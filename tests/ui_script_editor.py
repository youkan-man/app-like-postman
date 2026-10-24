"""Native HTTP application acceptance for scripting and completion; never inline."""
from __future__ import annotations
import json
import os
from pathlib import Path
import tempfile
from playwright.sync_api import expect, sync_playwright
from test_proxy import proxy, start_server
from script_editor_checks import check_editor


def main():
    if os.environ.get('MINIPOST_INLINE_TEST') == '1':
        raise RuntimeError('This acceptance suite requires a real HTTP origin')
    server = None
    url = os.environ.get('MINIPOST_REMOTE_URL')
    if not url:
        server, url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-script-'))) / 'script-editor'
    out.mkdir(parents=True, exist_ok=True)
    checks, shots, errors = [], [], []
    def passed(message):
        checks.append(message)
        print('PASS '+message, flush=True)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width':1440,'height':1000})
            page.set_default_timeout(10000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(url, wait_until='domcontentloaded')
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            page.locator('#editor-tab-scripts').click()
            area=page.get_by_label('送信前スクリプト',exact=True)
            root=page.locator('#script-panel-before .source-editor')
            def capture(name):
                page.screenshot(path=str(out/(name+'.png')),full_page=True)
                shots.append(name+'.png')
            check_editor(page,area,root,passed,capture)

            # Verify the actual isolated Worker, not an evaluator in the test process.
            area.fill("pm.test('script assertion', () => pm.expect(2 + 2).to.equal(4)); vars.set('editorVerified', 'yes');")
            page.locator('#script-panel-before').get_by_role('button',name='このスクリプトを実行',exact=True).click()
            expect(page.locator('#scriptLog')).to_contain_text('PASS script assertion')
            assert page.evaluate("JSON.parse(sessionStorage.getItem('minipost.primary.v1')).some(x=>x.key==='editorVerified'&&x.value==='yes')")
            passed('edited pre-script executes in the isolated Worker and commits its successful variable write')

            area.fill("vars.set('rejectedWrite', 'no'); pm.test('reject', () => pm.expect(1).to.equal(2));")
            page.locator('#script-panel-before').get_by_role('button',name='このスクリプトを実行',exact=True).click()
            expect(page.locator('#scriptLog')).to_contain_text('Expected')
            assert not page.evaluate("JSON.parse(sessionStorage.getItem('minipost.primary.v1')).some(x=>x.key==='rejectedWrite')")
            passed('a failing assertion keeps partial variable writes out of session state')

            page.locator('#script-tab-after').click()
            after=page.get_by_label('受信後スクリプト',exact=True)
            after.fill('console.l')
            after.press('Tab')
            expect(after).to_have_value('console.log')
            after.fill('console.log(response.status);')
            expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
            page.reload(wait_until='domcontentloaded')
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            page.locator('#editor-tab-scripts').click()
            page.locator('#script-tab-after').click()
            expect(page.get_by_label('受信後スクリプト',exact=True)).to_have_value('console.log(response.status);')
            passed('post-script completion and IndexedDB autosave survive an HTTP reload')
            assert not errors, errors
            passed('no uncaught browser JavaScript errors')
            browser.close()
    finally:
        (out/'results.json').write_text(json.dumps({'mode':'native Chromium HTTP','checks':checks,'screenshots':shots,'errors':errors},ensure_ascii=False,indent=2))
        if server:
            server.shutdown();server.server_close()


if __name__ == '__main__':
    main()
