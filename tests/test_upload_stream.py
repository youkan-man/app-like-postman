"""HTTP-boundary upload regressions; receiver hashes bytes, never echoes them."""
from __future__ import annotations
import contextlib
import hashlib
import http.client
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import socket
import sys
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import app
from upload_stream import UploadStore, UploadError, IO_BYTES, CHUNK_BYTES


class DigestHandler(BaseHTTPRequestHandler):
    records = []
    waiting = threading.Event()
    release = threading.Event()
    def log_message(self, *_args):
        pass
    def receive(self):
        size = int(self.headers.get('Content-Length', '0'))
        received, digest, maximum = 0, hashlib.sha256(), 0
        while received < size:
            data = self.rfile.read(min(IO_BYTES, size - received))
            if not data:
                break
            received += len(data); maximum = max(maximum, len(data)); digest.update(data)
        record = {'size': received, 'sha256': digest.hexdigest(), 'method': self.command,
                  'path': self.path, 'max_read': maximum, 'content_type': self.headers.get('Content-Type')}
        self.records.append(record)
        if self.path == '/wait':
            self.waiting.set(); self.release.wait(5)
        body = json.dumps(record).encode()
        self.send_response(307 if self.path == '/redirect307' else 302 if self.path == '/redirect302' else 200)
        if self.path.startswith('/redirect'):
            self.send_header('Location', '/digest')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            self.wfile.write(body)
    do_POST = do_PUT = do_PATCH = do_GET = receive


class QuietApp(app.Handler):
    def log_message(self, *_args):
        pass


def server(handler):
    instance = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=instance.serve_forever, daemon=True).start()
    return instance


def http_json(port, method, path, data=None, headers=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    if isinstance(data, dict):
        data = json.dumps(data).encode()
        headers = {**(headers or {}), 'Content-Type': 'application/json'}
    try:
        connection.request(method, path, data, headers or {})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


class UploadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.target = server(DigestHandler)
        cls.proxy = server(QuietApp)
    @classmethod
    def tearDownClass(cls):
        for running in [cls.proxy, cls.target]:
            running.shutdown(); running.server_close()
    def setUp(self):
        self.prior = app.UPLOADS
        app.UPLOADS = UploadStore()
        DigestHandler.records.clear(); DigestHandler.waiting.clear(); DigestHandler.release.clear()
    def tearDown(self):
        DigestHandler.release.set()
        app.UPLOADS.close(); app.UPLOADS = self.prior
    def call(self, method, path, data=None, headers=None):
        return http_json(self.proxy.server_port, method, path, data, headers)
    def create(self, sizes):
        status, result = self.call('POST', '/api/uploads', {'sizes': sizes})
        self.assertEqual(status, 201, result)
        self.assertEqual(result['chunk_bytes'], CHUNK_BYTES)
        return result['upload_id']
    def chunk(self, token, index, offset, data):
        return self.call('POST', f'/api/uploads/{token}/{index}', data,
                         {'Content-Type': 'application/octet-stream', 'X-MiniPost-Offset': str(offset)})
    def stage(self, data):
        token = self.create([len(data)])
        for start in range(0, len(data), CHUNK_BYTES):
            status, result = self.chunk(token, 0, start, data[start:start+CHUNK_BYTES])
            self.assertEqual(status, 200, result)
        return token
    def send(self, token, path='/digest', **extra):
        return self.call('POST', '/api/request', {'url': f'http://127.0.0.1:{self.target.server_port}{path}',
            'method': 'POST', 'body_upload': 0, 'upload_id': token, **extra})
    def test_empty_all_bytes_and_multichunk_exact_length_and_digest(self):
        for data in [b'', bytes(range(256)), bytes(range(256))*(CHUNK_BYTES//256*3+1)]:
            with self.subTest(size=len(data)):
                token = self.stage(data)
                upload = app.UPLOADS.get(token)
                status, result = self.send(token, method='PUT', headers=[{'key':'Content-Type','value':'custom/binary'}, {'key':'Content-Length','value':'1'}])
                self.assertEqual(status, 200, result)
                body = json.loads(result['body'])
                self.assertEqual(body['sha256'], hashlib.sha256(data).hexdigest())
                self.assertEqual(body['size'], len(data)); self.assertEqual(body['method'], 'PUT')
                self.assertEqual(body['content_type'], 'custom/binary')
                self.assertLessEqual(body['max_read'], IO_BYTES)
                self.assertTrue(upload.closed); self.assertFalse(app.UPLOADS.entries)
    def test_redirect307_rewinds_file_and_preserves_bytes(self):
        data = b'\0\xffabc' * 500000
        token = self.stage(data)
        status, result = self.send(token, '/redirect307', method='PATCH')
        self.assertEqual(status, 200, result)
        self.assertEqual(len(DigestHandler.records), 2)
        self.assertTrue(all(row['sha256'] == hashlib.sha256(data).hexdigest() and row['method']=='PATCH' for row in DigestHandler.records))
        self.assertFalse(app.UPLOADS.entries)
    def test_redirect302_drops_body_after_post(self):
        status, result = self.send(self.stage(b'abc'), '/redirect302')
        self.assertEqual(status, 200, result)
        self.assertEqual(DigestHandler.records[-1]['method'], 'GET')
        self.assertEqual(DigestHandler.records[-1]['size'], 0)
    def test_invalid_offsets_delete_incomplete_file_without_target_send(self):
        token = self.stage(b'abc')
        session = app.UPLOADS.get(token); stored = session.file(0)
        self.assertEqual(self.chunk(token, 0, 0, b'bad')[0], 409)
        self.assertFalse(app.UPLOADS.entries); self.assertTrue(stored.closed)
        self.assertEqual(len(DigestHandler.records), 0)
    def test_incomplete_upload_cannot_be_claimed_or_sent(self):
        token = self.create([9]); self.chunk(token, 0, 0, b'abc')
        self.assertEqual(self.send(token)[0], 409)
        self.assertEqual(len(DigestHandler.records), 0)
        self.assertEqual(self.call('DELETE', '/api/uploads/'+token)[0], 200)
        self.assertFalse(app.UPLOADS.entries)
    def test_unresolved_file_reference_is_rejected_not_sent_empty(self):
        status, _ = self.call('POST', '/api/request', {'url': f'http://127.0.0.1:{self.target.server_port}/', 'body_upload': 0})
        self.assertEqual(status, 400); self.assertFalse(DigestHandler.records)
    def test_transfer_is_single_use(self):
        token = self.stage(b'abc')
        self.assertEqual(self.send(token)[0], 200)
        self.assertEqual(self.send(token)[0], 404)
        self.assertEqual(len(DigestHandler.records), 1)
    def test_failed_target_cleans_staged_file(self):
        token = self.stage(b'abc'); session = app.UPLOADS.get(token); stored = session.file(0)
        with socket.socket() as unused:
            unused.bind(('127.0.0.1', 0)); port = unused.getsockname()[1]
        status, _ = self.send(token, url=f'http://127.0.0.1:{port}/')
        self.assertEqual(status, 502); self.assertTrue(stored.closed); self.assertFalse(app.UPLOADS.entries)
    def test_cancel_interrupts_unlimited_target_response_wait(self):
        token = self.stage(b'abc'); session = app.UPLOADS.get(token); result = []
        worker = threading.Thread(target=lambda: result.append(self.send(token, '/wait', timeout_ms=0)))
        worker.start(); self.assertTrue(DigestHandler.waiting.wait(3))
        self.assertEqual(self.call('DELETE', '/api/uploads/'+token)[0], 200)
        worker.join(3); self.assertFalse(worker.is_alive()); self.assertTrue(session.closed)
        self.assertFalse(app.UPLOADS.entries); self.assertNotEqual(result[0][0], 200)
    def test_oversize_legacy_json_is_rejected_before_buffering(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.proxy.server_port, timeout=3)
        try:
            connection.putrequest('POST','/api/request')
            connection.putheader('Content-Length',str(400*1024*1024)); connection.endheaders()
            self.assertEqual(connection.getresponse().status, 413)
        finally:
            connection.close()
    def test_cross_origin_creation_and_deletion_are_rejected(self):
        self.assertEqual(self.call('POST','/api/uploads',{'sizes':[1]},{'Origin':'https://other.test'})[0],403)
        token = self.stage(b'a')
        self.assertEqual(self.call('DELETE','/api/uploads/'+token,headers={'Origin':'https://other.test'})[0],403)
        self.assertIn(token, app.UPLOADS.entries)
    def test_idle_expiry_closes_anonymous_file(self):
        token = self.stage(b'abc'); upload=app.UPLOADS.get(token); stored=upload.file(0)
        upload.touched -= app.UPLOADS.ttl + 1; app.UPLOADS.expire()
        self.assertTrue(stored.closed); self.assertFalse(app.UPLOADS.entries)
    def test_truncated_chunk_releases_file(self):
        token = self.create([100]); session=app.UPLOADS.get(token)
        connection=socket.create_connection(('127.0.0.1',self.proxy.server_port))
        connection.sendall((f'POST /api/uploads/{token}/0 HTTP/1.0\r\nContent-Length: 100\r\nContent-Type: application/octet-stream\r\nX-MiniPost-Offset: 0\r\n\r\n').encode()+b'abc')
        connection.shutdown(socket.SHUT_WR)
        connection.recv(4096); connection.close()
        self.assertTrue(session.closed); self.assertFalse(app.UPLOADS.entries)
    def test_multipart_preserves_unicode_empty_files_and_body_framing(self):
        # Small multipart uses a collecting receiver solely to inspect the envelope.
        seen=[]
        class Collector(DigestHandler):
            def receive(self):
                data=self.rfile.read(int(self.headers['Content-Length']));seen.append((data,self.headers['Content-Type']))
                self.send_response(200);self.send_header('Content-Length','0');self.end_headers()
            do_POST=receive
        target=server(Collector)
        try:
            token=self.create([3,0]);self.chunk(token,0,0,b'\0\xffx')
            status,result=self.call('POST','/api/request',{'method':'POST','url':f'http://127.0.0.1:{target.server_port}/','upload_id':token,
                'headers':[{'key':'Content-Type','value':'multipart/form-data; boundary=wrong'}],
                'multipart':[{'key':'note','value':'日本語'},{'key':'files','filename':'日本語.bin','upload':0,'content_type':'application/octet-stream'},{'key':'files','filename':'empty.bin','upload':1}]})
            self.assertEqual(status,200,result)
            data,content_type=seen[0];self.assertNotIn('wrong',content_type)
            self.assertIn('filename="日本語.bin"'.encode(),data);self.assertIn(b'\0\xffx\r\n',data)
            self.assertIn('日本語'.encode(),data);self.assertTrue(data.endswith(b'--\r\n'))
            self.assertFalse(app.UPLOADS.entries)
        finally:
            target.shutdown();target.server_close()

if __name__ == '__main__':
    unittest.main()
