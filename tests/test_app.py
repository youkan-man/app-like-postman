from __future__ import annotations

import base64
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app import create_server


class TargetHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/echo?redirected=1")
            self.end_headers()
            return
        if self.path == "/binary":
            body = b"\x00\x01\x02\xff"
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._json(
            {
                "method": "GET",
                "path": self.path,
                "x-test": self.headers.get("X-Test"),
            }
        )

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode()
        self._json(
            {
                "method": "POST",
                "path": self.path,
                "content-type": self.headers.get("Content-Type"),
                "body": body,
            }
        )


class RunningServer:
    def __init__(self, server: ThreadingHTTPServer):
        self.server = server
        self.thread = threading.Thread(target=server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self.server

    def __exit__(self, exc_type, exc, tb):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class MiniPostTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.target_context = RunningServer(ThreadingHTTPServer(("127.0.0.1", 0), TargetHandler))
        cls.target_server = cls.target_context.__enter__()
        cls.app_context = RunningServer(create_server("127.0.0.1", 0))
        cls.app_server = cls.app_context.__enter__()
        cls.target_base = f"http://127.0.0.1:{cls.target_server.server_port}"
        cls.app_base = f"http://127.0.0.1:{cls.app_server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.app_context.__exit__(None, None, None)
        cls.target_context.__exit__(None, None, None)

    def proxy(self, payload: dict) -> tuple[int, dict]:
        request = Request(
            f"{self.app_base}/api/request",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_health_and_static_ui(self) -> None:
        with urlopen(f"{self.app_base}/api/health", timeout=3) as response:
            health = json.load(response)
        self.assertEqual(health["status"], "ok")

        with urlopen(f"{self.app_base}/", timeout=3) as response:
            html = response.read().decode()
        self.assertIn("MiniPost", html)
        self.assertIn("/api/request", html)

    def test_get_with_query_and_header(self) -> None:
        status, result = self.proxy(
            {
                "method": "GET",
                "url": f"{self.target_base}/echo?x=1",
                "headers": [{"key": "X-Test", "value": "works"}],
                "timeout_ms": 2000,
            }
        )
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], 200)
        echoed = json.loads(result["body"])
        self.assertEqual(echoed["path"], "/echo?x=1")
        self.assertEqual(echoed["x-test"], "works")

    def test_post_text_body(self) -> None:
        status, result = self.proxy(
            {
                "method": "POST",
                "url": f"{self.target_base}/echo",
                "headers": [
                    {"key": "Content-Type", "value": "application/json"}
                ],
                "body": '{"hello":"world"}',
                "timeout_ms": 2000,
            }
        )
        self.assertEqual(status, 200)
        echoed = json.loads(result["body"])
        self.assertEqual(echoed["method"], "POST")
        self.assertEqual(echoed["body"], '{"hello":"world"}')
        self.assertEqual(echoed["content-type"], "application/json")

    def test_redirect_is_followed(self) -> None:
        status, result = self.proxy(
            {
                "method": "GET",
                "url": f"{self.target_base}/redirect",
                "follow_redirects": True,
            }
        )
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], 200)
        self.assertEqual(len(result["redirects"]), 1)
        self.assertIn("redirected=1", result["url"])

    def test_binary_response_is_base64(self) -> None:
        status, result = self.proxy(
            {"method": "GET", "url": f"{self.target_base}/binary"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(result["body_encoding"], "base64")
        self.assertEqual(base64.b64decode(result["body"]), b"\x00\x01\x02\xff")

    def test_invalid_scheme_is_rejected(self) -> None:
        status, result = self.proxy({"method": "GET", "url": "file:///etc/passwd"})
        self.assertEqual(status, 400)
        self.assertEqual(result["error"]["type"], "validation_error")

    def test_cross_site_origin_is_rejected(self) -> None:
        request = Request(
            f"{self.app_base}/api/request",
            data=json.dumps({"method": "GET", "url": self.target_base}).encode(),
            headers={
                "Content-Type": "application/json",
                "Origin": "https://attacker.invalid",
                "Sec-Fetch-Site": "cross-site",
            },
            method="POST",
        )
        with self.assertRaises(HTTPError) as context:
            urlopen(request, timeout=3)
        self.assertEqual(context.exception.code, 403)


if __name__ == "__main__":
    unittest.main()
