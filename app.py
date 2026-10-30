"""Dependency-free HTTP workbench proxy. Run with python app.py or Docker."""
from __future__ import annotations

import base64
import atexit
import errno
import gzip
import http.client
import json
import os
import re
import ssl
import socket
import threading
import time
import uuid
import zlib
from email.message import Message
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from url_codec import request_url, wire_url, form_body, transform_text
from network import runtime_info, connection_details, connection_diagnostic, format_network_error
from upload_stream import UploadStore, UploadError, StreamBody, prepare_stream_body, CHUNK_BYTES, MAX_METADATA_BYTES

STATIC_DIR = Path(__file__).resolve().parent / "static"
# No automatic server-side persistence: only an explicit POST from the UI writes here.
WORKSPACE_FILE = Path(os.getenv("MINIPOST_WORKSPACE_FILE") or
                      ("/data/workspace.json" if os.getenv("MINIPOST_CONTAINER") else ".minipost/workspace.json")).resolve()
MAX_WORKSPACE_BYTES = 10 * 1024 * 1024
# Legacy JSON requests stay bounded; new binary uploads use disk-backed chunks.
MAX_REQUEST_JSON_BYTES = 64 * 1024 * 1024
UPLOADS = UploadStore(directory=os.getenv("MINIPOST_UPLOAD_DIR") or None)
atexit.register(UPLOADS.close)
WORKSPACE_LOCK = threading.Lock()
TEXT_TYPES = ("text/", "json", "xml", "javascript", "yaml", "csv", "svg")
TOKEN = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")


def _decode64(value):
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as error:
        raise ValueError("ファイルのBase64データが不正です。") from error


def _quoted(value):
    value = str(value)
    if "\r" in value or "\n" in value:
        raise ValueError("フォームの名前・ファイル名に改行は使用できません。")
    return value.replace("\\", "\\\\").replace('"', '\\"')


def prepare_body(payload, headers):
    if "body_upload" in payload or "body_file" in payload or any(
            isinstance(part, dict) and ("upload" in part or "file" in part)
            for part in payload.get("multipart", []) or []):
        raise UploadError("転送用ファイルの参照がありません。ファイルを選び直して送信してください。")
    if "form_urlencoded" in payload:
        return form_body(payload["form_urlencoded"])
    if "multipart" in payload:
        boundary = "----MiniPost" + uuid.uuid4().hex
        parts = []
        for part in payload["multipart"]:
            disposition = f'Content-Disposition: form-data; name="{_quoted(part["key"])}"'
            if "filename" in part:
                disposition += f'; filename="{_quoted(part["filename"])}"'
                data = _decode64(part.get("data", ""))
            else:
                data = str(part.get("value", "")).encode("utf-8")
            content_type = part.get("content_type")
            head = f"--{boundary}\r\n{disposition}\r\n"
            if content_type:
                if "\r" in content_type or "\n" in content_type:
                    raise ValueError("Content-Typeに改行は使用できません。")
                head += f"Content-Type: {content_type}\r\n"
            parts.extend([head.encode("utf-8") + b"\r\n", data, b"\r\n"])
        parts.append(f"--{boundary}--\r\n".encode())
        headers[:] = [(k, v) for k, v in headers if k.lower() != "content-type"]
        headers.append(("Content-Type", f"multipart/form-data; boundary={boundary}"))
        return b"".join(parts)
    if "body_base64" in payload:
        return _decode64(payload["body_base64"])
    body = payload.get("body")
    return None if body is None else str(body).encode("utf-8")


def send_http_request(payload, upload=None):
    if not isinstance(payload, dict):
        raise ValueError("リクエストはJSONオブジェクトで指定してください。")
    url = request_url(payload)
    method = str(payload.get("method", "GET")).upper()
    if not TOKEN.fullmatch(method):
        raise ValueError("HTTPメソッドが不正です。")
    headers = []
    for item in payload.get("headers") or []:
        if not isinstance(item, dict) or item.get("disabled") or item.get("enabled") is False:
            continue
        key = str(item.get("key", "")).strip()
        if not key:
            continue
        value = str(item.get("value", ""))
        if not TOKEN.fullmatch(key) or "\r" in value or "\n" in value:
            raise ValueError("ヘッダー名または値が不正です。")
        # The caller cannot supply conflicting byte-buffer framing.
        if key.lower() not in {"content-length", "transfer-encoding", "connection"}:
            headers.append((key, value))
    body = prepare_stream_body(payload, headers, upload) if upload is not None else prepare_body(payload, headers)
    timeout_ms = float(payload.get("timeout_ms", 30000))
    if timeout_ms < 0 or not timeout_ms < float("inf"):
        raise ValueError("Timeoutは0以上の数値で指定してください。0は無制限です。")
    timeout = timeout_ms / 1000 if timeout_ms else None
    verify_tls = payload.get("verify_tls", False) is not False
    context = ssl.create_default_context() if verify_tls else ssl._create_unverified_context()
    started = time.perf_counter()
    redirects = []
    for hop in range(21):
        target = urlsplit(url)
        if target.scheme not in {"http", "https"} or not target.hostname:
            raise ValueError("http:// または https:// のURLを指定してください。")
        if target.username is not None:
            raise ValueError("URL内の認証情報はAuthorizationのBasic Authに設定してください。")
        port = target.port or (443 if target.scheme == "https" else 80)
        details = connection_details(target)
        # URL host is unchanged for TCP, HTTP Host and TLS verification.
        connection = http.client.HTTPConnection(target.hostname, port, timeout=timeout)
        phase = "connect"
        if upload is not None:
            upload.begin_send(len(body) if body is not None else 0)
        try:
            connection.sock = socket.create_connection((target.hostname, port), timeout)
            details["peer_ip"] = connection.sock.getpeername()[0]
            if target.scheme == "https":
                phase = "tls"
                connection.sock = context.wrap_socket(connection.sock, server_hostname=target.hostname)
            if upload is not None:
                upload.check()
                upload.outgoing = connection.sock
            phase = "send"
            path = (target.path or "/") + ("?" + target.query if target.query else "")
            connection.putrequest(method, path, skip_host=any(k.lower() == "host" for k, _ in headers), skip_accept_encoding=True)
            for key, value in headers:
                connection.putheader(key, value)
            connection.putheader("Connection", "close")
            if body is not None:
                connection.putheader("Content-Length", str(len(body)))
            elif method in {"POST", "PUT", "PATCH"}:
                connection.putheader("Content-Length", "0")
            if isinstance(body, StreamBody):
                body.send(connection)
            else:
                connection.endheaders(body)
            phase = "receive"
            if upload is not None:
                upload.wait_response()
            response = connection.getresponse()
            response_headers = response.getheaders()
            raw_body = response.read()
            status, reason = response.status, response.reason
            location = response.getheader("Location")
            content_type = response.getheader("Content-Type", "")
            content_encoding = response.getheader("Content-Encoding", "").lower()
        except Exception as error:
            error.minipost_network = connection_diagnostic(error, details, phase)
            raise
        finally:
            connection.close()
            if upload is not None:
                upload.outgoing = None
        if payload.get("follow_redirects", True) and status in {301, 302, 303, 307, 308} and location:
            if hop == 20:
                raise ValueError("リダイレクト回数が20回を超えました。Settingsで追従をOFFにできます。")
            next_url = wire_url(urljoin(url, location))
            next_target = urlsplit(next_url)
            next_port = next_target.port or (443 if next_target.scheme == "https" else 80)
            if (target.scheme, target.hostname, port) != (next_target.scheme, next_target.hostname, next_port):
                headers = [(k, v) for k, v in headers if k.lower() not in {"authorization", "cookie", "proxy-authorization", "host"}]
            redirects.append({"status": status, "url": url, "location": next_url})
            if (status == 303 and method != "HEAD") or (status in {301, 302} and method == "POST"):
                method, body = "GET", None
                headers = [(k, v) for k, v in headers if k.lower() not in {"content-type", "content-encoding"}]
            url = next_url
            continue
        wire_size = len(raw_body)
        if method != "HEAD" and raw_body:
            if content_encoding == "gzip":
                raw_body = gzip.decompress(raw_body)
            elif content_encoding == "deflate":
                try:
                    raw_body = zlib.decompress(raw_body)
                except zlib.error:
                    raw_body = zlib.decompress(raw_body, -zlib.MAX_WBITS)
        message = Message()
        message["content-type"] = content_type
        charset = message.get_content_charset() or "utf-8"
        is_text = not content_type or any(token in content_type.lower() for token in TEXT_TYPES)
        if is_text:
            try:
                body_value = raw_body.decode(charset, errors="replace")
            except LookupError:
                body_value = raw_body.decode("utf-8", errors="replace")
        else:
            body_value = base64.b64encode(raw_body).decode("ascii")
        return {
            "ok": True, "status": status, "status_text": reason, "url": url,
            "headers": [{"key": k, "value": v} for k, v in response_headers],
            "body": body_value, "body_encoding": "text" if is_text else "base64",
            "body_base64": base64.b64encode(raw_body).decode("ascii"),
            "content_type": content_type, "size": len(raw_body), "wire_size": wire_size,
            "elapsed_ms": round((time.perf_counter() - started) * 1000), "redirects": redirects,
            "network": details,
        }
    raise RuntimeError("リダイレクト処理に失敗しました。")


def write_workspace(payload):
    if not isinstance(payload, dict) or payload.get("kind") != "minipost.workspace" or payload.get("version") != 1:
        raise ValueError("MiniPostワークスペース形式のみ保存できます。")
    ws = payload.get("workspace")
    if (not isinstance(ws, dict) or ws.get("version") != 2 or
            any(not isinstance(ws.get(k), list) for k in ("collections", "environments", "globals", "tabs", "history"))):
        raise ValueError("ワークスペースの構造が不正です。")
    content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if len(content) > MAX_WORKSPACE_BYTES:
        raise ValueError("データのサイズ上限は10 MiBです。")
    with WORKSPACE_LOCK:
        WORKSPACE_FILE.parent.mkdir(parents=True, exist_ok=True)
        pending = WORKSPACE_FILE.with_name(".workspace-" + uuid.uuid4().hex + ".tmp")
        try:
            with open(pending, "xb") as output:
                os.chmod(pending, 0o600)
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            os.replace(pending, WORKSPACE_FILE)
        finally:
            pending.unlink(missing_ok=True)
    return {"ok": True, "bytes": len(content), "saved_at": payload.get("exported_at")}


def read_workspace():
    with WORKSPACE_LOCK:
        if not WORKSPACE_FILE.exists():
            return None
        if WORKSPACE_FILE.stat().st_size > MAX_WORKSPACE_BYTES:
            raise ValueError("保存データが10 MiBを超えています。")
        return json.loads(WORKSPACE_FILE.read_text("utf-8"))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def send_json(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # The user stopped receiving this response.

    def do_GET(self):
        progress = re.fullmatch(r"/api/uploads/([a-f0-9]{64})/progress", self.path)
        if progress:
            if not self.upload_origin_allowed():
                self.send_json(403, {"ok": False, "error": "別オリジンからの転送状態取得は許可されていません。"})
                return
            try:
                self.send_json(200, {"ok": True, "progress": UPLOADS.get(progress[1]).progress()})
            except UploadError as error:
                self.send_json(error.status, {"ok": False, "error": str(error)})
            return
        if self.path == "/api/health":
            self.send_json(200, {"ok": True, "runtime": runtime_info(), "uploads": {"protocol": 1, "chunk_bytes": CHUNK_BYTES, "progress": True}})
        elif self.path == "/api/workspace":
            try:
                saved = read_workspace()
                if saved is None:
                    self.send_json(404, {"ok": False, "error": "サーバーに保存されたワークスペースはありません。"})
                else:
                    self.send_json(200, saved)
            except (OSError, ValueError, json.JSONDecodeError) as error:
                self.send_json(500, {"ok": False, "error": str(error)})
        else:
            super().do_GET()

    def upload_origin_allowed(self):
        origin = self.headers.get("Origin")
        return (not origin or urlsplit(origin).netloc == self.headers.get("Host")) and self.headers.get("Sec-Fetch-Site") != "cross-site"

    def log_request(self, code="-", size="-"):
        # Upload IDs are short-lived capability tokens; do not put them in logs.
        if self.path.startswith("/api/uploads/"):
            self.log_message('"%s /api/uploads/[session]" %s %s', self.command, str(code), str(size))
        else:
            super().log_request(code, size)

    def do_DELETE(self):
        match = re.fullmatch(r"/api/uploads/([a-f0-9]{64})", self.path)
        if not match:
            self.send_json(404, {"ok": False, "error": "Not Found"})
        elif not self.upload_origin_allowed():
            self.send_json(403, {"ok": False, "error": "別オリジンからのファイル操作は許可されていません。"})
        else:
            UPLOADS.discard(match[1])
            self.send_json(200, {"ok": True})

    def post_upload(self):
        # Never leave unread bytes eligible for reuse as another HTTP request.
        self.close_connection = True
        token = None
        try:
            if not self.upload_origin_allowed():
                raise UploadError("別オリジンからのファイル転送は許可されていません。", 403)
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or self.headers.get("Transfer-Encoding"):
                raise UploadError("ファイル転送にはContent-Lengthが必要です。", 411)
            length = int(lengths[0])
            if self.path == "/api/uploads":
                if not 0 < length <= MAX_METADATA_BYTES:
                    raise UploadError("転送情報のサイズが不正です。", 413)
                if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                    raise UploadError("転送情報はapplication/jsonで指定してください。", 415)
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise UploadError("転送情報の形式が不正です。")
                token = UPLOADS.create(payload.get("sizes"))
                self.send_json(201, {"ok": True, "upload_id": token, "chunk_bytes": CHUNK_BYTES, "progress": True})
            else:
                match = re.fullmatch(r"/api/uploads/([a-f0-9]{64})/(\d+)", self.path)
                if not match:
                    raise UploadError("Not Found", 404)
                token, index = match[1], int(match[2])
                if self.headers.get("Content-Type", "").split(";")[0] != "application/octet-stream":
                    raise UploadError("ファイルはapplication/octet-streamで転送してください。", 415)
                offset = int(self.headers.get("X-MiniPost-Offset", "-1"))
                upload = UPLOADS.get(token)
                # Bound an abandoned partial chunk; target timeout is separate.
                self.connection.settimeout(60)
                offset = upload.append(index, offset, length, self.rfile, self.connection)
                self.send_json(200, {"ok": True, "offset": offset})
        except Exception as error:
            if token is not None:
                UPLOADS.discard(token)
            disk_full = isinstance(error, OSError) and error.errno in (errno.ENOSPC, errno.EDQUOT)
            status = 507 if disk_full else getattr(error, "status", 400)
            message = "一時ファイル用ディスクの空き容量が不足しています。送信していません。" if disk_full else str(error)
            self.send_json(status, {"ok": False, "error": message})

    def do_POST(self):
        if self.path == "/api/uploads" or self.path.startswith("/api/uploads/"):
            self.post_upload()
            return
        if self.path not in ("/api/request", "/api/workspace", "/api/url-transform"):
            self.send_json(404, {"ok": False, "error": "Not Found"})
            return
        try:
            if self.path in ("/api/workspace", "/api/url-transform"):
                origin = self.headers.get("Origin")
                if origin and urlsplit(origin).netloc != self.headers.get("Host"):
                    self.send_json(403, {"ok": False, "error": "別オリジンからの保存は許可されていません。"})
                    return
                if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
                    self.send_json(415, {"ok": False, "error": "application/jsonが必要です。"})
                    return
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or (self.path == "/api/workspace" and length > MAX_WORKSPACE_BYTES):
                self.send_json(413 if length > MAX_WORKSPACE_BYTES else 400, {"ok": False, "error": "保存データのサイズまたは形式が不正です。"})
                return
            if length > MAX_REQUEST_JSON_BYTES:
                self.close_connection = True
                self.send_json(413, {"ok": False, "error": "JSON本文が大きすぎます。バイナリファイルは大容量転送対応の画面で選び直してください。"})
                return
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if self.path == "/api/url-transform":
                self.send_json(200, {"ok": True, "text": transform_text(payload)})
            elif self.path == "/api/workspace":
                self.send_json(200, write_workspace(payload))
            elif isinstance(payload, dict) and "upload_id" in payload:
                if not self.upload_origin_allowed():
                    raise UploadError("別オリジンからのファイル送信は許可されていません。", 403)
                with UPLOADS.claim(payload["upload_id"], self.connection) as upload:
                    self.send_json(200, send_http_request(payload, upload))
            else:
                self.send_json(200, send_http_request(payload))
        except Exception as error:
            if isinstance(error, UploadError):
                self.send_json(error.status, {"ok": False, "error": str(error)})
                return
            diagnostic = getattr(error, "minipost_network", None)
            # Certificate verification errors are ValueErrors too. Preserve TLS cause.
            if diagnostic is None and isinstance(error, (ValueError, UnicodeError, TypeError, KeyError)):
                self.send_json(400, {"ok": False, "error": str(error)})
                return
            self.send_json(502, {"ok": False, "error_origin": "minipost",
                "error": format_network_error(error, diagnostic) if diagnostic else str(error),
                "diagnostic": diagnostic})


if __name__ == "__main__":
    ThreadingHTTPServer((os.environ.get("HOST", "0.0.0.0"), int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
