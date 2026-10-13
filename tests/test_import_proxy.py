"""Import -> compile -> real MiniPost HTTP API -> loopback echo regression tests.

This suite uses a local echo server, NOT the COM Gateway and NOT browser mocks.
Run together with test_proxy.py using unittest discovery. Node.js is required.
"""
from __future__ import annotations

import base64
import json
import shutil
import subprocess
import unittest
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

import test_proxy as helpers

COMPILE = r"""
import fs from 'node:fs';
import {SCHEMA, importPostman, exportCollection, compileRequest} from './static/core.mjs';
const o = JSON.parse(fs.readFileSync(0, 'utf8'));
const request = {method: 'GET', url: '{{baseUrl}}/echo'};
const folder = {name: 'Folder', item: [{name: 'Echo', request}]};
const doc = {info: {name: 'HTTP regression', schema: SCHEMA.replace('v2.1.0', o.version || 'v2.0.0')},
  item: [folder], variable: [{key: 'baseUrl', value: o.url}, {key: 'token', value: 'fixture-token'}]};
({request, folder, collection: doc}[o.level || 'request']).auth = o.auth;
if (o.noauth) request.auth = {type: 'noauth'};
let c = importPostman(doc).collections[0];
if (o.roundtrip) c = importPostman(exportCollection(c)).collections[0];
let environments = [];
if (o.archive) {
  const parsed = [[{collections: ['c'], environments: ['e']}, 'archive.json'],
    [exportCollection(c), 'collection.json'],
    [{name: 'Dev', values: [{key: 'token', value: 'environment-token'}]}, 'environment.json']]
    .map(([value, name]) => importPostman(value, name));
  c = parsed.flatMap(p => p.collections)[0];
  environments = parsed.flatMap(p => p.environments);
}
const item = c.item[0].item[0];
const ws = {collections: [c], environments, globals: [], environmentId: environments[0]?.id};
const payload = compileRequest(ws, {collectionId: c._mpId, itemId: item._mpId, request: item.request}).payload;
process.stdout.write(JSON.stringify(payload));
"""


class ImportProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which('node'):
            raise RuntimeError('Node.js is required for import-to-proxy tests.')
        cls.echo, cls.url = helpers.start_server()
        cls.proxy_server, cls.proxy_url = helpers.start_server(helpers.proxy.Handler)

    @classmethod
    def tearDownClass(cls):
        for server in [cls.echo, cls.proxy_server]:
            server.shutdown()
            server.server_close()

    def received(self, auth, **options):
        compiled = subprocess.run(
            ['node', '--input-type=module', '-e', COMPILE], cwd=helpers.ROOT,
            input=json.dumps({'url': self.url, 'auth': auth, **options}),
            capture_output=True, text=True, timeout=10, check=True,
        )
        payload = json.loads(compiled.stdout)
        with urlopen(Request(
            self.proxy_url + '/api/request', data=json.dumps(payload).encode(),
            headers={'Content-Type': 'application/json'},
        ), timeout=10) as response:
            result = json.load(response)
        self.assertTrue(result['ok'])
        self.assertEqual(result['status'], 200)
        received = json.loads(result['body'])
        received['headers'] = {k.lower(): v for k, v in received['headers']}
        received['query'] = parse_qs(urlsplit(received['path']).query)
        return received

    def test_v20_auth_helpers_reach_real_http_target(self):
        basic = base64.b64encode('日本:fixture-token'.encode()).decode()
        cases = [
            ({'type': 'basic', 'basic': {'username': '日本', 'password': '{{token}}'}}, 'authorization', 'Basic ' + basic, 'headers'),
            ({'type': 'bearer', 'bearer': {'token': '{{token}}'}}, 'authorization', 'Bearer fixture-token', 'headers'),
            ({'type': 'apikey', 'apikey': {'key': 'x-api-key', 'value': '{{token}}', 'in': 'header'}}, 'x-api-key', 'fixture-token', 'headers'),
            ({'type': 'apikey', 'apikey': {'key': 'api_key', 'value': '{{token}}', 'in': 'query'}}, 'api_key', ['fixture-token'], 'query'),
            ({'type': 'oauth2', 'oauth2': {'accessToken': '{{token}}'}}, 'authorization', 'Bearer fixture-token', 'headers'),
            ({'type': 'oauth2', 'oauth2': {'accessToken': '{{token}}', 'addTokenTo': 'queryParams'}}, 'access_token', ['fixture-token'], 'query'),
        ]
        for auth, key, expected, location in cases:
            with self.subTest(type=auth['type'], location=location):
                self.assertEqual(self.received(auth)[location].get(key), expected)

    def test_auth_inheritance_and_noauth_at_the_http_boundary(self):
        auth = {'type': 'bearer', 'bearer': {'token': '{{token}}'}}
        for level in ['collection', 'folder', 'request']:
            with self.subTest(level=level):
                self.assertEqual(self.received(auth, level=level)['headers'].get('authorization'), 'Bearer fixture-token')
        self.assertNotIn('authorization', self.received(auth, level='collection', noauth=True)['headers'])

    def test_roundtrip_schema_conversion_preserves_sent_credentials(self):
        # The editor uses arrays for either schema; v2.0 export must restore objects.
        auth = {'type': 'basic', 'basic': [{'key': 'username', 'value': 'edited'}, {'key': 'password', 'value': 'password'}]}
        expected = 'Basic ' + base64.b64encode(b'edited:password').decode()
        for version in ['v2.0.0', 'v2.1.0']:
            with self.subTest(version=version):
                self.assertEqual(self.received(auth, version=version, roundtrip=True)['headers'].get('authorization'), expected)

    def test_archive_index_and_environment_import_before_real_send(self):
        received = self.received({'type': 'bearer', 'bearer': {'token': '{{token}}'}}, archive=True)
        self.assertEqual(received['headers'].get('authorization'), 'Bearer environment-token')


if __name__ == '__main__':
    unittest.main()
