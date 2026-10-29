"""Binary/file lifecycle + navigation + application confirmations.

Default is native Chromium over HTTP (also supports the two-VM Relay).
MINIPOST_INLINE_TEST=1 is explicitly a DOM fixture with a Python HTTP bridge.
The receive server hashes the actual HTTP bytes; it never echoes expected data.
"""
from __future__ import annotations
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

RECEIVED = []
class ReceiveBytes(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        content_type = self.headers.get('Content-Type', '')
        result = {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'method': self.command, 'content_type': content_type}
        if content_type.startswith('multipart/form-data'):
            message = BytesParser(policy=default).parsebytes(b'Content-Type: ' + content_type.encode() + b'\r\nMIME-Version: 1.0\r\n\r\n' + body)
            result['parts'] = [{'name': part.get_param('name', header='content-disposition'), 'filename': part.get_filename(),
                                'bytes': len(part.get_payload(decode=True)), 'sha256': hashlib.sha256(part.get_payload(decode=True)).hexdigest()}
                               for part in message.iter_parts()]
        RECEIVED.append(result)
        output = json.dumps(result, ensure_ascii=False).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(output)))
        self.end_headers(); self.wfile.write(output)
    do_PUT = do_PATCH = do_POST


def main():
    remote = os.environ.get('MINIPOST_REMOTE_URL')
    if remote:
        peer = os.environ['LOCAL_RELAY_VM_BROWSER_IP']; port = int(os.environ.get('LOCAL_RELAY_VM_BROWSER_PORT') or 18081)
        receiver = ThreadingHTTPServer(('0.0.0.0', port), ReceiveBytes)
        Thread(target=receiver.serve_forever, daemon=True).start(); target = f'http://{peer}:{port}/bytes'
        app, app_url = None, remote
    else:
        receiver, target = start_server(ReceiveBytes); target += '/bytes'
        app, app_url = start_server(proxy.Handler)
    fixture = BrowserApp(app_url)
    output = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-binary-'))) / 'binary-workflows'
    output.mkdir(parents=True, exist_ok=True)
    checks, errors, dialogs, shots = [], [], [], []
    def passed(name): checks.append(name); print('PASS ' + name, flush=True)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width':1440, 'height':920})
            page.set_default_timeout(12000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            def native_dialog(dialog): dialogs.append({'type':dialog.type,'message':dialog.message}); dialog.dismiss()
            page.on('dialog', native_dialog)
            fixture.open(page); expect(page.locator('#connectionStatus')).to_contain_text('connected')
            def import_value(value):
                page.locator('#import').click(); page.get_by_label('インポートJSON',exact=True).fill(json.dumps(value)); page.locator('#modalSubmit').click()
                expect(page.locator('#modalTitle')).to_have_text('インポート完了'); page.locator('#modalSubmit').click()
            def choose(name):
                if page.locator('#sidebarTabs').is_hidden(): page.locator('#toggleSidebar').click()
                page.locator('#sidebarTabs-collections').click()
                page.locator('.tree-open').filter(has=page.locator('.tree-label',has_text=name)).first.click()
                expect(page.locator('#requestName')).to_have_value(name); page.locator('#editor-tab-body').click()
            def pick(name, data, index=None, mime='application/octet-stream'):
                key='binary' if index is None else f'form-{index}'
                picker=page.locator(f'[data-file-slot="{key}"] .file-pick')
                if not picker.count():
                    # Before-fix reproduction: use the original file selection control.
                    picker=page.locator('#request-fields-body').get_by_role('button',name='ファイルを選択',exact=True) if index is None else page.locator('.kv-value .file-pick').nth(index)
                    if not picker.count() and index is None: picker=page.locator('#request-fields-body > button').first
                with page.expect_file_chooser() as selection: picker.click()
                selection.value.set_files({'name':name,'mimeType':mime,'buffer':data})
            def ready(name):
                expect(page.locator('#request-fields-body .file-pick').filter(has_text=name)).to_have_attribute('aria-busy','false')
            def send(data=None):
                page.locator('#send').click(); expect(page.locator('#send')).to_contain_text('Send',timeout=30000)
                expect(page.locator('#responseStatus')).to_contain_text('200')
                result=json.loads(page.locator('.response-code').inner_text())
                if data is not None:
                    assert result['bytes']==len(data),result
                    assert result['sha256']==hashlib.sha256(data).hexdigest(),result
                return result
            def capture(name):
                expect(page.locator('#toast')).to_be_hidden(timeout=15000)
                page.screenshot(path=str(output/(name+'.png')),full_page=True);shots.append(name+'.png')
            def delayed_reads():
                page.evaluate('''() => {
                  window.__releases={};const original=File.prototype.arrayBuffer;
                  File.prototype.arrayBuffer=function(){
                    if(this.name==='unreadable.bin')return Promise.reject(new Error('test read failure'));
                    const value=original.call(this);
                    if(!this.name.startsWith('hold-'))return value;
                    return new Promise((resolve,reject)=>{window.__releases[this.name]=()=>value.then(resolve,reject);});
                  };
                }''')
            sample={'info':{'name':'Binary workflows'},'item':[{'name':name,'request':{'method':'POST','url':target,'body':{'mode':'file'}}} for name in ['Upload A','Upload B']]}
            import_value(sample);choose('Upload A')
            first=bytes([0,1,127,128,254,255]);pick('first.bin',first)
            # Baseline reproduction does not depend on new UI or implementation details.
            if not page.locator('[data-file-slot]').count():
                expect(page.locator('#request-fields-body')).to_contain_text('first.bin')
                send(first);delayed_reads();replacement=b'new selection\x00\xff';pick('hold-replacement.bin',replacement)
                result=send();page.evaluate("window.__releases['hold-replacement.bin']()")
                assert result['sha256']==hashlib.sha256(replacement).hexdigest(),f"BUG: reselect+Send transmitted previous file: {result}"
                return
            ready('first.bin');send(first)
            for data,name in [(b'','empty.bin'),(bytes(range(256))*4,'全バイト.bin'),(bytes(range(256))*24576,'six-mib.bin')]:
                pick(name,data);ready(name);send(data)
            for method in ['PUT','PATCH']:
                page.locator('#method').select_option(method);send(bytes(range(256))*24576)
            page.locator('#method').select_option('POST')
            passed('zero bytes, all 256 byte values, 6 MiB, POST/PUT/PATCH match receiver SHA-256')
            choose('Upload B');count=len(RECEIVED);page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_have_text('ERROR');assert len(RECEIVED)==count
            second=b'B\x00\xff';pick('second.bin',second);ready('second.bin');send(second)
            choose('Upload A');send(bytes(range(256))*24576)
            passed('request switches keep attachments separate and never reuse another request file')
            delayed_reads();replacement=b'new selection\x00\xff';pick('hold-replacement.bin',replacement)
            expect(page.locator('[data-file-slot=binary] .file-pick')).to_have_attribute('aria-busy','true')
            count=len(RECEIVED);page.locator('#send').click();expect(page.locator('#send')).to_contain_text('Cancel');assert len(RECEIVED)==count
            page.evaluate("window.__releases['hold-replacement.bin']()")
            expect(page.locator('#send')).to_contain_text('Send');expect(page.locator('#responseStatus')).to_contain_text('200')
            assert json.loads(page.locator('.response-code').inner_text())['sha256']==hashlib.sha256(replacement).hexdigest()
            passed('Send during replacement read waits and sends the new file, never the old one')
            pick('hold-background.bin',b'background');choose('Upload B')
            page.evaluate("window.__releases['hold-background.bin']()")
            send(second);choose('Upload A');ready('hold-background.bin');send(b'background')
            passed('file read completion updates its originating request even after switching selection')
            pick('hold-older.bin',b'old slow');pick('latest.bin',b'latest');ready('latest.bin')
            page.evaluate("window.__releases['hold-older.bin']()")
            send(b'latest');passed('out-of-order completion cannot overwrite a newer file selection')
            pick('unreadable.bin',b'not read');expect(page.locator('.file-read-error')).to_contain_text('test read failure')
            count=len(RECEIVED);page.locator('#send').click();expect(page.locator('#responseStatus')).to_have_text('ERROR');assert len(RECEIVED)==count
            pick('recovered.bin',b'recovered');ready('recovered.bin');send(b'recovered')
            passed('read failure discards old bytes, blocks transmission, and recovers on reselection')
            pick('hold-cancel.bin',b'cancel wait');count=len(RECEIVED)
            page.locator('#send').click();expect(page.locator('#send')).to_contain_text('Cancel');page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_have_text('CANCELLED');assert len(RECEIVED)==count
            page.evaluate("window.__releases['hold-cancel.bin']()")
            ready('hold-cancel.bin');send(b'cancel wait');passed('Cancel interrupts a pending file send without sending or losing the file')
            # A script waiting before HTTP must not observe a later file selection.
            page.locator('#editor-tab-scripts').click()
            page.get_by_label('送信前スクリプト',exact=True).fill('await new Promise(resolve => setTimeout(resolve, 1200));')
            page.locator('#editor-tab-body').click();pick('snapshot.bin',b'snapshot');ready('snapshot.bin')
            page.locator('#send').click();expect(page.locator('#send')).to_contain_text('Cancel')
            pick('changed-after-send.bin',b'changed');ready('changed-after-send.bin')
            expect(page.locator('#send')).to_contain_text('Send');expect(page.locator('#responseStatus')).to_contain_text('200')
            assert json.loads(page.locator('.response-code').inner_text())['sha256']==hashlib.sha256(b'snapshot').hexdigest()
            page.locator('#editor-tab-scripts').click();page.get_by_label('送信前スクリプト',exact=True).fill('');page.locator('#editor-tab-body').click()
            passed('asynchronous pre-request scripts use the attachment captured at Send')
            # Multipart insertion must move an in-flight selection along with its row.
            page.locator('input[name=bodyMode][value=formdata]').check()
            body=page.locator('#request-fields-body');body.get_by_role('button',name='＋ 行を追加').click()
            body.get_by_label('Key 1',exact=True).fill('upload');body.locator('tbody select').first.select_option('file')
            pick('hold-row.bin',first,index=0)
            body.get_by_role('button',name='行 1 の操作',exact=True).click();page.get_by_role('menuitem',name='この上に行を追加',exact=True).click()
            body.get_by_label('Key 1',exact=True).fill('note');body.get_by_label('Value 1',exact=True).fill('metadata')
            page.evaluate("window.__releases['hold-row.bin']()")
            ready('hold-row.bin');result=send()
            assert [(p['name'],p['sha256']) for p in result['parts']]==[('note',hashlib.sha256(b'metadata').hexdigest()),('upload',hashlib.sha256(first).hexdigest())],result
            body.get_by_role('button',name='行 1 を削除',exact=True).click();result=send()
            assert len(result['parts'])==1 and result['parts'][0]['sha256']==hashlib.sha256(first).hexdigest()
            passed('multipart insertion/deletion keep ready and pending file bytes on their original field')
            with page.expect_file_chooser() as multiple:page.locator('[data-file-slot="form-0"] .file-pick').click()
            multiple.value.set_files([{'name':'empty.dat','mimeType':'application/octet-stream','buffer':b''},
                                      {'name':'日本語.bin','mimeType':'application/octet-stream','buffer':first}])
            ready('empty.dat');result=send()
            assert [(part['filename'],part['bytes'],part['sha256']) for part in result['parts']]==[
                ('empty.dat',0,hashlib.sha256(b'').hexdigest()),('日本語.bin',len(first),hashlib.sha256(first).hexdigest())],result
            passed('multiple multipart files preserve order, Unicode filenames, empty files and receiver hashes')
            pick('hold-deleted-row.bin',b'deleted',index=0)
            body.get_by_role('button',name='行 1 を削除',exact=True).click()
            page.evaluate("window.__releases['hold-deleted-row.bin']()")
            body.get_by_role('button',name='＋ 行を追加').click();body.get_by_label('Key 1',exact=True).fill('new-upload');body.locator('tbody select').first.select_option('file')
            count=len(RECEIVED);page.locator('#send').click();expect(page.locator('#responseStatus')).to_have_text('ERROR');assert len(RECEIVED)==count
            passed('deleting a pending multipart row cannot resurrect its file on a new row')
            page.locator('input[name=bodyMode][value=file]').check();pick('display.bin',first);ready('display.bin');send(first)
            capture('binary-receiver-sha256-desktop')
            for width,height in [(1440,920),(390,844),(320,720)]:
                page.set_viewport_size({'width':width,'height':height})
                if page.locator('#sidebarTabs').is_hidden():page.locator('#toggleSidebar').click()
                tabs=page.locator('#sidebarTabs button').all();boxes=[tab.bounding_box() for tab in tabs]
                assert max(b['y'] for b in boxes)-min(b['y'] for b in boxes)<1,boxes
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                if width==1440:
                    bounds=page.locator('#sidebarTabs').bounding_box();assert all(b['x']>=bounds['x'] and b['x']+b['width']<=bounds['x']+bounds['width']+1 for b in boxes),boxes
                capture('single-row-navigation-'+str(width))
                if width<820:page.locator('#navClose').click()
            passed('all four sidebar categories stay on one row at desktop and phone widths')
            page.set_viewport_size({'width':1440,'height':920})
            # Test the smallest resizable sidebar, including keyboard scroll to the last tab.
            page.locator('#sidebarResize').focus();page.keyboard.press('Home')
            page.locator('#sidebarTabs-collections').focus();page.keyboard.press('End')
            last=page.locator('#sidebarTabs-relations');expect(last).to_be_focused()
            b=last.bounding_box();nav=page.locator('#sidebarTabs').bounding_box();assert b['x']>=nav['x']-1 and b['x']+b['width']<=nav['x']+nav['width']+1
            page.locator('#sidebarResize').focus();page.keyboard.press('ArrowRight');page.keyboard.press('ArrowRight');page.keyboard.press('ArrowRight')
            passed('minimum sidebar width scrolls a single row and keyboard navigation reveals the selected category')
            choose('Upload A');expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
            fixture.reload(page);expect(page.locator('#connectionStatus')).to_contain_text('connected')
            choose('Upload A');expect(page.locator('[data-file-slot=binary]')).to_contain_text('再選択')
            count=len(RECEIVED);page.locator('#send').click();expect(page.locator('#responseStatus')).to_have_text('ERROR');assert len(RECEIVED)==count
            pick('reload-selected.bin',first);ready('reload-selected.bin');send(first)
            passed('reload explicitly requires file reselection, then sends the selected bytes correctly')
            # Native file chooser cancellation is non-destructive.
            with page.expect_file_chooser() as selection:page.locator('[data-file-slot=binary] .file-pick').click()
            selection.value.element.dispatch_event('cancel');send(first)
            passed('cancelling the file chooser preserves the last selected file')
            # Application confirmations: Cancel/Escape preserve, accept deletes, no browser dialogs.
            for method in ['cancel','escape','accept']:
                page.get_by_role('button',name='Upload Bの操作',exact=True).click();page.get_by_role('menuitem',name='削除',exact=True).click()
                confirm=page.locator('#appConfirm');expect(confirm).to_be_visible();expect(confirm.get_by_role('button',name='キャンセル')).to_be_focused()
                assert confirm.evaluate("e=>e.matches(':modal')")
                if method=='cancel':confirm.get_by_role('button',name='キャンセル').click()
                elif method=='escape':page.keyboard.press('Escape')
                else:
                    capture('request-delete-confirmation-desktop');confirm.get_by_role('button',name='削除',exact=True).click()
                expect(confirm).to_have_count(0)
                if method!='accept':expect(page.get_by_role('button',name='Upload Bの操作',exact=True)).to_be_visible()
            expect(page.get_by_role('button',name='Upload Bの操作',exact=True)).to_have_count(0)
            passed('request deletion uses the app dialog, cancel/Escape are non-destructive, and only accept deletes')
            import_value({'name':'Delete env','_postman_variable_scope':'environment','values':[]})
            page.locator('#sidebarTabs-environments').click();page.get_by_role('button',name='Delete envの操作',exact=True).click()
            page.get_by_role('menuitem',name='削除',exact=True).click();page.locator('#appConfirm').get_by_role('button',name='削除',exact=True).click()
            expect(page.locator('#environment')).to_have_value('')
            page.locator('[data-scope=primary] .tree-open').click();page.locator('#workspacePage').get_by_role('button',name='すべて消去',exact=True).click()
            page.locator('#appConfirm').get_by_role('button',name='キャンセル').click()
            passed('environment deletion and primary-variable clearing use application confirmations')
            choose('Upload A');page.locator('#sidebarTabs-history').click();page.locator('#clearHistory').click()
            page.set_viewport_size({'width':320,'height':720});capture('history-confirmation-320')
            page.locator('#appConfirm').get_by_role('button',name='キャンセル').click()
            page.set_viewport_size({'width':1440,'height':920});expect(page.locator('.history-entry').first).to_be_visible()
            page.locator('#clearHistory').click();page.locator('#appConfirm').get_by_role('button',name='削除',exact=True).click()
            expect(page.locator('.history-entry')).to_have_count(0)
            passed('history clearing is confirmed inside the app at phone width with cancellation preserving history')
            choose('Upload A');page.locator('#requestName').fill('Upload revised');expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
            page.locator('#requestHistory').click();page.locator('.revision-entry').last.locator('summary').click()
            page.locator('.revision-entry').last.get_by_role('button',name='この版を復元',exact=True).click()
            expect(page.locator('#modal')).to_be_visible();expect(page.locator('#appConfirm')).to_be_visible()
            page.locator('#appConfirm').get_by_role('button',name='キャンセル').click();expect(page.locator('#modal')).to_be_visible()
            page.locator('.revision-entry').last.get_by_role('button',name='この版を復元',exact=True).click();page.locator('#appConfirm').get_by_role('button',name='復元',exact=True).click()
            expect(page.locator('#appConfirm')).to_have_count(0);page.locator('#closeModal').click()
            passed('revision restore confirmation stacks above the history drawer without closing it on cancellation')
            # Remaining destructive paths also use the same application dialog.
            page.get_by_role('button',name='Untitled requestの下書き操作',exact=True).click()
            page.get_by_role('menuitem',name='下書きを削除',exact=True).click()
            page.locator('#appConfirm').get_by_role('button',name='削除',exact=True).click()
            expect(page.get_by_role('button',name='Untitled requestの下書き操作',exact=True)).to_have_count(0)
            import_value({'info':{'name':'Delete tree'},'item':[{'name':'Delete folder','item':[{'name':'Inside folder','request':{'method':'GET','url':target}}]}]})
            for button_name in ['Delete folderの操作','Delete treeの設定']:
                page.get_by_role('button',name=button_name,exact=True).click();page.get_by_role('menuitem',name='削除',exact=True).click()
                page.locator('#appConfirm').get_by_role('button',name='削除',exact=True).click()
                expect(page.get_by_role('button',name=button_name,exact=True)).to_have_count(0)
            passed('draft, folder and collection deletion all use application confirmations')
            page.locator('#sidebarTabs-environments').click();page.locator('[data-scope=primary] .tree-open').click()
            page.locator('#workspacePage').get_by_role('button',name='＋ 行を追加').click()
            page.locator('#workspacePage').get_by_label('Key 1',exact=True).fill('clear-me')
            page.locator('#workspacePage').get_by_label('Value 1',exact=True).fill('session-value')
            page.locator('[data-scope=primary] .icon-button').click();page.get_by_role('menuitem',name='すべて消去',exact=True).click()
            page.locator('#appConfirm').get_by_role('button',name='削除',exact=True).click()
            expect(page.locator('#workspacePage .kv-data-row')).to_have_count(0)
            page.locator('#sidebarTabs-relations').click();page.locator('#sidebarAdd').click()
            page.get_by_role('menuitem',name='リレーションを作成',exact=True).click()
            page.locator('#modal').get_by_label('リレーション名',exact=True).fill('Delete flow');page.locator('#modalSubmit').click()
            page.get_by_role('button',name='Delete flowの操作',exact=True).click();page.get_by_role('menuitem',name='削除',exact=True).click()
            page.locator('#appConfirm').get_by_role('button',name='削除',exact=True).click()
            expect(page.get_by_role('button',name='Delete flowの操作',exact=True)).to_have_count(0)
            passed('primary context clear and relation deletion require in-app confirmation')
            assert not dialogs,dialogs;assert not errors,errors
            passed('no browser-native alert/confirm/prompt or uncaught JavaScript errors')
            browser.close()
    finally:
        (output/'results.json').write_text(json.dumps({'mode':'DOM fixture + Python HTTP bridge' if fixture.inline else 'native Chromium HTTP',
            'checks':checks,'page_errors':errors,'native_dialogs':dialogs,'screenshots':shots,'received_requests':len(RECEIVED)},ensure_ascii=False,indent=2))
        if app:app.shutdown();app.server_close()
        receiver.shutdown();receiver.server_close()
if __name__=='__main__':main()
