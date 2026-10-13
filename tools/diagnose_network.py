#!/usr/bin/env python3
"""Compare one target from the CLI host and a running MiniPost container.

Read-only inspection plus TCP/TLS handshakes. No HTTP request, credentials,
container restart, network reconfiguration, firewall change, or subnet scan.
This file is standalone and also works with older MiniPost containers.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
from urllib.parse import urlsplit

# Run the identical probe with each environment's resolver and network namespace.
# An outer subprocess timeout bounds DNS as well as all connection attempts.
PROBE = r'''
import ipaddress,json,os,shutil,socket,ssl,struct,subprocess,sys
from pathlib import Path
host,port,scheme,timeout=sys.argv[1],int(sys.argv[2]),sys.argv[3],float(sys.argv[4])
result={"addresses":[],"attempts":[],"http_sent":False}
try: result["netns"]=os.readlink("/proc/self/ns/net")
except OSError: result["netns"]=None

def route(ip):
    if shutil.which("ip"):
        try:
            p=subprocess.run(["ip","-j","route","get",ip],capture_output=True,text=True,timeout=3)
            if p.returncode==0:
                return {"source":"kernel ip route get","entries":json.loads(p.stdout)}
        except (OSError,ValueError,subprocess.TimeoutExpired): pass
    # Minimal Python images do not contain iproute2. This fallback is explicitly
    # not an authoritative policy-routing lookup; keep all matching main routes.
    address=ipaddress.ip_address(ip.split("%")[0])
    if address.version==4:
        try:
            matches=[]
            for line in Path("/proc/net/route").read_text().splitlines()[1:]:
                f=line.split()
                if len(f)<8 or not (int(f[3],16)&1): continue
                decode=lambda x: socket.inet_ntoa(struct.pack("=I",int(x,16)))
                net=ipaddress.ip_network(decode(f[1])+"/"+decode(f[7]),strict=False)
                if address in net:
                    matches.append({"dst":str(net),"dev":f[0],"gateway":decode(f[2]),"metric":int(f[6])})
            matches.sort(key=lambda x:(-ipaddress.ip_network(x["dst"]).prefixlen,x["metric"]))
            return {"source":"/proc/net/route snapshot (IPv4 main table; policy routing not evaluated)","entries":matches}
        except (OSError,ValueError): pass
    return {"source":"unavailable","entries":[]}

try:
    infos=socket.getaddrinfo(host,port,type=socket.SOCK_STREAM)
    unique={}
    for family,kind,proto,_canon,addr in infos:
        unique.setdefault((family,addr), (family,kind,proto,addr))
    result["addresses"]=[row[3][0] for row in unique.values()]
    result["omitted_addresses"]=max(0,len(unique)-8)
    for family,kind,proto,addr in list(unique.values())[:8]:
        row={"ip":addr[0],"route":route(addr[0]),"tcp":False}
        result["attempts"].append(row)
        sock=None
        try:
            sock=socket.socket(family,kind,proto);sock.settimeout(timeout);sock.connect(addr)
            row.update(tcp=True,source_ip=sock.getsockname()[0],peer_ip=sock.getpeername()[0])
            if scheme=="https":
                try:
                    sock=ssl.create_default_context().wrap_socket(sock,server_hostname=host)
                    row.update(tls=True,tls_version=sock.version())
                except ssl.SSLCertVerificationError as error:
                    row.update(tls=False,tls_error="TLS_CERTIFICATE_ERROR",detail=error.verify_message)
                except (ssl.SSLError,OSError) as error:
                    row.update(tls=False,tls_error=type(error).__name__)
        except OSError as error:
            row.update(error=type(error).__name__,errno=error.errno)
        finally:
            if sock is not None: sock.close()
except (OSError,ValueError) as error:
    result["dns_error"]=type(error).__name__
    result["errno"]=getattr(error,"errno",None)
print(json.dumps(result))
'''


def parse_target(value: str) -> dict:
    """Discard path/query/fragment immediately; never copy them into evidence."""
    u = urlsplit(value)
    if u.scheme not in {'http', 'https'} or not u.hostname:
        raise ValueError('http:// または https:// の送信先URLを指定してください。')
    if u.username is not None or u.password is not None:
        raise ValueError('認証情報を含まないURLを指定してください。')
    port = u.port or (443 if u.scheme == 'https' else 80)
    return {'host': u.hostname, 'port': port, 'scheme': u.scheme}


def run(args: list[str], data: str | None = None, timeout: float = 15) -> str:
    try:
        p = subprocess.run(args, input=data, text=True, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f'{args[0]}: {type(error).__name__}') from error
    if p.returncode:
        # Do not echo raw daemon output: custom endpoints can contain credentials.
        raise RuntimeError(f'{args[0]} failed (exit {p.returncode}); Dockerへの接続・権限を確認してください。')
    return p.stdout


def probe(prefix: list[str], target: dict, timeout: float) -> dict:
    args = [target['host'], str(target['port']), target['scheme'], str(timeout)]
    try:
        return json.loads(run(prefix + args, PROBE, timeout=12 + 16 * timeout))
    except (RuntimeError, ValueError) as error:
        return {'probe_error': str(error), 'addresses': [], 'attempts': []}


def docker_matches(networks: list[dict], addresses: list[str]) -> list[dict]:
    found = []
    for net in networks:
        # A macvlan or ipvlan may intentionally use the LAN subnet. Do not call
        # that a bridge conflict, or scan arbitrary IPs to find a free subnet.
        if net.get('driver') != 'bridge':
            continue
        for subnet in net.get('subnets', []):
            try:
                cidr = ipaddress.ip_network(subnet, strict=False)
                for raw_ip in sorted(set(addresses)):
                    ip = ipaddress.ip_address(raw_ip.split('%')[0])
                    if ip.version == cidr.version and ip in cidr:
                        found.append({'ip': raw_ip, 'subnet': str(cidr),
                                      'network': net['name'], 'attached': net.get('attached', False)})
            except ValueError:
                continue
    return found


def findings(host: dict, container: dict, matches: list[dict], same_host: bool) -> list[dict]:
    def item(code, message): return {'code': code, 'message': message}
    out = []
    if matches:
        out.append(item('TARGET_IN_DOCKER_BRIDGE_SUBNET',
            '送信先IPがDocker bridgeのCIDR内です。相手がLAN上の別機器ならサブネット重複の候補です。'
            '意図したコンテナ宛てなら正常なので、この一致だけで障害原因とは断定しません。'))
    if set(host.get('addresses', [])) != set(container.get('addresses', [])):
        out.append(item('DNS_RESULTS_DIFFER', 'ホスト側とコンテナ側で名前解決結果が異なります。接続した実IPを比較してください。'))
    if host.get('probe_error') or container.get('probe_error'):
        out.append(item('PROBE_INCOMPLETE', '診断を完了できない環境があります。失敗を通信不可の判定と混同しないでください。'))
        return out
    h = any(a.get('tcp') for a in host.get('attempts', []))
    c = any(a.get('tcp') for a in container.get('attempts', []))
    if not same_host:
        out.append(item('HOST_VANTAGE_UNCONFIRMED',
            'CLIを実行したOSとDocker daemonのネットワークが同一とは確認できません。'
            'リモートDocker・Docker Desktopではdaemon側の経路も確認が必要です。'))
    if h and not c:
        out.append(item('CLI_REACHABLE_CONTAINER_UNREACHABLE',
            '同じ指定宛先へのTCPはCLI側で成功し、コンテナ側では失敗しました。'
            '解決IP・Docker/LANのCIDR重複・転送/NAT・宛先側の送信元制限を切り分けます。'))
    elif not h and not c:
        out.append(item('BOTH_UNREACHABLE',
            'CLI側でもコンテナ側でもTCP接続できません。アプリのlocalhost設定ではなく、'
            '宛先の待受・ホストの経路/DNS・ファイアウォールも確認が必要です。'))
    elif c:
        out.append(item('CONTAINER_TCP_REACHABLE',
            'コンテナからTCP接続できています。502が続く場合はTLS・HTTP応答・入口プロキシ・'
            '実際に配備したアプリ版を比較してください。この診断ではHTTPを送っていません。'))
    if any(a.get('tcp') and a.get('tls') is False for a in container.get('attempts', [])):
        out.append(item('CONTAINER_TLS_FAILED', 'TCP接続後にTLSが失敗しています。証明書・SNI・信頼するCAを確認してください。'))
    return out


def collect(target: dict, container: str, timeout: float) -> dict:
    if container.startswith('-'):
        raise ValueError('コンテナ名が不正です。')
    info = json.loads(run(['docker', 'inspect', '--type', 'container', '--format',
        '{"id":{{json .Id}},"running":{{json .State.Running}},"network_mode":{{json .HostConfig.NetworkMode}},"networks":{{json .NetworkSettings.Networks}}}', container]))
    if not info['running']:
        raise RuntimeError('指定コンテナは起動していません。診断では起動・再起動しません。')
    ids = run(['docker', 'network', 'ls', '-q']).split()
    nets = []
    if ids:
        allowed = {'com.docker.network.bridge.name', 'com.docker.network.bridge.enable_ip_masquerade',
                   'com.docker.network.bridge.gateway_mode_ipv4', 'com.docker.network.bridge.gateway_mode_ipv6'}
        for net in json.loads(run(['docker', 'network', 'inspect', *ids])):
            nets.append({'name': net['Name'], 'driver': net['Driver'], 'internal': net.get('Internal', False),
                'subnets': [r['Subnet'] for r in net.get('IPAM', {}).get('Config', []) if r.get('Subnet')],
                'options': {k: v for k, v in (net.get('Options') or {}).items() if k in allowed},
                'attached': net['Name'] in info['networks']})
    same_host = False
    try:
        daemon_os = run(['docker', 'info', '--format', '{{.OperatingSystem}}']).strip()
        ctx = json.loads(run(['docker', 'context', 'inspect']))[0]
        endpoint = os.environ.get('DOCKER_HOST') or ctx.get('Endpoints', {}).get('docker', {}).get('Host', '')
        same_host = platform.system() == 'Linux' and endpoint.startswith('unix:') and 'docker desktop' not in daemon_os.lower()
    except (RuntimeError, ValueError, KeyError, IndexError):
        daemon_os = 'unavailable'
    h = probe([sys.executable, '-'], target, timeout)
    c = probe(['docker', 'exec', '-i', info['id'], 'python', '-'], target, timeout)
    matches = docker_matches(nets, h.get('addresses', []) + c.get('addresses', []))
    return {'version': 1, 'target': target, 'container': info, 'daemon_os': daemon_os,
            'cli_is_native_daemon_host': same_host, 'docker_networks': nets,
            'host_probe': h, 'container_probe': c, 'target_docker_matches': matches,
            'findings': findings(h, c, matches, same_host),
            'limits': ['TCP/TLS only; no HTTP requests or API authentication were tested.',
                       'Network addresses are in this report; redact unrelated addresses before public sharing.',
                       'No container restart, route/firewall change, or automatic subnet selection.']}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url', help='接続できないAPIのURL（パス・クエリは送信/保存しません）')
    parser.add_argument('--container', default='app-like-postman')
    parser.add_argument('--timeout', type=float, default=2.0, help='各TCP/TLS接続のタイムアウト秒')
    parser.add_argument('--output', help='診断JSONを保存するファイル（任意）')
    args = parser.parse_args()
    try:
        if not 0 < args.timeout <= 10: raise ValueError('--timeout は0より大きく10以下にしてください。')
        report = collect(parse_target(args.url), args.container, args.timeout)
        text = json.dumps(report, ensure_ascii=False, indent=2)
        if args.output: Path(args.output).write_text(text + '\n', encoding='utf-8')
        print(text)
        return 0
    except (ValueError, RuntimeError, OSError) as error:
        print(json.dumps({'diagnostic_error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
