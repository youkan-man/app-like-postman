"""Diagnostic behavior; local TCP checks are not evidence about the user's LAN."""
import importlib.util
import ipaddress
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('diagnose_network', ROOT / 'tools/diagnose_network.py')
diag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)


class DiagnoseNetworkTests(unittest.TestCase):
    def test_discards_url_secrets(self):
        result = diag.parse_target('https://192.168.9.20:8443/private?token=secret#fragment')
        self.assertEqual(result, {'host': '192.168.9.20', 'port': 8443, 'scheme': 'https'})

    def test_rejects_userinfo_and_non_http(self):
        for value in ['ftp://192.168.9.20/', 'https://user:secret@example.org/', 'not-a-url']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                diag.parse_target(value)

    def test_ipv6_target_and_standard_ports(self):
        self.assertEqual(diag.parse_target('https://[fd00::20]/')['host'], 'fd00::20')
        self.assertEqual(diag.parse_target('http://example.org/')['port'], 80)

    def test_reports_bridge_subnet_match_without_claiming_root_cause(self):
        nets = [{'name': 'app_default', 'driver': 'bridge', 'subnets': ['192.168.9.0/24'], 'attached': True}]
        matches = diag.docker_matches(nets, ['192.168.9.20'])
        self.assertTrue(matches[0]['attached'])
        finding = diag.findings({'attempts': []}, {'attempts': []}, matches, True)[0]
        self.assertEqual(finding['code'], 'TARGET_IN_DOCKER_BRIDGE_SUBNET')
        self.assertIn('断定しません', finding['message'])

    def test_other_bridge_networks_can_shadow_lan_on_host(self):
        nets = [{'name': 'unrelated', 'driver': 'bridge', 'subnets': ['10.9.0.0/16'], 'attached': False}]
        self.assertFalse(diag.docker_matches(nets, ['10.9.4.5'])[0]['attached'])

    def test_macvlan_and_ipvlan_are_not_labeled_bridge_conflicts(self):
        for driver in ['macvlan', 'ipvlan', 'host']:
            self.assertEqual(diag.docker_matches([{'name': 'lan', 'driver': driver,
                'subnets': ['192.168.9.0/24']}], ['192.168.9.20']), [])

    def test_no_match_for_another_lan(self):
        self.assertEqual(diag.docker_matches([{'name':'app','driver':'bridge',
            'subnets':['172.17.0.0/16']}], ['192.168.9.20']), [])

    def test_ipv6_bridge_match(self):
        self.assertEqual(len(diag.docker_matches([{'name':'app','driver':'bridge',
            'subnets':['fd12::/64']}], ['fd12::20'])), 1)

    def test_dns_mismatch_and_failed_probe_are_distinct(self):
        rows = diag.findings({'addresses': ['192.168.1.5']},
            {'addresses': [], 'probe_error': 'docker exec failed'}, [], True)
        codes = [row['code'] for row in rows]
        self.assertIn('DNS_RESULTS_DIFFER', codes)
        self.assertIn('PROBE_INCOMPLETE', codes)
        self.assertNotIn('BOTH_UNREACHABLE', codes)

    def test_host_and_container_differ(self):
        rows = diag.findings({'attempts': [{'tcp':True}]},
                             {'attempts': [{'tcp':False}]}, [], True)
        self.assertIn('CLI_REACHABLE_CONTAINER_UNREACHABLE', [r['code'] for r in rows])

    def test_remote_docker_caveat(self):
        rows = diag.findings({'attempts': [{'tcp':True}]}, {'attempts': [{'tcp':True}]}, [], False)
        self.assertIn('HOST_VANTAGE_UNCONFIRMED', [r['code'] for r in rows])

    def test_tcp_success_does_not_mean_http_success(self):
        rows = diag.findings({}, {'attempts': [{'tcp':True, 'tls':False}]}, [], True)
        self.assertIn('CONTAINER_TLS_FAILED', [r['code'] for r in rows])
        self.assertIn('HTTPを送っていません', str(rows))

    def test_probe_connects_but_sends_no_http(self):
        received = []
        with socket.socket() as server:
            server.bind(('127.0.0.1', 0)); server.listen(1)
            def accept():
                with server.accept()[0] as conn:
                    conn.settimeout(3)
                    received.append(conn.recv(4096))
            thread = threading.Thread(target=accept, daemon=True); thread.start()
            result = diag.probe([sys.executable, '-'], {'host':'127.0.0.1',
                'port':server.getsockname()[1], 'scheme':'http'}, 1)
            thread.join(timeout=4)
        self.assertTrue(result['attempts'][0]['tcp'], result)
        self.assertEqual(received, [b''])
        self.assertFalse(result['http_sent'])

    def test_probe_closed_port(self):
        with socket.socket() as server:
            server.bind(('127.0.0.1', 0)); port = server.getsockname()[1]
        result = diag.probe([sys.executable, '-'], {'host':'127.0.0.1', 'port':port, 'scheme':'http'}, 1)
        self.assertFalse(result['attempts'][0]['tcp'], result)
        self.assertEqual(result['attempts'][0]['error'], 'ConnectionRefusedError')


if __name__ == '__main__':
    unittest.main()
