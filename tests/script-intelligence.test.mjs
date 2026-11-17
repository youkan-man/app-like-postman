import test from 'node:test';
import assert from 'node:assert/strict';
import {createScriptIntelligence} from '../static/script-intelligence.mjs';
import ts from '../static/vendor-typescript.mjs';

const service = createScriptIntelligence();
const inspect = (marked, context = {}, options = {}) => {
  const position = marked.indexOf('¦');
  assert.notEqual(position, -1, 'test source must identify the cursor');
  const source = marked.slice(0, position) + marked.slice(position + 1);
  return {...service.analyze(source, position, {...options, context}), source, position};
};
const names = (source, context, options) => inspect(source, context, options).completion?.items.map(item => item.label) || [];
const has = (source, expected, context) => {
  const candidates = names(source, context);
  for (const name of expected) assert.ok(candidates.includes(name), `${name} not found in ${JSON.stringify(candidates)}`);
};

test('analysis is backed by the bundled TypeScript parser and language service', () => {
  const result = inspect('const value = {count:1}; value.co¦');
  assert.deepEqual(result.engine, {name:'TypeScript', version:'5.9.3'});
  assert.equal(result.completion.items[0].label, 'count');
  assert.match(result.completion.items[0].signature, /number/);
});

test('object literals, aliases, nested values and destructuring preserve member types', () => {
  has('const record = {profile:{city:"Kyoto", rank:2}}; const alias = record.profile; alias.¦', ['city','rank']);
  has('const {profile:person} = {profile:{city:"Kyoto", rank:2}}; person.city.toU¦', ['toUpperCase']);
  has('const [first] = [{name:"A", active:true}]; first.¦', ['name','active']);
});

test('block/function scope and local shadowing are resolved from declarations', () => {
  assert.ok(!names('function hidden(secretArgument) { const secretLocal=1; return secretLocal; } sec¦').some(name => name.startsWith('secret')));
  assert.ok(!names('{ const blockOnly = 1; } block¦').includes('blockOnly'));
  assert.deepEqual(names('const request = {custom:true}; request.¦'), ['custom']);
  has('const item = {outside:1}; function child(){ const item={inside:"x"}; item.¦ }', ['inside']);
  assert.ok(!names('const item = {outside:1}; function child(){ const item={inside:"x"}; item.¦ }').includes('outside'));
});

test('inferred callback parameters and returned values support method chains', () => {
  has('const rows = [{name:"A",score:2}]; rows.map(row => row.¦);', ['name','score']);
  has('const rows = [{score:2}]; rows.map(row => row.score).filter(score => score.to¦);', ['toFixed','toPrecision','toString']);
  has('function create(){return {ready:true, data:{count:1}};} create().data.¦', ['count']);
});

test('classes, inheritance and this members are inferred', () => {
  has('class Base { base(){return 1;} } class Child extends Base { constructor(){super();this.count=1;} own(){this.¦} }', ['base','count','own']);
  has('class Box { make(){return {done:true};} } new Box().make().¦', ['done']);
});

test('standard collection, string, Promise and typed-array libraries are real types', () => {
  has('const value = [1,2,3]; value.¦', ['map','filter','reduce','toReversed']);
  has('new Uint8Array([1,2]).sub¦', ['subarray']);
  has('const entry = new Map([["id", {active:true}]]).get("id"); entry.¦', ['active']);
  has('const value = await Promise.resolve({ready:true}); value.¦', ['ready']);
});

test('JSDoc parameters, return types and custom signatures are understood', () => {
  has('/** @param {{name:string, age:number}} person */\nfunction inspect(person){ person.¦ }', ['name','age']);
  const signature = inspect('/** Converts a count.\n * @param {number} amount quantity\n * @param {string} unit unit name\n */\nfunction format(amount, unit="ms"){ return amount+unit; }\nformat(1, ¦').signature;
  assert.equal(signature.name, 'format');
  assert.equal(signature.argument, 1);
  assert.match(signature.signature, /amount: number/);
  assert.match(signature.signature, /unit\??: string/);
  assert.match(signature.description, /Converts a count/);
});

test('control-flow narrowing and optional chains use the expression type', () => {
  has('let value = Math.random() > .5 ? "value" : 2; if (typeof value === "string") { value.toU¦ }', ['toUpperCase']);
  has('const value = {profile:{name:"A"}}; value?.profile?.na¦', ['name']);
  has('const people = [{profile:{name:"A"}}]; people[0].profile.¦', ['name']);
});

test('template interpolations are parsed as JavaScript while literal text is not', () => {
  has('const person = {name:"A"}; `hello ${person.na¦}`', ['name']);
  assert.equal(inspect('const person = {name:"A"}; `person.na¦`').completion, null);
  assert.equal(inspect('"pm.re¦"').completion, null);
  assert.equal(inspect('// pm.re¦').completion, null);
  assert.equal(inspect('/* pm.re¦ */').completion, null);
  assert.equal(inspect('const expression = /pm.re¦/;').completion, null);
});

test('computed-property string completion preserves quotes and the complete suffix', () => {
  const result = inspect('const object = {"long-name":1, other:2}; object["lo¦ng-typo"]');
  const item = result.completion.items.find(item => item.label === 'long-name');
  assert.ok(item);
  assert.equal(result.source.slice(0,item.from) + item.insertText + result.source.slice(item.to), 'const object = {"long-name":1, other:2}; object["long-name"]');
});

test('escaped and Unicode-escaped literal prefixes resolve exact dictionary keys', () => {
  const context = {data:{'a"b':1, "a'b":2, 'apple':3}};
  const quoted = inspect('store.get("a\\\"¦wrong")', context);
  const item = quoted.completion.items[0];
  const accepted = quoted.source.slice(0,item.from) + item.insertText + quoted.source.slice(item.to);
  assert.equal(accepted, 'store.get("a\\\"b")');
  const unicode = inspect('store.get("\\u0061p¦")', context);
  assert.ok(unicode.completion.items.some(item => item.label === 'apple'));
  const single = inspect("store.get('a\\'¦wrong')", context);
  const singleItem = single.completion.items[0];
  assert.equal(single.source.slice(0,singleItem.from) + singleItem.insertText + single.source.slice(singleItem.to), "store.get('a\\'b')");
});

test('backtick dictionary completions preserve interpolation-looking keys as literal text', () => {
  const keys = ['a${b}', 'a\\${b}', 'a`b', 'a\nb'];
  const context = {data:Object.fromEntries(keys.map(key => [key,1]))};
  const result = inspect('store.get(`a¦`)',context);
  const inserted = [];
  for (const item of result.completion.items) {
    const accepted = result.source.slice(0,item.from) + item.insertText + result.source.slice(item.to);
    const parsed = ts.createSourceFile('accepted.js',accepted,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const argument = parsed.statements[0].expression.arguments[0];
    assert.ok(ts.isNoSubstitutionTemplateLiteral(argument),accepted);
    assert.deepEqual(parsed.parseDiagnostics,[]);
    inserted.push(argument.text);
  }
  assert.deepEqual(inserted.sort(),keys.sort());
  for (const source of ['store.get(`a$¦wrong`)','store.get(`\\u0061$¦wrong`)']) {
    const partial = inspect(source,context);
    const item = partial.completion.items.find(item => item.label === 'a${b}');
    assert.ok(item);
    assert.equal(partial.source.slice(0,item.from) + item.insertText + partial.source.slice(item.to),'store.get(`a\\${b}`)');
  }
});

test('incomplete syntax remains useful and replacement removes an erroneous suffix', () => {
  const result = inspect('const profile = {address:{city:"Kyoto"}}; profile.address.ci¦tty');
  const item = result.completion.items.find(item => item.label === 'city');
  assert.ok(item);
  assert.equal(result.source.slice(item.from,item.to), 'citty');
  has('function incomplete(){ const item={ready:true}; item.re¦', ['ready']);
});

test('unicode identifiers retain correct UTF-16 offsets', () => {
  const result = inspect('const 認証情報 = {利用者名:"A"}; 認証情報.利用¦者名');
  const item = result.completion.items.find(item => item.label === '利用者名');
  assert.ok(item);
  assert.equal(result.source.slice(item.from,item.to), '利用者名');
  has('const 𐐀value={member:1}; 𐐀value.me¦', ['member']);
});

test('compiler identifier spans preserve private markers and decode escaped names', () => {
  const privateName = inspect('class Box { #secret=1; read(){ return this.#se¦cretTypo; } }');
  const item = privateName.completion.items.find(item => item.label === '#secret');
  assert.ok(item);
  assert.equal(privateName.source.slice(item.from,item.to),'#secretTypo');
  assert.equal(privateName.source.slice(0,item.from)+item.insertText+privateName.source.slice(item.to),
    'class Box { #secret=1; read(){ return this.#secret; } }');

  const escaped = inspect('const \\u0061bc={ready:true}; \\u0061b¦Typo');
  const name = escaped.completion.items.find(item => item.label === 'abc');
  assert.ok(name);
  assert.equal(escaped.source.slice(name.from,name.to),'\\u0061bTypo');
  assert.equal(escaped.source.slice(0,name.from)+name.insertText+escaped.source.slice(name.to),
    'const \\u0061bc={ready:true}; abc');
});

test('unterminated literals ending in escaped delimiters retain their decoded prefix', () => {
  const context = {data:{'a"b':1, "a'b":1, 'a`${missing}':1, unrelated:1}};
  for (const [marked,expected,quote] of [
    ['store.get("a\\"¦','a"b','"'],
    ["store.get('a\\'¦","a'b","'"],
    ['store.get(`a\\`¦','a`${missing}','`']
  ]) {
    const result = inspect(marked,context);
    assert.equal(result.completion.items.length,1);
    const item = result.completion.items[0];
    const accepted = result.source.slice(0,item.from)+item.insertText+result.source.slice(item.to)+quote+')';
    const parsed = ts.createSourceFile('accepted.js',accepted,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const argument = parsed.statements[0].expression.arguments[0];
    assert.ok(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument));
    assert.equal(argument.text,expected);
    assert.deepEqual(parsed.parseDiagnostics,[]);
  }
});

test('edits invalidate old symbols and inferred members without restarting the service', () => {
  has('const changing={first:1}; changing.¦', ['first']);
  assert.deepEqual(names('const changing={second:"x"}; changing.¦'), ['second']);
  assert.ok(!names('const newest=1; chan¦').includes('changing'));
});

test('internal analysis wrappers do not become suggestions while user __ names remain valid', () => {
  const result = names('¦', {}, {explicit:true});
  assert.ok(result.includes('input') && result.includes('pm'));
  assert.ok(!result.some(name => name.startsWith('__')));
  has('const __userValue=1; __user¦', ['__userValue']);
});

test('parsing does not execute source and unknown receivers do not get fictional APIs', () => {
  globalThis.__minipostAnalysisExecution = 0;
  inspect('globalThis.__minipostAnalysisExecution++; throw new Error("must not run"); pm.¦');
  assert.equal(globalThis.__minipostAnalysisExecution, 0);
  delete globalThis.__minipostAnalysisExecution;
  assert.deepEqual(names('unknown.pm.response.¦'), []);
  assert.deepEqual(names('const value = JSON.parse("{}"); value.¦'), []);
});

test('syntax diagnostics and type information use user-source offsets', () => {
  const invalid = inspect('const broken = ;¦');
  assert.ok(invalid.diagnostics.some(item => item.severity === 'error'));
  assert.ok(invalid.diagnostics.every(item => item.from >= 0 && item.to <= invalid.source.length));
  const typed = inspect('const count = 7; count¦');
  assert.match(typed.quickInfo.text, /count/);
  assert.equal(typed.source.slice(typed.quickInfo.from,typed.quickInfo.to), 'count');
});

test('unfinished blocks, expressions and comments report errors at the user-source boundary', () => {
  for (const source of ['function helper() {', 'if (true) {', 'const fn = (', 'const value = {', '/* unfinished']) {
    const result = inspect(source + '¦');
    assert.ok(result.diagnostics.some(item => item.severity === 'error'), source);
    assert.ok(result.diagnostics.every(item => item.from >= 0 && item.to <= source.length), source);
    assert.ok(result.diagnostics.some(item => item.from === source.length), source);
  }
  assert.deepEqual(inspect('function helper() {}\nreturn helper();¦').diagnostics, []);
});

test('details are available on demand for any returned candidate', () => {
  const result = inspect('const row = {description:"A"}; row.de¦');
  const details = service.details(result.source,result.position,'description');
  assert.equal(details.label,'description');
  assert.match(details.signature,/string/);
});

test.after(() => service.dispose());
