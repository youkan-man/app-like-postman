"""Workspace transactions and API tools in the real isolated script Worker.

Author scripts through the UI, send HTTP to the peer VM, and inspect only
committed IndexedDB state. No runtime or browser-storage implementation mocks.
"""
from __future__ import annotations

from contextlib import contextmanager
from http.server import ThreadingHTTPServer
import json
from relation_ui_helpers import relations
import os
from pathlib import Path
import re
import shutil
import tempfile
from threading import Thread
from urllib.parse import parse_qsl, urlsplit

from playwright.sync_api import expect, sync_playwright
from test_proxy import EchoHandler, proxy, start_server
from ui_standalone_scripts import READ_WORKSPACE


def main():
    if os.environ.get('MINIPOST_INLINE_TEST') == '1':
        raise RuntimeError('Workspace API acceptance requires a real HTTP origin')
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
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-workspace-api-'))) / 'script-workspace-api'
    out.mkdir(parents=True, exist_ok=True)
    checks, screenshots, errors, dialogs, crashes, requests = [], [], [], [], [], []
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

    workspace = {
        'version': 2, 'collections': [{'_mpId': 'api-c', 'info': {'name': 'API workspace',
            'schema': 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
            'variable': [], 'item': [{'_mpId': 'api-request', 'name': 'Echo request',
                'request': {'method': 'GET', 'url': '{{baseUrl}}/echo', 'header': [], 'body': {'mode': 'none'}},
                'settings': {'timeout_ms': 10000}}]}],
        'tabs': [], 'history': [], 'globals': [
            {'key': 'duplicate', 'value': 'first', 'enabled': True},
            {'key': 'duplicate', 'value': 'last', 'enabled': True},
            {'key': 'disabled', 'value': 'off', 'disabled': True},
            {'key': 'inactive', 'value': 'untouched', 'enabled': False},
            {'key': '', 'value': 'blank'}], 'environmentId': 'api-env',
        'environments': [{'id': 'api-env', 'name': 'API environment', 'values': [
            {'key': 'baseUrl', 'value': receiver_url, 'enabled': True},
            {'key': 'duplicate', 'value': 'first', 'enabled': True},
            {'key': 'duplicate', 'value': 'last', 'enabled': True},
            {'key': 'disabled', 'value': 'off', 'disabled': True},
            {'key': 'inactive', 'value': 'untouched', 'enabled': False},
            {'key': '', 'value': 'blank'}]}],
        'scripts': [{'id': 'api-main', 'name': 'API操作', 'source': '', 'input': json.dumps({'baseUrl': receiver_url}),
                     'inputFormat': 'json', 'timeoutMs': 0}],
        'scriptData': {}, 'relations': [], 'relationRuns': [], 'theme': 'light',
    }

    try:
        with sync_playwright() as playwright, capture_failure():
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM') or shutil.which('chromium'),
                                                  headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
            page.set_default_timeout(15000)
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

            def sidebar(name):
                if page.locator('#toggleSidebar').get_attribute('aria-expanded') != 'true':
                    page.locator('#toggleSidebar').click()
                page.locator(f'[data-sidebar="{name}"]').click()

            def open_script():
                sidebar('scripts')
                page.locator('[data-script-id="api-main"] .tree-open').click()
                expect(page.locator('.scripts-page')).to_be_visible()

            def edit(source):
                page.get_by_label('スクリプトのコード', exact=True).fill(source)

            def run(state='success'):
                page.locator('#runStandaloneScript').click()
                try:
                    expect(page.locator('#standaloneScriptStatus')).to_have_attribute('data-state', state)
                except AssertionError as error:
                    raise AssertionError('Script outcome: ' + page.locator('#standaloneScriptResult').inner_text()
                                         + '\n' + page.locator('#standaloneScriptLog').inner_text()) from error

            def result():
                return json.loads(page.locator('#standaloneScriptResult').inner_text())

            def capture(name):
                page.screenshot(path=str(out / (name + '.png')), full_page=True)
                screenshots.append(name + '.png')

            page.goto(url, wait_until='domcontentloaded')
            ready()
            page.locator('#import').click()
            page.get_by_label('インポートJSON', exact=True).fill(json.dumps(
                {'kind': 'minipost.workspace', 'version': 1, 'workspace': workspace}, ensure_ascii=False))
            page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
            with page.expect_navigation(wait_until='domcontentloaded'):
                page.locator('#modalSubmit').click()
            ready()
            open_script()

            edit("""
const data = {items: [{name: '日本語', count: 0}, {name: 'b,c', count: 2}]};
const csv = tools.csv.stringify(data.items, {header: true});
const encoded = tools.encoding.base64.encode('日本語😀');
return {
  hash: await tools.crypto.hash('abc'),
  hmac: await tools.crypto.hmac('key', 'The quick brown fox jumps over the lazy dog'),
  uuid: tools.crypto.uuid(), sameTools: tools === minipost.tools,
  decoded: tools.encoding.base64.decode(encoded),
  csv: tools.csv.parse(csv, {header: true}),
  selected: tools.json.select(data, '/items/*/name'),
  query: tools.query.parse('x=1&x=2&flag=false'),
  cookies: tools.cookies.parse('mode=dark; label=%E6%97%A5%E6%9C%AC%E8%AA%9E'),
  dom: typeof document
};
""")
            run()
            value = result()
            assert value['hash'] == 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', value
            assert value['hmac'] == 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8', value
            assert re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', value['uuid'])
            assert value['decoded'] == '日本語😀' and value['sameTools'] and value['dom'] == 'undefined'
            assert value['csv'] == [{'name': '日本語', 'count': '0'}, {'name': 'b,c', 'count': '2'}]
            assert value['selected'] == [{'path': '/items/0/name', 'value': '日本語'}, {'path': '/items/1/name', 'value': 'b,c'}]
            assert [(row['key'], row['value']) for row in value['query']] == [('x', '1'), ('x', '2'), ('flag', 'false')]
            assert value['cookies'] == {'mode': 'dark', 'label': '日本語'}
            assert not requests
            passed('real isolated Worker supports SHA256, HMAC, UUID, Unicode encoding, CSV, JSON selection and duplicate query parsing on the HTTP origin')

            edit("""
const original = {items:[{id:1},{id:2}],mode:'draft'};
const changes = [
  {op:'add',path:'/items/1',value:{id:3}},
  {op:'move',from:'/mode',path:'/state'},
  {op:'copy',from:'/items/0',path:'/first'},
  {op:'test',path:'/state',value:'draft'}
];
const patched = tools.json.patch(original,changes);
let rejected = false;
try { tools.json.patch(original,[{op:'replace',path:'/mode',value:'changed'},{op:'remove',path:'/missing'}]); }
catch { rejected = true; }
return {original,patched,rejected,roundTrip:tools.json.patch(original,tools.json.diff(original,patched))};
""")
            run()
            value = result()
            original = {'items': [{'id': 1}, {'id': 2}], 'mode': 'draft'}
            patched = {'items': [{'id': 1}, {'id': 3}, {'id': 2}], 'state': 'draft', 'first': {'id': 1}}
            assert value == {'original': original, 'patched': patched, 'rejected': True, 'roundTrip': patched}, value
            passed('JSON Patch runs in the isolated Worker, applies array insertion and move/copy/test, round-trips diffs and leaves its input intact on failure')

            edit("""
const part = value => tools.encoding.base64.encode(JSON.stringify(value),{urlSafe:true});
const header = part({alg:'HS256',typ:'JWT'});
const payload = part({sub:'user-1',name:'日本語',roles:['read','write']});
const token = `${header}.${payload}.AA`;
return {jwt:tools.jwt.decode(`Bearer ${token}`),signingInput:`${header}.${payload}`,
  cookies:tools.cookies.parse('discount=50%; quoted="hello%20world"; label=%E6%97%A5%E6%9C%AC%E8%AA%9E'),
  raw:tools.cookies.parse('label=%E6%97%A5%E6%9C%AC%E8%AA%9E',{decode:false}),
  setCookie:tools.cookies.parseSetCookie('discount=50%; Path=/; HttpOnly')};
""")
            run()
            value = result()
            assert value['jwt'] == {'header': {'alg': 'HS256', 'typ': 'JWT'},
                                    'payload': {'sub': 'user-1', 'name': '日本語', 'roles': ['read', 'write']},
                                    'signature': 'AA', 'signingInput': value['signingInput']}, value
            assert value['cookies'] == {'discount': '50%', 'quoted': 'hello world', 'label': '日本語'}
            assert value['raw'] == {'label': '%E6%97%A5%E6%9C%AC%E8%AA%9E'}
            assert value['setCookie'] == {'name': 'discount', 'value': '50%', 'attributes': {'path': '/', 'httponly': True}}
            passed('JWT inspection reads Bearer token Unicode claims and Cookie parsing preserves opaque percent values with optional raw decoding')

            edit("vars.set('primaryLive','on'); vars.set('primaryDisabled','off'); vars.set('primaryRevived','off'); return true;")
            run()
            sidebar('environments')
            page.locator('[data-scope="primary"] .tree-open').click()
            page.get_by_label('行 2 を有効にする', exact=True).uncheck()
            page.get_by_label('行 3 を有効にする', exact=True).uncheck()
            open_script()
            edit("""
pm.environment.set('duplicate','env-updated');
minipost.environments.variables('api-env').set('disabled','env-reenabled');
pm.globals.set('duplicate','global-updated');
pm.globals.set('disabled','global-reenabled');
vars.set('primaryRevived','primary-reenabled');
const effective={environment:pm.environment.get('duplicate'),inherited:vars.get('duplicate'),
  disabledEnvironment:pm.environment.get('disabled'),global:pm.globals.get('duplicate'),
  disabledGlobal:pm.globals.get('disabled'),primary:vars.get('primaryRevived')};
const removed={environment:pm.environment.clear(),global:pm.globals.clear(),primary:vars.clear()};
pm.environment.set('baseUrl',input.baseUrl);
return {effective,removed,environmentRows:minipost.environments.get('api-env').values,globalRows:pm.globals.list()};
""")
            run()
            value = result()
            assert value['effective'] == {'environment': 'env-updated', 'inherited': 'env-updated',
                                          'disabledEnvironment': 'env-reenabled', 'global': 'global-updated',
                                          'disabledGlobal': 'global-reenabled', 'primary': 'primary-reenabled'}, value
            assert value['removed'] == {'environment': 6, 'global': 5, 'primary': 3}, value
            assert value['environmentRows'] == [{'key': 'baseUrl', 'value': receiver_url, 'enabled': True}]
            assert value['globalRows'] == []
            durable = saved()
            assert durable['globals'] == [] and durable['environments'][0]['values'] == value['environmentRows']
            assert page.evaluate("JSON.parse(sessionStorage.getItem('minipost.primary.v1') || '[]')") == []
            passed('variable setters update the effective duplicate and reactivate disabled rows; clear removes every environment, global and primary row including inactive or blank entries')

            edit("vars.set('nestedHidden','original'); return true;")
            run()
            sidebar('environments')
            page.locator('[data-scope="primary"] .tree-open').click()
            page.get_by_label('行 1 を有効にする', exact=True).uncheck()
            open_script()
            edit("""
const child=minipost.scripts.create({name:'Clear nested variables',source:
  "const wasVisible=vars.has('nestedHidden'); const count=vars.clear(); store.set('nestedClear',{wasVisible,count});"});
const relation=minipost.relations.create({name:'Nested variable scope',steps:[
  {id:'restore-disabled-binding',type:'forEach',source:'literal',value:'[1,2]',itemVariable:'nestedHidden',indexVariable:'loopIndex',intervalMs:0,
   steps:[{id:'binding-wait',type:'wait',delayMs:0}]},
  {id:'clear-nested-rows',type:'script',scriptId:child.id}
]});
await minipost.relations.run(relation.id);
minipost.relations.delete(relation.id);minipost.scripts.delete(child.id);
return store.get('nestedClear');
""")
            run()
            assert result() == {'wasVisible': False, 'count': 1}
            assert page.evaluate("JSON.parse(sessionStorage.getItem('minipost.primary.v1') || '[]')") == []
            passed('the real Worker bridge retains disabled primary rows through a script-invoked loop and nested clear without committing temporary loop bindings')

            edit("""
const url=tools.url.build(input.baseUrl+'/echo',{query:{space:'a b',plus:'a+b'}});
const request = tools.request.build({method:'POST',url,
  query:{tag:['a','b'],extra:'雪 空'},headers:{'X-Helper':'yes'},json:{message:'日本語',enabled:false},bearer:'test-token'});
const response = await minipost.requests.send(request);
return {status:response.status,body:response.body};
""")
            run()
            value = result()
            assert value['status'] == 200 and value['body']['method'] == 'POST', value
            wire_url = urlsplit(value['body']['path'])
            assert wire_url.path == '/echo'
            assert parse_qsl(wire_url.query) == [('space', 'a b'), ('plus', 'a+b'), ('tag', 'a'), ('tag', 'b'), ('extra', '雪 空')]
            assert json.loads(value['body']['body']) == {'message': '日本語', 'enabled': False}
            wire_headers = {key.lower(): val for key, val in value['body']['headers']}
            assert wire_headers['authorization'] == 'Bearer test-token' and wire_headers['x-helper'] == 'yes'
            assert wire_headers['content-type'] == 'application/json'
            assert len(requests) == 1
            passed('URL and request builders preserve spaces, literal plus, Unicode and duplicate query values with JSON and authentication over real HTTP')

            edit("""
const collection=minipost.collections.create({name:'Generated API'});
const folder=minipost.folders.create({name:'Operations',parent:collection.id});
minipost.collections.variables(collection.id).set('scope','collection');
minipost.folders.variables(folder.id).set('scope','folder');
const request=minipost.requests.create({name:'Generated request',parent:folder.id,
  request:tools.request.build({method:'GET',url:input.baseUrl+'/echo',query:{scope:'{{scope}}'}})});
const environment=minipost.environments.create({name:'Generated environment',values:[{key:'mode',value:'test'}]});
minipost.environments.variables(environment.id).set('other','present');
const draft=minipost.drafts.create({name:'Generated draft',request:{method:'POST',url:input.baseUrl+'/echo',body:{mode:'file'}}});
const child=minipost.scripts.create({name:'Read pending values',source:
  "store.set('childSaw',minipost.requests.get(input.request).name); return minipost.collections.variables(input.collection).get('scope');"});
const seen=await scripts.run(child.id,{request:request.id,collection:collection.id});
const relation=minipost.relations.create({name:'Generated relation',steps:[{id:'generated-wait',type:'wait',delayMs:0}]});
const definitions=minipost.ribbons.forRequest(request.id);
const ribbon=definitions.create({key:'api',name:'API controls'});
const group=definitions.groups(ribbon.id).create({name:'Run'});
const control=definitions.controls(ribbon.id,group.id).create({key:'count',type:'number',label:'Count',value:3});
definitions.controls(ribbon.id,group.id).update(control.id,{value:4});
minipost.settings.update({theme:'dark'});
const ids={collection:collection.id,folder:folder.id,request:request.id,environment:environment.id,
  draft:draft.id,draftId:draft.draftId,child:child.id,relation:relation.id,ribbon:ribbon.id,group:group.id,control:control.id};
store.set('created',ids);
return {ids,seen,childSaw:store.get('childSaw'),scope:minipost.folders.variables(folder.id).get('scope'),
  count:definitions.controls(ribbon.id,group.id).get(control.id).value};
""")
            run()
            value = result()
            ids = value['ids']
            assert value['seen'] == 'collection' and value['childSaw'] == 'Generated request'
            assert value['scope'] == 'folder' and value['count'] == 4
            durable = saved()
            generated = next(c for c in durable['collections'] if c['_mpId'] == ids['collection'])
            created_request = generated['item'][0]['item'][0]
            assert created_request['name'] == 'Generated request'
            assert created_request['ribbonState']['ribbons'][0]['groups'][0]['controls'][0]['value'] == 4
            assert any(s['id'] == ids['child'] for s in durable['scripts'])
            assert any(r['id'] == ids['relation'] for r in relations(durable))
            assert any(t['id'] == ids['draftId'] for t in durable['tabs'])
            expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
            passed('synchronous model APIs create collections, folders, requests, drafts, environments, scripts, relations and ribbon definitions in one committed transaction')
            passed('child scripts read pending creations and scoped variables before commit; workspace settings update the live UI')

            edit("""
const ids=store.get('created');minipost.settings.update({theme:'light'});
const response=await minipost.requests.send(ids.request);
const clone=minipost.requests.clone(ids.request,{name:'Cloned request',parent:'api-c'});
const moved=minipost.requests.move(clone.id,ids.folder);
minipost.requests.update(moved.id,{name:'Moved request'});
store.set('moved',moved.id);
return {path:response.body.path,moved:minipost.requests.get(moved.id).path,
  inherited:minipost.folders.variables(ids.folder).toObject(),responses:(await minipost.responses.list()).length};
""")
            run()
            value = result()
            assert value['path'] == '/echo?scope=folder', value
            assert value['moved'] == 'Generated API / Operations / Moved request'
            assert value['inherited']['scope'] == 'folder' and value['responses'] >= 1
            expect(page.locator('html')).to_have_attribute('data-theme', 'light')
            passed('send uses staged tree scope and clone/move/update preserve usable request identities across collections')

            sidebar('collections')
            page.locator('[data-item-id="api-request"] .tree-open').click()
            expect(page.locator('#url')).to_have_value('{{baseUrl}}/echo')
            open_script()
            edit("minipost.requests.update('api-c:api-request',{request:{url:input.baseUrl+'/echo?updated=yes'}}); return minipost.requests.get('api-c:api-request').request.url;")
            run()
            sidebar('collections')
            page.locator('[data-item-id="api-request"] .tree-open').click()
            expect(page.locator('#url')).to_have_value(receiver_url + '/echo?updated=yes')
            passed('script edits refresh an already open saved request instead of leaving its cached editor stale')
            open_script()

            edit("""
const ids=store.get('created');
const child=minipost.scripts.create({name:'Count loop',source:
  "store.set('loopCount',(store.get('loopCount')||0)+1); vars.set('lastLoopItem',vars.get('item')); return store.get('loopCount');"});
const relation=minipost.relations.create({name:'Script loop',steps:[{
  id:'native-array-loop',type:'forEach',source:'literal',value:'[10,20,30]',itemVariable:'item',indexVariable:'index',intervalMs:0,
  steps:[{id:'native-loop-script',type:'script',scriptId:child.id,inputFormat:'saved',input:'null',resultVariable:'loopResult'}]
}]});
vars.set('item','outer');
const result=await minipost.relations.run(relation.id);
store.set('scriptLoop',relation.id);
return {status:result.status,entries:result.entries.length,count:store.get('loopCount'),
  item:vars.get('item'),last:vars.get('lastLoopItem'),result:vars.get('loopResult')};
""")
            run()
            assert result() == {'status': 'succeeded', 'entries': 3, 'count': 3, 'item': 'outer', 'last': '30', 'result': '3'}
            assert any(r['relationId'] == saved()['scriptData']['scriptLoop'] for r in saved()['relationRuns'])
            passed('scripts execute a newly created array relation with isolated child scripts, pending data visibility and restored outer loop variables')

            before = saved()
            edit("minipost.collections.create({name:'Must roll back'}); minipost.drafts.update(store.get('created').draft,{name:'Must roll back'}); store.set('failedTransaction',true); throw new Error('intentional rollback');")
            run('error')
            after = saved()
            assert after['collections'] == before['collections'] and after['tabs'] == before['tabs']
            assert 'failedTransaction' not in after['scriptData']
            passed('an exception discards the whole workspace transaction including creations, edits and shared data')

            edit("minipost.collections.create({name:'Cancelled collection'}); store.set('cancelledTransaction',true); console.log('waiting for stop'); await tools.flow.delay(60000);")
            page.locator('#runStandaloneScript').click()
            expect(page.locator('#standaloneScriptLog')).to_contain_text('waiting for stop')
            page.locator('#stopStandaloneScript').click()
            expect(page.locator('#standaloneScriptStatus')).to_have_attribute('data-state', 'stopped')
            after = saved()
            assert not any(c['info']['name'] == 'Cancelled collection' for c in after['collections'])
            assert 'cancelledTransaction' not in after['scriptData']
            passed('stopping asynchronous helper work terminates the Worker and discards pending model edits')

            edit("minipost.scripts.update('api-main',{name:'Stale script name'}); store.set('conflictWrite',true); console.log('waiting for edit'); await tools.flow.delay(2500);")
            page.locator('#runStandaloneScript').click()
            expect(page.locator('#standaloneScriptLog')).to_contain_text('waiting for edit')
            page.locator('.scripts-page').get_by_label('スクリプト名', exact=True).fill('Manual script name')
            expect(page.locator('#standaloneScriptStatus')).to_have_attribute('data-state', 'error')
            expect(page.locator('#standaloneScriptResult')).to_contain_text('同じ項目')
            after = saved()
            assert next(s['name'] for s in after['scripts'] if s['id'] == 'api-main') == 'Manual script name'
            assert 'conflictWrite' not in after['scriptData']
            passed('a conflicting manual edit wins and rejects all script writes without silently replacing it')

            edit("minipost.collections.update('api-c',{info:{description:'Concurrent change preserved'}}); console.log('waiting for unrelated edit'); await tools.flow.delay(2500); return true;")
            page.locator('#runStandaloneScript').click()
            expect(page.locator('#standaloneScriptLog')).to_contain_text('waiting for unrelated edit')
            page.locator('.scripts-page').get_by_label('スクリプト名', exact=True).fill('API操作')
            expect(page.locator('#standaloneScriptStatus')).to_have_attribute('data-state', 'success')
            after = saved()
            assert next(c['info']['description'] for c in after['collections'] if c['_mpId'] == 'api-c') == 'Concurrent change preserved'
            assert next(s['name'] for s in after['scripts'] if s['id'] == 'api-main') == 'API操作'
            expect(page.locator('.scripts-page').get_by_label('スクリプト名', exact=True)).to_be_focused()
            assert page.locator('.scripts-page').get_by_label('スクリプト名', exact=True).evaluate('(node)=>node.selectionStart') == len('API操作')
            passed('field-level commits preserve unrelated edits, keyboard focus and caret while the script is running')

            edit("await minipost.requests.send('api-c:api-request'); const moved=minipost.requests.move('api-c:api-request',store.get('created').folder); store.set('movedEcho',moved.id); return moved.id;")
            run()
            moved_echo = page.locator('#standaloneScriptResult').inner_text()
            assert moved_echo == ids['collection'] + ':api-request'
            edit("const response=await minipost.responses.get(store.get('movedEcho')); return {requestId:response.requestId,status:response.response.status,path:response.response.body.path};")
            run()
            assert result() == {'requestId': moved_echo, 'status': 200, 'path': '/echo?updated=yes'}
            passed('moving a received request preserves its response identity for subsequent extraction and script access')

            sidebar('collections')
            page.locator(f'[data-draft-id="{ids["draftId"]}"] .tree-open').click()
            page.locator('[data-editor="body"]').click()
            with page.expect_file_chooser() as chooser:
                page.get_by_role('button', name='ファイルを選択', exact=True).click()
            chooser.value.set_files({'name': 'api-payload.txt', 'mimeType': 'text/plain', 'buffer': '日本語\nAPI'.encode()})
            expect(page.locator('#request-fields-body')).to_contain_text('api-payload.txt')
            open_script()
            edit("const ref=store.get('created').draft; const files=await minipost.attachments.list(ref); return {files,text:await minipost.attachments.read(ref,'binary',0,{format:'text'}),bytes:await minipost.attachments.read(ref,'binary',0,{format:'bytes'})};")
            run()
            value = result()
            assert value['files'][0]['name'] == 'api-payload.txt' and value['text'] == '日本語\nAPI'
            assert bytes(value['bytes']) == '日本語\nAPI'.encode()
            assert 'blob' not in json.dumps(saved()['tabs']) and 'api-payload.txt' in json.dumps(saved()['tabs'])
            passed('scripts read selected attachment metadata and exact bytes without embedding file contents in workspace storage')

            edit("const history=minipost.history.list(); const first=minipost.history.get(history[0].id); minipost.history.delete(first.id); minipost.requests.delete(store.get('moved')); minipost.relations.delete(store.get('created').relation); minipost.environments.delete(store.get('created').environment); return {before:history.length,after:minipost.history.list().length,exists:minipost.requests.list().some(r=>r.name==='Moved request')};")
            run()
            value = result()
            assert value['after'] == value['before'] - 1 and value['exists'] is False
            after = saved()
            assert not any(r['id'] == ids['relation'] for r in relations(after))
            assert not any(e['id'] == ids['environment'] for e in after['environments'])
            passed('history and model deletion APIs remove only their explicitly selected entries')

            edit("""
const created=minipost.requests.create({name:'Editable request',parent:store.get('created').collection,
  request:{method:'GET',url:input.baseUrl+'/echo?keep=a%2Bb&tag=old',
    header:[{key:'X-Disabled',value:'kept',disabled:true}],body:{mode:'none'}}});
store.set('editableRequest',created.id);
const target=minipost.requests.edit(created.id);
target.set('method','POST');
target.query.set('tag',['日本語','a+b']);
target.query.set('page',2);
target.headers.set('X-Token','first');
target.headers.set('x-token','updated');
target.json.set({user:{name:'before'},items:[{count:0}],enabled:false,nullable:null,temporary:true});
target.json.set('user.name','日本語');
target.json.set(['items',0,'count'],3);
target.json.delete('temporary');
const child=minipost.scripts.create({name:'Edit request child',source:
  "const target=minipost.requests.edit(input); target.json.set('child',target.query.get('page')); return target.headers.get('X-TOKEN');"});
const childValue=await scripts.run(child.id,created.id);
const snapshot=minipost.requests.get(created.id);
snapshot.name='Edited request';
minipost.requests.set(created.id,snapshot);
minipost.requests.set(created.id,'settings.timeout_ms',12000);
minipost.settings.set('settings.timeout_ms',15000);
const collection=minipost.collections.get(store.get('created').collection);
collection.name='Generated API edited';
minipost.collections.set(collection.id,collection);
let identityRejected=false;
try { minipost.requests.set(created.id,{...minipost.requests.get(created.id),id:'changed-id'}); }
catch { identityRejected=true; }
const response=await minipost.requests.send(created.id);
return {wire:response.body,childValue,identityRejected,url:target.get('url'),
  page:target.query.get('page'),tags:target.query.getAll('tag'),json:target.json.get(),
  token:target.headers.get('X-Token'),name:minipost.requests.get(created.id,'name'),
  timeout:minipost.requests.get(created.id,'settings.timeout_ms'),
  setting:minipost.settings.get('settings.timeout_ms'),
  collection:minipost.collections.get(collection.id,'info.name')};
""")
            run()
            value = result()
            assert value['wire']['method'] == 'POST', value
            assert parse_qsl(urlsplit(value['wire']['path']).query) == [
                ('keep', 'a+b'), ('tag', '日本語'), ('tag', 'a+b'), ('page', '2')], value
            expected_body = {'user': {'name': '日本語'}, 'items': [{'count': 3}],
                             'enabled': False, 'nullable': None, 'child': '2'}
            assert json.loads(value['wire']['body']) == expected_body == value['json'], value
            headers = {key.lower(): val for key, val in value['wire']['headers']}
            assert headers['x-token'] == 'updated' and 'x-disabled' not in headers, headers
            assert headers['content-type'] == 'application/json', headers
            assert value['childValue'] == value['token'] == 'updated' and value['identityRejected'], value
            assert value['page'] == '2' and value['tags'] == ['日本語', 'a+b'], value
            assert value['name'] == 'Edited request' and value['collection'] == 'Generated API edited', value
            assert value['timeout'] == 12000 and value['setting'] == 15000, value
            assert urlsplit(value['url']).path == '/echo', value
            capture('request-editing-desktop')
            passed('saved request editors use matching get/set operations for fields, named headers, repeated queries and JSON paths; child scripts and real HTTP observe pending edits')
            passed('entity snapshots and nested settings use the same get/set selectors, retain identity and accept an edited collection name alias')

            before = saved()
            edit("const target=minipost.requests.edit(store.get('editableRequest')); target.query.set('page',99); target.json.set('user.name','rollback'); throw new Error('request rollback');")
            run('error')
            assert saved()['collections'] == before['collections']
            passed('a failed request-editing script leaves saved request fields, headers, query and body unchanged')

            edit("""
const id=store.get('editableRequest'), target=minipost.requests.edit(id);
target.form.set('tag',['one','two']);
target.form.set('enabled',false);
target.form.set('a.b','雪 空+');
const response=await minipost.requests.send(id);
return {wire:response.body,tags:target.form.getAll('tag'),enabled:target.form.get('enabled'),value:target.form.get('a.b')};
""")
            run()
            value = result()
            assert parse_qsl(value['wire']['body']) == [('tag', 'one'), ('tag', 'two'), ('enabled', 'false'), ('a.b', '雪 空+')], value
            headers = {key.lower(): val for key, val in value['wire']['headers']}
            assert headers['content-type'].startswith('application/x-www-form-urlencoded'), headers
            assert value['tags'] == ['one', 'two'] and value['enabled'] == 'false' and value['value'] == '雪 空+', value
            passed('named form get/set edits send repeated values, booleans, literal dotted keys and Unicode with the correct content type')

            durable = saved()
            page.reload(wait_until='domcontentloaded')
            ready()
            open_script()
            reloaded = saved()
            for key in ['collections', 'environments', 'tabs', 'relations', 'relationRuns', 'scriptData']:
                assert reloaded[key] == durable[key], key
            passed('native IndexedDB reload preserves created structures, loop runs and typed shared data')

            for source, expected in [('minipost.collections.', 'create'), ('tools.crypto.', 'hmac'),
                                     ('tools.json.', 'patch'), ('tools.jwt.', 'decode'),
                                     ('minipost.requests.', 'set'),
                                     ('minipost.requests.edit("Edited request").headers.', 'set'),
                                     ('minipost.requests.edit("Edited request").query.', 'get'),
                                     ('minipost.requests.edit("Edited request").json.', 'set')]:
                area = page.get_by_label('スクリプトのコード', exact=True)
                area.fill(source)
                area.press('End')
                area.press('Control+Space')
                editor = page.locator('.standalone-script-code .source-editor')
                expect(editor).to_have_attribute('data-intelligence', 'ready', timeout=20000)
                expect(editor.locator('.source-suggestions').get_by_role('option', name=expected, exact=True)).to_be_attached()
                area.press('Escape')
            passed('the actual language Worker offers workspace get/set, request header/query/JSON editors and API helper methods')

            edit("return {sha256:await tools.crypto.hash('abc'), requests:minipost.requests.list().length};")
            run()
            capture('workspace-api-desktop')
            page.get_by_role('button', name='スクリプトの操作', exact=True).click()
            page.get_by_role('menuitem', name='APIリファレンス', exact=True).click()
            search = page.get_by_label('APIを検索', exact=True)
            search.fill('crypto.hmac')
            expect(page.locator('#scriptApiResults')).to_contain_text('crypto.hmac')
            assert page.locator('#scriptApiResults .script-api-entry').count() > 0
            expect(page.locator('#modal .dialog-footer')).not_to_be_visible()
            expect(page.locator('#closeModal')).to_be_visible()
            capture('api-reference-desktop')
            page.set_viewport_size({'width': 320, 'height': 720})
            expect(search).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            bounds = search.bounding_box()
            assert bounds and bounds['width'] >= 150, bounds
            expect(page.locator('#modal .dialog-footer')).not_to_be_visible()
            expect(page.locator('#closeModal')).to_be_visible()
            capture('api-reference-320')
            search.fill('request.headers')
            expect(page.locator('#scriptApiResults')).to_contain_text('request.headers.get')
            expect(page.locator('#scriptApiResults')).to_contain_text('request.headers.set')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert page.locator('#scriptApiResults').evaluate('(node)=>node.scrollWidth<=node.clientWidth+1')
            capture('request-api-reference-320')
            search.fill('this-method-does-not-exist')
            expect(page.locator('#scriptApiResults .script-api-entry')).to_have_count(0)
            page.locator('#closeModal').click()
            passed('API reference search filters methods and remains usable at desktop and 320px without viewport overflow or a redundant action footer')

            assert not errors, errors
            assert not dialogs, dialogs
            assert not crashes, crashes
            passed('workspace API scenarios produce no uncaught browser errors, native dialogs or page crashes')
            completed = True
            browser.close()
    finally:
        (out / 'results.json').write_text(json.dumps({
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
