"""Live UI acceptance: navigation, item menus, drawers, resizing and screenshots.

The target is a real loopback echo server, not a COM Gateway or physical device.
"""
import json
import os
from pathlib import Path
import tempfile
from playwright.sync_api import expect, sync_playwright
from browser_app import BrowserApp
from test_proxy import proxy, start_server


def main():
    echo, echo_url = start_server()
    app, app_url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-ui-'))) / 'ui'
    out.mkdir(parents=True, exist_ok=True)
    checks, shots, errors = [], [], []

    def passed(name):
        checks.append(name)
        print(f'PASS {name}', flush=True)

    def report():
        (out / 'ui-results.json').write_text(json.dumps({
            'passed': len(checks), 'checks': checks, 'screenshots': shots,
            'page_errors': errors, 'target': 'real loopback HTTP echo',
            'physical_devices': False,
        }, ensure_ascii=False, indent=2))

    sample = {
        'info': {'name': 'Telemetry API', 'schema': 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
        'variable': [{'key': 'baseUrl', 'value': echo_url}, {'key': 'token', 'value': 'ui-test-token'}],
        'auth': {'type': 'bearer', 'bearer': [{'key': 'token', 'value': '{{token}}'}]},
        'item': [{'name': 'Channels', 'item': [
            {'name': 'Read channels', 'request': {'method': 'GET', 'url': '{{baseUrl}}/echo?channel=1&include=measurements'}},
            {'name': 'Update channel', 'request': {'method': 'POST', 'url': '{{baseUrl}}/echo', 'body': {'mode': 'raw', 'raw': '{\n  "channel": 1,\n  "voltage": 12.5,\n  "current": 3.2,\n  "enabled": true\n}', 'options': {'raw': {'language': 'json'}}}}},
            {'name': 'Long name / ' + 'request-with-a-long-name-' * 8, 'request': {'method': 'GET', 'url': '{{baseUrl}}/echo?long=' + 'abcdef-' * 40}},
        ]}, {'name': 'Saved requests', 'item': [
            {'name': f'Request {i:02d}', 'request': {'method': 'GET', 'url': '{{baseUrl}}/echo?request=' + str(i)}} for i in range(45)
        ]}],
    }
    environment = {'name': 'Local development', '_postman_variable_scope': 'environment', 'values': [
        {'key': 'baseUrl', 'value': echo_url, 'enabled': True},
        {'key': 'token', 'value': 'ui-environment-token', 'enabled': True},
    ]}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True, args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 1440, 'height': 920})
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))

            def capture(name):
                page.wait_for_function('document.fonts.status === "loaded"')
                page.screenshot(path=str(out / f'{name}.png'), full_page=True)
                shots.append({'name': name, 'viewport': page.viewport_size, 'theme': page.locator('html').get_attribute('data-theme'), 'layout': page.locator('html').get_attribute('data-layout')})

            def import_raw(value):
                page.locator('#import').click()
                page.get_by_label('インポートJSON').fill(json.dumps(value))
                page.locator('#modalSubmit').click()
                expect(page.locator('#modalTitle')).to_have_text('インポート完了')
                page.locator('#modalSubmit').click()

            def open_request(name):
                page.locator('.tree-open').filter(has=page.locator('.tree-label', has_text=name)).first.click()
                expect(page.locator('#requestName')).to_have_value(name)

            def send():
                page.locator('#send').click()
                expect(page.locator('#responseStatus')).to_contain_text('200')

            fixture = BrowserApp(app_url); fixture.open(page)
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            assert page.locator('#newRequest, #sidebarMore, #editEnvironment').count() == 0
            expect(page.locator('#addTab')).to_be_visible()
            expect(page.locator('html')).to_have_attribute('data-response-empty', 'true')
            expect(page.locator('#responseStatus')).to_be_visible()
            expect(page.locator('#responseStatus')).to_have_text('未送信')
            assert 35 <= page.locator('.response-panel').bounding_box()['height'] < 90
            expect(page.locator('html')).to_have_attribute('data-theme', 'light')
            assert page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()") == '#f4f6f9'
            expect(page.locator('#sidebarTabs [data-sidebar=collections]')).to_have_attribute('aria-selected', 'true')
            expect(page.locator('#editorTabs [role=tab]')).to_have_count(7)
            expect(page.locator('#responseTabs [role=tab]')).to_have_count(5)
            expect(page.locator('#editor-tab-all')).to_have_attribute('aria-selected', 'true')
            assert page.locator('#requestTabs, .request-tab').count() == 0
            capture('empty-desktop')
            passed('formal corporate defaults with scoped setting/response tabs and no accumulating request tabs')
            import_raw(sample)
            import_raw(environment)
            send()
            expect(page.locator('html')).to_have_attribute('data-response-empty', 'false')
            assert page.locator('.response-panel').bounding_box()['height'] > 100
            assert json.loads(page.locator('.response-code').inner_text())['path'] == '/echo?channel=1&include=measurements'
            passed('existing Collection and Environment import through real HTTP')

            # Only the inner setting pages switch; all-settings mode preserves
            # the established accordion layout and spacing.
            workspace_before_page_switch = page.evaluate('localStorage.getItem("minipost.workspace.v2")')
            page.locator('#editor-tab-headers').click()
            expect(page.locator('#editor-tab-headers')).to_have_attribute('aria-selected', 'true')
            expect(page.locator('section.editor-section[data-pane=headers]')).to_be_visible()
            expect(page.locator('section.editor-section[data-pane=params]')).not_to_be_visible()
            page.locator('#editor-tab-headers').focus()
            page.keyboard.press('ArrowRight')
            expect(page.locator('#editor-tab-authorization')).to_have_attribute('aria-selected', 'true')
            page.keyboard.press('Home')
            expect(page.locator('#editor-tab-all')).to_have_attribute('aria-selected', 'true')
            assert page.evaluate('localStorage.getItem("minipost.workspace.v2")') == workspace_before_page_switch
            passed('internal settings page navigation retains request data and avoids revisions')

            # Only visibility changes: open fields retain the flat editor geometry.
            expect(page.locator('#editorContent > details, #editorContent > summary')).to_have_count(0)
            expect(page.locator('section.editor-section')).to_have_count(6)
            for name in ['params', 'headers', 'authorization', 'body', 'settings', 'scripts']:
                section = page.locator(f'section.editor-section[data-pane={name}]')
                expect(section.locator('.editor-section-body')).to_be_visible()
                expect(section).to_have_css('border-top-left-radius', '0px')
                expect(section.locator('.editor-section-body')).to_have_css('padding-left', '0px')
                before = section.bounding_box()
                fields = section.locator('.editor-section-body')
                fields.evaluate('el => el.dataset.nodeProbe = "retained"')
                title = section.locator('h2')
                toggle = title.get_by_role('button')
                expect(toggle).to_have_attribute('aria-controls', f'request-fields-{name}')
                title.click()
                expect(toggle).to_have_attribute('aria-expanded', 'false')
                expect(fields).not_to_be_visible()
                toggle.focus()
                page.keyboard.press('Enter')
                expect(toggle).to_have_attribute('aria-expanded', 'true')
                expect(fields).to_be_visible()
                expect(fields).to_have_attribute('data-node-probe', 'retained')
                after = section.bounding_box()
                for axis in ['x', 'width', 'height']:
                    assert abs(before[axis] - after[axis]) < .5, (name, axis, before, after)
                page.keyboard.press('Space')
                expect(fields).not_to_be_visible()
                page.keyboard.press('Space')
                expect(fields).to_be_visible()
            expect(page.locator('#editorTabs [role=tab]')).to_have_count(7)
            page.locator('#editorContent').evaluate('el => el.scrollTop = 0')
            passed('flat spacing is unchanged by pointer and keyboard disclosure; field nodes remain mounted')
            headers = page.locator('section.editor-section[data-pane=headers]')
            scripts = page.locator('section.editor-section[data-pane=scripts]')
            headers.get_by_role('button', name='HTTP ヘッダー').click()
            scripts.get_by_role('button', name='スクリプト', exact=True).click()
            page.locator('#url').fill(page.locator('#url').input_value())
            expect(headers.locator('.editor-section-body')).not_to_be_visible()
            expect(scripts.locator('.editor-section-body')).not_to_be_visible()
            expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
            before = page.evaluate('localStorage.getItem("minipost.workspace.v2")')
            page.locator('section.editor-section[data-pane=params] h2 button').click()
            assert page.evaluate('localStorage.getItem("minipost.workspace.v2")') == before
            page.locator('section.editor-section[data-pane=params] h2 button').click()
            fixture.reload(page)
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            expect(headers.locator('.editor-section-body')).not_to_be_visible()
            expect(scripts.locator('.editor-section-body')).not_to_be_visible()
            capture('disclosure-desktop')
            headers.get_by_role('button', name='HTTP ヘッダー').click()
            scripts.get_by_role('button', name='スクリプト', exact=True).click()
            send()
            page.locator('#editorContent').evaluate('el => el.scrollTop = 0')
            passed('disclosure survives render and reload without changing request data or revisions')

            trigger = page.get_by_role('button', name='Read channelsの操作', exact=True)
            trigger.click()
            expect(page.locator('#itemMenu')).to_be_visible()
            expect(page.locator('#modal')).not_to_be_visible()
            page.keyboard.press('End')
            expect(page.locator('#itemMenu button').last).to_be_focused()
            page.keyboard.press('Escape')
            expect(trigger).to_be_focused()
            passed('item context menu keyboard navigation and focus return')
            trigger.click()
            page.get_by_role('menuitem', name='名前を変更').click()
            page.get_by_label('Name', exact=True).fill('Discarded name')
            page.locator('#cancelModal').click()
            expect(page.locator('#requestName')).to_have_value('Read channels')
            passed('rename cancellation preserves the request')
            trigger.click()
            capture('item-menu')
            page.keyboard.press('Escape')

            page.locator('#sidebarTabs [data-sidebar=environments]').click()
            page.get_by_role('button', name='Local development', exact=True).click()
            expect(page.locator('#modal')).not_to_be_visible()
            expect(page.locator('#workspacePage')).to_be_visible()
            expect(page.locator('#exchange')).not_to_be_visible()
            page.locator('#workspacePage').get_by_label('Value 1', exact=True).fill(echo_url + '/saved')
            capture('environment-page')
            page.locator('#sidebarTabs [data-sidebar=collections]').click()
            page.locator('#sidebarTabs [data-sidebar=environments]').click()
            expect(page.locator('#workspacePage').get_by_label('Value 1', exact=True)).to_have_value(echo_url + '/saved')
            page.locator('#workspacePage').get_by_label('Value 1', exact=True).fill(echo_url)
            page.locator('#workspacePage').get_by_label('Value 2', exact=True).fill('ui-updated-token')
            expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
            page.locator('#sidebarTabs [data-sidebar=collections]').click()
            send()
            assert dict(json.loads(page.locator('.response-code').inner_text())['headers'])['Authorization'] == 'Bearer ui-updated-token'
            passed('full-page variable autosave survives page switches and real auth round trip')

            open_request('Update channel')
            expect(page.locator('section.editor-section[data-pane=body] .editor-section-body')).to_be_visible()
            send()
            capture('desktop-light')
            page.locator('#theme').click()
            expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
            expect(page.locator('#import')).to_have_css('background-color', 'rgb(32, 43, 57)')
            expect(page.locator('#url')).to_have_css('background-color', 'rgb(32, 43, 57)')
            capture('desktop-dark')
            page.locator('#theme').click()
            expect(page.locator('html')).to_have_attribute('data-theme', 'light')
            expect(page.locator('#import')).to_have_css('background-color', 'rgb(255, 255, 255)')
            page.locator('#layoutToggle').click()
            expect(page.locator('html')).to_have_attribute('data-layout', 'side')
            left, right = page.locator('.request-editor').bounding_box(), page.locator('.response-panel').bounding_box()
            assert right['x'] >= left['x'] + left['width']
            capture('desktop-side-by-side')
            page.locator('#responseResize').focus()
            before = int(page.locator('#responseResize').get_attribute('aria-valuenow'))
            page.keyboard.press('ArrowRight')
            assert int(page.locator('#responseResize').get_attribute('aria-valuenow')) > before
            passed('side-by-side layout and keyboard horizontal separator')
            page.locator('#wrapResponse').click()
            assert page.locator('.response-code').evaluate('el => getComputedStyle(el).whiteSpace') == 'pre'
            fixture.reload(page)
            expect(page.locator('html')).to_have_attribute('data-layout', 'side')
            expect(page.locator('#wrapResponse')).to_have_attribute('aria-pressed', 'false')
            passed('split position and wrapping preferences survive reload')
            expect(page.locator('html')).to_have_attribute('data-response-empty', 'false')
            expect(page.locator('#wrapResponse')).to_be_visible()
            send()
            expect(page.locator('#wrapResponse')).to_be_visible()
            page.locator('#wrapResponse').click()
            page.locator('#layoutToggle').click()
            expect(page.locator('section.editor-section[data-pane=body] .editor-section-body')).to_be_visible()
            send()
            page.locator('#response-tab-pretty').focus()
            page.keyboard.press('ArrowRight')
            expect(page.locator('#response-tab-raw')).to_have_attribute('aria-selected', 'true')
            page.locator('#response-tab-headers').click()
            expect(page.locator('.kv-readonly')).to_contain_text('application/json')
            page.locator('#response-tab-pretty').click()
            expect(page.locator('#response-tab-pretty')).to_have_attribute('aria-selected', 'true')
            expect(page.locator('#responseTabs [role=tab]')).to_have_count(5)
            passed('response format tabs switch with pointer and keyboard')

            before = page.locator('.sidebar').bounding_box()['width']
            page.locator('#sidebarResize').focus()
            page.keyboard.press('ArrowRight')
            assert page.locator('.sidebar').bounding_box()['width'] > before
            fixture.reload(page)
            assert page.locator('.sidebar').bounding_box()['width'] > before
            passed('sidebar resize persists without altering workspace data')
            page.locator('#toggleSidebar').click()
            expect(page.locator('#navigation')).not_to_be_visible()
            page.locator('#toggleSidebar').click()
            expect(page.locator('#navigation')).to_be_visible()
            passed('desktop sidebar collapse and restore')

            for i in range(12):
                open_request(f'Request {i:02d}')
            expect(page.locator('#requestTabs, .request-tab')).to_have_count(0)
            expect(page.locator('#environment')).to_be_visible()
            expect(page.locator('#addTab')).to_be_visible()
            expect(page.locator('#requestName')).to_have_value('Request 11')
            passed('list selection opens one request without a tab strip')
            page.locator('#search').fill('Request 44')
            open_request('Request 44')
            expect(page.locator('#search')).to_have_value('Request 44')
            page.locator('#search').fill('')
            assert page.locator('#sidebarContent').evaluate('el => el.scrollHeight > el.clientHeight')
            passed('large request list search keeps its context')
            long_name = sample['item'][0]['item'][2]['name']
            open_request(long_name)
            page.locator('#requestName').focus()
            expect(page.locator('#requestName')).to_have_value(long_name)
            send()
            capture('long-values')
            passed('long request names and URLs remain editable and send intact')
            page.locator('#url').fill('{{missingUrl}}/echo')
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_have_text('ERROR')
            capture('request-error')
            passed('unresolved-variable error remains visible')

            for width, height in [(1024, 768), (768, 1024), (390, 844)]:
                page.set_viewport_size({'width': width, 'height': height})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
                expect(page.locator('#send')).to_be_visible()
                if width <= 650:
                    header = page.locator('.topbar').bounding_box()
                    for control in ['#toggleSidebar', '#addTab', '#import', '#dataActions', '#environment', '#theme']:
                        rect = page.locator(control).bounding_box()
                        assert rect and rect['y'] >= 0, (control, rect)
                        assert rect['y'] + rect['height'] <= header['y'] + header['height'] + 1, (control, rect, header)
                if width <= 820:
                    expect(page.locator('#navigation')).not_to_be_visible()
                    page.locator('#toggleSidebar').click()
                    expect(page.locator('#navigation')).to_have_attribute('aria-modal', 'true')
                    page.locator('#search').fill('Read channels')
                    capture(f'navigation-{width}')
                    open_request('Read channels')
                    expect(page.locator('#navigation')).not_to_be_visible()
                    page.locator('#toggleSidebar').click()
                    page.keyboard.press('Escape')
                    expect(page.locator('#toggleSidebar')).to_be_focused()
                expect(page.locator('section.editor-section[data-pane=params] .editor-section-body')).to_be_visible()
                page.locator('#url').fill('{{baseUrl}}/echo?channel=1')
                send()
                expect(page.locator('#responseSearch')).to_be_visible()
                capture(f'workspace-{width}')
            passed('desktop tablet and phone navigation, sending and response search')

            page.set_viewport_size({'width': 1440, 'height': 920})
            page.locator('#search').fill('')
            page.locator('#sidebarTabs [data-sidebar=environments]').click()
            page.get_by_role('button', name='Local development', exact=True).click()
            page.locator('#workspacePage').get_by_label('Value 2', exact=True).fill('autosaved-mobile-edit')
            page.set_viewport_size({'width': 390, 'height': 844})
            expect(page.locator('#workspacePage').get_by_label('Value 2', exact=True)).to_have_value('autosaved-mobile-edit')
            expect(page.locator('#modal')).not_to_be_visible()
            capture('mobile-variables')
            page.set_viewport_size({'width': 1440, 'height': 920})
            passed('variable page remains inline across desktop and phone without losing values')
            page.locator('#sidebarTabs [data-sidebar=collections]').click()
            open_request('Read channels')
            page.evaluate('document.documentElement.style.fontSize="26px"')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.locator('#send').scroll_into_view_if_needed()
            expect(page.locator('#send')).to_be_visible()
            capture('text-200-percent')
            page.evaluate('document.documentElement.style.fontSize=""')
            passed('200 percent root text enlargement keeps actions reachable')
            previous_storage = page.evaluate('({...localStorage.__data})') if fixture.inline else None
            touch_context = browser.new_context(viewport={'width':390,'height':844}, has_touch=True, storage_state=context.storage_state())
            page = touch_context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            if fixture.inline: fixture.local = previous_storage
            fixture.open(page)
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            page.locator('#toggleSidebar').tap()
            page.get_by_role('button', name='Read channelsの操作', exact=True).tap()
            page.get_by_role('menuitem', name='名前を変更').tap()
            expect(page.locator('#modalTitle')).to_have_text('リクエスト名')
            page.locator('#cancelModal').tap()
            page.locator('#toggleSidebar').tap()
            page.locator('.tree-open').filter(has=page.locator('.tree-label', has_text='Read channels')).first.tap()
            page.locator('#send').tap()
            expect(page.locator('#responseStatus')).to_contain_text('200')
            section = page.locator('section.editor-section[data-pane=body]')
            section.locator('h2 button').tap()
            expect(section.locator('.editor-section-body')).not_to_be_visible()
            capture('disclosure-phone')
            section.locator('h2 button').tap()
            expect(section.locator('.editor-section-body')).to_be_visible()
            capture('phone-touch')
            passed('touch emulation opens item actions, sends and discloses flat fields')
            assert not errors, errors
            passed('no uncaught UI JavaScript errors')
            report(); browser.close()
    finally:
        report()
        for server in [app, echo]:
            server.shutdown(); server.server_close()

if __name__ == '__main__':
    main()
