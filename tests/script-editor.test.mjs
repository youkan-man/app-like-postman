import test from 'node:test';
import assert from 'node:assert/strict';
import {scriptCompletions,highlight} from '../static/code-editor.mjs';
import {completionContext,signatureHelp,scriptCode} from '../static/script-intelligence.mjs';
const names=text=>scriptCompletions(text).map(item=>item.label);
test('root and partial member completion',()=>{
  assert.ok(names('pm.').includes('expect'));
  assert.deepEqual(scriptCompletions('pm.exp'),[{label:'expect',insert:'ect'}]);
  assert.ok(names('vars.s').includes('set'));assert.ok(names('console.l').includes('log'));
  assert.deepEqual(names('unknown.method'),[]);assert.deepEqual(names('p'),['pm']);
});
test('nested and optional-chain API completion',()=>{
  assert.deepEqual(scriptCompletions('pm.response.js'),[{label:'json',insert:'on'}]);
  assert.ok(names('pm.environment.s').includes('set'));
  assert.deepEqual(names('pm.response.headers.g'),['get']);
  assert.deepEqual(names('pm?.response?.js'),['json']);
});
test('unknown chains do not borrow known suffixes',()=>{
  assert.deepEqual(names('other.pm.response.'),[]);assert.deepEqual(names('strange.'),[]);
});
test('whitespace around member dots',()=>assert.deepEqual(names('pm . response . js'),['json']));
for(const prefix of ['// pm.','/* pm.','"pm.',"'pm.",'`pm.','const expression = /pm.']){
 test('no suggestion inside literal or comment '+prefix,()=>assert.deepEqual(names(prefix),[]));
}
test('closed comments and strings do not leak identifiers',()=>{
  assert.deepEqual(names('// const pretender = 1;\npre'),[]);
  assert.deepEqual(names('const note = "const pretender = 1";\npre'),[]);
  assert.deepEqual(names('/* hidden */ pm.response.js'),['json']);
});
test('local const let var function and parameter names',()=>{
  assert.ok(names('const accessToken = 1;\naccess').includes('accessToken'));
  assert.ok(names('let localValue;\nlocal').includes('localValue'));
  assert.ok(names('var variable;\nvari').includes('variable'));
  assert.ok(names('function helper(inputValue) { inp').includes('inputValue'));
  assert.ok(names('const apply = (record, index) => rec').includes('record'));
});
test('unicode identifiers',()=>assert.ok(names('const 認証情報 = 1;\n認証').includes('認証情報')));
test('replacement range includes right-hand identifier suffix',()=>{
  const source='pm.response.json';const result=completionContext(source,14);
  assert.equal(result.from,12);assert.equal(result.to,16);assert.equal(result.prefix,'js');
});
test('explicit Ctrl-space at an empty position',()=>{
  assert.equal(completionContext(''),null);
  assert.ok(completionContext('',0,{explicit:true}).items.some(x=>x.label==='pm'));
});
test('signatures count only commas in the current call',()=>{
  const h=signatureHelp('vars.set("token", JSON.stringify({a:1,b:2}), ');
  assert.equal(h.name,'vars.set');assert.equal(h.argument,2);
  assert.equal(signatureHelp('vars.set("token", ').argument,1);
  assert.equal(signatureHelp('vars.set("tok').argument,0);
  assert.equal(signatureHelp('vars.set("token",1);'),null);
});
test('nested call signature belongs to the inner callable',()=>{
  assert.equal(signatureHelp('vars.set("x", JSON.stringify(').name,'JSON.stringify');
});
test('comments never produce signature UI',()=>assert.equal(signatureHelp('// vars.set('),null));
test('syntax highlighting escapes HTML and styles actual keywords',()=>{
  const html=highlight('const x = "<unsafe>"; // hello','javascript');
  assert.match(html,/syntax-keyword/);assert.match(html,/syntax-comment/);assert.ok(html.includes('&lt;unsafe&gt;'));
});
test('source masks preserve offsets and line endings',()=>{
  const s='const x="//ab";\n/* c */ vars.';const mask=scriptCode(s);
  assert.equal(mask.code.length,s.length);assert.equal(mask.code.indexOf('\n'),s.indexOf('\n'));assert.equal(mask.mode,'code');
});
