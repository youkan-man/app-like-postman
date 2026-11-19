"""Native HTTP application acceptance for scripting and completion; never inline."""
from __future__ import annotations
from contextlib import contextmanager
import json
import os
from pathlib import Path
import tempfile
from playwright.sync_api import expect, sync_playwright
from test_proxy import proxy, start_server
from script_editor_checks import check_editor


def check_json_formatting(page, passed, capture):
    page.locator('#editor-tab-body').click()
    body_mode = page.get_by_label('本文の形式', exact=True)
    body_mode.select_option('raw')
    expect(body_mode).to_have_value('raw')
    page.get_by_label('本文のフォーマット', exact=True).select_option('json')
    area = page.get_by_label('Raw body', exact=True)
    original = '{"name":"Ada","enabled":true,"items":[1,2]}'
    formatted = json.dumps(json.loads(original), ensure_ascii=False, indent=2)
    area.fill('')
    area.press_sequentially(original, delay=8)
    expect(area).to_have_value(original)
    # Keep a real user selection so format/Undo cannot silently replace the
    # editor and reset its input history or caret to the start/end of the body.
    area.press('Home')
    area.press('ArrowRight')
    for _ in range(6):
        area.press('Shift+ArrowRight')
    selection = area.evaluate('element => [element.selectionStart, element.selectionEnd, element.selectionDirection]')
    assert selection[:2] == [1, 7]
    page.get_by_role('button', name='JSON整形', exact=True).click()
    expect(area).to_have_value(formatted)
    expect(area).to_be_focused()
    for width, height in [(1440, 1000), (390, 844), (320, 720)]:
        page.set_viewport_size({'width': width, 'height': height})
        expect(area).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        capture('body-json-formatted-' + str(width))
    page.set_viewport_size({'width': 1440, 'height': 1000})
    area.press('Control+z')
    expect(area).to_have_value(original)
    assert area.evaluate('element => [element.selectionStart, element.selectionEnd, element.selectionDirection]') == selection
    expect(area).to_be_focused()
    area.press('Control+Shift+z')
    expect(area).to_have_value(formatted)
    expect(area).to_be_focused()
    passed('JSON formatting stays in the native edit history: Undo restores the exact typed body and selection, and Redo reapplies it')
    page.locator('#editor-tab-scripts').click()
    page.locator('#script-tab-before').click()


def main():
    if os.environ.get('MINIPOST_INLINE_TEST') == '1':
        raise RuntimeError('This acceptance suite requires a real HTTP origin')
    server = None
    url = os.environ.get('MINIPOST_REMOTE_URL')
    if not url:
        server, url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-script-'))) / 'script-editor'
    out.mkdir(parents=True, exist_ok=True)
    checks, shots, errors, dialogs, crashes = [], [], [], [], []
    page = None
    completed = False
    def passed(message):
        checks.append(message)
        print('PASS '+message, flush=True)

    @contextmanager
    def capture_failure():
        try:
            yield
        except Exception:
            if page and not page.is_closed():
                try:
                    page.screenshot(path=str(out/'failure.png'), full_page=True)
                    shots.append('failure.png')
                except Exception:
                    pass
            raise

    try:
        with sync_playwright() as p, capture_failure():
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width':1440,'height':1000})
            page.set_default_timeout(10000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
            page.on('crash', lambda: crashes.append('page crashed'))
            page.goto(url, wait_until='domcontentloaded')
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            page.locator('#editor-tab-scripts').click()
            area=page.get_by_label('送信前スクリプト',exact=True)
            root=page.locator('#script-panel-before .source-editor')
            def capture(name):
                page.screenshot(path=str(out/(name+'.png')),full_page=True)
                shots.append(name+'.png')
            check_editor(page,area,root,passed,capture)
            check_json_formatting(page,passed,capture)

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
            expect(page.locator('#script-panel-after .source-editor')).to_have_attribute('data-intelligence','ready',timeout=30000)
            expect(page.locator('#script-panel-after .source-suggestions').get_by_role('option',name='log',exact=True)).to_be_visible()
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
            assert not dialogs, dialogs
            assert not crashes, crashes
            passed('no uncaught browser JavaScript errors, native dialogs or page crashes')
            completed = True
            browser.close()
    finally:
        (out/'results.json').write_text(json.dumps({'ok':completed,'mode':'native Chromium HTTP','checks':checks,'screenshots':shots,'errors':errors,'native_dialogs':dialogs,'crashes':crashes},ensure_ascii=False,indent=2))
        if server:
            server.shutdown();server.server_close()


if __name__ == '__main__':
    main()
