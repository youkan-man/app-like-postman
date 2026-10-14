"""Local contracts and live receiver checks, not a substitute for three-VM E2E."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('relay_acceptance', Path(__file__).with_name('run.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EndpointTests(unittest.TestCase):
    def env(self):
        return {'LOCAL_RELAY_VM_A_IP': '10.42.0.2', 'LOCAL_RELAY_VM_B_IP': '10.42.0.3',
                'LOCAL_RELAY_VM_A_PUBLIC_URL': 'http://192.0.2.10:18101',
                'LOCAL_RELAY_VM_B_PUBLIC_URL': 'http://192.0.2.10:18102'}

    def test_distinct_public_ports_are_kept(self):
        self.assertEqual(module.public_urls(self.env())['a'], 'http://192.0.2.10:18101')

    def test_no_internal_fallback(self):
        with self.assertRaisesRegex(RuntimeError, 'MISSING_PUBLISHED_URL'):
            module.public_urls({'LOCAL_RELAY_VM_A_ADDRESS': '10.42.0.2:8080'})

    def test_guest_ip_is_not_public(self):
        env = self.env(); env['LOCAL_RELAY_VM_A_PUBLIC_URL'] = 'http://10.42.0.2:8080'
        with self.assertRaises(ValueError):
            module.public_urls(env)

    def test_credentials_and_loopback_are_rejected(self):
        for url in ['http://u:p@example.test:80', 'http://localhost:8080',
                    'http://127.0.0.1:8080', 'http://[::1]:80', 'http://host.docker.internal:1',
                    'http://192.0.2.10:80000', 'http://192.0.2.10:1/?token=x']:
            with self.subTest(url=url):
                env = self.env(); env['LOCAL_RELAY_VM_A_PUBLIC_URL'] = url
                with self.assertRaises(ValueError):
                    module.public_urls(env)

    def test_a_and_b_must_be_distinct(self):
        env = self.env(); env['LOCAL_RELAY_VM_B_PUBLIC_URL'] = env['LOCAL_RELAY_VM_A_PUBLIC_URL']
        with self.assertRaises(ValueError):
            module.public_urls(env)


class LiveReceiverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), module.Receiver)
        self.server.identity = {'role': 'b', 'boot_id': 'test'}
        self.server.receipts = []; self.server.lock = threading.Lock()
        self.server.log_file = Path(self.temp.name) / 'receipt.jsonl'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.temp.cleanup()

    def post(self, path, data=b'hello', request_id='unit-0'):
        request = Request(self.base + path, data=data, headers={'X-MiniPost-Test-Id': request_id})
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_unicode_byte_hash_and_receipt(self):
        body = '日本語'.encode(); status, result = self.post('/echo', body)
        self.assertEqual(status, 200)
        self.assertEqual(result['body_sha256'], module.digest(body))
        self.assertEqual(result['body_bytes'], len(body))
        self.assertEqual(result['received_body'], '日本語')
        records = module.get_json(self.base + '/receipts?run=unit')['receipts']
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['id'], 'unit-0')

    def test_upstream_502_still_records_once(self):
        status, result = self.post('/upstream-502')
        self.assertEqual(status, 502)
        self.assertEqual(len(self.server.receipts), 1)
        self.assertEqual(result['status'], 502)

    def test_duplicate_attempts_are_visible(self):
        self.post('/echo'); self.post('/echo')
        self.assertEqual(len(self.server.receipts), 2)

    def test_wrong_endpoint_is_not_recorded(self):
        self.assertEqual(self.post('/elsewhere')[0], 404)
        self.assertEqual(self.server.receipts, [])

    def test_missing_id_is_rejected(self):
        self.assertEqual(self.post('/echo', request_id='')[0], 400)


if __name__ == '__main__':
    unittest.main()
