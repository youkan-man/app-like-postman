import test from 'node:test';
import assert from 'node:assert/strict';
import {createScriptHost,makeScriptContext,formatScriptValue} from '../static/script-host.mjs';
import {PrimaryVariables} from '../static/runtime.mjs';

function fixture(){return {version:2,environmentId:'env',globals:[{key:'global',value:'old'}],environments:[{id:'env',name:'Test',values:[{key:'host',value:'old.example'}]}],tabs:[],scripts:[],scriptData:{rows:[1,2]},collections:[{_mpId:'collection',info:{name:'API'},variable:[{key:'path',value:'items'}],item:[{_mpId:'request',name:'Fetch',request:{method:'GET',url:'https://{{host}}/{{path}}?id={{id}}',header:[]}}]}]};}

test('standalone context has typed input and variables without a selected request',()=>{
  const workspace=fixture(),primary=new PrimaryVariables();primary.set('id','1');
  const context=makeScriptContext(workspace,primary,{input:[1,{ok:true}],scriptId:'script'});
  assert.deepEqual(context.input,[1,{ok:true}]);assert.equal(context.request,null);assert.equal(context.variables.host,'old.example');
  context.data.rows.push(3);assert.deepEqual(workspace.scriptData,{rows:[1,2]});
});

test('get then modify then send preserves request identity, attachments and collection variables',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();let sent,filesTab,recorded;
  const host=createScriptHost({workspace,primary,filesFor:tab=>{filesTab=tab;return {};},send:async payload=>{sent=payload;return {status:200,body:'{"ok":true}',headers:[]};},onResponse:tab=>recorded=tab});
  const request=await host('requests.get',['collection:request']);request.request.header=[{key:'X-Edited',value:'yes'}];
  const result=await host('requests.send',[request],{variables:{primary:{id:'42'},environment:{host:'new.example'},globals:{global:'new'}}});
  assert.equal(filesTab.collectionId,'collection');assert.equal(filesTab.itemId,'request');assert.equal(recorded.itemId,'request');
  assert.equal(sent.url,'https://new.example/items');assert.deepEqual(sent.query,[{key:'id',value:'42'}]);assert.equal(sent.headers.find(row=>row.key==='X-Edited')?.value,'yes');
  assert.deepEqual(result.body,{ok:true});assert.equal(workspace.environments[0].values[0].value,'old.example');assert.equal(primary.get('id'),undefined);
});

test('catalog and workspace reads are isolated and ambiguous names are rejected',async()=>{
  const workspace=fixture();workspace.collections[0].item.push({...workspace.collections[0].item[0],_mpId:'other'});
  const host=createScriptHost({workspace,primary:new PrimaryVariables()});
  await assert.rejects(host('requests.get',['Fetch']),/複数/);
  const copy=await host('workspace.read');copy.scriptData.rows.push(9);
  assert.deepEqual((await host('workspace.read')).scriptData.rows,[1,2]);
  assert.equal((await host('requests.list')).length,2);
});

test('cancellation is carried through to a script send and does not record its response',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();let recorded=false;
  const control=new AbortController();
  const host=createScriptHost({workspace,primary,send:async(_payload,signal)=>{assert.equal(signal,control.signal);control.abort();return {status:200,body:'ok',headers:[]};},onResponse:()=>recorded=true});
  await assert.rejects(host('requests.send',[{method:'GET',url:'https://example.test'}],{signal:control.signal}),{name:'AbortError'});
  assert.equal(recorded,false);
});

test('result rendering preserves repeated references and represents real cycles without throwing',()=>{
  const row={x:1};assert.deepEqual(JSON.parse(formatScriptValue({a:row,b:row})),{a:{x:1},b:{x:1}});
  const value={};value.self=value;assert.equal(JSON.parse(formatScriptValue(value)).self,'[循環参照]');
  const map=new Map();map.set('self',map);assert.match(formatScriptValue(map),/循環参照/);
  assert.equal(formatScriptValue(undefined),'戻り値なし');assert.equal(formatScriptValue('text'),'text');assert.equal(formatScriptValue(null),'null');
});
