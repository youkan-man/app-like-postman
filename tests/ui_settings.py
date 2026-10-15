"""Real browser regressions for settings autosave, selection and context actions.

No fetch mocks: imported settings must reach an actual HTTP echo server.
"""
import json
import os
from pathlib import Path
import tempfile

from playwright.sync_api import sync_playwright, expect
from test_proxy import proxy, start_server

KEY = 'minipost.workspace.v2'


def main():
    echo, echo_url = start_server()
    app, app_url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-settings-'))) / 'settings'
    out.mkdir(parents=True, exist_ok=True)
    checks, errors, images = [], [], []

    def passed(name):
        checks.append(name)
        print('PASS ' + name, flush=True)

    collection = {
        'info': {'name': 'Control API', 'schema': 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
        'variable': [{'key': 'scope', 'value': 'parent', 'description': 'parent setting'}],
        'auth': {'type': 'bearer', 'bearer': [{'key': 'token', 'value': '{{token}}'}]},
        'item': [{'name': 'Channels', 'variable': [{'key': 'offset', 'value': '1'}], 'item': [
            {'name': 'Read channels', 'request': {'method': 'GET', 'url': '{{baseUrl}}/echo?environment={{region}}&scope={{scope}}'}},
            {'name': 'Write channel', 'request': {'method': 'POST', 'url': '{{baseUrl}}/echo', 'body': {'mode': 'raw', 'raw': '{"limit":12}'}}},
        ]}],
    }
    envs = [{
        'name': name, '_postman_variable_scope': 'environment',
        'values': [{'key': 'baseUrl', 'value': echo_url, 'enabled': True},
                   {'key': 'region', 'value': region, 'enabled': True},
                   {'key': 'token', 'value': token, 'enabled': True, 'type': 'secret'},
                   {'key': 'disabledValue', 'value': 'off', 'enabled': False}],
    } for name, region, token in [('Development', 'dev', 'dev-token'), ('Staging', 'staging', 'staging-token')]]
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True, args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 1600, 'height': 980})
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))

            def state():
                return page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)

            def saved():
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')

            def capture(name):
                page.screenshot(path=str(out / (name + '.png')), full_page=True)
                images.append(name + '.png')

            def import_raw(data):
                page.locator('#import').click()
                page.get_by_label('インポートJSON', exact=True).fill(json.dumps(data))
                page.locator('#modalSubmit').click()
                expect(page.locator('#modalTitle')).to_have_text('インポート完了')
                page.locator('#modalSubmit').click()

            def drawer_env(name):
                page.locator('details.sidebar-group[data-group=environments]').evaluate('el => el.open = true')
                page.get_by_role('button', name='◫  ' + name, exact=True).click()
                expect(page.locator('#modal').get_by_label('Environment name', exact=True)).to_have_value(name)

            def row_menu(index, action):
                page.locator('#modal').get_by_role('button', name=f'行 {index} の操作', exact=True).click()
                page.get_by_role('menuitem', name=action, exact=True).click()

            def env_menu(name, action, right=False):
                target = page.get_by_role('button', name='◫  ' + name, exact=True)
                if right:
                    target.click(button='right')
                else:
                    page.get_by_role('button', name=name + 'の操作', exact=True).click()
                page.get_by_role('menuitem', name=action, exact=True).click()

            def send():
                with page.expect_response(lambda r: r.url.endswith('/api/request') and r.request.method == 'POST') as pending:
                    page.locator('#send').click()
                response = pending.value
                assert response.status == 200
                result = response.json()
                assert result['ok'] and result['status'] == 200
                return json.loads(result['body'])

            page.goto(app_url, wait_until='domcontentloaded')
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            for data in [collection, *envs]:
                import_raw(data)
            drawer_env('Development')
            modal = page.locator('#modal')
            dev_id = modal.get_attribute('data-settings-id')
            staging_id = next(e['id'] for e in state()['environments'] if e['name'] == 'Staging')
            expect(page.locator('#environment')).to_have_value(dev_id)
            expect(page.locator(f'[data-environment-id="{dev_id}"]')).to_have_class('tree-row selected')
            expect(page.locator('#modalSubmit')).not_to_be_visible()
            expect(page.locator('#cancelModal')).to_have_text('閉じる')
            passed('selected environment, highlighted row and drawer agree; no Save/Cancel workflow')

            token = modal.get_by_label('Value 3', exact=True)
            token.fill('dev-edited')
            saved()
            expect(modal).to_be_visible()
            expect(token).to_be_focused()
            assert next(e for e in state()['environments'] if e['id'] == dev_id)['values'][2]['value'] == 'dev-edited'
            # The live request remains accessible beside the nonmodal drawer.
            result = send()
            assert dict(result['headers'])['Authorization'] == 'Bearer dev-edited'
            assert 'environment=dev' in result['path']
            expect(modal).to_be_visible()
            passed('autosave preserves focus and open drawer; edited token immediately reaches real HTTP')

            page.locator('#environment').focus()
            page.locator('#environment').select_option(staging_id)
            expect(modal).to_have_attribute('data-settings-id', staging_id)
            expect(modal.get_by_label('Value 3', exact=True)).to_have_value('staging-token')
            expect(page.locator('#environment')).to_be_focused()
            modal.get_by_label('Value 3', exact=True).fill('staging-edited')
            page.locator('#environment').select_option(dev_id)
            expect(modal.get_by_label('Value 3', exact=True)).to_have_value('dev-edited')
            saved()
            assert next(e for e in state()['environments'] if e['id'] == staging_id)['values'][2]['value'] == 'staging-edited'
            capture('environment-autosave')
            passed('header selector switches drawer without dropping either environment edits')

            page.locator('#environment').select_option('')
            expect(modal).to_contain_text('環境は選択されていません')
            expect(modal.get_by_label('Value 1', exact=True)).to_have_count(0)
            page.locator('#environment').select_option(staging_id)
            expect(modal.get_by_label('Value 3', exact=True)).to_have_value('staging-edited')
            modal.get_by_label('Environment name', exact=True).fill('Staging renamed')
            saved()
            expect(page.locator('#environment option:checked')).to_have_text('Staging renamed')
            expect(page.get_by_role('button', name='◫  Staging renamed', exact=True)).to_be_visible()
            passed('No environment removes stale values; renaming updates selection and sidebar immediately')

            env_menu('Development', '設定をコピー', right=True)
            env_menu('Staging renamed', '設定を貼り付け')
            expect(modal.get_by_label('Environment name', exact=True)).to_have_value('Staging renamed')
            expect(modal.get_by_label('Value 3', exact=True)).to_have_value('dev-edited')
            modal.get_by_label('Value 3', exact=True).fill('independent-token')
            saved()
            assert next(e for e in state()['environments'] if e['id'] == dev_id)['values'][2]['value'] == 'dev-edited'
            passed('environment settings copy/paste preserves target identity and uses independent values')

            env_menu('Staging renamed', '複製')
            expect(modal.get_by_label('Environment name', exact=True)).to_have_value('Staging renamed copy')
            copied_id = modal.get_attribute('data-settings-id')
            assert copied_id not in (dev_id, staging_id)
            expect(page.locator('#environment')).to_have_value(copied_id)
            modal.get_by_label('Value 2', exact=True).fill('copy-region')
            saved()
            assert next(e for e in state()['environments'] if e['id'] == staging_id)['values'][1]['value'] == 'dev'
            row_menu(2, '行をコピー')
            row_menu(2, '行を複製')
            expect(modal.get_by_label('Value 3', exact=True)).to_have_value('copy-region')
            modal.get_by_label('Value 3', exact=True).fill('cloned-row')
            expect(modal.get_by_label('Value 2', exact=True)).to_have_value('copy-region')
            row_menu(3, 'コピーした行を下に貼り付け')
            expect(modal.get_by_label('Value 4', exact=True)).to_have_value('copy-region')
            row_menu(4, '無効にする')
            saved()
            assert next(e for e in state()['environments'] if e['id'] == copied_id)['values'][3]['disabled']
            row_menu(4, '削除')
            passed('environment duplication and variable-row copy/duplicate/paste/disable/delete are independent')

            # Native input context menus should remain available for ordinary text copy.
            native = modal.get_by_label('Value 1', exact=True).evaluate("el => el.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true}))")
            assert native
            expect(page.locator('#itemMenu')).not_to_be_visible()
            modal.get_by_role('button', name='行 1 の操作', exact=True).click()
            capture('variable-context-menu')
            page.keyboard.press('Escape')
            expect(modal.get_by_role('button', name='行 1 の操作', exact=True)).to_be_focused()
            passed('variable context menu keyboard/focus works without replacing native text-input menus')

            modal.get_by_label('Value 2', exact=True).fill('flush-on-close')
            page.locator('#closeModal').click()
            page.reload(wait_until='domcontentloaded')
            drawer_env('Staging renamed copy')
            expect(modal.get_by_label('Value 2', exact=True)).to_have_value('flush-on-close')
            passed('close flushes pending autosave and reload restores selected environment and values')

            # Ctrl+S has no close side effect inside the autosave drawer.
            modal.get_by_label('Value 2', exact=True).fill('keyboard-saved')
            page.keyboard.press('Control+s')
            saved()
            expect(modal).to_be_visible()
            # Export must contain the live value, not the old copy from opening.
            with page.expect_download() as download_info:
                modal.get_by_role('button', name='Export', exact=True).click()
            download = download_info.value
            data = json.loads(Path(download.path()).read_text())
            assert data['values'][1]['value'] == 'keyboard-saved'
            passed('Ctrl+S leaves settings open; export includes automatically saved live values')

            # Globals remain globals, independent of selected-environment navigation.
            page.locator('#closeModal').click()
            page.get_by_role('button', name='◫  Globals', exact=True).click()
            modal.locator('.table-add').click()
            modal.get_by_label('Key 1', exact=True).fill('globalKey')
            modal.get_by_label('Value 1', exact=True).fill('global-value')
            saved()
            page.locator('#environment').select_option(dev_id)
            expect(modal).to_have_attribute('data-settings-kind', 'globals')
            expect(modal.get_by_label('Value 1', exact=True)).to_have_value('global-value')
            passed('Globals autosave is independent and never mislabeled as the selected environment')

            page.locator('#closeModal').click()
            page.locator('details.sidebar-group[data-group=collections]').evaluate('el => el.open = true')
            page.get_by_role('button', name='Control APIの設定', exact=True).click()
            page.get_by_role('menuitem', name='変数・認証を編集').click()
            modal.get_by_label('Value 1', exact=True).fill('scope-live')
            modal.get_by_label('Token', exact=True).fill('scope-token')
            saved()
            result = send()
            assert dict(result['headers'])['Authorization'] == 'Bearer scope-token'
            assert 'scope=scope-live' in result['path']
            expect(modal).to_be_visible()
            passed('collection variables and inherited auth autosave without dismissing the drawer')

            page.get_by_role('button', name='Control APIの設定', exact=True).click()
            page.get_by_role('menuitem', name='設定をコピー').click()
            page.get_by_role('button', name='Channelsの操作', exact=True).click()
            page.get_by_role('menuitem', name='設定を貼り付け').click()
            saved()
            stored = state()['collections'][0]
            assert stored['item'][0]['name'] == 'Channels'
            assert stored['item'][0]['auth']['bearer'][0]['value'] == 'scope-token'
            page.get_by_role('button', name='Channelsの操作', exact=True).click()
            page.get_by_role('menuitem', name='複製').click()
            saved()
            stored = state()['collections'][0]
            assert len(stored['item']) == 2
            source, duplicate = stored['item']
            assert source['_mpId'] != duplicate['_mpId'] and source['item'][0]['_mpId'] != duplicate['item'][0]['_mpId']
            page.get_by_role('button', name='Control APIの設定', exact=True).click()
            page.get_by_role('menuitem', name='複製').click()
            saved()
            original, copy = state()['collections']
            assert original['_mpId'] != copy['_mpId']
            passed('scope settings paste and folder/collection duplication preserve independent hierarchy identities')

            page.locator('#closeModal').click()
            drawer_env('Staging renamed copy')
            # A storage failure is displayed, not falsely acknowledged as persisted.
            page.evaluate("() => { window.__originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(k,v) { if(k==='minipost.workspace.v2') throw new DOMException('full','QuotaExceededError'); return window.__originalSetItem.call(this,k,v); }; }")
            modal.get_by_label('Value 2', exact=True).fill('survives-save-error')
            expect(page.locator('#drawerSaveState')).to_contain_text('保存できません')
            expect(modal.get_by_label('Value 2', exact=True)).to_have_value('survives-save-error')
            page.evaluate('() => { Storage.prototype.setItem = window.__originalSetItem; }')
            modal.get_by_label('Value 2', exact=True).fill('recovered')
            saved()
            passed('storage errors keep the editor values and show a failed-save state, then recover')

            # Responsive transition preserves the exact live row values.
            page.set_viewport_size({'width': 390, 'height': 844})
            expect(modal).to_have_attribute('aria-modal', 'true')
            modal.get_by_label('Value 2', exact=True).fill('mobile-live')
            saved()
            row_menu(2, '行を複製')
            expect(modal.get_by_label('Value 3', exact=True)).to_have_value('mobile-live')
            modal.get_by_role('button', name='行 2 の操作', exact=True).click()
            expect(page.locator('#itemMenu')).to_be_visible()
            assert page.locator('#itemMenu').evaluate("el => el.closest('dialog')?.id") == 'modal'
            capture('mobile-settings-menu')
            page.keyboard.press('Escape')
            expect(modal).to_be_visible()
            page.keyboard.press('Escape')
            expect(modal).not_to_be_visible()
            page.set_viewport_size({'width': 1600, 'height': 980})
            drawer_env('Staging renamed copy')
            expect(modal.get_by_label('Value 2', exact=True)).to_have_value('mobile-live')
            passed('mobile native-modal menus work; resizing and Escape keep automatically saved edits')

            # Removing the active environment also removes stale drawer content.
            page.once('dialog', lambda dialog: dialog.accept())
            env_menu('Staging renamed copy', '削除')
            expect(page.locator('#environment')).to_have_value('')
            expect(modal).to_contain_text('環境は選択されていません')
            saved()
            assert not any(e['id'] == copied_id for e in state()['environments'])
            passed('deleting the selected environment clears selection and stale settings together')
            assert not errors, errors
            passed('no uncaught browser JavaScript errors')
            browser.close()
    finally:
        (out / 'results.json').write_text(json.dumps({'passed': len(checks), 'checks': checks, 'screenshots': images, 'page_errors': errors,
            'target': 'real loopback HTTP', 'storage_failure_test': 'Storage.setItem only; HTTP not mocked'}, ensure_ascii=False, indent=2))
        for server in (app, echo):
            server.shutdown(); server.server_close()


if __name__ == '__main__':
    main()
