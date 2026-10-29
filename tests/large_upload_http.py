"""384/512 MiB HTTP upload verification with a separately measured proxy process."""
from __future__ import annotations
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import resource
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
from test_upload_stream import DigestHandler, QuietApp, http_json, server
from http.server import ThreadingHTTPServer


def measured_proxy(pipe):
    class MeasuredApp(QuietApp):
        def do_GET(self):
            if self.path == '/test/resources':
                return self.send_json(200, {'ok': True, 'max_rss_kib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, 'uploads': len(app.UPLOADS.entries)})
            super().do_GET()
    running=ThreadingHTTPServer(('127.0.0.1',0),MeasuredApp)
    pipe.send(running.server_port);pipe.close();running.serve_forever()


def main():
    context=multiprocessing.get_context('spawn')
    parent,child=context.Pipe(duplex=False)
    proxy=context.Process(target=measured_proxy,args=(child,));proxy.start()
    target=server(DigestHandler);port=parent.recv();results=[]
    try:
        before=http_json(port,'GET','/test/resources')[1]
        block=bytes(range(256))*4096
        for mib in (384,512):
            digest=hashlib.sha256()
            status,created=http_json(port,'POST','/api/uploads',{'sizes':[mib*len(block)]})
            assert status==201,created
            token=created['upload_id']
            for part in range(mib):
                status,chunk=http_json(port,'POST',f'/api/uploads/{token}/0',block,{'Content-Type':'application/octet-stream','X-MiniPost-Offset':str(part*len(block))})
                assert status==200 and chunk['offset']==(part+1)*len(block),chunk
                digest.update(block)
            staged=http_json(port,'GET','/test/resources')[1]
            status,response=http_json(port,'POST','/api/request',{'method':'PUT','url':f'http://127.0.0.1:{target.server_port}/digest','upload_id':token,'body_upload':0,'timeout_ms':0})
            assert status==200 and response['status']==200,response
            received=json.loads(response['body'])
            assert received['size']==mib*len(block) and received['sha256']==digest.hexdigest(),received
            after=http_json(port,'GET','/test/resources')[1]
            assert after['uploads']==0,after
            assert after['max_rss_kib']-before['max_rss_kib'] < 64*1024,(before,after)
            record={'mib':mib,'bytes':received['size'],'sha256':received['sha256'],'peak_proxy_rss_mib':round(after['max_rss_kib']/1024,2), 'rss_growth_mib':round((after['max_rss_kib']-before['max_rss_kib'])/1024,2),'staged_proxy_rss_mib':round(staged['max_rss_kib']/1024,2),'pending_uploads':after['uploads']}
            results.append(record);print(json.dumps(record),flush=True)
    finally:
        target.shutdown();target.server_close();proxy.terminate();proxy.join(5)
    out=Path(os.environ.get('ARTIFACT_DIR','artifacts/large-upload'));out.mkdir(parents=True,exist_ok=True)
    (out/'large-http-results.json').write_text(json.dumps({'mode':'real HTTP; separate proxy process; bounded client and receiver buffers','results':results},indent=2))

if __name__=='__main__':main()
