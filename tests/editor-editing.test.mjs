import test from 'node:test';
import assert from 'node:assert/strict';
import {indentEdit, newlineEdit, smartBackspaceEdit, smartHomeSelection, toggleLineCommentEdit, moveLinesEdit} from '../static/editor-editing.mjs';

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

test('Backspace in indentation removes to the preceding tab stop', () => {
  for (const [source, position, expected, caret] of [
    ['    work();', 4, '  work();', 2],
    ['     work();', 5, '    work();', 4],
    ['    work();', 3, '   work();', 2],
    ['  ', 2, '', 0],
  ]) {
    const edit = smartBackspaceEdit(source, position, position);
    assert.equal(apply(source, edit), expected);
    assert.deepEqual([edit.selectionStart, edit.selectionEnd], [caret, caret]);
  }
});

test('smart Backspace respects tab widths and preserves whitespace after the caret', () => {
  const source = 'head\r\n \t  日本語();';
  const position = source.indexOf('日本語');
  const edit = smartBackspaceEdit(source, position, position, {tabSize:4});
  assert.equal(apply(source, edit), 'head\r\n \t日本語();');
  const again = smartBackspaceEdit(apply(source, edit), edit.selectionStart, edit.selectionEnd, {tabSize:4});
  assert.equal(apply(apply(source, edit), again), 'head\r\n日本語();');
});

test('smart Backspace leaves code, selected text and line joins to native editing', () => {
  for (const [source, start, end] of [['  value', 4, 4], ['  value', 0, 2], ['x\n', 2, 2], ['', 0, 0]]) {
    assert.equal(smartBackspaceEdit(source, start, end), null);
  }
});

test('Home alternates between first nonblank character and column zero', () => {
  const source = 'previous\n    alpha();', first = source.indexOf('alpha'), zero = source.indexOf('\n') + 1;
  let saved = smartHomeSelection(source, source.length, source.length);
  assert.deepEqual(saved, {selectionStart:first, selectionEnd:first, selectionDirection:'none'});
  saved = smartHomeSelection(source, saved.selectionStart, saved.selectionEnd);
  assert.deepEqual(saved, {selectionStart:zero, selectionEnd:zero, selectionDirection:'none'});
  saved = smartHomeSelection(source, saved.selectionStart, saved.selectionEnd);
  assert.equal(saved.selectionStart, first);
});

test('Shift+Home preserves its anchor and changes only the selection focus', () => {
  const source = '    alpha();', anchor = source.length;
  const first = smartHomeSelection(source, anchor, anchor, {extend:true});
  assert.deepEqual(first, {selectionStart:4, selectionEnd:anchor, selectionDirection:'backward'});
  const second = smartHomeSelection(source, first.selectionStart, first.selectionEnd, {extend:true, direction:first.selectionDirection});
  assert.deepEqual(second, {selectionStart:0, selectionEnd:anchor, selectionDirection:'backward'});
  const third = smartHomeSelection(source, second.selectionStart, second.selectionEnd, {extend:true, direction:second.selectionDirection});
  assert.deepEqual(third, first);
  assert.deepEqual(smartHomeSelection(source, 0, 0, {extend:true}), {selectionStart:0, selectionEnd:4, selectionDirection:'forward'});
  assert.deepEqual(smartHomeSelection(source, 0, 4, {extend:true, direction:'forward'}), {selectionStart:0, selectionEnd:0, selectionDirection:'none'});
});

test('Home uses the active end of backward and forward multiline selections', () => {
  const source = '  first\n    second';
  const start = source.indexOf('first') + 2, end = source.length;
  assert.equal(smartHomeSelection(source, start, end, {direction:'backward'}).selectionStart, 2);
  assert.equal(smartHomeSelection(source, start, end, {direction:'forward'}).selectionStart, source.indexOf('second'));
});

test('Home handles blank lines, tabs, CRLF and UTF-16 positions', () => {
  const source = '😀\r\n\t  日本語\r\n   ';
  assert.equal(smartHomeSelection(source, source.indexOf('語') + 1, source.indexOf('語') + 1).selectionStart, source.indexOf('日本語'));
  assert.equal(smartHomeSelection(source, source.length, source.length).selectionStart, source.lastIndexOf('\n') + 1);
  assert.deepEqual(smartHomeSelection('', 0, 0), {selectionStart:0, selectionEnd:0, selectionDirection:'none'});
});

test('JavaScript comments align at the shared indentation and toggle losslessly', () => {
  const source = '  first();\n    second();\n\n  third();';
  const edit = toggleLineCommentEdit(source, 0, source.length, {language:'javascript'});
  const next = apply(source, edit);
  assert.equal(next, '  // first();\n  //   second();\n\n  // third();');
  const reverse = toggleLineCommentEdit(next, edit.selectionStart, edit.selectionEnd, {language:'javascript'});
  assert.equal(apply(next, reverse), source);
  assert.deepEqual([reverse.selectionStart, reverse.selectionEnd], [0, source.length]);
});

test('comment toggling removes one level only when every nonblank line is commented', () => {
  const source = '// already\ncode();';
  const edit = toggleLineCommentEdit(source, 0, source.length, {language:'javascript'});
  const next = apply(source, edit);
  assert.equal(next, '// // already\n// code();');
  assert.equal(apply(next, toggleLineCommentEdit(next, edit.selectionStart, edit.selectionEnd, {language:'javascript'})), source);
  const commented = '  //text\n    // value\n  ';
  assert.equal(apply(commented, toggleLineCommentEdit(commented, 0, commented.length, {language:'javascript'})), '  text\n    value\n  ');
});

test('GraphQL uses hash comments while JSON and text do not gain invalid comments', () => {
  const source = '  id\n    name # existing';
  const edit = toggleLineCommentEdit(source, 0, source.length, {language:'graphql'});
  const next = apply(source, edit);
  assert.equal(next, '  # id\n  #   name # existing');
  assert.equal(apply(next, toggleLineCommentEdit(next, edit.selectionStart, edit.selectionEnd, {language:'graphql'})), source);
  for (const language of ['text', 'json', 'xml', 'html']) assert.equal(toggleLineCommentEdit(source, 0, source.length, {language}), null);
});

test('comment selection ending at the next column zero does not touch the following line', () => {
  const source = 'first();\r\nsecond();\r\nlast();', end = source.indexOf('last');
  const edit = toggleLineCommentEdit(source, 0, end, {language:'javascript'});
  const next = apply(source, edit);
  assert.equal(next, '// first();\r\n// second();\r\nlast();');
  assert.equal(edit.selectionEnd, next.indexOf('last'));
});

test('comment toggling preserves a partial token selection and Unicode positions', () => {
  const source = '  const label = "😀日本語";', start = source.indexOf('😀'), end = source.indexOf('語') + 1;
  const edit = toggleLineCommentEdit(source, start, end, {language:'javascript'});
  const next = apply(source, edit);
  assert.equal(next.slice(edit.selectionStart, edit.selectionEnd), '😀日本語');
  assert.equal(apply(next, toggleLineCommentEdit(next, edit.selectionStart, edit.selectionEnd, {language:'javascript'})), source);
});

test('comment toggling preserves tabs even when indentation columns do not align', () => {
  for (const source of ['\tfirst\n \tsecond', ' first\n\tsecond', '\t first\r\n  second\r\n']) {
    const edit = toggleLineCommentEdit(source, 0, source.length, {language:'javascript'});
    const next = apply(source, edit);
    assert.equal(apply(next, toggleLineCommentEdit(next, edit.selectionStart, edit.selectionEnd, {language:'javascript'})), source);
  }
});

test('comment toggling works on an empty line and whitespace-only blocks', () => {
  const empty = toggleLineCommentEdit('', 0, 0, {language:'javascript'});
  assert.equal(apply('', empty), '// ');
  assert.deepEqual([empty.selectionStart, empty.selectionEnd], [3, 3]);
  assert.equal(apply('// ', toggleLineCommentEdit('// ', 3, 3, {language:'javascript'})), '');
  const source = '  \n ';
  const edit = toggleLineCommentEdit(source, 0, source.length, {language:'javascript'});
  const next = apply(source, edit);
  assert.equal(apply(next, toggleLineCommentEdit(next, edit.selectionStart, edit.selectionEnd, {language:'javascript'})), source);
});

test('comment alignment handles long indentation without a per-column argument list', () => {
  const prefix = ' '.repeat(140000), source = prefix + 'first();\n' + prefix + '  second();';
  const edit = toggleLineCommentEdit(source, 0, source.length, {language:'javascript'});
  const next = apply(source, edit);
  assert.equal(next, prefix + '// first();\n' + prefix + '//   second();');
  assert.equal(apply(next, toggleLineCommentEdit(next, edit.selectionStart, edit.selectionEnd, {language:'javascript'})), source);
});

test('moving a line keeps the caret at the same position inside its code', () => {
  const source = 'first\n  beta();\nlast', caret = source.indexOf('beta') + 3;
  const up = moveLinesEdit(source, caret, caret, {direction:'up'});
  assert.equal(apply(source, up), '  beta();\nfirst\nlast');
  assert.deepEqual([up.selectionStart, up.selectionEnd], [5, 5]);
  const down = moveLinesEdit(source, caret, caret, {direction:'down'});
  const next = apply(source, down);
  assert.equal(next, 'first\nlast\n  beta();');
  assert.equal(down.selectionStart, next.indexOf('beta') + 3);
});

test('moving selected lines excludes the following column-zero line and retains the block selection', () => {
  const source = 'A\nB\nC\nD', start = source.indexOf('B'), end = source.indexOf('D');
  const up = moveLinesEdit(source, start, end, {direction:'up'});
  assert.equal(apply(source, up), 'B\nC\nA\nD');
  assert.deepEqual([up.selectionStart, up.selectionEnd], [0, 4]);
  const down = moveLinesEdit(source, start, end, {direction:'down'});
  assert.equal(apply(source, down), 'A\nD\nB\nC');
  assert.deepEqual([down.selectionStart, down.selectionEnd], [4, 7]);
});

test('line movement at either document boundary is a no-op', () => {
  const source = 'first\nlast';
  assert.equal(moveLinesEdit(source, 1, 1, {direction:'up'}), null);
  assert.equal(moveLinesEdit(source, source.length, source.length, {direction:'down'}), null);
  for (const direction of ['up', 'down']) {
    assert.equal(moveLinesEdit(source, 0, source.length, {direction}), null);
    assert.equal(moveLinesEdit('', 0, 0, {direction}), null);
    assert.equal(moveLinesEdit('x\n', 2, 2, {direction}), null);
  }
});

test('line movement preserves the original terminal newline and line-ending bytes', () => {
  for (const source of ['one\ntwo', 'one\ntwo\n', 'one\r\ntwo', 'one\r\ntwo\r\n']) {
    const edit = moveLinesEdit(source, 1, 1, {direction:'down'});
    const next = apply(source, edit);
    assert.equal(next, source.replace('one', 'TEMP').replace('two', 'one').replace('TEMP', 'two'));
    const reverse = moveLinesEdit(next, edit.selectionStart, edit.selectionEnd, {direction:'up'});
    assert.equal(apply(next, reverse), source);
  }
  assert.equal(apply('a\r\nb\nc', moveLinesEdit('a\r\nb\nc', 3, 3, {direction:'up'})), 'b\r\na\nc');
});

test('line movement keeps an explicitly present blank line and UTF-16 token selection', () => {
  assert.equal(apply('A\n\n', moveLinesEdit('A\n\n', 2, 2, {direction:'up'})), '\nA\n');
  const source = 'head\r\n  😀日本語();\r\nlast', start = source.indexOf('😀'), end = source.indexOf('語') + 1;
  const edit = moveLinesEdit(source, start, end, {direction:'down'});
  const next = apply(source, edit);
  assert.equal(next, 'head\r\nlast\r\n  😀日本語();');
  assert.equal(next.slice(edit.selectionStart, edit.selectionEnd), '😀日本語');
});

test('duplicating a line above or below selects the new copy at the original column', () => {
  const source = 'one\ntwo', caret = source.indexOf('two') + 1;
  const up = moveLinesEdit(source, caret, caret, {direction:'up', duplicate:true});
  const down = moveLinesEdit(source, caret, caret, {direction:'down', duplicate:true});
  assert.equal(apply(source, up), 'one\ntwo\ntwo');
  assert.equal(apply(source, down), 'one\ntwo\ntwo');
  assert.equal(up.selectionStart, 5);
  assert.equal(down.selectionStart, 9);
});

test('duplicating a multiline selection retains its ending at column zero', () => {
  const source = 'one\ntwo\nlast\n', end = source.indexOf('last');
  const edit = moveLinesEdit(source, 0, end, {direction:'down', duplicate:true});
  assert.equal(apply(source, edit), 'one\ntwo\none\ntwo\nlast\n');
  assert.deepEqual([edit.selectionStart, edit.selectionEnd], [8, 16]);
  const above = moveLinesEdit(source, 0, end, {direction:'up', duplicate:true});
  assert.equal(apply(source, above), 'one\ntwo\none\ntwo\nlast\n');
  assert.deepEqual([above.selectionStart, above.selectionEnd], [0, 8]);
});

test('line duplication preserves final newline presence, CRLF and Unicode selections', () => {
  for (const ending of ['', '\r\n']) {
    const source = 'head\r\n  😀日本語();' + ending, start = source.indexOf('😀'), end = source.indexOf('語') + 1;
    const edit = moveLinesEdit(source, start, end, {direction:'down', duplicate:true});
    const next = apply(source, edit);
    assert.equal(next, 'head\r\n  😀日本語();\r\n  😀日本語();' + ending);
    assert.equal(next.slice(edit.selectionStart, edit.selectionEnd), '😀日本語');
  }
});

test('duplicating empty and terminal blank lines creates exactly one blank line', () => {
  for (const direction of ['up', 'down']) {
    const empty = moveLinesEdit('', 0, 0, {direction, duplicate:true});
    assert.equal(apply('', empty), '\n');
    assert.equal(empty.selectionStart, direction === 'up' ? 0 : 1);
    const last = moveLinesEdit('one\r\n', 5, 5, {direction, duplicate:true});
    assert.equal(apply('one\r\n', last), 'one\r\n\r\n');
    assert.equal(last.selectionStart, direction === 'up' ? 5 : 7);
  }
});
