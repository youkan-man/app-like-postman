"""Actual COM Gateway outside MiniPost's container, via shipped Compose configurations."""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import urlopen

from docker_network import DockerApp, OUT, ROOT, free_port


SCRIPT = """
import fs from 'node:fs';
import {importPostman,walkItems,compileRequest} from './static/core.mjs';
const options=JSON.parse(fs.readFileSync(0,'utf8'));
const c=importPostman(fs.readFileSync('examples/com-gateway.postman_collection.json','utf8')).collections[0];
const env={id:'test',values:Object.entries(options).map(([key,value])=>({key,value}))};
const ws={collections:[c],globals:[],environments:[env],environmentId:'test'};
const result=[];
walkItems(c.item,item=>{if(item.request)result.push({name:item.name,payload:compileRequest(ws,{collectionId:c._mpId,itemId:item._mpId,request:item.request}).payload});});
process.stdout.write(JSON.stringify(result));
"""


def browser_gateway(app, base, token, mode):
    from playwright.sync_api import expect, sync_playwright
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 920})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(app.url)
        expect(page.locator('#connectionStatus')).to_contain_text('connected')
        collection = json.loads((ROOT / 'examples/com-gateway.postman_collection.json').read_text())
        environment = {'name': 'Real Gateway outside Docker', '_postman_variable_scope': 'environment', 'values': [
            {'key': 'baseUrl', 'value': base, 'enabled': True}, {'key': 'gatewayToken', 'value': token, 'enabled': True}]}
        for value in [collection, environment]:
            page.locator('#import').click(); page.get_by_label('Postman JSON').fill(json.dumps(value)); page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_have_text('インポート完了'); page.locator('#modalSubmit').click()
        page.locator('#loopbackTarget').select_option('docker-host' if mode == 'bridge' else 'direct')
        page.locator('#send').click()
        expect(page.locator('#responseStatus')).to_contain_text('200')
        assert json.loads(page.locator('.response-code').inner_text())['status'] == 'ok'
        page.screenshot(path=str(OUT / f'real-gateway-{mode}.png'), full_page=True)
        assert not errors, errors
        browser.close()


def main():
    checkout = Path(os.environ.get('GATEWAY_CHECKOUT', '__missing_gateway_checkout__')).resolve()
    if not (checkout / 'gateway/app.py').is_file():
        raise SystemExit('Set GATEWAY_CHECKOUT to an app-com-transport-gateway checkout.')
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    for mode in ['bridge', 'host']:
        with tempfile.TemporaryDirectory(prefix='minipost-real-gateway-') as data:
            port, token = free_port(), secrets.token_urlsafe(48)
            # This instance is disposable; no production configuration or device access.
            env = {k: v for k, v in os.environ.items() if not k.startswith(('GATEWAY_', 'USB_AGENT_'))}
            env.update(GATEWAY_DATA_DIR=data, GATEWAY_ADMIN_TOKEN=token, PYTHONPATH=str(checkout))
            with open(OUT / f'gateway-{mode}.log', 'w+') as log:
                child = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'gateway.app:app', '--host', '0.0.0.0' if mode == 'bridge' else '127.0.0.1', '--port', str(port)], cwd=checkout, env=env, stdout=log, stderr=log)
                try:
                    for _ in range(150):
                        if child.poll() is not None:
                            raise RuntimeError('Gateway exited before readiness; see gateway log.')
                        try:
                            with urlopen(f'http://127.0.0.1:{port}/healthz', timeout=.5) as response:
                                assert json.load(response)['status'] == 'ok'
                            break
                        except (URLError, OSError):
                            time.sleep(.1)
                    else:
                        raise RuntimeError('Gateway did not become ready.')
                    base = f'http://localhost:{port}'
                    compiled = subprocess.run(['node', '--input-type=module', '-e', SCRIPT], cwd=ROOT,
                        input=json.dumps({'baseUrl': base, 'gatewayToken': token, 'portId': f'minipost-{mode}-demo'}),
                        capture_output=True, text=True, check=True)
                    cases = json.loads(compiled.stdout)
                    assert len(cases) == 12
                    gateway_ns = os.readlink(f'/proc/{child.pid}/ns/net')
                    with DockerApp('minipost-real-gateway-' + mode, host=mode == 'host') as app:
                        assert (app.netns == gateway_ns) == (mode == 'host')
                        if mode == 'bridge':
                            status, error = app.request(**cases[0]['payload'])
                            assert status == 502 and error['diagnostic']['code'] == 'CONNECTION_REFUSED', error
                            print('PASS reproduce container-localhost 502 before explicit host routing', flush=True)
                        for case in cases:
                            status, result = app.request(**case['payload'], loopback_target='docker-host' if mode == 'bridge' else 'direct')
                            expected = 201 if case['name'] == 'Create demo port' else 401 if case['name'].startswith('Unauthenticated') else 200
                            assert status == 200 and result['ok'] and result['status'] == expected, (case['name'], result)
                            body = json.loads(result['body'])
                            if case['name'] == 'Start demo port': assert body['state'] == 'running'
                            if case['name'] == 'Stop demo port': assert body['state'] == 'stopped'
                            if case['name'].startswith('Login'): assert any(h['key'].lower() == 'set-cookie' for h in result['headers'])
                            if mode == 'bridge':
                                assert result['network']['connect_host'] == 'host.docker.internal'
                            results.append({'mode': mode, 'name': case['name'], 'http_status': expected, 'network': result['network'], 'gateway_pid': child.pid, 'gateway_netns': gateway_ns, 'minipost_netns': app.netns})
                            print(f"PASS {mode}: {case['name']} -> {expected}", flush=True)
                        browser_gateway(app, base, token, mode)
                        print(f'PASS actual browser → Docker ({mode}) → real Gateway', flush=True)
                finally:
                    if child.poll() is None:
                        child.terminate()
                        try: child.wait(timeout=10)
                        except subprocess.TimeoutExpired: child.kill(); child.wait()
                    (OUT / 'gateway-results.json').write_text(json.dumps({'passed': len(results), 'checks': results, 'physical_devices': False}, indent=2))
    print('PASS 24 real-Gateway requests through two Docker configurations; 2 real browser scenarios.')


if __name__ == '__main__':
    main()
