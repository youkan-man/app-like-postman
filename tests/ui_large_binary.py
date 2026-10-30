"""Native Chromium: disk-backed >300 MiB files through real MiniPost HTTP.

No inline bridge, mocked network response, Base64 fixture, or full-file Python
buffer. Test payloads are generated outside the published artifact directory.
"""
from __future__ import annotations
import contextlib
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from urllib.request import urlopen
from http.server import ThreadingHTTPServer
from playwright.sync_api import expect, sync_playwright
from test_upload_stream import DigestHandler

ROOT = Path(__file__).resolve().parents[1]
BLOCK = bytes(range(256)) * 4096


def generate(path, mib):
    digest = hashlib.sha256()
    with path.open('wb') as output:
        for _ in range(mib):
            output.write(BLOCK); digest.update(BLOCK)
    return digest.hexdigest()


def main():
    if os.getenv('MINIPOST_INLINE_TEST'):
        raise RuntimeError('This suite requires native browser HTTP and disk-backed files.')
    app_url = os.environ['MINIPOST_REMOTE_URL']
    peer = os.environ['LOCAL_RELAY_VM_BROWSER_IP']
    receiver = ThreadingHTTPServer(('0.0.0.0', int(os.getenv('LOCAL_RELAY_VM_BROWSER_PORT','18081'))), DigestHandler)
    threading.Thread(target=receiver.serve_forever, daemon=True).start()
    endpoint = f'http://{peer}:{receiver.server_port}/digest'
    out = Path(os.getenv('ARTIFACT_DIR','.local_relay/output')) / 'large-binary'
    out.mkdir(parents=True,exist_ok=True)
    checks, errors, dialogs, crashes, records, shots = [], [], [], [], [], []
    def passed(name):
        checks.append(name); print('PASS '+name,flush=True)
    def resources():
        with urlopen(app_url+'/__relay_test_resources',timeout=10) as response:
            return json.load(response)
    before = resources()
    try:
        with tempfile.TemporaryDirectory(prefix='minipost-large-fixtures-') as temp, sync_playwright() as p:
            paths = {mib: Path(temp)/f'大容量-{mib}MiB.bin' for mib in (384,512)}
            hashes = {mib:generate(path,mib) for mib,path in paths.items()}
            empty = Path(temp)/'empty.bin';empty.write_bytes(b'')
            browser = p.chromium.launch(executable_path=os.getenv('CHROMIUM'),headless=True,args=['--no-sandbox'])
            page = browser.new_page(viewport={'width':1440,'height':920})
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('crash',lambda:crashes.append('renderer crashed'))
            page.on('dialog',lambda d:(dialogs.append(d.type),d.dismiss()))
            page.goto(app_url,wait_until='domcontentloaded')
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            collection={'info':{'name':'Large file verification','schema':'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},'item':[
                {'name':'Large binary upload','request':{'method':'PUT','url':endpoint,'body':{'mode':'file'}},'settings':{'timeout_ms':0,'verify_tls':False,'follow_redirects':True}}]}
            page.locator('#import').click();page.get_by_label('インポートJSON').fill(json.dumps(collection))
            page.locator('#modalSubmit').click();expect(page.locator('#modalTitle')).to_have_text('インポート完了');page.locator('#modalSubmit').click()
            page.locator('#editor-tab-body').click()
            # Instrument actual file reads and completed native HTTP requests.
            # This does not supply or substitute any response bytes.
            page.evaluate('''() => {
              window.__largestArrayBuffer=0; window.__uploadChunks=0;
              const read=Blob.prototype.arrayBuffer;
              Blob.prototype.arrayBuffer=function(){
                window.__largestArrayBuffer=Math.max(window.__largestArrayBuffer,this.size);
                if(this.size>65536)throw Error('Full-file arrayBuffer read forbidden by test');
                return read.call(this);
              };
              const nativeFetch=window.fetch.bind(window);
              window.fetch=async(...args)=>{
                const response=await nativeFetch(...args);
                if(/^\\/api\\/uploads\\/[a-f0-9]+\\/\\d+$/.test(String(args[0]))&&response.ok)window.__uploadChunks++;
                return response;
              };
            }''')
            cdp=page.context.new_cdp_session(page)
            heap_baseline=cdp.send('Runtime.getHeapUsage')['usedSize'];heap_max=heap_baseline
            def pick(paths, slot='binary'):
                with page.expect_file_chooser() as chosen:
                    page.locator(f'[data-file-slot="{slot}"] .file-pick').click()
                chosen.value.set_files([str(path) for path in paths])
                expect(page.locator(f'[data-file-slot="{slot}"] .file-pick')).to_have_attribute('aria-busy','false',timeout=15000)
            def send():
                nonlocal heap_max
                page.locator('#send').click()
                deadline=time.monotonic()+240
                while 'Cancel' in page.locator('#send').inner_text():
                    assert time.monotonic()<deadline,'upload deadline exceeded'
                    heap_max=max(heap_max,cdp.send('Runtime.getHeapUsage')['usedSize'])
                    page.wait_for_timeout(100)
                expect(page.locator('#responseStatus')).to_contain_text('200',timeout=10000)
                return json.loads(page.locator('.response-code').inner_text())
            for mib in (384,512):
                pick([paths[mib]])
                result=send()
                assert result['size']==mib*1024*1024 and result['sha256']==hashes[mib],result
                assert result['method']=='PUT',result
                measured=resources();assert measured['pending_uploads']==0,measured
                records.append({'mode':'binary','mib':mib,'receiver':result,'proxy_resources':measured})
                passed(f'{mib} MiB disk file PUT: receiver length and SHA-256 match')
            page.screenshot(path=str(out/'binary-512MiB-desktop.png'),full_page=True);shots.append('binary-512MiB-desktop.png')
            # Same bounded path for multipart; verify the complete actual wire body
            # including both file parts, Unicode names and generated framing.
            page.locator('input[name=bodyMode][value=formdata]').check()
            body=page.locator('#request-fields-body')
            body.get_by_role('button',name='＋ 行を追加',exact=True).click()
            body.get_by_label('Key 1',exact=True).fill('firmware')
            body.locator('tbody tr').first.locator('select').select_option('file')
            pick([paths[384],empty],'form-0')
            result=send()
            boundary=result['content_type'].split('boundary=',1)[1]
            expected=hashlib.sha256();size=0
            for path in (paths[384],empty):
                head=(f'--{boundary}\r\nContent-Disposition: form-data; name="firmware"; filename="{path.name}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
                expected.update(head);size+=len(head)
                with path.open('rb') as file:
                    while data:=file.read(65536):expected.update(data);size+=len(data)
                expected.update(b'\r\n');size+=2
            tail=f'--{boundary}--\r\n'.encode();expected.update(tail);size+=len(tail)
            assert result['size']==size and result['sha256']==expected.hexdigest(),result
            records.append({'mode':'multipart','file_mib':384,'receiver':result})
            passed('384 MiB multipart plus empty file: complete wire length and SHA-256 match')
            # Throttle real upload traffic to create a deterministic Cancel window.
            page.locator('input[name=bodyMode][value=file]').check()
            count=len(DigestHandler.records);prior_chunks=page.evaluate('__uploadChunks')
            cdp.send('Network.enable')
            cdp.send('Network.emulateNetworkConditions',{'offline':False,'latency':1,'downloadThroughput':-1,'uploadThroughput':4*1024*1024})
            page.locator('#send').click()
            page.wait_for_function('(count)=>window.__uploadChunks>count',arg=prior_chunks,timeout=20000)
            page.locator('#send').click();expect(page.locator('#responseStatus')).to_have_text('CANCELLED',timeout=10000)
            cdp.send('Network.emulateNetworkConditions',{'offline':False,'latency':0,'downloadThroughput':-1,'uploadThroughput':-1})
            deadline=time.monotonic()+10
            while resources()['pending_uploads']:
                assert time.monotonic()<deadline,'aborted upload was not cleaned up'
                page.wait_for_timeout(100)
            assert len(DigestHandler.records)==count,'cancelled staging sent a target request'
            passed('Cancel during 512 MiB upload removes staging without sending to the target')
            result=send();assert result['sha256']==hashes[512] and result['size']==512*1024*1024,result
            passed('explicit resend after cancellation uses the still-selected 512 MiB file')
            after=resources()
            assert after['pending_uploads']==0,after
            assert after['max_rss_kib']-before['max_rss_kib']<64*1024,(before,after)
            assert heap_max-heap_baseline<128*1024*1024,(heap_baseline,heap_max)
            assert page.evaluate('__largestArrayBuffer')<=65536
            passed('bounded file reads and JS/proxy memory; no full-file buffers or remaining uploads')
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=str(out/'binary-512MiB-phone.png'),full_page=True);shots.append('binary-512MiB-phone.png')
            assert not errors and not dialogs and not crashes,(errors,dialogs,crashes)
            passed('UI stays usable; no native dialogs, page exceptions or renderer crashes')
            (out/'results.json').write_text(json.dumps({'mode':'native Chromium HTTP; disk-backed files; two VM peers','checks':checks,'records':records,'proxy_before':before,'proxy_after':after,'js_heap_baseline_bytes':heap_baseline,'js_heap_peak_bytes':heap_max,'largest_array_buffer_read':page.evaluate('__largestArrayBuffer'),'page_errors':errors,'native_dialogs':dialogs,'crashes':crashes,'screenshots':shots},ensure_ascii=False,indent=2))
            browser.close()
    finally:
        receiver.shutdown();receiver.server_close()
        if not (out/'results.json').exists():
            (out/'failed-checks.json').write_text(json.dumps({'checks':checks,'page_errors':errors,'dialogs':dialogs,'crashes':crashes},indent=2))

if __name__=='__main__':main()
