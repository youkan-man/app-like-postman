"""Native IndexedDB + HTTP: migration, quota recovery and atomic server restore.

This suite requires a normal HTTP browser origin. It deliberately has no inline
storage mock: tests/storage.test.mjs covers the isolated storage unit tests.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import tempfile
from playwright.sync_api import expect, sync_playwright
from test_proxy import proxy, start_server

READ = """() => new Promise((resolve, reject) => {
  const open = indexedDB.open('minipost.workspace.v1', 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result, tx = db.transaction('state'), request = tx.objectStore('state').get('workspace');
    tx.oncomplete = () => {db.close(); resolve(request.result ? JSON.parse(request.result.json) : null);};
    tx.onabort = () => {db.close(); reject(tx.error);};
  };
})"""
FAIL_LOCAL = """() => {
  Storage.prototype.setItem = function() {throw new DOMException('test quota', 'QuotaExceededError');};
}"""

def main():
    with tempfile.TemporaryDirectory(prefix='minipost-storage-') as temp:
        original = proxy.WORKSPACE_FILE
        proxy.WORKSPACE_FILE = Path(temp) / 'workspace.json'
        server, url = start_server(proxy.Handler)
        out = Path(os.environ.get('ARTIFACT_DIR', temp)) / 'storage'
        out.mkdir(parents=True, exist_ok=True)
        checks, errors, dialog_metrics = [], [], []
        def passed(text):
            checks.append(text); print('PASS ' + text, flush=True)
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True, args=['--no-sandbox'])
                context = browser.new_context(viewport={'width': 1440, 'height': 900})
                page = context.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(url, wait_until='domcontentloaded')
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                page.locator('#url').fill('https://example.test/original')
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
                seed = page.evaluate(READ)
                assert seed['tabs'][0]['request']['url']
                # Reopen a fresh origin context containing only legacy localStorage.
                context.close(); context = browser.new_context(viewport={'width': 1440, 'height': 900})
                context.add_init_script("if (!localStorage.getItem('legacySeeded')) {localStorage.setItem('minipost.workspace.v2', " + json.dumps(json.dumps(seed)) + "); localStorage.setItem('legacySeeded', '1');}")
                page = context.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(url, wait_until='domcontentloaded')
                expect(page.locator('#url')).to_have_value('https://example.test/original')
                assert page.evaluate(READ)['tabs'] == seed['tabs']
                passed('existing localStorage workspace migrates to native IndexedDB without losing drafts')

                # Inject a valid large backup through the real user import flow.
                large = json.loads(json.dumps(seed)); large['globals'] = [{'key': 'large-test-value', 'value': 'x' * (6 * 1024 * 1024), 'enabled': True}]
                bundle = {'kind': 'minipost.workspace', 'version': 1, 'workspace': large,
                          'layout': {'layout': {'sidebar': 280}, 'sections': ['body'], 'navigation': {'editor': 'body', 'sidebar': 'collections', 'response': 'pretty'}}}
                backup = Path(temp) / 'large.json'; backup.write_text(json.dumps(bundle))
                page.locator('#import').click()
                page.locator('input[type=file]:not([webkitdirectory])').first.set_input_files(backup)
                page.locator('#modalSubmit').click()
                expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
                page.locator('#modalSubmit').click()
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                page.wait_for_function("document.documentElement.dataset.editorPage === 'body'")
                assert len(page.evaluate(READ)['globals'][0]['value']) == 6 * 1024 * 1024
                assert page.evaluate("localStorage.getItem('minipost.workspace.v2')") is None
                passed('6 MiB workspace is saved intact without a full localStorage duplicate')
                assert not proxy.WORKSPACE_FILE.exists()

                # Quota/security failure is now permanent across reloads in this context.
                page.evaluate(FAIL_LOCAL); context.add_init_script('(' + FAIL_LOCAL + ')()')
                page.locator('#url').fill('https://example.test/server-snapshot')
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
                page.locator('#dataActions').click(); page.get_by_role('menuitem', name='サーバーへ保存', exact=True).click()
                expect(page.locator('#serverSaveState')).to_have_class('saved', timeout=15000)
                saved_server = json.loads(proxy.WORKSPACE_FILE.read_text())
                page.locator('#url').fill('https://example.test/local-newer')
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
                page.reload(wait_until='domcontentloaded')
                expect(page.locator('#url')).to_have_value('https://example.test/local-newer')
                assert json.loads(proxy.WORKSPACE_FILE.read_text()) == saved_server
                passed('edits survive reload with every localStorage write denied; server stays opt-in')

                page.locator('#dataActions').click(); page.get_by_role('menuitem', name='サーバーから読込', exact=True).click()
                expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
                page.screenshot(path=str(out / 'server-restore-desktop.png'), full_page=True)
                page.set_viewport_size({'width': 390, 'height': 844})
                page.screenshot(path=str(out / 'server-restore-phone.png'), full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.locator('#modalSubmit').click()
                expect(page.locator('#url')).to_have_value('https://example.test/server-snapshot')
                assert page.evaluate(READ) == saved_server['workspace']
                page.reload(wait_until='domcontentloaded')
                expect(page.locator('#url')).to_have_value('https://example.test/server-snapshot')
                passed('explicit server restore commits and survives reload despite full localStorage')

                page.set_viewport_size({'width': 1440, 'height': 900})
                page.locator('#url').fill('https://example.test/keep-on-failure')
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
                before = page.evaluate(READ)
                page.locator('#dataActions').click(); page.get_by_role('menuitem', name='サーバーから読込', exact=True).click()
                expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
                page.evaluate("""() => {
                  window.__put = IDBObjectStore.prototype.put;
                  IDBObjectStore.prototype.put = function(value, key) {
                    if (key === 'preferences') throw new DOMException('forced second write failure', 'QuotaExceededError');
                    return window.__put.call(this, value, key);
                  };
                }""")
                page.locator('#modalSubmit').click()
                expect(page.locator('#modalMessage')).to_contain_text('既存のワークスペースは維持')
                assert page.evaluate(READ) == before
                page.evaluate('() => {IDBObjectStore.prototype.put = window.__put;}')
                for width, height, name in [(1440, 900, 'restore-failure-preserved'), (320, 720, 'restore-failure-320')]:
                    page.set_viewport_size({'width': width, 'height': height})
                    for identifier in ['modalMessage', 'cancelModal', 'modalSubmit']:
                        expect(page.locator('#' + identifier)).to_be_in_viewport(ratio=1)
                    metrics = page.locator('#modal').evaluate('''node => {
                        const box=node.getBoundingClientRect(),body=node.querySelector('#modalBody');
                        const cancel=node.querySelector('#cancelModal').getBoundingClientRect();
                        const submit=node.querySelector('#modalSubmit').getBoundingClientRect();
                        return {width:innerWidth,height:innerHeight,top:box.top,bottom:box.bottom,
                            left:box.left,right:box.right,dialog_height:box.height,
                            body_scroll_width:body.scrollWidth,body_client_width:body.clientWidth,
                            document_width:document.documentElement.scrollWidth,
                            cancel_top:cancel.top,submit_top:submit.top,cancel_right:cancel.right,submit_left:submit.left};
                    }''')
                    dialog_metrics.append(metrics)
                    assert metrics['left'] >= 0 and metrics['right'] <= width, metrics
                    assert metrics['top'] >= 0 and metrics['bottom'] <= height, metrics
                    assert metrics['body_scroll_width'] <= metrics['body_client_width'], metrics
                    assert metrics['document_width'] <= width, metrics
                    assert abs(metrics['cancel_top'] - metrics['submit_top']) <= 1, metrics
                    assert metrics['cancel_right'] <= metrics['submit_left'], metrics
                    page.screenshot(path=str(out / (name + '.png')), full_page=True)
                page.set_viewport_size({'width': 1440, 'height': 900})
                page.locator('#closeModal').click()
                expect(page.locator('#url')).to_have_value('https://example.test/keep-on-failure')
                passed('aborting the second IndexedDB write preserves both live and durable workspace')

                # The same server URL must not automatically leak backups to a new browser.
                other = browser.new_context(); fresh = other.new_page(); fresh.goto(url, wait_until='domcontentloaded')
                expect(fresh.locator('#connectionStatus')).to_contain_text('connected')
                expect(fresh.locator('#url')).to_have_value('')
                assert fresh.evaluate(READ) is None
                passed('a separate browser profile remains empty until explicit server import')
                other.close()
                assert not errors, errors
                (out / 'result.json').write_text(json.dumps({'checks': checks, 'errors': errors, 'native_indexeddb': True,
                    'dialog_metrics': dialog_metrics,
                    'screenshots': ['server-restore-desktop.png', 'server-restore-phone.png', 'restore-failure-preserved.png', 'restore-failure-320.png']}, ensure_ascii=False, indent=2))
                browser.close()
        finally:
            server.shutdown(); server.server_close(); proxy.WORKSPACE_FILE = original

if __name__ == '__main__':
    main()
