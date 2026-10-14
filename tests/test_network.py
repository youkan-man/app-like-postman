"""Direct routing and diagnostic regression; no host/subnet overrides."""
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
    def test_connections_keep_url_host_unchanged(self):
        for host in ['localhost', 'localhost.', '127.0.0.1', '[::1]', '192.168.1.5', 'gateway', 'api.example.com']:
            target = urlsplit(f'http://{host}:1234/private?token=secret')
            details = network.connection_details(target)
            self.assertEqual(details['connect_host'], target.hostname)
            self.assertEqual(details['port'], 1234)
            self.assertFalse(details['host_routing_applied'])
            self.assertNotIn('secret', json.dumps(details))

    def test_old_network_mode_environment_does_not_change_destination(self):
        with patch.dict('os.environ', {'MINIPOST_NETWORK_MODE': 'host'}):
            self.assertEqual(network.connection_details(urlsplit('https://localhost/'))['connect_host'], 'localhost')

    def test_deprecated_client_route_field_cannot_rewrite_destination(self):
        echo, base = start_server()
        try:
            result = proxy.send_http_request({'url': base + '/echo', 'loopback_target': 'docker-host'})
            self.assertEqual(result['status'], 200)
            self.assertEqual(result['network']['connect_host'], '127.0.0.1')
            self.assertFalse(result['network']['host_routing_applied'])
        finally:
            echo.shutdown(); echo.server_close()

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
