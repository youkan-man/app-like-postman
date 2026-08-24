#!/usr/bin/env python3
"""MiniPost: a tiny, dependency-free HTTP client UI and Python proxy."""

from __future__ import annotations

import base64
import binascii
import http.client
import json
import logging
import os
import re
import socket
import ssl
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit

APP_NAME = "app-like-postman"
APP_VERSION = "2.0.0"
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

DEFAULT_REQUEST_LIMIT = 2 * 1024 * 1024
DEFAULT_RESPONSE_LIMIT = 10 * 1024 * 1024
MAX_TIMEOUT_MS = 10 * 60 * 1000
MAX_REDIRECTS = 10

TOKEN_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
TEXTUAL_CONTENT_RE = re.compile(
    r"(?:^text/|json|xml|javascript|x-www-form-urlencoded|graphql|yaml|csv|svg)",
    re.IGNORECASE,
)
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
SENSITIVE_REDIRECT_HEADERS = {"authorization", "cookie", "proxy-authorization"}
CONTENT_HEADERS = {"content-length", "content-type", "content-encoding"}
REDIRECT_STATUSES = {301, 302, 303, 307, 308}

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
)
LOGGER = logging.getLogger(APP_NAME)


class ClientInputError(ValueError):
    """The browser sent an invalid proxy request."""


class TargetRequestError(RuntimeError):
    """The target request failed before an HTTP response was received."""


class TargetTimeoutError(TargetRequestError):
    """The target request timed out."""


def env_int(name: str, default: int, minimum: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        LOGGER.warning("Ignoring invalid %s=%r", name, raw)
        return default
    return max(minimum, value)


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def normalize_origin(value: str) -> tuple[str, str, int] | None:
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        return parsed.scheme.lower(), parsed.hostname.lower(), port
    except ValueError:
        return None


def normalized_target_url(raw_url: Any) -> str:
    if not isinstance(raw_url, str) or not raw_url.strip():
        raise ClientInputError("URLを入力してください。")

    value = raw_url.strip()
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError as exc:
        raise ClientInputError(f"URLのポート番号が不正です: {exc}") from exc

    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise ClientInputError("http:// または https:// のURLだけを指定できます。")
    if not parsed.hostname:
        raise ClientInputError("URLにホスト名がありません。")

    return urlunsplit((scheme, parsed.netloc, parsed.path or "/", parsed.query, ""))


def ascii_request_target(parsed: Any) -> str:
    path = quote(parsed.path or "/", safe="/%:@-._~!$&'()*+,;=")
    if parsed.query:
        query = quote(parsed.query, safe="=&?/:;+,%@-._~!$'()*[]")
        return f"{path}?{query}"
    return path


def parse_timeout_ms(value: Any) -> int:
    try:
        timeout_ms = int(value)
    except (TypeError, ValueError):
        timeout_ms = 30_000
    if timeout_ms == 0:
        return MAX_TIMEOUT_MS
    return min(max(timeout_ms, 1), MAX_TIMEOUT_MS)


def parse_headers(raw_headers: Any) -> tuple[list[tuple[str, str]], list[str]]:
    if raw_headers is None:
        return [], []
    if not isinstance(raw_headers, list):
        raise ClientInputError("headers は配列で指定してください。")

    headers: list[tuple[str, str]] = []
    ignored: list[str] = []
    for index, item in enumerate(raw_headers):
        if not isinstance(item, dict):
            raise ClientInputError(f"headers[{index}] の形式が不正です。")
        if item.get("enabled", True) is False:
            continue

        name = str(item.get("key", "")).strip()
        value = str(item.get("value", ""))
        if not name:
            continue
        if len(name) > 256 or not TOKEN_RE.fullmatch(name):
            raise ClientInputError(f"HTTPヘッダー名が不正です: {name!r}")
        if "\r" in value or "\n" in value:
            raise ClientInputError(f"HTTPヘッダー値に改行は使用できません: {name}")
        if len(value) > 16_384:
            raise ClientInputError(f"HTTPヘッダー値が長すぎます: {name}")
        try:
            value.encode("latin-1")
        except UnicodeEncodeError as exc:
            raise ClientInputError(
                f"HTTPヘッダー値はISO-8859-1で表現できる文字にしてください: {name}"
            ) from exc

        lower_name = name.lower()
        if lower_name in HOP_BY_HOP_HEADERS or lower_name == "content-length":
            ignored.append(name)
            continue
        headers.append((name, value))

    return headers, ignored


def parse_body(payload: dict[str, Any], request_limit: int) -> bytes:
    body = payload.get("body")
    if body is None:
        return b""
    if not isinstance(body, str):
        raise ClientInputError("body は文字列で指定してください。")

    encoding = str(payload.get("body_encoding", "text")).lower()
    if encoding == "base64":
        try:
            data = base64.b64decode(body, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ClientInputError("body のBase64形式が不正です。") from exc
    elif encoding == "text":
        data = body.encode("utf-8")
    else:
        raise ClientInputError("body_encoding は text または base64 を指定してください。")

    if len(data) > request_limit:
        raise ClientInputError(
            f"リクエストBodyが上限を超えています（{request_limit} bytes）。"
        )
    return data


def strip_headers(
    headers: list[tuple[str, str]], names: set[str]
) -> list[tuple[str, str]]:
    return [(name, value) for name, value in headers if name.lower() not in names]


def origin_of(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    assert parsed.hostname is not None
    return parsed.scheme.lower(), parsed.hostname.lower(), port


def choose_text_encoding(content_type: str) -> str:
    match = re.search(r"charset\s*=\s*[\"']?([^;\"']+)", content_type, re.I)
    return match.group(1).strip() if match else "utf-8"


def represent_body(
    data: bytes, content_type: str, content_encoding: str = ""
) -> tuple[str, str]:
    if not data:
        return "", "text"

    if content_encoding and content_encoding.lower() != "identity":
        return base64.b64encode(data).decode("ascii"), "base64"

    if TEXTUAL_CONTENT_RE.search(content_type):
        encoding = choose_text_encoding(content_type)
        try:
            return data.decode(encoding), "text"
        except (LookupError, UnicodeDecodeError):
            return data.decode("utf-8", errors="replace"), "text"

    if not content_type:
        try:
            decoded = data.decode("utf-8")
            if not any(ord(char) < 9 for char in decoded):
                return decoded, "text"
        except UnicodeDecodeError:
            pass

    return base64.b64encode(data).decode("ascii"), "base64"


def read_limited(response: http.client.HTTPResponse, limit: int) -> tuple[bytes, bool]:
    chunks: list[bytes] = []
    total = 0
    truncated = False

    while total <= limit:
        chunk = response.read(min(65_536, limit + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > limit:
            truncated = True
            break

    data = b"".join(chunks)
    if truncated:
        data = data[:limit]
    return data, truncated


def make_connection(
    parsed: Any, timeout_seconds: float, verify_tls: bool
) -> http.client.HTTPConnection:
    assert parsed.hostname is not None
    host = parsed.hostname.encode("idna").decode("ascii")
    port = parsed.port

    if parsed.scheme == "https":
        context = ssl.create_default_context()
        if not verify_tls:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        return http.client.HTTPSConnection(
            host, port=port, timeout=timeout_seconds, context=context
        )
    return http.client.HTTPConnection(host, port=port, timeout=timeout_seconds)


def single_request(
    *,
    method: str,
    url: str,
    headers: list[tuple[str, str]],
    body: bytes,
    timeout_seconds: float,
    verify_tls: bool,
    response_limit: int,
) -> dict[str, Any]:
    parsed = urlsplit(url)
    connection = make_connection(parsed, timeout_seconds, verify_tls)
    outgoing_headers = list(headers)
    lower_names = {name.lower() for name, _ in outgoing_headers}

    if parsed.username is not None and "authorization" not in lower_names:
        username = unquote(parsed.username)
        password = unquote(parsed.password or "")
        token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        outgoing_headers.append(("Authorization", f"Basic {token}"))
        lower_names.add("authorization")

    if "user-agent" not in lower_names:
        outgoing_headers.append(("User-Agent", f"MiniPost/{APP_VERSION}"))
    if "accept" not in lower_names:
        outgoing_headers.append(("Accept", "*/*"))
    if "accept-encoding" not in lower_names:
        outgoing_headers.append(("Accept-Encoding", "identity"))
    outgoing_headers.append(("Connection", "close"))

    has_host = any(name.lower() == "host" for name, _ in outgoing_headers)
    should_send_length = bool(body) or method in {"POST", "PUT", "PATCH"}

    started = time.perf_counter()
    try:
        connection.putrequest(
            method,
            ascii_request_target(parsed),
            skip_host=has_host,
            skip_accept_encoding=True,
        )
        for name, value in outgoing_headers:
            connection.putheader(name, value)
        if should_send_length:
            connection.putheader("Content-Length", str(len(body)))
        connection.endheaders(body if body else None)

        response = connection.getresponse()
        response_headers = response.getheaders()
        response_body, truncated = read_limited(response, response_limit)
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        return {
            "status": response.status,
            "status_text": response.reason or "",
            "headers": [
                {"key": name, "value": value} for name, value in response_headers
            ],
            "raw_body": response_body,
            "size": len(response_body),
            "truncated": truncated,
            "elapsed_ms": elapsed_ms,
        }
    except (socket.timeout, TimeoutError) as exc:
        raise TargetTimeoutError(f"接続先が {timeout_seconds:g} 秒以内に応答しませんでした。") from exc
    except ssl.SSLCertVerificationError as exc:
        raise TargetRequestError(
            "TLS証明書を検証できませんでした。Optionsで検証を無効にすることもできます。"
        ) from exc
    except ssl.SSLError as exc:
        raise TargetRequestError(f"TLS通信に失敗しました: {exc}") from exc
    except (OSError, http.client.HTTPException) as exc:
        raise TargetRequestError(f"接続先への通信に失敗しました: {exc}") from exc
    finally:
        connection.close()


def forward_request(payload: dict[str, Any]) -> dict[str, Any]:
    request_limit = env_int("MAX_REQUEST_BYTES", DEFAULT_REQUEST_LIMIT)
    response_limit = env_int("MAX_RESPONSE_BYTES", DEFAULT_RESPONSE_LIMIT)

    method = str(payload.get("method", "GET")).strip().upper()
    if not method or len(method) > 32 or not TOKEN_RE.fullmatch(method):
        raise ClientInputError("HTTPメソッドが不正です。")

    url = normalized_target_url(payload.get("url"))
    headers, ignored_headers = parse_headers(payload.get("headers"))
    body = parse_body(payload, request_limit)
    timeout_ms = parse_timeout_ms(payload.get("timeout_ms", 30_000))
    verify_tls = bool(payload.get("verify_tls", True))
    follow_redirects = bool(payload.get("follow_redirects", True))
    try:
        requested_redirects = int(payload.get("max_redirects", 5) or 0)
    except (TypeError, ValueError) as exc:
        raise ClientInputError("max_redirects は整数で指定してください。") from exc
    max_redirects = min(max(requested_redirects, 0), MAX_REDIRECTS)

    current_method = method
    current_url = url
    current_body = body
    current_headers = list(headers)
    redirects: list[dict[str, Any]] = []
    total_started = time.perf_counter()
    deadline = total_started + timeout_ms / 1000

    for redirect_index in range(max_redirects + 1):
        remaining_seconds = deadline - time.perf_counter()
        if remaining_seconds <= 0:
            raise TargetTimeoutError(
                f"接続先が {timeout_ms / 1000:g} 秒以内に処理を完了しませんでした。"
            )
        result = single_request(
            method=current_method,
            url=current_url,
            headers=current_headers,
            body=current_body,
            timeout_seconds=remaining_seconds,
            verify_tls=verify_tls,
            response_limit=response_limit,
        )

        response_headers = result["headers"]
        content_type = next(
            (
                item["value"]
                for item in response_headers
                if item["key"].lower() == "content-type"
            ),
            "",
        )
        content_encoding = next(
            (
                item["value"]
                for item in response_headers
                if item["key"].lower() == "content-encoding"
            ),
            "",
        )
        location = next(
            (
                item["value"]
                for item in response_headers
                if item["key"].lower() == "location"
            ),
            None,
        )

        should_redirect = (
            follow_redirects
            and result["status"] in REDIRECT_STATUSES
            and bool(location)
            and redirect_index < max_redirects
        )
        if not should_redirect:
            body_value, body_encoding = represent_body(
                result.pop("raw_body"), content_type, content_encoding
            )
            result.update(
                {
                    "ok": True,
                    "url": current_url,
                    "method": current_method,
                    "body": body_value,
                    "body_encoding": body_encoding,
                    "content_type": content_type,
                    "content_encoding": content_encoding,
                    "redirects": redirects,
                    "ignored_headers": ignored_headers,
                    "elapsed_ms": round((time.perf_counter() - total_started) * 1000),
                    "response_limit": response_limit,
                    "redirect_limit_reached": bool(
                        follow_redirects
                        and result["status"] in REDIRECT_STATUSES
                        and location
                        and redirect_index >= max_redirects
                    ),
                }
            )
            return result

        next_url = normalized_target_url(urljoin(current_url, str(location)))
        redirects.append(
            {
                "status": result["status"],
                "from": current_url,
                "to": next_url,
            }
        )

        if origin_of(next_url) != origin_of(current_url):
            current_headers = strip_headers(current_headers, SENSITIVE_REDIRECT_HEADERS)

        if result["status"] == 303 or (
            result["status"] in {301, 302} and current_method not in {"GET", "HEAD"}
        ):
            current_method = "GET"
            current_body = b""
            current_headers = strip_headers(current_headers, CONTENT_HEADERS)

        current_url = next_url

    raise TargetRequestError("Redirect処理に失敗しました。")


class MiniPostHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class MiniPostHandler(SimpleHTTPRequestHandler):
    server_version = f"MiniPost/{APP_VERSION}"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        LOGGER.info("%s - %s", self.address_string(), format % args)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self' 'unsafe-inline'; "
            "script-src 'self' 'unsafe-inline'; connect-src 'self'; "
            "img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
        )
        super().end_headers()

    def list_directory(self, path: str) -> None:
        self.send_error(404, "Not Found")
        return None

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _origin_is_allowed(self) -> bool:
        fetch_site = (self.headers.get("Sec-Fetch-Site") or "").lower()
        if fetch_site == "cross-site":
            return False

        origin = self.headers.get("Origin")
        if not origin:
            return True
        if origin == "null":
            return False

        allowed_origins = {
            item.strip()
            for item in os.getenv("ALLOWED_ORIGINS", "").split(",")
            if item.strip()
        }
        if origin in allowed_origins:
            return True

        scheme = "http"
        if env_bool("TRUST_PROXY_HEADERS"):
            scheme = (self.headers.get("X-Forwarded-Proto") or scheme).split(",")[0].strip()
        host = self.headers.get("Host")
        if not host:
            return False
        return normalize_origin(origin) == normalize_origin(f"{scheme}://{host}")

    def _read_json(self) -> dict[str, Any]:
        content_length = self.headers.get("Content-Length")
        try:
            length = int(content_length or "0")
        except ValueError as exc:
            raise ClientInputError("Content-Length が不正です。") from exc

        request_limit = env_int("MAX_REQUEST_BYTES", DEFAULT_REQUEST_LIMIT)
        envelope_limit = env_int(
            "MAX_PROXY_ENVELOPE_BYTES", request_limit * 4 + 512 * 1024
        )
        if length <= 0:
            raise ClientInputError("JSONリクエストBodyがありません。")
        if length > envelope_limit:
            raise ClientInputError(
                f"プロキシ要求が上限を超えています（{envelope_limit} bytes）。"
            )

        raw = self.rfile.read(length)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ClientInputError("JSONリクエストBodyが不正です。") from exc
        if not isinstance(value, dict):
            raise ClientInputError("JSONのルートはオブジェクトにしてください。")
        return value

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/api/health":
            self._send_json(
                200,
                {"status": "ok", "service": APP_NAME, "version": APP_VERSION},
            )
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        if self.path.split("?", 1)[0] == "/api/health":
            self._send_json(
                200,
                {"status": "ok", "service": APP_NAME, "version": APP_VERSION},
            )
            return
        super().do_HEAD()

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/api/request":
            self._send_json(404, {"ok": False, "error": {"message": "Not Found"}})
            return
        if not self._origin_is_allowed():
            self._send_json(
                403,
                {
                    "ok": False,
                    "error": {
                        "type": "origin_rejected",
                        "message": "別オリジンからのプロキシ操作は拒否されました。",
                    },
                },
            )
            return

        try:
            payload = self._read_json()
            result = forward_request(payload)
            self._send_json(200, result)
        except ClientInputError as exc:
            self._send_json(
                400,
                {
                    "ok": False,
                    "error": {"type": "validation_error", "message": str(exc)},
                },
            )
        except TargetTimeoutError as exc:
            self._send_json(
                504,
                {
                    "ok": False,
                    "error": {"type": "target_timeout", "message": str(exc)},
                },
            )
        except TargetRequestError as exc:
            self._send_json(
                502,
                {
                    "ok": False,
                    "error": {"type": "target_request_error", "message": str(exc)},
                },
            )
        except Exception:
            LOGGER.exception("Unhandled proxy error")
            self._send_json(
                500,
                {
                    "ok": False,
                    "error": {
                        "type": "internal_error",
                        "message": "バックエンド内部で予期しないエラーが発生しました。",
                    },
                },
            )


def create_server(host: str, port: int) -> MiniPostHTTPServer:
    if not STATIC_DIR.joinpath("index.html").is_file():
        raise RuntimeError(f"Static UI not found: {STATIC_DIR / 'index.html'}")
    return MiniPostHTTPServer((host, port), MiniPostHandler)


def main() -> None:
    host = os.getenv("APP_HOST", "0.0.0.0")
    port = env_int("APP_PORT", 8080)
    server = create_server(host, port)
    LOGGER.info("MiniPost %s listening on http://%s:%s", APP_VERSION, host, port)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        LOGGER.info("Stopping MiniPost")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
