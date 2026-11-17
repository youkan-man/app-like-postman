import test from 'node:test';
import assert from 'node:assert/strict';
import {indentEdit, newlineEdit} from '../static/editor-editing.mjs';

function apply(source, edit) {
  return edit ? source.slice(0, edit.from) + edit.text + source.slice(edit.to) : source;
}

test('Tab indents a selected block without replacing its source and preserves the selection', () => {
  const source = 'const first = 1;\nconst second = 2;';
  const edit = indentEdit(source, 0, source.length);
  const next = apply(source, edit);
  assert.equal(next, '  const first = 1;\n  const second = 2;');
  assert.deepEqual([edit.selectionStart, edit.selectionEnd], [0, next.length]);
  const reverse = indentEdit(next, edit.selectionStart, edit.selectionEnd, {direction:'backward'});
  assert.equal(apply(next, reverse), source);
  assert.deepEqual([reverse.selectionStart, reverse.selectionEnd], [0, source.length]);
});

test('a block selection ending at the next line start leaves that line unchanged', () => {
  const source = 'first\nsecond\nthird';
  const edit = indentEdit(source, 2, source.indexOf('third'));
  assert.equal(apply(source, edit), '  first\n  second\nthird');
  assert.deepEqual([edit.selectionStart, edit.selectionEnd], [4, source.indexOf('third') + 4]);
});

test('a single-line selection also preserves selected text while indenting its line', () => {
  const source = 'const important = 1;';
  const edit = indentEdit(source, 6, 15);
  assert.equal(apply(source, edit), '  ' + source);
  assert.equal(apply(source, edit).slice(edit.selectionStart, edit.selectionEnd), 'important');
});

test('a caret inserts whitespace to the next tab stop, including after an existing tab', () => {
  assert.equal(apply('abc', indentEdit('abc', 3, 3)), 'abc ');
  assert.equal(apply('ab', indentEdit('ab', 2, 2)), 'ab  ');
  assert.equal(apply('\ta', indentEdit('\ta', 2, 2, {tabSize:4})), '\ta   ');
  assert.equal(apply('abc', indentEdit('abc', 3, 3, {indent:'\t', tabSize:4})), 'abc\t');
});

test('outdent removes an indentation unit rather than non-whitespace code', () => {
  const source = '    alpha\n\tbeta\n gamma\nzero';
  const edit = indentEdit(source, 0, source.length, {direction:'backward'});
  assert.equal(apply(source, edit), '  alpha\nbeta\ngamma\nzero');
  assert.equal(indentEdit('alpha', 2, 2, {direction:'backward'}), null);
});

test('outdent handles mixed tabs and spaces in visual columns', () => {
  const source = ' \titem';
  const edit = indentEdit(source, source.length, source.length, {direction:'backward', tabSize:4});
  assert.equal(apply(source, edit), '  item');
  assert.equal(edit.selectionStart, '  item'.length);
  const original = '\talpha\n \tbeta';
  const forward = indentEdit(original, 0, original.length);
  const indented = apply(original, forward);
  assert.equal(apply(indented, indentEdit(indented, forward.selectionStart, forward.selectionEnd, {direction:'backward'})), original);
});

test('block indentation retains CRLF line endings and UTF-16 selection offsets', () => {
  const source = 'const 😀 = "値";\r\n日本語();\r\nlast();';
  const start = source.indexOf('😀'), end = source.indexOf('last');
  const edit = indentEdit(source, start, end);
  const next = apply(source, edit);
  assert.equal(next, '  const 😀 = "値";\r\n  日本語();\r\nlast();');
  assert.equal(edit.selectionStart, start + 2);
  assert.equal(edit.selectionEnd, end + 4);
  assert.ok(next.slice(edit.selectionStart, edit.selectionEnd).startsWith('😀'));
});

test('indentation of blank lines and a final selected line is deterministic', () => {
  const source = 'a\n\nb\n';
  assert.equal(apply(source, indentEdit(source, 0, source.length)), '  a\n  \n  b\n');
  assert.equal(apply('', indentEdit('', 0, 0)), '  ');
  const leadingBlank = '\nfirst\n';
  assert.equal(apply(leadingBlank, indentEdit(leadingBlank, 0, leadingBlank.length)), '  \n  first\n');
  assert.equal(apply(leadingBlank, indentEdit(leadingBlank, 0, 1)), '  \nfirst\n');
});

test('Enter carries leading whitespace into the new line', () => {
  const source = '\t  const label = "日本語";';
  const edit = newlineEdit(source, source.length, source.length, {language:'javascript'});
  assert.equal(apply(source, edit), source + '\n\t  ');
  assert.equal(edit.selectionStart, source.length + 4);
});

for (const [language, source] of [['javascript', 'if (ready) {}'], ['json', '{"items": []}'], ['graphql', 'query {}']]) {
  test(`Enter splits paired delimiters and places the caret inside (${language})`, () => {
    const position = source.indexOf(language === 'json' ? ']' : '}');
    const edit = newlineEdit(source, position, position, {language});
    assert.equal(apply(source, edit), source.slice(0, position) + '\n  \n' + source.slice(position));
    assert.equal(edit.selectionStart, position + 3);
  });
}

test('paired delimiter indentation keeps outer indentation and removes only intervening horizontal whitespace', () => {
  const source = '  const data = {   };';
  const position = source.indexOf('{') + 1;
  const edit = newlineEdit(source, position, position, {language:'javascript'});
  assert.equal(apply(source, edit), '  const data = {\n    \n  };');
  assert.equal(edit.selectionStart, position + 5);
});

test('Enter replaces a selected range without duplicating the selected source', () => {
  const source = '  alpha + beta';
  const edit = newlineEdit(source, source.indexOf('+'), source.indexOf('beta') + 4, {language:'javascript'});
  assert.equal(apply(source, edit), '  alpha \n  ');
});

test('Enter uses CRLF for a CRLF document and preserves surrogate pairs', () => {
  const source = 'const label = "😀";\r\n  if (ready) {}';
  const position = source.lastIndexOf('}');
  const edit = newlineEdit(source, position, position, {language:'javascript'});
  assert.equal(apply(source, edit), 'const label = "😀";\r\n  if (ready) {\r\n    \r\n  }');
  assert.equal(edit.selectionStart, position + 6);
});

for (const source of ['  // {', '  /* {', '  const text = "{', "  const text = '{", '  const text = `raw {', '  const expression = /[({', '  return /[({']) {
  test('literal or comment delimiters do not add indentation: ' + source, () => {
    const edit = newlineEdit(source, source.length, source.length, {language:'javascript'});
    assert.equal(apply(source, edit), source + '\n  ');
  });
}

test('an opening brace before a trailing comment still starts an indented code block', () => {
  const source = '  if (ready) { // a description with }';
  assert.equal(apply(source, newlineEdit(source, source.length, source.length, {language:'javascript'})), source + '\n    ');
});

test('braces inside GraphQL comments or block strings do not indent code', () => {
  for (const source of ['  # {', '  """description {']) {
    assert.equal(apply(source, newlineEdit(source, source.length, source.length, {language:'graphql'})), source + '\n  ');
  }
});

test('template interpolation is code while nested template text remains literal', () => {
  const source = 'const label = `Hello ${}';
  const position = source.length - 1;
  assert.equal(apply(source, newlineEdit(source, position, position, {language:'javascript'})), 'const label = `Hello ${\n  \n}');
  const nested = '  const label = `${`raw {';
  assert.equal(apply(nested, newlineEdit(nested, nested.length, nested.length, {language:'javascript'})), nested + '\n  ');
  const beforeInterpolation = 'const label = `Hello ${name}`;';
  const beforeBrace = beforeInterpolation.indexOf('{');
  assert.equal(apply(beforeInterpolation, newlineEdit(beforeInterpolation, beforeBrace, beforeBrace, {language:'javascript'})), 'const label = `Hello $\n{name}`;');
});

test('text mode only carries indentation and never interprets braces', () => {
  const source = '  {}';
  assert.equal(apply(source, newlineEdit(source, 3, 3)), '  {\n  }');
});
