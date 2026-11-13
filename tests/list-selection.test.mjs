import test from 'node:test';
import assert from 'node:assert/strict';
import {SelectionState} from '../static/list-selection.mjs';

const order = ['draft:a', 'draft:b', 'draft:c', 'draft:d', 'draft:e'];

test('ordinary selection replaces the previous group', () => {
  const state = new SelectionState();
  state.set(['draft:a', 'draft:c']);
  state.select('draft:b', order);
  assert.deepEqual(state.ids, ['draft:b']);
  assert.equal(state.anchor, 'draft:b');
});

test('individual toggles add and remove without losing the other rows', () => {
  const state = new SelectionState();
  state.select('draft:a', order);
  state.select('draft:c', order, {toggle: true});
  state.select('draft:a', order, {toggle: true});
  assert.deepEqual(state.ids, ['draft:c']);
  assert.equal(state.has('draft:a'), false);
  assert.equal(state.anchor, 'draft:a');
});

test('ranges include both endpoints and can grow and shrink around one anchor', () => {
  const state = new SelectionState();
  state.select('draft:b', order);
  state.select('draft:e', order, {range: true});
  assert.deepEqual(state.ids, order.slice(1));
  state.select('draft:c', order, {range: true});
  assert.deepEqual(state.ids, ['draft:b', 'draft:c']);
  assert.equal(state.anchor, 'draft:b');
  assert.equal(state.focused, 'draft:c');
});

test('backwards ranges follow displayed order and can cross the anchor', () => {
  const state = new SelectionState();
  state.select('draft:c', order);
  state.select('draft:a', order, {range: true});
  assert.deepEqual(state.ids, order.slice(0, 3));
  state.select('draft:d', order, {range: true});
  assert.deepEqual(state.ids, ['draft:c', 'draft:d']);
  assert.equal(state.anchor, 'draft:c');
});

test('Ctrl/Meta + Shift adds a range to an existing disjoint selection', () => {
  const state = new SelectionState();
  state.select('draft:a', order);
  state.select('draft:c', order, {toggle: true});
  state.select('draft:e', order, {range: true, additive: true});
  assert.deepEqual(state.ids, ['draft:a', 'draft:c', 'draft:d', 'draft:e']);
});

test('plain Shift replaces a disjoint selection with the anchored range', () => {
  const state = new SelectionState();
  state.select('draft:a', order);
  state.select('draft:c', order, {toggle: true});
  state.select('draft:e', order, {range: true});
  assert.deepEqual(state.ids, ['draft:c', 'draft:d', 'draft:e']);
});

test('range uses the displayed order, never a hidden row or source sort order', () => {
  const state = new SelectionState();
  const filtered = ['draft:e', 'draft:c', 'draft:a'];
  state.select('draft:e', filtered);
  state.select('draft:a', filtered, {range: true});
  assert.deepEqual(state.ids, filtered);
  assert.equal(state.has('draft:b'), false);
  assert.equal(state.has('draft:d'), false);
});

test('filtering and rerendering discard stale selections and stale anchors', () => {
  const state = new SelectionState();
  state.select('draft:b', order);
  state.select('draft:d', order, {range: true});
  state.reconcile(['draft:c', 'draft:e']);
  assert.deepEqual(state.ids, ['draft:c']);
  assert.equal(state.anchor, 'draft:c');
  assert.equal(state.focused, 'draft:c');
  state.select('draft:e', ['draft:c', 'draft:e'], {range: true});
  assert.deepEqual(state.ids, ['draft:c', 'draft:e']);
});

test('rerendering after row actions preserves a disjoint selection and its keyboard anchor', () => {
  const state = new SelectionState();
  state.select('draft:a', order);
  state.select('draft:d', order, {toggle: true});
  state.focused = 'draft:a';
  state.reconcile([...order]);
  assert.deepEqual(state.ids, ['draft:a', 'draft:d']);
  assert.equal(state.anchor, 'draft:d');
  assert.equal(state.focused, 'draft:a');
  state.select('draft:b', order, {range: true});
  assert.deepEqual(state.ids, ['draft:b', 'draft:c', 'draft:d']);
});

test('select-all is restricted to the current view and preserves a visible anchor', () => {
  const state = new SelectionState();
  state.select('draft:c', order);
  state.selectAll(['draft:a', 'draft:c', 'draft:e']);
  assert.deepEqual(state.ids, ['draft:a', 'draft:c', 'draft:e']);
  assert.equal(state.anchor, 'draft:c');
  state.select('draft:a', ['draft:a', 'draft:c', 'draft:e'], {range: true});
  assert.deepEqual(state.ids, ['draft:a', 'draft:c']);
});

test('switching from drafts to history cannot delete IDs from the previous view', () => {
  const state = new SelectionState();
  state.selectAll(order);
  state.reconcile(['history:a', 'history:b']);
  assert.deepEqual(state.ids, []);
  assert.equal(state.anchor, null);
  assert.equal(state.focused, null);
  state.selectAll(['history:a', 'history:b']);
  assert.deepEqual(state.ids, ['history:a', 'history:b']);
});

test('selection snapshots cannot mutate state or create duplicate deletion targets', () => {
  const state = new SelectionState();
  const input = ['draft:a', 'draft:a', '', null, 'draft:b'];
  state.set(input);
  input.push('draft:c');
  const snapshot = state.ids;
  snapshot.push('draft:d');
  assert.deepEqual(state.ids, ['draft:a', 'draft:b']);
});

test('unknown targets are ignored and clearing removes the range anchor', () => {
  const state = new SelectionState();
  state.select('draft:b', order);
  state.select('draft:missing', order, {toggle: true});
  assert.deepEqual(state.ids, ['draft:b']);
  state.clear();
  assert.deepEqual(state.ids, []);
  assert.equal(state.anchor, null);
  state.select('draft:d', order, {range: true});
  assert.deepEqual(state.ids, ['draft:d']);
});

test('removing the final row leaves no selected ID or stale keyboard target', () => {
  const state = new SelectionState();
  state.select('draft:a', order);
  state.reconcile([]);
  assert.deepEqual(state.ids, []);
  assert.equal(state.anchor, null);
  assert.equal(state.focused, null);
  state.selectAll([]);
  assert.deepEqual(state.ids, []);
});
