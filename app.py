"""Dependency-free HTTP workbench proxy. Run with python app.py or Docker."""
from __future__ import annotations

import base64
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
from network import runtime_info, connection_details, connection_diagnostic, format_network_error

STATIC_DIR = Path(__file__).resolve().parent / "static"
# No automatic server-side persistence: only an explicit POST from the UI writes here.
WORKSPACE_FILE = Path(os.getenv("MINIPOST_WORKSPACE_FILE") or
                      ("/data/workspace.json" if os.getenv("MINIPOST_CONTAINER") else ".minipost/workspace.json")).resolve()
MAX_WORKSPACE_BYTES = 10 * 1024 * 1024
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


def send_http_request(payload):
    if not isinstance(payload, dict):
        raise ValueError("リクエストはJSONオブジェクトで指定してください。")
    url = str(payload.get("url", "")).strip()
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
    body = prepare_body(payload, headers)
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
        try:
            connection.sock = socket.create_connection((target.hostname, port), timeout)
            details["peer_ip"] = connection.sock.getpeername()[0]
            if target.scheme == "https":
                phase = "tls"
                connection.sock = context.wrap_socket(connection.sock, server_hostname=target.hostname)
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
            connection.endheaders(body)
            phase = "receive"
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
        if payload.get("follow_redirects", True) and status in {301, 302, 303, 307, 308} and location:
            if hop == 20:
                raise ValueError("リダイレクト回数が20回を超えました。Settingsで追従をOFFにできます。")
            next_url = urljoin(url, location)
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
        if self.path == "/api/health":
            self.send_json(200, {"ok": True, "runtime": runtime_info()})
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

    def do_POST(self):
        if self.path not in ("/api/request", "/api/workspace"):
            self.send_json(404, {"ok": False, "error": "Not Found"})
            return
        try:
            if self.path == "/api/workspace":
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
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if self.path == "/api/workspace":
                self.send_json(200, write_workspace(payload))
            else:
                self.send_json(200, send_http_request(payload))
        except Exception as error:
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
