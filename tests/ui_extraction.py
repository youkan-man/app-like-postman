"""Extraction-dialog UI contracts; default uses the real HTTP proxy and Chromium.

MINIPOST_INLINE_TEST=1 is explicitly a DOM fixture + Python HTTP bridge,
not native browser HTTP/IndexedDB evidence. Neither mode changes browser policy.
"""
import json
import os
from http.server import BaseHTTPRequestHandler
from pathlib import Path
import tempfile
from playwright.sync_api import expect, sync_playwright
from browser_app import BrowserApp
from test_proxy import proxy, start_server


class MetadataHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        payload = {'method': 'GET', 'result': {'message': '取得済みのレスポンス',
                   'items': {f'field_{i:03}': i for i in range(100)},
                   'key/with~escape': False, 'long_' + 'value_' * 40: '日本語' * 70}}
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    echo, echo_url = start_server(MetadataHandler)
    app, app_url = start_server(proxy.Handler)
    fixture = BrowserApp(app_url)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-extraction-'))) / 'extraction'
    out.mkdir(parents=True, exist_ok=True)
    checks, shots, errors = [], [], []
    result = {'mode': 'DOM fixture + Python HTTP bridge' if fixture.inline else 'native Chromium HTTP',
              'checks': checks, 'screenshots': shots, 'page_errors': errors}

    def passed(message):
        checks.append(message)
        print('PASS ' + message, flush=True)

    sample = {'info': {'name': 'Extraction API', 'schema': 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
              'item': [{'name': 'Read metadata', 'request': {'method': 'GET',
                        'url': echo_url + '/metadata?token={{token}}&other={{other}}&long={{' + 'long_variable_' * 8 + '}}'}}]}
    environment = {'name': 'Development', '_postman_variable_scope': 'environment',
                   'values': [{'key': 'token', 'value': 'existing-token'}, {'key': 'other', 'value': 'existing-other'}, {'key': 'long_variable_' * 8, 'value': 'long-key-value'}]}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.on('pageerror', lambda error: errors.append(str(error)))
            fixture.open(page)
            expect(page.locator('#connectionStatus')).to_contain_text('connected')

            def capture(name):
                page.wait_for_function('document.fonts.status === "loaded"')
                expect(page.locator('#toast')).to_be_hidden(timeout=15000)
                page.screenshot(path=str(out / (name + '.png')), full_page=True)
                shots.append({'file': name + '.png', 'viewport': page.viewport_size})

            def load(value):
                page.locator('#import').click()
                page.get_by_label('インポートJSON').fill(json.dumps(value))
                page.locator('#modalSubmit').click()
                expect(page.locator('#modalTitle')).to_have_text('インポート完了')
                page.locator('#modalSubmit').click()

            def side(name):
                if page.locator('#sidebarTabs').is_hidden():
                    page.locator('#toggleSidebar').click()
                page.locator(f'#sidebarTabs [data-sidebar={name}]').click()

            def request():
                side('collections')
                page.locator('.tree-open').filter(has=page.locator('.tree-label', has_text='Read metadata')).click()
                expect(page.locator('#requestName')).to_have_value('Read metadata')

            def extract_environment():
                request()
                page.get_by_role('button', name='Read metadataの操作', exact=True).click()
                page.get_by_role('menuitem', name='環境変数を抽出', exact=True).click()
                expect(page.locator('.extraction-dialog')).to_be_visible()

            def no_overflow(selector):
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                assert page.locator(selector).evaluate('e=>e.scrollWidth <= e.clientWidth + 1'), selector

            load(sample)
            load(environment)
            extract_environment()
            target = page.get_by_label('抽出先環境', exact=True)
            original_id = target.input_value()
            expect(page.get_by_label('新しい環境名', exact=True)).to_be_hidden()
            expect(page.get_by_label('既存の同名変数を上書き', exact=True)).to_be_visible()
            token = page.get_by_label('tokenの値', exact=True)
            token.fill('edited-but-not-applied')
            token.evaluate('e=>window.__candidateNode=e')
            page.get_by_label('otherを抽出', exact=True).uncheck()
            capture('environment-existing-desktop')
            target.select_option('__new__')
            expect(page.get_by_label('新しい環境名', exact=True)).to_be_visible()
            expect(page.get_by_label('既存の同名変数を上書き', exact=True)).to_be_hidden()
            page.get_by_label('新しい環境名', exact=True).fill('Draft environment')
            target.select_option(original_id)
            assert token.evaluate('e=>e===window.__candidateNode')
            expect(token).to_have_value('edited-but-not-applied')
            expect(page.get_by_label('otherを抽出', exact=True)).not_to_be_checked()
            passed('target changes only toggle relevant fields and preserve actual controls, values and checks')

            candidate = page.locator('.extraction-candidate').first
            candidate.locator('label').click()
            expect(page.get_by_label('tokenを抽出', exact=True)).not_to_be_checked()
            token.click()
            expect(page.get_by_label('tokenを抽出', exact=True)).not_to_be_checked()
            candidate.locator('label').click()
            expect(page.get_by_label('tokenを抽出', exact=True)).to_be_checked()
            passed('candidate label toggles only its checkbox; editing its value does not toggle selection')

            for width, height in [(390, 844), (320, 720)]:
                page.set_viewport_size({'width': width, 'height': height})
                no_overflow('.extraction-dialog')
                no_overflow('.extraction-list')
                expect(page.locator('#modalSubmit')).to_be_visible()
                capture('environment-existing-' + str(width))
            target.select_option('__new__')
            expect(page.get_by_label('新しい環境名', exact=True)).to_have_value('Draft environment')
            capture('environment-new-phone')
            page.locator('#cancelModal').click()
            side('environments')
            page.locator('#sidebarContent [data-environment-id] .tree-open').first.click()
            expect(page.locator('#environmentName')).to_have_value('Development')
            expect(page.locator('#workspacePage').get_by_label('Value 1', exact=True)).to_have_value('existing-token')
            expect(page.locator('#sidebarContent [data-environment-id]')).to_have_count(1)
            passed('narrow extraction forms remain usable and cancellation changes neither values nor environment count')

            page.set_viewport_size({'width': 1440, 'height': 1000})
            assert page.locator('#environmentName').bounding_box()['width'] > 560
            expect(page.locator('#workspacePage .workspace-note')).to_have_count(0)
            capture('environment-page-desktop')
            page.locator('#environmentName').fill('Development / ' + 'long-environment-name-' * 8)
            for width, height in [(768, 1024), (390, 844)]:
                page.set_viewport_size({'width': width, 'height': height})
                no_overflow('#workspacePage')
                expect(page.locator('#workspacePage').get_by_role('button', name='変更履歴', exact=True)).to_be_visible()
                capture('environment-page-' + str(width))
            passed('environment page uses available name width and retains controls for long names on tablet and phone')
            page.set_viewport_size({'width': 1440, 'height': 1000})
            page.locator('#environmentName').fill('Development')
            for scope in ['primary', 'globals']:
                page.locator(f'#sidebarContent [data-scope={scope}] .tree-open').click()
                expect(page.locator('#workspacePage .workspace-note')).to_have_count(0)
            passed('environment, Globals and primary pages contain no redundant implementation notes')

            request()
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_contain_text('200', timeout=15000)
            page.locator('#extractResponse').click()
            expect(page.get_by_label('一次変数名', exact=True)).to_have_value('status')
            selected = page.locator('.metadata-row[data-path="/body/result/items/field_070"]')
            selected.click()
            expect(selected).to_be_focused()
            expect(selected).to_have_attribute('aria-pressed', 'true')
            expect(page.get_by_label('抽出パス', exact=True)).to_have_value('/body/result/items/field_070')
            scroll = page.locator('.metadata-tree').evaluate('e=>e.scrollTop')
            selected.evaluate('e=>window.__metadataNode=e')
            selected.press('Enter')
            assert selected.evaluate('e=>e===window.__metadataNode')
            expect(selected).to_be_focused()
            assert abs(page.locator('.metadata-tree').evaluate('e=>e.scrollTop') - scroll) < 1
            passed('mouse and Enter selection preserve the actual metadata button, focus and list scroll')

            selected.press('ArrowDown')
            expect(page.locator('.metadata-row[data-path="/body/result/items/field_071"]')).to_be_focused()
            expect(page.get_by_label('一次変数名', exact=True)).to_have_value('field_071')
            page.get_by_label('一次変数名', exact=True).fill('chosenValue')
            page.locator('.metadata-row[data-path="/body/result/items/field_072"]').click()
            expect(page.get_by_label('一次変数名', exact=True)).to_have_value('chosenValue')
            page.get_by_label('抽出パス', exact=True).fill('/status')
            expect(page.locator('.metadata-row[data-path="/status"]')).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('.metadata-row[data-path="/body/result/items/field_072"]')).to_have_attribute('aria-pressed', 'false')
            passed('keyboard navigation selects rows, explicit variable names survive and manual paths synchronize highlighting')

            search = page.get_by_label('レスポンス要素を検索', exact=True)
            search.fill('/body/result/items/field_07')
            expect(search).to_be_focused()
            expect(page.locator('.metadata-row:visible')).to_have_count(10)
            expect(page.locator('.metadata-row:visible[tabindex="0"]')).to_have_count(1)
            page.locator('.metadata-row:visible[tabindex="0"]').focus()
            page.keyboard.press('End')
            end = page.locator('.metadata-row[data-path="/body/result/items/field_079"]')
            expect(end).to_be_focused()
            end.press('Home')
            expect(selected).to_be_focused()
            selected.press('Shift+F10')
            expect(page.get_by_role('menuitem', name='パスをコピー', exact=True)).to_be_visible()
            page.keyboard.press('Escape')
            expect(selected).to_be_focused()
            page.get_by_role('button', name='選択要素の操作', exact=True).click()
            expect(page.get_by_role('menuitem', name='値をコピー', exact=True)).to_be_visible()
            page.keyboard.press('Escape')
            expect(page.get_by_role('button', name='選択要素の操作', exact=True)).to_be_focused()
            passed('filtered rows support Home/End, keyboard context menus and a visible touch-accessible menu')

            search.fill('this-value-does-not-exist')
            expect(page.locator('.metadata-empty')).to_be_visible()
            search.fill('')
            expect(page.locator('.metadata-empty')).to_be_hidden()
            assert selected.evaluate('e=>e===window.__metadataNode')
            page.locator('.metadata-row[data-path="/body/result/key~1with~0escape"]').click()
            expect(page.get_by_label('抽出パス', exact=True)).to_have_value('/body/result/key~1with~0escape')
            passed('empty search is explicit and clearing search retains nodes; escaped JSON Pointers remain exact')
            capture('response-selected-desktop')

            for width, height in [(768, 1024), (390, 844), (320, 720)]:
                page.set_viewport_size({'width': width, 'height': height})
                page.locator('.metadata-row[aria-pressed=true]').scroll_into_view_if_needed()
                no_overflow('.response-extraction')
                expect(page.locator('#modalSubmit')).to_be_visible()
                expect(page.get_by_role('button', name='選択要素の操作', exact=True)).to_be_visible()
                capture('response-selected-' + str(width))
            page.set_viewport_size({'width': 1440, 'height': 1100})
            page.add_style_tag(content='.response-extraction {font-size:200%} .response-extraction input,.response-extraction button,.response-extraction label,.response-extraction span,.response-extraction p {font-size:inherit!important}')
            no_overflow('.response-extraction')
            page.locator('.metadata-row[aria-pressed=true]').scroll_into_view_if_needed()
            assert page.locator('.metadata-row:visible').evaluate_all('''elements=>elements.every(row=>{const [path,type,value]=[...row.children].map(e=>e.getBoundingClientRect());return path.right<=type.left+1&&type.right<=value.left+1;})''')
            capture('response-text-200-percent')
            page.locator('#modalSubmit').click()
            expect(page.locator('#modal')).not_to_be_visible()
            values = page.evaluate("JSON.parse(sessionStorage.getItem('minipost.primary.v1'))")
            assert {row['key']: row['value'] for row in values}['chosenValue'] == 'false'
            passed('phone/tablet/enlarged text remain operable and extraction stores the selected false value losslessly')
            assert not errors, errors
            passed('no uncaught browser exceptions')
            browser.close()
    finally:
        result['passed'] = len(checks)
        (out / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        app.shutdown(); app.server_close(); echo.shutdown(); echo.server_close()


if __name__ == '__main__':
    main()
