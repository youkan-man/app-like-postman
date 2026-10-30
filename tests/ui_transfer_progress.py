"""Native HTTP: throttle upload, hold the receiver, and observe actual UI progress."""
from __future__ import annotations
import contextlib
import hashlib
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect
from test_upload_stream import QuietApp, server


class Receiver(BaseHTTPRequestHandler):
    body_ready = threading.Event()
    body_release = threading.Event()
    response_ready = threading.Event()
    response_release = threading.Event()
    receipts = []
    def log_message(self, *_args): pass
    def receive(self):
        self.connection.settimeout(30)
        self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 65536)
        length = int(self.headers.get('Content-Length','0')); received=0; digest=hashlib.sha256()
        while received < length:
            data=self.rfile.read(min(65536,length-received))
            if not data: return
            digest.update(data); received+=len(data)
            if self.path=='/slow' and received==len(data):
                self.body_ready.set(); self.body_release.wait(25)
        row={'size':received,'sha256':digest.hexdigest(),'path':self.path}
        self.receipts.append(row)
        if self.path=='/slow':
            self.response_ready.set(); self.response_release.wait(25)
        if self.path=='/fail':
            self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
        body=json.dumps(row).encode()
        self.send_response(200);self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(body)));self.end_headers()
        with contextlib.suppress(BrokenPipeError,ConnectionResetError):self.wfile.write(body)
    do_POST=do_GET=receive


def main():
    if os.getenv('MINIPOST_INLINE_TEST'):raise RuntimeError('Progress acceptance requires native HTTP.')
    local=None
    if os.getenv('MINIPOST_REMOTE_URL'):
        app_url=os.environ['MINIPOST_REMOTE_URL'];host=os.environ['LOCAL_RELAY_VM_BROWSER_IP']
        receiver=ThreadingHTTPServer(('0.0.0.0',int(os.getenv('LOCAL_RELAY_VM_BROWSER_PORT','18081'))),Receiver)
    else:
        local=server(QuietApp);app_url=f'http://127.0.0.1:{local.server_port}';host='127.0.0.1'
        receiver=ThreadingHTTPServer(('127.0.0.1',0),Receiver)
    threading.Thread(target=receiver.serve_forever,daemon=True).start()
    target=f'http://{host}:{receiver.server_port}'
    out=Path(os.getenv('ARTIFACT_DIR','.local_relay/output'))/'transfer-progress';out.mkdir(parents=True,exist_ok=True)
    checks=[];errors=[];dialogs=[];shots=[]
    report={'mode':'native Chromium HTTP','checks':checks,'page_errors':errors,'native_dialogs':dialogs,'screenshots':shots}
    def passed(name):checks.append(name);print('PASS '+name,flush=True)
    try:
        with tempfile.TemporaryDirectory(prefix='minipost-progress-') as temp, sync_playwright() as p:
            file=Path(temp)/'転送確認-32MiB.bin';block=bytes(range(256))*4096;digest=hashlib.sha256()
            with file.open('wb') as output:
                for _ in range(32):output.write(block);digest.update(block)
            browser=p.chromium.launch(executable_path=os.getenv('CHROMIUM'),headless=True,args=['--no-sandbox'])
            page=browser.new_page(viewport={'width':1440,'height':920})
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.on('dialog',lambda dialog:(dialogs.append(dialog.type),dialog.dismiss()))
            page.goto(app_url,wait_until='domcontentloaded');expect(page.locator('#connectionStatus')).to_contain_text('connected')
            sample={'info':{'name':'Transfer progress verification','schema':'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},'item':[
                {'name':'Large transfer A','request':{'method':'POST','url':target+'/slow','body':{'mode':'file'}},'settings':{'timeout_ms':0}},
                {'name':'Quick request B','request':{'method':'GET','url':target+'/digest','body':{'mode':'none'}}}]}
            page.locator('#import').click();page.get_by_label('インポートJSON').fill(json.dumps(sample));page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_have_text('インポート完了');page.locator('#modalSubmit').click();page.locator('#editor-tab-body').click()
            def choose(name):
                if not page.locator('#sidebarContent').is_visible():page.locator('#toggleSidebar').click()
                page.locator('.tree-open').filter(has=page.locator('.tree-label',has_text=name)).first.click()
                expect(page.locator('#requestName')).to_have_value(name)
            def capture(name):
                page.screenshot(path=str(out/(name+'.png')),full_page=True);shots.append(name+'.png')
            with page.expect_file_chooser() as picker:page.locator('[data-file-slot=binary] .file-pick').click()
            picker.value.set_files(str(file));expect(page.locator('[data-file-slot=binary] .file-pick')).to_have_attribute('aria-busy','false')
            cdp=page.context.new_cdp_session(page);cdp.send('Network.enable')
            cdp.send('Network.emulateNetworkConditions',{'offline':False,'latency':0,'downloadThroughput':-1,'uploadThroughput':4*1048576})
            baseline=page.locator('#url').bounding_box();page.locator('#send').click()
            progress=page.locator('#transferProgress');bar=progress.locator('progress')
            expect(progress).to_have_attribute('data-visible','true',timeout=10000)
            expect(progress).to_have_attribute('data-phase','upload')
            page.wait_for_function("(()=>{const p=document.querySelector('#transferProgress progress');return p&&p.value>0&&p.value<p.max})()")
            expect(progress).to_contain_text('MiB');expect(progress).to_contain_text('%')
            capture('upload-desktop')
            current=page.locator('#url').bounding_box();assert current['y']==baseline['y'] and current['height']==baseline['height']
            passed('slow native upload shows measured bytes, percentage and progress without shifting the request editor')
            page.set_viewport_size({'width':320,'height':720})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');expect(bar).to_be_visible()
            capture('upload-320');passed('320px progress text and bar remain readable without horizontal page overflow')
            cdp.send('Network.emulateNetworkConditions',{'offline':False,'latency':0,'downloadThroughput':-1,'uploadThroughput':-1})
            assert Receiver.body_ready.wait(10)
            expect(progress).to_have_attribute('data-phase','send',timeout=15000)
            page.wait_for_function("(()=>{const p=document.querySelector('#transferProgress progress');return p&&p.value>0&&p.value<p.max})()")
            expect(progress).to_contain_text('送信先へ転送中');capture('target-send-320')
            passed('backend-to-target bytes are distinct from completed browser upload and are not reported as overall completion')
            page.set_viewport_size({'width':1440,'height':920})
            choose('Quick request B');expect(page.locator('#transferProgress')).to_have_count(0)
            page.locator('#send').click();expect(page.locator('#responseStatus')).to_contain_text('200')
            expect(page.locator('#transferProgress')).to_have_count(0)
            choose('Large transfer A');expect(progress).to_have_attribute('data-phase','send')
            passed('switching requests and sending B does not replace A progress or show it on B')
            Receiver.body_release.set();assert Receiver.response_ready.wait(15)
            expect(progress).to_have_attribute('data-phase','waiting',timeout=5000)
            expect(progress).to_contain_text('応答待ち');assert bar.get_attribute('value') is None
            capture('response-wait-desktop')
            receipt=Receiver.receipts[-1];assert receipt['size']==32*1048576 and receipt['sha256']==digest.hexdigest(),receipt
            report['receiver']=receipt
            passed('fully sent bytes switch to indeterminate response waiting, with actual receiver size and SHA-256 verified')
            page.locator('#send').click();expect(page.locator('#responseStatus')).to_have_text('CANCELLED',timeout=10000)
            expect(page.locator('#transferProgress')).to_have_count(0);Receiver.response_release.set()
            passed('Cancel during response waiting removes progress and never displays success')
            page.locator('#url').fill(target+'/digest');page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_contain_text('200',timeout=20000)
            expect(page.locator('#transferProgress')).to_have_count(0)
            result=json.loads(page.locator('.response-code').inner_text());assert result['sha256']==digest.hexdigest()
            passed('an explicit resend starts fresh, completes and removes all progress UI')
            page.locator('#url').fill(target+'/fail');page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_contain_text('ERROR',timeout=20000)
            expect(page.locator('#transferProgress')).to_have_count(0);expect(page.locator('#send')).to_contain_text('Send')
            passed('a target connection failure clears progress and restores Send without automatic resend')
            choose('Quick request B')
            page.evaluate('''() => {window.__progressShown=0;new MutationObserver(()=>{
                if(document.querySelector('#transferProgress[data-visible="true"]'))window.__progressShown++;
              }).observe(document.querySelector('#responseContent'),{subtree:true,childList:true,attributes:true});}''')
            page.locator('#send').click();expect(page.locator('#responseStatus')).to_contain_text('200')
            page.wait_for_timeout(850);assert page.evaluate('__progressShown')==0
            passed('short requests do not flash a delayed progress bar after they finish')
            assert not errors and not dialogs,(errors,dialogs)
            passed('no browser-native dialogs or uncaught JavaScript errors')
            browser.close()
    finally:
        Receiver.body_release.set();Receiver.response_release.set()
        receiver.shutdown();receiver.server_close()
        if local:local.shutdown();local.server_close()
        (out/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
