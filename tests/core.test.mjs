import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {SCHEMA, rows, urlParts, displayUrl, setUrlText, setQuery, normalizeRequest, newRequest, importPostman, exportCollection, contextFor, resolver, compileRequest, walkItems} from '../static/core.mjs';

const collection = (request = {}, extra = {}) => ({info: {name: 'API', schema: SCHEMA}, item: [{name: 'Request', request: {method: 'GET', url: 'http://localhost/test', ...request}}], ...extra});
function setup(data = collection()) {
  const c = importPostman(data).collections[0]; let item;
  walkItems(c.item, i => {if (i.request && !item) item = i;});
  const w = {collections: [c], environments: [], globals: [], environmentId: ''};
  const tab = {id: 'tab', collectionId: c._mpId, itemId: item._mpId, request: item.request};
  return {c, w, tab, item};
}
const compile = (request, extra) => {const {w, tab} = setup(collection(request, extra)); return compileRequest(w, tab).payload;};

test('Collection v2.0 and v2.1 including BOM', () => {
  for (const v of ['v2.0.0', 'v2.1.0']) {
    const data = collection(); data.info.schema = SCHEMA.replace('v2.1.0', v);
    assert.equal(importPostman('\uFEFF' + JSON.stringify(data)).collections[0].info.name, 'API');
  }
});
test('request shorthand strings and nested folders', () => {
  const data = collection(); data.item = [{name: 'A', item: [{name: 'B', item: [{name: 'R', request: 'http://localhost/r'}]}]}];
  const {c, w, tab} = setup(data); assert.equal(contextFor(w, tab).parents.length, 2); assert.equal(tab.request.method, 'GET'); assert.ok(c.item[0]._mpId);
});
test('Collection and Environment API wrappers', () => {assert.equal(importPostman({collection: collection()}).collections.length, 1); assert.equal(importPostman({environment: {name: 'e', values: []}}).environments.length, 1);});
test('Environment, Globals and data dump', () => {
  const result = importPostman({collections: [collection()], environments: [{name: 'Dev', values: [{key: 'a', value: 5}]}], globals: [{key: 'a', value: 'global'}]});
  assert.equal(result.environments[0].values[0].value, '5'); assert.equal(result.globals[0].value, 'global');
  assert.equal(importPostman({values: [{key: 'g', value: 1}]}, 'globals.postman_globals.json').globals.length, 1);
});
test('separate imports never share IDs', () => {assert.notEqual(importPostman(collection()).collections[0]._mpId, importPostman(collection()).collections[0]._mpId);});
test('reject invalid JSON, unknown formats, v1 and unknown variable scopes', () => {
  for (const data of ['no-json', 'null', '[]', '{}', {requests: []}, {values: [], _postman_variable_scope: 'bad'}]) assert.throws(() => importPostman(data));
  const c = collection(); c.info.schema = '/v1.0.0/collection.json'; assert.throws(() => importPostman(c));
});
test('query object overrides raw and preserves duplicate and disabled values', () => {
  const p = compile({url: {raw: 'http://localhost/p?k=old', query: [{key: 'k', value: 'a'}, {key: 'k', value: 'b'}, {key: 'disabled', value: 'x', disabled: true}]}});
  assert.equal(p.url, 'http://localhost/p?k=a&k=b');
});
test('query string is parsed without duplication and keeps hash separate', () => {
  const r = normalizeRequest({url: 'http://localhost/p?x=1&x=2#section'}); assert.equal(r.url.query.length, 2);
  const {w, tab} = setup(collection(r)); assert.equal(compileRequest(w, tab).payload.url, 'http://localhost/p?x=1&x=2');
});
test('URL editing and Params editing remain synchronized', () => {
  const r = newRequest(); setUrlText(r, '{{baseUrl}}/p?q=a%20b'); assert.equal(r.url.query[0].value, 'a b');
  r.url.query.push({key: 'x', value: '{{token}}'}); setQuery(r, r.url.query);
  assert.equal(displayUrl(r.url), '{{baseUrl}}/p?q=a%20b&x={{token}}');
  setUrlText(r, 'http://localhost/new?z=3'); assert.equal(r.url.query.length, 1); assert.equal(r.url.query[0].key, 'z');
});
test('construct structured URL with protocol, host, port, path', () => {
  assert.equal(compile({url: {protocol: 'http', host: ['local', 'test'], port: '9090', path: ['api', 'ports'], query: [{key: 'a', value: '1'}]}}).url, 'http://local.test:9090/api/ports?a=1');
});
test('environment wins over collection and global; disabled overrides skipped', () => {
  const {w, tab, c} = setup(collection({url: '{{baseUrl}}/{{x}}'}, {variable: [{key: 'baseUrl', value: 'http://localhost'}, {key: 'x', value: 'collection'}]}));
  w.globals = [{key: 'x', value: 'global'}]; w.environments = [{id: 'env', values: [{key: 'x', value: 'environment'}]}]; w.environmentId = 'env';
  assert.equal(compileRequest(w, tab).payload.url, 'http://localhost/environment');
  w.environments[0].values[0].enabled = false; assert.equal(compileRequest(w, tab).payload.url, 'http://localhost/collection');
});
test('variable recursion, false and zero values, cycles, missing and prototype keys', () => {
  const r = resolver({a: '{{b}}', b: 0, c: false}); assert.equal(r('{{a}}/{{c}}'), '0/false');
  assert.throws(() => resolver({a: '{{b}}', b: '{{a}}'})('{{a}}'), /循環/);
  assert.throws(() => resolver({})('{{missing}}'), /未設定/);
  assert.throws(() => resolver({})('{{constructor}}'), /未設定/);
  const proto = JSON.parse('{"__proto__":"safe"}'); assert.equal(resolver(proto)('{{__proto__}}'), 'safe');
});
test('dynamic variables stable within one request', () => {const r = resolver({}); assert.equal(r('{{$guid}}'), r('{{$guid}}')); assert.match(r('{{$timestamp}}'), /^\d+$/);});
test('path variables with slash and UTF-8 are escaped', () => {
  const p = compile({url: {raw: 'http://localhost/:id/a', variable: [{key: 'id', value: '日本/語'}]}});
  assert.equal(p.url, 'http://localhost/%E6%97%A5%E6%9C%AC%2F%E8%AA%9E/a');
  assert.throws(() => compile({url: 'http://localhost/:missing'}), /パス変数/);
});
test('dynamic full URL query retained and additional params appended once', () => {
  assert.equal(compile({url: '{{full}}'}, {variable: [{key: 'full', value: 'http://localhost/a?k=v'}]}).url, 'http://localhost/a?k=v');
});
test('URL query and header variables are escaped correctly', () => {
  const p = compile({url: {raw: 'http://localhost/', query: [{key: 'q', value: '{{q}}'}]}, header: [{key: 'X-Value', value: '{{q}}'}, {key: 'X-Off', value: 'x', disabled: true}]}, {variable: [{key: 'q', value: 'a&b +日本'}]});
  assert.equal(new URL(p.url).searchParams.get('q'), 'a&b +日本'); assert.equal(p.headers.length, 1); assert.equal(p.headers[0].value, 'a&b +日本');
});
test('raw header string supports colon in values and duplicate names', () => {const p = compile({header: 'X-Test: a:b\nX-Test: second'}); assert.equal(p.headers.length, 2); assert.equal(p.headers[0].value, 'a:b');});
test('inherited bearer and explicit noauth', () => {
  const extra = {auth: {type: 'bearer', bearer: [{key: 'token', value: 'parent'}]}};
  assert.equal(compile({}, extra).headers[0].value, 'Bearer parent');
  assert.equal(compile({auth: {type: 'noauth'}}, extra).headers.length, 0);
});
test('folder auth overrides collection and request overrides folder', () => {
  const data = collection({}, {auth: {type: 'bearer', bearer: [{key: 'token', value: 'collection'}]}});
  data.item = [{name: 'Folder', auth: {type: 'bearer', bearer: [{key: 'token', value: 'folder'}]}, item: data.item}];
  const {w, tab} = setup(data); assert.equal(compileRequest(w, tab).payload.headers[0].value, 'Bearer folder');
  tab.request.auth = {type: 'bearer', bearer: [{key: 'token', value: 'request'}]}; assert.equal(compileRequest(w, tab).payload.headers[0].value, 'Bearer request');
});
test('Basic UTF-8 and single generated Authorization', () => {
  const p = compile({header: [{key: 'authorization', value: 'old'}], auth: {type: 'basic', basic: [{key: 'username', value: '日本'}, {key: 'password', value: 'pass'}]}});
  assert.equal(p.headers.length, 1); assert.equal(Buffer.from(p.headers[0].value.slice(6), 'base64').toString(), '日本:pass');
});
test('API key header and query placement', () => {
  for (const where of ['header', 'query']) {
    const p = compile({auth: {type: 'apikey', apikey: [{key: 'key', value: 'api-key'}, {key: 'value', value: 'abc'}, {key: 'in', value: where}]}});
    if (where === 'query') assert.equal(new URL(p.url).searchParams.get('api-key'), 'abc'); else assert.equal(p.headers[0].key, 'api-key');
  }
});
test('OAuth access token only and unsupported auth errors', () => {
  assert.equal(compile({auth: {type: 'oauth2', oauth2: [{key: 'accessToken', value: 'abc'}]}}).headers[0].value, 'Bearer abc');
  assert.throws(() => compile({auth: {type: 'oauth2', oauth2: []}}), /accessToken/);
  assert.throws(() => compile({auth: {type: 'digest'}}), /未対応/);
});
test('raw JSON substitutes variables without forcing valid JSON', () => {
  const p = compile({method: 'POST', body: {mode: 'raw', raw: '{"v":"{{value}}"}', options: {raw: {language: 'json'}}}}, {variable: [{key: 'value', value: 'ok'}]});
  assert.equal(p.body, '{"v":"ok"}'); assert.equal(p.headers[0].value, 'application/json');
  assert.equal(compile({body: {mode: 'raw', raw: '{invalid-json'}}).body, '{invalid-json');
});
test('all raw languages and explicit content type respected', () => {
  for (const [lang, type] of [['json', 'application/json'], ['xml', 'application/xml'], ['html', 'text/html'], ['javascript', 'application/javascript']]) assert.equal(compile({body: {mode: 'raw', raw: 'x', options: {raw: {language: lang}}}}).headers[0].value, type);
  assert.equal(compile({header: [{key: 'Content-Type', value: 'custom/type'}], body: {mode: 'raw', raw: 'x'}}).headers[0].value, 'custom/type');
});
test('urlencoded repeated keys and inactive entries', () => {
  const p = compile({method: 'POST', body: {mode: 'urlencoded', urlencoded: [{key: 'q', value: 'a b'}, {key: 'q', value: 'c+d'}, {key: 'off', value: 'x', disabled: true}]}});
  assert.equal(p.body, 'q=a+b&q=c%2Bd'); assert.equal(p.headers[0].value, 'application/x-www-form-urlencoded');
});
test('binary and multipart require reselection and preserve chosen bytes', () => {
  const {w, tab} = setup(collection({method: 'POST', body: {mode: 'file', file: {src: '/private/path.bin'}}}));
  assert.throws(() => compileRequest(w, tab), /ファイル/);
  assert.equal(compileRequest(w, tab, {binary: [{name: 'a.bin', type: '', data: 'AAEC'}]}).payload.body_base64, 'AAEC');
  tab.request.body = {mode: 'formdata', formdata: [{key: 'meta', value: 'x'}, {key: 'upload', type: 'file'}, {key: 'off', type: 'file', disabled: true}]};
  assert.throws(() => compileRequest(w, tab), /upload/);
  const parts = compileRequest(w, tab, {'form-1': [{name: 'a.bin', type: 'application/octet-stream', data: 'AAEC'}, {name: 'b.bin', data: 'AwQ='}]}).payload.multipart;
  assert.equal(parts.length, 3); assert.equal(parts[1].data, 'AAEC');
});
test('GraphQL JSON variables and query', () => {const p = compile({body: {mode: 'graphql', graphql: {query: 'query { hello }', variables: '{"n":1}'}}}); assert.deepEqual(JSON.parse(p.body), {query: 'query { hello }', variables: {n: 1}});});
test('none and disabled bodies do not send data; GET body is allowed', () => {
  assert.equal(compile({body: {mode: 'none', raw: 'x'}}).body, null);
  assert.equal(compile({body: {mode: 'raw', raw: 'x', disabled: true}}).body, null);
  assert.equal(compile({method: 'GET', body: {mode: 'raw', raw: 'x'}}).body, 'x');
});
test('settings preserve self-signed TLS default, infinite timeout, redirects', () => {
  const {w, tab} = setup(); assert.equal(compileRequest(w, tab).payload.verify_tls, false);
  tab.settings = {verify_tls: true, follow_redirects: false, timeout_ms: 0};
  const p = compileRequest(w, tab).payload; assert.equal(p.verify_tls, true); assert.equal(p.follow_redirects, false); assert.equal(p.timeout_ms, 0);
});
test('unsupported scripts are preserved, visible in context and warned about', () => {
  const data = collection(); data.event = [{listen: 'prerequest', script: {exec: ['pm.variables.set("x",1);']}}]; data.item[0].response = [{name: 'Example', code: 200}];
  const imported = importPostman(data); assert.ok(imported.warnings.length);
  const {w, tab, c} = setup(data); assert.ok(compileRequest(w, tab).warnings.length);
  const out = exportCollection(c); assert.deepEqual(out.event, data.event); assert.deepEqual(out.item[0].response, data.item[0].response); assert.equal(JSON.stringify(out).includes('_mpId'), false);
});
test('unknown metadata and auth data survive re-export', () => {
  const data = collection({auth: {type: 'digest', digest: [{key: 'username', value: 'u'}]}, certificate: {name: 'keep'}}, {custom: {a: 1}});
  const c = importPostman(data).collections[0]; const out = exportCollection(c); assert.deepEqual(out.custom, {a: 1}); assert.deepEqual(out.item[0].request.auth, data.item[0].request.auth); assert.equal(out.item[0].request.certificate.name, 'keep');
});
test('Gateway sample imports with nested folders and no embedded token', () => {
  const data = JSON.parse(fs.readFileSync(new URL('./fixtures/com-gateway.postman_collection.json', import.meta.url)));
  const {w, tab, c} = setup(data); assert.equal(c.item.length, 3);
  assert.equal(compileRequest(w, tab).payload.headers.length, 0);
  c.variable.find(v => v.key === 'baseUrl').value = 'http://127.0.0.1:9999';
  c.variable.find(v => v.key === 'gatewayToken').value = 'test-only-token';
  let create; walkItems(c.item, i => {if (i.name === 'Create demo port') create = i;}); tab.itemId = create._mpId; tab.request = create.request;
  const p = compileRequest(w, tab).payload;
  assert.equal(p.url, 'http://127.0.0.1:9999/api/ports'); assert.equal(JSON.parse(p.body).source.kind, 'demo');
  assert.equal(p.headers.find(h => h.key === 'Authorization').value, 'Bearer test-only-token');
});
