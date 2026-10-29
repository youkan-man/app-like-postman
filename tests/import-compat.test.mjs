import test from 'node:test';
import assert from 'node:assert/strict';
import {SCHEMA, importPostman, exportCollection, compileRequest, walkItems, rows} from '../static/core.mjs';

// Synthetic values only. These tests neither contact a Gateway nor use saved credentials.
const legacySchema = SCHEMA.replace('v2.1.0', 'v2.0.0');
function fixture(auth, {schema = legacySchema, level = 'request'} = {}) {
  const request = {method: 'GET', url: 'http://localhost/api/ports'};
  const leaf = {name: 'Ports', request};
  const folder = {name: 'Gateway', item: [leaf]};
  const source = {info: {name: 'Compatibility', schema}, item: [folder], variable: [{key: 'token', value: 'fixture-token'}]};
  ({request, folder, collection: source}[level]).auth = auth;
  const collection = importPostman(source).collections[0];
  let item;
  walkItems(collection.item, i => {if (i.request) item = i;});
  const workspace = {collections: [collection], environments: [], globals: [], environmentId: ''};
  const tab = {collectionId: collection._mpId, itemId: item._mpId, request: item.request};
  return {collection, workspace, tab};
}
function send(auth, options) {
  const {workspace, tab} = fixture(auth, options);
  return compileRequest(workspace, tab).payload;
}
const authorization = payload => payload.headers.find(h => h.key.toLowerCase() === 'authorization')?.value;

test('v2.0 Basic object imports actual UTF-8 username and password', () => {
  const payload = send({type: 'basic', basic: {username: '日本', password: '{{token}}', saveHelperData: true}});
  assert.equal(Buffer.from(authorization(payload).slice(6), 'base64').toString('utf8'), '日本:fixture-token');
});
test('v2.0 Bearer object is resolved at collection, folder and request scopes', () => {
  for (const level of ['collection', 'folder', 'request']) {
    assert.equal(authorization(send({type: 'bearer', bearer: {token: '{{token}}'}}, {level})), 'Bearer fixture-token');
  }
});
test('v2.0 API Key object supports header and query placement', () => {
  for (const placement of ['header', 'query']) {
    const payload = send({type: 'apikey', apikey: {key: 'gateway-key', value: '{{token}}', in: placement}});
    if (placement === 'query') assert.equal(payload.query.find(row=>row.key==='gateway-key').value, 'fixture-token');
    else assert.equal(payload.headers.find(h => h.key === 'gateway-key')?.value, 'fixture-token');
  }
});
test('v2.0 OAuth object supports header prefix and query token', () => {
  assert.equal(authorization(send({type: 'oauth2', oauth2: {accessToken: '{{token}}', headerPrefix: 'Token'}})), 'Token fixture-token');
  const payload = send({type: 'oauth2', oauth2: {accessToken: '{{token}}', addTokenTo: 'queryParams'}});
  assert.equal(payload.query.find(row=>row.key==='access_token').value, 'fixture-token');
});
test('explicit noauth still suppresses inherited v2.0 authentication', () => {
  const {workspace, tab} = fixture({type: 'bearer', bearer: {token: '{{token}}'}}, {level: 'collection'});
  tab.request.auth = {type: 'noauth'};
  assert.equal(authorization(compileRequest(workspace, tab).payload), undefined);
});
test('object auth attributes work with the existing rows-based auth editor', () => {
  assert.deepEqual(rows({username: 'u', password: 'p'}).map(({key, value}) => [key, value]), [['username', 'u'], ['password', 'p']]);
});
test('v2.0 edited auth exports as objects at every supported scope', () => {
  for (const level of ['collection', 'folder', 'request']) {
    const {collection} = fixture({type: 'basic', basic: [{key: 'username', value: 'edited'}, {key: 'password', value: 'p'}]}, {level});
    const out = exportCollection(collection);
    const owner = ({collection: out, folder: out.item[0], request: out.item[0].item[0].request})[level];
    assert.equal(out.info.schema, legacySchema);
    assert.deepEqual(owner.auth.basic, {username: 'edited', password: 'p'});
  }
});
test('v2.0 unchanged auth keeps additional metadata and value types', () => {
  const auth = {type: 'basic', basic: {username: 'u', password: 'p', saveHelperData: true}};
  const {collection} = fixture(auth);
  assert.deepEqual(exportCollection(collection).item[0].item[0].request.auth, auth);
});
test('v2.0 export omits disabled attributes from a converted editable array', () => {
  const {collection} = fixture({type: 'basic', basic: [{key: 'username', value: 'u'}, {key: 'password', value: 'not-used', disabled: true}]});
  assert.deepEqual(exportCollection(collection).item[0].item[0].request.auth.basic, {username: 'u'});
});
test('v2.1 re-export retains array attribute metadata without mutating workspace', () => {
  const auth = {type: 'basic', basic: [{key: 'username', value: 'u', type: 'string', description: 'keep'}]};
  const {collection} = fixture(auth, {schema: SCHEMA});
  const before = JSON.stringify(collection);
  assert.deepEqual(exportCollection(collection).item[0].item[0].request.auth, auth);
  assert.equal(JSON.stringify(collection), before);
});
test('v2.1 output converts legacy object attributes to the declared array schema', () => {
  const {collection} = fixture({type: 'bearer', bearer: {token: '{{token}}'}}, {schema: SCHEMA});
  assert.deepEqual(exportCollection(collection).item[0].item[0].request.auth.bearer, [{key: 'token', value: '{{token}}'}]);
});
test('v2.0 import, edit, export, re-import preserves the effective request', () => {
  const {collection, workspace, tab} = fixture({type: 'bearer', bearer: {token: '{{token}}'}});
  tab.request.auth.bearer = [{key: 'token', value: 'edited-token', type: 'string'}];
  const expected = compileRequest(workspace, tab).payload;
  const again = importPostman(exportCollection(collection)).collections[0];
  const item = again.item[0].item[0];
  workspace.collections = [again];
  assert.deepEqual(compileRequest(workspace, {collectionId: again._mpId, itemId: item._mpId, request: item.request}).payload, expected);
});
test('data dump archive.json index does not abort sibling file imports', () => {
  const index = {version: 1, collections: ['collection-id'], environments: ['environment-id']};
  const {collection} = fixture({type: 'bearer', bearer: {token: '{{token}}'}});
  const files = [[index, 'archive.json'], [exportCollection(collection), 'collection.json'], [{name: 'Local', values: [{key: 'token', value: 'env-token'}]}, 'environment.json']];
  const parsed = files.map(([content, name]) => importPostman(content, name));
  assert.equal(parsed.flatMap(p => p.collections).length, 1);
  assert.equal(parsed.flatMap(p => p.environments).length, 1);
  assert.equal(parsed[0].warnings.length, 1);
  assert.match(parsed[0].warnings[0], /索引/);
});
test('empty and path-qualified archive indices are recognized', () => {
  for (const name of ['archive.json', 'export/archive.json', 'export\\ARCHIVE.JSON']) {
    const result = importPostman({collections: [], environments: []}, name);
    assert.equal(result.collections.length, 0);
    assert.match(result.warnings[0], /索引/);
  }
});
test('index handling does not silently swallow malformed data or another file', () => {
  for (const value of [{collections: ['id', 4]}, {collections: ['id', {}]}, {collections: 'id', environments: []}]) {
    assert.throws(() => importPostman(value, 'archive.json'));
  }
  assert.throws(() => importPostman({collections: ['id']}, 'request.json'));
});
test('a real embedded data dump named archive.json is imported, not skipped', () => {
  const {collection} = fixture({type: 'noauth'});
  const result = importPostman({collections: [exportCollection(collection)], environments: [{name: 'Dev', values: []}]}, 'archive.json');
  assert.equal(result.collections.length, 1);
  assert.equal(result.environments.length, 1);
});
test('unsupported legacy authentication is retained and still rejected on send', () => {
  const auth = {type: 'digest', digest: {username: 'u', password: 'p'}};
  const {collection, workspace, tab} = fixture(auth);
  assert.deepEqual(exportCollection(collection).item[0].item[0].request.auth, auth);
  assert.throws(() => compileRequest(workspace, tab), /未対応/);
});
