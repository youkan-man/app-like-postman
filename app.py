import base64
import json
import ssl
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPSHandler, Request, build_opener

STATIC_DIR = Path(__file__).resolve().parent / "static"
TEXT_TYPES = ("text/", "json", "xml", "javascript", "yaml", "csv", "svg")


def send_http_request(payload):
    url = str(payload.get("url", "")).strip()
    method = str(payload.get("method", "GET")).upper()

    if not url:
        raise ValueError("URLを入力してください。")
    if not url.startswith(("http://", "https://")):
        raise ValueError("http:// または https:// のURLを指定してください。")

    headers = {}
    for item in payload.get("headers") or []:
        if isinstance(item, dict) and item.get("key"):
            headers[str(item["key"])] = str(item.get("value", ""))

    body = payload.get("body")
    body_bytes = None if body is None else str(body).encode("utf-8")
    timeout = max(int(payload.get("timeout_ms") or 30000) / 1000, 0.1)
    verify_tls = payload.get("verify_tls", True) is not False

    context = ssl.create_default_context() if verify_tls else ssl._create_unverified_context()
    opener = build_opener(HTTPSHandler(context=context))
    request = Request(url, data=body_bytes, headers=headers, method=method)

    started = time.perf_counter()
    try:
        response = opener.open(request, timeout=timeout)
    except HTTPError as error:
        response = error
    except (URLError, TimeoutError, OSError) as error:
        raise RuntimeError(str(error.reason if isinstance(error, URLError) else error)) from error

    with response:
        raw_body = response.read()
        content_type = response.headers.get("Content-Type", "")
        content_type_lower = content_type.lower()
        is_text = not content_type or any(token in content_type_lower for token in TEXT_TYPES)

        if is_text:
            charset = response.headers.get_content_charset() or "utf-8"
            body_value = raw_body.decode(charset, errors="replace")
            body_encoding = "text"
        else:
            body_value = base64.b64encode(raw_body).decode("ascii")
            body_encoding = "base64"

        return {
            "ok": True,
            "status": response.status,
            "status_text": response.reason or "",
            "url": response.geturl(),
            "headers": [
                {"key": key, "value": value}
                for key, value in response.headers.items()
            ],
            "body": body_value,
            "body_encoding": body_encoding,
            "content_type": content_type,
            "size": len(raw_body),
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
        }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def send_json(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/health":
            self.send_json(200, {"ok": True})
            return
        super().do_GET()

    def do_POST(self):
        if self.path != "/api/request":
            self.send_json(404, {"ok": False, "error": "Not Found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            result = send_http_request(payload)
            self.send_json(200, result)
        except ValueError as error:
            self.send_json(400, {"ok": False, "error": str(error)})
        except Exception as error:
            self.send_json(502, {"ok": False, "error": str(error)})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
