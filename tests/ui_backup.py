"""Real Chromium checks for local-first persistence, whole-file transfer and context-menu Send."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
from urllib.error import HTTPError
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright
from test_proxy import proxy, start_server


def main():
    with tempfile.TemporaryDirectory(prefix='minipost-backup-') as temp:
        original = proxy.WORKSPACE_FILE
        proxy.WORKSPACE_FILE = Path(temp) / 'workspace.json'
        echo, echo_url = start_server()
        app, app_url = start_server(proxy.Handler)
        out = Path(os.environ.get('ARTIFACT_DIR', temp)) / 'backup'
        out.mkdir(parents=True, exist_ok=True)
        checks = []
        errors = []

        def passed(text):
            checks.append(text)
            print('PASS ' + text, flush=True)

        def server_workspace():
            try:
                with urlopen(app_url + '/api/workspace', timeout=5) as response:
                    return response.status, json.loads(response.read())
            except HTTPError as error:
                return error.code, json.loads(error.read())

        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True, args=['--no-sandbox'])
                page = browser.new_page(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(app_url)
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                assert server_workspace()[0] == 404

                collection = {
                    'info': {'name': 'Backup API', 'schema': 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
                    'item': [{'name': 'Echo backup', 'request': {'method': 'POST', 'url': echo_url + '/echo',
                              'body': {'mode': 'raw', 'raw': '{"note":"initial"}',
                                       'options': {'raw': {'language': 'json'}}}}}],
                }
                env = {'name': 'QA backup', '_postman_variable_scope': 'environment',
                       'values': [{'key': 'key', 'value': 'test-local-only'}]}

                def import_one(data):
                    page.locator('#import').click()
                    page.get_by_label('インポートJSON').fill(json.dumps(data))
                    page.locator('#modalSubmit').click()
                    expect(page.locator('#modalTitle')).to_have_text('インポート完了')
                    page.locator('#modalSubmit').click()

                import_one(collection)
                import_one(env)
                assert server_workspace()[0] == 404
                state = page.evaluate('JSON.parse(localStorage.getItem("minipost.workspace.v2"))')
                assert state['collections'][0]['info']['name'] == 'Backup API'
                assert state['environments'][0]['name'] == 'QA backup'
                passed('Postman individual import changes localStorage without writing server data')

                # A context menu Send uses the selected saved request, never a hidden tab.
                item = page.get_by_role('button', name='Echo backupの操作', exact=True)
                item.click()
                page.get_by_role('menuitem', name='送信', exact=True).click()
                expect(page.locator('#responseStatus')).to_contain_text('200')
                assert page.evaluate('JSON.parse(localStorage.getItem("minipost.workspace.v2")).history.length') > 0
                assert server_workspace()[0] == 404
                passed('saved request is sent by context menu without server workspace persistence')

                page.locator('#dataActions').click()
                with page.expect_download() as download:
                    page.get_by_role('menuitem', name='全体エクスポート').click()
                target = out / 'whole-workspace.json'
                download.value.save_as(target)
                whole = json.loads(target.read_text())
                assert whole['kind'] == 'minipost.workspace'
                assert whole['version'] == 1
                assert whole['workspace']['collections'][0]['info']['name'] == 'Backup API'
                assert whole['workspace']['environments'][0]['values'][0]['value'] == 'test-local-only'
                assert whole['workspace']['history']
                assert isinstance(whole['workspace']['revisions'], dict)
                assert whole['layout'] is not None
                passed('whole export includes collections, environments, request history, revisions and layout')

                page.locator('#dataActions').click()
                with page.expect_response(lambda response: response.url.endswith('/api/workspace') and response.request.method == 'POST') as pending:
                    page.get_by_role('menuitem', name='サーバーへ保存').click()
                assert pending.value.status == 200
                assert proxy.WORKSPACE_FILE.is_file()
                status, on_server = server_workspace()
                assert status == 200
                assert on_server['workspace']['environments'][0]['values'][0]['value'] == 'test-local-only'
                passed('explicit menu action commits an atomic server backup')

                # Further changes must not modify the saved server snapshot.
                page.locator('#url').fill(echo_url + '/echo?changed=local')
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
                assert server_workspace()[1]['workspace'] == on_server['workspace']
                passed('new edits are local only and do not auto-sync to server')

                # Recover the previously stored snapshot with the manual restore UI.
                page.locator('#dataActions').click()
                page.get_by_role('menuitem', name='サーバーから読込').click()
                expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
                expect(page.locator('#importMode')).to_have_value('replace')
                page.locator('#modalSubmit').click()
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                restored = page.evaluate('JSON.parse(localStorage.getItem("minipost.workspace.v2"))')
                assert restored['environments'][0]['values'][0]['value'] == 'test-local-only'
                assert restored['collections'][0]['item'][0]['request']
                passed('manually restoring a server backup retains environment and request data')

                page.screenshot(path=str(out / 'whole-backup-desktop.png'), full_page=True)
                page.set_viewport_size({'width': 390, 'height': 844})
                page.screenshot(path=str(out / 'whole-backup-phone.png'), full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                assert not errors, errors
                passed('backup UI and context actions produce no browser exceptions or viewport overflow')
                (out / 'result.json').write_text(json.dumps({'checks': checks, 'errors': errors,
                    'screenshots': ['whole-backup-desktop.png', 'whole-backup-phone.png']}, ensure_ascii=False, indent=2))
                browser.close()
        finally:
            for server in (app, echo):
                server.shutdown()
                server.server_close()
            proxy.WORKSPACE_FILE = original


if __name__ == '__main__':
    main()
