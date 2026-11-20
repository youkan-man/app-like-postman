import test from 'node:test';
import assert from 'node:assert/strict';
import {newRequest} from '../static/core.mjs';
import {RevisionStore, requestKey} from '../static/revisions.mjs';
import {exportWorkspace, isWorkspaceBundle, readWorkspaceBundle, mergeWorkspace} from '../static/workspace-data.mjs';
import {newRelation,newStep,newRelationStep,walkRelationSteps,validateRelation} from '../static/relations.mjs';
import {newScript} from '../static/scripts.mjs';

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
  ws.tabs[0].request.method='PUT';
  history.capture();
  const archive=exportWorkspace(ws,{layout:{sidebar:333},sections:['headers']});
  assert.ok(isWorkspaceBundle(archive));
  const recovered=readWorkspaceBundle(JSON.stringify(archive));
  assert.deepEqual(recovered.workspace,ws);
  assert.equal(recovered.layout.layout.sidebar,333);
  assert.ok(Array.isArray(recovered.workspace.revisions['environment:e1']));
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

test('a broken nested full backup is rejected before current data can be replaced',()=>{
  const invalid = [
    ws => {ws.collections[0].item=null;},
    ws => {ws.collections[0].item[0].item=[{_mpId:'r',name:'Broken'}];},
    ws => {ws.tabs[0].request=null;},
    ws => {ws.environments[0].values={key:'not-an-array'};},
    ws => {ws.history[0].tab=null;},
    ws => {ws.revisions=JSON.parse('{"__proto__":[{"value":{}}]}');},
    ws => {ws.revisions={'request:c1:i1':{not:'revisions'}};}
  ];
  for(const corrupt of invalid) {
    const before=sample(), ws=structuredClone(before);
    corrupt(ws);
    assert.throws(()=>readWorkspaceBundle(exportWorkspace(ws)));
    assert.equal(before.collections[0].info.name,'API');
  }
});
test('older before/after change histories remain importable',()=>{
  const ws=sample();
  ws.settingHistory={globals:[{at:'2026-10-14T00:00:00Z',before:[],after:[{key:'x',value:'a'}],fields:['0']}]};
  const result=readWorkspaceBundle(exportWorkspace(ws));
  assert.deepEqual(result.workspace.settingHistory,ws.settingHistory);
});

test('nested relation blocks survive backup and remap request, script, branch and revision references together',()=>{
  const source=sample(), relation=newRelation('Nested flow'), loop=newRelationStep('repeat'), branch=newRelationStep('if');
  const first=newStep({collectionId:'c1',itemId:'i1'}),second=newStep({draftId:'t1'}),script=newScript('Transform');
  script.source='return input;';source.scripts=[script];
  first.condition.enabled=true;first.onTrue=second.id;
  const call=newRelationStep('script');call.scriptId=script.id;
  const each=newRelationStep('forEach');each.value='[1,2]';each.steps=[call];
  branch.steps=[first,second];branch.elseSteps=[each];loop.steps=[branch];relation.steps=[loop];source.relations=[relation];
  source.relationRuns=[{id:'run',relationId:relation.id,entries:[{stepId:first.id,branch:{target:second.id}}]}];
  source.revisions[`relation:${relation.id}`]=[{id:'revision-flow',value:structuredClone(relation)}];
  source.settingHistory={[`relation:${relation.id}`]:[{before:structuredClone(relation),after:structuredClone(relation)}]};
  const before=structuredClone(source),restored=readWorkspaceBundle(exportWorkspace(source)).workspace;
  assert.deepEqual(restored.relations,source.relations);
  const into=sample();mergeWorkspace(into,restored);
  const imported=into.relations[0], importedBranch=imported.steps[0].steps[0];
  const [a,b]=importedBranch.steps, importedCall=importedBranch.elseSteps[0].steps[0];
  const oldIds=new Set(),newIds=new Set();walkRelationSteps(relation.steps,step=>oldIds.add(step.id));walkRelationSteps(imported.steps,step=>newIds.add(step.id));
  assert.equal(newIds.size,oldIds.size);for(const id of newIds)assert.equal(oldIds.has(id),false);
  assert.equal(a.collectionId,into.collections[1]._mpId);assert.equal(a.itemId,into.collections[1].item[0].item[0]._mpId);
  assert.equal(b.draftId,into.tabs[1].id);assert.equal(a.onTrue,b.id);assert.equal(importedCall.scriptId,into.scripts[0].id);
  assert.equal(into.relationRuns[0].relationId,imported.id);assert.equal(into.relationRuns[0].entries[0].stepId,a.id);
  assert.equal(into.relationRuns[0].entries[0].branch.target,b.id);
  const key=`relation:${imported.id}`;
  for(const revision of [into.revisions[key][0].value,into.settingHistory[key][0].before,into.settingHistory[key][0].after]) {
    assert.equal(revision.steps[0].steps[0].steps[0].onTrue,b.id);
    assert.equal(revision.steps[0].steps[0].elseSteps[0].steps[0].scriptId,importedCall.scriptId);
  }
  validateRelation(imported,into);assert.deepEqual(source,before);
});

test('incomplete relation blocks remain editable after reload but malformed nested structure is rejected',()=>{
  const source=sample(),relation=newRelation('Draft flow'),loop=newRelationStep('repeat');
  const script=newRelationStep('script');loop.steps=[script];relation.steps=[loop];source.relations=[relation];
  assert.deepEqual(readWorkspaceBundle(exportWorkspace(source)).workspace.relations,source.relations);
  for(const corrupt of [
    step=>{step.steps={};},step=>{step.steps[0].id=step.id;},step=>{step.steps[0].type='invalid';},
    step=>{step.steps[0].scriptId=3;},step=>{step.steps[0].elseSteps=[];}
  ]) {
    const broken=structuredClone(source);corrupt(broken.relations[0].steps[0]);
    assert.throws(()=>readWorkspaceBundle(exportWorkspace(broken)));
    const into=sample(),before=structuredClone(into);assert.throws(()=>mergeWorkspace(into,broken));assert.deepEqual(into,before);
  }
  const broken=structuredClone(source);let child=broken.relations[0].steps[0];
  for(let at=0;at<33;at++){child.steps=[newRelationStep('repeat')];child=child.steps[0];}
  assert.throws(()=>readWorkspaceBundle(exportWorkspace(broken)));
});

test('malformed relation blocks in revision archives cannot become restorable data',()=>{
  const source=sample();
  source.revisions['relation:flow']=[{value:{name:'Flow',steps:[{id:'loop',type:'if',steps:[],elseSteps:{}}]}}];
  assert.throws(()=>readWorkspaceBundle(exportWorkspace(source)));
});
