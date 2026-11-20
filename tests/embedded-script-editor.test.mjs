import test from 'node:test';
import assert from 'node:assert/strict';
import {updateSavedScriptSource} from '../static/embedded-script-editor.mjs';
import {newScript} from '../static/scripts.mjs';
import {RevisionStore} from '../static/revisions.mjs';
import {executeScript} from '../static/script-worker.mjs';
import {makeScriptContext} from '../static/script-host.mjs';
import {PrimaryVariables} from '../static/runtime.mjs';

function workspace(){
  const script={...newScript('Shared'),id:'shared',source:'return input.value + 1;'};
  return {collections:[],environments:[],globals:[],tabs:[],history:[],relations:[],scripts:[script],scriptData:{},scriptBindings:{}};
}

test('embedded edits retain the shared script identity, update execution and capture source revisions',async()=>{
  const ws=workspace(),store=new RevisionStore(ws),script=ws.scripts[0],before=structuredClone(script);
  const source='return input.value * 3;';
  const result=updateSavedScriptSource(ws,'shared',source,script.source);
  assert.equal(result.script,script);assert.equal(result.changed,true);
  assert.deepEqual({...script,source:before.source},before);
  store.capture();assert.equal(ws.revisions['script:shared'].length,2);
  assert.equal(ws.revisions['script:shared'][0].value.source,before.source);
  assert.equal(ws.revisions['script:shared'][1].value.source,source);
  assert.deepEqual(ws.revisions['script:shared'][1].changed,['source']);
  const executed=await executeScript(ws.scripts[0].source,makeScriptContext(ws,new PrimaryVariables(),{scriptId:'shared',input:{value:4}}));
  assert.equal(executed.result,12);
  assert.equal(updateSavedScriptSource(ws,'shared',source,source).changed,false);
  store.capture();assert.equal(ws.revisions['script:shared'].length,2);
});

test('embedded edits resolve the live model instead of updating a replaced saved-script object',()=>{
  const ws=workspace(),captured=ws.scripts[0],original=captured.source;
  ws.scripts=[{...captured,name:'Renamed externally'}];
  const result=updateSavedScriptSource(ws,'shared','return 42;',original);
  assert.equal(result.script,ws.scripts[0]);assert.notEqual(result.script,captured);
  assert.equal(captured.source,original);assert.equal(ws.scripts[0].source,'return 42;');
  assert.equal(ws.scripts[0].name,'Renamed externally');
});

test('stale or deleted embedded references cannot overwrite current code or recreate scripts',()=>{
  const ws=workspace(),before=ws.scripts[0].source;
  ws.scripts[0].source='return "external";';const snapshot=structuredClone(ws);
  assert.throws(()=>updateSavedScriptSource(ws,'shared','return "stale";',before),/別の操作/);
  assert.deepEqual(ws,snapshot);
  assert.equal(updateSavedScriptSource(ws,'shared',ws.scripts[0].source,before).changed,false);
  ws.scripts=[];
  assert.throws(()=>updateSavedScriptSource(ws,'shared','return "stale";',before),/ありません/);
  assert.deepEqual(ws.scripts,[]);
  assert.throws(()=>updateSavedScriptSource(workspace(),'shared',42,before),TypeError);
});
