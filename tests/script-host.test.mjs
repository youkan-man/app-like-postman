import test from 'node:test';
import assert from 'node:assert/strict';
import {createScriptHost,makeScriptContext,formatScriptValue} from '../static/script-host.mjs';
import {PrimaryVariables} from '../static/runtime.mjs';
import {historyEntry} from '../static/sent-history.mjs';
import {RequestSession} from '../static/request-session.mjs';

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

test('a script send preserves canonical target ribbons through recorded history and reopening for editing',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables(),item=workspace.collections[0].item[0];
  item.request.url='https://example.test/saved';
  item.ribbonState={id:'saved-scope',activeRibbonId:'tools',ribbonBindings:{},ribbons:[{id:'tools',key:'tools',name:'Tools',groups:[{
    id:'group',name:'Inputs',controls:[{id:'query',key:'query',label:'Query',type:'text',value:'canonical',actions:[]}]
  }]}]};
  const value=state=>state.ribbons[0].groups[0].controls[0];
  const cached=structuredClone(item.ribbonState);cached.id='stale-editor-scope';value(cached).value='stale';
  workspace.tabs=[{id:'editor',collectionId:'collection',itemId:'request',name:'Fetch',request:item.request,ribbonState:cached}];
  let recorded;
  const host=createScriptHost({workspace,primary,filesFor:tab=>{assert.equal(tab.ribbonState.id,'saved-scope');return {};},
    send:async()=>{value(item.ribbonState).value='edited during send';return {status:200,body:'{}',headers:[]};},
    onResponse:(tab,result)=>{recorded=historyEntry(tab,result);}});
  const request=await host('requests.get',['collection:request']);request.request.header=[{key:'X-Edited',value:'yes'}];
  await host('requests.send',[request]);
  assert.equal(recorded.tab.ribbonState.id,'saved-scope');assert.equal(value(recorded.tab.ribbonState).value,'canonical');
  assert.equal(recorded.tab.request.header[0].value,'yes');assert.equal(value(item.ribbonState).value,'edited during send');
  const session=new RequestSession(workspace,()=>({id:'blank',request:{method:'GET',url:''}})),editor=session.openHistory(recorded);
  assert.notEqual(editor.ribbonState.id,'saved-scope');assert.equal(value(editor.ribbonState).value,'canonical');
  value(editor.ribbonState).value='history edit';assert.equal(value(recorded.tab.ribbonState).value,'canonical');
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
