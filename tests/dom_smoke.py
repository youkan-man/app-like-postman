"""Offline DOM tests for environments that forbid all browser URL navigation.

All fetch responses here are explicit mocks; use browser_smoke.py for live E2E.
No browser policy is changed and no network request is made by these tests.
"""
import json
import os
from pathlib import Path
import re
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]

def main():
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-dom-')))
    out.mkdir(parents=True, exist_ok=True)
    checks = []
    def passed(name):
        checks.append(name); print('PASS ' + name, flush=True)
    html = (ROOT / 'static/index.html').read_text()
    html = re.sub(r'<script[^>]*src="/app.js"[^>]*></script>', '', html)
    html = html.replace('<link rel="stylesheet" href="/style.css">', '<style>' + (ROOT / 'static/style.css').read_text() + '</style>')
    core = re.sub(r'^export ', '', (ROOT / 'static/core.mjs').read_text(), flags=re.M)
    app = re.sub(r'^import .*?;\n', '', (ROOT / 'static/app.js').read_text(), count=1)
    gateway = json.loads((ROOT / 'examples/com-gateway.postman_collection.json').read_text())
    sample = {
        'info': {'name': 'DOM verification', 'schema': gateway['info']['schema']},
        'variable': [{'key': 'baseUrl', 'value': 'http://example.test'}, {'key': 'token', 'value': 'collection-token'}],
        'auth': {'type': 'bearer', 'bearer': [{'key': 'token', 'value': '{{token}}'}]},
        'item': [{'name': 'Requests', 'item': [
            {'name': 'Query request', 'request': {'method': 'GET', 'url': {'raw': '{{baseUrl}}/echo?x=old', 'query': [{'key': 'x', 'value': 'one'}, {'key': 'x', 'value': 'two'}, {'key': 'off', 'value': 'x', 'disabled': True}]}}},
            {'name': 'JSON request', 'request': {'method': 'POST', 'url': '{{baseUrl}}/echo', 'body': {'mode': 'raw', 'raw': '{\n  "message": "hello {{label}}",\n  "enabled": true\n}', 'options': {'raw': {'language': 'json'}}}}},
            {'name': 'Slow request', 'request': {'method': 'GET', 'url': '{{baseUrl}}/slow'}}
        ]}]
    }
    env = {'name': 'DOM mock environment', '_postman_variable_scope': 'environment', 'values': [{'key': 'token', 'value': 'test-only-token', 'type': 'secret'}, {'key': 'label', 'value': 'workspace'}]}
    storage = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        page = None; errors = []
        def load():
            nonlocal page
            if page is not None: page.close()
            page = browser.new_page(viewport={'width': 1440, 'height': 920})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_default_timeout(7000)
            page.set_content(html)
            prelude = '''
            window.__storage=STORAGE;
            Object.defineProperty(window, 'localStorage', {configurable: true, value: {
              getItem(key) {return Object.hasOwn(window.__storage,key)?window.__storage[key]:null;},
              setItem(key,value) {window.__storage[key]=String(value);},
              removeItem(key) {delete window.__storage[key];}
            }});
            window.__sent=[]; window.__gateway=GATEWAY;
            window.fetch = async (url, options={}) => {
              if (url === '/api/health') return new Response(JSON.stringify({ok:true}),{status:200});
              if (url === '/api/examples/gateway') return new Response(JSON.stringify(window.__gateway),{status:200});
              if (url !== '/api/request') throw new Error('Offline DOM test forbids network');
              const payload=JSON.parse(options.body);window.__sent.push(payload);
              if(payload.url.includes('/slow')) await new Promise((resolve,reject)=>{const id=setTimeout(resolve,500);options.signal.addEventListener('abort',()=>{clearTimeout(id);reject(new DOMException('aborted','AbortError'));},{once:true});});
              const text=JSON.stringify({test_mode:'DOM mock — no network',method:payload.method,url:payload.url,headers:payload.headers,body:payload.body,body_base64:payload.body_base64,multipart:payload.multipart},null,2);
              let binary='';for(const b of new TextEncoder().encode(text))binary+=String.fromCharCode(b);
              return new Response(JSON.stringify({ok:true,status:200,status_text:'OK',body:text,body_encoding:'text',body_base64:btoa(binary),headers:[{key:'Content-Type',value:'application/json'}],content_type:'application/json',size:new TextEncoder().encode(text).length,elapsed_ms:17,redirects:[]}),{status:200});
            };
            '''.replace('STORAGE', json.dumps(storage)).replace('GATEWAY', json.dumps(gateway))
            page.add_script_tag(content=prelude)
            page.add_script_tag(content='(() => {\n' + core + '\n' + app + '\n})();')
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
        def import_raw(data):
            page.locator('#import').click(); page.get_by_label('インポートJSON').fill(json.dumps(data)); page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_have_text('インポート完了'); page.locator('#modalSubmit').click()
        def open_request(name):
            page.locator('.tree-open').filter(has=page.locator('.tree-label', has_text=name)).first.click()
            expect(page.locator('#requestName')).to_have_value(name)
        def send():
            page.locator('#send').click(); expect(page.locator('#responseStatus')).to_contain_text('200')
            return page.evaluate('window.__sent.at(-1)')
        load(); passed('initial DOM render and mocked health response')
        import_raw(sample)
        expect(page.locator('#url')).to_have_value('{{baseUrl}}/echo?x=one&x=two')
        import_raw(env); request = send()
        assert request['url'] == 'http://example.test/echo?x=one&x=two'
        assert request['headers'][0]['value'] == 'Bearer test-only-token'
        passed('collection/env import, hierarchy, disabled rows, variable and auth compilation')
        page.get_by_label('Value 1', exact=True).fill('changed')
        expect(page.locator('#url')).to_have_value('{{baseUrl}}/echo?x=changed&x=two')
        page.locator('#url').fill('{{baseUrl}}/echo?edited=yes')
        expect(page.get_by_label('Key 1', exact=True)).to_have_value('edited')
        page.keyboard.press('Control+s'); passed('URL and Params bidirectional editing; Ctrl+S save')
        open_request('JSON request'); expect(page.locator('section.editor-section[data-pane=body] .editor-section-body')).to_be_visible()
        request = send(); assert json.loads(request['body'])['message'] == 'hello workspace'
        page.get_by_label('Raw body').fill('{\n  "message": "edited {{label}}",\n  "count": 3,\n  "enabled": true\n}')
        page.keyboard.press('Control+s'); page.wait_for_timeout(300)
        storage = page.evaluate('window.__storage'); load()
        expect(page.locator('section.editor-section[data-pane=body] .editor-section-body')).to_be_visible(); expect(page.get_by_label('Raw body')).to_have_value('{\n  "message": "edited {{label}}",\n  "count": 3,\n  "enabled": true\n}')
        request = send(); assert json.loads(request['body'])['message'] == 'edited workspace'
        passed('JSON edit, template resolution and persisted-state restoration')
        page.locator('#responseSearch').fill('workspace'); expect(page.locator('mark').first).to_be_visible(); page.locator('#responseSearch').fill('')
        page.locator('#responseMode').select_option('headers'); expect(page.locator('.kv-readonly')).to_contain_text('application/json')
        page.locator('#responseMode').select_option('pretty'); passed('response syntax, search and header view')
        page.locator('input[name=bodyMode][value=file]').check()
        with page.expect_file_chooser() as chooser: page.get_by_role('button', name='ファイルを選択', exact=True).click()
        chooser.value.set_files({'name':'payload.bin','mimeType':'application/octet-stream','buffer':b'\x00\x01\xff'})
        request = send(); assert request['body_base64'] == 'AAH/'
        passed('binary file selection and lossless proxy-payload construction')
        page.locator('input[name=bodyMode][value=formdata]').check()
        page.get_by_role('button', name='＋ 行を追加').click(); page.get_by_label('Key 1', exact=True).fill('metadata'); page.get_by_label('Value 1', exact=True).fill('hello {{label}}')
        page.get_by_role('button', name='＋ 行を追加').click(); page.get_by_label('Key 2', exact=True).fill('upload'); page.locator('.kv-table tbody tr').nth(1).locator('select').select_option('file')
        with page.expect_file_chooser() as chooser: page.get_by_role('button', name='ファイルを選択', exact=True).click()
        chooser.value.set_files({'name':'a.bin','mimeType':'application/octet-stream','buffer':b'\x00\x01\xff'})
        request = send(); assert request['multipart'][0]['value'] == 'hello workspace'; assert request['multipart'][1]['data'] == 'AAH/'
        page.locator('input[name=bodyMode][value=raw]').check(); page.keyboard.press('Control+s')
        passed('multipart table, file selection, variable and payload construction')
        open_request('Slow request'); page.locator('#send').click(); open_request('Query request'); request = send(); assert request['url'].endswith('/echo?edited=yes')
        page.wait_for_timeout(700); open_request('Slow request'); expect(page.locator('#responseStatus')).to_contain_text('200')
        assert 'http://example.test/slow' in page.locator('.response-code').inner_text()
        passed('concurrent mock responses remain isolated per request tab')
        page.locator('#send').click(); page.locator('#send').click(); expect(page.locator('#responseStatus')).to_have_text('CANCELLED')
        expect(page.locator('.response-code')).to_contain_text('取り消せません'); passed('receive cancellation and correct limitation message')
        page.locator('details.sidebar-group[data-group=history]').evaluate('el => el.open = true'); expect(page.locator('.history-entry').first).to_be_visible(); page.locator('.history-entry').first.click()
        page.locator('details.sidebar-group[data-group=collections]').evaluate('el => el.open = true'); passed('history display and reopen')
        page.wait_for_timeout(300); before = page.evaluate('JSON.parse(localStorage.getItem("minipost.workspace.v2")).collections.length')
        page.locator('#import').click(); page.get_by_label('インポートJSON').fill('{"bad":"format"}'); page.locator('#modalSubmit').click()
        expect(page.locator('#modalMessage')).to_contain_text('Collection'); page.locator('#closeModal').click()
        assert page.evaluate('JSON.parse(localStorage.getItem("minipost.workspace.v2")).collections.length') == before
        passed('invalid import is atomic and non-destructive')
        malicious = json.loads(json.dumps(sample)); malicious['info']['name']='<img src=x onerror="window.__XSS=1">'; malicious['event']=[{'listen':'prerequest','script':{'exec':['window.__SCRIPT_RAN=true;']}}]
        import_raw(malicious); expect(page.locator('#requestWarning')).to_be_visible(); assert not page.evaluate('Boolean(window.__XSS || window.__SCRIPT_RAN)')
        expect(page.locator('section.editor-section[data-pane=scripts] .editor-section-body')).to_be_visible(); expect(page.locator('.scripts-block')).to_contain_text('__SCRIPT_RAN')
        passed('untrusted imported labels are text; scripts retained but not executed')
        page.wait_for_timeout(300); storage=page.evaluate('window.__storage')
        state=json.loads(storage['minipost.workspace.v2']); state['collections']=[c for c in state['collections'] if not c['info']['name'].startswith('<img')]
        ids={c['_mpId'] for c in state['collections']}; state['tabs']=[t for t in state['tabs'] if t.get('collectionId') in ids]; state['activeId']=state['tabs'][0]['id']
        storage['minipost.workspace.v2']=json.dumps(state); load()
        page.locator('#gatewayExample').click(); expect(page.locator('#modalTitle')).to_have_text('インポート完了'); page.locator('#modalSubmit').click()
        open_request('JSON request'); expect(page.locator('section.editor-section[data-pane=body] .editor-section-body')).to_be_visible(); send()
        passed('built-in COM Gateway collection loads without changing its configuration')
        page.locator('#requestInfo').evaluate("e => e.textContent='画面確認 · 通信モック（実Gatewayには未接続）'")
        page.locator('#connectionStatus').evaluate("e => e.textContent='Offline DOM test · simulated transport'")
        page.wait_for_timeout(300)
        page.screenshot(path=str(out/'minipost-preview.png'), full_page=True)
        for width,height in [(1440,920),(1024,768),(768,1024),(390,844)]:
            page.set_viewport_size({'width':width,'height':height}); assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'overflow {width}'; expect(page.locator('#send')).to_be_visible()
        passed('no document overflow at desktop, tablet and phone widths')
        page.set_viewport_size({'width':1440,'height':920}); old=page.locator('.sidebar').bounding_box()['width']; handle=page.locator('#sidebarResize').bounding_box()
        page.mouse.move(handle['x']+2,handle['y']+60); page.mouse.down(); page.mouse.move(handle['x']+72,handle['y']+60); page.mouse.up(); assert page.locator('.sidebar').bounding_box()['width'] > old
        passed('pointer-driven sidebar resize')
        assert not errors, errors; passed('no uncaught JavaScript exceptions')
        (out/'dom-results.json').write_text(json.dumps({'mode':'offline DOM, mocked fetch, mocked localStorage','passed':len(checks),'checks':checks,'page_errors':errors},indent=2))
        browser.close()
    print(json.dumps({'passed':len(checks),'artifacts':str(out)}))

if __name__=='__main__': main()
