"""Fast route/diagnosis regressions; actual Docker routes live in docker_network.py."""
import json
import socket
import ssl
import sys
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from test_proxy import ROOT, proxy, start_server
sys.path.insert(0, str(ROOT))
import network


class NetworkTests(unittest.TestCase):
    def test_only_literal_loopback_reroutes(self):
        with patch.dict('os.environ', {'MINIPOST_NETWORK_MODE': 'bridge'}):
            for host in ['localhost', 'localhost.', '127.0.0.1', '127.1.2.3', '[::1]']:
                details = network.connection_details(urlsplit(f'http://{host}:1234/a?q=secret'), 'docker-host')
                self.assertEqual(details['connect_host'], 'host.docker.internal')
                self.assertNotIn('secret', json.dumps(details))
            for host in ['192.168.1.5', 'gateway', 'api.example.com']:
                details = network.connection_details(urlsplit(f'http://{host}/'), 'docker-host')
                self.assertEqual(details['connect_host'], host)
                self.assertFalse(details['host_routing_applied'])

    def test_no_silent_loopback_rewrite(self):
        details = network.connection_details(urlsplit('http://localhost:8081/'))
        self.assertEqual(details['connect_host'], 'localhost')
        self.assertFalse(details['host_routing_applied'])

    def test_host_network_does_not_need_gateway_alias(self):
        with patch.dict('os.environ', {'MINIPOST_NETWORK_MODE': 'host'}):
            self.assertEqual(network.connection_details(urlsplit('https://localhost/'), 'docker-host')['connect_host'], 'localhost')

    def test_invalid_route_is_rejected(self):
        with self.assertRaises(ValueError):
            network.connection_details(urlsplit('http://localhost/'), 'surprise')

    def test_error_classes_are_distinct(self):
        details = network.connection_details(urlsplit('https://example.com/'))
        for error, code in [(socket.gaierror(-2, 'no DNS'), 'DNS_ERROR'), (ConnectionRefusedError(), 'CONNECTION_REFUSED'), (TimeoutError(), 'TIMEOUT'), (ssl.SSLCertVerificationError(), 'TLS_CERTIFICATE_ERROR'), (ssl.SSLError(), 'TLS_ERROR'), (ConnectionResetError(), 'CONNECTION_RESET')]:
            with self.subTest(code=code):
                self.assertEqual(network.connection_diagnostic(error, details, 'connect')['code'], code)

    def test_api_reports_connection_origin_without_url_secrets(self):
        app, base = start_server(proxy.Handler)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
        try:
            request = Request(base + '/api/request', data=json.dumps({'url': f'http://127.0.0.1:{port}/private?token=NEVER-DISCLOSE', 'headers': [{'key':'Authorization','value':'Bearer NEVER-DISCLOSE'}]}).encode(), headers={'Content-Type':'application/json'})
            with self.assertRaises(HTTPError) as raised:
                urlopen(request)
            error = raised.exception
            self.assertEqual(error.code, 502)
            result = json.load(error)
            self.assertEqual(result['error_origin'], 'minipost')
            self.assertEqual(result['diagnostic']['code'], 'CONNECTION_REFUSED')
            self.assertNotIn('NEVER-DISCLOSE', json.dumps(result))
        finally:
            app.shutdown(); app.server_close()


if __name__ == '__main__':
    unittest.main()
