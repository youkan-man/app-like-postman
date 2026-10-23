import test from 'node:test';
import assert from 'node:assert/strict';
import {scriptCompletions,highlight} from '../static/code-editor.mjs';
test('script completion resolves object members and partial names',()=>{
 assert.ok(scriptCompletions('pm.').some(x=>x.label==='expect'));
 assert.deepEqual(scriptCompletions('pm.exp'),[{label:'expect',insert:'ect'}]);
 assert.ok(scriptCompletions('vars.s').some(x=>x.label==='set'));
 assert.ok(scriptCompletions('console.l').some(x=>x.label==='log'));
 assert.deepEqual(scriptCompletions('unknown.method'),[]);
});
test('script highlight escapes HTML and styles JavaScript keywords',()=>{
 const html=highlight('const x = "<unsafe>";','javascript');
 assert.match(html,/syntax-keyword/);assert.ok(html.includes('&lt;unsafe&gt;'));
});
