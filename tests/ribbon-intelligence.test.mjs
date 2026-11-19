import test from 'node:test';
import assert from 'node:assert/strict';
import {createScriptIntelligence} from '../static/script-intelligence.mjs';
import {buildLanguageProject} from '../static/script-language-model.mjs';
import {scriptEditorContext} from '../static/script-editor-context.mjs';

function fixture() {
  return {activeRibbonId:'main-ribbon',ribbons:[
    {id:'main-ribbon',key:'main',name:'Main',groups:[{id:'main-group',name:'Inputs',controls:[
      {id:'query-id',key:'query',label:'Query',type:'text',value:'private query'},
      {id:'count-id',key:'count',label:'Count',type:'number',value:null},
      {id:'ready-id',key:'ready',label:'Ready',type:'toggle',value:false},
      {id:'mode-id',key:'mode',label:'Mode',type:'select',value:'private-choice',options:[{value:'private-choice',label:'Choice'}]},
      {id:'output-id',key:'output',label:'Result',type:'display',value:{rows:[{name:'private name',score:3}],total:1}}
    ]}]},
    {id:'next-ribbon',key:'next',name:'Next',groups:[{id:'next-group',name:'Next',controls:[
      {id:'other-query-id',key:'query',label:'Query',type:'number',value:5},
      {id:'result-id',key:'result',label:'Result',type:'display',value:{saved:true}}
    ]}]}
  ]};
}

const intelligence = createScriptIntelligence();
const labels = (source,context) => (intelligence.analyze(source,source.length,{explicit:true,context}).completion?.items||[]).map(item=>item.label);
test.after(()=>intelligence.dispose());

test('ribbon methods and literal references come from the current catalog through aliases',()=>{
  const context=fixture();
  for(const prefix of ['ribbon.','minipost.ribbon.']) {
    const names=labels(prefix,context);
    for(const name of ['list','active','activate','controls','get','set','values','show','enable']) assert.ok(names.includes(name),prefix+name);
  }
  for(const prefix of ['ribbon.get("','minipost.ribbon.set("','const {get}=ribbon; get("','const ui=minipost.ribbon; ui.show("']) {
    const keys=labels(prefix,context);
    for(const key of ['count-id','main.count','count','next.result','result']) assert.ok(keys.includes(key),prefix+key);
    assert.ok(!keys.includes('Count'));
  }
  assert.deepEqual(new Set(labels('ribbon.activate("',context)),new Set(['Main','main','main-ribbon','Next','next','next-ribbon']));
});

test('ribbon values expose typed member and method chains, including normalized set results',()=>{
  const context=fixture();
  assert.ok(labels('ribbon.get("count").',context).includes('toFixed'));
  assert.ok(!labels('ribbon.get("count").',context).includes('trim'));
  assert.ok(labels('ribbon.get("query").',context).includes('trim'));
  assert.ok(labels('ribbon.get("next.query").',context).includes('toFixed'));
  assert.deepEqual(labels('minipost.ribbon.get("main.output").rows[0].',context),['name','score']);
  assert.ok(labels('const value=ribbon.set("count", "4"); value.',context).includes('toFixed'));
  assert.ok(labels('const value=ribbon.set("query", false); value.',context).includes('trim'));
  assert.deepEqual(labels('const value=ribbon.set("output", {updated:[{complete:true}]}); value.updated[0].',context),['complete']);
  assert.deepEqual(labels('const {output}=ribbon.values(); output.',context),['rows','total']);
  assert.deepEqual(labels('ribbon.values("Next").',context),['query','result']);
  assert.deepEqual(labels('ribbon.values("next").result.',context),['saved']);
});

test('active-ribbon bare-key resolution and removed controls update the live type project',()=>{
  const context=fixture();
  assert.ok(labels('ribbon.get("query").',context).includes('trim'));
  context.activeRibbonId='next-ribbon';
  assert.ok(labels('ribbon.get("query").',context).includes('toFixed'));
  assert.ok(!labels('ribbon.get("query").',context).includes('trim'));
  assert.deepEqual(labels('ribbon.values().',context),['query','result']);
  context.activeRibbonId='';
  assert.ok(!labels('ribbon.get("',context).includes('query'));
  assert.deepEqual(labels('ribbon.get("query").',context),[]);
  context.ribbons[1].groups[0].controls[1].key='renamed';
  context.ribbons[1].groups[0].controls[1].value={changed:2};
  assert.ok(labels('ribbon.get("',context).includes('next.renamed'));
  assert.ok(!labels('ribbon.get("',context).includes('next.result'));
  assert.deepEqual(labels('ribbon.get("next.renamed").',context),['changed']);
  context.ribbons[1].groups[0].controls.pop();
  assert.deepEqual(labels('ribbon.get("next.renamed").',context),[]);
});

test('imported script ribbon bindings override original aliases and deleted bindings never fall back',()=>{
  const context=fixture();
  context.scripts=[{id:'caller',name:'Caller',source:'',input:'null',inputFormat:'json',bindingId:'copied'},
    {id:'child',name:'Child',source:'return ribbon.get("query");',input:'null',inputFormat:'json'}];
  context.scriptId='caller';
  context.ribbonBindings={copied:{controls:{query:'other-query-id','old-output':'result-id'},ribbons:{Main:'next-ribbon'}}};
  assert.ok(labels('ribbon.get("query").',context).includes('toFixed'));
  assert.deepEqual(labels('ribbon.get("old-output").',context),['saved']);
  assert.deepEqual(labels('ribbon.values("Main").',context),['query','result']);
  assert.ok(labels('const value=await scripts.run("Child"); value.',context).includes('trim'));
  context.ribbonBindings.copied.controls.query='deleted';
  assert.ok(!labels('ribbon.get("',context).includes('query'));
  assert.deepEqual(labels('ribbon.get("query").',context),[]);
  context.ribbonBindings.copied.ribbons.Main='deleted';
  assert.ok(!labels('ribbon.activate("',context).includes('Main'));
});

test('editor snapshots retain ribbon data shapes and fresh keys without copying private field values',()=>{
  const workspace={...fixture(),collections:[],tabs:[],environments:[],globals:[],scripts:[],scriptData:{},ribbonBindings:{copy:{ribbons:{old:'next-ribbon'},controls:{old:'result-id'}}}};
  let context=scriptEditorContext(workspace,{rows:[]});
  assert.equal(context.activeRibbonId,'main-ribbon');
  assert.equal(context.ribbons[0].groups[0].controls[0].key,'query');
  assert.deepEqual(context.ribbons[0].groups[0].controls[4].value,{rows:[{name:'',score:0}],total:0});
  assert.deepEqual(context.ribbonBindings,workspace.ribbonBindings);
  assert.ok(!JSON.stringify(context).includes('private'));
  const project=buildLanguageProject('',context),declarations=project.files['/minipost/model.d.ts'];
  assert.ok(!declarations.includes('private'));
  assert.match(declarations,/"main.count": number \| null/);
  workspace.ribbons[0].groups[0].controls[0].key='new-query';
  workspace.activeRibbonId='next-ribbon';
  context=scriptEditorContext(workspace,{rows:[]});
  assert.equal(context.activeRibbonId,'next-ribbon');
  assert.ok(labels('ribbon.get("',context).includes('main.new-query'));
  assert.ok(!labels('ribbon.get("',context).includes('main.query'));
});

test('ribbon declarations share per-binding dictionaries across many saved scripts',()=>{
  const context=fixture();
  context.scripts=Array.from({length:100},(_,index)=>({id:`script-${index}`,name:`Script ${index}`,source:'return ribbon.get("count");',input:'null',inputFormat:'json'}));
  const text=buildLanguageProject('',context).files['/minipost/model.d.ts'];
  assert.equal((text.match(/export type RibbonReadGroup_/g)||[]).length,1);
  assert.equal((text.match(/export type RibbonLookupGroup_/g)||[]).length,1);
});
