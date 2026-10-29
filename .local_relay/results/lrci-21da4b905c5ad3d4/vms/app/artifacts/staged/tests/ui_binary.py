"""Binary bytes, async file ownership, single-row navigation and custom dialogs.
Default: real Chromium HTTP. Explicit inline mode is only a DOM + HTTP-bridge test.
MINIPOST_REMOTE_URL runs Chromium and the receiver on the Relay browser VM.
"""
import base64
import hashlib
import json
import os
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
from threading import Thread
from playwright.sync_api import sync_playwright, expect
from browser_app import BrowserApp
from test_proxy import proxy, start_server

received = []
class Receiver(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass
    def do_POST(self):
        data = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        record = {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'content_type': self.headers.get('Content-Type'), 'parts': []}
        if record['content_type'].startswith('multipart/form-data'):
            message = BytesParser(policy=default).parsebytes(('Content-Type: '+record['content_type']+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+data)
            for part in message.iter_parts():
                body = part.get_payload(decode=True)
                record['parts'].append({'name': part.get_param('name', header='content-disposition'), 'filename': part.get_filename(), 'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
        received.append(record)
        output = json.dumps(record).encode()
        self.send_response(200);self.send_header('Content-Type', 'application/json');self.send_header('Content-Length',str(len(output)));self.end_headers();self.wfile.write(output)

def main():
    app = None
    remote = os.environ.get('MINIPOST_REMOTE_URL')
    if remote:
        peer = os.environ['LOCAL_RELAY_VM_BROWSER_IP'];port=int(os.environ.get('LOCAL_RELAY_VM_BROWSER_PORT') or 18081)
        receiver = ThreadingHTTPServer(('0.0.0.0',port), Receiver);Thread(target=receiver.serve_forever,daemon=True).start();target=f'http://{peer}:{port}/bytes';url=remote
    else:
        receiver, target = start_server(Receiver);target += '/bytes';app,url=start_server(proxy.Handler)
    fixture=BrowserApp(url)
    out=Path(os.environ.get('ARTIFACT_DIR',tempfile.mkdtemp(prefix='minipost-binary-')))/'binary';out.mkdir(parents=True,exist_ok=True)
    checks, errors, dialogs, screenshots = [], [], [], []
    def passed(name): checks.append(name);print('PASS '+name,flush=True)
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM'),headless=True,args=['--no-sandbox'])
            page=browser.new_page(viewport={'width':1440,'height':920});page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('dialog',lambda d:(dialogs.append(d.type),d.dismiss()))
            page.set_default_timeout(12000);fixture.open(page);expect(page.locator('#connectionStatus')).to_contain_text('connected')
            sample={'info':{'name':'Binary regression'},'item':[{'name':name,'request':{'method':'POST','url':target,'body':{'mode':'file'}}} for name in ['Binary A','Binary B']]}
            def import_value(value):
                page.locator('#import').click();page.get_by_label('インポートJSON').fill(json.dumps(value));page.locator('#modalSubmit').click();expect(page.locator('#modalTitle')).to_have_text('インポート完了');page.locator('#modalSubmit').click()
            def side(value):
                if page.locator('#sidebarTabs').is_hidden():page.locator('#toggleSidebar').click()
                page.locator(f'[data-sidebar={value}]').click()
            def request(name):
                side('collections');page.locator('.tree-open').filter(has=page.locator('.tree-label',has_text=name)).first.click();expect(page.locator('#requestName')).to_have_value(name);page.locator('#editor-tab-body').click()
            def choose(name,data,index=0,multiple=None):
                with page.expect_file_chooser() as choosing:page.locator('[data-pane=body] .file-selection .file-pick').nth(index).click()
                values=multiple or [{'name':name,'mimeType':'application/octet-stream','buffer':data}]
                choosing.value.set_files(values)
            def ready(name,index=0):expect(page.locator('[data-pane=body] .file-pick').nth(index)).to_contain_text(name)
            def send(data=None):
                count=len(received);page.locator('#send').click();expect(page.locator('#send')).to_contain_text('Send');expect(page.locator('#responseStatus')).to_contain_text('200')
                if data is not None:expect(page.locator('.response-code')).to_contain_text(hashlib.sha256(data).hexdigest())
                result=json.loads(page.locator('.response-code').inner_text());assert len(received)==count+1
                if data is not None:assert result['size']==len(data)
                return result
            def delay_reads():
                page.evaluate("""()=>{window.savedArrayBuffer=File.prototype.arrayBuffer;window.pendingReads={};File.prototype.arrayBuffer=function(){const file=this;return new Promise((resolve,reject)=>{pendingReads[file.name]={release:()=>resolve(savedArrayBuffer.call(file)),reject:()=>reject(Error('injected read failure'))};});};}""")
            def release(name):page.evaluate('name=>pendingReads[name].release()',name)
            def restore_reads():page.evaluate('()=>{File.prototype.arrayBuffer=savedArrayBuffer;}')
            def shot(name):
                page.screenshot(path=str(out/(name+'.png')),full_page=True);screenshots.append(name+'.png')
            import_value(sample);request('Binary A')
            ys=page.locator('#sidebarTabs button').evaluate_all('nodes=>nodes.map(n=>n.getBoundingClientRect().y)');assert len(set(ys))==1,ys
            passed('sidebar categories occupy exactly one row')
            allbytes=bytes(range(256));choose('all-bytes.bin',allbytes);ready('all-bytes.bin');send(allbytes)
            passed('all byte values 00-FF reach the receiver unchanged')
            choose('empty.bin',b'');ready('empty.bin');send(b'');passed('zero-byte binary sends a real empty body')
            large=allbytes*8192;choose('large-2MiB.bin',large);ready('large-2MiB.bin');send(large);passed('2 MiB binary length and SHA-256 match at the actual receiver')
            delay_reads();new=allbytes[::-1];choose('delayed.bin',new);page.wait_for_function("pendingReads['delayed.bin']")
            count=len(received);page.locator('#send').click();expect(page.locator('#send')).to_contain_text('Cancel');page.wait_for_timeout(150);assert len(received)==count
            release('delayed.bin');expect(page.locator('.response-code')).to_contain_text(hashlib.sha256(new).hexdigest());assert received[-1]['size']==len(new);restore_reads()
            passed('Send waits for file replacement and never sends the previous bytes')
            delay_reads();choose('owner-A.bin',b'owner A');page.wait_for_function("pendingReads['owner-A.bin']");request('Binary B');release('owner-A.bin');restore_reads()
            assert page.locator('.file-pick').inner_text()=='ファイルを選択';request('Binary A');ready('owner-A.bin');send(b'owner A');passed('finishing a read after request selection updates only the originating request')
            delay_reads();choose('first.bin',b'first');page.wait_for_function("pendingReads['first.bin']");choose('last.bin',b'last');page.wait_for_function("pendingReads['last.bin']");release('last.bin');ready('last.bin');release('first.bin');restore_reads();ready('last.bin');send(b'last')
            passed('out-of-order file reads cannot overwrite the newest selection')
            delay_reads();choose('cancelled.bin',b'cancelled');page.wait_for_function("pendingReads['cancelled.bin']");count=len(received);page.locator('#send').click();expect(page.locator('#send')).to_contain_text('Cancel');page.locator('#send').click();expect(page.locator('#responseStatus')).to_contain_text('CANCELLED');release('cancelled.bin');restore_reads();ready('cancelled.bin');assert len(received)==count;send(b'cancelled')
            passed('Cancel interrupts the pending send; a later explicit resend uses the chosen file')
            delay_reads();choose('bad.bin',b'bad');page.wait_for_function("pendingReads['bad.bin']");page.evaluate("pendingReads['bad.bin'].reject()");restore_reads();expect(page.locator('.file-selection-state')).to_contain_text('読込失敗');count=len(received);page.locator('#send').click();expect(page.locator('#responseStatus')).to_contain_text('ERROR');assert len(received)==count
            passed('file read failures do not silently resend a previous attachment')
            choose('recovered.bin',allbytes);ready('recovered.bin');send(allbytes);page.get_by_label('ファイル選択を解除',exact=True).click();count=len(received);page.locator('#send').click();expect(page.locator('#responseStatus')).to_contain_text('ERROR');assert len(received)==count
            passed('clearing binary selection removes the bytes as well as the displayed name')
            page.locator('[name=bodyMode][value=formdata]').check();body=page.locator('[data-pane=body]');body.get_by_role('button',name='＋ 行を追加',exact=True).click();body.get_by_label('Key 1',exact=True).fill('upload');body.locator('.kv-data-row').first.locator('select').select_option('file')
            delay_reads();choose('row.bin',allbytes);page.wait_for_function("pendingReads['row.bin']");body.get_by_label('行 1 の操作',exact=True).click();page.get_by_role('menuitem',name='この上に行を追加').click();body.get_by_label('Key 1',exact=True).fill('note');body.get_by_label('Value 1',exact=True).fill('note body');release('row.bin');restore_reads();ready('row.bin')
            result=send();upload=next(part for part in result['parts'] if part['name']=='upload');assert upload['sha256']==hashlib.sha256(allbytes).hexdigest() and upload['filename']=='row.bin';assert result['parts'][0]['name']=='note'
            passed('multipart insertion during read keeps the bytes bound to the original row')
            body.get_by_label('行 1 を削除',exact=True).click();ready('row.bin');result=send();assert result['parts'][0]['sha256']==hashlib.sha256(allbytes).hexdigest()
            body.get_by_label('行 1 の操作',exact=True).click();page.get_by_role('menuitem',name='行を複製',exact=True).click();result=send();assert len(result['parts'])==2 and all(part['sha256']==hashlib.sha256(allbytes).hexdigest() for part in result['parts'])
            body.get_by_label('行 1 を削除',exact=True).click();result=send();assert len(result['parts'])==1
            passed('multipart removal and duplication preserve independent file-row bindings')
            choose('',b'',multiple=[{'name':'日本語.bin','mimeType':'application/octet-stream','buffer':b'\x00\xff'},{'name':'empty-part.bin','mimeType':'application/octet-stream','buffer':b''}]);ready('empty-part.bin');result=send();assert [v['size'] for v in result['parts']]==[2,0];assert result['parts'][0]['filename']=='日本語.bin'
            passed('multipart multi-file selection includes Unicode filenames and empty files')
            page.locator('[name=bodyMode][value=file]').check();choose('relation.bin',allbytes);ready('relation.bin');page.get_by_role('button',name='Binary Aの操作',exact=True).click();page.get_by_role('menuitem',name='リレーションに追加',exact=True).click();page.get_by_label('リレーション名',exact=True).fill('Binary flow');page.locator('#modalSubmit').click();page.get_by_label('全体の回数',exact=True).fill('2');page.locator('.relation-step').first.get_by_label('開始前 ms',exact=True).fill('700')
            count=len(received);page.locator('#runRelation').click();expect(page.locator('#stopRelationGlobal')).to_be_visible();request('Binary A');choose('changed-after-run.bin',b'new file');ready('changed-after-run.bin');side('relations');expect(page.locator('#relationRunLog h2')).to_contain_text('完了',timeout=20000);assert len(received)==count+2;assert all(r['sha256']==hashlib.sha256(allbytes).hexdigest() for r in received[count:])
            passed('repeated relation uses the attachment snapshot captured at run start')
            # Delete confirmation is an in-app dialog and is cancellable with Escape.
            request('Binary B');page.get_by_role('button',name='Binary Bの操作',exact=True).click();page.get_by_role('menuitem',name='削除',exact=True).click();expect(page.locator('.confirm-dialog')).to_be_visible();expect(page.locator('[data-confirm-cancel]')).to_be_focused();shot('confirmation-desktop');page.keyboard.press('Escape');expect(page.locator('.confirm-dialog')).to_have_count(0);expect(page.get_by_role('button',name='Binary Bの操作',exact=True)).to_be_visible()
            page.get_by_role('button',name='Binary Bの操作',exact=True).click();page.get_by_role('menuitem',name='削除',exact=True).click();page.locator('[data-confirm-accept]').click();expect(page.get_by_role('button',name='Binary Bの操作',exact=True)).to_have_count(0)
            passed('application confirmation defaults to Cancel, supports Escape and executes only on confirmation')
            request('Binary A');send(b'new file');shot('binary-desktop')
            for width in [390,320]:
                page.set_viewport_size({'width':width,'height':844});page.locator('#toggleSidebar').click();ys=page.locator('#sidebarTabs button').evaluate_all('nodes=>nodes.map(n=>n.getBoundingClientRect().y)');assert len(set(ys))==1
                for tab in page.locator('#sidebarTabs button').all():tab.scroll_into_view_if_needed();rect=tab.bounding_box();assert rect['x']>=0 and rect['x']+rect['width']<=width
                shot(f'navigation-{width}');page.keyboard.press('Escape');assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');shot(f'binary-{width}')
            passed('320px and 390px navigation stays single-row with reachable tabs and no page overflow')
            assert not errors,errors;assert not dialogs,dialogs;passed('no browser-native dialogs or uncaught JavaScript errors')
            browser.close()
    finally:
        (out/'results.json').write_text(json.dumps({'mode':'DOM fixture + Python HTTP bridge' if fixture.inline else 'native Chromium HTTP','checks':checks,'screenshots':screenshots,'page_errors':errors,'native_dialogs':dialogs,'receiver_requests':len(received)},ensure_ascii=False,indent=2))
        if app:app.shutdown();app.server_close()
        receiver.shutdown();receiver.server_close()
if __name__=='__main__':main()
