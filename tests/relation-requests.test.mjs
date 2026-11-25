import test from 'node:test';
import assert from 'node:assert/strict';
import {clone,newRequest,normalizeRequest,isRelationRequest,compileRequest,importPostman,exportCollection} from '../static/core.mjs';
import {newRelation,newStep,newRelationStep,walkRelationSteps} from '../static/relations.mjs';
import {newRelationRequest,relationForRequest,relationRequestEntries,findRelationRequest,ensureRelationRequests,duplicateRequest} from '../static/relation-requests.mjs';
import {RequestSession} from '../static/request-session.mjs';
import {RevisionStore} from '../static/revisions.mjs';
import {newScript} from '../static/scripts.mjs';
import {newRibbonState} from '../static/ribbons.mjs';
import {duplicateItem,duplicateCollection,snapshotSettings,applySettings} from '../static/editops.mjs';
import {moveCollectionItem} from '../static/collection-move.mjs';
import {exportWorkspace,readWorkspaceBundle,mergeWorkspace} from '../static/workspace-data.mjs';

let sequence=0;
const blank=()=>({id:`draft-${++sequence}`,name:'Request',request:newRequest()});
function fixture() {
  const target={_mpId:'http',name:'HTTP',request:newRequest()},script=newScript('Transform');
  const first=newStep({collectionId:'collection',itemId:'http'}),last=newStep({collectionId:'collection',itemId:'flow'});
  first.onTrue=last.id;
  const branch=newRelationStep('if'),loop=newRelationStep('repeat'),call=newRelationStep('script');
  call.scriptId=script.id;branch.steps=[first,last];branch.elseSteps=[call];loop.steps=[branch];
  const definition={...newRelation('Flow'),environmentId:'environment',steps:[loop]};
  const flow={_mpId:'flow',name:'Flow',request:newRelationRequest('Flow',definition),ribbonState:newRibbonState()};
  const folder={_mpId:'folder',name:'Folder',item:[target,flow]};
  const collection={_mpId:'collection',info:{name:'Collection'},item:[folder]};
  const workspace={version:2,collections:[collection],tabs:[],environments:[{id:'environment',name:'QA',values:[]}],
    environmentId:'environment',globals:[],history:[],revisions:{},relations:[],relationRuns:[],scripts:[script]};
  return {workspace,collection,folder,target,flow,definition,loop,branch,first,last,call,script};
}
const steps=relation=>{const result=[];walkRelationSteps(relation.steps,step=>result.push(step));return result;};

test('relation request normalization retains inactive HTTP values and rejects HTTP compilation',()=>{
  const request=newRelationRequest('Flow');assert.equal(isRelationRequest(request),true);
  assert.equal(request.method,undefined);assert.equal(request.url,undefined);
  const http=normalizeRequest({method:'PATCH',url:'https://example.test/path?x=1',body:{mode:'raw',raw:'keep'}});
  Object.assign(http,{type:'relation',relation:request.relation});
  const normalized=normalizeRequest(http);
  assert.deepEqual(normalized,http);assert.notEqual(normalized,http);
  assert.throws(()=>compileRequest({}, {request:normalized}),/リレーション/);
  normalized.type='http';assert.equal(relationForRequest(normalized),null);
  const restored=normalizeRequest(normalized);assert.equal(restored.method,'PATCH');assert.equal(restored.body.raw,'keep');
  assert.equal(restored.relation.id,request.relation.id);
  assert.throws(()=>normalizeRequest({type:'other'}),/種類/);
  assert.throws(()=>normalizeRequest({type:'relation',relation:{steps:{}}}),/形式/);
});

test('legacy catalog migration preserves nested definitions, identities, logs and restorable revisions',()=>{
  const {workspace,folder,flow,definition}=fixture();folder.item.pop();
  workspace.relations=[clone(definition)];workspace.relationRuns=[{id:'run',relationId:definition.id,entries:[{stepId:definition.steps[0].id}]}];
  const previous={...clone(definition),name:'Earlier',repeat:3};delete previous.id;
  workspace.revisions[`relation:${definition.id}`]=[{id:'revision',at:'2026-11-01',value:previous}];
  workspace.settingHistory={[`relation:${definition.id}`]:[{before:previous,after:clone(definition)}]};
  const logs=clone(workspace.relationRuns),original=clone(workspace.relations);
  ensureRelationRequests(workspace);
  const entry=findRelationRequest(workspace,definition.id),key=`request:${entry.collectionId}:${entry.itemId}`;
  assert.deepEqual(workspace.relations,[]);assert.equal(workspace.collections.length,2);
  assert.equal(entry.owner.name,'Flow');assert.deepEqual(entry.relation,original[0]);
  assert.deepEqual(workspace.relationRuns,logs);assert.equal(entry.relation.environmentId,'environment');
  assert.equal(workspace.revisions[`relation:${definition.id}`],undefined);
  assert.equal(workspace.revisions[key][0].value.request.relation.id,definition.id);
  assert.equal(workspace.settingHistory[key][0].before.request.relation.repeat,3);
  new RevisionStore(workspace).restore(key,workspace.revisions[key][0]);
  assert.equal(entry.owner.name,'Earlier');assert.equal(entry.owner.request.relation.repeat,3);
  assert.equal(entry.owner.request.relation.id,definition.id);
  const after=clone(workspace);ensureRelationRequests(workspace);assert.deepEqual(workspace,after);
  assert.deepEqual(readWorkspaceBundle(exportWorkspace(workspace)).workspace,workspace);
  assert.equal(flow.request.relation.id,definition.id);
});

test('migration reuses an identical canonical owner and rejects divergent legacy definitions',()=>{
  const {workspace,flow}=fixture();workspace.relations=[clone(flow.request.relation)];
  ensureRelationRequests(workspace);assert.equal(workspace.collections.length,1);assert.equal(relationRequestEntries(workspace).length,1);
  workspace.relations=[{...clone(flow.request.relation),repeat:10}];const before=clone(workspace);
  assert.throws(()=>ensureRelationRequests(workspace),/重複/);assert.deepEqual(workspace,before);
});

test('relation lookup shares saved and draft request references while ignoring saved editor caches',()=>{
  const {workspace,collection,flow}=fixture();
  const draft={id:'draft',name:'Draft flow',request:newRelationRequest('Draft flow')};
  workspace.tabs=[{id:'cache',collectionId:collection._mpId,itemId:flow._mpId,name:flow.name,request:clone(flow.request)},draft];
  assert.equal(relationRequestEntries(workspace).length,2);
  for(const ref of [flow.request.relation.id,'collection:flow','flow',{collectionId:'collection',itemId:'flow'},'Flow'])
    assert.equal(findRelationRequest(workspace,ref).owner,flow);
  for(const ref of [draft.request.relation.id,'draft:draft','draft',{draftId:'draft'}])assert.equal(findRelationRequest(workspace,ref).owner,draft);
  draft.request.type='http';assert.equal(findRelationRequest(workspace,'draft:draft'),null);
});

test('saved relation editors reload normally and history copies do not share relation or step identities',()=>{
  const {workspace,collection,flow}=fixture(),session=new RequestSession(workspace,blank);
  const saved=session.openSaved(collection,flow);assert.equal(saved.request.relation.id,flow.request.relation.id);
  const reloaded=new RequestSession(readWorkspaceBundle(exportWorkspace(workspace)).workspace,blank);
  assert.equal(reloaded.active.itemId,flow._mpId);assert.equal(reloaded.active.request.type,'relation');
  workspace.history.push({id:'history',tab:clone(saved)});
  const historical=session.openHistory(workspace.history[0]);
  assert.notEqual(historical.request.relation.id,flow.request.relation.id);
  assert.notEqual(historical.request.relation.steps[0].id,flow.request.relation.steps[0].id);
  assert.equal(steps(historical.request.relation).find(step=>step.draftId)?.draftId,historical.id);
  assert.equal(workspace.tabs.length,0);session.addDraft(historical);session.addDraft(historical);
  assert.equal(workspace.tabs.length,1);assert.equal(relationRequestEntries(workspace).length,2);
  historical.name='Renamed';relationForRequest(historical.request,historical.name);
  const backup=readWorkspaceBundle(exportWorkspace(workspace)).workspace;
  assert.equal(new RequestSession(backup,blank).active.request.relation.name,'Renamed');
});

test('copying relation requests, folders and collections repairs branches and internal ownership references',()=>{
  const {collection,folder,flow}=fixture(),before=clone(collection);
  const copied=duplicateCollection(collection,[]),newFolder=copied.item[0],newFlow=newFolder.item[1];
  assert.notEqual(newFlow.request.relation.id,flow.request.relation.id);
  assert.notEqual(newFlow.ribbonState.id,flow.ribbonState.id);
  const [first,last]=newFlow.request.relation.steps[0].steps[0].steps;
  assert.equal(first.collectionId,copied._mpId);assert.equal(first.itemId,newFolder.item[0]._mpId);
  assert.equal(last.itemId,newFlow._mpId);assert.equal(first.onTrue,last.id);
  assert.equal(steps(newFlow.request.relation).some(step=>steps(flow.request.relation).some(old=>old.id===step.id)),false);
  const folderCopy=duplicateItem(folder),nested=folderCopy.item[1].request.relation.steps[0].steps[0].steps;
  assert.equal(nested[0].collectionId,collection._mpId);assert.equal(nested[0].itemId,folderCopy.item[0]._mpId);
  const draftCopy=duplicateRequest(flow.request,{name:'Draft copy',from:{collectionId:collection._mpId,itemId:flow._mpId},to:{draftId:'draft-copy'}});
  assert.equal(draftCopy.relation.steps[0].steps[0].steps[1].draftId,'draft-copy');
  assert.equal(draftCopy.relation.steps[0].steps[0].steps[1].itemId,'');
  assert.deepEqual(collection,before);
});

test('pasting request settings keeps target relation identity and owns copied steps independently',()=>{
  const {flow}=fixture(),target={_mpId:'target',name:'Target',request:newRelationRequest('Target')},id=target.request.relation.id;
  applySettings(target,'request',snapshotSettings(flow,'request'));
  assert.equal(target.request.relation.id,id);assert.equal(target.request.relation.name,'Target');
  assert.notEqual(target.request.relation.steps[0].id,flow.request.relation.steps[0].id);
});

test('individual collection export/import preserves nested internal relation references and external references',()=>{
  const {collection,flow}=fixture();
  const external=newStep({collectionId:'external-collection',itemId:'external-request'});flow.request.relation.steps.push(external);
  const output=exportCollection(collection);assert.equal(JSON.stringify(output).includes('_mpId'),false);
  assert.equal(output.item[0].item[1].request.url,undefined);assert.ok(output._minipostRequestRefs);
  const imported=importPostman(JSON.stringify(output)).collections[0],importedFlow=imported.item[0].item[1];
  const [first,last]=importedFlow.request.relation.steps[0].steps[0].steps;
  assert.equal(first.collectionId,imported._mpId);assert.equal(first.itemId,imported.item[0].item[0]._mpId);
  assert.equal(last.itemId,importedFlow._mpId);assert.equal(first.onTrue,last.id);
  assert.notEqual(importedFlow.request.relation.id,flow.request.relation.id);
  assert.equal(importedFlow.request.relation.steps[1].collectionId,external.collectionId);
  assert.equal(importedFlow.request.relation.steps[1].itemId,external.itemId);
  assert.equal(importedFlow.request.relation.environmentId,flow.request.relation.environmentId);
  const another=importPostman(output).collections[0];assert.notEqual(another.item[0].item[1].request.relation.id,importedFlow.request.relation.id);
  output.item[0].item[1].request.relation.steps[0].steps={};assert.throws(()=>importPostman(output),/形式/);
});

test('workspace merge remaps canonical relations, historical snapshots, revisions and nested run logs consistently',()=>{
  const {workspace:source,flow,collection,script}=fixture();
  const run={id:'run',relationId:flow.request.relation.id,entries:[{stepId:flow.request.relation.steps[0].id,loops:[{stepId:flow.request.relation.steps[0].id}],
    relationRun:{id:'nested-run',relationId:flow.request.relation.id,entries:[{stepId:flow.request.relation.steps[0].steps[0].steps[0].id}]}}]};
  source.relationRuns=[run];source.history=[{id:'history',tab:{id:'old-editor',collectionId:collection._mpId,itemId:flow._mpId,name:flow.name,request:clone(flow.request)},relation_run:clone(run)}];
  const snapshot={name:flow.name,request:clone(flow.request)};
  source.revisions['request:collection:flow']=[{id:'revision',value:clone(snapshot)}];
  source.settingHistory={'request:collection:flow':[{before:clone(snapshot),after:clone(snapshot)}]};
  const before=clone(source),destination=fixture().workspace;
  mergeWorkspace(destination,readWorkspaceBundle(exportWorkspace(source)).workspace);
  const imported=destination.collections[1],owner=imported.item[0].item[1],definition=owner.request.relation;
  const [first,last]=definition.steps[0].steps[0].steps;
  assert.equal(first.collectionId,imported._mpId);assert.equal(first.itemId,imported.item[0].item[0]._mpId);assert.equal(last.itemId,owner._mpId);
  assert.equal(first.onTrue,last.id);assert.notEqual(definition.id,flow.request.relation.id);
  assert.equal(definition.environmentId,destination.environments[1].id);
  assert.equal(definition.steps[0].steps[0].elseSteps[0].scriptId,destination.scripts.find(value=>value.id!==script.id&&value.id!==destination.scripts[0].id).id);
  const key=`request:${imported._mpId}:${owner._mpId}`;
  for(const restored of [destination.history[0].tab.request,destination.revisions[key][0].value.request,
    destination.settingHistory[key][0].before.request,destination.settingHistory[key][0].after.request])assert.deepEqual(restored.relation,definition);
  for(const importedRun of [destination.relationRuns[0],destination.history[0].relation_run]){
    assert.equal(importedRun.relationId,definition.id);assert.equal(importedRun.entries[0].stepId,definition.steps[0].id);
    assert.equal(importedRun.entries[0].loops[0].stepId,definition.steps[0].id);
    assert.equal(importedRun.entries[0].relationRun.relationId,definition.id);assert.equal(importedRun.entries[0].relationRun.entries[0].stepId,first.id);
  }
  assert.deepEqual(source,before);
});

test('moving a request repairs nested relation references in stored, open, history and revision values',()=>{
  const {workspace,flow,target}=fixture(),session=new RequestSession(workspace,blank),open=session.openSaved(workspace.collections[0],flow);
  workspace.history=[{id:'history',tab:{id:'old',name:flow.name,request:clone(flow.request)}}];
  workspace.revisions['request:collection:flow']=[{value:{name:flow.name,request:clone(flow.request)}}];
  workspace.collections.push({_mpId:'destination',info:{name:'Destination'},item:[]});
  moveCollectionItem(workspace,{collectionId:'collection',itemId:target._mpId,targetCollectionId:'destination'},{editors:session.all()});
  for(const request of [flow.request,open.request,workspace.history[0].tab.request,workspace.revisions['request:collection:flow'][0].value.request])
    assert.equal(request.relation.steps[0].steps[0].steps[0].collectionId,'destination');
});

test('malformed canonical definitions and restorable snapshots are rejected before merging',()=>{
  for(const corrupt of [
    ws=>{ws.collections[0].item[0].item[1].request.relation.steps[0].steps={};},
    ws=>{ws.collections[0].item[0].item[1].request.type='unknown';},
    ws=>{ws.tabs.push({id:'draft',name:'Broken',request:{type:'relation',relation:{id:'broken',name:'Broken',steps:[{id:'x',type:'if',steps:[],elseSteps:{}}]}}});},
    ws=>{ws.tabs.push({id:'draft',name:'Duplicate',request:clone(ws.collections[0].item[0].item[1].request)});},
    ws=>{ws.revisions['request:collection:flow']=[{value:{name:'Broken',request:{type:'relation',relation:{id:'broken',name:'Broken',steps:{}}}}}];}
  ]){
    const source=fixture().workspace;corrupt(source);assert.throws(()=>readWorkspaceBundle(exportWorkspace(source)));
    const into=fixture().workspace,before=clone(into);
    assert.throws(()=>mergeWorkspace(into,source));assert.deepEqual(into,before);
  }
});
