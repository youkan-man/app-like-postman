"""Local Relay three-VM acceptance: C browser -> A published URL -> B published URL.

No control-plane credentials, target rewriting, browser fetch mocks or automatic
POST retries. B is a live, test-only HTTP receiver, not the private COM Gateway.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[2]
STATE = Path('/srv/app/minipost-relay-ci')
OUT = ROOT / '.local_relay/output'
UNIT_B = 'minipost-relay-ci-receiver'
PROJECT = 'minipost-relay-ci'
DIRECT = build_opener(ProxyHandler({}))
MAX_BODY = 1024 * 1024


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(*args: str, timeout: int = 900) -> str:
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{args[0]} exited {result.returncode}: {result.stdout[-5000:]}')
    return result.stdout


def role() -> str:
    value = os.environ.get('LOCAL_RELAY_VM_NAME', '')
    if value not in {'a', 'b', 'c'}:
        raise RuntimeError('This step requires a Local Relay a/b/c VM reservation.')
    return value


def identity() -> dict:
    return {
        'role': role(),
        'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
        'test_source_sha256': digest(Path(__file__).read_bytes()),
        'app_js_sha256': digest((ROOT / 'static/app.js').read_bytes()),
    }


def get_json(url: str) -> dict:
    with DIRECT.open(url, timeout=5) as response:
        return json.load(response)


def ready(url: str) -> dict:
    # Read-only readiness can be polled. POSTs below are never replayed.
    deadline = time.monotonic() + 45
    while True:
        try:
            return get_json(url)
        except (OSError, ValueError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(.5)


def public_urls(env: dict[str, str]) -> dict[str, str]:
    """Require explicit published metadata; never infer it from guest IP/port."""
    urls = {}
    for member in ('a', 'b'):
        key = f'LOCAL_RELAY_VM_{member.upper()}_PUBLIC_URL'
        value = env.get(key, '')
        if not value:
            raise RuntimeError(f'MISSING_PUBLISHED_URL: {key}. Internal _IP/_ADDRESS '
                               'does not identify the published endpoint.')
        parsed = urlsplit(value)
        if (parsed.scheme not in {'http', 'https'} or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment or parsed.path not in {'', '/'}):
            raise ValueError(f'Invalid published endpoint for {member}')
        if parsed.hostname in {'localhost', 'host.docker.internal'}:
            raise ValueError('A published endpoint must not be a loopback/host alias')
        try:
            host = ipaddress.ip_address(parsed.hostname)
        except ValueError:
            host = None
        if host and (host.is_loopback or host.is_unspecified or host.is_link_local):
            raise ValueError('Invalid published IP')
        guest_ip = env.get(f'LOCAL_RELAY_VM_{member.upper()}_IP')
        if parsed.hostname == guest_ip:
            raise ValueError('Guest private IP is not the published endpoint')
        # Accessing .port also rejects malformed/out-of-range ports.
        _ = parsed.port
        urls[member] = value.rstrip('/')
    if urls['a'] == urls['b']:
        raise ValueError('A and B must have distinct published endpoints')
    return urls


def prepare() -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    own_units = ['minipost-relay-ci-a-stop.timer', 'minipost-relay-ci-a-stop.service'] if role() == 'a' else [UNIT_B] if role() == 'b' else []
    for unit in own_units:
        subprocess.run(['systemctl', 'stop', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        subprocess.run(['systemctl', 'reset-failed', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    OUT.mkdir(parents=True, exist_ok=True)
    write_json(OUT / 'identity.json', identity())
    # Only allowlisted address metadata, never dump the ambient environment.
    write_json(OUT / 'endpoint-contract.json', {
        name: os.environ[name]
        for member in ('A', 'B', 'C')
        for suffix in ('IP', 'PORT', 'ADDRESS', 'PUBLIC_URL')
        if (name := f'LOCAL_RELAY_VM_{member}_{suffix}') in os.environ
    })
    run('python3', '-m', 'unittest', 'discover', '-s', 'ci/local_relay', '-p', 'test_*.py')


def compose(*args: str) -> str:
    return run('docker', 'compose', '-p', PROJECT,
               '-f', str(STATE / 'app/docker-compose.yml'),
               '-f', str(STATE / 'compose-ci.json'), *args)


def deploy_a() -> None:
    if role() != 'a':
        raise RuntimeError('A deployment must run on A')
    run('systemctl', 'start', 'docker')
    context = STATE / 'app'
    context.mkdir(exist_ok=True)
    for name in ('app.py', 'network.py', 'Dockerfile', 'docker-compose.yml', 'static', 'examples'):
        source, target = ROOT / name, context / name
        if source.is_dir():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)
    write_json(context / 'static/__relay_ci__/identity.json', identity())
    write_json(STATE / 'compose-ci.json', {'services': {'app-like-postman': {
        'container_name': 'minipost-relay-ci-a', 'restart': 'no'
    }}})
    os.environ.update(MINIPOST_BIND='0.0.0.0', MINIPOST_PORT='8080')
    (OUT / 'deploy.log').write_text(compose('up', '-d', '--build'))
    health = ready('http://127.0.0.1:8080/api/health')
    if health.get('runtime', {}).get('network_mode') != 'bridge':
        raise RuntimeError('A is not using the shipped bridge deployment')
    write_json(OUT / 'deployment.json', {**identity(), 'runtime': health['runtime']})
    # Bound the lifetime even if a later graph step fails or C becomes unreachable.
    run('systemd-run', '--unit=minipost-relay-ci-a-stop', '--on-active=35m',
        '--collect', '/usr/bin/docker', 'stop', 'minipost-relay-ci-a')


class Receiver(BaseHTTPRequestHandler):
    def log_message(self, *_: object) -> None:
        pass

    def json_response(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == '/healthz':
            self.json_response(200, self.server.identity)
        elif parsed.path == '/receipts':
            prefix = parse_qs(parsed.query).get('run', [''])[0]
            if not re.fullmatch(r'[a-z0-9-]{1,80}', prefix):
                self.json_response(400, {'error': 'invalid run'}); return
            with self.server.lock:
                rows = [x for x in self.server.receipts if x['id'].startswith(prefix + '-')]
            self.json_response(200, {'identity': self.server.identity, 'receipts': rows})
        else:
            self.json_response(404, {'error': 'not found'})

    def do_POST(self) -> None:
        if urlsplit(self.path).path not in {'/echo', '/upstream-502'}:
            self.json_response(404, {'error': 'not found'}); return
        request_id = self.headers.get('X-MiniPost-Test-Id', '')
        if not re.fullmatch(r'[a-z0-9-]{1,100}', request_id):
            self.json_response(400, {'error': 'test id required'}); return
        try:
            length = int(self.headers.get('Content-Length', '-1'))
        except ValueError:
            length = -1
        if not 0 <= length <= MAX_BODY:
            self.json_response(413, {'error': 'body limit'}); return
        body = self.rfile.read(length)
        status = 502 if urlsplit(self.path).path == '/upstream-502' else 200
        row = {'id': request_id, 'method': self.command, 'path': self.path,
               'status': status, 'body_bytes': len(body), 'body_sha256': digest(body),
               'host': self.headers.get('Host'), 'peer': self.client_address[0]}
        with self.server.lock:
            self.server.receipts.append(row)
            with self.server.log_file.open('a') as stream:
                stream.write(json.dumps(row) + '\n')
        self.json_response(status, {**row, 'identity': self.server.identity,
                                   'received_body': body.decode('utf-8', errors='replace')})


def serve() -> None:
    server = ThreadingHTTPServer(('0.0.0.0', 8081), Receiver)
    server.identity = json.loads((STATE / 'receiver-identity.json').read_text())
    server.lock = threading.Lock()
    server.receipts = []
    server.log_file = OUT / 'received.jsonl'
    server.serve_forever()


def deploy_b() -> None:
    if role() != 'b':
        raise RuntimeError('B deployment must run on B')
    subprocess.run(['systemctl', 'stop', UNIT_B], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, check=False)
    write_json(STATE / 'receiver-identity.json', identity())
    (OUT / 'received.jsonl').write_text('')
    run('systemd-run', '--unit=' + UNIT_B, '--collect',
        '--property=RuntimeMaxSec=2100', '--property=WorkingDirectory=' + str(ROOT),
        '/usr/bin/python3', str(Path(__file__).resolve()), 'serve')
    observed = ready('http://127.0.0.1:8081/healthz')
    if observed != identity():
        raise RuntimeError('B receiver identity mismatch')
    write_json(OUT / 'deployment.json', observed)


def browser_tools() -> None:
    venv = STATE / 'venv'
    run('python3', '-m', 'venv', str(venv))
    python = str(venv / 'bin/python')
    run(python, '-m', 'pip', 'install', '-r', str(ROOT / 'requirements-test.txt'))
    run(python, '-m', 'playwright', 'install', '--with-deps', 'chromium')


def verify() -> None:
    report = {'status': 'failed', 'phase': 'published-endpoint-contract',
              'operator': identity(), 'requests': [], 'screenshots': []}
    try:
        urls = public_urls(dict(os.environ))
        report['published_endpoints'] = urls
        report['phase'] = 'published-readiness'
        a = ready(urls['a'] + '/__relay_ci__/identity.json')
        b = ready(urls['b'] + '/healthz')
        if (a['role'] != 'a' or b['role'] != 'b'
                or len({a['boot_id'], b['boot_id'], report['operator']['boot_id']}) != 3):
            raise RuntimeError('Three distinct VM identities were not proven')
        for who in (a, b):
            if who['test_source_sha256'] != report['operator']['test_source_sha256']:
                raise RuntimeError('Peer is running a different test revision')
        report['a_identity'], report['b_identity'] = a, b
        from playwright.sync_api import sync_playwright, expect
        import secrets
        tag = 'ci-' + secrets.token_hex(8)
        report['run'] = tag
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 960})
            errors, seen = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: seen.append(request.url))
            try:
                report['phase'] = 'browser-open-A-published'
                response = page.goto(urls['a'] + '/', timeout=45000)
                if response.status != 200 or page.url != urls['a'] + '/':
                    raise RuntimeError('Browser did not open the exact A published URL')
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                if digest(page.request.get(urls['a'] + '/app.js').body()) != a['app_js_sha256']:
                    raise RuntimeError('Served MiniPost JavaScript does not match deployment')
                cases = [('json', '{"message":"外部URLからPOST","value":42}', '/echo'),
                         ('text', 'plain POST C -> A -> B', '/echo'),
                         ('xml', '<request><value>42</value></request>', '/echo'),
                         ('json', '{"expected":"upstream 502"}', '/upstream-502')]
                for n, (language, body, path) in enumerate(cases):
                    report['phase'] = f'browser-post-{n}'
                    if n:
                        page.locator('#addTab').click()
                    request_id = f'{tag}-{n}'
                    target = urls['b'] + path
                    page.locator('#requestName').fill('POST B external ' + str(n + 1))
                    page.locator('#method').select_option('POST')
                    page.locator('#url').fill(target)
                    expect(page.locator('#loopbackTarget')).to_have_value('direct')
                    page.locator('[data-pane=headers]').click()
                    page.locator('#editorContent .table-add').click()
                    page.get_by_label('Key 1', exact=True).fill('X-MiniPost-Test-Id')
                    page.get_by_label('Value 1', exact=True).fill(request_id)
                    page.locator('[data-pane=body]').click()
                    page.locator('input[name=bodyMode][value=raw]').check()
                    page.locator('#editorContent .body-toolbar select').select_option(language)
                    page.get_by_label('Raw body', exact=True).fill(body)
                    with page.expect_response(lambda r: r.url == urls['a'] + '/api/request'
                                              and r.request.method == 'POST', timeout=45000) as pending:
                        page.locator('#send').click()
                    proxy = pending.value
                    payload, result = proxy.request.post_data_json, proxy.json()
                    expected = 502 if path == '/upstream-502' else 200
                    if (payload['url'] != target or proxy.status != 200
                            or not result.get('ok') or result['status'] != expected
                            or result.get('redirects') or result['url'] != target):
                        raise RuntimeError(f'POST failed: proxy={proxy.status}, '
                                           f'target={result.get("status")}, '
                                           f'diagnosis={result.get("diagnostic")}')
                    received = json.loads(result['body'])
                    if (received['identity'] != b or received['id'] != request_id
                            or received['received_body'] != body
                            or received['body_sha256'] != digest(body.encode())
                            or received['host'] != urlsplit(urls['b']).netloc
                            or result['network']['host_routing_applied']):
                        raise RuntimeError('B receipt or unchanged published route did not match')
                    report['requests'].append({k: v for k, v in received.items()
                                               if k != 'received_body'})
                    expect(page.locator('#responseStatus')).to_contain_text(str(expected))
                    image = f'external-post-{n}.png'
                    page.screenshot(path=str(OUT / image), full_page=True, timeout=10000)
                    report['screenshots'].append(image)
                    write_json(OUT / 'verification.json', report)
                receipts = get_json(urls['b'] + '/receipts?run=' + tag)['receipts']
                ids = collections.Counter(x['id'] for x in receipts)
                if (len(receipts) != len(cases) or any(v != 1 for v in ids.values())
                        or {x['id']: x['body_sha256'] for x in receipts}
                        != {x['id']: x['body_sha256'] for x in report['requests']}):
                    raise RuntimeError('B receiver has missing, duplicate or mismatched POSTs')
                origin = urlsplit(urls['a']).netloc
                if errors or any(urlsplit(url).netloc != origin for url in seen):
                    raise RuntimeError('Browser errors or a browser request bypassed A')
                report.update(status='passed', phase='complete', receiver_receipts=receipts,
                              browser_request_urls=seen, browser_errors=errors)
            finally:
                if report['status'] != 'passed':
                    try:
                        page.screenshot(path=str(OUT / 'failure.png'), timeout=3000)
                        report['screenshots'].append('failure.png')
                    except Exception:
                        pass
                browser.close()
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        write_json(OUT / 'verification.json', report)


def stop() -> None:
    if role() == 'a':
        (OUT / 'container.log').write_text(run('docker', 'logs', 'minipost-relay-ci-a'))
        compose('down', '--remove-orphans')
        subprocess.run(['systemctl', 'stop', 'minipost-relay-ci-a-stop.timer'], check=False)
    elif role() == 'b':
        run('systemctl', 'stop', UNIT_B)
    write_json(OUT / 'service-stop.json', {'role': role(), 'stopped': True,
                                         'vm_deleted': False})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'deploy-a', 'deploy-b',
                                         'browser-tools', 'serve', 'verify', 'stop'])
    action = parser.parse_args().action
    {'prepare': prepare, 'deploy-a': deploy_a, 'deploy-b': deploy_b,
     'browser-tools': browser_tools, 'serve': serve, 'verify': verify,
     'stop': stop}[action]()
