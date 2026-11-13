"""Real Chromium -> MiniPost -> HTTP receiver checks for variable values/history.

The receiver echoes what arrived on its socket. No browser routing, injected
transport, or inline app is used. Screenshots and results go to ARTIFACT_DIR.
"""
from __future__ import annotations

import copy
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import tempfile
from threading import Thread
from urllib.parse import parse_qs, urlsplit

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

# Independently locate a character with canvas font metrics. Fixtures use
# non-wrapping inputs/textareas; this does not call the application's hit-test.
TOKEN_POINT = """(control, {token, scroll}) => {
  const value = control.value, start = value.indexOf(token);
  if(start < 0) throw Error('Token is absent: '+token);
  const style = getComputedStyle(control), rect = control.getBoundingClientRect();
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  ctx.font = style.font;
  const before = value.slice(0,start), lines = before.split('\\n');
  const measure = text => ctx.measureText(text).width + Math.max(0,text.length-1)*(parseFloat(style.letterSpacing)||0);
  const line = parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.2;
  const left = parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft);
  const top = parseFloat(style.borderTopWidth)+parseFloat(style.paddingTop);
  const x = left+measure(lines[lines.length-1])+measure(token)/2;
  const y = control.tagName === 'TEXTAREA' ? top+(lines.length-.5)*line : rect.height/2;
  if(scroll) {
    control.scrollLeft = Math.max(0,x-control.clientWidth/2);
    if(control.tagName === 'TEXTAREA')control.scrollTop = Math.max(0,y-control.clientHeight/2);
  }
  return {x:rect.x+x-control.scrollLeft,y:rect.y+y-control.scrollTop};
}"""


def main():
    if os.environ.get('MINIPOST_INLINE_TEST') == '1':
        raise RuntimeError('ui_sent_values requires a real HTTP browser origin')
    app_url=os.environ.get('MINIPOST_REMOTE_URL');app=None
    if app_url:
        peer=os.environ['LOCAL_RELAY_VM_BROWSER_IP']
        port=int(os.environ.get('LOCAL_RELAY_VM_BROWSER_PORT') or '18081')
        receiver=ThreadingHTTPServer(('0.0.0.0',port),EchoHandler)
        Thread(target=receiver.serve_forever,daemon=True).start()
        receiver_url=f'http://{peer}:{port}'
    else:
        receiver, receiver_url = start_server()
        app, app_url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-sent-values-'))) / 'sent-values'
    out.mkdir(parents=True, exist_ok=True)
    checks, errors, dialogs, screenshots = [], [], [], []
    page = None

    def passed(name):
        checks.append(name)
        print('PASS '+name, flush=True)

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM') or shutil.which('chromium'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width':1440,'height':1000}, accept_downloads=True)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
            page.goto(app_url, wait_until='domcontentloaded')
            expect(page.locator('#connectionStatus')).to_contain_text('connected')

            def state():
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
                return page.evaluate(READ_WORKSPACE)

            def capture(name):
                expect(page.locator('#toast')).to_be_hidden(timeout=12000)
                page.screenshot(path=str(out/(name+'.png')), full_page=True)
                screenshots.append(name+'.png')

            def load(value, workspace=False):
                page.locator('#import').click()
                page.get_by_label('インポートJSON',exact=True).fill(json.dumps(value,ensure_ascii=False))
                page.locator('#modalSubmit').click()
                if workspace:
                    expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
                    page.locator('#modalSubmit').click()
                    expect(page.locator('#modal')).not_to_be_visible()
                    expect(page.locator('#connectionStatus')).to_contain_text('connected')
                else:
                    expect(page.locator('#modalTitle')).to_have_text('インポート完了')
                    page.locator('#modalSubmit').click()

            def side(name):
                if page.locator('#sidebarTabs').is_hidden():page.locator('#toggleSidebar').click()
                page.locator(f'#sidebarTabs [data-sidebar={name}]').click()

            def choose():
                side('collections')
                page.locator('.tree-open').filter(has=page.locator('.tree-label',has_text='Snapshot request')).first.click()
                expect(page.locator('#requestName')).to_have_value('Snapshot request')

            def editor(name):
                page.locator(f'#editorTabs [data-editor={name}]').click()

            tooltip = page.locator('.variable-tooltip')

            def hover(control, key, value=None, *, status='resolved', scroll=False):
                control.scroll_into_view_if_needed()
                control.evaluate('e=>e.blur()')
                position = control.evaluate(TOKEN_POINT,{'token':'{{'+key+'}}','scroll':scroll})
                page.mouse.move(1,1)
                page.mouse.move(position['x'],position['y'])
                expect(tooltip).to_be_visible()
                expect(tooltip.locator('.variable-tooltip-name')).to_have_text('{{'+key+'}}')
                expect(tooltip).to_have_attribute('data-state',status)
                if value is not None:expect(tooltip.locator('.variable-tooltip-value')).to_have_text(value)
                return position

            template_url = '{{base}}/echo/:pathKey?q={{query}}&token={{token}}'
            template_body = '{\n  "token": "{{token}}",\n  "nested": "{{nested}}",\n  "empty": "{{empty}}"\n}'
            load({'info':{'name':'Sent values','schema':'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
                'variable':[{'key':'token','value':'collection-token'}],
                'item':[{'name':'Folder','variable':[{'key':'token','value':'folder-token'}],'item':[
                    {'name':'Snapshot request','request':{'method':'POST',
                        'url':{'raw':template_url,'variable':[{'key':'pathKey','value':'日本/語'}]},
                        'header':[{'key':'X-Token','value':'{{token}}'},{'key':'X-Nested','value':'{{nested}}'},{'key':'X-Empty','value':'{{empty}}'}],
                        'auth':{'type':'bearer','bearer':[{'key':'token','value':'{{token}}'}]},
                        'body':{'mode':'raw','raw':template_body,'options':{'raw':{'language':'json'}}},
                        '_minipost':{'before':"vars.set('token', 'sent-token');",'after':"vars.set('token', 'after-token');"}}}]}]})
            load({'_postman_variable_scope':'globals','values':[{'key':'token','value':'global-token'}]})
            load({'name':'Current environment','_postman_variable_scope':'environment','values':[
                {'key':'base','value':receiver_url}, {'key':'token','value':'environment-token'},
                {'key':'query','value':'日本語 & ? / +'}, {'key':'empty','value':''},
                {'key':'nested','value':'{{token}}/suffix'}, {'key':'zero','value':'0'},
                {'key':'disabled','value':'off','enabled':False}]})
            load({'name':'Other environment','_postman_variable_scope':'environment','values':[
                {'key':'base','value':receiver_url}, {'key':'token','value':'other-token'}]})
            page.locator('#environment').select_option(label='Current environment')
            choose();url = page.locator('#url')
            hover(url,'base',receiver_url)
            hover(url,'token','environment-token')
            expect(tooltip.locator('.variable-tooltip-scope')).to_contain_text('Current environment')
            passed('each URL placeholder resolves the hovered token using the selected environment')

            page.locator('#environment').select_option('')
            hover(url,'token','folder-token')
            page.locator('#environment').select_option(label='Current environment')
            hover(url,'token','environment-token')
            passed('switching environments immediately refreshes hover precedence over folder/collection/globals')

            url.fill('{{empty}}/{{missing}}/{{zero}}/{{disabled}}')
            hover(url,'empty','空文字',status='empty')
            hover(url,'missing',status='missing')
            hover(url,'zero','0')
            hover(url,'disabled',status='missing')
            url.fill(template_url)
            passed('empty, zero, missing and disabled variables have distinct correct hover states')

            editor('headers')
            headers = page.locator('#request-fields-headers')
            hover(headers.get_by_label('Value 1',exact=True),'token','environment-token')
            hover(headers.get_by_label('Value 2',exact=True),'nested','environment-token/suffix')
            editor('authorization')
            hover(page.locator('#request-fields-authorization').get_by_label('Token',exact=True),'token','environment-token')
            editor('body');area = page.get_by_label('Raw body',exact=True)
            hover(area,'token','environment-token')
            capture('hover-body-desktop')
            passed('header/auth/body hover resolves nested variables without changing the request')

            page.mouse.move(1,1)
            area.evaluate("e=>{const n=e.value.indexOf('{{token}}')+3;e.focus();e.setSelectionRange(n,n)}")
            area.press('ArrowRight')
            expect(tooltip).to_be_visible()
            expect(tooltip.locator('.variable-tooltip-value')).to_have_text('environment-token')
            area.press('Escape');expect(tooltip).not_to_be_visible()
            passed('keyboard caret reveals a variable and Escape dismisses its value')

            url.fill('http://'+('long-path/'*30)+'{{token}}')
            hover(url,'token','environment-token',scroll=True)
            url.fill(template_url)
            area.fill(('line without variable\n'*80)+'prefix {{token}}')
            hover(area,'token','environment-token',scroll=True)
            area.fill(template_body)
            passed('hover hit testing follows horizontal input scrolling and vertical textarea scrolling')

            with page.expect_response(lambda response:response.url.endswith('/api/request')) as sent_response:
                page.locator('#send').click()
            response = sent_response.value.json()
            assert response['ok'],response
            expect(page.locator('#responseStatus')).to_contain_text('200')
            expect(page.locator('#send')).to_contain_text('Send')
            received = json.loads(response['body']);sent = response['sent_requests'][0]
            assert sent['transmission']=='sent'
            assert sent['method']==received['method']=='POST'
            assert sent['request_target']==received['path']
            assert sent['url']==receiver_url+received['path']
            assert [(h['key'],h['value']) for h in sent['headers']]==[tuple(h) for h in received['headers']]
            assert sent['body']==received['body']
            assert sent['body_size']==len(received['body'].encode())
            assert json.loads(received['body'])=={'token':'sent-token','nested':'sent-token/suffix','empty':''}
            assert dict(received['headers'])['Authorization']=='Bearer sent-token'
            assert parse_qs(urlsplit(received['path']).query)['q']==['日本語 & ? / +']
            assert '%E6%97%A5%E6%9C%AC%2F%E8%AA%9E' in received['path']
            passed('saved snapshot exactly matches real receiver method, encoded URL, all wire headers and UTF-8 body')

            hover(area,'token','after-token')
            expect(tooltip.locator('.variable-tooltip-scope')).to_have_text('一次変数')
            saved = state();history = saved['history'][-1]
            assert history['sent_requests'][0]==sent
            assert history['tab']['request']['body']['raw']==template_body
            passed('pre-send script values are frozen in history while hover shows post-response primary values')

            page.locator('#environment').select_option(label='Other environment')
            before = state()
            side('history');page.locator('.history-entry').first.click()
            history_page=page.locator('#historyPage')
            expect(history_page).to_be_visible()
            expect(history_page.locator('[data-sent-url]')).to_have_text(sent['url'])
            expect(history_page.locator('[data-sent-headers]')).to_contain_text('Bearer sent-token')
            expect(history_page.locator('[data-sent-body]')).to_have_text(sent['body'])
            after = state()
            assert after['activeId']==before['activeId'] and after['environmentId']==before['environmentId']
            assert after['tabs']==before['tabs']
            capture('history-desktop')
            passed('history displays transmitted values without changing the current environment or request draft')

            page.reload(wait_until='domcontentloaded')
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            side('history');page.locator('.history-entry').first.click()
            expect(history_page.locator('[data-sent-body]')).to_have_text(sent['body'])
            assert state()['history'][-1]['sent_requests'][0]==sent
            passed('history retains the original transmitted values after environment changes and reload')

            for width,height in [(390,844),(320,720)]:
                page.set_viewport_size({'width':width,'height':height})
                if page.locator('#navClose').is_visible():page.locator('#navClose').click()
                expect(history_page).to_be_visible()
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                capture('history-'+str(width))
            passed('history remains readable at 390px and 320px without document horizontal overflow')

            page.set_viewport_size({'width':1440,'height':1000})
            history_page.locator('[data-history-edit]').click()
            expect(page.locator('#exchange')).to_be_visible()
            expect(page.get_by_label('Raw body',exact=True)).to_have_value(template_body)
            assert '{{token}}' in page.locator('#url').input_value()
            passed('explicit edit action reopens the original variable template')

            page.set_viewport_size({'width':390,'height':844})
            hover(page.locator('#url'),'base',receiver_url,scroll=True)
            bounds=tooltip.bounding_box()
            assert bounds and bounds['x']>=0 and bounds['y']>=0
            assert bounds['x']+bounds['width']<=391 and bounds['y']+bounds['height']<=845
            capture('hover-phone')
            passed('tooltip stays inside the phone viewport')

            page.set_viewport_size({'width':1440,'height':1000})
            legacy = copy.deepcopy(state())
            legacy_entry={key:value for key,value in history.items() if key not in ('sent_request','sent_requests','prepared_request')}
            legacy_entry.update(id='legacy-sent-values-check',at='2026-01-01T00:00:00Z')
            legacy_entry['tab']['name']='Legacy request'
            legacy['history'].append(legacy_entry)
            load({'kind':'minipost.workspace','version':1,'workspace':legacy},workspace=True)
            side('history');page.locator('.history-entry').filter(has_text='Legacy request').click()
            expect(history_page.locator('[data-sent-legacy]')).to_contain_text('この履歴には送信時の実値が保存されていません。')
            expect(history_page.locator('[data-sent-url]')).to_have_count(0)
            expect(history_page.locator('[data-sent-body]')).to_have_count(0)
            capture('history-legacy')
            passed('legacy history reports missing transmitted values instead of resolving old templates with current variables')

            assert not errors,errors
            assert not dialogs,dialogs
            passed('no uncaught browser errors or native dialogs')
            browser.close();page=None
    except Exception:
        if page and not page.is_closed():
            page.screenshot(path=str(out/'failure.png'),full_page=True)
            screenshots.append('failure.png')
        raise
    finally:
        (out/'results.json').write_text(json.dumps({'mode':'native Chromium HTTP','checks':checks,'page_errors':errors,'native_dialogs':dialogs,'screenshots':screenshots},ensure_ascii=False,indent=2))
        if app:app.shutdown();app.server_close()
        receiver.shutdown();receiver.server_close()


if __name__=='__main__':
    main()
