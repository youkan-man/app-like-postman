"""Default Compose and a real HTTP peer, without host/subnet routing overrides."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('ARTIFACT_DIR', str(ROOT / 'artifacts/docker-network')))


def command(*args, cwd=ROOT, env=None):
    return subprocess.check_output(args, cwd=cwd, env=env, text=True, stderr=subprocess.STDOUT).strip()


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def json_http(url, payload=None):
    request = Request(url, data=None if payload is None else json.dumps(payload).encode(), headers={'Content-Type':'application/json'})
    try:
        response = urlopen(request, timeout=30)
    except HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response)


class DockerApp:
    def __init__(self, name):
        self.name = name + '-' + secrets.token_hex(4)
        self.temp = tempfile.TemporaryDirectory()
        override = Path(self.temp.name) / 'names.json'
        override.write_text(json.dumps({'services': {'app-like-postman': {'container_name': self.name, 'restart': 'no'}}}))
        self.args = ['docker', 'compose', '-p', self.name, '-f', str(ROOT / 'docker-compose.yml'), '-f', str(override)]
        self.env = {**os.environ, 'MINIPOST_PORT': '0'}

    def compose(self, *args):
        return command(*self.args, *args, env=self.env)

    def __enter__(self):
        OUT.mkdir(parents=True, exist_ok=True)
        try:
            (OUT / 'compose.json').write_text(self.compose('config', '--format', 'json'))
            (OUT / 'build.log').write_text(self.compose('up', '-d', '--build'))
            self.cid = self.compose('ps', '-q', 'app-like-postman')
            info = json.loads(command('docker', 'inspect', self.cid))[0]
            self.image = info['Image']
            self.network = next(iter(info['NetworkSettings']['Networks']))
            self.url = 'http://127.0.0.1:' + info['NetworkSettings']['Ports']['8080/tcp'][0]['HostPort']
            for index in range(60):
                try:
                    status, health = json_http(self.url + '/api/health')
                    assert status == 200 and health['runtime']['container']
                    break
                except OSError:
                    if index == 59:
                        raise
                    time.sleep(.5)
            return self
        except BaseException:
            self.__exit__()
            raise

    def request(self, **payload):
        return json_http(self.url + '/api/request', payload)

    def __exit__(self, *args):
        try:
            (OUT / 'container.log').write_text(self.compose('logs', '--no-color'))
        finally:
            self.compose('down', '--remove-orphans')
            self.temp.cleanup()


def main():
    from playwright.sync_api import sync_playwright, expect
    with DockerApp('minipost-normal-test') as app:
        peer = 'minipost-peer-' + secrets.token_hex(4)
        script = "from http.server import ThreadingHTTPServer;from test_proxy import EchoHandler;ThreadingHTTPServer(('0.0.0.0',8080),EchoHandler).serve_forever()"
        # Keep tests beside the application, as on the native test runner.
        command('docker', 'run', '-d', '--name', peer, '--network', app.network,
                '-v', str(ROOT / 'tests') + ':/app/tests:ro', '-e', 'PYTHONPATH=/app/tests',
                app.image, 'python', '-c', script)
        checks = []
        try:
            for index in range(30):
                status, result = app.request(url='http://' + peer + ':8080/echo')
                if status == 200:
                    break
                time.sleep(.3)
            assert status == 200 and result['status'] == 200, result
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True)
                page = browser.new_page(viewport={'width':1440, 'height':920})
                page.goto(app.url, wait_until='domcontentloaded')
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                expect(page.locator('#loopbackTarget,#requestTabs')).to_have_count(0)
                for expected in [200, 502]:
                    page.locator('#method').select_option('POST')
                    page.locator('#url').fill(f'http://{peer}:8080/echo?status={expected}')
                    page.locator('[data-pane=body]').click()
                    page.locator('input[name=bodyMode][value=raw]').check()
                    page.get_by_label('Raw body').fill('日本語 POST')
                    with page.expect_response(lambda r: r.url.endswith('/api/request')) as pending:
                        page.locator('#send').click()
                    response = pending.value
                    result = response.json()
                    assert response.status == 200 and result['status'] == expected
                    assert json.loads(result['body'])['body'] == '日本語 POST'
                    assert result['network']['connect_host'] == peer and not result['network']['host_routing_applied']
                    expect(page.locator('#responseStatus')).to_contain_text(str(expected))
                    page.screenshot(path=str(OUT / f'normal-post-{expected}.png'))
                    checks.append({'status':expected, 'body_match':True, 'unchanged_target':True})
                browser.close()
            (OUT / 'results.json').write_text(json.dumps({'status':'passed', 'checks':checks, 'deployment':'shipped default Compose; test name and random port only'}, indent=2))
        finally:
            try:
                (OUT / 'receiver.log').write_text(command('docker', 'logs', peer))
            finally:
                command('docker', 'rm', '-f', peer)


if __name__ == '__main__':
    main()
