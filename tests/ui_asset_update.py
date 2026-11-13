"""Native HTTP regression for upgrading while old ES modules remain cached.

The fixture serves two deliberately old module APIs with long-lived cache
headers, then switches to the current Handler on the same browser origin.
All current assets and workspace operations use the real application HTTP UI.
"""
from __future__ import annotations

from collections import Counter
from contextlib import contextmanager
import hashlib
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from threading import Lock, Thread
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright
from test_proxy import proxy


READ_WORKSPACE = """() => new Promise((resolve, reject) => {
  const open = indexedDB.open('minipost.workspace.v1', 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result, tx = db.transaction('state');
    const request = tx.objectStore('state').get('workspace');
    tx.oncomplete = () => {db.close(); resolve(request.result ? JSON.parse(request.result.json) : null);};
    tx.onabort = () => {db.close(); reject(tx.error);};
  };
})"""

PROBE = b"""<!doctype html><title>Legacy module cache</title>
<button id="stopRelationGlobal"></button><button id="extractResponse"></button><div id="sidebarContent"></div>
<script type="module">
import {RevisionStore} from '/revisions.mjs';
import {initStudio} from '/studio.mjs';
const workspace = {collections:[], environments:[], globals:[], tabs:[], history:[]};
const revisions = new RevisionStore(workspace);
const studio = initStudio({$:id=>document.getElementById(id), workspace:()=>workspace, toast:()=>{}});
const failures = [];
for (const call of [()=>revisions.remove('draft:old'), ()=>studio.forgetResponse('draft:old')]) {
  try {call();} catch (error) {failures.push(error.name+': '+error.message);}
}
window.__legacyProbe = {remove:typeof revisions.remove, forget:typeof studio.forgetResponse, failures};
</script>"""


def main():
    if os.environ.get('MINIPOST_INLINE_TEST') == '1':
        raise RuntimeError('ui_asset_update requires a real HTTP browser origin')
    current_revisions = (proxy.STATIC_DIR/'revisions.mjs').read_text()
    legacy_revisions, count = re.subn(r'\n  remove\(key\) \{.*?\n  \}', '', current_revisions, count=1, flags=re.S)
    assert count == 1, 'Legacy fixture must remove the actual new RevisionStore API'
    current_studio = (proxy.STATIC_DIR/'studio.mjs').read_text()
    legacy_studio, count = re.subn(r'(return \{primary,execute,rememberResponse,responseFor,transferResponse),forgetResponse,',
                                 r'\1,', current_studio, count=1)
    assert count == 1, 'Legacy fixture must remove the actual exported Studio deletion API'
    legacy = {'/revisions.mjs': legacy_revisions.encode(), '/studio.mjs': legacy_studio.encode()}
    counts, log, lock = Counter(), [], Lock()
    phase = {'value': 'legacy'}

    class UpdateHandler(proxy.Handler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            path = urlsplit(self.path).path
            with lock:
                counts[path] += 1
                log.append((phase['value'], path))
            content = PROBE if path == '/cache-probe' else legacy.get(path) if phase['value'] == 'legacy' else None
            if content is None:
                return super().do_GET()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8' if path == '/cache-probe' else 'text/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-store' if path == '/cache-probe' else 'public, max-age=31536000')
            self.end_headers()
            self.wfile.write(content)

    server = ThreadingHTTPServer(('127.0.0.1', 0), UpdateHandler)
    Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-asset-update-')))/'asset-update'
    out.mkdir(parents=True, exist_ok=True)
    checks, errors, dialogs, crashes, screenshots = [], [], [], [], []
    completed = False
    page = None

    def passed(name):
        checks.append(name)
        print('PASS '+name, flush=True)

    @contextmanager
    def capture_failure():
        try:
            yield
        except Exception:
            try:
                if page and not page.is_closed():
                    page.screenshot(path=str(out/'failure.png'), full_page=True)
                    screenshots.append('failure.png')
            except Exception as error:
                print('Could not capture failure screenshot: '+str(error), flush=True)
            raise

    try:
        with sync_playwright() as playwright, capture_failure():
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM') or shutil.which('chromium'),
                                                 headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
            page.on('crash', lambda: crashes.append('page crashed'))
            page.goto(origin+'/cache-probe', wait_until='domcontentloaded')
            page.wait_for_function('window.__legacyProbe !== undefined')
            old = page.evaluate('window.__legacyProbe')
            assert old['remove'] == old['forget'] == 'undefined', old
            assert len(old['failures']) == 2 and all('TypeError' in value for value in old['failures']), old
            with lock:
                warmed_counts = {path: counts[path] for path in legacy}
            assert all(count == 1 for count in warmed_counts.values()), warmed_counts
            passed('legacy root modules are loaded over HTTP and expose the exact missing deletion APIs')

            phase['value'] = 'current'
            static_headers = {}
            page.on('response', lambda response: static_headers.update({urlsplit(response.url).path: response.headers})
                    if urlsplit(response.url).path.startswith('/assets/') else None)
            page.goto(origin+'/', wait_until='domcontentloaded')
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            expect(page.locator('#requestName')).to_be_visible()
            with lock:
                current_paths = [path for stage, path in log if stage == 'current']
            scripts_and_styles = [path for path in current_paths if path.endswith(('.js', '.mjs', '.css'))]
            assert scripts_and_styles and all(path.startswith('/assets/') for path in scripts_and_styles), scripts_and_styles
            assert {'/assets/app.js', '/assets/revisions.mjs', '/assets/studio.mjs'} <= set(scripts_and_styles)
            assert all(static_headers[path].get('cache-control') == 'no-store' for path in scripts_and_styles)
            assert page.evaluate("async () => typeof (await import('/assets/revisions.mjs')).RevisionStore.prototype.remove") == 'function'
            passed('updated application and its relative module graph load exclusively from uncached assets URLs')

            cached_hashes = page.evaluate("""async paths => Object.fromEntries(await Promise.all(paths.map(async path => {
              const bytes = await (await fetch(path, {cache:'force-cache'})).arrayBuffer();
              const digest = await crypto.subtle.digest('SHA-256', bytes);
              return [path, Array.from(new Uint8Array(digest), value=>value.toString(16).padStart(2,'0')).join('')];
            })))""", list(legacy))
            assert cached_hashes == {path: hashlib.sha256(body).hexdigest() for path, body in legacy.items()}
            with lock:
                assert {path: counts[path] for path in legacy} == warmed_counts
            passed('old module bytes remain in the real browser cache without an additional server read')

            settings = {'verify_tls': False, 'follow_redirects': True, 'timeout_ms': 30000}
            drafts = [{'id': f'cache-draft-{index}', 'name': f'Cached workspace draft {index}', 'dirty': True,
                       'settings': settings.copy(), 'request': {'method': 'GET', 'url': origin+'/api/health', 'header': []}}
                      for index in [1, 2]]
            workspace = {'version': 2, 'collections': [], 'environments': [], 'globals': [], 'tabs': drafts,
                         'activeId': drafts[0]['id'], 'environmentId': '', 'history': [], 'collapsed': [],
                         'revisions': {'draft:'+draft['id']: [{'value': {'name': draft['name'],
                                       'request': draft['request'], 'settings': draft['settings']}}] for draft in drafts}}
            page.locator('#import').click()
            page.get_by_label('インポートJSON', exact=True).fill(json.dumps({
                'kind': 'minipost.workspace', 'version': 1, 'workspace': workspace,
                'layout': {'navigation': {'editor': 'params', 'sidebar': 'collections', 'response': 'pretty'}}}))
            page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
            with page.expect_navigation(wait_until='domcontentloaded'):
                page.locator('#modalSubmit').click()
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            first = page.locator('[data-draft-id="cache-draft-1"] [data-select-open]')
            second = page.locator('[data-draft-id="cache-draft-2"] [data-select-open]')
            first.click()
            second.click(modifiers=['Control'])
            expect(page.locator('[data-draft-id].list-selected')).to_have_count(2)
            first.press('Delete')
            expect(page.locator('#appConfirm')).to_have_count(1)
            page.locator('#appConfirm').get_by_role('button', name='削除', exact=True).click()
            expect(page.locator('[data-draft-id]')).to_have_count(0)
            expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
            after = page.evaluate(READ_WORKSPACE)
            assert after['tabs'] == [] and not any(key.startswith('draft:') for key in after['revisions'])
            passed('bulk deletion completes with warmed legacy caches and removes both drafts and their revisions')
            page.reload(wait_until='domcontentloaded')
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            expect(page.locator('[data-draft-id]')).to_have_count(0)
            after = page.evaluate(READ_WORKSPACE)
            assert after['tabs'] == [] and not any(key.startswith('draft:') for key in after['revisions'])
            assert not errors and not dialogs and not crashes, (errors, dialogs, crashes)
            page.screenshot(path=str(out/'warm-cache-delete-desktop.png'), full_page=True)
            screenshots.append('warm-cache-delete-desktop.png')
            passed('reload preserves the empty draft list without partial deletion, native dialogs or browser errors')
            completed = True
            browser.close()
    finally:
        (out/'results.json').write_text(json.dumps({'ok': completed, 'mode': 'native Chromium HTTP',
            'checks': checks, 'page_errors': errors, 'native_dialogs': dialogs, 'crashes': crashes,
            'screenshots': screenshots, 'legacy_sha256': {path: hashlib.sha256(body).hexdigest() for path, body in legacy.items()}},
            ensure_ascii=False, indent=2))
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
