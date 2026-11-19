import test from 'node:test';
import assert from 'node:assert/strict';
import {clone} from '../static/core.mjs';
import {newScript} from '../static/scripts.mjs';
import {PrimaryVariables} from '../static/runtime.mjs';
import {exportWorkspace,readWorkspaceBundle,mergeWorkspace} from '../static/workspace-data.mjs';
import {newRibbon,newRibbonGroup,newRibbonControl,validRibbonKey,validRibbons,validRibbonWorkspace,ensureRibbons,
  listRibbonControls,resolveRibbon,resolveRibbonControl,normalizeRibbonValue,evaluateRibbonCondition,ribbonControlState,prepareRibbonWrites} from '../static/ribbons.mjs';

function workspace() {return {version:2,collections:[],environments:[],globals:[],tabs:[],history:[],collapsed:[],revisions:{}};}
function ribbon(name='Tools',key='tools') {
  const result=newRibbon(name,key),group=newRibbonGroup('Actions'),text=newRibbonControl('text','Value');
  text.key='value';group.controls.push(text);result.groups.push(group);return result;
}
function sample() {const ws=workspace();ensureRibbons(ws);ws.ribbons.push(ribbon());ws.activeRibbonId=ws.ribbons[0].id;return ws;}
const condition=(source,key,operator,value)=>({mode:'all',rules:[{source,key,operator,...(value===undefined?{}:{value})}]});
const first=ws=>ws.ribbons[0].groups[0].controls[0];

test('ribbon initialization retains old workspaces and creates no examples or active selection',()=>{
  const ws=workspace(),before=clone(ws);assert.deepEqual(readWorkspaceBundle(exportWorkspace(ws)).workspace,before);
  ensureRibbons(ws);assert.deepEqual(ws.ribbons,[]);assert.equal(ws.activeRibbonId,'');assert.deepEqual(ws.ribbonBindings,{});
  assert.deepEqual(newRibbon().groups,[]);assert.deepEqual(newRibbonGroup().controls,[]);
  assert.deepEqual(['button','text','number','select','toggle','display'].map(type=>newRibbonControl(type).value),[null,'',0,'',false,'']);
  for(const type of ['button','text','number','select','toggle','display'])assert.ok(validRibbonKey(newRibbonControl(type).key));
  for(const key of ['日本語_1','name-2','_value'])assert.equal(validRibbonKey(key),true);
  for(const key of ['a.b',' space','1first','__proto__','constructor',''])assert.equal(validRibbonKey(key),false);
});

test('full backup keeps typed values, options, conditions, actions and an inactive ribbon',()=>{
  const ws=sample(),control=first(ws);control.type='display';control.value={zero:0,no:false,empty:'',rows:[null,'日本語']};
  control.visibleWhen=condition('store','finished','eq',true);
  control.actions=[{id:'action',type:'activate',target:ws.ribbons[0].id,when:condition('ribbon',control.id,'notEmpty')}];
  ws.activeRibbonId='';assert.equal(validRibbons(ws.ribbons),true);
  assert.deepEqual(readWorkspaceBundle(exportWorkspace(ws)).workspace,ws);
});

test('invalid nested definitions and duplicate references reject imports without changing either workspace',()=>{
  const cases=[
    ws=>{ws.ribbons={};},ws=>{ws.activeRibbonId='missing';},ws=>{ws.ribbons[0].key='invalid.key';},
    ws=>{ws.ribbons.push(clone(ws.ribbons[0]));},ws=>{ws.ribbons[0].groups[0].controls.push({...clone(first(ws)),id:'second'});},
    ws=>{first(ws).type='unknown';},ws=>{first(ws).value=42;},ws=>{first(ws).visible='false';},
    ws=>{first(ws).visibleWhen=condition('ribbon','value','execute','code');},
    ws=>{first(ws).visibleWhen={mode:'all',rules:[{source:'ribbon',key:null,operator:'truthy'}]};},
    ws=>{first(ws).options=[{value:'same',label:'A'},{value:'same',label:'B'}];},
    ws=>{first(ws).actions=[{id:'action',type:'script',scriptId:2}];},
    ws=>{ws.ribbonBindings={binding:{controls:{value:4}}};}
  ];
  for(const corrupt of cases) {
    const source=sample(),into=sample(),before=clone(into);corrupt(source);
    assert.equal(validRibbonWorkspace(source),false);
    assert.throws(()=>readWorkspaceBundle({kind:'minipost.workspace',version:1,workspace:source}));
    assert.throws(()=>mergeWorkspace(into,source));assert.deepEqual(into,before);
  }
});

test('controls resolve stable IDs, qualified keys, active-local keys and unique inactive keys',()=>{
  const ws=sample(),other=ribbon('Other','other');ws.ribbons.push(other);
  const one=first(ws),two=other.groups[0].controls[0];
  assert.equal(resolveRibbonControl(ws,one.id).control,one);
  assert.equal(resolveRibbonControl(ws,'other.value').control,two);
  assert.equal(resolveRibbonControl(ws,'value').control,one);
  assert.equal(resolveRibbonControl(ws,'value',{ribbonId:other.id}).control,two);
  ws.activeRibbonId=other.id;assert.equal(resolveRibbonControl(ws,'value').control,two);
  ws.activeRibbonId='';assert.throws(()=>resolveRibbonControl(ws,'value'),/重複/);
  two.key='unique';assert.equal(resolveRibbonControl(ws,'unique').control,two);
  assert.throws(()=>resolveRibbonControl(ws,'Value'),/見つかりません/);
  assert.equal(listRibbonControls(ws)[1].reference,'other.unique');
});

test('ribbon name collisions are explicit and caller bindings never fall back to an unrelated target',()=>{
  const ws=sample();ws.ribbons.push(ribbon('tools','second'));
  assert.throws(()=>resolveRibbon(ws,'tools'),/重複/);
  assert.equal(resolveRibbon(ws,ws.ribbons[0].id),ws.ribbons[0]);
  ws.ribbonBindings={scope:{ribbons:{tools:ws.ribbons[1].id},controls:{value:first(ws).id}}};
  assert.equal(resolveRibbon(ws,'tools',{bindingId:'scope'}),ws.ribbons[1]);
  assert.equal(resolveRibbonControl(ws,'value',{bindingId:'scope'}).control,first(ws));
  ws.ribbonBindings.scope.controls.value='deleted';
  assert.throws(()=>resolveRibbonControl(ws,'value',{bindingId:'scope'}),/見つかりません/);
  ws.activeRibbonId='';assert.throws(()=>resolveRibbon(ws),/選択/);
});

test('typed normalization rejects ambiguous booleans, nonfinite numbers, invalid options and non-JSON displays',()=>{
  assert.equal(normalizeRibbonValue({type:'text'},42),'42');assert.equal(normalizeRibbonValue({type:'text'},null),'');
  assert.equal(normalizeRibbonValue({type:'number'},'12.5'),12.5);assert.equal(normalizeRibbonValue({type:'number'},''),null);
  assert.equal(normalizeRibbonValue({type:'number'},null),null);assert.equal(normalizeRibbonValue({type:'toggle'},false),false);
  assert.equal(normalizeRibbonValue({type:'select',options:[]},''),'');
  assert.equal(normalizeRibbonValue({type:'select',options:[{value:'prod',label:'Production'}]},'prod'),'prod');
  const data={a:[0,false,null]};const normalized=normalizeRibbonValue({type:'display'},data);assert.deepEqual(normalized,data);assert.notEqual(normalized,data);
  const cycle={};cycle.self=cycle;
  for(const [type,value] of [['toggle','false'],['toggle',0],['number',false],['number',Infinity],['number','bad'],['number',[]],['text',{}],['select','missing'],['display',undefined],['display',cycle],['display',new Date()],['display',new Array(2)]])
    assert.throws(()=>normalizeRibbonValue({type,options:[]},value));
});

test('conditions use typed equality, numeric comparisons, all/any and live value scopes',()=>{
  const ws=sample(),control=first(ws),primary=new PrimaryVariables();control.type='number';control.value=0;
  ws.scriptData={progress:{count:3},done:false,'literal.dot':'direct'};
  ws.globals=[{key:'target',value:'global'},{key:'disabled',value:'ignore',disabled:true}];
  ws.environments=[{id:'env',name:'QA',values:[{key:'target',value:'environment'}]}];ws.environmentId='env';primary.set('target','primary');
  const context={workspace:ws,primary};
  for(const [rule,expected] of [
    [condition('ribbon','tools.value','eq',0),true],[condition('ribbon','tools.value','eq',false),false],
    [condition('ribbon','tools.value','eq','0'),false],[condition('ribbon','tools.value','empty'),false],
    [condition('ribbon','tools.value','falsy'),true],[condition('store','progress.count','gte','3'),true],
    [condition('store','done','eq',false),true],[condition('store','literal.dot','eq','direct'),true],
    [condition('globals','target','eq','global'),true],[condition('environment','target','eq','environment'),true],
    [condition('variables','target','eq','primary'),true],[condition('globals','disabled','empty'),true],
    [condition('ribbon','deleted','ne',1),false]
  ])assert.equal(evaluateRibbonCondition(rule,context),expected,JSON.stringify(rule));
  assert.equal(evaluateRibbonCondition({mode:'any',rules:[...condition('store','done','truthy').rules,...condition('store','progress.count','eq',3).rules]},context),true);
  assert.equal(evaluateRibbonCondition({mode:'all',rules:[]},context),true);
  assert.equal(evaluateRibbonCondition({mode:'any',rules:[]},context),true);
  for(const mode of ['any','all'])assert.equal(evaluateRibbonCondition({mode,rules:[{source:'ribbon',key:'',operator:'falsy'}]},context),false);
  primary.unset('target');assert.equal(evaluateRibbonCondition(condition('variables','target','eq','environment'),context),true);
  assert.equal(evaluateRibbonCondition(condition('variables','target','eq','global'),{...context,environment:null}),true);
});

test('conditional visibility and enabled state update without mutating definitions',()=>{
  const ws=sample(),control=first(ws),before=clone(control);
  control.visibleWhen=condition('store','visible','eq',true);control.enabledWhen=condition('ribbon',control.id,'notEmpty');
  const context={workspace:ws};assert.deepEqual(ribbonControlState(control,context),{visible:false,enabled:false});
  ws.scriptData={visible:true};control.value='ready';assert.deepEqual(ribbonControlState(control,context),{visible:true,enabled:true});
  control.visible=false;assert.deepEqual(ribbonControlState(control,context),{visible:false,enabled:true});
  assert.equal(before.value,'');assert.equal(Object.hasOwn(control,'computedVisible'),false);
});

test('all script ribbon writes validate before commit and retain live object identities',()=>{
  const ws=sample(),control=first(ws),other=ribbon('Other','other');ws.ribbons.push(other);
  const untouched=other.groups[0].controls[0];untouched.value='edited while running';
  const commit=prepareRibbonWrites(ws,[{type:'value',id:control.id,value:'updated',expected:''},{type:'enabled',id:control.id,value:false,expected:true},{type:'activate',id:other.id,value:other.id,expected:ws.activeRibbonId}]);
  assert.equal(control.value,'');assert.equal(ws.activeRibbonId,ws.ribbons[0].id);
  assert.equal(commit(),true);assert.equal(first(ws),control);assert.equal(control.value,'updated');assert.equal(control.enabled,false);assert.equal(ws.activeRibbonId,other.id);
  assert.equal(untouched.value,'edited while running');
  assert.equal(prepareRibbonWrites(ws,[{type:'value',id:control.id,value:'updated',expected:'updated'}])(),false);
});

test('a late invalid write or concurrent same-target edit leaves every ribbon property untouched',()=>{
  const ws=sample(),control=first(ws);control.value='manual';const before=clone(ws);
  for(const writes of [
    [{type:'visible',id:control.id,value:false,expected:true},{type:'value',id:control.id,value:'script',expected:''}],
    [{type:'value',id:control.id,value:'script',expected:'manual'},{type:'enabled',id:control.id,value:'false'}],
    [{type:'value',id:control.id,value:'script',expected:'manual',expectedShape:{type:'number',options:[]}}],
    [{type:'activate',id:ws.ribbons[0].id,value:ws.ribbons[0].id,expected:'other'}],
    [{type:'value',id:'gone',value:'script'}]
  ]){assert.throws(()=>prepareRibbonWrites(ws,writes));assert.deepEqual(ws,before);}
  assert.equal(prepareRibbonWrites(ws,[])(),false);assert.deepEqual(ws,before);
});

test('multiple writes from one action chain accept original or staged expected values',()=>{
  const ws=sample(),control=first(ws);
  const commit=prepareRibbonWrites(ws,[{type:'value',id:control.id,value:'first',expected:''},{type:'value',id:control.id,value:'second',expected:'first'},{type:'value',id:control.id,value:'last',expected:''}]);
  assert.equal(commit(),true);assert.equal(control.value,'last');
});

test('staged writes resolve IDs only, so deleted identities cannot hit a matching live key or name',()=>{
  const ws=sample(),control=first(ws);control.key='deleted_control';ws.ribbons[0].name='deleted_ribbon';const before=clone(ws);
  assert.throws(()=>prepareRibbonWrites(ws,[{type:'value',id:'deleted_control',value:'wrong',expected:''}]),/見つかりません/);
  assert.throws(()=>prepareRibbonWrites(ws,[{type:'activate',id:'deleted_ribbon',value:'deleted_ribbon',expected:ws.activeRibbonId}]),/見つかりません/);
  assert.deepEqual(ws,before);
});

test('appending remaps ribbon and script references, preserves existing values and keeps source immutable',()=>{
  const source=sample(),control=first(source),other=ribbon('Other','other');source.ribbons.push(other);
  const script={...newScript('Transform'),id:'script'};source.scripts=[script];
  control.visibleWhen=condition('ribbon','tools.value','eq','ready');
  control.actions=[
    {id:'script-action',type:'script',scriptId:script.id},
    {id:'set-action',type:'set',target:control.id,value:'written',when:condition('ribbon','value','empty')},
    {id:'toggle-action',type:'toggle',target:control.id},
    {id:'activate-action',type:'activate',target:'other'}
  ];
  control.value='source';const original=clone(source),into=sample();first(into).value='local';into.scripts=[{...newScript('Local'),id:'script'}];
  const oldRibbon=into.ribbons[0],oldControl=first(into);mergeWorkspace(into,source);
  assert.deepEqual(source,original);assert.equal(first(into),oldControl);assert.equal(oldControl.value,'local');assert.equal(into.activeRibbonId,oldRibbon.id);
  const imported=into.ribbons[1],importedControl=imported.groups[0].controls[0],importedOther=into.ribbons[2];
  assert.equal(imported.key,'tools_2');assert.notEqual(imported.id,source.ribbons[0].id);assert.notEqual(imported.groups[0].id,source.ribbons[0].groups[0].id);assert.notEqual(importedControl.id,control.id);
  assert.equal(importedControl.visibleWhen.rules[0].key,importedControl.id);
  assert.equal(importedControl.actions[0].scriptId,into.scripts[1].id);
  assert.equal(importedControl.actions[1].target,importedControl.id);assert.equal(importedControl.actions[1].when.rules[0].key,importedControl.id);
  assert.equal(importedControl.actions[2].target,importedControl.id);assert.equal(importedControl.actions[3].target,importedOther.id);
  assert.notEqual(importedControl.actions[0].id,'script-action');
  assert.equal(validRibbonWorkspace(into),true);
});

test('repeated imports bind literal ribbon keys and IDs to the matching script group through another backup',()=>{
  const source=sample();source.scripts=[{...newScript('Read'),id:'reader',source:'return ribbon.get("tools.value")'}];
  const original=clone(source),combined=clone(source);mergeWorkspace(combined,source);mergeWorkspace(combined,source);
  assert.deepEqual(source,original);assert.deepEqual(combined.ribbons.map(ribbon=>ribbon.key),['tools','tools_2','tools_3']);
  for(let index=0;index<3;index++) {
    const script=combined.scripts[index],ribbon=combined.ribbons[index],control=ribbon.groups[0].controls[0];
    assert.equal(resolveRibbon(combined,'Tools',{bindingId:script.bindingId}),ribbon);
    assert.equal(resolveRibbon(combined,source.ribbons[0].id,{bindingId:script.bindingId}),ribbon);
    assert.equal(resolveRibbonControl(combined,'tools.value',{bindingId:script.bindingId}).control,control);
    assert.equal(resolveRibbonControl(combined,first(source).id,{bindingId:script.bindingId}).control,control);
  }
  const restored=readWorkspaceBundle(exportWorkspace(combined)).workspace,destination=sample();mergeWorkspace(destination,restored);
  for(let index=0;index<3;index++) assert.equal(resolveRibbonControl(destination,'tools.value',{bindingId:destination.scripts[index].bindingId}).control,destination.ribbons[index+1].groups[0].controls[0]);
});

test('imported missing structured targets never bind to existing local controls or scripts',()=>{
  const source=sample(),control=first(source),into=sample();into.scripts=[{...newScript('Missing'),id:'missing-script'}];
  first(into).id='missing-control';
  control.actions=[{id:'action-set',type:'set',target:'missing-control',value:'wrong'},{id:'action-script',type:'script',scriptId:'missing-script'}];
  control.enabledWhen=condition('ribbon','missing-control','truthy');mergeWorkspace(into,source);
  const imported=into.ribbons[1].groups[0].controls[0];
  assert.notEqual(imported.actions[0].target,'missing-control');assert.throws(()=>resolveRibbonControl(into,imported.actions[0].target));
  assert.notEqual(imported.actions[1].scriptId,'missing-script');assert.equal(into.scripts.some(script=>script.id===imported.actions[1].scriptId),false);
  assert.equal(evaluateRibbonCondition(imported.enabledWhen,{workspace:into}),false);
});

test('ambiguous bare control keys stay dynamic when a script changes active ribbon after import',()=>{
  const source=sample();source.ribbons.push(ribbon('Other','other'));source.scripts=[{...newScript('Switch'),id:'script'}];
  const into=workspace();mergeWorkspace(into,source);const bindingId=into.scripts[0].bindingId;
  assert.equal(Object.hasOwn(into.ribbonBindings[bindingId].controls,'value'),false);
  assert.equal(resolveRibbonControl(into,'value',{bindingId}).ribbon,into.ribbons[0]);
  into.activeRibbonId=into.ribbons[1].id;assert.equal(resolveRibbonControl(into,'value',{bindingId}).ribbon,into.ribbons[1]);
});
