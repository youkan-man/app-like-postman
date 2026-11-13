"""URL text, actual receiver bytes, explicit transforms, fixed rail and pointer moves.

MINIPOST_INLINE_TEST=1 is reported as DOM+Python bridge, never native HTTP.
Remote mode uses the application VM plus a receiver on the browser VM.
"""
import base64
from contextlib import contextmanager
import hashlib
import json
import os
import re
from pathlib import Path
import tempfile
from threading import Thread
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl
from playwright.sync_api import expect, sync_playwright
from browser_app import BrowserApp
from test_proxy import proxy, start_server

class Receiver(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):self.receive()
    def do_POST(self):self.receive()
    def receive(self):
        body=self.rfile.read(int(self.headers.get('Content-Length',0)))
        result={'path':self.path,'sha256':hashlib.sha256(body).hexdigest(),'size':len(body),'body_base64':base64.b64encode(body).decode()}
        data=json.dumps(result).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)

def main():
    app_url=os.environ.get('MINIPOST_REMOTE_URL');app=None
    if app_url:
        peer=os.environ['LOCAL_RELAY_VM_BROWSER_IP'];port=int(os.environ.get('LOCAL_RELAY_VM_BROWSER_PORT','18081'))
        receiver=ThreadingHTTPServer(('0.0.0.0',port),Receiver);Thread(target=receiver.serve_forever,daemon=True).start();target=f'http://{peer}:{port}'
    else:
        receiver,target=start_server(Receiver);app,app_url=start_server(proxy.Handler)
    out=Path(os.environ.get('ARTIFACT_DIR',tempfile.mkdtemp(prefix='minipost-text-url-')))/'text-url-navigation';out.mkdir(parents=True,exist_ok=True)
    fixture=BrowserApp(app_url);checks=[];errors=[];native_dialogs=[];shots=[]
    page=None
    def passed(name):checks.append(name);print('PASS '+name,flush=True)

    @contextmanager
    def capture_failure():
        try:
            yield
        except Exception:
            try:
                if page and not page.is_closed():
                    page.screenshot(path=str(out/'failure.png'),full_page=True);shots.append('failure.png')
            except Exception as error:
                print('Could not capture failure screenshot: '+str(error),flush=True)
            raise

    try:
        with sync_playwright() as p,capture_failure():
            browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
            page=browser.new_page(viewport={'width':1440,'height':920},accept_downloads=True)
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('dialog',lambda d:(native_dialogs.append(d.message),d.dismiss()))
            fixture.open(page);expect(page.locator('#connectionStatus')).to_contain_text('connected')
            def saved():expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
            def state():saved();return page.evaluate("JSON.parse(localStorage.getItem('minipost.workspace.v2'))")
            def capture(name,wait_for_toast=True):
                if wait_for_toast:expect(page.locator('#toast')).to_be_hidden(timeout=12000)
                page.screenshot(path=str(out/(name+'.png')),full_page=True);shots.append(name+'.png')
            def load(value):
                page.locator('#import').click();page.get_by_label('インポートJSON',exact=True).fill(json.dumps(value));page.locator('#modalSubmit').click()
                expect(page.locator('#modalTitle')).to_have_text('インポート完了');page.locator('#modalSubmit').click();saved()
            def row(name):return page.locator('.tree-row[data-collection-id]').filter(has=page.locator('.tree-label',has_text=re.compile('^'+re.escape(name)+'$')))
            def stored_item(value, collection_id, item_id):
                def descendants(items):
                    for item in items:
                        yield item
                        yield from descendants(item.get('item', []))
                collection=next(c for c in value['collections'] if c['_mpId']==collection_id)
                return next(item for item in descendants(collection['item']) if item['_mpId']==item_id)
            def choose(name):
                if page.locator('#sidebarTabs').is_hidden():page.locator('#toggleSidebar').click()
                page.locator('[data-sidebar=collections]').click();row(name).locator('.tree-open').click();expect(page.locator('#requestName')).to_have_value(name)
            def send():
                page.locator('#send').click();expect(page.locator('#responseStatus')).to_contain_text('200',timeout=15000)
                expect(page.locator('#send')).to_contain_text('Send');return json.loads(page.locator('.response-code').inner_text())
            schema='https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
            load({'info':{'name':'Collection A','schema':schema},'item':[
                {'name':'Folder A','item':[{'name':'Request one','request':{'method':'POST','url':target+'/echo','body':{'mode':'raw','raw':'original'}}}]},
                {'name':'Request two','request':{'method':'GET','url':target+'/echo?two=1'}},
                {'name':'Upload','request':{'method':'POST','url':target+'/日本 語','body':{'mode':'file'}}}]})
            load({'info':{'name':'Collection B','schema':schema},'item':[{'name':'Other request','request':{'method':'GET','url':target+'/echo'}}]})
            choose('Request one')
            raw=target+'/日本 語?q=大阪+名張&data={"a":1}'
            page.locator('#url').fill(raw);saved();received=send()
            assert parse_qsl(received['path'].split('?',1)[1])==[('q','大阪+名張'),('data','{"a":1}')]
            assert received['path'].startswith('/%E6%97%A5%E6%9C%AC%20%E8%AA%9E?')
            expect(page.locator('#url')).to_have_value(raw)
            choose('Request two');choose('Request one');expect(page.locator('#url')).to_have_value(raw)
            page.keyboard.press('Control+s');saved();fixture.reload(page);expect(page.locator('#url')).to_have_value(raw)
            passed('raw Unicode/space/plus/JSON URL stays readable across send, selection, save and reload; receiver matches')
            page.locator('#editor-tab-params').click()
            value='a&b=+?#%2F 日本';page.locator('[data-pane=params]').get_by_label('Value 1',exact=True).fill(value);saved()
            assert value in page.locator('#url').input_value()
            received=send();assert parse_qsl(received['path'].split('?',1)[1])[0]==('q',value)
            passed('params with reserved delimiters remain one value; frontend never percent-encodes their display')
            plain=target+'/日本 語?q=a b';page.locator('#url').fill(plain)
            area=page.locator('#url');area.focus();start=plain.index('日本');area.evaluate('(e,s)=>e.setSelectionRange(s,s+4)',start)
            area.press('Shift+F10');page.get_by_role('menuitem',name='選択範囲をURLエンコード',exact=True).click()
            encoded=plain.replace('日本 語','%E6%97%A5%E6%9C%AC%20%E8%AA%9E')
            expect(area).to_have_value(encoded);received=send();assert '%25E6' not in received['path']
            area.focus()
            area.evaluate('(e,s)=>e.setSelectionRange(s,e.value.indexOf("?"))',start)
            area.press('Shift+F10');page.get_by_role('menuitem',name='選択範囲をURLデコード',exact=True).click();expect(area).to_have_value(plain)
            passed('keyboard context menu explicitly encodes/decodes selection; encoded URL sends without a second escape')
            area.fill(target+'/%ZZ');area.focus();area.select_text();area.press('Shift+F10');page.get_by_role('menuitem',name='選択範囲をURLデコード',exact=True).click()
            expect(page.locator('#toast')).to_contain_text('不正な%');expect(area).to_have_value(target+'/%ZZ')
            area.fill(plain);saved();capture('text-url-desktop')
            passed('invalid manual decoding reports an inline error without changing the URL or opening a browser dialog')
            # Exercise actual pointer motion rather than directly invoking model functions.
            def begin_drag(source):
                grip=row(source).locator('.tree-drag-handle');box=grip.bounding_box()
                page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);page.mouse.down()

            def drag(source,target_name,position='inside',cancel=False,inspect_inside=False):
                dest=row(target_name).bounding_box();begin_drag(source)
                fraction={'inside':.5,'before':.1,'after':.9}[position]
                page.mouse.move(dest['x']+dest['width']*.6,dest['y']+dest['height']*fraction,steps=12)
                if inspect_inside:
                    expect(row(target_name)).to_have_attribute('data-drop-position','inside')
                    expect(page.locator('.tree-drop-line:visible')).to_have_count(0)
                    expect(page.locator('.tree-drop-indicator')).to_have_count(0)
                    capture('collection-folder-inside-desktop',wait_for_toast=False)
                if cancel:page.keyboard.press('Escape')
                page.mouse.up();saved()
                expect(page.locator('.tree-drop-line:visible')).to_have_count(0)
                expect(page.locator('.tree-row[data-drop-position]')).to_have_count(0)

            first=state();a,b=first['collections']
            # Both row edges and the actual space between them are one target.
            # Use a source outside this sibling list so its own removal cannot
            # turn this move into a no-op or change the insertion index.
            upper=row('Request two').bounding_box();lower=row('Upload').bounding_box()
            x=upper['x']+upper['width']*.6
            upper_bottom=upper['y']+upper['height'];gap_y=(upper_bottom+lower['y'])/2
            assert lower['y']>=upper_bottom-.5,(upper,lower)
            other_id=row('Other request').get_attribute('data-item-id')
            begin_drag('Other request')
            line=page.locator('.tree-drop-line:visible');targets=[]
            for name,y in [('lower edge of A',upper_bottom-2),('actual gap',gap_y),('upper edge of B',lower['y']+2)]:
                page.mouse.move(x,y,steps=5)
                expect(line).to_have_count(1)
                expect(line).to_have_attribute('data-drop-key',re.compile(r'.+'))
                assert line.text_content()=='',name
                expect(page.locator('.tree-drop-indicator')).to_have_count(0)
                expect(page.locator('.tree-row[data-drop-position]')).to_have_count(0)
                bounds=line.bounding_box();assert bounds and bounds['width']>0 and bounds['height']>0,name
                targets.append((line.get_attribute('data-drop-key'),bounds))
            shared_key,shared_bounds=targets[0]
            for key,bounds in targets[1:]:
                assert key==shared_key,targets
                assert all(abs(bounds[axis]-shared_bounds[axis])<1 for axis in ['x','y','width']),targets
            passed('lower sibling edge, physical gap and upper sibling edge share one empty insertion line, key and geometry')
            page.mouse.move(x,gap_y,steps=3)
            expect(line).to_have_attribute('data-drop-key',shared_key)
            capture('collection-shared-gap-during-drag',wait_for_toast=False)
            page.mouse.up();saved()
            expect(page.locator('.tree-drop-line:visible')).to_have_count(0)
            w=state()
            expected_ids=[a['item'][0]['_mpId'],a['item'][1]['_mpId'],other_id,a['item'][2]['_mpId']]
            assert [item['_mpId'] for item in w['collections'][0]['item']]==expected_ids
            assert w['collections'][1]['item']==[]
            drag('Other request','Collection B');w=state()
            assert [item['_mpId'] for item in w['collections'][0]['item']]==[item['_mpId'] for item in a['item']]
            assert [item['_mpId'] for item in w['collections'][1]['item']]==[other_id]
            passed('releasing in the shared gap inserts the source exactly once at that position and preserves its ID')

            drag('Request two','Folder A',inspect_inside=True);w=state();assert [i['name'] for i in w['collections'][0]['item'][0]['item']]==['Request one','Request two']
            source_box=row('Request two').bounding_box();next_box=row('Upload').bounding_box()
            expected_y=(source_box['y']+source_box['height']+next_box['y'])/2
            begin_drag('Request two')
            page.mouse.move(next_box['x']+next_box['width']*.6,next_box['y']+2,steps=8)
            line=page.locator('.tree-drop-line:visible');expect(line).to_have_count(1)
            bounds=line.bounding_box();assert abs(bounds['y']+bounds['height']/2-expected_y)<1
            capture('collection-folder-exit-gap',wait_for_toast=False)
            page.mouse.up();saved();w=state()
            assert [item['name'] for item in w['collections'][0]['item']]==['Folder A','Request two','Upload']
            drag('Request two','Folder A')
            passed('moving a folder child out keeps the insertion line at the actual row gap while its source remains visible')
            drag('Request two','Request one','before');w=state();assert [i['name'] for i in w['collections'][0]['item'][0]['item']]==['Request two','Request one']
            passed('mouse dragging supports inside-folder placement and before/after ordering with stable item IDs')
            before=state();drag('Folder A','Request one','inside');assert state()==before
            drag('Request two','Other request','after',cancel=True);assert state()==before
            passed('self-descendant drops and Escape leave collections unchanged')
            choose('Request one');page.locator('#url').fill(plain+' changed');saved()
            before=state();request_id=row('Request one').get_attribute('data-item-id');key=f"request:{a['_mpId']}:{request_id}";revs=before['revisions'][key]
            request=stored_item(before,a['_mpId'],request_id)
            assert request['request']['url']['raw']==plain+' changed'
            drag('Folder A','Collection B');w=state()
            current=stored_item(w,b['_mpId'],request_id);assert current==request
            assert w['tabs']==before['tabs']
            assert w['activeRequest']=={'collectionId':b['_mpId'],'itemId':request_id}
            assert w['revisions'][f"request:{b['_mpId']}:{request_id}"]==revs
            assert key not in w['revisions'];expect(page.locator('#requestName')).to_have_value('Request one');expect(area).to_have_value(plain+' changed')
            passed('cross-collection folder move preserves active editor, descendant IDs and existing revisions')
            # A binary attachment must follow the open editor during a move.
            choose('Upload');page.locator('#editor-tab-body').click();data=bytes(range(256))*4096
            with page.expect_file_chooser() as picked:page.locator('[data-file-slot=binary] .file-pick').click()
            picked.value.set_files({'name':'日本.bin','mimeType':'application/octet-stream','buffer':data})
            expect(page.locator('[data-file-slot=binary] .file-pick')).to_have_text('日本.bin')
            row('Upload').get_by_role('button',name='Uploadの操作',exact=True).click();page.get_by_role('menuitem',name='リレーションに追加',exact=True).click()
            page.get_by_label('リレーション名',exact=True).fill('Upload flow');page.locator('#modalSubmit').click();choose('Upload')
            drag('Upload','Collection B');w=state();assert w['relations'][0]['steps'][0]['collectionId']==b['_mpId']
            received=send();assert received['size']==len(data) and received['sha256']==hashlib.sha256(data).hexdigest()
            passed('moving a selected binary request keeps its bytes and relation references; actual receiver hash matches')
            grip=row('Upload').locator('.tree-drag-handle');grip.focus();grip.press('Space');grip.press('Home');grip.press('Enter');w=state()
            assert any(i['name']=='Upload' for i in w['collections'][0]['item']);assert w['relations'][0]['steps'][0]['collectionId']==a['_mpId']
            passed('keyboard grab/Home/Enter moves the same request and preserves its relation target')
            capture('collection-move-desktop')
            for width,height in [(390,844),(320,720)]:
                page.set_viewport_size({'width':width,'height':height});page.wait_for_function("document.getElementById('navClose').hidden === !matchMedia('(max-width:820px)').matches")
                if page.locator('#sidebarTabs').is_hidden():page.locator('#toggleSidebar').click()
                buttons=page.locator('#sidebarTabs [role=tab]');boxes=[item.bounding_box() for item in buttons.all()]
                assert len(boxes)==4 and all(box for box in boxes)
                assert max(box['x'] for box in boxes)-min(box['x'] for box in boxes)<1
                assert buttons.evaluate_all('(items)=>items.every(e=>{const b=e.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight;})')
                assert page.locator('#sidebarTabs').evaluate('e=>e.scrollWidth<=e.clientWidth&&e.scrollHeight<=e.clientHeight')
                buttons.first.focus();page.keyboard.press('ArrowDown');expect(page.locator('[data-sidebar=environments]')).to_have_attribute('aria-selected','true')
                expect(page.locator('#sidebarTitle')).to_have_text('環境');page.keyboard.press('End');expect(page.locator('[data-sidebar=relations]')).to_have_attribute('aria-selected','true')
                page.locator('[data-sidebar=collections]').click();assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');capture('fixed-rail-'+str(width))
            passed('320/390px category rail remains fixed, fully visible and keyboard operable without wrapping or horizontal scroll')
            # Touch input comes through Chromium's input system, not a synthetic DOM drop.
            client=page.context.new_cdp_session(page);client.send('Emulation.setTouchEmulationEnabled',{'enabled':True,'maxTouchPoints':1})
            expect(row('Upload').locator('.tree-drag-handle')).to_have_css('touch-action','none')
            src=row('Upload').locator('.tree-drag-handle').bounding_box();dest=row('Collection B').bounding_box()
            x,y=src['x']+src['width']/2,src['y']+src['height']/2
            client.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
            for fraction in (.2,.4,.6,.8,1):
                client.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+(dest['x']+dest['width']*.5-x)*fraction,'y':y+(dest['y']+dest['height']/2-y)*fraction}]})
            client.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]});saved()
            expect(row('Upload')).to_have_attribute('data-collection-id',b['_mpId'])
            assert any(i['name']=='Upload' for i in state()['collections'][1]['item'])
            passed('touch drag on the grip moves a request without converting ordinary row scrolling into a drag')
            before=state();fixture.reload(page);restored=state()
            assert restored['collections']==before['collections'] and restored['relations']==before['relations']
            assert restored['activeId']==before['activeId'] and restored['revisions']==before['revisions']
            assert restored['activeRequest']==before['activeRequest']
            expect(page.locator('#requestName')).to_have_value('Upload')
            passed('moved hierarchy, stable references, active request and revision history survive reload')
            # A collection's final insertion gap follows its whole expanded
            # subtree, which can be far below its header and the viewport.
            page.set_viewport_size({'width':1440,'height':920})
            load({'info':{'name':'Long collection','schema':schema},'item':[
                {'name':f'Long request {index}','request':{'method':'GET','url':target+'/echo'}} for index in range(40)]})
            if page.locator('#sidebarTabs').is_hidden():page.locator('#toggleSidebar').click()
            page.locator('[data-sidebar=collections]').click();before=state()
            grip=row('Collection A').locator('.tree-drag-handle');grip.focus()
            page.keyboard.press('Space');page.keyboard.press('End')
            line=page.locator('.tree-drop-line:visible');expect(line).to_have_count(1)
            bounds=line.bounding_box();sidebar=page.locator('#sidebarContent').bounding_box()
            last=row('Long request 39').bounding_box()
            assert bounds['y']>=sidebar['y'] and bounds['y']+bounds['height']<=sidebar['y']+sidebar['height']+1
            assert abs(bounds['y']+bounds['height']/2-last['y']-last['height'])<1
            capture('collection-keyboard-end',wait_for_toast=False)
            page.keyboard.press('Escape');expect(page.locator('.tree-drop-line:visible')).to_have_count(0)
            assert state()==before
            passed('keyboard End scrolls the actual gap after an expanded collection into view; Escape preserves the order')
            assert not errors,errors;assert not native_dialogs,native_dialogs
            passed('no browser-native dialogs or uncaught page exceptions')
            browser.close()
    finally:
        (out/'results.json').write_text(json.dumps({'mode':'DOM fixture + Python HTTP bridge' if fixture.inline else 'native Chromium HTTP','checks':checks,'page_errors':errors,'native_dialogs':native_dialogs,'screenshots':shots},ensure_ascii=False,indent=2))
        if app:app.shutdown();app.server_close()
        receiver.shutdown();receiver.server_close()
if __name__=='__main__':main()
