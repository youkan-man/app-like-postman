import test from 'node:test';
import assert from 'node:assert/strict';
import {findMatches, replaceEdit} from '../static/editor-search.mjs';

const apply = (source, edit) => edit ? source.slice(0, edit.from) + edit.text + source.slice(edit.to) : source;

test('literal search escapes every regexp metacharacter and keeps source offsets', () => {
  const literal = '.*+?^${}()|[]\\';
  const source = 'prefix ' + literal + ' middle ' + literal;
  assert.deepEqual(findMatches(source, literal), [{from:7, to:7 + literal.length}, {from:15 + literal.length, to:15 + literal.length * 2}]);
});

test('empty searches have no matches or edits', () => {
  assert.deepEqual(findMatches('source', ''), []);
  assert.deepEqual(findMatches('', 'source'), []);
  assert.equal(replaceEdit('source', '', 'text', {all:true}), null);
});

test('search finds non-overlapping matches without losing an adjacent occurrence', () => {
  assert.deepEqual(findMatches('aaaaa', 'aa'), [{from:0, to:2}, {from:2, to:4}]);
  assert.deepEqual(findMatches('abcabc', 'abc'), [{from:0, to:3}, {from:3, to:6}]);
});

test('case sensitivity is explicit and searching never changes source text', () => {
  const source = 'Token token TOKEN';
  assert.deepEqual(findMatches(source, 'token'), [{from:0, to:5}, {from:6, to:11}, {from:12, to:17}]);
  assert.deepEqual(findMatches(source, 'token', {caseSensitive:true}), [{from:6, to:11}]);
  assert.equal(source, 'Token token TOKEN');
});

test('Unicode case matching uses original UTF-16 offsets instead of a length-changing lowercase copy', () => {
  assert.deepEqual(findMatches('İ K K k 😀Σςσ', 'k'), [{from:2,to:3},{from:4,to:5},{from:6,to:7}]);
  assert.deepEqual(findMatches('İ K K k 😀Σςσ', 'σ'), [{from:10,to:11},{from:11,to:12},{from:12,to:13}]);
});

test('Japanese, emoji and multiline literals preserve DOM selection offsets', () => {
  const source = '😀日本語\r\n😀日本語';
  assert.deepEqual(findMatches(source, '日本語'), [{from:2, to:5}, {from:9, to:12}]);
  assert.deepEqual(findMatches(source, '😀'), [{from:0, to:2}, {from:7, to:9}]);
  assert.deepEqual(findMatches(source, '語\r\n😀'), [{from:4, to:9}]);
});

test('a range only returns complete matches inside its boundaries', () => {
  const source = 'abc abc abc';
  assert.deepEqual(findMatches(source, 'abc', {from:2, to:10}), [{from:4, to:7}]);
  assert.deepEqual(findMatches(source, 'abc', {from:9, to:2}), []);
  assert.deepEqual(findMatches(source, 'abc', {from:-10, to:100}), [{from:0,to:3},{from:4,to:7},{from:8,to:11}]);
  assert.deepEqual(findMatches('😀 x 😀', '😀', {from:1}), [{from:5,to:7}]);
  assert.deepEqual(findMatches('😀 x 😀', '😀', {to:1}), []);
});

test('a single replacement only changes the complete selected match', () => {
  const source = 'name + name';
  const edit = replaceEdit(source, 'name', 'title', {selectionStart:7, selectionEnd:11});
  assert.equal(apply(source, edit), 'name + title');
  assert.deepEqual(edit, {from:7,to:11,text:'title',selectionStart:7,selectionEnd:12,selectionDirection:'forward'});
  assert.equal(replaceEdit(source, 'name', 'title', {selectionStart:8, selectionEnd:11}), null);
  assert.equal(replaceEdit(source, 'name', 'title', {selectionStart:0, selectionEnd:0}), null);
});

test('replacement rechecks the current source rather than trusting stale offsets', () => {
  assert.equal(replaceEdit('next + name', 'name', 'title', {selectionStart:0, selectionEnd:4}), null);
  assert.equal(apply('NAME + name', replaceEdit('NAME + name', 'name', 'title', {selectionStart:0,selectionEnd:4})), 'title + name');
  assert.equal(replaceEdit('NAME + name', 'name', 'title', {caseSensitive:true,selectionStart:0,selectionEnd:4}), null);
});

test('replace all is one plan spanning all original matches and preserving everything between them', () => {
  const source = 'before: name\r\n  name / Name; after';
  const edit = replaceEdit(source, 'name', 'label', {all:true});
  assert.equal(apply(source, edit), 'before: label\r\n  label / label; after');
  assert.equal(edit.from, 8);
  assert.equal(edit.to, source.indexOf(';'));
  assert.deepEqual([edit.selectionStart,edit.selectionEnd], [8,13]);
  assert.equal(apply(source, replaceEdit(source, 'name', 'label', {all:true,caseSensitive:true})), 'before: label\r\n  label / Name; after');
});

test('dollar signs and replacement patterns are inserted literally', () => {
  const replacement = '$& $1 $$ $` $\'';
  assert.equal(apply('x x', replaceEdit('x x', 'x', replacement, {all:true})), replacement + ' ' + replacement);
});

test('replace all never searches its own inserted replacement', () => {
  assert.equal(apply('aaa', replaceEdit('aaa', 'a', 'aa', {all:true})), 'aaaaaa');
  assert.equal(apply('aaaaa', replaceEdit('aaaaa', 'aa', 'x', {all:true})), 'xxa');
});

test('empty replacement removes only original matches and returns a valid caret', () => {
  const edit = replaceEdit('a + a', 'a', '', {all:true});
  assert.equal(apply('a + a', edit), ' + ');
  assert.deepEqual([edit.selectionStart,edit.selectionEnd], [0,0]);
});

test('same-text and missing matches produce no undo entry', () => {
  assert.equal(replaceEdit('item', 'item', 'item', {all:true}), null);
  assert.equal(replaceEdit('item', 'missing', 'value', {all:true}), null);
});

test('Unicode replacement selects the complete inserted string using UTF-16 offsets', () => {
  const source = '前 値 後 値';
  const edit = replaceEdit(source, '値', '😀名前', {all:true});
  assert.equal(apply(source, edit), '前 😀名前 後 😀名前');
  assert.equal(apply(source, edit).slice(edit.selectionStart,edit.selectionEnd), '😀名前');
});
