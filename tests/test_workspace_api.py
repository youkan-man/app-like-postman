"""Explicit server workspace persistence: no automatic writes and no data loss on invalid input."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import app as minipost

EXAMPLE = {
    "kind": "minipost.workspace", "version": 1, "exported_at": "2026-10-14T00:00:00Z",
    "workspace": {
        "version": 2, "collections": [], "environments": [{"id": "e1", "name": "QA", "values": [{"key": "secret", "value": "local-test"}]}],
        "globals": [], "tabs": [], "activeId": "", "environmentId": "e1", "history": [],
        "revisions": {"environment:e1": [{"at": "2026-10-14T00:00:00Z", "value": {"name": "QA"}}]},
    },
    "layout": {"layout": {"sidebar": 250}},
}

class ExplicitWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.original_path = minipost.WORKSPACE_FILE
        minipost.WORKSPACE_FILE = Path(self.tempdir.name) / "private" / "workspace.json"
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), minipost.Handler)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(timeout=3)
        minipost.WORKSPACE_FILE = self.original_path
        self.tempdir.cleanup()

    def request(self, method, body=None, origin=None, content_type="application/json"):
        headers = {}
        if body is not None:
            headers["Content-Type"] = content_type
            body = json.dumps(body).encode()
        if origin:
            headers["Origin"] = origin
        req = Request(self.base + "/api/workspace", data=body, headers=headers, method=method)
        try:
            with urlopen(req, timeout=5) as res:
                return res.status, json.loads(res.read())
        except HTTPError as res:
            return res.code, json.loads(res.read())

    def test_explicit_save_and_reload_with_all_scopes(self):
        status, response = self.request("GET")
        self.assertEqual(status, 404)
        self.assertFalse(minipost.WORKSPACE_FILE.exists())
        status, response = self.request("POST", EXAMPLE)
        self.assertEqual(status, 200)
        self.assertTrue(response["ok"])
        self.assertTrue(minipost.WORKSPACE_FILE.is_file())
        if os.name == "posix":
            self.assertEqual(minipost.WORKSPACE_FILE.stat().st_mode & 0o777, 0o600)
        status, saved = self.request("GET")
        self.assertEqual(status, 200)
        self.assertEqual(saved, EXAMPLE)
        self.assertEqual(saved["workspace"]["environments"][0]["values"][0]["value"], "local-test")

    def test_invalid_request_never_overwrites_valid_backup(self):
        self.assertEqual(self.request("POST", EXAMPLE)[0], 200)
        self.assertEqual(self.request("POST", {"kind": "other", "version": 1})[0], 400)
        self.assertEqual(self.request("POST", EXAMPLE, origin="https://evil.example")[0], 403)
        self.assertEqual(self.request("POST", EXAMPLE, content_type="text/plain")[0], 415)
        self.assertEqual(self.request("GET")[1], EXAMPLE)

    def test_workspace_is_not_written_by_proxy_healthcheck(self):
        with urlopen(self.base + "/api/health", timeout=5) as res:
            self.assertEqual(res.status, 200)
        self.assertFalse(minipost.WORKSPACE_FILE.exists())

    def test_limit_guard_keeps_original(self):
        self.assertEqual(self.request("POST", EXAMPLE)[0], 200)
        huge = json.loads(json.dumps(EXAMPLE))
        huge["workspace"]["environments"][0]["values"][0]["value"] = "x" * (10 * 1024 * 1024)
        self.assertEqual(self.request("POST", huge)[0], 413)
        self.assertEqual(self.request("GET")[1], EXAMPLE)


if __name__ == "__main__":
    unittest.main()
