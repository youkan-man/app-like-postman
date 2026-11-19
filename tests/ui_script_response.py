"""Request/response script effects through native HTTP, Workers and the response UI."""
from __future__ import annotations

from contextlib import contextmanager
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from threading import Thread

from playwright.sync_api import expect, sync_playwright
from test_proxy import proxy, start_server


RECEIVED = []


class ReceiveScriptRequest(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def handle_request(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        record = {'method': self.command, 'path': self.path,
                  'headers': dict(self.headers.items()), 'body': body.decode('utf-8')}
        content_type = self.headers.get('Content-Type', '')
        if content_type.startswith('multipart/form-data'):
            message = BytesParser(policy=default).parsebytes(b'Content-Type: ' + content_type.encode() + b'\r\nMIME-Version: 1.0\r\n\r\n' + body)
            record['parts'] = [{'name': part.get_param('name', header='content-disposition'), 'filename': part.get_filename(),
                                'sha256': hashlib.sha256(part.get_payload(decode=True)).hexdigest()}
                               for part in message.iter_parts()]
        RECEIVED.append(record)
        output = json.dumps(record, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('X-Original', 'received-from-server')
        self.send_header('Content-Length', str(len(output)))
        self.end_headers()
        self.wfile.write(output)

    do_GET = do_POST = do_PUT = do_PATCH = handle_request


READ_WORKSPACE = """() => new Promise((resolve, reject) => {
  const open = indexedDB.open('minipost.workspace.v1', 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result, tx = db.transaction('state');
    const request = tx.objectStore('state').get('workspace');
    tx.oncomplete = () => {db.close(); resolve(JSON.parse(request.result.json));};
    tx.onabort = () => {db.close(); reject(tx.error);};
  };
})"""


def main():
    if os.environ.get('MINIPOST_INLINE_TEST') == '1':
        raise RuntimeError('Script response acceptance requires a real HTTP origin')
    app = None
    url = os.environ.get('MINIPOST_REMOTE_URL')
    if url:
        peer = os.environ['LOCAL_RELAY_VM_BROWSER_IP']
        port = int(os.environ.get('LOCAL_RELAY_VM_BROWSER_PORT') or '18081')
        receiver = ThreadingHTTPServer(('0.0.0.0', port), ReceiveScriptRequest)
        Thread(target=receiver.serve_forever, daemon=True).start()
        target = f'http://{peer}:{port}'
    else:
        receiver, target = start_server(ReceiveScriptRequest)
        app, url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-response-script-'))) / 'script-response'
    out.mkdir(parents=True, exist_ok=True)
    checks, screenshots, errors, dialogs, crashes, proxy_requests = [], [], [], [], [], []
    page = None
    completed = False

    def passed(message):
        checks.append(message)
        print('PASS ' + message, flush=True)

    @contextmanager
    def capture_failure():
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

    before_source = (
        'request.method = "POST";\n'
        'request.url = ' + json.dumps(target + '/wire?stage=before') + ';\n'
        'request.header = [{key:"X-Script-Wire",value:"changed"}, {key:"Content-Type",value:"application/json"}];\n'
        'request.body = {mode:"raw",raw:JSON.stringify({edited:true,label:"日本語"}),options:{raw:{language:"json"}}};'
    )
    after_source = '''const wire = response.json();
response.body = {wire, processed:{label:"加工された値",total:21}, route:"continue"};
response.status = 201;
response.statusText = "Processed";
response.setHeader("X-Processed", "yes");
response.removeHeader("X-Original");
response.content_type = "application/json; charset=utf-8";
response.show("pretty");
store.set("afterEffect", {done:true});
vars.set("afterMarker", "success");'''
    manual_source = '''const previous = response.json();
response.setBody({manual:true,from:previous.processed.label}, "application/json; charset=utf-8");
response.status = 202;
response.setHeader("X-Manual", "yes");
minipost.response.setHeader("X-Alias", "yes");
response.show("raw");
store.set("manualApplied", true);
vars.set("manualApplied", "yes");'''
    html_body = '<h1 id="processed-title">加工したHTML</h1><script>parent.__responseScriptExecuted = true</script>'
    html_source = 'response.setBody(' + json.dumps(html_body) + ', "text/html; charset=utf-8"); response.status = 203; response.show("preview");'
    failure_source = '''response.setBody({partial:"must not commit"}); response.status = 299;
store.set("failedResponseWrite", true); vars.set("failedResponseWrite", "bad");
throw new Error("response failure after edits");'''
    cancellation_source = '''response.setBody({cancelled:"must not commit"}); response.status = 298;
store.set("cancelledResponseWrite", true); vars.set("cancelledResponseWrite", "bad");
console.log("waiting after edits"); await new Promise(() => {});'''
    race_source = '''store.set("staleResponseWrite", true); vars.set("staleResponseWrite", "bad");
console.log("waiting for newer response");
await new Promise(resolve => setTimeout(resolve, 1500));
response.setBody({stale:"must not replace the newer response"}); response.status = 297;'''
    race_values_source = '''store.set("staleDerivedWrite", response.status); vars.set("staleDerivedWrite", response.status);
console.log("waiting for newer response");
await new Promise(resolve => setTimeout(resolve, 1500));'''

    def script(identifier, name, source, timeout=5000):
        return {'id': identifier, 'name': name, 'source': source,
                'input': 'null', 'inputFormat': 'json', 'timeoutMs': timeout}

    def item(identifier, name, path):
        return {'_mpId': identifier, 'name': name, 'request': {'method': 'GET', 'url': target + path,
                'header': [], 'body': {'mode': 'none'}}, 'settings': {}}

    main_request = item('response-main', 'Transform response', '/original')
    main_request['request']['_minipost'] = {'enabled': True, 'before': before_source, 'after': after_source,
        'timeoutMs': 5000, 'extractions': [{'id': 'processed-value', 'name': 'processedLabel',
        'path': '/body/processed/label', 'enabled': True, 'missing': 'keep'}]}
    upload_request = item('response-upload', 'Reorder selected files', '/upload')
    upload_request['request'].update(method='POST', body={'mode': 'formdata', 'formdata': [
        {'key': 'firstFile', 'type': 'file'}, {'key': 'secondFile', 'type': 'file'}]},
        _minipost={'enabled': True, 'before': 'request.body.formdata.reverse();', 'timeoutMs': 5000})

    density_metrics = []

    def step(identifier, request_id):
        return {'id': identifier, 'collectionId': 'response-collection', 'itemId': request_id,
                'repeat': 1, 'delayMs': 0, 'intervalMs': 0,
                'condition': {'enabled': False, 'source': 'response', 'path': '/status', 'operator': 'eq', 'value': '200'},
                'onTrue': '$next', 'onFalse': '$next'}

    first_step = step('response-step-main', 'response-main')
    first_step.update(condition={'enabled': True, 'source': 'response', 'path': '/body/route', 'operator': 'eq', 'value': 'continue'},
                      onTrue='response-step-finish', onFalse='response-step-skip')
    workspace = {'version': 2, 'collections': [{'_mpId': 'response-collection',
        'info': {'name': 'Response scripts', 'schema': 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
        'variable': [], 'item': [main_request, item('response-skip', 'Skipped response', '/skipped'),
                                item('response-finish', 'Finished response', '/finished'), upload_request]}],
        'tabs': [], 'history': [], 'globals': [], 'environments': [], 'environmentId': '', 'scriptData': {},
        'scripts': [script('response-manual', '加工したJSON', manual_source),
                    script('response-html', 'HTMLに変換', html_source),
                    script('response-view', '本文を表示', 'response.show("raw");'),
                    script('response-fail', '失敗する加工', failure_source),
                    script('response-cancel', '停止する加工', cancellation_source, 0),
                    script('response-race', '新しい受信を待つ加工', race_source),
                    script('response-race-values', '新しい受信を待つ変数更新', race_values_source)],
        'relations': [{'id': 'response-relation', 'name': 'Branch on transformed response', 'repeat': 1,
                       'intervalMs': 0, 'maxExecutions': 3, 'stopOnError': True,
                       'steps': [first_step, step('response-step-skip', 'response-skip'), step('response-step-finish', 'response-finish')]}],
        'relationRuns': []}

    try:
        with sync_playwright() as playwright, capture_failure():
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
            page.set_default_timeout(15000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
            page.on('crash', lambda: crashes.append('page crashed'))
            page.on('request', lambda request: proxy_requests.append(request.url) if '/api/request' in request.url else None)

            def ready():
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                expect(page.locator('#saveState')).not_to_have_text('ローカルデータを読込中…')

            def stored():
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
                return page.evaluate(READ_WORKSPACE)

            def primary():
                return page.evaluate("Object.fromEntries(JSON.parse(sessionStorage.getItem('minipost.primary.v1') || '[]').map(row => [row.key, row.value]))")

            def sidebar(name):
                if page.locator('#toggleSidebar').get_attribute('aria-expanded') != 'true':
                    page.locator('#toggleSidebar').click()
                page.locator(f'[data-sidebar="{name}"]').click()

            def choose_main():
                sidebar('collections')
                page.locator('.tree-open').filter(has=page.locator('.tree-label', has_text='Transform response')).first.click()
                expect(page.locator('#requestName')).to_have_value('Transform response')

            def send(status='201'):
                page.locator('#send').click()
                expect(page.locator('#send')).to_contain_text('Send', timeout=30000)
                expect(page.locator('#responseStatus')).to_contain_text(status)

            def body():
                return json.loads(page.locator('#responseContent .response-code').inner_text())

            def menu():
                page.locator('#responseActions').click()

            def run_saved(identifier):
                menu()
                page.get_by_role('menuitem', name='スクリプトを実行', exact=True).click()
                expect(page.locator('#modalTitle')).to_have_text('レスポンスにスクリプトを実行')
                page.get_by_label('実行するスクリプト', exact=True).select_option(identifier)
                page.locator('#modalSubmit').click()
                expect(page.locator('#modal')).not_to_be_visible()

            def restore():
                menu()
                page.get_by_role('menuitem', name='受信時のレスポンスに戻す', exact=True).click()
                expect(page.locator('#responseModified')).to_be_hidden()
                expect(page.locator('#responseStatus')).to_contain_text('200')

            def copied_text():
                # Exercise the native clipboard: paste the app's copy into a
                # temporary textarea rather than replacing clipboard APIs.
                page.locator('#copyResponse').click()
                expect(page.locator('#toast')).to_contain_text('コピーしました。')
                page.evaluate('''() => {
                    const area = document.createElement('textarea'); area.id = 'test-clipboard-target';
                    area.style.cssText = 'position:fixed;inset:10px auto auto 10px;z-index:99999;';
                    document.body.append(area); area.focus();
                }''')
                try:
                    probe = page.locator('#test-clipboard-target')
                    probe.press('Control+v')
                    expect(probe).not_to_have_value('')
                    return probe.input_value()
                finally:
                    page.evaluate("document.getElementById('test-clipboard-target')?.remove()")

            def download():
                with page.expect_download() as pending:
                    page.locator('#downloadResponse').click()
                attachment = pending.value
                return attachment.suggested_filename, Path(attachment.path()).read_bytes()

            def capture(name):
                page.screenshot(path=str(out / (name + '.png')), full_page=True)
                screenshots.append(name + '.png')

            page.goto(url, wait_until='domcontentloaded')
            ready()
            page.locator('#import').click()
            page.get_by_label('インポートJSON', exact=True).fill(json.dumps({'kind': 'minipost.workspace', 'version': 1, 'workspace': workspace}, ensure_ascii=False))
            page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
            with page.expect_navigation(wait_until='domcontentloaded'):
                page.locator('#modalSubmit').click()
            ready()
            choose_main()
            send()
            assert len(RECEIVED) == 1, RECEIVED
            received = RECEIVED[0]
            assert received['method'] == 'POST' and received['path'] == '/wire?stage=before', received
            assert {key.lower(): value for key, value in received['headers'].items()}['x-script-wire'] == 'changed', received
            assert json.loads(received['body']) == {'edited': True, 'label': '日本語'}, received
            passed('pre-send mutations to method, URL, headers and JSON body reach the real HTTP receiver')

            processed = body()
            assert processed == {'wire': received, 'processed': {'label': '加工された値', 'total': 21}, 'route': 'continue'}, processed
            expect(page.locator('#responseModified')).to_be_visible()
            expect(page.locator('#responseStatus')).to_contain_text('Processed')
            expect(page.locator('#response-tab-pretty')).to_have_attribute('aria-selected', 'true')
            assert primary()['processedLabel'] == '加工された値', primary()
            assert primary()['afterMarker'] == 'success'
            assert stored()['scriptData']['afterEffect'] == {'done': True}
            passed('post-receive edits replace the actual body/status and automatic extraction reads processed metadata')

            page.locator('#response-tab-headers').click()
            expect(page.locator('#responseContent')).to_contain_text(re.compile('X-Processed', re.I))
            expect(page.locator('#responseContent')).to_contain_text('application/json; charset=utf-8')
            expect(page.locator('#responseContent')).not_to_contain_text(re.compile('X-Original', re.I))
            page.locator('#response-tab-raw').click()
            assert json.loads(copied_text()) == processed
            filename, downloaded = download()
            assert filename.endswith('.json') and json.loads(downloaded) == processed, (filename, downloaded)
            passed('response header/body views, native clipboard copy and downloaded JSON use the processed response')

            request_count = len(RECEIVED), len(proxy_requests)
            run_saved('response-manual')
            expect(page.locator('#responseStatus')).to_contain_text('202')
            expect(page.locator('#response-tab-raw')).to_have_attribute('aria-selected', 'true')
            manual = {'manual': True, 'from': '加工された値'}
            assert body() == manual
            assert (len(RECEIVED), len(proxy_requests)) == request_count
            assert primary()['manualApplied'] == 'yes'
            assert stored()['scriptData']['manualApplied'] is True
            page.locator('#response-tab-headers').click()
            expect(page.locator('#responseContent')).to_contain_text(re.compile('X-Alias', re.I))
            expect(page.locator('#responseContent')).to_contain_text(re.compile('X-Manual', re.I))
            page.locator('#response-tab-raw').click()
            passed('a saved script edits an already-received response through response/minipost.response without another HTTP request')

            page.locator('#editor-tab-scripts').click()
            page.locator('#script-tab-after').click()
            run_saved('response-fail')
            expect(page.locator('#scriptLog')).to_contain_text('response failure after edits')
            expect(page.locator('#responseStatus')).to_contain_text('202')
            assert body() == manual
            assert 'failedResponseWrite' not in primary()
            assert 'failedResponseWrite' not in stored()['scriptData']
            assert (len(RECEIVED), len(proxy_requests)) == request_count
            passed('a failing response script commits neither edited display/status nor variable/shared-data writes')

            run_saved('response-cancel')
            expect(page.locator('#scriptLog')).to_contain_text('waiting after edits')
            expect(page.locator('#stopRelationGlobal')).to_be_visible()
            page.locator('#stopRelationGlobal').click()
            expect(page.locator('#scriptLog')).to_contain_text('停止')
            expect(page.locator('#stopRelationGlobal')).to_be_hidden()
            expect(page.locator('#responseStatus')).to_contain_text('202')
            assert body() == manual
            assert 'cancelledResponseWrite' not in primary()
            assert 'cancelledResponseWrite' not in stored()['scriptData']
            assert (len(RECEIVED), len(proxy_requests)) == request_count
            passed('Stop after pending mutations preserves the previous response and discards partial script writes')

            run_saved('response-html')
            expect(page.locator('#responseStatus')).to_contain_text('203')
            expect(page.locator('#response-tab-preview')).to_have_attribute('aria-selected', 'true')
            expect(page.frame_locator('#responseContent iframe').locator('#processed-title')).to_have_text('加工したHTML')
            assert page.evaluate('window.__responseScriptExecuted === undefined')
            filename, downloaded = download()
            assert filename.endswith('.html') and downloaded.decode('utf-8') == html_body
            assert (len(RECEIVED), len(proxy_requests)) == request_count
            passed('setBody/content type/show select the transformed HTML preview and matching download')

            page.locator('#editor-tab-params').click()
            if page.locator('#toggleSidebar').get_attribute('aria-expanded') == 'true':
                page.locator('#toggleSidebar').click()
            for width, height in [(1440, 900), (390, 844), (320, 720), (844, 390)]:
                page.set_viewport_size({'width': width, 'height': height})
                expect(page.locator('#responseModified')).to_be_visible()
                expect(page.locator('#responseActions')).to_be_visible()
                page.evaluate('async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }')
                density = page.evaluate('''() => {
                    const request = document.querySelector('.request-editor').getBoundingClientRect();
                    const fields = document.querySelector('.editor-section[data-pane=params]').getBoundingClientRect();
                    return {width:innerWidth,height:innerHeight,requestHeight:request.height,fieldsHeight:fields.height,unusedBelowFields:request.bottom-fields.bottom};
                }''')
                density_metrics.append(density)
                assert 0 <= density['unusedBelowFields'] <= 80, ('empty request fields reserve too much space', density)
                assert density['fieldsHeight'] <= 50, ('empty query controls occupy separate rows', density)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                assert page.locator('.statusbar').evaluate('element => element.getBoundingClientRect().bottom <= innerHeight + 1')
                capture(f'response-transformed-{width}x{height}')
                menu()
                restore_item = page.get_by_role('menuitem', name='受信時のレスポンスに戻す', exact=True)
                expect(restore_item).to_be_visible()
                box = restore_item.bounding_box()
                assert box and box['x'] >= 0 and box['y'] >= 0 and box['x'] + box['width'] <= width + 1 and box['y'] + box['height'] <= height + 1, box
                capture(f'response-menu-{width}x{height}')
                page.keyboard.press('Escape')
            page.set_viewport_size({'width': 1440, 'height': 900})
            passed('processed response, HTML preview and response actions remain usable at desktop, 390 px and 320 px')

            page.evaluate('async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }')
            compact_height = page.locator('.request-editor').bounding_box()['height']
            page.locator('#responseResize').focus()
            page.keyboard.press('End')
            page.locator('#editor-tab-headers').click()
            page.locator('#editor-tab-params').click()
            page.evaluate('async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }')
            assert page.locator('.request-editor').bounding_box()['height'] > compact_height + 80
            page.locator('#responseResize').focus()
            page.keyboard.press('Home')
            passed('empty request fields fit their content until the user explicitly adjusts the split')

            restore()
            page.locator('#response-tab-pretty').click()
            assert body() == received
            page.locator('#response-tab-headers').click()
            expect(page.locator('#responseContent')).to_contain_text(re.compile('X-Original', re.I))
            expect(page.locator('#responseContent')).not_to_contain_text(re.compile('X-Processed', re.I))
            expect(page.locator('#responseContent')).not_to_contain_text(re.compile('X-Manual', re.I))
            assert (len(RECEIVED), len(proxy_requests)) == request_count
            passed('restore returns to the first wire response after multiple transformations without resending')

            run_saved('response-view')
            expect(page.locator('#response-tab-raw')).to_have_attribute('aria-selected', 'true')
            page.locator('#response-tab-pretty').click()
            expect(page.locator('#response-tab-pretty')).to_have_attribute('aria-selected', 'true')
            run_saved('response-view')
            expect(page.locator('#response-tab-raw')).to_have_attribute('aria-selected', 'true')
            expect(page.locator('#responseModified')).to_be_hidden()
            assert body() == received
            assert (len(RECEIVED), len(proxy_requests)) == request_count
            passed('repeating show after manual view selection applies the new presentation once without modifying response bytes')

            page.locator('#editor-tab-scripts').click()
            page.locator('#script-tab-after').click()
            for identifier, variable in [('response-race', 'staleResponseWrite'), ('response-race-values', 'staleDerivedWrite')]:
                run_saved(identifier)
                expect(page.locator('#scriptLog')).to_contain_text('waiting for newer response')
                # The live log is the barrier: send a newer request while old
                # response processing is pending, with and without body edits.
                count = len(RECEIVED), len(proxy_requests)
                send()
                expect(page.locator('#toast')).to_contain_text('実行中にレスポンスが更新されたため')
                expect(page.locator('#stopRelationGlobal')).to_be_hidden()
                expect(page.locator('#responseStatus')).to_contain_text('201')
                assert body() == {'wire': RECEIVED[-1], 'processed': {'label': '加工された値', 'total': 21}, 'route': 'continue'}
                assert (len(RECEIVED), len(proxy_requests)) == (count[0] + 1, count[1] + 1)
                assert variable not in primary()
                assert variable not in stored()['scriptData']
            passed('delayed response processing and variable-only scripts cannot commit after a newer HTTP response')

            sidebar('relations')
            page.locator('[data-relation-id="response-relation"] .tree-open').click()
            count = len(RECEIVED)
            page.locator('#runRelation').click()
            expect(page.locator('#relationRunLog h2')).to_contain_text('完了', timeout=30000)
            run = stored()['relationRuns'][-1]
            assert run['status'] == 'succeeded', run
            assert [entry['requestName'] for entry in run['entries']] == ['Transform response', 'Finished response'], run
            assert run['entries'][0]['httpStatus'] == 201 and run['entries'][0]['branch']['matched'] is True, run
            assert [entry['path'] for entry in RECEIVED[count:]] == ['/wire?stage=before', '/finished'], RECEIVED[count:]
            passed('relation decisions and recorded status use the transformed response, skipping the unmatched request')

            choose_main()
            page.locator('#editor-tab-scripts').click()
            page.locator('#script-tab-after').click()
            page.get_by_label('受信後スクリプト', exact=True).fill(failure_source)
            send('200')
            expect(page.locator('#automationError')).to_contain_text('response failure after edits')
            expect(page.locator('#responseModified')).to_be_hidden()
            page.locator('#response-tab-pretty').click()
            assert body() == RECEIVED[-1]
            assert 'failedResponseWrite' not in primary()
            assert 'failedResponseWrite' not in stored()['scriptData']
            passed('a failed automatic post-hook preserves the received body/status and reports its error without partial writes')

            page.get_by_label('受信後スクリプト', exact=True).fill(cancellation_source)
            page.get_by_label('スクリプト制限時間', exact=True).fill('0')
            page.locator('#send').click()
            expect(page.locator('#scriptLog')).to_contain_text('waiting after edits')
            expect(page.locator('#send')).to_contain_text('Cancel')
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_have_text('CANCELLED')
            expect(page.locator('#responseModified')).to_be_hidden()
            assert 'cancelledResponseWrite' not in primary()
            assert 'cancelledResponseWrite' not in stored()['scriptData']
            passed('cancelling an automatic post-hook after mutation never commits its response or shared-data writes')

            sidebar('collections')
            page.locator('.tree-open').filter(has=page.locator('.tree-label', has_text='Reorder selected files')).first.click()
            expect(page.locator('#requestName')).to_have_value('Reorder selected files')
            page.locator('#editor-tab-body').click()
            first_bytes, second_bytes = b'first selected file bytes', b'second selected file bytes'
            for index, name, content in [(0, 'first.txt', first_bytes), (1, 'second.txt', second_bytes)]:
                with page.expect_file_chooser() as picker:
                    page.locator(f'[data-file-slot="form-{index}"] .file-pick').click()
                picker.value.set_files({'name': name, 'mimeType': 'text/plain', 'buffer': content})
                expect(page.locator(f'[data-file-slot="form-{index}"] .file-pick')).to_have_text(name)
                expect(page.locator(f'[data-file-slot="form-{index}"] .file-pick')).to_have_attribute('aria-busy', 'false')
            expected_parts = [
                {'name': 'secondFile', 'filename': 'second.txt', 'sha256': hashlib.sha256(second_bytes).hexdigest()},
                {'name': 'firstFile', 'filename': 'first.txt', 'sha256': hashlib.sha256(first_bytes).hexdigest()}]
            send('200')
            assert RECEIVED[-1]['parts'] == expected_parts, RECEIVED[-1]
            expect(page.locator('[data-file-slot="form-0"] .file-pick')).to_have_text('first.txt')
            expect(page.locator('[data-file-slot="form-1"] .file-pick')).to_have_text('second.txt')
            passed('automatic form-data row reordering sends the corresponding selected bytes while preserving editor selections')

            page.locator('#editor-tab-scripts').click()
            page.locator('#script-tab-before').click()
            page.locator('#script-panel-before').get_by_role('button', name='このスクリプトを実行', exact=True).click()
            page.locator('#editor-tab-body').click()
            expect(page.locator('[data-file-slot="form-0"] .file-pick')).to_have_text('second.txt')
            expect(page.locator('[data-file-slot="form-1"] .file-pick')).to_have_text('first.txt')
            page.locator('#editor-tab-scripts').click()
            page.get_by_label('送信前スクリプト', exact=True).fill('')
            send('200')
            assert RECEIVED[-1]['parts'] == expected_parts, RECEIVED[-1]
            page.locator('#editor-tab-body').click()
            capture('script-reordered-files-desktop')
            passed('manually applying a form-data script moves live file selections with their rows and preserves receiver hashes')

            assert not errors, errors
            assert not dialogs, dialogs
            assert not crashes, crashes
            passed('native response editing produces no uncaught JavaScript errors, browser dialogs or crashes')
            completed = True
            browser.close()
    finally:
        (out / 'results.json').write_text(json.dumps({'ok': completed, 'mode': 'native Chromium HTTP',
            'checks': checks, 'screenshots': screenshots, 'density_metrics': density_metrics, 'page_errors': errors, 'native_dialogs': dialogs,
            'crashes': crashes, 'http_requests': RECEIVED, 'proxy_request_count': len(proxy_requests)}, ensure_ascii=False, indent=2))
        for server in [app, receiver]:
            if server:
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    main()
