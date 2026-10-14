"""Real HTTPS through the API: certificate errors must not become input HTTP 400."""
import json
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from test_proxy import EchoHandler, proxy, start_server


class TlsApiTests(unittest.TestCase):
    def test_certificate_error_has_network_diagnostic(self):
        with tempfile.TemporaryDirectory(prefix='minipost-api-tls-') as temp:
            cert, key = Path(temp) / 'cert.pem', Path(temp) / 'key.pem'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=localhost'], check=True, capture_output=True)
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(cert, key)
            server = ThreadingHTTPServer(('127.0.0.1', 0), EchoHandler)
            server.socket = tls.wrap_socket(server.socket, server_side=True)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            app, base = start_server(proxy.Handler)
            try:
                for verify, expected in [(True, 502), (False, 200)]:
                    payload = {'url': f'https://127.0.0.1:{server.server_port}/echo', 'verify_tls': verify}
                    request = Request(base + '/api/request', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
                    try:
                        response = urlopen(request, timeout=10)
                    except HTTPError as error:
                        response = error
                    with response:
                        result = json.load(response)
                        self.assertEqual(response.status, expected, result)
                    if verify:
                        self.assertEqual(result['diagnostic']['code'], 'TLS_CERTIFICATE_ERROR')
                        self.assertEqual(result['diagnostic']['phase'], 'tls')
                        self.assertEqual(result['error_origin'], 'minipost')
                    else:
                        self.assertTrue(result['ok'])
                        self.assertEqual(result['status'], 200)
            finally:
                for running in [app, server]:
                    running.shutdown(); running.server_close()


if __name__ == '__main__':
    unittest.main()
