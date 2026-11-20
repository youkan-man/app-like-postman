import test from 'node:test';
import assert from 'node:assert/strict';
import {clone} from '../static/core.mjs';
import {PrimaryVariables} from '../static/runtime.mjs';
import {newRelation,runRelation,validateRelation} from '../static/relations.mjs';
import {applyScriptWrites,newScript} from '../static/scripts.mjs';
import {executeScript} from '../static/script-worker.mjs';
import {createScriptHost,makeScriptContext} from '../static/script-host.mjs';
import {createScriptRelationRunner} from '../static/script-relations.mjs';

function fixture(){
  const saved={...newScript('Saved input'),id:'saved',input:'{"saved":true}'};
  const workspace={version:2,collections:[],tabs:[],history:[],globals:[],environments:[],
    scripts:[saved],scriptData:{},relations:[],relationRuns:[]};
  const primary=new PrimaryVariables(),relation=newRelation('API shape');
  return {workspace,primary,relation,options:{workspace,primary:()=>primary.snapshot(),variables:()=>primary.snapshot(),writePrimary:writes=>primary.apply(writes)}};
}

test('script-created literal array relation runs without an unused path and commits its child effects',async()=>{
  const {workspace,primary}=fixture(),before=clone(workspace);
  const runRelation=createScriptRelationRunner({script:executeScript});
  const onCall=createScriptHost({workspace,primary,runRelation});
  const output=await executeScript(`
    const child=minipost.scripts.create({name:'Count loop',source:
      "store.set('loopCount',(store.get('loopCount')||0)+1); vars.set('lastLoopItem',vars.get('item')); return store.get('loopCount');"});
    const relation=minipost.relations.create({name:'Script loop',steps:[{
      id:'native-array-loop',type:'forEach',source:'literal',value:'[10,20,30]',itemVariable:'item',indexVariable:'index',intervalMs:0,
      steps:[{id:'native-loop-script',type:'script',scriptId:child.id,inputFormat:'saved',input:'null',resultVariable:'loopResult'}]
    }]});
    vars.set('item','outer');
    const result=await minipost.relations.run(relation.id);
    store.set('scriptLoop',relation.id);
    return {status:result.status,entries:result.entries.length,count:store.get('loopCount'),
      item:vars.get('item'),last:vars.get('lastLoopItem'),result:vars.get('loopResult')};
  `,makeScriptContext(workspace,primary),{onCall});
  assert.deepEqual(output.result,{status:'succeeded',entries:3,count:3,item:'outer',last:'30',result:'3'});
  assert.deepEqual(workspace,before);
  assert.deepEqual(primary.snapshot(),{});
  applyScriptWrites(workspace,primary,undefined,output);
  assert.equal(workspace.scriptData.loopCount,3);
  assert.equal(workspace.relationRuns[0].relationId,workspace.scriptData.scriptLoop);
  assert.equal(primary.get('item'),'outer');
  assert.equal(primary.get('index'),undefined);
});

test('result array source defaults its omitted path to the root and does not need a literal value',async()=>{
  const {relation,options,primary}=fixture(),seen=[],inputs=[];
  relation.steps=[{id:'produce',type:'script',scriptId:'saved'},
    {id:'loop',type:'forEach',source:'result',itemVariable:'item',indexVariable:'index',intervalMs:0,
      steps:[{id:'consume',type:'script',scriptId:'saved',inputFormat:'saved'}]}];
  const run=await runRelation(relation,{...options,executeScript:async(_script,{input,step})=>{
    inputs.push(input);
    if(step.id==='produce')return {result:[0,false,{id:3}]};
    seen.push([primary.get('item'),primary.get('index')]);return {result:null};
  }});
  assert.equal(run.status,'succeeded',run.error);
  assert.deepEqual(seen,[['0','0'],['false','1'],['{"id":3}','2']]);
  assert.deepEqual(inputs,Array(4).fill({saved:true}));
  assert.deepEqual(primary.snapshot(),{});
});

test('response input mode does not require an unused explicit input',async()=>{
  const {relation,options}=fixture();
  relation.steps=[{id:'script',type:'script',scriptId:'saved',inputFormat:'response'}];
  let called=false;
  const run=await runRelation(relation,{...options,executeScript:async(_script,{input})=>{
    called=true;assert.equal(input,null);return {result:input};
  }});
  assert.equal(run.status,'succeeded',run.error);assert.equal(called,true);
});

test('array source validation still rejects missing literal data and nonstring optional fields',()=>{
  const {relation,workspace}=fixture();
  const loop={id:'loop',type:'forEach',source:'literal',value:'[]',itemVariable:'item',indexVariable:'index',intervalMs:0,
    steps:[{id:'wait',type:'wait',delayMs:0}]};
  for(const patch of [{value:undefined},{value:null},{value:[]},{path:null},{path:2},{path:{}},
    {source:'result',path:[]},{source:'primary',value:0}]){
    relation.steps=[{...loop,...patch}];
    assert.throws(()=>validateRelation(relation,workspace),/配列の参照元/,JSON.stringify(patch));
  }
});

test('script input validation still requires explicit text or JSON and rejects invalid formats and types',()=>{
  const {relation,workspace}=fixture();
  for(const patch of [{inputFormat:'json'},{inputFormat:'text'},{inputFormat:null},{inputFormat:'invalid'},
    {input:null},{input:0},{inputFormat:'response',input:[]}]){
    relation.steps=[{id:'script',type:'script',scriptId:'saved',...patch}];
    assert.throws(()=>validateRelation(relation,workspace),/スクリプトの入力/,JSON.stringify(patch));
  }
});
