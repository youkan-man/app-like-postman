import test from 'node:test';
import assert from 'node:assert/strict';
import {clone,newRequest} from '../static/core.mjs';
import {newRelationRequest,relationRequestEntries} from '../static/relation-requests.mjs';
import {newStep,newRelationStep} from '../static/relations.mjs';
import {executeRequest} from '../static/execution.mjs';
import {createScriptRelationRunner} from '../static/script-relations.mjs';
import {makeScriptContext,createScriptHost} from '../static/script-host.mjs';
import {executeScript} from '../static/script-worker.mjs';
import {applyScriptWrites,newScript} from '../static/scripts.mjs';
import {PrimaryVariables,responseMetadata} from '../static/runtime.mjs';
import {createWorkspaceModel} from '../static/workspace-api.mjs';
import {RequestSession} from '../static/request-session.mjs';
import {newRibbonState,newRibbon,newRibbonGroup,newRibbonControl,cloneRibbonState} from '../static/ribbons.mjs';

const target=itemId=>newStep({collectionId:'collection',itemId});
function fixture(){
  const leaf={_mpId:'leaf',name:'HTTP',request:{...newRequest(),url:'{{baseUrl}}/echo'},settings:{timeout_ms:4321}};
  const child={_mpId:'child',name:'Child',request:newRelationRequest('Child',{id:'child-flow',steps:[target('leaf')]}),settings:{}};
  const parent={_mpId:'parent',name:'Parent',request:newRelationRequest('Parent',{id:'parent-flow',steps:[target('child')]}),settings:{}};
  const workspace={version:2,collections:[{_mpId:'collection',info:{name:'Collection'},variable:[{key:'collectionValue',value:'inherited'}],item:[leaf,child,parent]}],
    tabs:[],globals:[],environments:[{id:'default',name:'Default',values:[{key:'baseUrl',value:'https://default.invalid'}]},
      {id:'selected',name:'Selected',values:[{key:'baseUrl',value:'https://selected.invalid'}]}],environmentId:'default',
    scripts:[],relations:[],relationRuns:[],history:[],scriptData:{},scriptBindings:{}};
  return {workspace,leaf,child,parent,primary:new PrimaryVariables()};
}
const tabFor=item=>({id:'editor-'+item._mpId,collectionId:'collection',itemId:item._mpId,name:item.name,request:item.request,settings:item.settings});
function transport(){const calls=[];return {calls,send:async(payload,signal)=>{assert.equal(signal?.aborted||false,false);calls.push(payload);return {status:200,headers:[],body:'{"ok":true}',elapsed_ms:3};}};}
function scriptRun(state,source,options={}){
  const network=transport(),responses=[];
  const runner=createScriptRelationRunner({script:executeScript,send:network.send,onResponse:(tab,result)=>responses.push({tab,result})});
  const host=createScriptHost({...state,send:network.send,runRelation:runner});
  return {...network,responses,task:executeScript(source,makeScriptContext(state.workspace,state.primary),{onCall:host,...options})};
}

test('relation requests use unified execution, nest, retain child settings, and return flow results without an HTTP envelope',async()=>{
  const state=fixture(),network=transport(),responses=[],progress=[];state.parent.request.relation.repeat=2;
  const result=await executeRequest({...state,tab:tabFor(state.parent),script:executeScript,send:network.send,
    onResponse:(tab,result)=>responses.push({tab,result}),onRelationProgress:run=>progress.push(clone(run))});
  assert.equal(result.type,'relation');assert.equal(result.status,undefined);assert.equal(result.body,undefined);
  assert.equal(result.run.status,'succeeded');assert.equal(result.run.entries.length,2);assert.equal(network.calls.length,2);
  assert.equal(network.calls[0].timeout_ms,4321);
  assert.equal(result.run.entries[0].httpStatus,undefined);assert.equal(result.run.entries[0].relationRun.entries[0].httpStatus,200);
  assert.equal(responses.length,4);assert.equal(state.workspace.relationRuns.length,3);
  assert.ok(progress.some(run=>run.current));assert.equal(progress.at(-1).status,'succeeded');
  assert.deepEqual(responseMetadata(result),result);
});

test('relation environments inherit into nested requests and explicit script options override the target definition',async()=>{
  const state=fixture();state.parent.request.relation.environmentId='selected';
  const network=transport(),first=await executeRequest({...state,tab:tabFor(state.parent),send:network.send});
  assert.equal(first.run.environmentId,'selected');assert.equal(first.run.environmentName,'Selected');
  assert.equal(first.run.entries[0].relationRun.environmentId,'selected');
  assert.equal(network.calls[0].url,'https://selected.invalid/echo');assert.equal(state.workspace.environmentId,'default');
  state.child.request.relation.environmentId='default';
  const overridden=await executeRequest({...state,tab:tabFor(state.parent),send:network.send});
  assert.equal(overridden.run.environmentId,'selected');assert.equal(overridden.run.entries[0].relationRun.environmentId,'default');
  assert.equal(network.calls[1].url,'https://default.invalid/echo');
  delete state.child.request.relation.environmentId;
  const call=scriptRun(state,"const result=await minipost.requests.send('collection:parent',{environmentId:'default'});return {type:result.type,status:result.run.status};");
  assert.deepEqual((await call.task).result,{type:'relation',status:'succeeded'});
  assert.equal(call.calls[0].url,'https://default.invalid/echo');
});

test('direct, transitive, and script-mediated recursion stops before any HTTP send',async()=>{
  for(const kind of ['direct','transitive','script']){
    const state=fixture(),network=transport();
    if(kind==='direct')state.parent.request.relation.steps=[target('parent')];
    if(kind==='transitive')state.child.request.relation.steps=[target('parent')];
    if(kind==='script'){
      const saved={...newScript('Recursive'),id:'recursive',source:"await pm.requests.send('collection:parent');"};
      state.workspace.scripts=[saved];state.parent.request.relation.steps=[{...newRelationStep('script'),scriptId:saved.id}];
    }
    const result=await executeRequest({...state,tab:tabFor(state.parent),script:executeScript,send:network.send});
    assert.equal(result.run.status,'failed',kind);assert.match(result.run.error,/再帰/,kind);assert.equal(network.calls.length,0,kind);
  }
  const state=fixture();await assert.rejects(executeRequest({...state,tab:tabFor(state.parent),relationAncestors:Array.from({length:16},(_,i)=>`ancestor-${i}`)}),/深すぎ/);
});

test('cancelling a nested relation wait stops the unified request and leaves a cancelled execution record',async()=>{
  const state=fixture(),controller=new AbortController(),network=transport();
  state.child.request.relation.steps=[{...newRelationStep('wait'),delayMs:60000}];
  const task=executeRequest({...state,tab:tabFor(state.parent),signal:controller.signal,send:network.send,
    onRelationProgress:run=>{if(run.current?.status==='running')setTimeout(()=>controller.abort(),0);}});
  const result=await task;
  assert.equal(result.type,'relation');assert.equal(result.run.status,'cancelled');assert.equal(network.calls.length,0);
  assert.equal(result.run.entries[0].relationRun.status,'cancelled');
  assert.ok(state.workspace.relationRuns.some(run=>run.status==='cancelled'));
});

test('control blocks before the first request inherit the owning collection variables',async()=>{
  const state=fixture(),network=transport();
  state.parent.request.relation.steps=[{...newRelationStep('if'),condition:{enabled:true,source:'variables',path:'collectionValue',operator:'eq',value:'inherited'},steps:[target('leaf')],elseSteps:[]}];
  const result=await executeRequest({...state,tab:tabFor(state.parent),send:network.send});
  assert.equal(result.run.status,'succeeded');assert.equal(network.calls.length,1);
});

test('requests.send merges relation edits only on success and preserves the relations.run compatibility result',async()=>{
  const state=fixture(),saved={...newScript('Change'),id:'change',source:"store.set('count',(store.get('count')||0)+1); vars.set('fromFlow',vars.get('collectionValue'));"};
  state.workspace.scripts=[saved];state.child.request.relation.steps=[{...newRelationStep('script'),scriptId:saved.id}];
  const original=clone(state.workspace),call=scriptRun(state,"const sent=await minipost.requests.send('Parent');const legacy=await pm.relations.run('parent-flow');return {type:sent.type,status:legacy.status,count:store.get('count'),inherited:vars.get('fromFlow')};"),output=await call.task;
  assert.deepEqual(output.result,{type:'relation',status:'succeeded',count:2,inherited:'inherited'});assert.deepEqual(state.workspace,original);
  applyScriptWrites(state.workspace,state.primary,state.workspace.environments[0],output);
  assert.equal(state.workspace.scriptData.count,2);assert.equal(state.primary.get('fromFlow'),'inherited');
  state.workspace.scripts[0].source="store.set('failed',true);vars.set('failed','bad');throw new Error('failed child');";
  const failedBefore=clone(state.workspace),failedPrimary=clone(state.primary.rows);
  const failed=await scriptRun(state,"try{await minipost.requests.send('Parent');}catch(error){return error.message;}").task;
  assert.match(failed.result,/failed child/);applyScriptWrites(state.workspace,state.primary,state.workspace.environments[0],failed);
  assert.deepEqual(state.workspace,failedBefore);assert.deepEqual(state.primary.rows,failedPrimary);
});

test('relation script steps use the targeted request ribbon even when invoked from another owner',async()=>{
  const state=fixture(),scope=newRibbonState(),ribbon=newRibbon('Tools','tools'),group=newRibbonGroup('Controls'),control=newRibbonControl('number','Count');
  control.key='count';control.value=0;group.controls.push(control);ribbon.groups.push(group);scope.ribbons.push(ribbon);scope.activeRibbonId=ribbon.id;
  state.parent.ribbonState=scope;state.child.ribbonState=cloneRibbonState(scope);
  const saved={...newScript('Increment'),id:'increment',source:"ribbon.set('count',ribbon.get('count')+1);return vars.get('collectionValue');"};
  state.workspace.scripts=[saved];state.child.request.relation.steps=[{...newRelationStep('script'),scriptId:saved.id,resultVariable:'scopeValue'}];
  const network=transport(),runner=createScriptRelationRunner({script:executeScript,send:network.send});
  const host=createScriptHost({...state,runRelation:runner});
  const output=await executeScript("await minipost.requests.send('collection:child');",makeScriptContext(state.workspace,state.primary,{tab:tabFor(state.parent)}),{onCall:host});
  applyScriptWrites(state.workspace,state.primary,state.workspace.environments[0],output);
  assert.equal(state.parent.ribbonState.ribbons[0].groups[0].controls[0].value,0);
  assert.equal(state.child.ribbonState.ribbons[0].groups[0].controls[0].value,1);
  assert.equal(state.primary.get('scopeValue'),'inherited');
});

test('relation CRUD edits canonical saved requests with old ID aliases and symmetric request get/set',()=>{
  const state=fixture(),model=createWorkspaceModel(state.workspace),api=model.api;
  assert.equal(api.relations.get('collection:parent').id,'parent-flow');
  api.relations.set('parent-flow','repeat',3);assert.equal(api.requests.get('collection:parent','request.relation.repeat'),3);
  api.requests.edit('collection:parent').set('relation.intervalMs',5);assert.equal(api.relations.get('Parent','intervalMs'),5);
  api.relations.update('parent-flow',{name:'Renamed'});assert.equal(api.requests.get('collection:parent','name'),'Renamed');
  api.requests.edit('collection:parent').set('relation.name','Edited name');assert.equal(api.requests.get('collection:parent','name'),'Edited name');
  api.requests.set('collection:parent','request.relation.name','Path name');assert.equal(api.requests.get('collection:parent','name'),'Path name');
  api.requests.update('collection:parent',{request:{relation:{name:'Patch name'}}});assert.equal(api.relations.get('parent-flow','name'),'Patch name');
  assert.throws(()=>api.requests.update('collection:parent',{request:{relation:{id:'another-id'}}}),/変更できません/);
  const created=api.relations.create({name:'Created',parent:'collection',steps:[{id:'wait',type:'wait',delayMs:0}]});
  assert.ok(api.requests.list().some(entry=>entry.request.relation?.id===created.id));assert.deepEqual(model.state.relations,[]);
  const draft=api.drafts.create({name:'Scratch',request:{type:'relation'}});
  assert.equal(api.relations.get(draft.id).name,'Scratch');api.relations.set(draft.id,'name','Scratch renamed');
  assert.equal(api.requests.get(draft.id,'name'),'Scratch renamed');
  api.requests.set('collection:leaf','request.type','relation');
  assert.equal(api.requests.get('collection:leaf','request.type'),'relation');assert.ok(api.relations.get('collection:leaf').id);
  api.relations.delete(created.id);assert.ok(!api.requests.list().some(entry=>entry.request.relation?.id===created.id));
  assert.equal(relationRequestEntries(model.state).length,4);
});

test('cloning relation requests rekeys nested steps and moving a target repairs canonical relation references',()=>{
  const state=fixture(),model=createWorkspaceModel(state.workspace),api=model.api;
  const first=target('leaf'),second=target('parent');first.onTrue=second.id;
  api.relations.set('parent-flow','steps',[first,second]);
  const copied=api.requests.clone('collection:parent'),original=api.relations.get('parent-flow'),definition=copied.request.relation;
  assert.notEqual(definition.id,original.id);assert.notEqual(definition.steps[0].id,first.id);assert.equal(definition.steps[0].onTrue,definition.steps[1].id);
  assert.equal(definition.steps[1].itemId,copied.itemId);assert.equal(definition.steps[1].collectionId,copied.collectionId);
  const destination=api.collections.create({name:'Destination'});api.requests.move('collection:leaf',destination.id);
  assert.equal(api.relations.get('parent-flow').steps[0].collectionId,destination.id);assert.equal(api.relations.get('child-flow').steps[0].collectionId,destination.id);
});

test('a before-script type change executes the relation snapshot without sending the former HTTP request',async()=>{
  const state=fixture(),network=transport(),source={_mpId:'convert',name:'Converted',request:{...newRequest(),url:'https://must-not-send.invalid',_minipost:{enabled:true,before:`
    request.set('type','relation');
    request.set('relation.steps',${JSON.stringify([target('leaf')])});
  `}},settings:{}};
  state.workspace.collections[0].item.push(source);
  const result=await executeRequest({...state,tab:tabFor(source),script:executeScript,send:network.send});
  assert.equal(result.type,'relation');assert.equal(result.run.status,'succeeded');
  assert.deepEqual(network.calls.map(payload=>payload.url),['https://default.invalid/echo']);
  assert.equal(source.request.type,undefined);
});

test('saved relation and HTTP drafts keep collection inheritance through both migrated and legacy draft targets',async()=>{
  for(const kind of ['relation','http'])for(const migrate of [true,false]){
    const state=fixture(),network=transport(),seen=[];
    const source="store.set('fromPromoted',vars.get('collectionValue')??null);";
    state.workspace.scripts.push({...newScript('Read owner'),id:'read-owner',source});
    const request=kind==='relation'?newRelationRequest('Promoted',{id:'promoted-flow',steps:[{...newRelationStep('script'),scriptId:'read-owner'}]}):
      {...newRequest(),url:'https://example.invalid/{{collectionValue}}',_minipost:{enabled:true,before:source}};
    const draft={id:'draft-target',name:'Promoted',request,settings:{}};
    state.workspace.tabs.push(draft);state.parent.request.relation.steps=[newStep({draftId:draft.id})];
    const session=new RequestSession(state.workspace,()=>({id:'blank',name:'Blank',request:newRequest(),settings:{}}));
    const saved={_mpId:'promoted',name:draft.name,request:clone(draft.request),settings:{}};
    state.workspace.collections[0].item.push(saved);Object.assign(draft,{collectionId:'collection',itemId:saved._mpId});
    if(migrate){session.markSaved(draft);assert.equal(state.parent.request.relation.steps[0].draftId,undefined);}
    else{
      // Old saved editor caches may differ from the authoritative collection item.
      if(kind==='relation')draft.request.relation.steps=[{...newRelationStep('wait'),delayMs:0}];
      else draft.request.url='https://stale-cache.invalid';
      assert.equal(state.parent.request.relation.steps[0].draftId,draft.id);
    }
    const result=await executeRequest({...state,tab:tabFor(state.parent),send:network.send,script:executeScript,onResponse:tab=>seen.push(tab)});
    assert.equal(result.run.status,'succeeded',`${kind}/${migrate}`);assert.equal(state.workspace.scriptData.fromPromoted,'inherited',`${kind}/${migrate}`);
    assert.equal(seen[0].collectionId,'collection');assert.equal(seen[0].itemId,'promoted');
    if(kind==='http')assert.equal(network.calls[0].url,'https://example.invalid/inherited');
  }
});

test('converted relation runs capture the actual environment and its original name for progress and history',async()=>{
  const state=fixture(),network=transport(),progress=[];
  state.workspace.scripts.push({...newScript('Rename environment'),id:'rename-env',source:"minipost.environments.update('selected',{name:'Changed during execution'});"});
  const steps=[target('leaf'),{...newRelationStep('script'),scriptId:'rename-env'}];
  const original={_mpId:'convert-env',name:'Convert env',request:{...newRequest(),url:'https://must-not-send.invalid',_minipost:{enabled:true,before:`
    request.set('type','relation');request.set('relation.environmentId','selected');request.set('relation.steps',${JSON.stringify(steps)});
  `}},settings:{}};
  state.workspace.collections[0].item.push(original);
  const result=await executeRequest({...state,tab:tabFor(original),script:executeScript,send:network.send,onRelationProgress:run=>progress.push(clone(run))});
  assert.equal(result.run.status,'succeeded');assert.equal(network.calls[0].url,'https://selected.invalid/echo');
  assert.equal(result.run.environmentId,'selected');assert.equal(result.run.environmentName,'Selected');
  assert.equal(state.workspace.environments[1].name,'Changed during execution');
  assert.ok(progress.length);assert.ok(progress.every(run=>run.environmentId==='selected'&&run.environmentName==='Selected'));
  const stored=state.workspace.relationRuns.find(run=>run.id===result.run.id);
  assert.equal(stored.environmentId,'selected');assert.equal(stored.environmentName,'Selected');
  assert.equal(original.request.type,undefined);
});
