"""Real ingress framing: decode chunking before the outbound HTTP request."""
from __future__ import annotations
import base64
import http.client
import io
import json
import socket
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from test_proxy import proxy, start_server

class RequestFramingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.receiver, cls.target = start_server()
        cls.server, cls.base = start_server(proxy.Handler)
    @classmethod
    def tearDownClass(cls):
        for server in [cls.server, cls.receiver]: server.shutdown(); server.server_close()
    def send(self, payload, chunked):
        content = json.dumps(payload, ensure_ascii=False).encode()
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        chunks = (content[i:i+37] for i in range(0,len(content),37))
        conn.request('POST','/api/request', body=chunks if chunked else content,
                     headers={'Content-Type':'application/json'}, encode_chunked=chunked)
        response = conn.getresponse(); result=json.load(response); status=response.status; conn.close()
        return status,result
    def test_same_binary_arrives_for_content_length_and_chunked(self):
        for data in [b'', bytes(range(256)), bytes(range(256))*257]:
            for chunked in [False,True]:
                with self.subTest(size=len(data),chunked=chunked):
                    status,result=self.send({'url':self.target+'/echo','method':'POST','body_base64':base64.b64encode(data).decode()},chunked)
                    self.assertEqual(status,200,result)
                    self.assertEqual(base64.b64decode(json.loads(result['body'])['body_base64']),data)
    def test_chunk_boundary_can_split_utf8_and_base64_json(self):
        status,result=self.send({'url':self.target+'/echo','method':'POST','body':'日本語の本文'*200},True)
        self.assertEqual(status,200,result)
        self.assertEqual(json.loads(result['body'])['body'],'日本語の本文'*200)
    def read(self, body, pairs, limit=None):
        headers=Message()
        for key,value in pairs:headers[key]=value
        return proxy.read_request_body(io.BytesIO(body),headers,limit)
    def test_extensions_and_trailers_do_not_become_payload(self):
        body=b'3;name="value"\r\nabc\r\n2\r\nde\r\n0\r\nX-Checksum: ignored\r\n\r\n'
        self.assertEqual(self.read(body,[('Transfer-Encoding','Chunked')]),b'abcde')
    def test_identical_repeated_content_lengths_are_unambiguous(self):
        self.assertEqual(self.read(b'abc',[('Content-Length','003'),('Content-Length','3, 3')]),b'abc')
    def test_conflicting_or_invalid_framing_is_rejected(self):
        cases=[([('Content-Length','3'),('Transfer-Encoding','chunked')],b''),
               ([('Content-Length','3, 4')],b'abcdef'),([('Content-Length','+3')],b'abc'),
               ([('Content-Length','-1')],b''),([('Transfer-Encoding','chunked, chunked')],b''),
               ([('Transfer-Encoding','chunked;foo=bar')],b''),([('Transfer-Encoding','gzip')],b''),
               ([('Transfer-Encoding','chunked')],b'Z\r\n'),
               ([('Transfer-Encoding','chunked')],b'3\r\nabcXX'),
               ([('Transfer-Encoding','chunked')],b'0\r\nContent-Length: 3\r\n\r\n'),
               ([('Transfer-Encoding','chunked')],b'1\nA\n0\n\n'),
               ([('Content-Length','5')],b'abc')]
        for pairs,body in cases:
            with self.subTest(pairs=pairs,body=body):
                with self.assertRaises(proxy.RequestBodyError):self.read(body,pairs)
    def test_decoded_workspace_limit_rejects_before_large_chunk_is_read(self):
        with self.assertRaises(proxy.RequestBodyError) as error:
            self.read(b'a00001\r\n',[('Transfer-Encoding','chunked')],10*1024*1024)
        self.assertEqual(error.exception.status,413)
    def test_chunked_workspace_save_preserves_existing_backup_on_quota_error(self):
        original = proxy.WORKSPACE_FILE
        with tempfile.TemporaryDirectory() as temp:
            proxy.WORKSPACE_FILE = Path(temp) / 'workspace.json'
            bundle = {'kind':'minipost.workspace','version':1,'workspace':{'version':2,'collections':[],
                      'environments':[],'globals':[],'tabs':[],'history':[]}}
            try:
                content=json.dumps(bundle).encode()
                conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
                conn.request('POST','/api/workspace',body=iter([content[:21],content[21:]]),
                             headers={'Content-Type':'application/json'},encode_chunked=True)
                response=conn.getresponse();result=json.load(response);conn.close()
                self.assertEqual(response.status,200,result)
                with socket.create_connection(('127.0.0.1',self.server.server_port),timeout=5) as sock:
                    sock.sendall(b'POST /api/workspace HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\na00001\r\n')
                    response=http.client.HTTPResponse(sock);response.begin();result=json.load(response)
                    self.assertEqual(response.status,413,result)
                self.assertEqual(json.loads(proxy.WORKSPACE_FILE.read_text()),bundle)
            finally:proxy.WORKSPACE_FILE=original

    def test_chunk_metadata_is_bounded(self):
        for body in [b'1;'+b'a'*8192+b'\r\n',b'0\r\n'+b'X: v\r\n'*102+b'\r\n']:
            with self.assertRaises(proxy.RequestBodyError):self.read(body,[('Transfer-Encoding','chunked')])
    def test_raw_http_extensions_and_trailers_reach_actual_receiver(self):
        payload=json.dumps({'url':self.target+'/echo','method':'POST','body':'complete'}).encode()
        with socket.create_connection(('127.0.0.1',self.server.server_port),timeout=5) as sock:
            sock.sendall(b'POST /api/request HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n'+hex(len(payload))[2:].encode()+b';test=1\r\n'+payload+b'\r\n0\r\nX-Test: yes\r\n\r\n')
            response=http.client.HTTPResponse(sock);response.begin();result=json.load(response)
            self.assertEqual(response.status,200,result)
            self.assertEqual(json.loads(result['body'])['body'],'complete')

if __name__=='__main__':unittest.main()
