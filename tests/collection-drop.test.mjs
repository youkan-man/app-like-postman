import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCollectionDropTargets, resolveCollectionDropTarget} from '../static/collection-drop.mjs';
import {moveCollectionItem, planCollectionMove} from '../static/collection-move.mjs';

const request = id => ({_mpId: id, name: id, request: {method: 'GET', url: 'https://example.test/' + id}});
const folder = (id, item) => ({_mpId: id, name: id, item});
const collection = (id, item) => ({_mpId: id, info: {name: id}, item});
const row = (collectionId, itemId, top, bottom, indentLeft = itemId ? 20 : 0) =>
  ({collectionId, itemId, top, bottom, left: 0, right: 240, indentLeft});
const fixture = () => ({collections: [collection('a', [request('one'), request('two'), request('upload')]),
  collection('b', [request('other')])], tabs: [], revisions: {}});
const flatRows = () => [row('a', '', 0, 32), row('a', 'one', 32, 64), row('a', 'two', 64, 96),
  row('a', 'upload', 100, 132), row('b', '', 140, 172), row('b', 'other', 172, 204)];
const external = {collectionId: 'b', itemId: 'other'};
const resolve = (targets, y, x = 80) => resolveCollectionDropTarget(targets, {x, y});
const gapAt = (targets, parentId, index) => targets.find(target => target.kind === 'gap' && target.parentId === parentId && target.index === index);

test('one sibling boundary has one key, intent and fixed line across both row halves and the gap', () => {
  const workspace = fixture(), rows = flatRows();
  const targets = buildCollectionDropTargets(workspace, external, rows);
  const boundary = gapAt(targets, 'a', 2);
  assert.ok(boundary);
  assert.equal(boundary.y, 98);
  assert.equal(boundary.top, 80);
  assert.equal(boundary.bottom, 116);
  for (const y of [94, 96, 98, 100, 102]) assert.equal(resolve(targets, y), boundary);
  assert.deepEqual(boundary.intent, {...external, targetCollectionId: 'a', targetId: 'upload', position: 'before'});
  assert.equal(targets.filter(target => target.kind === 'gap' && target.y === 98).length, 1);
  moveCollectionItem(workspace, boundary.intent);
  assert.deepEqual(workspace.collections[0].item.map(item => item._mpId), ['one', 'two', 'other', 'upload']);
  assert.deepEqual(workspace.collections[1].item, []);
});

test('a visible list of n siblings exposes n+1 distinct canonical gaps', () => {
  const targets = buildCollectionDropTargets(fixture(), external, flatRows());
  const gaps = targets.filter(target => target.kind === 'gap' && target.parentId === 'a');
  assert.deepEqual(gaps.map(target => target.index), [0, 1, 2, 3]);
  assert.equal(new Set(gaps.map(target => target.key)).size, 4);
  assert.equal(resolve(targets, 34), gaps[0]);
  assert.equal(resolve(targets, 130), gaps[3]);
});

test('first and last gaps remain reachable just outside row edges within bounded padding', () => {
  const rows = flatRows().filter(value => value.collectionId === 'a' && value.itemId);
  const targets = buildCollectionDropTargets(fixture(), external, rows);
  const first = gapAt(targets, 'a', 0), last = gapAt(targets, 'a', 3);
  for (const y of [30, 32, 34]) assert.equal(resolve(targets, y), first);
  for (const y of [130, 132, 134]) assert.equal(resolve(targets, y), last);
  assert.equal(first.y, 32);
  assert.equal(last.y, 132);
  assert.equal(resolve(targets, 15), null);
  assert.equal(resolve(targets, 149), null);
});

test('source removal normalizes its two neighboring slots into one stable no-op', () => {
  const workspace = fixture(), source = {collectionId: 'a', itemId: 'two'};
  const targets = buildCollectionDropTargets(workspace, source, flatRows());
  const noop = targets.filter(target => target.kind === 'gap' && target.noop);
  assert.equal(noop.length, 1);
  assert.equal(noop[0].parentId, 'a');
  assert.equal(noop[0].index, 1);
  assert.equal(resolve(targets, 62), noop[0]);
  assert.equal(resolve(targets, 102), noop[0]);
  assert.equal(resolve(targets, 80), null);
  const before = JSON.stringify(workspace);
  assert.equal(moveCollectionItem(workspace, noop[0].intent).changed, false);
  assert.equal(JSON.stringify(workspace), before);
});

test('first and last source positions do not shift on their normalized no-op boundary', () => {
  for (const itemId of ['one', 'upload']) {
    const workspace = fixture(), targets = buildCollectionDropTargets(workspace, {collectionId: 'a', itemId}, flatRows());
    const gaps = targets.filter(target => target.kind === 'gap' && target.parentId === 'a');
    assert.equal(gaps.length, 3);
    assert.equal(gaps.filter(target => target.noop).length, 1);
    assert.equal(moveCollectionItem(workspace, gaps.find(target => target.noop).intent).changed, false);
  }
});

function nestedFixture() {
  return {collections: [collection('a', [folder('folder', [request('child-one'), request('child-two')]), request('next')]),
    collection('b', [request('other')])], tabs: [], revisions: {}};
}
function nestedRows() {
  return [{...row('a', '', 0, 30), expanded: true}, {...row('a', 'folder', 30, 60), expanded: true},
    row('a', 'child-one', 60, 90, 33), row('a', 'child-two', 90, 120, 33), row('a', 'next', 124, 154),
    row('b', '', 164, 194), row('b', 'other', 194, 224)];
}

test('expanded folder to shallow next sibling is one outer gap after all descendants', () => {
  const workspace = nestedFixture(), targets = buildCollectionDropTargets(workspace, external, nestedRows());
  const boundary = gapAt(targets, 'a', 1);
  assert.equal(boundary.y, 122);
  assert.equal(boundary.intent.targetId, 'next');
  assert.equal(boundary.intent.position, 'before');
  for (const y of [118, 122, 126]) {
    assert.equal(resolve(targets, y, 5), boundary);
    assert.equal(resolve(targets, y, 100), boundary);
  }
  assert.equal(targets.filter(target => target.kind === 'gap' && target.y >= 120 && target.y <= 124).length, 1);
  assert.equal(targets.some(target => target.kind === 'gap' && target.parentId === 'folder' && target.index === 2), false);
  moveCollectionItem(workspace, boundary.intent);
  assert.deepEqual(workspace.collections[0].item.map(item => item._mpId), ['folder', 'other', 'next']);
});

test('folder middle is inside, while header-to-first-child gap prepends its children', () => {
  const workspace = nestedFixture(), targets = buildCollectionDropTargets(workspace, external, nestedRows());
  const inside = resolve(targets, 45);
  assert.equal(inside.kind, 'inside');
  assert.equal(inside.parentId, 'folder');
  assert.equal(inside.index, 2);
  const first = resolve(targets, 62);
  assert.equal(first.kind, 'gap');
  assert.equal(first.parentId, 'folder');
  assert.equal(first.index, 0);
  assert.equal(first.y, 60);
  assert.notEqual(first.key, inside.key);
  moveCollectionItem(workspace, first.intent);
  assert.deepEqual(workspace.collections[0].item[0].item.map(item => item._mpId), ['other', 'child-one', 'child-two']);
});

test('folder append remains available through its center when the outer boundary owns the line', () => {
  const workspace = nestedFixture(), targets = buildCollectionDropTargets(workspace, external, nestedRows());
  const inside = resolve(targets, 45);
  moveCollectionItem(workspace, inside.intent);
  assert.deepEqual(workspace.collections[0].item[0].item.map(item => item._mpId), ['child-one', 'child-two', 'other']);
  assert.deepEqual(workspace.collections[0].item.map(item => item._mpId), ['folder', 'next']);
});

test('moving a folder child before the next root sibling keeps the line at the rendered boundary', () => {
  const workspace = {collections: [collection('a', [folder('folder', [request('source')]), request('next')])]};
  const rows = [row('a', '', 0, 30), row('a', 'folder', 30, 60),
    row('a', 'source', 60, 90, 33), row('a', 'next', 90, 120)];
  const targets = buildCollectionDropTargets(workspace, {collectionId: 'a', itemId: 'source'}, rows);
  const boundary = resolve(targets, 92);
  assert.equal(boundary.kind, 'gap');
  assert.equal(boundary.parentId, 'a');
  assert.equal(boundary.index, 1);
  assert.equal(boundary.noop, false);
  assert.equal(boundary.y, 90);
  assert.equal(resolve(targets, 75), null);
  moveCollectionItem(workspace, boundary.intent);
  assert.deepEqual(workspace.collections[0].item.map(item => item._mpId), ['folder', 'source', 'next']);
});

test('after a folder before the next collection includes the source child in its physical block', () => {
  const workspace = {collections: [collection('a', [folder('folder', [request('source')])]), collection('b', [])]};
  const rows = [row('a', '', 0, 30), row('a', 'folder', 30, 60),
    row('a', 'source', 60, 90, 33), row('b', '', 94, 124)];
  const targets = buildCollectionDropTargets(workspace, {collectionId: 'a', itemId: 'source'}, rows);
  const boundary = resolve(targets, 92);
  assert.equal(boundary.intent.targetId, 'folder');
  assert.equal(boundary.intent.position, 'after');
  assert.equal(boundary.noop, false);
  assert.equal(boundary.y, 92);
  assert.equal(resolve(targets, 75), null);
  moveCollectionItem(workspace, boundary.intent);
  assert.deepEqual(workspace.collections[0].item.map(item => item._mpId), ['folder', 'source']);
});

test('the final after-folder line stays below its rendered source subtree', () => {
  const workspace = {collections: [collection('a', [folder('folder', [folder('source', [request('child')])])])]};
  const rows = [row('a', '', 0, 30), row('a', 'folder', 30, 60),
    row('a', 'source', 60, 90, 33), row('a', 'child', 90, 120, 46)];
  const targets = buildCollectionDropTargets(workspace, {collectionId: 'a', itemId: 'source'}, rows);
  const boundary = resolve(targets, 122);
  assert.equal(boundary.kind, 'gap');
  assert.equal(boundary.intent.targetId, 'folder');
  assert.equal(boundary.intent.position, 'after');
  assert.equal(boundary.y, 120);
  assert.equal(boundary.noop, false);
  assert.equal(resolve(targets, 75), null);
  assert.equal(resolve(targets, 105), null);
  moveCollectionItem(workspace, boundary.intent);
  assert.deepEqual(workspace.collections[0].item.map(item => item._mpId), ['folder', 'source']);
});

test('end of a visible collection uses the last row parent, root append stays on its header', () => {
  const workspace = nestedFixture();
  workspace.collections[0].item.pop();
  const rows = nestedRows().filter(value => value.itemId !== 'next');
  const targets = buildCollectionDropTargets(workspace, external, rows);
  const end = resolve(targets, 118);
  assert.equal(end.kind, 'gap');
  assert.equal(end.parentId, 'folder');
  assert.equal(end.index, 2);
  assert.equal(end.y, 142);
  const rootInside = resolve(targets, 15);
  assert.equal(rootInside.kind, 'inside');
  assert.equal(rootInside.parentId, 'a');
  assert.equal(rootInside.index, 1);
});

test('source folder and every visible descendant are forbidden without jumping to a nearby slot', () => {
  const targets = buildCollectionDropTargets(nestedFixture(), {collectionId: 'a', itemId: 'folder'}, nestedRows());
  for (const y of [31, 45, 59, 62, 75, 105, 119]) assert.equal(resolve(targets, y), null);
  assert.equal(targets.some(target => ['folder', 'child-one', 'child-two'].includes(target.anchor.itemId)), false);
  // Array filtering by the UI does not discard the source exclusion geometry.
  const filtered = targets.filter(target => target.kind === 'gap');
  assert.equal(resolve(filtered, 75), null);
});

test('collapsed and empty parents have reachable inside targets without hidden anchors', () => {
  const workspace = nestedFixture();
  workspace.collections.push(collection('empty', []));
  const rows = [row('a', '', 0, 30), {...row('a', 'folder', 30, 60), expanded: false},
    row('a', 'next', 60, 90), row('b', '', 94, 124), row('b', 'other', 124, 154), row('empty', '', 160, 190)];
  const targets = buildCollectionDropTargets(workspace, external, rows);
  assert.equal(resolve(targets, 45).parentId, 'folder');
  assert.equal(resolve(targets, 45).index, 2);
  assert.equal(resolve(targets, 175).parentId, 'empty');
  assert.equal(resolve(targets, 175).index, 0);
  assert.ok(targets.every(target => rows.includes(target.anchor)));
  assert.equal(targets.some(target => target.anchor.itemId?.startsWith('child-')), false);
});

test('filtered siblings share one visible gap anchored before the next shown item', () => {
  const workspace = fixture();
  const rows = [row('a', '', 0, 32), row('a', 'one', 32, 64), row('a', 'upload', 68, 100),
    row('b', '', 108, 140), row('b', 'other', 140, 172)];
  const targets = buildCollectionDropTargets(workspace, external, rows), boundary = resolve(targets, 66);
  assert.equal(boundary.parentId, 'a');
  assert.equal(boundary.index, 2);
  assert.equal(boundary.intent.targetId, 'upload');
  assert.equal(boundary.y, 66);
  assert.equal(resolve(targets, 62), boundary);
  assert.equal(resolve(targets, 70), boundary);
  assert.equal(targets.some(target => target.anchor.itemId === 'two'), false);
  assert.equal(targets.filter(target => target.kind === 'gap' && target.y === 66).length, 1);
  moveCollectionItem(workspace, boundary.intent);
  assert.deepEqual(workspace.collections[0].item.map(item => item._mpId), ['one', 'two', 'other', 'upload']);
});

test('collection reordering treats expanded collections as complete blocks', () => {
  const workspace = nestedFixture();
  workspace.collections.push(collection('c', [request('c-one')]));
  const rows = [...nestedRows(), row('c', '', 232, 262), row('c', 'c-one', 262, 292)];
  const targets = buildCollectionDropTargets(workspace, {collectionId: 'c'}, rows);
  const between = targets.find(target => target.kind === 'gap' && target.index === 1);
  assert.equal(between.y, 159);
  assert.equal(between.parentId, null);
  for (const y of [152, 159, 166]) assert.equal(resolve(targets, y), between);
  assert.equal(targets.some(target => target.kind === 'inside' || target.anchor.itemId), false);
  assert.equal(resolve(targets, 250), null);
  assert.equal(resolve(targets, 280), null);
  moveCollectionItem(workspace, between.intent);
  assert.deepEqual(workspace.collections.map(value => value._mpId), ['a', 'c', 'b']);
});

test('collection source normalization also produces only one no-op slot', () => {
  const workspace = fixture();
  workspace.collections.push(collection('c', []));
  const rows = [...flatRows(), row('c', '', 212, 244)];
  const targets = buildCollectionDropTargets(workspace, {collectionId: 'b'}, rows);
  assert.equal(targets.filter(target => target.noop).length, 1);
  const noop = targets.find(target => target.noop);
  assert.equal(noop.index, 1);
  assert.equal(resolve(targets, 130), noop);
  assert.equal(resolve(targets, 214), noop);
  assert.equal(moveCollectionItem(workspace, noop.intent).changed, false);
});

test('cross-collection ID collisions, invalid sources and stale rows never produce unsafe targets', () => {
  const workspace = fixture();
  workspace.collections[0].item.push(request('other'));
  const targets = buildCollectionDropTargets(workspace, external, flatRows());
  assert.equal(targets.some(target => target.intent.targetCollectionId === 'a'), false);
  assert.deepEqual(buildCollectionDropTargets(workspace, {collectionId: 'missing', itemId: 'x'}, flatRows()), []);
  assert.deepEqual(buildCollectionDropTargets(workspace, {collectionId: 'a', itemId: 'missing'}, flatRows()), []);
  const stale = row('a', 'removed', 300, 332);
  assert.equal(buildCollectionDropTargets(fixture(), external, [...flatRows(), stale]).some(target => target.anchor === stale), false);
});

test('outside, malformed and source-only geometry does not select a remote target', () => {
  const targets = buildCollectionDropTargets(fixture(), external, flatRows());
  for (const point of [{x: -1, y: 98}, {x: 241, y: 98}, {x: 80, y: -20}, {x: 80, y: 250}, {x: NaN, y: 98}]) {
    assert.equal(resolveCollectionDropTarget(targets, point), null);
  }
  const workspace = {collections: [collection('a', [request('only')])]};
  assert.deepEqual(buildCollectionDropTargets(workspace, {collectionId: 'a'}, [row('a', '', 0, 32), row('a', 'only', 32, 64)]), []);
  assert.equal(resolveCollectionDropTarget([], {x: 10, y: 10}), null);
});

test('geometry refresh changes only line coordinates; keys and intents remain stable', () => {
  const workspace = fixture(), rows = flatRows();
  const before = buildCollectionDropTargets(workspace, external, rows);
  const after = buildCollectionDropTargets(workspace, external, rows.map(value => ({...value, top: value.top - 40, bottom: value.bottom - 40})));
  assert.deepEqual(after.map(target => [target.key, target.intent]), before.map(target => [target.key, target.intent]));
  assert.deepEqual(after.map(target => target.y), before.map(target => target.y - 40));
});

test('all returned plans agree with normalized indices and building never mutates workspace or rows', () => {
  const workspace = nestedFixture(), rows = nestedRows(), source = {collectionId: 'a', itemId: 'child-two'};
  const marker = {};
  rows[0].element = marker;
  const snapshot = JSON.stringify({workspace, rows});
  const targets = buildCollectionDropTargets(workspace, source, rows);
  assert.equal(targets[0].kind, 'inside');
  assert.equal(targets[0].anchor.element, marker);
  assert.equal(targets[0].rowdescriptor, targets[0].anchor);
  assert.equal(new Set(targets.map(target => target.key)).size, targets.length);
  for (const target of targets) {
    const plan = planCollectionMove(workspace, target.intent), oldIndex = plan.from.indexOf(plan.item);
    let index = plan.position === 'inside' ? plan.into.length : plan.into.indexOf(plan.anchor) + (plan.position === 'after' ? 1 : 0);
    if (plan.from === plan.into && index > oldIndex) index--;
    assert.equal(target.index, index);
    assert.equal(target.noop, plan.from === plan.into && index === oldIndex);
  }
  assert.equal(JSON.stringify({workspace, rows}), snapshot);
});
