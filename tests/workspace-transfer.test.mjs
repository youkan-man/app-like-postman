import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {prepareWorkspaceUpload} from '../static/workspace-transfer.mjs';
import {unpackWorkspaceBundle} from '../static/workspace-codec.mjs';
import {exportWorkspace, isWorkspaceBundle, readWorkspaceBundle} from '../static/workspace-data.mjs';

const workspace = () => ({version: 2, collections: [], environments: [], globals: [], tabs: [], history: [], revisions: {}});
const decode = upload => unpackWorkspaceBundle(JSON.parse(upload.headers['Content-Encoding'] === 'gzip'
  ? gunzipSync(Buffer.from(upload.body)).toString('utf8') : upload.body));

test('large workspace uploads pool repeated content before gzip without losing snapshots', async () => {
  const ws = workspace();
  const source = Array.from({length: 6000}, (_, i) => `const value_${i} = ${i * 7919};`).join('\n');
  ws.scripts = [{id: 'script', name: 'Large source', source, input: '', inputFormat: 'text', timeoutMs: 0}];
  ws.revisions['script:script'] = Array.from({length: 80}, (_, i) => ({id: `r${i}`, value: {name: `Version ${i}`, source}}));
  const bundle = exportWorkspace(ws);
  const rawBytes = Buffer.byteLength(JSON.stringify(bundle));
  assert.ok(rawBytes > 10 * 1024 * 1024);
  const upload = await prepareWorkspaceUpload(bundle);
  assert.equal(upload.headers['Content-Encoding'], 'gzip');
  assert.ok(upload.body.byteLength < rawBytes / 50);
  assert.deepEqual(decode(upload), bundle);
  const incoming = JSON.parse(gunzipSync(Buffer.from(upload.body)).toString('utf8'));
  assert.ok(isWorkspaceBundle(incoming));
  assert.deepEqual(readWorkspaceBundle(incoming).workspace, ws);
});

test('saving snapshots content before asynchronous compression and preserves newer edits', async () => {
  const ws = workspace();
  ws.globals = [{key: 'state', value: 'before'.repeat(12000)}];
  const expected = exportWorkspace(ws);
  const pending = prepareWorkspaceUpload(exportWorkspace(ws, null, {copy: false}));
  ws.globals[0].value = 'after';
  const actual = decode(await pending);
  assert.deepEqual(actual.workspace, expected.workspace);
  assert.equal(ws.globals[0].value, 'after');
});

test('pooling works without CompressionStream and failed compression falls back intact', async () => {
  const bundle = exportWorkspace(workspace());
  bundle.workspace.globals = [{key: 'test', value: '日本語'.repeat(18000)}];
  for (const compressionStream of [null, class {constructor() {throw new Error('unavailable');}}]) {
    const upload = await prepareWorkspaceUpload(bundle, {compressionStream});
    assert.equal(upload.headers['Content-Encoding'], undefined);
    assert.deepEqual(decode(upload), bundle);
  }
});

test('ordinary exports remain independent canonical JSON and small uploads stay uncompressed', async () => {
  const ws = workspace();
  ws.globals = [{key: 'value', value: 'old'}];
  const bundle = exportWorkspace(ws);
  ws.globals[0].value = 'new';
  assert.equal(bundle.workspace.globals[0].value, 'old');
  const upload = await prepareWorkspaceUpload(bundle);
  assert.equal(upload.headers['Content-Encoding'], undefined);
  assert.deepEqual(decode(upload), bundle);
});
