"""Test-only MiniPost server with an immutable process/source identity."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import sys
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import Handler


def source_hashes():
    paths = [ROOT / 'app.py', ROOT / 'network.py', *sorted((ROOT / 'static').iterdir())]
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in paths if path.is_file()}


def main():
    identity = {'instance': os.environ['MINIPOST_TEST_INSTANCE'], 'files': source_hashes()}

    class TestHandler(Handler):
        def do_GET(self):
            if self.path == '/__relay_test_identity':
                self.send_json(200, identity)
            else:
                super().do_GET()

        def end_headers(self):
            self.send_header('Cache-Control', 'no-store')
            super().end_headers()

    server = ThreadingHTTPServer((os.getenv('HOST', '0.0.0.0'), int(os.getenv('PORT', '8080'))), TestHandler)
    # Readiness cannot be recorded if the port could not be bound.
    output = ROOT / '.local_relay/output/process-identity.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(identity, indent=2))
    server.serve_forever()


if __name__ == '__main__':
    main()
