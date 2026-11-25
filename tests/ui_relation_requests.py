"""Relations share request ownership, editing, execution and persistence over HTTP."""
from __future__ import annotations

from contextlib import contextmanager
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import tempfile
from threading import Thread

from playwright.sync_api import expect, sync_playwright
from test_proxy import EchoHandler, proxy, start_server
from ui_standalone_scripts import READ_WORKSPACE
from relation_ui_helpers import relation_entries, relations


def main():
    if os.environ.get('MINIPOST_INLINE_TEST') == '1':
        raise RuntimeError('Relation request acceptance requires native Chromium over HTTP')
    app, url = None, os.environ.get('MINIPOST_REMOTE_URL')
    if url:
        port = int(os.environ.get('LOCAL_RELAY_VM_BROWSER_PORT', '18081'))
        receiver = ThreadingHTTPServer(('0.0.0.0', port), EchoHandler)
        Thread(target=receiver.serve_forever, daemon=True).start()
        target = f'http://{os.environ["LOCAL_RELAY_VM_BROWSER_IP"]}:{port}'
    else:
        receiver, target = start_server()
        app, url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-relation-requests-'))) / 'relation-requests'
    out.mkdir(parents=True, exist_ok=True)
    checks, screenshots, errors, dialogs, sent = [], [], [], [], []
    page, completed = None, False
    settings = {'timeout_ms': 10000, 'verify_tls': False, 'follow_redirects': True}

    def request_step(identifier, item_id):
        return {'id': identifier, 'type': 'request', 'collectionId': 'requests', 'itemId': item_id,
                'repeat': 1, 'delayMs': 0, 'intervalMs': 0, 'onTrue': '$next', 'onFalse': '$next',
                'condition': {'enabled': False, 'source': 'response', 'path': '/status', 'operator': 'eq', 'value': '200'}}

    child = {'id': 'relation-child', 'name': 'Nested request', 'repeat': 1, 'intervalMs': 0,
             'stopOnError': True, 'steps': [request_step('child-http', 'http-finish')]}
    legacy = {'id': 'relation-legacy', 'name': 'Legacy loop', 'repeat': 1, 'intervalMs': 0,
              'environmentId': 'flow-env', 'stopOnError': True, 'steps': [
                  {'id': 'loop-block', 'type': 'repeat', 'repeat': 2, 'intervalMs': 0,
                   'steps': [request_step('loop-http', 'http-start')]},
                  request_step('nested-call', 'nested-request')]}
    workspace = {'version': 2, 'collections': [{'_mpId': 'requests', 'info': {'name': 'Request types'}, 'item': [
        {'_mpId': 'http-start', 'name': 'HTTP start', 'settings': settings, 'request': {
            'method': 'POST', 'url': target + '/echo?stage=start', 'header': [{'key': 'X-Flow', 'value': '{{flow}}', 'disabled': False}],
            'body': {'mode': 'raw', 'raw': '{"keep":"payload"}', 'options': {'raw': {'language': 'json'}}}}},
        {'_mpId': 'http-finish', 'name': 'HTTP finish', 'settings': settings, 'request': {
            'method': 'GET', 'url': target + '/echo?stage=finish', 'header': []}},
        {'_mpId': 'nested-request', 'name': 'Nested request', 'settings': settings,
         'request': {'type': 'relation', 'relation': child}},
        {'_mpId': 'http-convert', 'name': 'Converted snapshot', 'settings': settings, 'request': {
            'method': 'GET', 'url': 'https://must-not-send.invalid', 'header': [], '_minipost': {
                'enabled': True, 'timeoutMs': 5000,
                'before': "request.set('type','relation');request.set('relation.steps',[{id:'converted-wait',type:'wait',delayMs:0}]);request.set('relation.environmentId','flow-env');"}}}]}],
        'environments': [{'id': 'flow-env', 'name': 'Flow environment', 'values': [{'key': 'flow', 'value': 'from-relation'}]}],
        'environmentId': '', 'globals': [], 'tabs': [], 'history': [], 'scripts': [{
            'id': 'script-relation-api', 'name': 'Request type API', 'inputFormat': 'json', 'input': 'null', 'timeoutMs': 5000,
            'source': """const request = minipost.requests.create({parent:'requests',name:'Script relation',request:{
  type:'relation',relation:{steps:[{id:'script-wait',type:'wait',delayMs:0}]}}});
minipost.requests.set(request.id,'request.relation.repeat',2);
const edited=minipost.requests.get(request.id);
const sent=await minipost.requests.send(request.id);
const compatible=await pm.relations.run(edited.request.relation.id);
return {type:sent.type,status:sent.run.status,repeat:edited.request.relation.repeat,compatible:compatible.status};"""}], 'scriptData': {},
        'relations': [legacy], 'relationRuns': [{'id': 'legacy-log', 'relationId': 'relation-legacy', 'status': 'succeeded',
            'startedAt': '2026-11-01T00:00:00Z', 'finishedAt': '2026-11-01T00:00:01Z', 'entries': []}],
        'revisions': {'relation:relation-legacy': [{'id': 'legacy-revision', 'at': '2026-11-01T00:00:00Z',
                        'reason': '変更前', 'changed': [], 'value': legacy}]}, 'collapsed': [], 'theme': 'light'}

    def passed(message):
        checks.append(message)
        print('PASS ' + message, flush=True)

    @contextmanager
    def failure_evidence():
        try:
            yield
        except Exception:
            if page and not page.is_closed():
                try:
                    page.screenshot(path=str(out / 'failure.png'), full_page=True)
                    screenshots.append('failure.png')
                except Exception:
                    pass
            raise

    try:
        with sync_playwright() as playwright, failure_evidence():
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM') or shutil.which('chromium'),
                                                 headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 920}, accept_downloads=True)
            page.set_default_timeout(10000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
            page.on('request', lambda request: sent.append(json.loads(request.post_data))
                    if request.url.endswith('/api/request') and request.method == 'POST' else None)

            def ready():
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                expect(page.locator('#saveState')).not_to_have_text('ローカルデータを読込中…')

            def saved():
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
                return page.evaluate(READ_WORKSPACE)

            def sidebar(kind='collections'):
                if page.locator('#toggleSidebar').get_attribute('aria-expanded') != 'true':
                    page.locator('#toggleSidebar').click()
                page.locator(f'[data-sidebar="{kind}"]').click()

            def choose(selector):
                sidebar()
                page.locator(selector + ' .tree-open').click()
                if page.locator('#navClose').is_visible() and page.locator('#toggleSidebar').get_attribute('aria-expanded') == 'true':
                    page.locator('#navClose').click()

            def capture(name):
                expect(page.locator('#toast')).to_be_hidden(timeout=12000)
                page.screenshot(path=str(out / (name + '.png')), full_page=True)
                screenshots.append(name + '.png')

            page.goto(url, wait_until='domcontentloaded')
            ready()
            page.locator('#import').click()
            page.get_by_label('インポートJSON', exact=True).fill(json.dumps({'kind': 'minipost.workspace', 'version': 1, 'workspace': workspace}))
            page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
            with page.expect_navigation(wait_until='domcontentloaded'):
                page.locator('#modalSubmit').click()
            ready()
            migrated = saved()
            entries = relation_entries(migrated)
            assert len(entries) == 2 and not migrated.get('relations'), migrated
            migrated_owner = next(entry for entry in entries if entry['relation']['id'] == legacy['id'])
            assert migrated_owner['relation']['steps'] == legacy['steps']
            revision_key = f"request:{migrated_owner['collectionId']}:{migrated_owner['owner']['_mpId']}"
            assert any(entry['id'] == 'legacy-revision' for entry in migrated['revisions'][revision_key])
            assert 'relation:relation-legacy' not in migrated['revisions']
            assert any(entry['id'] == 'legacy-log' for entry in migrated['relationRuns'])
            expect(page.locator('[data-sidebar="relations"]')).to_have_count(0)
            passed('legacy plans migrate once into normal saved requests with stable step IDs, logs and revisions')

            choose('[data-relation-id="relation-legacy"]')
            expect(page.locator('#requestType')).to_have_value('relation')
            expect(page.locator('#requestName')).to_have_value('Legacy loop')
            for selector in ['#url', '#method', '#editorTabs', '#workspacePage']:
                expect(page.locator(selector)).to_be_hidden()
            expect(page.locator('#editorContent #relationSteps')).to_be_visible()
            expect(page.locator('#requestHistory')).to_be_visible()
            expect(page.locator('#requestRibbonEdit')).to_be_visible()
            assert page.locator('#send').count() == 1
            before = len(sent)
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_contain_text('完了', timeout=30000)
            expect(page.locator('#send')).to_contain_text('実行')
            runs = saved()['relationRuns']
            assert runs[-1]['relationId'] == legacy['id'] and runs[-1]['status'] == 'succeeded', runs[-1]
            assert [entry['requestName'] for entry in runs[-1]['entries']] == ['HTTP start', 'HTTP start', 'Nested request']
            assert [{row['key']: row['value'] for row in entry['query']}['stage']
                    for entry in sent[before:]] == ['start', 'start', 'finish'], sent[before:]
            assert all(next(row['value'] for row in entry['headers'] if row['key'] == 'X-Flow') == 'from-relation'
                       for entry in sent[before:before + 2])
            assert all(entry.get('type') != 'relation' for entry in sent[before:])
            passed('the common execute action runs nested relation requests and only their HTTP children reach the proxy')
            capture('relation-request-desktop')

            page.locator('#requestHistory').click()
            expect(page.locator('.revision-entry')).not_to_have_count(0)
            page.keyboard.press('Escape')
            expect(page.locator('#modal')).not_to_be_visible()
            sidebar('history')
            expect(page.locator('#historyPage')).to_contain_text('Legacy loop')
            assert saved()['history'][-1]['type'] == 'relation'
            assert saved()['history'][-1]['relation_run']['relationId'] == legacy['id']
            passed('relation requests use the same revision and execution history surfaces')

            choose('[data-item-id="http-convert"]')
            before = len(sent)
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_contain_text('完了', timeout=30000)
            expect(page.locator('#relationRunLog')).to_be_visible()
            expect(page.locator('#requestType')).to_have_value('http')
            expect(page.locator('#url')).to_have_value('https://must-not-send.invalid')
            assert len(sent) == before
            converted = saved()['history'][-1]
            assert converted['type'] == 'relation' and converted['environmentId'] == 'flow-env'
            assert converted['environmentName'] == 'Flow environment'
            assert converted['tab']['request'].get('type', 'http') == 'http'
            assert converted['relation_run']['environmentId'] == 'flow-env'
            passed('before-script conversion displays its relation result and actual execution environment while preserving the HTTP template')

            choose('[data-item-id="http-start"]')
            original = saved()['collections'][0]['item'][0]['request']
            page.locator('#requestType').select_option('relation')
            expect(page.locator('#addRelationStep')).to_be_visible()
            page.locator('#addRelationStep').click()
            page.get_by_role('menuitem', name='待機', exact=True).click()
            page.get_by_label('待機 ms', exact=True).fill('123')
            retained = saved()['collections'][0]['item'][0]['request']['relation']
            page.locator('#requestType').select_option('http')
            expect(page.locator('#method')).to_have_value('POST')
            expect(page.locator('#url')).to_have_value(target + '/echo?stage=start')
            current = saved()['collections'][0]['item'][0]['request']
            for key in ['method', 'header', 'body']:
                assert current[key] == original[key], key
            assert current['url']['raw'] == target + '/echo?stage=start'
            page.locator('#requestType').select_option('relation')
            expect(page.get_by_label('待機 ms', exact=True)).to_have_value('123')
            assert saved()['collections'][0]['item'][0]['request']['relation']['id'] == retained['id']
            page.locator('#requestType').select_option('http')
            passed('HTTP and relation settings remain intact through both directions of type switching')

            sidebar()
            page.locator('[data-item-id="http-finish"]').click(button='right')
            page.get_by_role('menuitem', name='リレーション', exact=True).click()
            page.get_by_label('追加する名前', exact=True).fill('Created alongside HTTP')
            page.locator('#modalSubmit').click()
            expect(page.locator('#requestType')).to_have_value('relation')
            created = next(entry for entry in relation_entries(saved()) if entry['owner']['name'] == 'Created alongside HTTP')
            assert created['collectionId'] == 'requests'
            page.locator('#addRelationStep').click()
            page.get_by_role('menuitem', name='待機', exact=True).click()
            page.get_by_label('待機 ms', exact=True).fill('10000')
            page.locator('#send').click()
            expect(page.locator('#send')).to_contain_text('停止')
            expect(page.locator('#requestType')).to_be_disabled()
            choose('[data-item-id="http-finish"]')
            expect(page.locator('#send')).to_contain_text('送信')
            choose(f'[data-item-id="{created["owner"]["_mpId"]}"]')
            expect(page.locator('#send')).to_contain_text('停止')
            before = len(sent)
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_contain_text('停止', timeout=5000)
            expect(page.locator('#send')).to_contain_text('実行')
            assert len(sent) == before
            passed('context creation shares the collection and Stop follows the running request across selection changes')

            page.get_by_label('待機 ms', exact=True).fill('0')
            before_duplicate = relation_entries(saved())
            source = next(entry for entry in before_duplicate if entry['relation']['id'] == created['relation']['id'])
            page.locator('#duplicateRequest').click()
            duplicate = next(entry for entry in relation_entries(saved()) if entry['relation']['id'] not in
                             {entry['relation']['id'] for entry in before_duplicate})
            assert duplicate['relation']['id'] != created['relation']['id']
            assert duplicate['relation']['steps'][0]['id'] != source['relation']['steps'][0]['id']
            assert duplicate['relation']['steps'][0]['type'] == 'wait'
            passed('ordinary request duplication creates independent relation and step identities')

            page.locator('#saveRequest').click()
            page.get_by_label('Request name', exact=True).fill('Registered relation copy')
            page.get_by_label('Collection', exact=True).select_option('requests')
            page.locator('#modalSubmit').click()
            registered = next(entry for entry in relation_entries(saved()) if entry['owner']['name'] == 'Registered relation copy')
            assert registered['collectionId'] == 'requests'
            assert registered['relation']['id'] == duplicate['relation']['id']
            assert registered['relation']['steps'] == duplicate['relation']['steps']
            expect(page.locator('#saveRequest')).to_be_hidden()
            passed('a relation draft registers through the ordinary save action without changing its definition identity')

            sidebar('scripts')
            page.locator('[data-script-id="script-relation-api"] .tree-open').click()
            before = len(sent)
            page.locator('#runStandaloneScript').click()
            expect(page.locator('#standaloneScriptStatus')).to_have_attribute('data-state', 'success', timeout=30000)
            assert json.loads(page.locator('#standaloneScriptResult').inner_text()) == {
                'type': 'relation', 'status': 'succeeded', 'repeat': 2, 'compatible': 'succeeded'}
            assert len(sent) == before
            scripted = next(entry for entry in relation_entries(saved()) if entry['owner']['name'] == 'Script relation')
            assert scripted['collectionId'] == 'requests' and scripted['relation']['repeat'] == 2
            passed('the real isolated Worker creates, edits and sends a relation through requests APIs and legacy pm.relations')

            choose('[data-relation-id="relation-legacy"]')
            for width, height in [(390, 844), (320, 720)]:
                page.set_viewport_size({'width': width, 'height': height})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                expect(page.locator('#requestType')).to_be_in_viewport()
                expect(page.locator('#send')).to_be_in_viewport()
                expect(page.locator('#addRelationStep')).to_be_in_viewport()
                capture('relation-request-' + str(width))
            passed('one compact request heading and relation toolbar remain usable at 1440, 390 and 320px')

            before_reload = saved()
            page.reload(wait_until='domcontentloaded')
            ready()
            after_reload = saved()
            assert after_reload['collections'] == before_reload['collections']
            assert len(relations(after_reload)) == len(relations(before_reload))
            assert after_reload['relationRuns'] == before_reload['relationRuns']
            expect(page.locator('#requestType')).to_have_value('relation')
            expect(page.locator('#requestName')).to_have_value('Legacy loop')
            passed('saved relation requests, nested definitions and results survive reload without duplicate migration')
            assert not errors and not dialogs, {'errors': errors, 'dialogs': dialogs}
            completed = True
            browser.close()
    finally:
        result = {'ok': completed, 'mode': 'native Chromium HTTP', 'checks': checks, 'screenshots': screenshots,
                  'page_errors': errors, 'native_dialogs': dialogs, 'proxy_requests': sent}
        (out / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        if app:
            app.shutdown()
            app.server_close()
        receiver.shutdown()
        receiver.server_close()


if __name__ == '__main__':
    main()
