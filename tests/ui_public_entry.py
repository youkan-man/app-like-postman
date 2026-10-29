"""Native browser -> provider-published MiniPost -> provider-published receiver.

No private-peer fallback: missing public endpoints is a failed prerequisite.
Uses disposable test data only; never contacts a user's saved API endpoint.
"""
from __future__ import annotations
import hashlib
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit
from playwright.sync_api import expect, sync_playwright


def main():
    out = Path(os.environ.get('ARTIFACT_DIR', '.local_relay/output')) / 'public-entry'
    out.mkdir(parents=True, exist_ok=True)
    endpoints = [os.environ.get(f'LOCAL_RELAY_VM_{member}_PUBLIC_URL', '') for member in ['APP', 'BROWSER']]
    report = {'mode': 'native Chromium through provider-published endpoints', 'checks': [],
              'received': [], 'http_statuses': [], 'page_errors': [], 'native_dialogs': [],
              'source_urls_recorded': False, 'stage': 'public endpoint prerequisites', 'status': 'running'}
    receiver = None
    def safe(value):
        text = str(value)
        for url in endpoints:
            if url:
                text = text.replace(url, '<provider-public-endpoint>')
                parsed = urlsplit(url)
                text = text.replace(parsed.netloc, '<provider-host>')
        return text
    def passed(name):
        report['checks'].append(name)
        print('PASS ' + name, flush=True)
    try:
        if not all(endpoints):
            raise RuntimeError('Provider did not expose both public endpoints; private VM IPs are not a substitute.')
        for url in endpoints:
            parts = urlsplit(url)
            if parts.scheme not in {'http', 'https'} or not parts.netloc or parts.username or parts.password or parts.query or parts.fragment:
                raise RuntimeError('Public endpoint is not a plain HTTP origin/path; do not publish embedded credentials.')
        app_url, receiver_url = endpoints
        class Receiver(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def receive(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                row = {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'method': self.command}
                report['received'].append(row)
                binary = self.path == '/echo-binary'
                output = body if binary else json.dumps(row).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream' if binary else 'application/json')
                self.send_header('Content-Length', str(len(output)))
                self.end_headers(); self.wfile.write(output)
            do_POST = do_PUT = do_PATCH = receive
        receiver = ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('LOCAL_RELAY_VM_BROWSER_PORT') or 18081)), Receiver)
        Thread(target=receiver.serve_forever, daemon=True).start()
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.getenv('CHROMIUM'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 920})
            page.set_default_timeout(15000)
            page.on('pageerror', lambda error: report['page_errors'].append(safe(error)))
            def native(dialog):
                report['native_dialogs'].append(dialog.type); dialog.dismiss()
            page.on('dialog', native)
            def observed(response):
                if urlsplit(response.url).path.endswith('/api/request'):
                    report['http_statuses'].append(response.status)
            page.on('response', observed)
            try:
                report['stage'] = 'open published MiniPost and connect backend'
                page.goto(app_url, wait_until='domcontentloaded')
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                passed('provider-published MiniPost renders and its backend health connects')
                page.locator('#method').select_option('POST')
                page.locator('#editor-tab-body').click()
                page.locator('input[name=bodyMode][value=file]').check()
                def send(data, name, method='POST', binary_response=False):
                    report['stage'] = f'{method} {len(data)}-byte upload with ' + ('binary' if binary_response else 'JSON') + ' response'
                    page.locator('#method').select_option(method)
                    page.locator('#url').fill(receiver_url.rstrip('/') + ('/echo-binary' if binary_response else '/bytes'))
                    picker = page.locator('[data-file-slot=binary] .file-pick')
                    with page.expect_file_chooser() as chooser:
                        picker.click()
                    chooser.value.set_files({'name': name, 'mimeType': 'application/octet-stream', 'buffer': data})
                    expect(picker).to_have_attribute('aria-busy', 'false')
                    before = len(report['received'])
                    page.locator('#send').click()
                    expect(page.locator('#send')).to_contain_text('Send', timeout=60000)
                    expect(page.locator('#responseStatus')).to_contain_text('200')
                    assert len(report['received']) == before + 1, 'receiver did not observe exactly one request'
                    actual = report['received'][-1]
                    assert actual == {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'method': method}, actual
                    if binary_response:
                        expect(page.locator('.response-code')).to_contain_text('binary')
                    else:
                        assert json.loads(page.locator('.response-code').inner_text()) == actual
                    passed(report['stage'] + ' matches receiver length and SHA-256 through both public endpoints')
                for data, name in [(bytes([0,1,127,128,254,255]), 'first.bin'), (b'', 'empty.bin'),
                                   (bytes(range(256)), 'all-bytes.bin'), (bytes(range(256))*24576, 'six-mib.bin'),
                                   (bytes(range(256))*32768, 'eight-mib.bin')]:
                    send(data, name)
                for method in ['PUT', 'PATCH']:
                    send(bytes(range(256))*4096, 'one-mib.bin', method)
                send(bytes(range(256)), 'binary-response.bin', binary_response=True)
                assert not report['page_errors'], report['page_errors']
                assert not report['native_dialogs'], report['native_dialogs']
                passed('no uncaught JavaScript errors or browser-native dialogs')
                page.locator('#url').fill('http://test-receiver.invalid/echo-binary')
                page.screenshot(path=str(out / 'public-entry-success.png'), full_page=True)
                report['status'] = 'succeeded'
            except Exception:
                report['visible_status'] = safe(page.locator('#responseStatus').inner_text(timeout=1000)) if page.locator('#responseStatus').count() else 'app not rendered'
                if page.locator('#responseContent').count():
                    report['visible_error'] = safe(page.locator('#responseContent').inner_text())[:2000]
                raise
            finally:
                browser.close()
    except Exception as error:
        report['status'] = 'failed'; report['error'] = safe(error)
        print('FAIL ' + report['stage'] + ': ' + safe(error), flush=True)
        raise SystemExit(1)
    finally:
        if receiver is not None: receiver.shutdown(); receiver.server_close()
        (out / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))

if __name__ == '__main__': main()
