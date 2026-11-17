import test from 'node:test';
import assert from 'node:assert/strict';
import {scriptEditorContext} from '../static/script-editor-context.mjs';

function fixture(){return {
  version:2,collections:[{_mpId:'collection',info:{name:'Service'},variable:[{key:'collectionKey',value:'private-collection'}],item:[
    {_mpId:'folder',name:'Folder',variable:[{key:'folderKey',value:'private-folder'}],item:[{_mpId:'request',name:'Fetch records',
      request:{method:'POST',url:{raw:'https://service.invalid',variable:[{key:'urlKey',value:'private-url'}]},
        header:[{key:'Authorization',value:'private-authorization'}],body:{mode:'raw',raw:'private-body'}},settings:{timeout_ms:1000}}]}]}],
  tabs:[],history:[],environmentId:'env',environments:[{id:'env',name:'Staging',values:[{key:'environmentKey',value:'private-environment'},{key:'disabledKey',value:'no',enabled:false}]}],
  globals:[{key:'globalKey',value:'private-global'}],scripts:[{id:'active',name:'Main',source:'active source',input:'{"records":[{"id":1}]}',inputFormat:'json',bindingId:'group'},
    {id:'helper',name:'Helper',source:'return {ready:true};',input:'null',inputFormat:'json'}],scriptData:{last:{count:3}},scriptBindings:{group:{old:'helper'}}
};}

test('editor context carries dynamic names and shapes without request or variable secrets',()=>{
  const workspace=fixture(),tab={collectionId:'collection',itemId:'request',request:workspace.collections[0].item[0].item[0].request};
  const context=scriptEditorContext(workspace,{rows:[{key:'primaryKey',value:'private-primary'}]},{tab,phase:'before'});
  assert.deepEqual(Object.keys(context.variables).sort(),['collectionKey','environmentKey','folderKey','globalKey','primaryKey','urlKey']);
  assert.deepEqual(context.environment,{environmentKey:''});
  assert.equal(context.requests[0].id,'collection:request');
  assert.equal(context.requests[0].path,'Service / Folder / Fetch records');
  assert.equal(context.requests[0].request.body.raw,'');
  assert.equal(context.requests[0].request.header[0].value,'');
  assert.equal(context.environments[0].name,'Staging');
  assert.equal(context.environments[0].values[0].key,'environmentKey');
  assert.ok(!JSON.stringify(context).includes('private-'));
});

test('standalone snapshots retain raw input for worker parsing and refresh changed catalog data',()=>{
  const workspace=fixture(),script=workspace.scripts[0];
  let context=scriptEditorContext(workspace,{rows:[]},{script});
  assert.equal(context.scriptId,'active');assert.equal(context.inputSource,script.input);
  assert.equal(context.inputFormat,'json');assert.equal(context.scripts[0].source,'');
  assert.equal(context.scripts[1].source,'return {ready:true};');
  assert.deepEqual(context.bindings,{group:{old:'helper'}});
  workspace.scripts[1].name='Renamed';workspace.scripts[1].source='return {updated:1};';
  script.input='{"newField":true}';workspace.scriptData={newKey:[1,2]};
  context=scriptEditorContext(workspace,{rows:[]},{script});
  assert.equal(context.scripts[1].name,'Renamed');assert.equal(context.scripts[1].source,'return {updated:1};');
  assert.equal(context.inputSource,'{"newField":true}');assert.deepEqual(context.data,{newKey:[1,2]});
});

test('drafts override saved request shapes while keeping catalog identity',()=>{
  const workspace=fixture();workspace.tabs=[{id:'draft',name:'Edited',collectionId:'collection',itemId:'request',
    request:{method:'POST',url:'https://service.invalid',body:{mode:'formdata',formdata:[{key:'file',type:'file',src:'private-file'}]}},settings:{verify_tls:false}},
    {id:'unsaved',name:'Scratch',request:{method:'GET',url:'https://other.invalid'}}];
  const context=scriptEditorContext(workspace,{rows:[]});
  assert.equal(context.requests.length,2);assert.equal(context.requests[0].id,'collection:request');
  assert.ok(context.requests[0].request.body.formdata);assert.equal(context.requests[0].request.body.formdata[0].src,'');
  assert.equal(context.requests[1].id,'draft:unsaved');assert.equal(context.requests[1].name,'Scratch');
});

test('response JSON parsing is deferred to the worker and binary payloads are omitted',()=>{
  const workspace=fixture(),tab={request:{method:'GET',url:''}};
  const result={status:200,body:'{"users":[{"name":"Ada"}]}',headers:[{key:'X-Token',value:'private-token'}],body_encoding:'text'};
  let context=scriptEditorContext(workspace,{rows:[]},{tab,result,phase:'after'});
  assert.equal(context.rawResponse.body,result.body);assert.equal(context.phase,'after');assert.equal(context.response,undefined);
  assert.deepEqual(context.rawResponse.headers,[{key:'X-Token',value:''}]);
  context=scriptEditorContext(workspace,{rows:[]},{tab,result:{...result,body:'AA'.repeat(10000),body_encoding:'base64'},phase:'after'});
  assert.equal(context.rawResponse.body,'');
});

test('before-script completion does not reuse an earlier received response',()=>{
  const workspace=fixture(),tab={request:{method:'GET',url:''}};
  const result={status:200,body:'{"previousResult":true}',headers:[{key:'X-Previous',value:'private-token'}]};
  const context=scriptEditorContext(workspace,{rows:[]},{tab,result,phase:'before'});
  assert.equal(context.rawResponse,undefined);
  assert.equal(context.response,undefined);
  assert.ok(!JSON.stringify(context).includes('previousResult'));
  assert.ok(!JSON.stringify(context).includes('X-Previous'));
});
