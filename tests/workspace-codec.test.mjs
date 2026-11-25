import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_WORKSPACE_BYTES, PACKED_WORKSPACE_KIND, isPackedWorkspaceBundle,
  packWorkspaceBundle, unpackWorkspaceBundle} from '../static/workspace-codec.mjs';

const packed = (nodes, root = nodes.length - 1) => ({kind: PACKED_WORKSPACE_KIND, version: 1, root, nodes});
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const wireRoundTrip = value => unpackWorkspaceBundle(JSON.parse(JSON.stringify(packWorkspaceBundle(value))));
const envelope = workspace => ({kind: 'minipost.workspace', version: 1, workspace});
const body = Array.from({length: 4096}, (_, index) => `${index.toString(36)}:${Math.imul(index + 17, 2654435761).toString(36)}:${Math.imul(index + 101, 2246822519).toString(36)}`).join('\n');

test('pooling retains complete JSON data, Unicode, object order and metadata', () => {
  const value = envelope({version: 2, strings: ['', '日本語', 'é', '😀', '\ud800', '\n\t"\\'],
    numbers: [0, -0, 1.25, 1e-20, 1e30], other: [true, false, null, [], {}],
    repeated: Array.from({length: 8}, (_, index) => ({index, body, nested: {value: 'data', enabled: true}}))});
  value.layout = {theme: 'light'}; value.exported_at = '2026-11-25T00:00:00Z';
  const original = JSON.parse(JSON.stringify(value)), archive = packWorkspaceBundle(value);
  assert.ok(isPackedWorkspaceBundle(archive));
  const recovered = unpackWorkspaceBundle(JSON.parse(JSON.stringify(archive)));
  assert.deepEqual(recovered, original);
  assert.equal(JSON.stringify(recovered), JSON.stringify(value));
  assert.equal(MAX_WORKSPACE_BYTES, 256 * 1024 * 1024);
});

test('ordinary JSON omissions, sparse arrays, non-finite values and toJSON survive', () => {
  const sparse = []; sparse[4] = Infinity;
  const value = envelope({omitted: undefined, fn: () => {}, symbol: Symbol('x'), sparse,
    boxed: [new String('text'), new Number(12), new Boolean(false)],
    numbers: [NaN, Infinity, -Infinity],
    date: new Date('2026-11-25T00:00:00Z'), custom: {toJSON: key => ({key, value: 3})},
    repeated: Array.from({length: 4}, () => ({body}))});
  assert.deepEqual(wireRoundTrip(value), JSON.parse(JSON.stringify(value)));
  const circular = {}; circular.self = circular;
  assert.throws(() => packWorkspaceBundle(circular), /循環/);
  assert.throws(() => packWorkspaceBundle({value: 1n}), /BigInt/);
  assert.throws(() => packWorkspaceBundle(undefined), /JSON/);
});

test('prototype names and packed-looking user data have no marker collisions', () => {
  const special = JSON.parse('{"__proto__":{"polluted":"no"},"constructor":{"value":7},"prototype":[1,2],"toString":"own"}');
  const value = envelope({special, literal: [PACKED_WORKSPACE_KIND, ['a', [0]], ['o', ['__proto__', 0]]],
    marker: {kind: PACKED_WORKSPACE_KIND, version: 1, root: 0, nodes: ['not an archive here']},
    bodies: [body, body, body]});
  const result = wireRoundTrip(value);
  assert.deepEqual(result, value);
  assert.ok(Object.hasOwn(result.workspace.special, '__proto__'));
  assert.equal(Object.getPrototypeOf(result.workspace.special), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test('large distant bodies and identical subtrees are stored once', () => {
  assert.ok(body.length > 32 * 1024);
  const value = envelope({revisions: Array.from({length: 24}, (_, index) => ({
    id: `revision-${index}`, value: {name: `Change ${index}`, request: {method: 'POST', body}, settings: {timeout: 30000}}
  }))});
  const archive = packWorkspaceBundle(value);
  assert.ok(isPackedWorkspaceBundle(archive));
  assert.equal(archive.nodes.filter(node => node === body).length, 1);
  assert.ok(bytes(archive) < bytes(value) / 15);
  assert.deepEqual(unpackWorkspaceBundle(archive), value);
});

test('a history larger than the old 10 MiB limit round trips without pruning', () => {
  const value = envelope({history: Array.from({length: 180}, (_, index) => ({
    id: `history-${index}`, tab: {name: `Request ${index}`, request: {method: 'POST', url: '/api/data', body}},
    sent_requests: [{method: 'POST', url: '/api/data', body}]
  }))});
  assert.ok(bytes(value) > 10 * 1024 * 1024);
  const archive = packWorkspaceBundle(value), recovered = unpackWorkspaceBundle(archive);
  assert.ok(bytes(archive) < 1024 * 1024);
  assert.deepEqual(recovered, value);
  assert.equal(recovered.workspace.history.length, 180);
});

test('legacy canonical archives pass through unchanged and small archives stay plain', () => {
  const value = envelope({version: 2, collections: [], environments: [], globals: [], tabs: [], history: []});
  assert.equal(unpackWorkspaceBundle(value), value);
  const small = {name: 'Example'};
  assert.equal(packWorkspaceBundle(small), small);
  assert.equal(isPackedWorkspaceBundle(value), false);
});

test('corrupt nodes, versions, keys and non-backward references are rejected', () => {
  const invalid = [
    {...packed([null]), version: 2}, packed([]), packed([null], -1), packed([null], 1), packed([null], 0.5),
    packed([{}]), packed([undefined]), packed([NaN]), packed([Infinity]),
    packed([['x', []]]), packed([['a', {}]]), packed([['a', [], 0]]),
    packed([['a', [0]]]), packed([['a', [1]], null]), packed([null, ['a', [-1]]]),
    packed([null, ['a', [0.5]]]), packed([null, ['a', ['0']]]),
    packed([null, ['o', ['key']]]), packed([null, ['o', [1, 0]]]),
    packed([null, ['o', ['key', 0, 'key', 0]]]), packed([['o', ['self', 0]]]),
    packed([null, ['a', [Number.MAX_SAFE_INTEGER + 1]]])
  ];
  for (const value of invalid) assert.throws(() => unpackWorkspaceBundle(value), /不正/);
  assert.equal(unpackWorkspaceBundle(packed(['first', 'unused'], 0)), 'first');
});

test('UTF-8 expanded size checks are exact and reject exponential DAGs before expansion', () => {
  const value = {日本語: '😀'}, archive = packed(['😀', ['o', ['日本語', 0]]]);
  const size = bytes(value);
  assert.deepEqual(unpackWorkspaceBundle(archive, {maxBytes: size}), value);
  assert.throws(() => unpackWorkspaceBundle(archive, {maxBytes: size - 1}), /サイズ/);
  assert.throws(() => packWorkspaceBundle(value, {maxBytes: size - 1}), /サイズ/);
  assert.throws(() => unpackWorkspaceBundle(archive, {maxBytes: 0}), /上限/);
  const nodes = ['1234567890'];
  for (let at = 0; at < 60; at++) nodes.push(['a', [at, at]]);
  assert.throws(() => unpackWorkspaceBundle(packed(nodes), {maxBytes: 1024}), /サイズ/);
  assert.throws(() => unpackWorkspaceBundle(packed(nodes)), /サイズ/);
});

test('nesting is bounded at 256 containers for packing and unpacking', () => {
  let value = null;
  const nodes = [null];
  for (let at = 0; at < 256; at++) {value = [value]; nodes.push(['a', [at]]);}
  assert.deepEqual(unpackWorkspaceBundle(packed(nodes)), value);
  assert.doesNotThrow(() => packWorkspaceBundle(value));
  nodes.push(['a', [nodes.length - 1]]);
  assert.throws(() => unpackWorkspaceBundle(packed(nodes)), /階層/);
  assert.throws(() => packWorkspaceBundle([value]), /階層/);
});

test('pooled snapshots expand into independent mutable arrays and objects', () => {
  const item = {body, nested: [{value: 7}]};
  const original = envelope({current: item, revisions: [{value: item}, {value: item}]});
  const archive = packWorkspaceBundle(original);
  assert.ok(isPackedWorkspaceBundle(archive));
  const restored = unpackWorkspaceBundle(archive).workspace;
  restored.current.nested[0].value = 8;
  restored.revisions[0].value.nested.push({value: 9});
  assert.equal(restored.revisions[0].value.nested[0].value, 7);
  assert.deepEqual(restored.revisions[1].value.nested, [{value: 7}]);
  assert.deepEqual(original.workspace.current.nested, [{value: 7}]);
});
