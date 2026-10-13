"""Real sockets to a synthetic LAN peer outside Docker; NOT the user's LAN.

Requires an isolated Linux CI runner, root, Docker Compose, and iproute2.
Creates only uniquely named test namespaces/interfaces/Compose projects.
No global firewall rules, Docker daemon settings or forwarding sysctls change.
"""
from __future__ import annotations

from contextlib import contextmanager
import ipaddress
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
from urllib.request import ProxyHandler, build_opener

from docker_network import DockerApp, OUT, ROOT, command, endpoint, free_port

SERVER = '''
from http.server import BaseHTTPRequestHandler, HTTPServer
import json,os,sys
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  data=json.dumps({'node':'synthetic-lan-peer-outside-docker','marker':sys.argv[3],
   'netns':os.readlink('/proc/self/ns/net'),'peer_address':self.server.server_address[0],
   'source_ip':self.client_address[0]}).encode()
  self.send_response(200);self.send_header('Content-Type','application/json')
  self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
HTTPServer((sys.argv[1],int(sys.argv[2])),Handler).serve_forever()
'''


def unused_ranges():
    occupied = []
    for route in json.loads(command('ip', '-j', '-4', 'route', 'show', 'table', 'all')):
        dst = route.get('dst', 'default')
        if dst != 'default':
            occupied.append(ipaddress.ip_network(dst, strict=False))
    ids = command('docker', 'network', 'ls', '-q').split()
    if ids:
        for net in json.loads(command('docker', 'network', 'inspect', *ids)):
            for row in ((net.get('IPAM') or {}).get('Config') or []):
                if row.get('Subnet'):
                    occupied.append(ipaddress.ip_network(row['Subnet'], strict=False))
    picked = []
    for n in range(200, 250):
        candidate = ipaddress.ip_network(f'10.233.{n}.0/24')
        if not any(candidate.version == old.version and candidate.overlaps(old) for old in occupied + picked):
            picked.append(candidate)
            if len(picked) == 2: return picked
    raise RuntimeError('No unused synthetic test subnets; no existing network will be changed.')


class SubnetApp(DockerApp):
    def __init__(self, name, subnet):
        super().__init__(name)
        self.env['MINIPOST_SUBNET'] = str(subnet)
        self.args += ['-f', str(ROOT / 'docker-compose.subnet.yml')]


@contextmanager
def lan_peer(subnet):
    tag = secrets.token_hex(3)
    ns, host_if, peer_if = f'mp-lan-{tag}', f'mph{tag}', f'mpp{tag}'
    host_ip, peer_ip = str(subnet.network_address + 1), str(subnet.network_address + 200)
    marker, port = secrets.token_hex(16), free_port()
    child = None
    created_ns = created_link = pinned_route = False
    with tempfile.TemporaryDirectory(prefix='mp-lan-peer-') as temp:
        server = Path(temp) / 'server.py'; server.write_text(SERVER)
        with (OUT / 'peer.log').open('w') as log:
            try:
                command('ip', 'netns', 'add', ns); created_ns = True
                command('ip', 'link', 'add', host_if, 'type', 'veth', 'peer', 'name', peer_if); created_link = True
                command('ip', 'link', 'set', peer_if, 'netns', ns)
                command('ip', 'addr', 'add', f'{host_ip}/{subnet.prefixlen}', 'dev', host_if)
                command('ip', 'link', 'set', host_if, 'up')
                command('ip', '-n', ns, 'link', 'set', 'lo', 'up')
                command('ip', '-n', ns, 'addr', 'add', f'{peer_ip}/{subnet.prefixlen}', 'dev', peer_if)
                command('ip', '-n', ns, 'link', 'set', peer_if, 'up')
                command('ip', '-n', ns, 'route', 'add', 'default', 'via', host_ip)
                # Model the case where the host already has a correct explicit
                # route (e.g. a VPN), but the container has an overlapping subnet.
                command('ip', 'route', 'add', f'{peer_ip}/32', 'dev', host_if, 'src', host_ip)
                pinned_route = True
                child = subprocess.Popen(['ip','netns','exec',ns,sys.executable,str(server),peer_ip,str(port),marker],stdout=log,stderr=log)
                url = f'http://{peer_ip}:{port}/health'
                direct = build_opener(ProxyHandler({}))
                deadline = time.monotonic() + 15
                while True:
                    if child.poll() is not None: raise RuntimeError('Synthetic peer failed; see peer.log')
                    try:
                        with direct.open(url, timeout=1) as r: body = json.load(r)
                        assert body['marker'] == marker
                        break
                    except OSError:
                        if time.monotonic() >= deadline: raise
                        time.sleep(.1)
                yield {'url':url,'ip':peer_ip,'marker':marker,'host_ip':host_ip,
                       'netns':body['netns'],'host_route':json.loads(command('ip','-j','route','get',peer_ip))}
            finally:
                if child is not None and child.poll() is None:
                    child.terminate()
                    try: child.wait(timeout=5)
                    except subprocess.TimeoutExpired: child.kill(); child.wait()
                if pinned_route:
                    command('ip','route','del',f'{peer_ip}/32','dev',host_if)
                if created_link: command('ip','link','del',host_if)
                if created_ns: command('ip','netns','del',ns)


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run only on an isolated Linux CI runner as root; namespaces require privilege.')
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'topology':'synthetic IPv4 LAN peer in a non-Docker network namespace',
              'user_lan_tested':False, 'physical_devices_tested':False, 'checks':[],'status':'running'}
    def record(name, **details):
        report['checks'].append({'name':name,**details})
        print('PASS '+name, flush=True)
        (OUT / 'private-lan-results.json').write_text(json.dumps(report,indent=2))
    try:
        lan, safe = unused_ranges()
        conflict = list(lan.subnets(new_prefix=25))[1]
        report.update(lan_subnet=str(lan),safe_docker_subnet=str(safe),overlapping_docker_subnet=str(conflict))
        with lan_peer(lan) as peer, endpoint() as host:
            assert peer['netns'] != os.readlink('/proc/self/ns/net')
            record('Peer is outside host and Docker network namespaces',peer=peer)
            with SubnetApp('minipost-lan-safe',safe) as app:
                status, result = app.request(url=peer['url'],timeout_ms=3000)
                body = json.loads(result['body'])
                assert status == 200 and result['status'] == 200 and body['marker'] == peer['marker']
                assert body['netns'] not in [app.netns, os.readlink('/proc/self/ns/net')]
                assert body['source_ip'] == peer['host_ip'], body
                record('Docker bridge reaches separate LAN peer with masquerading',network=result['network'],response=body)
                status, result = app.request(url=peer['url'],loopback_target='docker-host',timeout_ms=3000)
                assert status == 200 and result['status'] == 200
                assert result['network']['connect_host'] == peer['ip'] and not result['network']['host_routing_applied']
                record('LAN IP is never rewritten to Docker host')
            with SubnetApp('minipost-lan-overlap',conflict) as bad:
                status, result = bad.request(url=f'http://host.docker.internal:{host.server_port}/health')
                assert status == 200 and json.loads(result['body'])['marker'] == host.marker
                record('Docker host stays reachable despite LAN overlap')
                status, result = bad.request(url=peer['url'],timeout_ms=1000)
                assert status == 502 and not result['ok'], result
                assert result['diagnostic']['code'] in {'TIMEOUT','NETWORK_UNREACHABLE'}
                record('Overlapping container subnet breaks only the LAN peer path',diagnostic=result['diagnostic'])
                output = command(sys.executable,str(ROOT/'tools/diagnose_network.py'),peer['url'],
                                 '--container',bad.cid,'--timeout','1')
                diagnostic = json.loads(output)
                assert any(x.get('tcp') for x in diagnostic['host_probe']['attempts'])
                assert not any(x.get('tcp') for x in diagnostic['container_probe']['attempts'])
                assert any(x['ip']==peer['ip'] and x['attached'] for x in diagnostic['target_docker_matches'])
                (OUT/'diagnostic-overlap.json').write_text(output)
                record('Standalone diagnosis compares host/container and identifies matching CIDR')
                # A new Compose project explicitly using a non-overlapping range
                # succeeds while the bad project is still present; nothing global
                # is disabled, and neither target URL nor API implementation changes.
                with SubnetApp('minipost-lan-corrected',safe) as fixed:
                    status, result = fixed.request(url=peer['url'],timeout_ms=3000)
                    assert status == 200 and result['status'] == 200
                    assert json.loads(result['body'])['marker'] == peer['marker']
                    record('Shipped subnet override restores the exact same LAN request',network=result['network'])
        report['status']='passed'
    except BaseException:
        report['status']='failed'
        raise
    finally:
        report['passed']=len(report['checks'])
        (OUT/'private-lan-results.json').write_text(json.dumps(report,indent=2))


if __name__ == '__main__':
    main()
