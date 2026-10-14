import test from 'node:test';
import assert from 'node:assert/strict';
import {newRequest} from '../static/core.mjs';
import {RevisionStore, requestKey} from '../static/revisions.mjs';
import {exportWorkspace, isWorkspaceBundle, readWorkspaceBundle, mergeWorkspace} from '../static/workspace-data.mjs';

function sample() {
  const r = newRequest();
  r.method='POST'; r.url='https://example.invalid/v1';
  return {
    version:2,
    collections:[{_mpId:'c1',info:{name:'API',schema:'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},item:[
      {_mpId:'f1',name:'Group',item:[{_mpId:'i1',name:'Get data',request:r,settings:{verify_tls:true,follow_redirects:true,timeout_ms:5000}}]}
    ],variable:[]}],
    environments:[{id:'e1',name:'QA',values:[{key:'region',value:'jp'}]}],
    globals:[{key:'base',value:'https://example.invalid'}],
    tabs:[{id:'t1',name:'Get data',collectionId:'c1',itemId:'i1',request:r,settings:{verify_tls:true,follow_redirects:true,timeout_ms:5000},dirty:false}],
    activeId:'t1',environmentId:'e1',
    history:[{id:'h1',environmentId:'e1',at:'2026-10-14T00:00:00Z',status:200,tab:{id:'t1',collectionId:'c1',itemId:'i1',name:'Get data',request:r}}],
    collapsed:['f1'],theme:'dark',revisions:{},
  };
}
test('full archive retains environments, globals, history, drafts, layout and revisions',()=>{
  const ws=sample();
  const history = new RevisionStore(ws);
  ws.environments[0].values[0].value='us';
  ws.collections[0].item[0].item[0].request.method='PUT';
  history.capture();
  const archive=exportWorkspace(ws,{layout:{sidebar:333},sections:['headers']});
  assert.ok(isWorkspaceBundle(archive));
  const recovered=readWorkspaceBundle(JSON.stringify(archive));
  assert.deepEqual(recovered.workspace,ws);
  assert.equal(recovered.layout.layout.sidebar,333);
  assert.equal(recovered.workspace.revisions['environment:e1'].at,undefined); // revisions are arrays
  assert.ok(recovered.workspace.revisions['environment:e1'].length>=2);
  assert.ok(recovered.workspace.revisions['request:c1:i1'].length>=2);
});
test('reject malformed bundles without mutating local state',()=>{
  const ws=sample();
  for(const bundle of [null,{}, {kind:'minipost.workspace',version:2,workspace:ws}, {kind:'minipost.workspace',version:1,workspace:{version:2,collections:[]}}, {kind:'minipost.workspace',version:1,workspace:null}]) {
    assert.throws(()=>readWorkspaceBundle(bundle));
  }
  assert.equal(ws.environments[0].name,'QA');
});
test('merging a full archive preserves existing items and remaps every foreign ID and revision key',()=>{
  const existing=sample(), incoming=sample();
  incoming.collections[0].info.name='Imported';
  incoming.revisions={'request:c1:i1':[{id:'revision',at:'2026-10-14',value:{name:'Original'}}], 'environment:e1':[{id:'revision-2',at:'2026-10-14'}]};
  const merged=mergeWorkspace(existing,incoming);
  assert.equal(merged.collections.length,2);
  assert.equal(merged.environments.length,2);
  assert.equal(merged.tabs.length,2);
  assert.equal(merged.history.length,2);
  const imp=merged.collections[1];
  const item=imp.item[0].item[0];
  assert.notEqual(imp._mpId,'c1');
  assert.notEqual(imp.item[0]._mpId,'f1');
  assert.notEqual(item._mpId,'i1');
  assert.equal(merged.tabs[1].collectionId,imp._mpId);
  assert.equal(merged.tabs[1].itemId,item._mpId);
  assert.equal(merged.history[1].environmentId,merged.environments[1].id);
  assert.ok(merged.revisions[`request:${imp._mpId}:${item._mpId}`]);
  assert.ok(merged.revisions[`environment:${merged.environments[1].id}`]);
  assert.equal(merged.collapsed[1],imp.item[0]._mpId);
  assert.equal(merged.collections[0].info.name,'API');
});
test('local request keys keep stable identity for stored entries',()=>{
  const ws=sample();
  assert.equal(requestKey(ws,ws.tabs[0]),'request:c1:i1');
  ws.tabs.push({...ws.tabs[0],id:'t2',itemId:null});
  assert.equal(requestKey(ws,ws.tabs[1]),'draft:t2');
});
