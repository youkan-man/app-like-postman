import test from 'node:test';
import assert from 'node:assert/strict';
import {highlight} from '../static/code-highlighter.mjs';

const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'"}[name]));
function render(source, language = 'javascript') {
  const html = highlight(source, language);
  assert.equal(decode(html.replace(/<\/?span(?: class="syntax-[a-z]+")?>/g, '')), String(source), 'highlighting must preserve every source character');
  return {html, tokens: [...html.matchAll(/<span class="syntax-([a-z]+)">([\s\S]*?)<\/span>/g)]
    .map(([,kind,value]) => ({kind, value: decode(value)}))};
}
const values = (result, kind) => result.tokens.filter(token => token.kind === kind).map(token => token.value);

test('JavaScript private fields do not turn the remainder of a class into a comment', () => {
  const source = 'class Count { #value = 1; next() { return ++this.#value; } } const next = true;';
  const result = render(source);
  assert.deepEqual(values(result, 'comment'), []);
  assert.deepEqual(values(result, 'key'), ['#value', '#value']);
  assert.ok(values(result, 'keyword').includes('return'));
  assert.ok(values(result, 'keyword').includes('true'));
  assert.ok(values(result, 'number').includes('1'));
});

test('only a leading JavaScript hashbang is a hash comment', () => {
  const result = render('#!/usr/bin/env node\nclass A { #field = 2; }\n#notAComment');
  assert.deepEqual(values(result, 'comment'), ['#!/usr/bin/env node']);
  assert.deepEqual(values(result, 'key'), ['#field', '#notAComment']);
});

test('regexp slash and comment characters inside character classes remain literal', () => {
  const result = render('const pattern = /[//]/; const next = true; const other = /[/*#]/gu;');
  assert.deepEqual(values(result, 'string'), ['/[//]/', '/[/*#]/gu']);
  assert.deepEqual(values(result, 'comment'), []);
  assert.deepEqual(values(result, 'keyword'), ['const', 'const', 'true', 'const']);
});

test('regexp escapes and escaped class endings do not terminate the token early', () => {
  const source = String.raw`const path = /foo\/bar[\]\/]/giu; const after = 3;`;
  const result = render(source);
  assert.deepEqual(values(result, 'string'), [String.raw`/foo\/bar[\]\/]/giu`]);
  assert.deepEqual(values(result, 'number'), ['3']);
});

test('division after values and calls stays distinct from a following regexp', () => {
  const result = render('const ratio = total / 2 / count(); const other = fn() / 3; const re = /x/;');
  assert.deepEqual(values(result, 'string'), ['/x/']);
  assert.deepEqual(values(result, 'number'), ['2', '3']);
});

test('regexp expressions are recognized after control parentheses, return and arrows', () => {
  const result = render('if (ready) /[//]/.test(value); function read() { return /a+/u; } const next = () => /b/;');
  assert.deepEqual(values(result, 'string'), ['/[//]/', '/a+/u', '/b/']);
  assert.deepEqual(values(result, 'comment'), []);
});

test('a function, class or arrow expression remains a value after its body closes', () => {
  const result = render('const a = function() {} / 2; const b = class {} / 3; const c = () => {} / 4; function ready() {} /ok/.test(value);');
  assert.deepEqual(values(result, 'string'), ['/ok/']);
  assert.deepEqual(values(result, 'number'), ['2', '3', '4']);
});

test('strings and comments protect their contents and recover at their own delimiters', () => {
  const result = render('const url = "https://host/#field"; /* "quote" /[//]/ */ const after = 2; // tail\nreturn after;');
  assert.deepEqual(values(result, 'string'), ['"https://host/#field"']);
  assert.deepEqual(values(result, 'comment'), ['/* "quote" /[//]/ */', '// tail']);
  assert.deepEqual(values(result, 'number'), ['2']);
  assert.ok(values(result, 'keyword').includes('return'));
});

test('template substitutions highlight code and return to raw text after balanced objects', () => {
  const result = render('const message = `total: ${items.map(item => ({value: item.n + 1})).length} done`;');
  assert.ok(values(result, 'string').includes('`total: '));
  assert.ok(values(result, 'string').includes(' done`'));
  assert.deepEqual(values(result, 'number'), ['1']);
  assert.ok(!values(result, 'string').some(value => value.includes('items.map')));
});

test('nested templates, comments and regexps inside substitutions preserve lexical states', () => {
  const result = render('const text = `outer ${ok ? `inner ${1 + 2}` : /[}\/]/.test("}") /* } */} end`; const after = false;');
  assert.ok(values(result, 'string').includes('`inner '));
  assert.ok(values(result, 'string').includes(' end`'));
  assert.deepEqual(values(result, 'number'), ['1', '2']);
  assert.deepEqual(values(result, 'comment'), ['/* } */']);
  assert.ok(values(result, 'keyword').includes('false'));
});

test('escaped backticks and interpolation openings stay in template text', () => {
  const source = 'const text = `literal \\` and \\${notCode + 42} ${7}`;';
  const result = render(source);
  assert.ok(values(result, 'string').some(value => value.includes('${notCode + 42}')));
  assert.deepEqual(values(result, 'number'), ['7']);
});

test('unfinished ordinary literals stop at a line boundary while template text spans lines', () => {
  const result = render('const text = "unfinished\nconst after = 2;\nconst pattern = /[//]\nconst end = 3;');
  assert.deepEqual(values(result, 'number'), ['2', '3']);
  assert.deepEqual(values(result, 'comment'), []);
  const template = render('const text = `first\n${1}\nlast');
  assert.deepEqual(values(template, 'number'), ['1']);
  assert.ok(values(template, 'string').includes('\nlast'));
});

test('numeric forms include signs, exponent notation, separators, radix literals and bigint', () => {
  const result = render('const list = [-1.25e-3, .5, 1_000, 0xff, 0b1010, 0o755, 42n, -23n, 1.];');
  assert.deepEqual(values(result, 'number'), ['-1.25e-3', '.5', '1_000', '0xff', '0b1010', '0o755', '42n', '-23n', '1.']);
});

test('subtraction is an operator while a negative operand retains its sign', () => {
  const result = render('const n = 8 - 3; const negative = -2; const difference = 8-3;');
  assert.deepEqual(values(result, 'number'), ['8', '3', '-2', '8', '3']);
});

test('Unicode identifiers keep embedded keyword spellings and digits together', () => {
  const result = render('const returnValue = "ok"; const 変数2 = 42; const 𐐀true = 1; thing.return;');
  assert.deepEqual(values(result, 'keyword'), ['const', 'const', 'const']);
  assert.deepEqual(values(result, 'number'), ['42', '1']);
});

test('JSON highlights quoted keys and JSON values without JavaScript hash comments', () => {
  const result = render('{"label" : "#tag // not comment", "n": -6.02e+23, "ok": true, "empty": null}', 'json');
  assert.deepEqual(values(result, 'key'), ['"label"', '"n"', '"ok"', '"empty"']);
  assert.deepEqual(values(result, 'number'), ['-6.02e+23']);
  assert.deepEqual(values(result, 'keyword'), ['true', 'null']);
  assert.deepEqual(values(result, 'comment'), []);
  assert.deepEqual(values(render('const #field', 'json'), 'keyword'), []);
});

test('GraphQL hash comments, operation words, variables and block strings are independent', () => {
  const source = 'query Fetch($limit: Int = -2) { items(limit: $limit) { id } }\n# explanation\n"""multi\n# not a comment\n\\""" quoted\nend"""\nmutation Change { update(ok: true) }';
  const result = render(source, 'graphql');
  assert.deepEqual(values(result, 'comment'), ['# explanation']);
  assert.deepEqual(values(result, 'variable'), ['$limit', '$limit']);
  assert.deepEqual(values(result, 'keyword'), ['query', 'mutation', 'true']);
  assert.equal(values(result, 'string').length, 1);
  assert.ok(values(result, 'string')[0].includes('# not a comment'));
});

test('XML attributes containing closing brackets or markup do not end their tag', () => {
  const result = render('<node value="a > b <fake>" other=\'quoted >\'>text</node>', 'xml');
  assert.deepEqual(values(result, 'string'), ['"a > b <fake>"', "'quoted >'"]);
  assert.ok(values(result, 'tag').includes('</node>'));
  assert.ok(!result.html.includes('<fake>'));
});

test('XML declarations, doctype subsets, comments and CDATA preserve exact boundaries', () => {
  const source = '<?xml version="1.0"?><!DOCTYPE x [<!ELEMENT x (#PCDATA)>]><!-- <fake> --><x><![CDATA[<fake>& "quotes"]]></x>';
  const result = render(source, 'xml');
  assert.deepEqual(values(result, 'comment'), ['<!-- <fake> -->']);
  assert.ok(values(result, 'string').includes('<![CDATA[<fake>& "quotes"]]>'));
  assert.ok(values(result, 'tag').some(value => value.includes('<!DOCTYPE x [<!ELEMENT x (#PCDATA)>]>')));
});

test('HTML, XML and text remain escaped even for hostile tags and existing entities', () => {
  for (const language of ['html', 'xml', 'text', 'javascript', 'json', 'graphql']) {
    const source = '<img src=x onerror="alert(1)"> &amp; <script>evil()</script> \' "';
    const result = render(source, language);
    assert.ok(!result.html.includes('<img'));
    assert.ok(!result.html.includes('<script'));
    assert.ok(result.html.replace(/<\/?span(?: class="syntax-[a-z]+")?>/g, '').includes('&amp;amp;'));
  }
});

test('MiniPost placeholders remain visible in request text, JSON strings and HTML attributes', () => {
  const cases = [
    ['https://{{host}}/{{path}} C:\\{{folder}}', 'text', ['{{host}}', '{{path}}', '{{folder}}']],
    ['{"token": "Bearer {{token}}", "value": {{number}}}', 'json', ['{{token}}', '{{number}}']],
    ['const url = "https://{{host}}"; const body = `{{body}} ${1}`;', 'javascript', ['{{host}}', '{{body}}']],
    ['<a href="{{url}}">{{label}}</a>', 'html', ['{{url}}', '{{label}}']]
  ];
  for (const [source, language, expected] of cases) assert.deepEqual(values(render(source, language), 'variable'), expected);
});

test('a large literal stays in one span and dense data keeps all text with bounded markup', () => {
  const literal = 'const large = "' + 'x'.repeat(300000) + '";';
  assert.equal(values(render(literal), 'string').length, 1);
  const dense = '[' + '1,'.repeat(20000) + '0]';
  const result = render(dense, 'json');
  assert.ok(result.tokens.length <= 12000);
});

test('incomplete placeholders and deeply nested templates do not recurse or lose text', () => {
  render('{{'.repeat(20000) + 'unclosed', 'text');
  const nested = '`x ${'.repeat(3000) + '1' + '}`'.repeat(3000);
  render(nested);
});

test('empty and non-string input retain the existing public API', () => {
  assert.equal(highlight(''), '');
  assert.equal(highlight(null), 'null');
  assert.equal(highlight(42), '42');
  assert.equal(highlight('<unknown>', 'unrecognized'), '&lt;unknown&gt;');
});
