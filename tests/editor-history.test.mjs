import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextHistory} from '../static/editor-history.mjs';

const caret = position => ({start:position, end:position, direction:'none'});
const apply = (source, edit) => edit ? source.slice(0, edit.from) + edit.text + source.slice(edit.to) : source;
const input = (inputType, timestamp) => ({inputType, timestamp});

test('Undo and Redo replace only the changed range and restore their exact selections', () => {
  const history = createTextHistory();
  const before = 'prefix old suffix', after = 'prefix new suffix';
  const original = {start:7, end:10, direction:'backward'}, next = caret(10);
  assert.equal(history.record(before, after, original, next), true);
  const undo = history.undo(after);
  assert.deepEqual(undo, {from:7, to:10, text:'old', selectionStart:7, selectionEnd:10, selectionDirection:'backward'});
  assert.equal(apply(after, undo), before);
  assert.equal(history.undo(before), null);
  const redo = history.redo(before);
  assert.deepEqual(redo, {from:7, to:10, text:'new', selectionStart:10, selectionEnd:10, selectionDirection:'none'});
  assert.equal(apply(before, redo), after);
  assert.equal(history.redo(after), null);
});

test('typing and deleting back to the same text never makes Undo jump over the last input', () => {
  const history = createTextHistory();
  history.reset('x');
  history.record('x', 'x ', caret(1), caret(2));
  history.record('x ', 'x y', caret(2), caret(3));
  history.record('x y', 'x ', caret(3), caret(2));
  let source = 'x ';
  for (const expected of ['x y', 'x ', 'x']) {
    source = apply(source, history.undo(source));
    assert.equal(source, expected);
  }
  assert.equal(history.undo(source), null);
  for (const expected of ['x ', 'x y', 'x ']) {
    source = apply(source, history.redo(source));
    assert.equal(source, expected);
  }
});

test('new editing after Undo permanently discards the previous Redo branch', () => {
  const history = createTextHistory();
  history.record('x', 'x ', caret(1), caret(2));
  assert.equal(apply('x ', history.undo('x ')), 'x');
  history.record('x', 'xy', caret(1), caret(2));
  history.record('xy', 'x', caret(2), caret(1));
  assert.equal(history.redo('x'), null);
  assert.equal(apply('x', history.undo('x')), 'xy');
  assert.equal(apply('xy', history.undo('xy')), 'x');
  assert.equal(history.undo('x'), null);
  assert.equal(apply('x', history.redo('x')), 'xy');
});

test('repeated identical full documents are distinct chronological edit positions', () => {
  const history = createTextHistory();
  const values = ['a', 'ab', 'a', 'ac', 'a'];
  for (let index = 1; index < values.length; index++) history.record(values[index - 1], values[index], caret(1), caret(values[index].length));
  let source = values.at(-1);
  for (const expected of ['ac', 'a', 'ab', 'a']) {
    source = apply(source, history.undo(source));
    assert.equal(source, expected);
  }
  assert.equal(history.undo(source), null);
});

test('native coalesced Undo and Redo walk all constituent edits and restore the outer selections', () => {
  const history = createTextHistory();
  const initial = {start:0, end:0, direction:'backward'}, final = {start:1, end:3, direction:'forward'};
  history.record('', 'a', initial, caret(1));
  history.record('a', 'ab', caret(1), caret(2));
  history.record('ab', 'abc', caret(2), final);
  assert.deepEqual(history.reconcile('abc', '', 'historyUndo'), initial);
  assert.equal(history.undo(''), null);
  assert.deepEqual(history.reconcile('', 'abc', 'historyRedo'), final);
  assert.equal(history.redo('abc'), null);
  assert.equal(apply('abc', history.undo('abc')), 'ab');
});

test('native reconciliation can stop at an intermediate edit and branch from there', () => {
  const history = createTextHistory();
  history.record('', 'a', caret(0), caret(1));
  history.record('a', 'ab', caret(1), caret(2));
  history.record('ab', 'abc', caret(2), caret(3));
  assert.deepEqual(history.reconcile('abc', 'a', 'historyUndo'), caret(1));
  history.record('a', 'a!', caret(1), caret(2));
  assert.equal(history.redo('a!'), null);
  assert.equal(apply('a!', history.undo('a!')), 'a');
  assert.equal(apply('a', history.undo('a')), '');
});

test('native coalesced operations can cross edits whose net text is unchanged', () => {
  const history = createTextHistory();
  const initial = {start:0, end:1, direction:'backward'}, final = caret(1);
  history.record('x', 'xy', initial, caret(2));
  history.record('xy', 'x', caret(2), final);
  assert.deepEqual(history.reconcile('x', 'x', 'historyUndo'), initial);
  assert.equal(history.undo('x'), null);
  assert.deepEqual(history.reconcile('x', 'x', 'historyRedo'), final);
  assert.equal(history.redo('x'), null);
});

test('native reconciliation never searches in the opposite direction for matching text', () => {
  const history = createTextHistory();
  history.record('a', 'b', caret(1), caret(1));
  history.record('b', 'c', caret(1), caret(1));
  assert.equal(history.reconcile('c', 'b', 'historyRedo'), null);
  assert.equal(history.undo('b'), null);
  assert.equal(history.redo('b'), null);
});

test('an unrelated native result resets the journal instead of applying stale entries', () => {
  const history = createTextHistory();
  history.record('one', 'two', caret(3), caret(3));
  assert.equal(history.reconcile('two', 'external', 'historyUndo'), null);
  assert.equal(history.undo('external'), null);
  assert.equal(history.redo('external'), null);
  assert.equal(history.record('external', 'external!', caret(8), caret(9)), true);
  assert.equal(apply('external!', history.undo('external!')), 'external');
});

test('Undo and Redo reject a mismatched current source and forget the invalid chain', () => {
  for (const method of ['undo', 'redo']) {
    const history = createTextHistory();
    history.record('a', 'ab', caret(1), caret(2));
    if (method === 'redo') history.undo('ab');
    assert.equal(history[method]('another document'), null);
    assert.equal(history.undo('another document'), null);
    assert.equal(history.redo('another document'), null);
    assert.equal(history.undo('ab'), null);
  }
});

test('record rejects a mismatched before value instead of joining unrelated documents', () => {
  const history = createTextHistory();
  history.record('one', 'two', caret(3), caret(3));
  assert.equal(history.record('unknown', 'unknown!', caret(7), caret(8)), false);
  assert.equal(history.undo('unknown!'), null);
  assert.equal(history.redo('unknown!'), null);
  assert.equal(history.record('unknown!', 'unknown!!', caret(8), caret(9)), true);
  assert.equal(apply('unknown!!', history.undo('unknown!!')), 'unknown!');
});

test('a no-op or selection-only record leaves the Redo chain intact', () => {
  const history = createTextHistory();
  history.record('a', 'ab', caret(1), caret(2));
  assert.equal(apply('ab', history.undo('ab')), 'a');
  assert.equal(history.record('a', 'a', caret(0), caret(1)), false);
  assert.equal(apply('a', history.redo('a')), 'ab');
});

test('selection snapshots and returned reconciliation selections are independent of caller mutation', () => {
  const history = createTextHistory();
  const before = {start:0, end:1, direction:'backward'}, after = caret(2);
  history.record('a', 'ab', before, after);
  before.start = 1; after.start = 0;
  const restored = history.reconcile('ab', 'a', 'historyUndo');
  assert.deepEqual(restored, {start:0, end:1, direction:'backward'});
  restored.start = 1;
  assert.deepEqual(history.reconcile('a', 'ab', 'historyRedo'), caret(2));
  assert.deepEqual(history.reconcile('ab', 'a', 'historyUndo'), {start:0, end:1, direction:'backward'});
});

test('maxEntries drops the oldest edits while preserving a usable linear Undo and Redo chain', () => {
  const history = createTextHistory({maxEntries:2});
  history.record('', 'a', caret(0), caret(1));
  history.record('a', 'ab', caret(1), caret(2));
  history.record('ab', 'abc', caret(2), caret(3));
  assert.equal(apply('abc', history.undo('abc')), 'ab');
  assert.equal(apply('ab', history.undo('ab')), 'a');
  assert.equal(history.undo('a'), null);
  assert.equal(apply('a', history.redo('a')), 'ab');
  assert.equal(apply('ab', history.redo('ab')), 'abc');
});

test('maxText counts changed text only, not unchanged document prefixes or suffixes', () => {
  const history = createTextHistory({maxText:4});
  const prefix = 'p'.repeat(100000), suffix = 's'.repeat(100000);
  const a = prefix + 'a' + suffix, b = prefix + 'b' + suffix, c = prefix + 'c' + suffix;
  history.record(a, b, caret(prefix.length), caret(prefix.length + 1));
  history.record(b, c, caret(prefix.length), caret(prefix.length + 1));
  assert.equal(apply(c, history.undo(c)), b);
  assert.equal(apply(b, history.undo(b)), a);
  assert.equal(history.undo(a), null);
});

test('maxText removes old deltas without losing the latest edit', () => {
  const history = createTextHistory({maxText:4});
  history.record('a', 'b', caret(1), caret(1));
  history.record('b', 'c', caret(1), caret(1));
  history.record('c', 'd', caret(1), caret(1));
  assert.equal(apply('d', history.undo('d')), 'c');
  assert.equal(apply('c', history.undo('c')), 'b');
  assert.equal(history.undo('b'), null);
  const large = createTextHistory({maxEntries:0, maxText:1});
  large.record('old value', 'large replacement', caret(9), caret(17));
  assert.equal(apply('large replacement', large.undo('large replacement')), 'old value');
  assert.equal(apply('old value', large.redo('old value')), 'large replacement');
});

test('native history older than the retained budget is accepted as text and resets local history', () => {
  const history = createTextHistory({maxEntries:1});
  history.record('', 'a', caret(0), caret(1));
  history.record('a', 'ab', caret(1), caret(2));
  assert.equal(history.reconcile('ab', '', 'historyUndo'), null);
  assert.equal(history.redo(''), null);
  history.record('', 'z', caret(0), caret(1));
  assert.equal(apply('z', history.undo('z')), '');
});

test('UTF-16 offsets, CRLF and backward selections survive replacing a surrogate pair', () => {
  const history = createTextHistory();
  const before = 'head\r\n  😀日本語\r\n', after = 'head\r\n  😁日本語\r\n';
  const start = before.indexOf('😀'), original = {start, end:start + 2, direction:'backward'}, next = caret(start + 2);
  history.record(before, after, original, next);
  const undo = history.undo(after);
  assert.equal(apply(after, undo), before);
  assert.deepEqual([undo.selectionStart, undo.selectionEnd, undo.selectionDirection], [start, start + 2, 'backward']);
  const redo = history.redo(before);
  assert.equal(apply(before, redo), after);
  assert.equal(redo.selectionStart, start + 2);
});

test('reset clears Undo and Redo and starts a new independent document history', () => {
  const history = createTextHistory();
  history.record('a', 'b', caret(1), caret(1));
  history.undo('b');
  history.reset('fresh');
  assert.equal(history.undo('fresh'), null);
  assert.equal(history.redo('fresh'), null);
  history.record('fresh', 'fresh!', caret(5), caret(6));
  assert.equal(apply('fresh!', history.undo('fresh!')), 'fresh');
});

test('reconcile rejects unsupported operations and a stale before value', () => {
  for (const [before, inputType] of [['b', 'insertText'], ['stale', 'historyUndo']]) {
    const history = createTextHistory();
    history.record('a', 'b', caret(1), caret(1));
    assert.equal(history.reconcile(before, 'current', inputType), null);
    assert.equal(history.undo('current'), null);
  }
});

test('adjacent typed characters Undo and Redo as one changed range, including Unicode inside repeated text', () => {
  const history = createTextHistory();
  history.record('aaa', 'aaaa', caret(1), caret(2), input('insertText', 1));
  history.record('aaaa', 'aaaaa', caret(2), caret(3), input('insertText', 2));
  history.record('aaaaa', 'aaa😀aa', caret(3), caret(5), input('insertText', 3));
  const undo = history.undo('aaa😀aa');
  assert.equal(apply('aaa😀aa', undo), 'aaa');
  assert.deepEqual([undo.selectionStart, undo.selectionEnd], [1, 1]);
  assert.equal(history.undo('aaa'), null);
  const redo = history.redo('aaa');
  assert.equal(apply('aaa', redo), 'aaa😀aa');
  assert.deepEqual([redo.selectionStart, redo.selectionEnd], [5, 5]);
});

test('typing over a selected word starts a new group that restores the original backward selection', () => {
  const history = createTextHistory();
  const original = {start:6, end:11, direction:'backward'};
  history.record('const total = 1;', 'const a = 1;', original, caret(7), input('insertText', 1));
  let source = 'const a = 1;', position = 7;
  for (const [index, character] of [...'nswer'].entries()) {
    const next = source.slice(0, position) + character + source.slice(position);
    history.record(source, next, caret(position), caret(position + 1), input('insertText', index + 2));
    source = next; position++;
  }
  assert.equal(source, 'const answer = 1;');
  const undo = history.undo(source);
  assert.equal(apply(source, undo), 'const total = 1;');
  assert.deepEqual([undo.selectionStart, undo.selectionEnd, undo.selectionDirection], [6, 11, 'backward']);
  assert.equal(apply('const total = 1;', history.redo('const total = 1;')), source);
});

test('a replacement or multi-character insert starts its own group while paste stays isolated', () => {
  for (const [before, after, selected] of [['a', 'axy', caret(1)], ['a', 'xy', {start:0, end:1, direction:'forward'}]]) {
    const history = createTextHistory();
    history.record('', 'a', caret(0), caret(1), input('insertText', 1));
    history.record(before, after, selected, caret(after.length), input('insertText', 2));
    history.record(after, after + 'z', caret(after.length), caret(after.length + 1), input('insertText', 3));
    assert.equal(apply(after + 'z', history.undo(after + 'z')), 'a');
    assert.equal(apply('a', history.undo('a')), '');
  }
  const history = createTextHistory();
  history.record('', 'a', caret(0), caret(1), input('insertText', 1));
  history.record('a', 'apaste', caret(1), caret(6), input('insertFromPaste', 2));
  history.record('apaste', 'apaste!', caret(6), caret(7), input('insertText', 3));
  assert.equal(apply('apaste!', history.undo('apaste!')), 'apaste');
  assert.equal(apply('apaste', history.undo('apaste')), 'a');
  assert.equal(apply('a', history.undo('a')), '');
});

test('adjacent backward and forward deletions group separately and preserve the original caret', () => {
  for (const [kind, values, positions] of [
    ['deleteContentBackward', ['ab😀c', 'ab😀', 'ab', 'a'], [5, 4, 2, 1]],
    ['deleteContentForward', ['ab😀c', 'a😀c', 'ac', 'a'], [1, 1, 1, 1]]
  ]) {
    const history = createTextHistory();
    for (let index = 1; index < values.length; index++) history.record(values[index - 1], values[index], caret(positions[index - 1]), caret(positions[index]), input(kind, index));
    const undo = history.undo('a');
    assert.equal(apply('a', undo), 'ab😀c');
    assert.equal(undo.selectionStart, positions[0]);
    const redo = history.redo('ab😀c');
    assert.equal(apply('ab😀c', redo), 'a');
    assert.equal(redo.selectionStart, positions.at(-1));
  }
  const history = createTextHistory();
  history.record('abcd', 'acd', caret(2), caret(1), input('deleteContentBackward', 1));
  history.record('acd', 'ad', caret(1), caret(1), input('deleteContentForward', 2));
  assert.equal(apply('ad', history.undo('ad')), 'acd');
  assert.equal(apply('acd', history.undo('acd')), 'abcd');
});

test('typing groups require increasing timestamps at most one second apart', () => {
  for (const [times, expected] of [
    [[0, 1000, 2000], ''], [[0, 1001, 1002], 'a'], [[100, 100, 101], 'a'], [[100, 99, 100], 'a']
  ]) {
    const history = createTextHistory();
    const values = ['', 'a', 'ab', 'abc'];
    for (let index = 1; index < values.length; index++) history.record(values[index - 1], values[index], caret(index - 1), caret(index), input('insertText', times[index - 1]));
    assert.equal(apply('abc', history.undo('abc')), expected);
  }
});

test('caret movement, selection direction and a non-collapsed after-selection stop grouping', () => {
  const moved = createTextHistory();
  moved.record('abcd', 'abXcd', caret(2), caret(3), input('insertText', 1));
  moved.record('abXcd', 'YabXcd', caret(0), caret(1), input('insertText', 2));
  assert.equal(apply('YabXcd', moved.undo('YabXcd')), 'abXcd');
  assert.equal(apply('abXcd', moved.undo('abXcd')), 'abcd');
  for (const [firstAfter, secondBefore] of [
    [caret(1), {start:1, end:1, direction:'forward'}],
    [{start:0, end:1, direction:'forward'}, caret(1)]
  ]) {
    const history = createTextHistory();
    history.record('', 'a', caret(0), firstAfter, input('insertText', 1));
    history.record('a', 'ab', secondBefore, caret(2), input('insertText', 2));
    assert.equal(apply('ab', history.undo('ab')), 'a');
  }
});

test('a nonadjacent text change and an explicit group break remain independent transactions', () => {
  const history = createTextHistory();
  history.record('a', 'ab', caret(1), caret(2), input('insertText', 1));
  history.record('ab', 'ac', caret(2), caret(2), input('insertText', 2));
  history.record('ac', 'acd', caret(2), caret(3), input('insertText', 3));
  history.breakGroup();
  history.record('acd', 'acde', caret(3), caret(4), input('insertText', 4));
  for (const [before, after] of [['acde', 'acd'], ['acd', 'ac'], ['ac', 'ab'], ['ab', 'a']]) assert.equal(apply(before, history.undo(before)), after);
});

test('native partial Undo and Redo retain individual records inside a typing group', () => {
  const history = createTextHistory();
  history.record('', 'a', caret(0), caret(1), input('insertText', 1));
  history.record('a', 'ab', caret(1), caret(2), input('insertText', 2));
  history.record('ab', 'abc', caret(2), caret(3), input('insertText', 3));
  assert.deepEqual(history.reconcile('abc', 'ab', 'historyUndo'), caret(2));
  assert.equal(apply('ab', history.undo('ab')), '');
  assert.deepEqual(history.reconcile('', 'a', 'historyRedo'), caret(1));
  assert.equal(apply('a', history.redo('a')), 'abc');
  assert.deepEqual(history.reconcile('abc', 'a', 'historyUndo'), caret(1));
  history.record('a', 'a!', caret(1), caret(2), input('insertText', 4));
  assert.equal(history.redo('a!'), null);
  assert.equal(apply('a!', history.undo('a!')), 'a');
  assert.equal(apply('a', history.undo('a')), '');
  assert.equal(apply('', history.redo('')), 'a');
  assert.equal(apply('a', history.redo('a')), 'a!');
});

test('Undo, Redo and even unavailable history navigation stop later typing joining an old group', () => {
  for (const navigate of [
    history => {history.undo('ab'); history.redo('');},
    history => {assert.equal(history.redo('ab'), null);},
    history => {history.reconcile('ab', '', 'historyUndo'); history.reconcile('', 'ab', 'historyRedo');}
  ]) {
    const history = createTextHistory();
    history.record('', 'a', caret(0), caret(1), input('insertText', 1));
    history.record('a', 'ab', caret(1), caret(2), input('insertText', 2));
    navigate(history);
    history.record('ab', 'abc', caret(2), caret(3), input('insertText', 3));
    assert.equal(apply('abc', history.undo('abc')), 'ab');
    assert.equal(apply('ab', history.undo('ab')), '');
  }
});

test('trimming a typing group respects the retained per-record budget without breaking replay', () => {
  const history = createTextHistory({maxEntries:2});
  history.record('', 'a', caret(0), caret(1), input('insertText', 1));
  history.record('a', 'ab', caret(1), caret(2), input('insertText', 2));
  history.record('ab', 'abc', caret(2), caret(3), input('insertText', 3));
  assert.equal(apply('abc', history.undo('abc')), 'a');
  assert.equal(history.undo('a'), null);
  assert.equal(apply('a', history.redo('a')), 'abc');
});
