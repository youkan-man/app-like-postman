"""Validate both directions of MiniPost's traffic through two retained Local Relay VMs."""
import json
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.request import Request, urlopen

app = os.environ['MINIPOST_REMOTE_URL'].rstrip('/')
peer = os.environ['LOCAL_RELAY_VM_BROWSER_IP']
app_peer = os.environ['LOCAL_RELAY_VM_APP_IP']
if app_peer == peer:
    raise RuntimeError('Both VM roles resolve to the same peer; not a two-VM test')
port = int(os.environ.get('LOCAL_RELAY_VM_BROWSER_PORT') or 18081)

class Echo(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        body = b'{"origin":"browser-vm","probe":"two-vm","ok":true}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

server = ThreadingHTTPServer(('0.0.0.0', port), Echo)
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with urlopen(app+'/api/health', timeout=8) as response:
        health = json.load(response)
        assert response.status == 200 and health['ok'], health
    with urlopen(app+'/', timeout=8) as response:
        source = response.read().decode('utf-8')
        assert response.status == 200 and 'MiniPost' in source, source[:150]
    payload = {'method': 'GET', 'url': f'http://{peer}:{port}/cross-vm-echo', 'timeout_ms': 8000}
    request = Request(app+'/api/request',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'},method='POST')
    with urlopen(request,timeout=12) as response:
        proxied=json.load(response)
        assert response.status == 200 and proxied['ok'] and proxied['status'] == 200, proxied
        assert json.loads(proxied['body'])['origin']=='browser-vm', proxied
    evidence={'ok':True,'app_http':True,'cross_vm_proxy':True,'two_way':True,'app_peer':'provider-injected','echo_port':port,'mode':'Local Relay VM private peer networking'}
    Path('.local_relay/output/two-vm-network.json').write_text(json.dumps(evidence,indent=2))
    print('PASS cross-VM HTTP browser->app and app->browser-echo')
finally:
    server.shutdown()
    server.server_close()
