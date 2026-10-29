"""Unencoded frontend JSON -> actual Python proxy -> exact receiver bytes."""
import base64
import json
import subprocess
import unittest
from urllib.parse import parse_qsl, unquote
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from test_proxy import ROOT, proxy, start_server
from url_codec import request_url, wire_url, transform_text

COMPILE = """
import fs from 'node:fs';
import {newRequest,setUrlText,setQuery,compileRequest} from './static/core.mjs';
const x=JSON.parse(fs.readFileSync(0,'utf8'));const request=newRequest();
setUrlText(request,x.url);request.method='POST';
if(x.query)setQuery(request,x.query);
if(x.body)request.body=x.body;
if(x.variables)request.url.variable=x.variables;
process.stdout.write(JSON.stringify(compileRequest({collections:[],environments:[],globals:[]},{request},x.files||{}).payload));
"""
class TextUrlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.echo, cls.target = start_server()
        cls.app, cls.base = start_server(proxy.Handler)
    @classmethod
    def tearDownClass(cls):
        for server in [cls.app, cls.echo]:
            server.shutdown();server.server_close()
    def compile(self, **case):
        result=subprocess.run(['node','--input-type=module','-e',COMPILE],cwd=ROOT,input=json.dumps(case),text=True,capture_output=True,check=True)
        return json.loads(result.stdout)
    def send(self, payload):
        with urlopen(Request(self.base+'/api/request',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'}),timeout=10) as reply:
            result=json.load(reply)
        self.assertEqual(result['status'],200)
        return json.loads(result['body'])
    def test_raw_url_and_binary_reach_receiver_without_double_encoding(self):
        data=bytes(range(256))*4096
        payload=self.compile(url=self.target+'/日本 語?q=大阪+名張&data={"a":1}&percent=%252F',body={'mode':'file'},files={'binary':[{'name':'日本.bin','type':'application/octet-stream','data':base64.b64encode(data).decode()}]})
        self.assertIn('/日本 語',payload['url']);self.assertNotIn('%E6',json.dumps(payload,ensure_ascii=False))
        self.assertEqual(payload['query'][0]['value'],'大阪+名張')
        received=self.send(payload)
        path,query=received['path'].split('?',1)
        self.assertEqual(path,'/%E6%97%A5%E6%9C%AC%20%E8%AA%9E')
        self.assertEqual(parse_qsl(query),[('q','大阪+名張'),('data','{"a":1}'),('percent','%2F')])
        self.assertEqual(base64.b64decode(received['body_base64']),data)
    def test_param_editor_reserved_values_stay_values_not_delimiters(self):
        values=[{'key':'a & 日本','value':'a&b=+?#%2F 日本'},{'key':'a & 日本','value':''}]
        received=self.send(self.compile(url=self.target+'/echo#never-sent',query=values))
        self.assertEqual(parse_qsl(received['path'].split('?',1)[1],keep_blank_values=True),[(row['key'],row['value']) for row in values])
        self.assertNotIn('never-sent',received['path'])
    def test_path_variables_are_encoded_only_at_http_boundary(self):
        payload=self.compile(url=self.target+'/:id/end',variables=[{'key':'id','value':'日本/語?#+%2F'}])
        self.assertEqual(payload['path_variables']['id'],'日本/語?#+%2F')
        received=self.send(payload)
        self.assertEqual(received['path'],'/%E6%97%A5%E6%9C%AC%2F%E8%AA%9E%3F%23%2B%252F/end')
    def test_front_form_fields_are_text_then_backend_form_encodes_once(self):
        values=[{'key':'q','value':'a b+日本'},{'key':'q','value':'%2F&='}]
        payload=self.compile(url=self.target+'/echo',body={'mode':'urlencoded','urlencoded':values})
        self.assertIsNone(payload['body']);self.assertEqual(payload['form_urlencoded'],values)
        received=self.send(payload)
        self.assertEqual(parse_qsl(received['body']),[(row['key'],row['value']) for row in values])
    def test_existing_url_escapes_and_literal_percent_are_not_confused(self):
        for raw,expected in [('/a%2Fb','/a%2Fb'),('/%E6%97%A5 本','/%E6%97%A5%20%E6%9C%AC'),('/100%','/100%25'),('/trail ','/trail%20')]:
            self.assertEqual(self.send({'url':self.target+raw})['path'],expected)
    def test_query_auth_override_removes_old_and_keeps_other_duplicates(self):
        url=request_url({'url':'http://example.test/?key=old&x=1&x=2','query':[{'key':'key','value':'日+&','replace':True}]})
        self.assertEqual(parse_qsl(url.split('?',1)[1]),[('x','1'),('x','2'),('key','日+&')])
    def test_unicode_redirect_location_is_encoded_in_backend(self):
        location='/日本 語?q=大阪'
        # The receiver fixture takes an ASCII Location value; wire_url covers
        # the identical redirection normalization used by the proxy.
        self.assertEqual(wire_url('http://example.test'+location),'http://example.test/%E6%97%A5%E6%9C%AC%20%E8%AA%9E?q=%E5%A4%A7%E9%98%AA')
    def test_idna_ipv6_and_reserved_path_escapes(self):
        self.assertEqual(wire_url('http://例え.テスト/日本'),'http://xn--r8jz45g.xn--zckzah/%E6%97%A5%E6%9C%AC')
        self.assertEqual(wire_url('http://[::1]:8080/a%2Fb'),'http://[::1]:8080/a%2Fb')
        for url in ['http://example.test/\r\nInjected','http://bad host/a']:
            with self.assertRaises(ValueError):request_url({'url':url})
    def test_explicit_transform_endpoint_roundtrip_and_invalid_input(self):
        def transform(text, operation, kind='component'):
            with urlopen(Request(self.base+'/api/url-transform',data=json.dumps({'text':text,'operation':operation,'kind':kind}).encode(),headers={'Content-Type':'application/json'})) as reply:return json.load(reply)['text']
        value='日本 語+/%';encoded=transform(value,'encode')
        self.assertEqual(encoded,'%E6%97%A5%E6%9C%AC%20%E8%AA%9E%2B%2F%25')
        self.assertEqual(transform(encoded,'decode'),value)
        self.assertEqual(transform(self.target+'/日本 語?q=a b','encode','url'),self.target+'/%E6%97%A5%E6%9C%AC%20%E8%AA%9E?q=a%20b')
        with self.assertRaises(HTTPError) as context:transform('%ZZ','decode')
        self.assertEqual(context.exception.code,400)
if __name__=='__main__':unittest.main()
