"""Keyboard and context-menu focus continuity across rerendering editor controls.

Native HTTP/IndexedDB when run in CI. MINIPOST_INLINE_TEST=1 is a separate
DOM/UI fixture with a Python HTTP bridge, not native browser evidence.
"""
import json
import os
from pathlib import Path
import tempfile
from playwright.sync_api import expect, sync_playwright
from browser_app import BrowserApp
from test_proxy import proxy, start_server


def main():
    app_url = os.environ.get('MINIPOST_REMOTE_URL')
    app = None
    if not app_url:
        app, app_url = start_server(proxy.Handler)
    fixture = BrowserApp(app_url)
    folder = 'Operations'
    collection = {
        'info': {'name': 'UI focus checks', 'schema': 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
        'item': [{'name': folder, 'item': [
            {'name': 'POST content', 'request': {
                'method': 'POST', 'url': 'https://example.org/submit?mode=before',
                'header': [{'key': 'X-Key', 'value': 'original'}],
                'body': {'mode': 'raw', 'raw': '{"ready": true}', 'options': {'raw': {'language': 'json'}}}}},
            {'name': 'Read metrics', 'request': {'method': 'GET', 'url': 'https://example.org/metrics'}}
        ]}]
    }
    out = Path(os.getenv('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-focus-'))) / 'focus'
    out.mkdir(parents=True, exist_ok=True)
    checks, screenshots, errors = [], [], []

    def passed(message):
        checks.append(message)
        print('PASS ' + message, flush=True)

    def screenshot(page, name):
        # Startup warnings from the deliberately restricted inline test origin
        # must finish before recording the controls they would otherwise cover.
        expect(page.locator('#toast')).to_be_hidden(timeout=12000)
        page.screenshot(path=str(out / (name + '.png')), full_page=True)
        screenshots.append({'file': name + '.png', 'viewport': page.viewport_size})

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.getenv('CHROMIUM', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            page.on('pageerror', lambda error: errors.append(str(error)))
            fixture.open(page)
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            page.locator('#import').click()
            page.get_by_label('インポートJSON').fill(json.dumps(collection))
            page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_have_text('インポート完了')
            page.locator('#modalSubmit').click()

            collection_toggle = page.locator('#sidebarContent .tree-open').filter(has_text='UI focus checks')
            collection_toggle.click()
            expect(collection_toggle).to_be_focused()
            expect(collection_toggle).to_have_attribute('aria-expanded', 'false')
            collection_toggle.press('Enter')
            expect(collection_toggle).to_be_focused()
            expect(collection_toggle).to_have_attribute('aria-expanded', 'true')
            folder_toggle = page.locator('#sidebarContent .tree-open').filter(has_text=folder)
            folder_toggle.click()
            expect(folder_toggle).to_be_focused()
            folder_toggle.press('Enter')
            expect(folder_toggle).to_be_focused()
            expect(folder_toggle).to_have_attribute('aria-expanded', 'true')
            passed('folder and collection disclosure preserve keyboard focus after subtree repaint')
            screenshot(page, 'tree-disclosure-desktop')

            page.locator('.tree-open').filter(has_text='POST content').click()
            page.locator('#editor-tab-body').click()
            mode = page.locator('input[name=bodyMode][value=none]')
            mode.focus()
            mode.press('Space')
            expect(mode).to_be_focused()
            expect(mode).to_be_checked()
            raw = page.locator('input[name=bodyMode][value=raw]')
            raw.focus()
            raw.press('Space')
            expect(raw).to_be_focused()
            expect(page.get_by_label('Raw body')).to_have_value('{"ready": true}')
            passed('body format keyboard change retains focus and unmodified raw payload')
            screenshot(page, 'body-format-desktop')

            page.locator('#editor-tab-authorization').click()
            auth = page.get_by_label('認証方式', exact=True)
            auth.select_option('bearer')
            expect(auth).to_be_focused()
            page.get_by_label('Token', exact=True).fill('sample-value')
            auth.select_option('basic')
            expect(auth).to_be_focused()
            page.get_by_label('Username', exact=True).fill('local-user')
            expect(page.get_by_label('Password', exact=True)).to_be_visible()
            passed('auth type rebuild restores selector focus and exposes the new inputs')
            screenshot(page, 'auth-switch-desktop')

            page.locator('#editor-tab-headers').click()
            header = page.locator('.editor-section[data-pane=headers]')
            header.get_by_role('button', name='行 1 の操作').click()
            page.get_by_role('menuitem', name='この上に行を追加').click()
            expect(header.get_by_label('Key 1', exact=True)).to_be_focused()
            header.get_by_label('Key 1', exact=True).fill('X-Added')
            header.get_by_label('Value 1', exact=True).fill('test')
            expect(header.get_by_label('Key 2', exact=True)).to_have_value('X-Key')
            header.get_by_role('button', name='行 1 の操作').click()
            page.get_by_role('menuitem', name='削除', exact=True).click()
            expect(header.get_by_label('Key 1', exact=True)).to_be_focused()
            expect(header.get_by_label('Key 1', exact=True)).to_have_value('X-Key')
            header.get_by_role('button', name='行 1 の操作').click()
            page.get_by_role('menuitem', name='無効にする').click()
            expect(header.get_by_label('行 1 を有効にする')).to_be_focused()
            expect(header.get_by_label('行 1 を有効にする')).not_to_be_checked()
            passed('row add/delete/toggle return keyboard focus to the affected row')
            screenshot(page, 'header-row-desktop')

            page.locator('#editor-tab-body').click()
            page.locator('input[name=bodyMode][value=formdata]').check()
            body = page.locator('.editor-section[data-pane=body]')
            body.get_by_role('button', name='＋ 行を追加').click()
            expect(body.get_by_label('Key 1', exact=True)).to_be_focused()
            body.get_by_label('Key 1', exact=True).fill('payload')
            picker = body.locator('.kv-table tbody tr').first.locator('select')
            picker.select_option('file')
            expect(picker).to_be_focused()
            picker.select_option('text')
            expect(picker).to_be_focused()
            expect(body.get_by_label('Key 1', exact=True)).to_have_value('payload')
            passed('form-data type selection retains focus, key and text/file mode')
            screenshot(page, 'form-data-desktop')

            page.locator('#sidebarTabs [data-sidebar=relations]').click()
            page.locator('#sidebarAdd').click()
            page.get_by_role('menuitem', name='リレーションを作成').click()
            page.locator('#modalSubmit').click()
            expect(page.get_by_role('button', name='停止', exact=True)).to_be_disabled()
            expect(page.locator('#addRelationStep')).to_be_visible()
            passed('idle relation stop control cannot be activated')
            for number in range(1, 4):
                page.locator('#addRelationStep').click()
                expect(page.get_by_label(f'ステップ {number} のリクエスト')).to_be_focused()
            page.get_by_label('ステップ 3 のリクエスト').select_option(index=1)
            chosen = page.get_by_label('ステップ 3 のリクエスト').input_value()
            page.get_by_label('ステップ 3 を上へ').click()
            expect(page.get_by_label('ステップ 2 を上へ')).to_be_focused()
            expect(page.get_by_label('ステップ 2 のリクエスト')).to_have_value(chosen)
            page.get_by_label('ステップ 2 を上へ').click()
            expect(page.get_by_label('ステップ 1 を下へ')).to_be_focused()
            expect(page.get_by_label('ステップ 1 のリクエスト')).to_have_value(chosen)
            passed('relation steps add and reorder with repeatable keyboard focus and preserved request binding')
            screenshot(page, 'relation-reordered-desktop')

            page.get_by_label('ステップ 1 の操作').click()
            page.get_by_role('menuitem', name='この後にステップを追加').click()
            expect(page.get_by_label('ステップ 2 のリクエスト')).to_be_focused()
            page.get_by_label('ステップ 2 のリクエスト').select_option(index=2)
            inserted = page.get_by_label('ステップ 2 のリクエスト').input_value()
            page.get_by_label('ステップ 2 の操作').click()
            page.get_by_role('menuitem', name='複製', exact=True).click()
            expect(page.get_by_label('ステップ 3 のリクエスト')).to_be_focused()
            expect(page.get_by_label('ステップ 3 のリクエスト')).to_have_value(inserted)
            page.get_by_label('ステップ 3 の操作').click()
            page.get_by_role('menuitem', name='削除', exact=True).click()
            expect(page.get_by_label('ステップ 3 のリクエスト')).to_be_focused()
            passed('relation context insert/duplicate/delete maintain focus on the resulting step')
            # A rejected run must restore the control state; it must not leave
            # a Stop button that can be clicked forever with no running task.
            page.locator('#runRelation').click()
            expect(page.locator('#runRelation')).to_be_enabled()
            expect(page.get_by_role('button', name='停止', exact=True)).to_be_disabled()
            expect(page.locator('#relationRunLog')).to_contain_text('未選択のリクエスト')
            passed('invalid relation run restores Run/Stop controls and keeps the error visible')

            # Assign the missing steps and test a real abortable wait.
            for row in page.locator('.relation-step').all():
                row.locator('select').first.select_option(index=1)
            page.locator('.relation-step').first.get_by_label('開始前 ms').fill('10000')
            page.locator('#runRelation').click()
            expect(page.get_by_role('button', name='停止', exact=True)).to_be_enabled()
            page.get_by_role('button', name='停止', exact=True).click()
            expect(page.get_by_role('button', name='停止', exact=True)).to_be_disabled(timeout=5000)
            passed('relation stop is available only during execution and cancels the pending wait')

            for width, height in [(390, 844), (320, 720)]:
                page.set_viewport_size({'width': width, 'height': height})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                expect(page.get_by_label('ステップ 1 のリクエスト')).to_be_visible()
                screenshot(page, f'relation-phone-{width}')
            passed('relation editing remains visible and free of page overflow at 320 and 390px')
            assert not errors, errors
            passed('no uncaught browser JavaScript errors')
            (out.parent / 'ui-focus-results.json').write_text(json.dumps({'mode': 'DOM fixture + Python HTTP bridge' if fixture.inline else 'native Chromium HTTP', 'checks': checks, 'screenshots': screenshots, 'page_errors': errors}, ensure_ascii=False, indent=2))
            print(f'UI FOCUS: {len(checks)} checks, {len(screenshots)} screenshots', flush=True)
            browser.close()
    finally:
        if app is not None:
            app.shutdown()
            app.server_close()


if __name__ == '__main__':
    main()
