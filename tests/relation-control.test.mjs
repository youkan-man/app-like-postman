import test from 'node:test';
import assert from 'node:assert/strict';
import {clone,newRequest,compileRequest} from '../static/core.mjs';
import {PrimaryVariables} from '../static/runtime.mjs';
import {newRelation,newStep,newRelationStep,validateRelation,runRelation,cloneRelationSteps,walkRelationSteps,END,NEXT,wait} from '../static/relations.mjs';

function fixture(){
  const collection={_mpId:'collection',info:{name:'API'},item:['A','B','C'].map(name=>({_mpId:name,name,request:{...newRequest(),url:'https://example.test/'+name+'?value={{item}}&index={{index}}'}}))};
  const workspace={collections:[collection],tabs:[],globals:[],environments:[],scripts:[{id:'script',name:'Transform',source:'initial source',input:'{"saved":true}',inputFormat:'json',timeoutMs:0}]};
  const primary=new PrimaryVariables(),relation=newRelation('Structured flow');
  const request=name=>newStep({collectionId:'collection',itemId:name});
  const node=(type,props={})=>Object.assign(newRelationStep(type),props);
  const condition=(source,path,operator,value)=>({enabled:true,source,path,operator,value});
  const options={workspace,primary:()=>primary.snapshot(),variables:()=>primary.snapshot(),writePrimary:writes=>primary.apply(writes)};
  return {workspace,primary,relation,request,node,condition,options};
}
const response=(body={},status=200)=>({status,headers:[],body:JSON.stringify(body),elapsed_ms:1});
const requests=run=>run.entries.filter(entry=>entry.type==='request');

test('nested repeats execute complete blocks, retain legacy request repeat, and log their paths',async()=>{
  const {relation,request,node,options}=fixture(),a=request('A');a.repeat=2;
  relation.repeat=2;relation.steps=[node('repeat',{repeat:2,steps:[a,node('repeat',{repeat:2,steps:[request('B')]})]}),request('C')];
  const seen=[];const run=await runRelation(relation,{...options,execute:async tab=>{seen.push(tab.name);return response();}});
  assert.equal(run.status,'succeeded',run.error);
  assert.deepEqual(seen,Array.from({length:2},()=>['A','A','B','B','A','A','B','B','C']).flat());
  assert.equal(run.entries[2].stepPath,'1.2.1');assert.deepEqual(run.entries[2].loops.map(loop=>loop.iteration),[1,1]);
});

test('forEach preserves JSON values and index in compiled HTTP templates, then restores bindings',async()=>{
  const {relation,request,node,options,primary,workspace}=fixture();primary.set('item','original');primary.set('unrelated','keep');
  relation.steps=[node('forEach',{value:'[0,false,null,{"id":7}]',steps:[request('A')]})];
  const sent=[];const run=await runRelation(relation,{...options,execute:async tab=>{
    const payload=compileRequest(workspace,tab,{},primary.rows).payload;sent.push(payload.query.find(row=>row.key==='value').value);
    assert.equal(primary.get('index'),String(sent.length-1));return response();
  }});
  assert.equal(run.status,'succeeded',run.error);assert.deepEqual(sent,['0','false','null','{"id":7}']);
  assert.deepEqual(primary.snapshot(),{item:'original',unrelated:'keep'});
});

test('nested forEach using the same binding names restores the outer element before its next step',async()=>{
  const {relation,request,node,options,primary}=fixture();
  relation.steps=[node('forEach',{value:'["outer-a","outer-b"]',steps:[node('forEach',{value:'[1,2]',steps:[request('A')]}),request('B')]})];
  const seen=[];const run=await runRelation(relation,{...options,execute:async tab=>{seen.push([tab.name,primary.get('item'),primary.get('index')]);return response();}});
  assert.equal(run.status,'succeeded',run.error);
  assert.deepEqual(seen,[['A','1','0'],['A','2','1'],['B','outer-a','0'],['A','1','0'],['A','2','1'],['B','outer-b','1']]);
  assert.deepEqual(primary.snapshot(),{});
});

test('if/else and continue/break route the current loop without skipping later outer steps',async()=>{
  const {relation,request,node,condition,options,primary}=fixture();
  relation.steps=[node('forEach',{value:'[1,2,3,4]',steps:[
    node('if',{condition:condition('primary','item','eq','2'),steps:[node('continue')],elseSteps:[request('A')]}),
    node('if',{condition:condition('primary','item','eq','3'),steps:[node('break')]}),request('B')
  ]}),request('C')];
  const seen=[];const run=await runRelation(relation,{...options,execute:async tab=>{seen.push([tab.name,primary.get('item')]);return response();}});
  assert.equal(run.status,'succeeded',run.error);assert.deepEqual(seen,[['A','1'],['B','1'],['A','3'],['C',undefined]]);
});

test('break ends only the innermost loop',async()=>{
  const {relation,request,node,options}=fixture();
  relation.steps=[node('repeat',{repeat:2,steps:[node('repeat',{repeat:10,steps:[request('A'),node('break'),request('B')]}),request('C')]})];
  const seen=[];const run=await runRelation(relation,{...options,execute:async tab=>{seen.push(tab.name);return response();}});
  assert.equal(run.status,'succeeded',run.error);assert.deepEqual(seen,['A','C','A','C']);
});

test('while reevaluates live variables and accepts response-driven conditions',async()=>{
  const {relation,request,node,condition,options,primary}=fixture();primary.set('count',0);
  relation.steps=[node('while',{condition:condition('primary','count','lt','3'),steps:[request('A')]}),
    node('while',{condition:condition('response','/body/next','truthy',''),steps:[request('B')]})];
  const seen=[];const run=await runRelation(relation,{...options,execute:async tab=>{
    seen.push(tab.name);primary.set('count',Number(primary.get('count'))+1);return response({next:tab.name==='A'});
  }});
  assert.equal(run.status,'succeeded',run.error);assert.deepEqual(seen,['A','A','A','B']);
});

test('while iteration bound fails before another effect and zero-iteration condition skips the block',async()=>{
  const {relation,request,node,condition,options}=fixture();
  const loop=node('while',{maxIterations:2,condition:condition('primary','missing','missing',''),steps:[request('A')]});
  relation.steps=[loop];let sent=0;
  const run=await runRelation(relation,{...options,execute:async()=>{sent++;return response();}});
  assert.equal(run.status,'failed');assert.match(run.error,/上限回数/);assert.equal(sent,2);
  loop.condition.operator='exists';sent=0;
  const skipped=await runRelation(relation,{...options,execute:async()=>{sent++;return response();}});
  assert.equal(skipped.status,'succeeded');assert.equal(sent,0);
});

test('array source reads JSON primary values, nested response arrays and latest script result',async()=>{
  const {relation,request,node,options,primary}=fixture();primary.set('payload',{rows:[10,20]});
  relation.steps=[node('forEach',{source:'primary',path:'/payload/rows',steps:[request('A')]}),request('B'),
    node('forEach',{source:'response',path:'/body/items',steps:[request('A')]}),
    node('script',{scriptId:'script'}),node('forEach',{source:'result',path:'',steps:[request('C')]})];
  const seen=[];const run=await runRelation(relation,{...options,execute:async tab=>{seen.push([tab.name,primary.get('item')]);return response({items:['r1','r2']});},executeScript:async()=>({result:[false,0],logs:[]})});
  assert.equal(run.status,'succeeded',run.error);
  assert.deepEqual(seen,[['A','10'],['A','20'],['B',undefined],['A','r1'],['A','r2'],['C','false'],['C','0']]);
});

test('script step captures source, resolves typed input and exposes its result to conditions and primary values',async()=>{
  const {relation,request,node,condition,options,workspace,primary}=fixture();primary.set('count',4);
  relation.steps=[node('script',{scriptId:'script',inputFormat:'json',input:'{"count":{{count}}}',resultVariable:'result'}),
    node('if',{condition:condition('result','/ready','truthy',''),steps:[request('B')],elseSteps:[request('C')]})];
  let captured=false;const seen=[];
  const run=await runRelation(relation,{...options,onProgress:()=>{if(!captured){captured=true;workspace.scripts[0].source='edited';}},
    executeScript:async(script,{input,signal})=>{assert.equal(script.source,'initial source');assert.deepEqual(input,{count:4});assert.equal(signal,undefined);return {result:{ready:true},logs:[{message:'done'}]};},
    execute:async tab=>{seen.push(tab.name);return response();}});
  assert.equal(run.status,'succeeded',run.error);assert.deepEqual(seen,['B']);assert.equal(primary.get('result'),'{"ready":true}');assert.equal(run.entries[0].logs[0].message,'done');
});

test('saved/text/response script inputs use their intended values without changing saved script input',async()=>{
  const {relation,request,node,options,workspace,primary}=fixture();primary.set('x','hello');
  relation.steps=[request('A'),node('script',{scriptId:'script'}),node('script',{scriptId:'script',inputFormat:'text',input:'{{x}}!'}),node('script',{scriptId:'script',inputFormat:'response'})];
  const inputs=[];const run=await runRelation(relation,{...options,execute:async()=>response({value:0}),executeScript:async(script,{input,raw})=>{inputs.push(input);assert.equal(raw.status,200);return {result:null};}});
  assert.equal(run.status,'succeeded',run.error);assert.deepEqual(inputs.slice(0,2),[{saved:true},'hello!']);assert.equal(inputs[2].body.value,0);assert.equal(workspace.scripts[0].input,'{"saved":true}');
});

test('script failure follows stopOnError policy and never exposes an older script result',async()=>{
  const {relation,request,node,condition,options}=fixture();relation.stopOnError=false;
  relation.steps=[node('script',{scriptId:'script'}),node('script',{scriptId:'script'}),node('if',{condition:condition('result','/ready','exists',''),steps:[request('A')],elseSteps:[request('B')]})];
  let calls=0;const seen=[];const run=await runRelation(relation,{...options,executeScript:async()=>{if(calls++)throw Error('script failed');return {result:{ready:true}};},execute:async tab=>{seen.push(tab.name);return response();}});
  assert.equal(run.status,'completed_with_errors');assert.deepEqual(seen,['B']);assert.equal(run.entries[1].error,'script failed');
});

test('stop aborts nested wait and restores existing loop values without sending its following request',async()=>{
  const {relation,request,node,options,primary}=fixture();primary.set('item','old');primary.set('index',7);
  relation.steps=[node('forEach',{value:'["new"]',steps:[node('wait',{delayMs:10000}),request('A')]})];
  const control=new AbortController();let sent=0;
  const run=await runRelation(relation,{...options,signal:control.signal,onProgress:state=>{if(state.current?.type==='wait'&&state.current.status==='running')control.abort();},execute:async()=>{sent++;return response();}});
  assert.equal(run.status,'cancelled');assert.equal(sent,0);assert.deepEqual(primary.snapshot(),{item:'old',index:'7'});assert.equal(run.entries[0].status,'cancelled');
});

test('stop is delivered through a script callback and still restores forEach bindings',async()=>{
  const {relation,node,options,primary}=fixture();relation.steps=[node('forEach',{value:'[1]',steps:[node('script',{scriptId:'script'})]})];
  const control=new AbortController();
  const run=await runRelation(relation,{...options,signal:control.signal,executeScript:async(_script,{signal})=>{setTimeout(()=>control.abort(),5);await wait(10000,signal);}});
  assert.equal(run.status,'cancelled');assert.deepEqual(primary.snapshot(),{});
});

test('control-only loops yield to Stop and obey the global operation limit',async()=>{
  const {relation,node,options}=fixture();relation.steps=[node('repeat',{repeat:1000000,steps:[node('continue')]})];
  const control=new AbortController();setTimeout(()=>control.abort(),5);
  const stopped=await runRelation(relation,{...options,signal:control.signal});assert.equal(stopped.status,'cancelled');
  relation.maxExecutions=5;
  const limited=await runRelation(relation,options);assert.equal(limited.status,'failed');assert.match(limited.error,/最大実行数/);
});

test('legacy END inside a nested group exits that whole round and preserves the next round',async()=>{
  const {relation,request,node,options,primary}=fixture(),a=request('A');a.condition={enabled:true,source:'response',path:'/status',operator:'eq',value:'200'};a.onTrue=END;
  relation.repeat=2;relation.steps=[node('forEach',{value:'[1,2]',steps:[a,request('B')]}),request('C')];
  const seen=[];const run=await runRelation(relation,{...options,execute:async tab=>{seen.push(tab.name);return response();}});
  assert.equal(run.status,'succeeded',run.error);assert.deepEqual(seen,['A','A']);assert.deepEqual(primary.snapshot(),{});
});

test('validation visits both branches and rejects missing references before any side effect',async()=>{
  const {relation,request,node,condition,options}=fixture();relation.steps=[request('A'),node('if',{condition:condition('primary','x','missing',''),steps:[request('B')],elseSteps:[node('script',{scriptId:'gone'})]})];
  let sent=0;await assert.rejects(runRelation(relation,{...options,execute:async()=>{sent++;return response();},executeScript:async()=>({})}),/スクリプト/);assert.equal(sent,0);
  relation.steps[1].elseSteps=[request('gone')];await assert.rejects(runRelation(relation,{...options,execute:async()=>{sent++;return response();}}),/リクエスト/);assert.equal(sent,0);
});

test('validation rejects cross-block jumps, duplicate nested IDs, orphan control and malformed blocks',()=>{
  const {relation,request,node,options}=fixture(),a=request('A'),b=request('B');
  relation.steps=[a,node('repeat',{steps:[b]})];a.onTrue=b.id;assert.throws(()=>validateRelation(relation,options.workspace),/同じブロック/);
  a.onTrue=NEXT;b.id=a.id;assert.throws(()=>validateRelation(relation,options.workspace),/重複/);
  relation.steps=[node('break')];assert.throws(()=>validateRelation(relation,options.workspace),/ループ内/);
  relation.steps=[node('repeat')];assert.throws(()=>validateRelation(relation,options.workspace),/ステップを追加/);
  relation.steps=[node('forEach',{itemVariable:'same',indexVariable:'same',steps:[request('A')]})];assert.throws(()=>validateRelation(relation,options.workspace),/異なる変数名/);
  relation.steps=[{...request('A'),steps:[request('B')]}];assert.throws(()=>validateRelation(relation,options.workspace),/子ステップ/);
});

test('array errors fail visibly and preflight rejects absent mutation callbacks before sending',async()=>{
  const {relation,request,node,options}=fixture();relation.steps=[node('forEach',{value:'{"not":"array"}',steps:[request('A')]})];
  let sent=0;const run=await runRelation(relation,{...options,execute:async()=>{sent++;return response();}});
  assert.equal(run.status,'failed');assert.match(run.error,/配列/);assert.equal(sent,0);
  relation.steps=[request('A'),node('forEach',{value:'[]',steps:[request('B')]})];
  await assert.rejects(runRelation(relation,{...options,writePrimary:undefined,execute:async()=>{sent++;return response();}}),/一次変数/);assert.equal(sent,0);
});

test('duplication remaps all nested IDs and local branch targets without changing the source',()=>{
  const {request,node}=fixture(),a=request('A'),b=request('B');a.onTrue=b.id;b.onFalse=a.id;
  const original=[node('repeat',{steps:[a,b]})],before=clone(original),copy=cloneRelationSteps(original);
  assert.deepEqual(original,before);assert.notEqual(copy[0].id,original[0].id);assert.notEqual(copy[0].steps[0].id,a.id);
  assert.equal(copy[0].steps[0].onTrue,copy[0].steps[1].id);assert.equal(copy[0].steps[1].onFalse,copy[0].steps[0].id);
  const paths=[];walkRelationSteps(copy,(_step,{path})=>paths.push(path));assert.deepEqual(paths,[[0],[0,'steps',0],[0,'steps',1]]);
});
