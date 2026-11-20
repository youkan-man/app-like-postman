import test from 'node:test';
import assert from 'node:assert/strict';
import {clone,newRequest} from '../static/core.mjs';
import {PrimaryVariables} from '../static/runtime.mjs';
import {newRelation,newStep,newRelationStep} from '../static/relations.mjs';
import {newScript,applyScriptWrites} from '../static/scripts.mjs';
import {executeScript} from '../static/script-worker.mjs';
import {makeScriptContext,createScriptHost} from '../static/script-host.mjs';
import {createScriptRelationRunner} from '../static/script-relations.mjs';

function fixture() {
  const child={...newScript('Accumulate'),id:'child',source:"store.set('count',(store.get('count')||0)+1); vars.set('lastItem',vars.get('item')); return store.get('count');"};
  const request={_mpId:'request',name:'Echo',request:{...newRequest(),url:'{{baseUrl}}/echo?n={{index}}'},settings:{}};
  const loop={...newRelationStep('forEach'),id:'loop',value:'[10,20]',steps:[
    {...newStep({collectionId:'collection',itemId:'request'}),id:'send'},
    {...newRelationStep('script'),id:'child-step',scriptId:child.id,resultVariable:'lastResult'}]};
  const relation={...newRelation('Flow'),id:'flow',steps:[loop]};
  const workspace={version:2,collections:[{_mpId:'collection',info:{name:'Collection'},item:[request]}],
    tabs:[],globals:[],environments:[{id:'env',name:'Environment',values:[{key:'baseUrl',value:'https://before.invalid'}]}],
    environmentId:'env',scripts:[child],relations:[relation],relationRuns:[],history:[],scriptData:{},scriptBindings:{}};
  return {workspace,primary:new PrimaryVariables(),relation,child};
}

function execute(state,source,options={}) {
  const requests=[],responses=[];
  const send=async payload=>{requests.push(payload);return {status:200,headers:[],body:JSON.stringify({path:payload.url}),body_encoding:'utf-8',content_type:'application/json'};};
  const runner=createScriptRelationRunner({script:executeScript,send,onResponse:(tab,response)=>responses.push({tab,response})});
  const host=createScriptHost({...state,send,runRelation:runner});
  return {requests,responses,task:executeScript(source,makeScriptContext(state.workspace,state.primary),{onCall:host,...options})};
}

test('script-invoked relations share pending models and variables, restore loop bindings and commit once',async()=>{
  const state=fixture(),before=clone(state.workspace);
  state.primary.apply([{key:'item',value:'outer'},{key:'index',value:'original'}]);
  const run=execute(state,"minipost.environments.variables('env').set('baseUrl','https://pending.invalid'); const result=await minipost.relations.run('flow'); return {status:result.status,count:store.get('count'),item:vars.get('item'),index:vars.get('index'),last:vars.get('lastResult')};");
  const output=await run.task;
  assert.deepEqual(output.result,{status:'succeeded',count:2,item:'outer',index:'original',last:'2'});
  assert.deepEqual(run.requests.map(value=>value.url),['https://pending.invalid/echo','https://pending.invalid/echo']);
  assert.deepEqual(run.requests.map(value=>value.query),[[{key:'n',value:'0'}],[{key:'n',value:'1'}]]);
  assert.equal(run.responses.length,2);
  assert.deepEqual(state.workspace,before);assert.equal(state.primary.get('lastResult'),undefined);
  assert.equal(applyScriptWrites(state.workspace,state.primary,state.workspace.environments[0],output),true);
  assert.equal(state.workspace.scriptData.count,2);assert.equal(state.workspace.relationRuns.length,1);
  assert.equal(state.workspace.environments[0].values[0].value,'https://pending.invalid');
  assert.equal(state.primary.get('item'),'outer');assert.equal(state.primary.get('lastItem'),'20');
});

test('failed relation child prevents outer model, store and primary writes from escaping',async()=>{
  const state=fixture(),before=clone(state.workspace);
  state.child.source="minipost.collections.update('collection',{name:'Pending'}); vars.set('failed','x'); store.set('failed',true); throw new Error('child failure');";
  const original=clone(state.workspace);
  const run=execute(state,"store.set('parent',true); await minipost.relations.run('flow');");
  await assert.rejects(run.task,/child failure/);
  assert.deepEqual(state.workspace,original);assert.deepEqual(state.primary.snapshot(),{});
  assert.equal(run.requests.length,1);assert.equal(run.responses.length,1);
  assert.equal(before.scriptData.parent,undefined);
});

test('stopping an awaited relation stops its wait and discards all pending changes',async()=>{
  const state=fixture();state.relation.steps=[{...newRelationStep('wait'),delayMs:60000}];
  const original=clone(state.workspace),abort=new AbortController();
  const run=execute(state,"minipost.collections.update('collection',{name:'Cancelled'}); await minipost.relations.run('flow');",{signal:abort.signal});
  setTimeout(()=>abort.abort(),10);
  await assert.rejects(run.task,error=>error.name==='AbortError');
  assert.deepEqual(state.workspace,original);assert.equal(run.requests.length,0);
});

test('recursive relation invocation is rejected before a second nested relation can send',async()=>{
  const state=fixture();state.child.source="await minipost.relations.run('flow');";
  state.relation.steps=[{...newRelationStep('script'),scriptId:'child'}];
  const run=execute(state,"await minipost.relations.run('flow');");
  await assert.rejects(run.task,/再帰/);assert.equal(run.requests.length,0);
  const runner=createScriptRelationRunner({script:executeScript});
  await assert.rejects(runner(state.relation,{workspace:clone(state.workspace),primary:{},environmentId:'env',ancestorRelationIds:['flow']}),/再帰/);
});

test('request hooks inside a script relation use isolated executor and the same pending transaction',async()=>{
  const state=fixture();
  const request=state.workspace.collections[0].item[0];
  request.request._minipost={enabled:true,before:"store.set('hookCount',(store.get('hookCount')||0)+1); minipost.globals.set('fromHook','yes');",after:"store.set('lastStatus',response.status);"};
  const run=execute(state,"await minipost.relations.run('flow'); return {hooks:store.get('hookCount'),status:store.get('lastStatus'),global:minipost.globals.get('fromHook')};");
  const output=await run.task;
  assert.deepEqual(output.result,{hooks:2,status:200,global:'yes'});
  assert.deepEqual(state.workspace.scriptData,{});assert.deepEqual(state.workspace.globals,[]);
  applyScriptWrites(state.workspace,state.primary,state.workspace.environments[0],output);
  assert.equal(state.workspace.scriptData.hookCount,2);assert.equal(state.workspace.globals[0].value,'yes');
});

test('script-invoked relation clear carries disabled primary rows through child execution and final commit',async()=>{
  const state=fixture();state.primary.rows=[{key:'visible',value:'old'},{key:'hidden',value:'old',disabled:true},{key:'',value:''}];
  state.child.source=`store.set('removed',vars.clear());vars.set('remaining','child');`;
  state.relation.steps=[{...newRelationStep('script'),scriptId:'child'}];
  const run=execute(state,`await minipost.relations.run('flow');return {removed:store.get('removed'),remaining:vars.get('remaining')};`),output=await run.task;
  assert.deepEqual(output.result,{removed:3,remaining:'child'});assert.equal(state.primary.rows.length,3);
  applyScriptWrites(state.workspace,state.primary,state.workspace.environments[0],output);assert.deepEqual(state.primary.snapshot(),{remaining:'child'});assert.equal(state.primary.rows.length,1);
});

test('temporary loop bindings restore duplicate and disabled rows with their metadata intact',async()=>{
  const state=fixture(),original=[{key:'item',value:'first',disabled:true,description:'first item'},{key:'index',value:'old index',enabled:false,description:'index'},{key:'item',value:'last',enabled:false,description:'last item'}];
  state.primary.rows=clone(original);
  const output=await execute(state,`await minipost.relations.run('flow');return {item:vars.has('item'),index:vars.has('index')};`).task;
  assert.deepEqual(output.result,{item:false,index:false});applyScriptWrites(state.workspace,state.primary,state.workspace.environments[0],output);
  assert.deepEqual(state.primary.rows.filter(row=>row.key==='item'||row.key==='index'),original);
  assert.equal(state.primary.get('lastItem'),'20');
});
