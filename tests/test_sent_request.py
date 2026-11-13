"""Verify request history against actual bytes received over HTTP."""
import base64
import io
import json
import socket
import struct
import unittest
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from test_proxy import proxy, EchoHandler, start_server
from upload_stream import UploadStore, IO_BYTES


class QuietProxy(proxy.Handler):
    def log_message(self, *args):
        pass


class DisconnectHandler(EchoHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.close_connection = True


class RejectBodyHandler(EchoHandler):
    def do_POST(self):
        # Reset immediately after headers, before accepting the complete body.
        self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
        self.close_connection = True


class ReadCounter:
    def __init__(self, file):
        self.file = file
        self.read_bytes = 0
        self.maximum = 0

    def read(self, length=-1):
        self.maximum = max(self.maximum, length)
        value = self.file.read(length)
        self.read_bytes += len(value)
        return value

    def __getattr__(self, key):
        return getattr(self.file, key)


class SentRequestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.echo, cls.target = start_server()
        cls.proxy_server, cls.base = start_server(QuietProxy)

    @classmethod
    def tearDownClass(cls):
        for server in [cls.proxy_server, cls.echo]:
            server.shutdown()
            server.server_close()

    def send(self, path='/echo', **values):
        return proxy.send_http_request({'url': self.target + path, **values})

    def assert_received(self, result, index=-1):
        received = json.loads(result['body'])
        snapshot = result['sent_requests'][index]
        self.assertEqual(snapshot['transmission'], 'sent')
        self.assertEqual(snapshot['method'], received['method'])
        self.assertEqual(snapshot['request_target'], received['path'])
        self.assertEqual([(item['key'], item['value']) for item in snapshot['headers']],
                         [tuple(item) for item in received['headers']])
        self.assertEqual(snapshot['body_size'], len(base64.b64decode(received['body_base64'])))
        if 'body' in snapshot:
            self.assertEqual(snapshot['body'], received['body'])
        return snapshot

    def test_unicode_full_text_and_generated_headers_match_received_values(self):
        body = '日本語\n' * 25000  # Deliberately exceeds 64 KiB; never silently truncate.
        result = self.send('/日本 語/:id#fragment', method='POST', body=body,
            path_variables={'id': 'a/b'}, query=[{'key': 'q', 'value': '大阪 +%&='}],
            headers=[{'key': 'Authorization', 'value': 'Bearer actual-token'},
                     {'key': 'X-Repeat', 'value': 'one'}, {'key': 'X-Repeat', 'value': 'two'},
                     {'key': 'X-Disabled', 'value': 'hidden', 'disabled': True},
                     {'key': 'Content-Length', 'value': '1'},
                     {'key': 'Transfer-Encoding', 'value': 'chunked'}])
        snapshot = self.assert_received(result)
        self.assertEqual(snapshot['body'], body)
        self.assertEqual(snapshot['body_mode'], 'text')
        self.assertEqual(snapshot['url'], self.target + snapshot['request_target'])
        self.assertIn('/%E6%97%A5%E6%9C%AC%20%E8%AA%9E/a%2Fb?', snapshot['url'])
        self.assertNotIn('fragment', snapshot['url'])
        headers = {item['key'].lower(): item['value'] for item in snapshot['headers']}
        self.assertEqual(headers['content-length'], str(len(body.encode())))
        self.assertEqual(headers['connection'], 'close')
        self.assertNotIn('transfer-encoding', headers)
        self.assertNotIn('x-disabled', headers)

    def test_custom_host_duplicates_and_empty_header_remain_exact(self):
        result = self.send(headers=[{'key': 'host', 'value': 'chosen.example'},
                                   {'key': 'X-Empty', 'value': ''},
                                   {'key': 'X-Repeat', 'value': 'a'},
                                   {'key': 'X-Repeat', 'value': 'b'}])
        snapshot = self.assert_received(result)
        self.assertEqual([item for item in snapshot['headers'] if item['key'].lower() == 'host'],
                         [{'key': 'host', 'value': 'chosen.example'}])
        self.assertEqual(snapshot['body_mode'], 'none')

    def test_urlencoded_body_and_fields_are_after_encoding(self):
        rows = [{'key': 'q', 'value': 'a b+日本'}, {'key': 'q', 'value': '%2F&='},
                {'key': 'empty', 'value': ''}, {'key': 'disabled', 'value': 'no', 'disabled': True}]
        result = self.send(method='POST', form_urlencoded=rows)
        snapshot = self.assert_received(result)
        self.assertEqual(snapshot['body_mode'], 'urlencoded')
        self.assertEqual(snapshot['form_urlencoded'], rows[:-1])
        self.assertEqual(snapshot['body'], 'q=a+b%2B%E6%97%A5%E6%9C%AC&q=%252F%26%3D&empty=')

    def test_empty_body_and_absent_body_remain_distinct(self):
        for values, mode in [({'method': 'POST'}, 'none'),
                             ({'method': 'POST', 'body': ''}, 'text'),
                             ({'method': 'GET', 'body': 'actual GET body'}, 'text')]:
            with self.subTest(values=values):
                snapshot = self.assert_received(self.send(**values))
                self.assertEqual(snapshot['body_mode'], mode)
                self.assertEqual('body' in snapshot, 'body' in values)

    def test_multipart_records_values_file_sizes_and_actual_boundary(self):
        data = bytes(range(256))
        result = self.send(method='POST', multipart=[{'key': 'note', 'value': '日本語\n'},
            {'key': 'files', 'filename': '日本.bin', 'data': base64.b64encode(data).decode(),
             'content_type': 'application/octet-stream'},
            {'key': 'files', 'filename': 'empty.bin', 'data': ''}])
        snapshot = self.assert_received(result)
        self.assertEqual(snapshot['body_mode'], 'multipart')
        self.assertEqual(snapshot['multipart'], [{'key': 'note', 'value': '日本語\n'},
            {'key': 'files', 'filename': '日本.bin', 'size': 256, 'content_type': 'application/octet-stream'},
            {'key': 'files', 'filename': 'empty.bin', 'size': 0}])
        self.assertNotIn('body', snapshot)
        self.assertNotIn(base64.b64encode(data).decode(), json.dumps(snapshot))
        boundary = next(item['value'].split('boundary=')[1] for item in snapshot['headers']
                        if item['key'].lower() == 'content-type')
        self.assertIn('--' + boundary, json.loads(result['body'])['body'])

    def test_legacy_binary_records_only_metadata(self):
        result = self.send(method='PUT', body_base64=base64.b64encode(bytes(range(256))).decode(), body_filename='送信.bin',
                           headers=[{'key': 'Content-Type', 'value': 'custom/binary'}])
        snapshot = self.assert_received(result)
        self.assertEqual(snapshot['body_mode'], 'binary')
        self.assertEqual(snapshot['file'], {'size': 256, 'content_type': 'custom/binary', 'filename': '送信.bin'})
        self.assertNotIn('body', snapshot)
        self.assertNotIn('body_base64', snapshot)

    def test_streamed_files_are_not_read_again_for_history(self):
        data = bytes(range(256)) * 2048
        store = UploadStore()
        try:
            token = store.create([len(data)])
            upload = store.get(token)
            upload.append(0, 0, len(data), io.BytesIO(data))
            counted = ReadCounter(upload.files[0])
            upload.files[0] = counted
            with store.claim(token):
                result = proxy.send_http_request({'url': self.target + '/echo', 'method': 'POST',
                    'body_upload': 0, 'body_filename': 'stream.bin',
                    'headers': [{'key': 'Content-Type', 'value': 'custom/stream'}]}, upload)
            snapshot = self.assert_received(result)
            self.assertEqual(snapshot['file'], {'size': len(data), 'content_type': 'custom/stream', 'filename': 'stream.bin'})
            self.assertEqual(counted.read_bytes, len(data))
            self.assertLessEqual(counted.maximum, IO_BYTES)
        finally:
            store.close()

    def test_streamed_multipart_keeps_file_metadata_and_text(self):
        store = UploadStore()
        try:
            token = store.create([3, 0])
            upload = store.get(token)
            upload.append(0, 0, 3, io.BytesIO(b'\0\xffx'))
            with store.claim(token):
                result = proxy.send_http_request({'url': self.target + '/echo', 'method': 'POST',
                    'multipart': [{'key': 'note', 'value': '日本語'},
                                  {'key': 'files', 'filename': 'a.bin', 'upload': 0},
                                  {'key': 'files', 'filename': 'empty.bin', 'upload': 1}]}, upload)
            snapshot = self.assert_received(result)
            self.assertEqual(snapshot['multipart'], [{'key': 'note', 'value': '日本語'},
                {'key': 'files', 'filename': 'a.bin', 'size': 3},
                {'key': 'files', 'filename': 'empty.bin', 'size': 0}])
        finally:
            store.close()

    def test_redirect_hops_show_initial_post_and_rewritten_get_without_credentials(self):
        second, other = start_server()
        try:
            result = self.send('/redirect?location=' + quote(other + '/echo', safe=''),
                method='POST', body='original body',
                headers=[{'key': 'Content-Type', 'value': 'text/plain'},
                         {'key': 'Authorization', 'value': 'Bearer original'},
                         {'key': 'Cookie', 'value': 'session=original'}])
            initial, final = result['sent_requests']
            self.assertEqual(initial['method'], 'POST')
            self.assertEqual(initial['body'], 'original body')
            self.assertEqual(initial['response_status'], 302)
            self.assertEqual(final['method'], 'GET')
            self.assertEqual(final['url'], other + '/echo')
            self.assertEqual(final['body_mode'], 'none')
            self.assertNotIn('body', final)
            final_headers = {item['key'].lower(): item['value'] for item in final['headers']}
            for key in ['authorization', 'cookie', 'content-type', 'content-length']:
                self.assertNotIn(key, final_headers)
            self.assert_received(result)
        finally:
            second.shutdown()
            second.server_close()

    def test_307_redirect_preserves_exact_body(self):
        result = self.send('/redirect?code=307', method='POST', body='unchanged 日本語')
        self.assertEqual(len(result['sent_requests']), 2)
        for snapshot in result['sent_requests']:
            self.assertEqual(snapshot['method'], 'POST')
            self.assertEqual(snapshot['body'], 'unchanged 日本語')
            self.assertEqual(snapshot['transmission'], 'sent')
        self.assert_received(result)

    def api_failure(self, payload):
        request = Request(self.base + '/api/request', data=json.dumps(payload).encode(),
                          headers={'Content-Type': 'application/json'})
        with self.assertRaises(HTTPError) as raised:
            urlopen(request, timeout=5)
        return json.load(raised.exception)

    def test_response_failure_retains_completed_send(self):
        target, url = start_server(DisconnectHandler)
        try:
            result = self.api_failure({'url': url, 'method': 'POST', 'body': 'sent before disconnect'})
            self.assertFalse(result['ok'])
            self.assertEqual(result['diagnostic']['phase'], 'receive')
            self.assertEqual(result['sent_requests'][0]['transmission'], 'sent')
            self.assertEqual(result['sent_requests'][0]['body'], 'sent before disconnect')
        finally:
            target.shutdown()
            target.server_close()

    def test_connection_failure_has_no_transmitted_request(self):
        with socket.socket() as unused:
            unused.bind(('127.0.0.1', 0))
            port = unused.getsockname()[1]
        result = self.api_failure({'url': f'http://127.0.0.1:{port}/?token=unsent-secret'})
        self.assertEqual(result['sent_requests'], [])
        self.assertNotIn('unsent-secret', json.dumps(result))

    def test_interrupted_body_is_not_reported_as_fully_sent(self):
        target, url = start_server(RejectBodyHandler)
        try:
            # Larger than the loopback socket send buffer so the reset arrives
            # while sendall is still transmitting the body.
            result = self.api_failure({'url': url, 'method': 'POST', 'body': 'x' * (8 * 1024 * 1024)})
            self.assertEqual(result['diagnostic']['phase'], 'send')
            self.assertEqual(result['sent_requests'][0]['transmission'], 'incomplete')
            self.assertEqual(result['sent_requests'][0]['body_size'], 8 * 1024 * 1024)
        finally:
            target.shutdown()
            target.server_close()

    def test_redirect_to_invalid_target_keeps_completed_initial_hop(self):
        result = self.api_failure({'url': self.target + '/redirect?location=ftp%3A%2F%2Fexample.test%2F',
                                   'method': 'POST', 'body': 'already sent'})
        self.assertEqual(len(result['sent_requests']), 1)
        self.assertEqual(result['sent_requests'][0]['body'], 'already sent')
        self.assertEqual(result['sent_requests'][0]['transmission'], 'sent')


if __name__ == '__main__':
    unittest.main()
