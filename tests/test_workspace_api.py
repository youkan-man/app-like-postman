"""Explicit server workspace persistence: no automatic writes and no data loss on invalid input."""
from __future__ import annotations

import base64
import copy
import gzip
import json
import random
import os
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import app as minipost
from workspace_codec import (PACKED_WORKSPACE_KIND, PACKED_WORKSPACE_MEDIA_TYPE, WorkspaceSizeError,
                             compact_json, pack_workspace_bundle, unpack_workspace_bundle)

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

    def request(self, method, body=None, origin=None, content_type="application/json", headers=None):
        headers = dict(headers or {})
        if body is not None:
            headers["Content-Type"] = content_type
            if not isinstance(body, bytes):
                body = json.dumps(body).encode()
        if origin:
            headers["Origin"] = origin
        req = Request(self.base + "/api/workspace", data=body, headers=headers, method=method)
        try:
            with urlopen(req, timeout=15) as res:
                raw = res.read()
                if res.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return res.status, json.loads(raw)
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
        import http.client
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.putrequest('POST', '/api/workspace')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', str(minipost.MAX_WORKSPACE_BYTES + 1))
        conn.endheaders()
        self.assertEqual(conn.getresponse().status, 413)
        conn.close()
        self.assertEqual(self.request("GET")[1], EXAMPLE)

    def test_large_history_is_pooled_compressed_and_losslessly_restored(self):
        document = copy.deepcopy(EXAMPLE)
        body = base64.b64encode(random.Random(2026).randbytes(384 * 1024)).decode("ascii")
        document["workspace"]["revisions"]["request:c1:r1"] = [
            {"at": f"2026-11-25T00:00:{index:02d}Z", "value": {
                "name": f"Request {index}", "request": {"method": "POST", "url": "https://example.invalid/",
                                                        "body": {"mode": "raw", "raw": body}}}}
            for index in range(24)
        ]
        encoded = compact_json(document)
        self.assertGreater(len(encoded), 10 * 1024 * 1024)
        status, result = self.request("POST", document)
        self.assertEqual(status, 200, result)
        self.assertEqual(result["expanded_bytes"], len(encoded))
        self.assertLess(result["packed_bytes"], len(encoded) // 10)
        self.assertLess(result["bytes"], len(encoded) // 20)
        self.assertEqual(self.request("GET")[1], document)
        self.assertEqual(minipost.read_workspace(), document)
        self.assertTrue(minipost.WORKSPACE_FILE.read_bytes().startswith(b"\x1f\x8b"))
        status, packed = self.request("GET", headers={"Accept": PACKED_WORKSPACE_MEDIA_TYPE})
        self.assertEqual(status, 200)
        self.assertEqual(packed["kind"], PACKED_WORKSPACE_KIND)
        self.assertEqual(unpack_workspace_bundle(packed), document)
        # The client can send the same compact archive using native gzip.
        status, result = self.request("POST", gzip.compress(compact_json(packed)), headers={"Content-Encoding": "gzip"})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.request("GET")[1], document)

    def test_unique_data_larger_than_old_limit_saves(self):
        document = copy.deepcopy(EXAMPLE)
        document["workspace"]["scriptData"] = {
            "unique": base64.b64encode(random.Random(78).randbytes(8 * 1024 * 1024)).decode("ascii")}
        self.assertGreater(len(compact_json(document)), 10 * 1024 * 1024)
        status, result = self.request("POST", document)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.request("GET")[1], document)

    def test_legacy_plain_file_remains_readable_and_is_not_rewritten_on_read(self):
        minipost.WORKSPACE_FILE.parent.mkdir(parents=True)
        legacy = json.dumps(EXAMPLE, ensure_ascii=False, indent=2).encode()
        minipost.WORKSPACE_FILE.write_bytes(legacy)
        self.assertEqual(self.request("GET")[1], EXAMPLE)
        self.assertEqual(unpack_workspace_bundle(self.request("GET", headers={"Accept": PACKED_WORKSPACE_MEDIA_TYPE})[1]), EXAMPLE)
        self.assertEqual(minipost.WORKSPACE_FILE.read_bytes(), legacy)

    def test_workspace_download_compression_is_negotiated(self):
        document = copy.deepcopy(EXAMPLE)
        document["workspace"]["scriptData"] = {"value": "保存内容" * 10000}
        self.assertEqual(self.request("POST", document)[0], 200)
        req = Request(self.base + "/api/workspace", headers={"Accept-Encoding": "gzip"})
        with urlopen(req, timeout=5) as response:
            self.assertEqual(response.headers["Content-Encoding"], "gzip")
            self.assertIn("Accept-Encoding", response.headers["Vary"])
            raw = response.read()
            self.assertEqual(int(response.headers["Content-Length"]), len(raw))
            self.assertEqual(json.loads(gzip.decompress(raw)), document)
        req = Request(self.base + "/api/workspace", headers={"Accept-Encoding": "gzip;q=0, *;q=1"})
        with urlopen(req, timeout=5) as response:
            self.assertIsNone(response.headers.get("Content-Encoding"))
            self.assertEqual(json.loads(response.read()), document)

    def test_bad_gzip_or_encoding_does_not_replace_previous_file(self):
        self.assertEqual(self.request("POST", EXAMPLE)[0], 200)
        previous = minipost.WORKSPACE_FILE.read_bytes()
        compressed = gzip.compress(compact_json(EXAMPLE))
        for invalid in (b"not gzip", compressed[:-1], compressed + b"trailing", gzip.compress(b"not JSON")):
            status, result = self.request("POST", invalid, headers={"Content-Encoding": "gzip"})
            self.assertEqual(status, 400, result)
            self.assertEqual(minipost.WORKSPACE_FILE.read_bytes(), previous)
        self.assertEqual(self.request("POST", compressed, headers={"Content-Encoding": "br"})[0], 415)
        self.assertEqual(minipost.WORKSPACE_FILE.read_bytes(), previous)

    def test_gzip_expansion_and_pool_expansion_limits_keep_previous_file(self):
        self.assertEqual(self.request("POST", EXAMPLE)[0], 200)
        previous = minipost.WORKSPACE_FILE.read_bytes()
        oversized = copy.deepcopy(EXAMPLE)
        oversized["workspace"]["scriptData"] = {"large": "a" * 10000}
        nodes = ["x" * 128]
        for index in range(1, 8):
            nodes.append(["a", [index - 1, index - 1]])
        bomb = {"kind": PACKED_WORKSPACE_KIND, "version": 1, "root": len(nodes) - 1, "nodes": nodes}
        with patch.object(minipost, "MAX_WORKSPACE_BYTES", 4096):
            self.assertEqual(self.request("POST", gzip.compress(compact_json(oversized)), headers={"Content-Encoding": "gzip"})[0], 413)
            self.assertEqual(self.request("POST", bomb)[0], 413)
        self.assertEqual(minipost.WORKSPACE_FILE.read_bytes(), previous)
        self.assertEqual(self.request("GET")[1], EXAMPLE)

    def test_invalid_pool_never_replaces_previous_file(self):
        self.assertEqual(self.request("POST", EXAMPLE)[0], 200)
        previous = minipost.WORKSPACE_FILE.read_bytes()
        invalid_nodes = [
            [["a", [0]]],                         # cycle
            ["value", ["a", [2]]],              # future reference
            ["value", ["o", ["key", 0, "key", 0]]],
            ["value", ["o", [0, 0]]],           # non-string key
            ["value", ["a", [True]]],           # bool is not an index
            ["value", ["object", []]],
        ]
        for nodes in invalid_nodes:
            payload = {"kind": PACKED_WORKSPACE_KIND, "version": 1, "root": len(nodes) - 1, "nodes": nodes}
            self.assertEqual(self.request("POST", payload)[0], 400)
            self.assertEqual(minipost.WORKSPACE_FILE.read_bytes(), previous)

    def test_failed_atomic_replace_keeps_previous_file(self):
        self.assertEqual(self.request("POST", EXAMPLE)[0], 200)
        previous = minipost.WORKSPACE_FILE.read_bytes()
        with patch.object(minipost.os, "replace", side_effect=OSError("disk failure")):
            self.assertNotEqual(self.request("POST", EXAMPLE)[0], 200)
        self.assertEqual(minipost.WORKSPACE_FILE.read_bytes(), previous)
        self.assertFalse(list(minipost.WORKSPACE_FILE.parent.glob(".workspace-*.tmp")))


class WorkspaceCodecTests(unittest.TestCase):
    def test_json_types_keys_unicode_and_independent_subtrees(self):
        item = {"__proto__": {"constructor": "保存\ud800"}, "number": -12.5, "boolean": True, "null": None, "list": []}
        source = {"items": [copy.deepcopy(item) for _ in range(100)], "order": {"z": 1, "a": 2}}
        packed = pack_workspace_bundle(source)
        self.assertEqual(packed["kind"], PACKED_WORKSPACE_KIND)
        restored = unpack_workspace_bundle(packed)
        self.assertEqual(restored, source)
        self.assertEqual(list(restored["order"]), ["z", "a"])
        restored["items"][0]["list"].append(1)
        self.assertEqual(restored["items"][1]["list"], [])
        self.assertEqual(json.loads(compact_json(source)), source)

    def test_plain_small_values_do_not_grow(self):
        source = {"a": 1}
        self.assertIs(pack_workspace_bundle(source), source)
        self.assertIs(unpack_workspace_bundle(source), source)

    def test_expansion_limits_precede_allocation_and_depth_is_bounded(self):
        nodes = ["value"]
        for index in range(1, 40):
            nodes.append(["a", [index - 1, index - 1]])
        with self.assertRaises(WorkspaceSizeError):
            unpack_workspace_bundle({"kind": PACKED_WORKSPACE_KIND, "version": 1, "root": 39, "nodes": nodes}, max_bytes=100000)
        nodes = [None] + [["a", [index]] for index in range(257)]
        with self.assertRaises(ValueError):
            unpack_workspace_bundle({"kind": PACKED_WORKSPACE_KIND, "version": 1, "root": 257, "nodes": nodes})


if __name__ == "__main__":
    unittest.main()
