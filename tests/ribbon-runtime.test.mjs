import test from 'node:test';
import assert from 'node:assert/strict';
import {executeScript} from '../static/script-worker.mjs';
import {makeScriptContext,createScriptHost,scriptRibbonSnapshot} from '../static/script-host.mjs';
import {applyScriptWrites} from '../static/scripts.mjs';
import {normalizeRibbonValue} from '../static/ribbons.mjs';
import {PrimaryVariables} from '../static/runtime.mjs';
import {executeRequest} from '../static/execution.mjs';
import {historyEntry} from '../static/sent-history.mjs';

const control = (id,key,type,value,extra={}) => ({id,key,label:key,type,value,options:[],visible:true,enabled:true,actions:[],...extra});
const definition = (id,key,controls) => ({id,key,name:key,groups:[{id:`${id}-group`,name:'Controls',controls}]});
function workspace() {
  return {version:2,collections:[],environments:[{id:'environment',name:'Development',values:[]}],environmentId:'environment',globals:[],history:[],
    scripts:[],scriptBindings:{},scriptData:{keep:'unchanged'},activeId:'request-a',tabs:[{id:'request-a',name:'Request A',request:{method:'GET',url:'https://example.test/a',header:[]},settings:{},ribbonState:{id:'scope-a',ribbonBindings:{},activeRibbonId:'main-ribbon',ribbons:[
      definition('main-ribbon','main',[
        control('count-id','count','number',2),control('name-id','name','text','before'),control('toggle-id','ready','toggle',false),
        control('choice-id','mode','select','test',{options:[{value:'test',label:'Test'},{value:'live',label:'Live'}]}),
        control('display-id','status','display',{ok:false}),control('button-id','run','button',null)
      ]),definition('other-ribbon','other',[control('other-count','count','number',40),control('unique-id','unique','text','other')])
    ]}}]};
}
const scope = (ws,owner=ws.tabs[0]) => owner.ribbonState;
const at = (ws,id,owner=ws.tabs[0]) => scope(ws,owner).ribbons.flatMap(r=>r.groups.flatMap(g=>g.controls)).find(c=>c.id===id);
function addRequest(ws) {
  const owner=structuredClone(ws.tabs[0]);
  owner.id='request-b';owner.name='Request B';owner.request={method:'GET',url:'https://example.test/b',header:[]};owner.ribbonState.id='scope-b';
  ws.tabs.push(owner);at(ws,'count-id',owner).value=200;
  return owner;
}
const primary = () => new PrimaryVariables();
const context = (ws,p=primary(),options={}) => makeScriptContext(ws,p,{ribbonOwner:ws.tabs[0],...options});
const run = (source,ws,p=primary(),options={}) => executeScript(source,context(ws,p),options);
const commit = (ws,p,out) => applyScriptWrites(ws,p,ws.environments[0],out);

// These exercises use the public API, the host's transaction boundary, and real
// request hooks; they deliberately avoid depending on private implementation helpers.
test('standalone ribbon APIs retain the selected owner without providing an HTTP request context', async()=>{
  const ws=workspace(),p=primary();
  assert.equal(context(ws,p).request,null);
  const out=await run(`
    const alias = ribbon === minipost.ribbon;
    ribbon.set('count', '7');
    ribbon.set('name', false);
    ribbon.show('status', false);
    ribbon.enable('run', false);
    const current = {active:ribbon.active(), values:ribbon.values(), controls:ribbon.controls()};
    const activated = minipost.ribbon.activate('other');
    return {alias,current,activated,other:ribbon.get('count'),all:ribbon.list()};
  `,ws,p);
  assert.equal(out.result.alias,true);
  assert.equal(out.result.current.values.count,7);
  assert.equal(out.result.current.values.name,'false');
  assert.equal(out.result.current.controls.find(c=>c.id==='button-id').enabled,false);
  assert.equal(out.result.current.controls.find(c=>c.id==='display-id').visible,false);
  assert.deepEqual(out.result.current.active,{id:'main-ribbon',key:'main',name:'main'});
  assert.deepEqual(out.result.activated,{id:'other-ribbon',key:'other',name:'other'});
  assert.equal(out.result.other,40);
  assert.equal(out.result.all.length,2);
  assert.equal(at(ws,'count-id').value,2);
  assert.equal(commit(ws,p,out),true);
  assert.equal(at(ws,'count-id').value,7);
  assert.equal(at(ws,'name-id').value,'false');
  assert.equal(at(ws,'display-id').visible,false);
  assert.equal(at(ws,'button-id').enabled,false);
  assert.equal(scope(ws).activeRibbonId,'other-ribbon');
});

test('nested scripts see and update one ribbon transaction with their own literal bindings', async()=>{
  const ws=workspace();scope(ws).ribbonBindings={parent:{controls:{count:'count-id'},ribbons:{chosen:'main-ribbon'}},child:{controls:{count:'other-count'},ribbons:{chosen:'other-ribbon'}}};
  ws.scripts=[{id:'parent',bindingId:'parent',name:'Parent'},
    {id:'child',bindingId:'child',name:'Child',source:`ribbon.set('count', ribbon.get('count')+1); ribbon.set('main.count', ribbon.get('main.count')+3); return ribbon.get('count');`}];
  const out=await executeScript(`ribbon.set('count',10); const child=await scripts.run('child'); return {child,parent:ribbon.get('count'),childValue:ribbon.get('other.count')};`,context(ws,primary(),{scriptId:'parent'}));
  assert.deepEqual(out.result,{child:41,parent:13,childValue:41});
  assert.equal(out.ribbonWrites.filter(w=>w.id==='count-id').length,1);
  assert.equal(out.ribbonWrites.find(w=>w.id==='count-id').expected,2);
  commit(ws,primary(),out);assert.equal(at(ws,'count-id').value,13);assert.equal(at(ws,'other-count').value,41);
});

test('ribbon controls and JSON values are copies and cannot mutate staged state without set', async()=>{
  const ws=workspace();
  const out=await run(`
    const status = ribbon.get('status');status.ok=true;
    const controls = ribbon.controls();controls[0].value=500;
    const values = ribbon.values();values.count=900;
    const set = ribbon.set('status',{nested:[1,false,null]});set.nested.push(4);
    return {status:ribbon.get('status'),count:ribbon.get('count')};
  `,ws);
  assert.deepEqual(out.result,{status:{nested:[1,false,null]},count:2});
  commit(ws,primary(),out);assert.deepEqual(at(ws,'display-id').value,{nested:[1,false,null]});
});

test('no active ribbon is distinct from the first ribbon and ambiguous bare references error', async()=>{
  const ws=workspace();scope(ws).activeRibbonId='';
  const out=await run(`return {active:ribbon.active(),values:ribbon.values(),controls:ribbon.controls(),unique:ribbon.get('unique'),count:ribbon.get('main.count')};`,ws);
  assert.deepEqual(out.result,{active:null,values:{},controls:[],unique:'other',count:2});
  await assert.rejects(run(`return ribbon.get('count');`,ws),/複数/);
  await assert.rejects(run(`return ribbon.get('missing');`,ws),/見つかりません/);
  await assert.rejects(run(`ribbon.activate('missing');`,ws),/見つかりません/);
});

test('qualified references and stable IDs survive label changes, and duplicate names require a key or ID', async()=>{
  const ws=workspace();scope(ws).ribbons[0].name='same';scope(ws).ribbons[1].name='same';at(ws,'count-id').label='renamed';
  assert.equal((await run(`return ribbon.get('count-id');`,ws)).result,2);
  assert.equal((await run(`return ribbon.get('other.count');`,ws)).result,40);
  await assert.rejects(run(`ribbon.activate('same');`,ws),/複数/);
  assert.equal((await run(`return ribbon.activate('other-ribbon').key;`,ws)).result,'other');
  scope(ws).ribbons[1].name='main';await assert.rejects(run(`ribbon.activate('main');`,ws),/複数/);
});

test('a deleted imported binding never silently resolves to an unrelated control or ribbon', async()=>{
  const ws=workspace();scope(ws).ribbonBindings={imported:{controls:{'main.count':'missing-control'},ribbons:{main:'missing-ribbon'}}};
  ws.scripts=[{id:'imported-script',bindingId:'imported',name:'Imported'}];
  const ctx=context(ws,primary(),{scriptId:'imported-script'});
  await assert.rejects(executeScript(`return ribbon.get('main.count');`,ctx),/見つかりません/);
  await assert.rejects(executeScript(`return ribbon.activate('main');`,ctx),/見つかりません/);
});

test('normalization and rejection agree between the script runtime and host domain', async()=>{
  const values=[['count-id','12.5',12.5],['count-id','',null],['count-id',null,null],['name-id',false,'false'],['name-id',7,'7'],['name-id',null,''],['toggle-id',true,true],['choice-id','live','live'],['choice-id','','']];
  for(const [id,value,expected] of values){
    const ws=workspace();assert.deepEqual(normalizeRibbonValue(at(ws,id),value),expected);
    const out=await executeScript('return ribbon.set(input.id,input.value);',context(ws,primary(),{input:{id,value}}));
    assert.deepEqual(out.result,expected);commit(ws,primary(),out);assert.deepEqual(at(ws,id).value,expected);
  }
  for(const [id,value] of [['count-id',false],['count-id',Infinity],['count-id',{}],['toggle-id','false'],['choice-id','missing'],['name-id',[]],['display-id',undefined],['display-id',new Date()]]){
    const ws=workspace();assert.throws(()=>normalizeRibbonValue(at(ws,id),value));
    await assert.rejects(executeScript('return ribbon.set(input.id,input.value);',context(ws,primary(),{input:{id,value}})));
  }
});

test('multiple activations retain the original selection for conflict checking', async()=>{
  const ws=workspace(),out=await run(`ribbon.activate('other');ribbon.activate('main');ribbon.activate('other');return ribbon.active();`,ws);
  assert.equal(out.ribbonWrites.length,1);assert.equal(out.ribbonWrites[0].expected,'main-ribbon');assert.equal(out.ribbonWrites[0].id,'other-ribbon');
  commit(ws,primary(),out);assert.equal(scope(ws).activeRibbonId,'other-ribbon');
});

test('ribbon writes preserve unrelated manual changes and the objects held by editors', async()=>{
  const ws=workspace(),p=primary(),row=at(ws,'count-id');
  const out=await run(`ribbon.set('count',8);store.set('result',8);vars.set('answer',8);`,ws,p);
  at(ws,'name-id').value='typed while running';ws.scriptData.other='manual';
  commit(ws,p,out);
  assert.equal(at(ws,'count-id'),row);assert.equal(row.value,8);
  assert.equal(at(ws,'name-id').value,'typed while running');assert.equal(ws.scriptData.other,'manual');assert.equal(p.get('answer'),'8');
});

test('a same-control edit rejects the entire commit including variable and shared data writes', async()=>{
  const ws=workspace(),p=primary();
  const out=await run(`ribbon.set('count',8);store.set('result',8);vars.set('answer',8);pm.environment.set('token','changed');`,ws,p);
  at(ws,'count-id').value=9;const before=structuredClone(ws);
  assert.throws(()=>commit(ws,p,out),/変更|更新|競合/);
  assert.deepEqual(ws,before);assert.deepEqual(p.snapshot(),{});
});

test('definition changes and deleted controls prevent stale script output from changing other scopes', async()=>{
  for(const mutate of [ws=>{at(ws,'count-id').type='text';at(ws,'count-id').value='2';},ws=>{scope(ws).ribbons[0].groups[0].controls=scope(ws).ribbons[0].groups[0].controls.filter(c=>c.id!=='count-id');},ws=>{at(ws,'count-id').options=[{value:'new',label:'New'}];}]){
    const ws=workspace(),p=primary(),out=await run(`ribbon.set('count',8);store.set('result',8);`,ws,p);mutate(ws);const before=structuredClone(ws);
    assert.throws(()=>commit(ws,p,out));assert.deepEqual(ws,before);
  }
});

test('script errors and cancellation never expose a partial ribbon transaction', async()=>{
  const ws=workspace(),before=structuredClone(ws);
  await assert.rejects(run(`ribbon.set('count',9);store.set('answer',9);throw new Error('failed');`,ws),error=>{
    assert.equal(error.message,'failed');assert.equal(Object.hasOwn(error,'ribbonWrites'),false);return true;
  });assert.deepEqual(ws,before);
  const controller=new AbortController();
  await assert.rejects(run(`ribbon.set('count',9);await minipost.workspace.read();`,ws,primary(),{signal:controller.signal,onCall:async()=>{controller.abort();return {};}}),{name:'AbortError'});
  assert.deepEqual(ws,before);
});

test('invalid later variable or data writes do not commit otherwise valid ribbon writes', async()=>{
  const ws=workspace(),out=await run(`ribbon.set('count',9);`,ws),before=structuredClone(ws);
  out.dataWrites.push({key:'invalid',value:undefined});
  assert.throws(()=>commit(ws,primary(),out));assert.deepEqual(ws,before);
});

test('before and after request hooks receive and commit the ribbon API', async()=>{
  const ws=workspace(),p=primary();
  const tab=Object.assign(ws.tabs[0],{name:'Example',request:{method:'GET',url:'https://example.test/{{count}}',header:[],_minipost:{before:`vars.set('count',ribbon.set('main.count',6));`,after:`ribbon.set('main.status',{status:response.status});ribbon.activate('other');`}},settings:{}});
  const result=await executeRequest({workspace:ws,tab,primary:p,script:executeScript,send:async payload=>{
    assert.equal(payload.url,'https://example.test/6');assert.equal(at(ws,'count-id').value,6);return {status:201,headers:[],body:'{}',body_encoding:'text',content_type:'application/json'};
  }});
  assert.deepEqual(result.automationErrors,[]);assert.deepEqual(at(ws,'display-id').value,{status:201});assert.equal(scope(ws).activeRibbonId,'other-ribbon');
});

test('invalid request mutation cannot leak staged ribbon writes through compile validation', async()=>{
  const ws=workspace(),p=primary();
  const tab=Object.assign(ws.tabs[0],{name:'Example',request:{method:'GET',url:'https://example.test/',header:[],_minipost:{before:`ribbon.set('count',99);request.url='unsupported://host/';`}},settings:{}});
  const before=structuredClone(ws);
  await assert.rejects(executeRequest({workspace:ws,tab,primary:p,script:executeScript,send:async()=>{throw new Error('must not send');}}));
  assert.deepEqual(ws,before);
});

test('serialized isolated worker retains the complete ribbon API without module dependencies', async()=>{
  const isolated=Function(`return (${executeScript.toString()})`)(),ws=workspace();
  const out=await isolated(`const ribbon = minipost.ribbon; ribbon.set('count',5);return ribbon.get('count');`,context(ws));
  assert.equal(out.result,5);assert.equal(out.ribbonWrites[0].value,5);
});

test('identical ribbon IDs and keys in two requests stay isolated after the selected request changes', async()=>{
  const ws=workspace(),p=primary(),a=ws.tabs[0],b=addRequest(ws),ctx=context(ws,p);
  // An old workspace-wide ribbon remains archived, even with matching identifiers.
  Object.assign(ws,{ribbons:structuredClone(scope(ws).ribbons),activeRibbonId:'main-ribbon',ribbonBindings:{}});
  ws.ribbons[0].groups[0].controls[0].value=900;
  const out=await executeScript(`ribbon.set('count',ribbon.get('count')+5);ribbon.activate('other');return ribbon.values('main');`,ctx);
  ws.activeId=b.id;at(ws,'name-id',b).value='B edited';
  assert.equal(out.ribbonScopeId,'scope-a');assert.equal(out.result.count,7);
  commit(ws,p,out);
  assert.equal(at(ws,'count-id',a).value,7);assert.equal(scope(ws,a).activeRibbonId,'other-ribbon');
  assert.equal(at(ws,'count-id',b).value,200);assert.equal(at(ws,'name-id',b).value,'B edited');assert.equal(scope(ws,b).activeRibbonId,'main-ribbon');
  assert.equal(ws.ribbons[0].groups[0].controls[0].value,900);assert.equal(ws.activeRibbonId,'main-ribbon');
  const other=await executeScript(`return ribbon.set('count',ribbon.get('count')+1);`,context(ws,p,{ribbonOwner:b}));
  commit(ws,p,other);assert.equal(at(ws,'count-id',a).value,7);assert.equal(at(ws,'count-id',b).value,201);
});

test('nested saved scripts retain their caller request scope across an asynchronous selection change', async()=>{
  const ws=workspace(),p=primary(),a=ws.tabs[0],b=addRequest(ws);
  ws.scripts=[{id:'child',name:'Child',source:`await minipost.workspace.read();return ribbon.set('count',ribbon.get('count')+1);`}];
  const host=createScriptHost({workspace:ws,primary:p});
  const out=await executeScript(`ribbon.set('count',10);const child=await scripts.run('Child');return {child,value:ribbon.get('count')};`,context(ws,p),{
    onCall:async(...args)=>{ws.activeId=b.id;at(ws,'count-id',b).value=300;return host(...args);}
  });
  assert.deepEqual(out.result,{child:11,value:11});assert.equal(out.ribbonScopeId,'scope-a');
  commit(ws,p,out);assert.equal(at(ws,'count-id',a).value,11);assert.equal(at(ws,'count-id',b).value,300);
});

test('sending a different request from a script never retargets the caller ribbon transaction', async()=>{
  const ws=workspace(),p=primary(),a=ws.tabs[0],b=addRequest(ws);
  b.request._minipost={before:`throw new Error('explicit sends do not run hooks');`};
  let sent=0;
  const host=createScriptHost({workspace:ws,primary:p,send:async payload=>{
    sent++;assert.equal(payload.url,'https://example.test/b');ws.activeId=b.id;
    at(ws,'count-id',b).value=250;
    return {status:202,body:'{"owner":"B"}',headers:[],content_type:'application/json'};
  },onResponse:(tab,result)=>ws.history.push(historyEntry(tab,result))});
  const out=await executeScript(`ribbon.set('count',8);const reply=await minipost.requests.send('draft:request-b');return {status:reply.status,body:reply.body,count:ribbon.set('count',ribbon.get('count')+1)};`,context(ws,p),{onCall:host});
  assert.equal(sent,1);assert.deepEqual(out.result,{status:202,body:{owner:'B'},count:9});
  commit(ws,p,out);assert.equal(at(ws,'count-id',a).value,9);assert.equal(at(ws,'count-id',b).value,250);
  assert.equal(ws.history[0].tab.ribbonState.id,'scope-b');assert.equal(at(ws,'count-id',ws.history[0].tab).value,200);
});

test('saved request editors use the canonical item ribbon state instead of a cached editor copy', async()=>{
  const ws=workspace(),p=primary(),draft=ws.tabs.shift();
  const item={_mpId:'saved-a',name:'Saved A',request:draft.request,ribbonState:draft.ribbonState};
  ws.collections=[{_mpId:'collection',info:{name:'Collection'},item:[item]}];
  const tab={...draft,id:'temporary-editor',collectionId:'collection',itemId:'saved-a',ribbonState:structuredClone(draft.ribbonState)};
  tab.ribbonState.id='stale-editor-scope';at(ws,'count-id',tab).value=500;
  const ctx=makeScriptContext(ws,p,{tab});
  assert.equal(ctx.ribbonScopeId,'scope-a');assert.equal(ctx.ribbons[0].groups[0].controls[0].value,2);
  const out=await executeScript(`return ribbon.set('count',12);`,ctx);commit(ws,p,out);
  assert.equal(at(ws,'count-id',item).value,12);assert.equal(at(ws,'count-id',tab).value,500);
});

test('before and after hooks keep their original scope while a different request is selected during send', async()=>{
  const ws=workspace(),p=primary(),a=ws.tabs[0],b=addRequest(ws),seen=[];
  a.request._minipost={before:`ribbon.set('count',6);`,after:`ribbon.set('count',ribbon.get('count')+response.status);`};
  const result=await executeRequest({workspace:ws,tab:a,primary:p,script:async(source,ctx,options)=>{
    seen.push({scopeId:ctx.ribbonScopeId,count:ctx.ribbons[0].groups[0].controls[0].value});return executeScript(source,ctx,options);
  },send:async()=>{
    assert.equal(at(ws,'count-id',a).value,6);ws.activeId=b.id;at(ws,'count-id',b).value=210;
    return {status:201,body:'{}',headers:[],content_type:'application/json'};
  }});
  assert.deepEqual(seen,[{scopeId:'scope-a',count:2},{scopeId:'scope-a',count:6}]);
  assert.deepEqual(result.automationErrors,[]);assert.equal(at(ws,'count-id',a).value,207);assert.equal(at(ws,'count-id',b).value,210);
});

test('deleting or replacing the owning request rejects all pending script writes atomically', async()=>{
  for(const mutate of [
    (ws,a)=>{ws.tabs=ws.tabs.filter(tab=>tab!==a);},
    (_ws,a)=>{a.ribbonState={...structuredClone(a.ribbonState),id:'replacement-scope'};},
    (_ws,a,b)=>{b.ribbonState.id=a.ribbonState.id;}
  ]) {
    const ws=workspace(),p=primary(),a=ws.tabs[0],b=addRequest(ws);
    const out=await executeScript(`ribbon.set('count',9);vars.set('count',9);pm.environment.set('token','pending');store.set('pending',true);await minipost.workspace.read();`,context(ws,p),{
      onCall:async()=>{mutate(ws,a,b);ws.activeId=b.id;return {};}
    });
    const before=structuredClone(ws);
    assert.throws(()=>commit(ws,p,out),/見つかりません|重複/);
    assert.deepEqual(ws,before);assert.deepEqual(p.snapshot(),{});
  }
});

test('an owner removed during HTTP send cannot redirect an after hook into the selected request', async()=>{
  const ws=workspace(),p=primary(),a=ws.tabs[0],b=addRequest(ws);
  a.request._minipost={after:`ribbon.set('count',99);store.set('pending',true);`};
  const result=await executeRequest({workspace:ws,tab:a,primary:p,script:executeScript,send:async()=>{
    ws.tabs=[b];ws.activeId=b.id;return {status:200,body:'{}',headers:[]};
  }});
  assert.equal(result.automationErrors.length,1);assert.match(result.automationErrors[0],/削除|変更/);
  assert.equal(at(ws,'count-id',b).value,200);assert.equal(ws.scriptData.pending,undefined);
});

test('no selected owner exposes no ribbons and never falls back to archived workspace ribbons', async()=>{
  const ws=workspace(),p=primary();
  Object.assign(ws,{ribbons:structuredClone(scope(ws).ribbons),activeRibbonId:'main-ribbon',ribbonBindings:{}});
  const ctx=makeScriptContext(ws,p);
  assert.equal(ctx.ribbonScopeId,null);assert.deepEqual(ctx.ribbons,[]);assert.equal(ctx.request,null);
  const out=await executeScript(`return {list:ribbon.list(),active:ribbon.active(),values:ribbon.values(),controls:ribbon.controls()};`,ctx);
  assert.deepEqual(out.result,{list:[],active:null,values:{},controls:[]});assert.equal(out.ribbonScopeId,null);
  await assert.rejects(executeScript(`return ribbon.get('count');`,ctx),/見つかりません/);
  const unscoped={ribbons:ws.ribbons,activeRibbonId:ws.activeRibbonId};
  assert.deepEqual((await executeScript(`return ribbon.list();`,unscoped)).result,[]);
  await assert.rejects(executeScript(`return ribbon.set('count',99);`,unscoped),/見つかりません/);
  assert.throws(()=>scriptRibbonSnapshot(ws,{ribbonScopeId:'deleted-scope'}),/削除|変更/);
});

test('a run without a ribbon scope stays empty if a ribbon is added while it is pending', async()=>{
  const ws=workspace(),p=primary(),a=ws.tabs[0],saved=structuredClone(a.ribbonState),b=addRequest(ws);
  delete a.ribbonState;
  const ctx=context(ws,p),out=await executeScript(`await minipost.workspace.read();return {list:ribbon.list(),active:ribbon.active()};`,ctx,{
    onCall:async()=>{a.ribbonState=saved;ws.activeId=b.id;return {};}
  });
  assert.equal(ctx.ribbonScopeId,null);assert.equal(out.ribbonScopeId,null);assert.deepEqual(out.result,{list:[],active:null});
  assert.deepEqual(out.ribbonWrites,[]);
});
