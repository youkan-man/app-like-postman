"""Independent script input, results, reuse and persistence over real browser HTTP.

The app is exercised through its UI and actual isolated Worker. IndexedDB reads
only inspect durable results; they never replace runtime or storage behavior.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import tempfile
from http.server import ThreadingHTTPServer
from threading import Thread

from playwright.sync_api import expect, sync_playwright
from test_proxy import EchoHandler, proxy, start_server


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


def main():
    if os.environ.get('MINIPOST_INLINE_TEST') == '1':
        raise RuntimeError('Independent script acceptance requires a real HTTP origin')
    server = None
    url = os.environ.get('MINIPOST_REMOTE_URL')
    if url:
        peer = os.environ['LOCAL_RELAY_VM_BROWSER_IP']
        port = int(os.environ.get('LOCAL_RELAY_VM_BROWSER_PORT') or '18081')
        receiver = ThreadingHTTPServer(('0.0.0.0', port), EchoHandler)
        Thread(target=receiver.serve_forever, daemon=True).start()
        receiver_url = f'http://{peer}:{port}'
    else:
        receiver, receiver_url = start_server()
        server, url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-scripts-'))) / 'standalone-scripts'
    out.mkdir(parents=True, exist_ok=True)
    checks, screenshots, errors, dialogs, crashes, requests = [], [], [], [], [], []
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
                    screenshots.append('failure.png')
                except Exception:
                    pass
            raise

    try:
        with sync_playwright() as playwright, capture_failure():
            browser = playwright.chromium.launch(
                executable_path=os.environ.get('CHROMIUM') or shutil.which('chromium'),
                headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
            page.set_default_timeout(10000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
            page.on('crash', lambda: crashes.append('page crashed'))
            page.on('request', lambda request: requests.append(request.url) if '/api/request' in request.url else None)

            def ready():
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                expect(page.locator('#saveState')).not_to_have_text('ローカルデータを読込中…')

            def saved():
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
                return page.evaluate(READ_WORKSPACE)

            def sidebar():
                if page.locator('#toggleSidebar').get_attribute('aria-expanded') != 'true':
                    page.locator('#toggleSidebar').click()
                page.locator('[data-sidebar="scripts"]').click()
                expect(page.locator('#sidebarContent')).to_have_attribute('data-side', 'scripts')

            def create(name):
                sidebar()
                page.locator('#sidebarAdd').click()
                page.get_by_role('menuitem', name='スクリプトを作成', exact=True).click()
                page.locator('#modal').get_by_label('スクリプト名', exact=True).fill(name)
                page.locator('#modalSubmit').click()
                expect(page.locator('#modal')).not_to_be_visible()
                expect(page.locator('.scripts-page')).to_be_visible()
                expect(page.locator('.scripts-page').get_by_label('スクリプト名', exact=True)).to_have_value(name)
                return next(item['id'] for item in reversed(saved()['scripts']) if item['name'] == name)

            def open_script(identifier):
                sidebar()
                page.locator(f'[data-script-id="{identifier}"] .tree-open').click()
                expect(page.locator('.scripts-page')).to_be_visible()

            def edit(source, value='null', fmt='json'):
                page.get_by_label('スクリプトのコード', exact=True).fill(source)
                page.get_by_label('入力形式', exact=True).select_option(fmt)
                page.get_by_label('スクリプトの入力', exact=True).fill(value)

            def run(outcome='success'):
                page.locator('#runStandaloneScript').click()
                try:
                    expect(page.locator('#standaloneScriptStatus')).to_have_attribute('data-state', outcome)
                except AssertionError as error:
                    details = page.locator('#standaloneScriptResult').inner_text()
                    logs = page.locator('#standaloneScriptLog').inner_text()
                    raise AssertionError(f'Script did not reach {outcome}: {details}\nLogs: {logs}') from error
                expect(page.locator('#runStandaloneScript')).to_be_enabled()

            def result():
                return json.loads(page.locator('#standaloneScriptResult').inner_text())

            def capture(name):
                page.screenshot(path=str(out/(name+'.png')), full_page=True)
                screenshots.append(name+'.png')

            page.goto(url, wait_until='domcontentloaded')
            ready()
            main_id = create('データ集計')
            edit('const values = input.values.map(Number); return {total: values.reduce((a,b) => a+b, 0), values, enabled: false, empty: null};',
                 '{"values":[3,"5",8]}')
            run()
            assert result() == {'total': 16, 'values': [3, 5, 8], 'enabled': False, 'empty': None}
            workspace = saved()
            assert workspace['collections'] == [] and workspace['tabs'] == [] and workspace['history'] == []
            assert requests == []
            passed('an empty workspace creates and runs a script with typed input and return values without creating or sending requests')

            edit('return input;', 'first line\nsecond line', 'text')
            run()
            expect(page.locator('#standaloneScriptResult')).to_have_text('first line\nsecond line')
            edit('return;', 'null')
            run()
            expect(page.locator('#standaloneScriptResult')).to_have_text('戻り値なし')
            edit('return null;')
            run()
            assert result() is None
            passed('text input is preserved and null is distinguished from an absent return value')

            edit("store.set('invalidInputRan', true); return input;", '{broken')
            run('error')
            assert 'invalidInputRan' not in saved().get('scriptData', {})
            passed('invalid JSON input is rejected before executing the script')

            child_id = create('倍にする')
            edit('return input.map(value => value * 2);', '[1,2]')
            saved()
            open_script(main_id)
            edit("const byName = await scripts.run('倍にする', input); const byId = await scripts.run("+json.dumps(child_id)+", [5]); return {byName, byId, count: scripts.list().length};", '[2,4,6]')
            run()
            assert result() == {'byName': [4, 8, 12], 'byId': [10], 'count': 2}
            passed('saved scripts are reusable by ID or unique name and their awaited typed results reach the caller')

            duplicate_id = create('倍にする')
            edit('return "duplicate";')
            saved()
            open_script(main_id)
            edit("return await scripts.run('倍にする', [1]);")
            run('error')
            edit('return await scripts.run('+json.dumps(child_id)+', [7]);')
            run()
            assert result() == [14]
            assert duplicate_id != child_id
            passed('ambiguous script names fail explicitly while stable ID calls remain usable')

            edit("store.set('lastSummary', {values: input, count: input.length, valid: true}); return store.get('lastSummary');", '[2,4,6]')
            run()
            expected_data = {'values': [2, 4, 6], 'count': 3, 'valid': True}
            assert result() == expected_data
            assert saved()['scriptData']['lastSummary'] == expected_data
            edit("store.set('lastSummary', {wrong: true}); store.set('failedWrite', 1); vars.set('failedWrite', 'x'); console.log('before failure'); throw new Error('intentional rollback');")
            run('error')
            expect(page.locator('#standaloneScriptLog')).to_contain_text('before failure')
            durable = saved()['scriptData']
            assert durable['lastSummary'] == expected_data and 'failedWrite' not in durable
            assert not page.evaluate("JSON.parse(sessionStorage.getItem('minipost.primary.v1') || '[]').some(row => row.key === 'failedWrite')")
            passed('shared data retains JSON types and runtime failure rolls back data and variable changes while preserving logs')

            edit("console.log('running-before-stop'); store.set('cancelledWrite', true); await new Promise(resolve => setTimeout(resolve, 60000)); return 'too late';")
            page.locator('#runStandaloneScript').click()
            expect(page.locator('#standaloneScriptLog')).to_contain_text('running-before-stop')
            expect(page.locator('#standaloneScriptStatus')).to_have_attribute('data-state', 'running')
            expect(page.locator('#runStandaloneScript')).not_to_be_visible()
            expect(page.locator('#stopStandaloneScript')).to_be_visible()
            capture('live-log-desktop')
            page.locator('#stopStandaloneScript').click()
            expect(page.locator('#standaloneScriptStatus')).to_have_attribute('data-state', 'stopped')
            expect(page.locator('#standaloneScriptLog')).to_contain_text('running-before-stop')
            assert 'cancelledWrite' not in saved()['scriptData']
            passed('logs stream before completion and stopping a running Worker preserves logs without committing pending writes')

            edit("const workspace = await minipost.workspace.read(); return {scripts: workspace.scripts.length, requests: (await minipost.requests.list()).length, environments: (await minipost.environments.list()).length, data: store.get('lastSummary'), dom: typeof document};")
            run()
            assert result() == {'scripts': 3, 'requests': 0, 'environments': 0, 'data': expected_data, 'dom': 'undefined'}
            assert requests == []
            passed('optional workspace APIs are available to independent scripts while DOM isolation remains intact')

            edit("const values = await scripts.run("+json.dumps(child_id)+", input); return {values, previous: store.get('lastSummary')};", '[4,9]')
            run()
            expected_result = {'values': [8, 18], 'previous': expected_data}
            assert result() == expected_result
            saved_before_reload = saved()
            page.reload(wait_until='domcontentloaded')
            ready()
            open_script(main_id)
            expect(page.get_by_label('スクリプトの入力', exact=True)).to_have_value('[4,9]')
            run()
            assert result() == expected_result
            after_reload = saved()
            assert after_reload['scripts'] == saved_before_reload['scripts']
            assert after_reload['scriptData'] == saved_before_reload['scriptData']
            passed('script source, input, identities and typed shared data survive native IndexedDB reload')

            page.locator('#dataActions').click()
            with page.expect_download() as download:
                page.get_by_role('menuitem', name='全体エクスポート', exact=True).click()
            backup = out/'scripts-workspace.json'
            download.value.save_as(backup)
            bundle = json.loads(backup.read_text())
            assert bundle['workspace']['scripts'] == after_reload['scripts']
            assert bundle['workspace']['scriptData'] == after_reload['scriptData']
            edit("store.clear(); return 'changed';")
            run()
            assert saved()['scriptData'] == {}
            page.locator('#import').click()
            page.get_by_label('インポートJSON', exact=True).fill(json.dumps(bundle, ensure_ascii=False))
            page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
            with page.expect_navigation(wait_until='domcontentloaded'):
                page.locator('#modalSubmit').click()
            ready()
            open_script(main_id)
            run()
            assert result() == expected_result
            assert saved()['scriptData'] == after_reload['scriptData']
            passed('whole-workspace export and restore recover executable scripts and shared data together')

            connected = json.loads(json.dumps(bundle))
            connected['workspace']['environments'] = [{'id': 'script-env', 'name': 'Script environment',
                                                      'values': [{'key': 'envValue', 'value': 'original', 'enabled': True}]}]
            connected['workspace']['environmentId'] = 'script-env'
            connected['workspace']['scripts'].extend([
                {'id': 'script-before-hook', 'name': '送信時の設定', 'input': 'null', 'inputFormat': 'json', 'timeoutMs': 0,
                 'source': "if (input.method !== 'POST') throw Error('missing request input'); vars.set('hookToken', 'from-hook'); store.set('beforeCalls', (store.get('beforeCalls') || 0) + 1);"},
                {'id': 'script-after-hook', 'name': '受信時の記録', 'input': 'null', 'inputFormat': 'json', 'timeoutMs': 0,
                 'source': "store.set('afterStatus', input.status); store.set('afterCalls', (store.get('afterCalls') || 0) + 1); return input.body;"},
            ])
            connected['workspace']['collections'] = [{
                '_mpId': 'script-collection', 'info': {'name': 'Script API',
                    'schema': 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
                'variable': [], 'item': [{'_mpId': 'script-request', 'name': 'Script echo',
                    'request': {'method': 'POST', 'url': receiver_url+'/echo?token={{hookToken}}',
                        'header': [{'key': 'X-Script-Env', 'value': '{{envValue}}', 'enabled': True}],
                        'body': {'mode': 'raw', 'raw': '{"from":"standalone"}',
                                 'options': {'raw': {'language': 'json'}}},
                        '_minipost': {'enabled': True, 'beforeScriptId': 'script-before-hook',
                                      'afterScriptId': 'script-after-hook', 'timeoutMs': 5000}},
                    'settings': {'verify_tls': False, 'follow_redirects': True, 'timeout_ms': 30000}}],
            }]
            page.locator('#import').click()
            page.get_by_label('インポートJSON', exact=True).fill(json.dumps(connected, ensure_ascii=False))
            page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
            with page.expect_navigation(wait_until='domcontentloaded'):
                page.locator('#modalSubmit').click()
            ready()
            open_script(main_id)
            edit("vars.set('hookToken', 'from-script'); minipost.environment.set('envValue', 'changed-in-run'); const request = await minipost.requests.get('Script echo'); const response = await minipost.requests.send(request); return {id: request.id, status: response.status, path: response.body.path, headers: response.body.headers};")
            sent_before = len(requests)
            run()
            received = result()
            assert received['id'] == 'script-collection:script-request'
            assert received['status'] == 200 and received['path'] == '/echo?token=from-script'
            assert dict(received['headers'])['X-Script-Env'] == 'changed-in-run'
            assert len(requests) == sent_before + 1
            durable = saved()
            assert not durable['scriptData'].get('beforeCalls') and not durable['scriptData'].get('afterCalls')
            assert durable['environments'][0]['values'][0]['value'] == 'changed-in-run'
            passed('explicit request API sends real HTTP using pending variables and environment changes without re-entering request hooks')

            if page.locator('#toggleSidebar').get_attribute('aria-expanded') != 'true':
                page.locator('#toggleSidebar').click()
            page.locator('[data-sidebar="collections"]').click()
            page.locator('[data-item-id="script-request"] .tree-open').click()
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_contain_text('200')
            durable = saved()['scriptData']
            assert durable['beforeCalls'] == 1 and durable['afterCalls'] == 1 and durable['afterStatus'] == 200
            assert len(requests) == sent_before + 2
            passed('normal request execution invokes referenced saved scripts before and after HTTP with phase-specific input')
            open_script(main_id)
            edit("const values = await scripts.run(\n  "+json.dumps(child_id)+", input\n);\n\nreturn {\n  values,\n  previous: store.get('lastSummary')\n};", '[4,9]')
            run()
            assert result() == expected_result

            for width, height in [(1440, 900), (390, 844), (320, 720)]:
                page.set_viewport_size({'width': width, 'height': height})
                if page.locator('#navClose').is_visible() and page.locator('#toggleSidebar').get_attribute('aria-expanded') == 'true':
                    page.locator('#navClose').click()
                expect(page.get_by_label('スクリプトのコード', exact=True)).to_be_visible()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, height)
                bounds = page.get_by_label('スクリプトのコード', exact=True).bounding_box()
                assert bounds and bounds['width'] >= 160 and bounds['height'] >= 90, bounds
                capture(f'scripts-{width}x{height}')
            passed('desktop and 390/320 px pages keep code, input and results accessible without horizontal viewport overflow')
            assert not errors, errors
            assert not dialogs, dialogs
            assert not crashes, crashes
            passed('independent script scenarios produce no uncaught browser errors, native dialogs or page crashes')
            completed = True
            browser.close()
    finally:
        (out/'results.json').write_text(json.dumps({
            'ok': completed, 'mode': 'native Chromium HTTP', 'native_indexeddb': True,
            'checks': checks, 'screenshots': screenshots, 'page_errors': errors,
            'native_dialogs': dialogs, 'crashes': crashes,
        }, ensure_ascii=False, indent=2))
        for active_server in (server, receiver):
            if active_server:
                active_server.shutdown()
                active_server.server_close()


if __name__ == '__main__':
    main()
