"""Browser E2E against MiniPost and a clearly separate loopback echo server.

Requires playwright and Chromium. This is NOT the COM Gateway integration test.
"""
import json
import os
from pathlib import Path
import tempfile
import sys
import time

from playwright.sync_api import sync_playwright, expect
from test_proxy import ROOT, proxy, start_server


def main():
    echo, echo_url = start_server()
    app, app_url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-browser-')))
    out.mkdir(parents=True, exist_ok=True)
    checks = []
    def passed(name):
        checks.append(name); print(f'PASS {name}', flush=True)

    sample = {
        'info': {'name': 'Proxy verification', 'schema': 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
        'variable': [{'key': 'baseUrl', 'value': echo_url}, {'key': 'token', 'value': 'collection-token'}, {'key': 'label', 'value': 'collection'}],
        'auth': {'type': 'bearer', 'bearer': [{'key': 'token', 'value': '{{token}}'}]},
        'item': [{'name': 'HTTP requests', 'item': [
            {'name': 'Query and bearer', 'request': {'method': 'GET', 'url': {'raw': '{{baseUrl}}/echo?tag=old', 'query': [{'key': 'tag', 'value': 'one'}, {'key': 'tag', 'value': 'two'}, {'key': 'off', 'value': 'ignored', 'disabled': True}]}}},
            {'name': 'JSON request', 'request': {'method': 'POST', 'url': '{{baseUrl}}/echo', 'body': {'mode': 'raw', 'raw': '{\n  "message": "hello {{label}}",\n  "enabled": true\n}', 'options': {'raw': {'language': 'json'}}}}},
            {'name': 'Slow request', 'request': {'method': 'GET', 'url': '{{baseUrl}}/delay?seconds=0.45'}},
            {'name': 'HTML preview', 'request': {'method': 'GET', 'url': '{{baseUrl}}/html'}},
            {'name': 'Cookie response', 'request': {'method': 'GET', 'url': '{{baseUrl}}/cookies'}}
        ]}]
    }
    env = {'name': 'Loopback verification', '_postman_variable_scope': 'environment', 'values': [{'key': 'baseUrl', 'value': echo_url, 'enabled': True}, {'key': 'token', 'value': 'test-only-token', 'enabled': True, 'type': 'secret'}, {'key': 'label', 'value': 'workspace', 'enabled': True}]}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 1440, 'height': 920}, accept_downloads=True)
            page = context.new_page(); errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(app_url)
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            passed('initial workspace and real proxy health')

            def import_raw(data):
                page.locator('#import').click(); page.get_by_label('インポートJSON').fill(json.dumps(data)); page.locator('#modalSubmit').click()
                expect(page.locator('#modalTitle')).to_have_text('インポート完了'); page.locator('#modalSubmit').click()
            def open_request(name):
                page.locator('.tree-open').filter(has=page.locator('.tree-label', has_text=name)).first.click()
                expect(page.locator('#requestName')).to_have_value(name)
            def send():
                page.locator('#send').click(); expect(page.locator('#responseStatus')).to_contain_text('200', timeout=10000)
            def body_json():
                return json.loads(page.locator('.response-code').inner_text())

            import_raw(sample)
            expect(page.locator('#requestName')).to_have_value('Query and bearer')
            expect(page.locator('#url')).to_have_value('{{baseUrl}}/echo?tag=one&tag=two')
            passed('Postman JSON import, folder tree, disabled query preservation')
            import_raw(env)
            expect(page.locator('#environment')).to_have_value(page.locator('#environment option', has_text='Loopback verification').get_attribute('value'))
            send(); payload = body_json()
            assert payload['path'] == '/echo?tag=one&tag=two', payload
            assert dict(payload['headers'])['Authorization'] == 'Bearer test-only-token'
            passed('environment precedence and inherited bearer round trip')

            page.get_by_label('Value 1', exact=True).fill('changed')
            expect(page.locator('#url')).to_have_value('{{baseUrl}}/echo?tag=changed&tag=two')
            page.locator('#url').fill('{{baseUrl}}/echo?edited=yes')
            expect(page.get_by_label('Key 1', exact=True)).to_have_value('edited')
            page.keyboard.press('Control+s')
            passed('bidirectional URL / Params editing and save')

            open_request('JSON request'); expect(page.locator('section.editor-section[data-pane=body] .editor-section-body')).to_be_visible()
            expect(page.get_by_label('Raw body')).to_contain_text('')
            send(); payload = body_json(); assert json.loads(payload['body'])['message'] == 'hello workspace'
            page.get_by_label('Raw body').fill('{\n  "message": "edited {{label}}",\n  "count": 3,\n  "enabled": true\n}')
            page.keyboard.press('Control+s'); page.reload(); expect(page.get_by_label('リクエスト名')).to_have_value('JSON request')
            expect(page.locator('section.editor-section[data-pane=body] .editor-section-body')).to_be_visible(); expect(page.get_by_label('Raw body')).to_have_value('{\n  "message": "edited {{label}}",\n  "count": 3,\n  "enabled": true\n}')
            send(); assert json.loads(body_json()['body'])['message'] == 'edited workspace'
            passed('JSON body variables, keyboard save and reload persistence')

            page.locator('#responseSearch').fill('workspace'); expect(page.locator('mark').first).to_be_visible()
            page.locator('#responseSearch').fill('');
            with page.expect_download() as download_info:
                page.locator('#downloadResponse').click()
            target = out / 'response.json'; download_info.value.save_as(target)
            assert json.loads(target.read_text())['method'] == 'POST'
            passed('response highlighting, search and lossless download')

            page.locator('input[name=bodyMode][value=file]').check()
            with page.expect_file_chooser() as chooser:
                page.locator('section.editor-section[data-pane=body]').get_by_role('button', name='ファイルを選択', exact=True).click()
            chooser.value.set_files({'name': 'payload.bin', 'mimeType': 'application/octet-stream', 'buffer': b'\x00\x01\xff'})
            send(); assert body_json()['body_base64'] == 'AAH/'
            passed('binary file upload through browser and Python proxy')

            page.locator('input[name=bodyMode][value=formdata]').check()
            page.locator('section.editor-section[data-pane=body]').get_by_role('button', name='＋ 行を追加').click()
            page.locator('section.editor-section[data-pane=body]').get_by_label('Key 1', exact=True).fill('metadata'); page.locator('section.editor-section[data-pane=body]').get_by_label('Value 1', exact=True).fill('hello {{label}}')
            page.locator('section.editor-section[data-pane=body]').get_by_role('button', name='＋ 行を追加').click()
            page.locator('section.editor-section[data-pane=body]').get_by_label('Key 2', exact=True).fill('upload'); page.locator('section.editor-section[data-pane=body] .kv-table tbody tr').nth(1).locator('select').select_option('file')
            with page.expect_file_chooser() as chooser:
                page.locator('section.editor-section[data-pane=body]').get_by_role('button', name='ファイルを選択', exact=True).click()
            chooser.value.set_files({'name': 'a.bin', 'mimeType': 'application/octet-stream', 'buffer': b'\x00\x01\xff'})
            send(); payload = body_json()
            assert 'hello workspace' in payload['body']; assert 'filename="a.bin"' in payload['body']; assert 'boundary=' in dict(payload['headers'])['Content-Type']
            passed('multipart text variables and actual file bytes')

            page.locator('input[name=bodyMode][value=raw]').check(); page.keyboard.press('Control+s')
            open_request('Cookie response'); send(); page.locator('#response-tab-cookies').click()
            expect(page.locator('.kv-readonly')).to_contain_text('a=1'); expect(page.locator('.kv-readonly')).to_contain_text('b=2')
            passed('separate duplicate Set-Cookie response rows')

            open_request('HTML preview'); send(); page.locator('#response-tab-preview').click()
            expect(page.locator('iframe.preview-frame')).to_be_visible(); assert not page.evaluate('Boolean(window.__PWNED)')
            assert page.locator('iframe.preview-frame').get_attribute('sandbox') == ''
            assert 'default-src' in page.locator('iframe.preview-frame').get_attribute('srcdoc')
            passed('HTML preview sandbox and network-restricting CSP')

            page.locator('#response-tab-pretty').click(); open_request('Slow request'); page.locator('#send').click()
            open_request('Query and bearer'); send(); assert body_json()['path'] == '/echo?edited=yes'
            page.wait_for_timeout(600); open_request('Slow request'); expect(page.locator('#responseStatus')).to_contain_text('200')
            assert body_json()['path'].startswith('/delay')
            passed('concurrent request tabs keep their own responses')

            page.locator('#url').fill('{{baseUrl}}/delay?seconds=1.5'); page.locator('#send').click(); page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_have_text('CANCELLED'); expect(page.locator('.response-code')).to_contain_text('取り消せません')
            passed('cancel receive and explicit target-side cancellation limitation')

            page.locator('details.sidebar-group[data-group=history]').evaluate('el => el.open = true'); expect(page.locator('.history-entry').first).to_be_visible()
            assert page.locator('.history-entry').count() >= 7
            page.locator('.history-entry').first.click(); expect(page.locator('#requestName')).not_to_have_value('Untitled request')
            passed('history persistence and reopen')
            page.locator('details.sidebar-group[data-group=collections]').evaluate('el => el.open = true')

            before = page.evaluate('JSON.parse(localStorage.getItem("minipost.workspace.v2")).collections.length')
            page.locator('#import').click(); page.get_by_label('インポートJSON').fill('{"bad":"data"}'); page.locator('#modalSubmit').click()
            expect(page.locator('#modalMessage')).to_contain_text('Collection'); page.locator('#closeModal').click()
            after = page.evaluate('JSON.parse(localStorage.getItem("minipost.workspace.v2")).collections.length'); assert before == after
            passed('invalid import leaves existing workspace unchanged')

            malicious = json.loads(json.dumps(sample)); malicious['info']['name'] = '<img src=x onerror="window.__XSS=1">'
            malicious['event'] = [{'listen': 'prerequest', 'script': {'exec': ['window.__SCRIPT_RAN=true;']}}]
            import_raw(malicious); expect(page.locator('#requestWarning')).to_be_visible(); assert not page.evaluate('Boolean(window.__XSS || window.__SCRIPT_RAN)')
            expect(page.locator('section.editor-section[data-pane=scripts] .editor-section-body')).to_be_visible(); expect(page.locator('.scripts-block')).to_contain_text('window.__SCRIPT_RAN')
            passed('untrusted imported names remain text; scripts retained but never executed')

            # Imported hostile labels remain visible as escaped text in this test.
            page.locator('#gatewayExample').click(); expect(page.locator('#modalTitle')).to_have_text('インポート完了'); page.locator('#modalSubmit').click()
            open_request('JSON request'); expect(page.locator('section.editor-section[data-pane=body] .editor-section-body')).to_be_visible(); send()
            page.wait_for_timeout(300)
            page.screenshot(path=str(out / 'browser-e2e.png'), full_page=True)

            for width, height in [(1440, 920), (1024, 768), (768, 1024), (390, 844)]:
                page.set_viewport_size({'width': width, 'height': height})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'overflow at {width}'
                expect(page.locator('#send')).to_be_visible()
            passed('responsive layout at desktop, tablet and phone widths')
            page.set_viewport_size({'width': 1440, 'height': 920})
            old_width = page.locator('.sidebar').bounding_box()['width']; handle = page.locator('#sidebarResize').bounding_box()
            page.mouse.move(handle['x'] + 2, handle['y'] + 70); page.mouse.down(); page.mouse.move(handle['x'] + 72, handle['y'] + 70); page.mouse.up()
            assert page.locator('.sidebar').bounding_box()['width'] > old_width
            passed('interactive sidebar resize')

            assert not errors, errors
            passed('no uncaught browser JavaScript errors')
            (out / 'browser-results.json').write_text(json.dumps({'passed': len(checks), 'checks': checks, 'page_errors': errors, 'gateway_integration': 'NOT RUN: separate real-Gateway test required'}, indent=2))
            browser.close()
    finally:
        for server in [app, echo]: server.shutdown(); server.server_close()
    print(json.dumps({'passed': len(checks), 'artifacts': str(out)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
