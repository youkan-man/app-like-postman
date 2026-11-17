import test from 'node:test';
import assert from 'node:assert/strict';
import {clone,newRequest} from '../static/core.mjs';
import {newScript,ensureScripts,parseScriptInput,validScripts,validScriptData,validScriptBindings,applyScriptWrites} from '../static/scripts.mjs';
import {PrimaryVariables,requestAutomation} from '../static/runtime.mjs';
import {exportWorkspace,readWorkspaceBundle,mergeWorkspace} from '../static/workspace-data.mjs';
import {RevisionStore} from '../static/revisions.mjs';
import {executeRequest} from '../static/execution.mjs';
import {executeScript} from '../static/script-worker.mjs';
import {completionContext,signatureHelp} from '../static/script-intelligence.mjs';

function workspace() {
  const request=newRequest();request.url='https://example.test/{{token}}';
  return {version:2,collections:[{_mpId:'collection',info:{name:'Collection'},item:[{_mpId:'item',name:'Request',request}]}],
    environments:[{id:'env',name:'Environment',values:[{key:'token',value:'original'}]}],environmentId:'env',globals:[],
    tabs:[{id:'draft',collectionId:'collection',itemId:'item',name:'Request',request:clone(request),settings:{}}],
    history:[],revisions:{},collapsed:[]};
}
const saved=(id,name=id,source='return input')=>({...newScript(name),id,source});
const output=(overrides={})=>({writes:{primary:[],environment:[],globals:[]},dataWrites:[],logs:[],...overrides});
const response=()=>({status:200,status_text:'OK',body:'{"count":3}',body_encoding:'text',headers:[],elapsed_ms:1,size:11});

test('saved scripts exist without any request and retain arbitrary input/source through a full backup',()=>{
  const ws=workspace();ws.collections=[];ws.tabs=[];ensureScripts(ws);
  const first=newScript('Transform');first.source='return input.map(row => row.value * 2)';first.input='[{"value":2}]';
  const second=newScript('Transform');second.inputFormat='text';second.input='plain\ntext';
  ws.scripts.push(first,second);ws.scriptData={values:[0,false,null,{text:'日本語'}]};
  const restored=readWorkspaceBundle(exportWorkspace(ws)).workspace;
  assert.deepEqual(restored,ws);assert.notEqual(first.id,second.id);assert.equal(first.timeoutMs,0);
  assert.deepEqual(parseScriptInput(first),[{value:2}]);assert.equal(parseScriptInput(second),'plain\ntext');
  first.input='{unfinished';assert.throws(()=>parseScriptInput(first),/JSON/);
});

test('old backups stay compatible and initializing scripts does not change existing requests',()=>{
  const old=workspace(),before=clone(old),restored=readWorkspaceBundle(exportWorkspace(old)).workspace;
  assert.deepEqual(restored,before);ensureScripts(restored);
  assert.deepEqual(restored.scripts,[]);assert.deepEqual(restored.scriptData,{});assert.deepEqual(restored.collections,before.collections);
});

test('malformed script collections and data are rejected before import mutates state',()=>{
  const good=workspace();good.scripts=[saved('script')];good.scriptData={value:1};
  for(const corrupt of [
    ws=>{ws.scripts={};},ws=>{ws.scripts[0].source=1;},ws=>{ws.scripts[0].input=null;},
    ws=>{ws.scripts[0].inputFormat='binary';},ws=>{ws.scripts[0].timeoutMs=-1;},
    ws=>{ws.scripts.push(clone(ws.scripts[0]));},ws=>{ws.scriptData=[];},ws=>{ws.scriptData.bad=undefined;},
    ws=>{ws.tabs[0].request._minipost={beforeScriptId:123};}
  ]) {
    const changed=clone(good);corrupt(changed);
    assert.throws(()=>readWorkspaceBundle({kind:'minipost.workspace',version:1,workspace:changed}));
  }
  const corrupt=clone(good);corrupt.scripts[0].source=42;const into=workspace(),before=clone(into);
  assert.throws(()=>mergeWorkspace(into,corrupt));assert.deepEqual(into,before);
  assert.equal(validScripts(good.scripts),true);assert.equal(validScriptData({value:Infinity}),false);
});

test('merging scripts remaps request, draft, history and revision references while preserving existing shared keys',()=>{
  const incoming=workspace();incoming.scripts=[saved('first','Same'),saved('second','Same')];
  const hook={beforeScriptId:'first',afterScriptId:'second',before:'legacy before',after:'legacy after'};
  incoming.collections[0].item[0].request._minipost=clone(hook);incoming.tabs[0].request._minipost=clone(hook);
  incoming.history=[{id:'history',tab:clone(incoming.tabs[0])}];
  incoming.revisions={
    'request:collection:item':[{value:{name:'Request',request:clone(incoming.tabs[0].request)}}],
    'script:first':[{value:(({id,...rest})=>rest)(incoming.scripts[0])}]
  };
  incoming.settingHistory={'draft:draft':[{before:{request:clone(incoming.tabs[0].request)},after:{request:clone(incoming.tabs[0].request)}}]};
  incoming.scriptData=JSON.parse('{"same":"incoming","new":[1,false],"__proto__":{"saved":true}}');
  const original=clone(incoming),into=workspace();into.scripts=[saved('first','Same')];into.scriptData={same:null};
  mergeWorkspace(into,incoming);
  assert.deepEqual(incoming,original);assert.equal(into.scripts.length,3);assert.equal(into.scripts[0].id,'first');
  const [beforeId,afterId]=into.scripts.slice(1).map(script=>script.id);
  assert.notEqual(beforeId,'first');assert.notEqual(afterId,'second');assert.notEqual(beforeId,afterId);
  const requests=[into.collections[1].item[0].request,into.tabs[1].request,into.history[0].tab.request];
  const revision=into.revisions[`request:${into.collections[1]._mpId}:${into.collections[1].item[0]._mpId}`][0].value.request;
  requests.push(revision,...Object.values(into.settingHistory)[0].flatMap(entry=>[entry.before.request,entry.after.request]));
  for(const request of requests){assert.equal(request._minipost.beforeScriptId,beforeId);assert.equal(request._minipost.afterScriptId,afterId);assert.equal(request._minipost.before,'legacy before');}
  assert.equal(into.revisions[`script:${beforeId}`][0].value.source,'return input');
  assert.equal(into.scriptData.same,null);assert.deepEqual(into.scriptData.new,[1,false]);
  assert.ok(Object.hasOwn(into.scriptData,'__proto__'));assert.deepEqual(into.scriptData.__proto__,{saved:true});assert.equal({}.saved,undefined);
});

test('an imported dangling script reference never binds to an unrelated existing script with the same ID',()=>{
  const incoming=workspace(),into=workspace();incoming.tabs[0].request._minipost={beforeScriptId:'missing'};
  into.scripts=[saved('missing')];mergeWorkspace(into,incoming);
  const reference=into.tabs[1].request._minipost.beforeScriptId;
  assert.notEqual(reference,'missing');assert.equal(into.scripts.some(script=>script.id===reference),false);
});

test('script revisions restore code, input and timeout while retaining identity and excluding shared data',()=>{
  const ws=workspace();ensureScripts(ws);const script=saved('script');ws.scripts.push(script);const history=new RevisionStore(ws);
  script.name='Renamed';script.source='return input * 2';script.input='4';script.inputFormat='json';script.timeoutMs=120;
  ws.scriptData.result={answer:8};history.capture();
  assert.deepEqual(Object.keys(ws.revisions),['script:script']);assert.equal(ws.revisions['script:script'].length,2);
  history.restore('script:script',ws.revisions['script:script'][0]);
  assert.equal(script.id,'script');assert.equal(script.source,'return input');assert.equal(script.input,'null');assert.equal(script.timeoutMs,0);
  assert.deepEqual(ws.scriptData,{result:{answer:8}});assert.equal(ws.revisions['script:script'].at(-1).reason,'復元');
  assert.deepEqual(readWorkspaceBundle(exportWorkspace(ws)).workspace.revisions,ws.revisions);
});

test('successful writes commit JSON data and variable scopes while preserving unrelated changes',()=>{
  const ws=workspace(),primary=new PrimaryVariables();primary.set('untouched','yes');ws.scriptData={keep:false,remove:1};
  const result=output({writes:{primary:[{key:' token ',value:'next'}],environment:[{key:'number',value:0}],globals:[{key:'object',value:{a:1}}]},
    dataWrites:[{key:'remove',remove:true},{key:'rows',value:[null,false,2]},{key:'__proto__',value:{safe:true}}]});
  assert.equal(applyScriptWrites(ws,primary,ws.environments[0],result),true);
  assert.equal(primary.get('token'),'next');assert.equal(primary.get('untouched'),'yes');
  assert.equal(ws.environments[0].values.find(row=>row.key==='number').value,'0');assert.equal(ws.globals[0].value,'{"a":1}');
  assert.deepEqual(ws.scriptData.rows,[null,false,2]);assert.equal(ws.scriptData.keep,false);assert.equal(Object.hasOwn(ws.scriptData,'remove'),false);
  assert.ok(Object.hasOwn(ws.scriptData,'__proto__'));assert.equal({}.safe,undefined);
  result.dataWrites[1].value.push('mutated');assert.deepEqual(ws.scriptData.rows,[null,false,2]);
});

test('missing environment and invalid late writes leave every scope unchanged',()=>{
  const circular={};circular.self=circular;
  for(const broken of [
    {environment:null,writes:{primary:[{key:'new',value:'x'}],environment:[{key:'x',value:'y'}],globals:[]}},
    {writes:{primary:[{key:'new',value:'x'}],environment:[],globals:[{key:'{invalid}',value:1}]}},
    ...[undefined,Infinity,1n,new Date(),circular].map(value=>({writes:{primary:[{key:'new',value:'x'}],environment:[{key:'token',value:'changed'}],globals:[]},dataWrites:[{key:'first',value:1},{key:'bad',value}]}))
  ]) {
    const ws=workspace(),primary=new PrimaryVariables();ws.scriptData={keep:1};primary.set('old','y');const before=clone(ws);
    assert.throws(()=>applyScriptWrites(ws,primary,broken.environment===null?null:ws.environments[0],output(broken)));
    assert.deepEqual(ws,before);assert.deepEqual(primary.snapshot(),{old:'y'});
  }
});

test('script writes retain the arrays and row objects held by open environment and Globals editors',()=>{
  const ws=workspace(),primary=new PrimaryVariables(),environment=ws.environments[0];
  environment.values.push({key:'editing',value:'before'});ws.globals.push({key:'count',value:'1'},{key:'note',value:'before'});
  const environmentRows=environment.values,globalsRows=ws.globals;
  const [tokenRow,editingRow]=environmentRows,[countRow,noteRow]=globalsRows;
  applyScriptWrites(ws,primary,environment,output({writes:{primary:[],environment:[{key:'token',value:'from script'}],globals:[{key:'count',value:2}]}}));
  assert.equal(environment.values,environmentRows);assert.equal(ws.globals,globalsRows);
  assert.equal(environment.values[0],tokenRow);assert.equal(environment.values[1],editingRow);
  assert.equal(ws.globals[0],countRow);assert.equal(ws.globals[1],noteRow);
  assert.equal(tokenRow.value,'from script');assert.equal(countRow.value,'2');
  // kvEditor callbacks retain their row/list references while a script runs.
  editingRow.value='typed after script';noteRow.value='saved from open editor';
  environmentRows.push({key:'added in open editor',value:'yes'});globalsRows.splice(0,1);
  const persisted=clone(ws);
  assert.equal(persisted.environments[0].values.find(row=>row.key==='editing').value,'typed after script');
  assert.equal(persisted.environments[0].values.at(-1).key,'added in open editor');
  assert.deepEqual(persisted.globals,[{key:'note',value:'saved from open editor'}]);
});

test('primary variable editors retain their row references after script output is applied',()=>{
  let saved;
  const primary=new PrimaryVariables({getItem:()=>null,setItem:(_key,value)=>{saved=JSON.parse(value);}});
  primary.set('token','old');primary.set('editing','before');
  const list=primary.rows,[tokenRow,editingRow]=list;
  applyScriptWrites(workspace(),primary,null,output({writes:{primary:[{key:'token',value:'script'}],environment:[],globals:[]}}));
  assert.equal(primary.rows,list);assert.equal(primary.rows[0],tokenRow);assert.equal(primary.rows[1],editingRow);
  assert.equal(tokenRow.value,'script');editingRow.value='typed after script';primary.save();
  assert.equal(saved.find(row=>row.key==='editing').value,'typed after script');
  const before=clone(primary.rows);
  assert.throws(()=>primary.apply([{key:'token',value:'should not commit'},{key:'',value:1}]));
  assert.deepEqual(primary.rows,before);assert.equal(primary.rows,list);
});

test('JSON data accepts arbitrary object keys and shared references but rejects cycles and sparse arrays',()=>{
  const value={number:1};assert.equal(validScriptData({left:value,right:value,leave:true,value:{leave:true}}),true);
  assert.equal(validScriptData({array:[0,false,null]}),true);assert.equal(validScriptData({array:new Array(2)}),false);
  const circular={};circular.circular=circular;assert.equal(validScriptData(circular),false);
});

test('saved hooks receive generic input, snapshots, host API and logs and commit returned data',async()=>{
  const ws=workspace(),primary=new PrimaryVariables(),tab=ws.tabs[0],events=[],flags=[],logs=[],calls=[];
  ws.scripts=[saved('before','Prepare','before source'),saved('after','Transform','after source')];ws.scriptData={prior:{value:1}};
  tab.request._minipost={beforeScriptId:'before',afterScriptId:'after',before:'do not execute',after:'do not execute'};
  const host=async()=>({ok:true});
  const result=await executeRequest({workspace:ws,tab,primary,scriptCall:host,onScriptLog:entry=>logs.push(entry),onScript:entry=>events.push(entry),onVariables:value=>flags.push(value),
    script:async(source,context,options)=>{
      calls.push(source);assert.equal(options.onCall,host);assert.equal(options.timeoutMs,0);assert.equal(context.scripts.length,2);
      options.onLog({level:'log',message:source});
      if(source==='before source'){
        assert.equal(context.input.method,'GET');assert.equal(context.scriptId,'before');assert.deepEqual(context.data,{prior:{value:1}});
        return output({writes:{primary:[{key:'token',value:'prepared'}],environment:[],globals:[]},dataWrites:[{key:'prepared',value:[2,3]}],result:{phase:'before'}});
      }
      assert.equal(context.input.status,200);assert.deepEqual(context.input.body,{count:3});assert.deepEqual(context.data.prepared,[2,3]);
      return output({result:[4,5]});
    },send:async payload=>{assert.equal(payload.url,'https://example.test/prepared');ws.scripts[1].source='changed while waiting';return response();}});
  assert.deepEqual(calls,['before source','after source']);assert.deepEqual(events.map(entry=>entry.result),[{phase:'before'},[4,5]]);
  assert.deepEqual(logs.map(entry=>entry.phase),['before','after']);assert.ok(flags.includes(true));assert.equal(result.status,200);
});

test('legacy inline hooks retain their timeout and context when no saved script is selected',async()=>{
  const ws=workspace(),primary=new PrimaryVariables(),tab=ws.tabs[0];tab.request._minipost={before:'legacy',afterScriptId:''};
  assert.equal(requestAutomation(tab.request).timeoutMs,5000);let runs=0;
  await executeRequest({workspace:ws,tab,primary,send:async()=>response(),script:async(source,context,options)=>{
    runs++;assert.equal(source,'legacy');assert.equal(context.request.method,'GET');assert.equal(options.timeoutMs,5000);
    return output({writes:{primary:[{key:'token',value:'compatible'}],environment:[],globals:[]}});
  }});
  assert.equal(runs,1);assert.equal(primary.get('token'),'compatible');
});

test('missing saved before hook stops HTTP and missing after hook preserves the response',async()=>{
  for(const phase of ['before','after']) {
    const ws=workspace(),primary=new PrimaryVariables(),tab=ws.tabs[0];let sends=0,runs=0;
    tab.request._minipost={[`${phase}ScriptId`]:'gone',[phase]:'legacy must not replace missing reference'};
    const task=executeRequest({workspace:ws,tab,primary,script:async()=>{runs++;return output();},send:async()=>{sends++;return response();}});
    if(phase==='before')await assert.rejects(task,/スクリプトが見つかりません/);
    else {const result=await task;assert.equal(result.status,200);assert.match(result.automationErrors[0],/スクリプトが見つかりません/);}
    assert.equal(sends,phase==='before'?0:1);assert.equal(runs,0);
  }
});

test('failed or cancelled saved hook results never partially commit script data or variables',async()=>{
  for(const cancelled of [false,true]) {
    const ws=workspace(),primary=new PrimaryVariables(),tab=ws.tabs[0],controller=new AbortController();ws.scripts=[saved('saved')];ws.scriptData={old:1};
    tab.request._minipost={beforeScriptId:'saved'};let sends=0;
    await assert.rejects(executeRequest({workspace:ws,tab,primary,signal:controller.signal,send:async()=>{sends++;return response();},script:async()=>{
      if(cancelled)controller.abort();return output({writes:{primary:[{key:'new',value:1}],environment:[],globals:[]},dataWrites:[{key:'bad',value:undefined}]});
    }}));
    assert.deepEqual(primary.snapshot(),{});assert.deepEqual(ws.scriptData,{old:1});assert.equal(sends,0);
  }
});

test('standalone APIs provide completions and signatures without requiring request code',()=>{
  const names=source=>completionContext(source)?.items.map(item=>item.label)||[];
  assert.ok(names('inp').includes('input'));assert.deepEqual(names('scripts.r'),['run']);assert.deepEqual(names('store.k'),['keys']);
  assert.deepEqual(names('minipost.requests.s'),['send']);assert.deepEqual(names('minipost.environments.g'),['get']);
  assert.deepEqual(names('minipost.store.d'),['delete']);assert.deepEqual(names('minipost.variables.s'),['set']);
  assert.equal(signatureHelp('scripts.run("Normalize", ').argument,1);assert.equal(signatureHelp('minipost.workspace.read(').name,'minipost.workspace.read');
});

function reusableWorkspace() {
  const ws=workspace();
  ws.scripts=[saved('parent-original','Parent','return [await scripts.run("child-original", input), await minipost.scripts.run("Child", input)];'),
    saved('child-original','Child','return "original";')];
  return ws;
}
const runSaved=async(ws,script)=>executeScript(script.source,{scripts:ws.scripts,bindings:ws.scriptBindings,scriptId:script.id,input:null});

test('adding the same backup twice preserves each original-ID and unique-name call without rewriting code',async()=>{
  const source=reusableWorkspace(),sourceBefore=clone(source),into=clone(source);
  const revision=new RevisionStore(into);into.scripts[0].input='1';revision.capture();
  const backup=readWorkspaceBundle(exportWorkspace(source)).workspace;
  mergeWorkspace(into,backup);mergeWorkspace(into,backup);
  assert.deepEqual(source,sourceBefore);assert.deepEqual(backup,sourceBefore);
  const parents=into.scripts.filter(script=>script.name==='Parent'),children=into.scripts.filter(script=>script.name==='Child');
  assert.equal(parents.length,3);assert.equal(new Set(into.scripts.map(script=>script.bindingId)).size,3);
  assert.equal(Object.keys(into.scriptBindings).length,3); // One dictionary per group, shared by its scripts.
  for (const [index,child] of children.entries()) child.source=`return ${JSON.stringify(['original','first copy','second copy'][index])};`;
  for (const [index,parent] of parents.entries()) {
    assert.equal(parent.source,source.scripts[0].source);
    assert.equal(parent.bindingId,children[index].bindingId);
    assert.equal(into.scriptBindings[parent.bindingId]['child-original'],children[index].id);
    assert.equal(into.scriptBindings[parent.bindingId].Child,children[index].id);
    assert.deepEqual((await runSaved(into,parent)).result,Array(2).fill(['original','first copy','second copy'][index]));
  }
  assert.equal(into.revisions['script:parent-original'][0].value.bindingId,parents[0].bindingId);
  new RevisionStore(into).restore('script:parent-original',into.revisions['script:parent-original'][0]);
  assert.deepEqual((await runSaved(into,parents[0])).result,['original','original']);
});

test('exporting and re-importing several copied script groups preserves old aliases and independent children',async()=>{
  const source=reusableWorkspace(),combined=clone(source);mergeWorkspace(combined,source);mergeWorkspace(combined,source);
  combined.scripts.filter(script=>script.name==='Child').forEach((script,index)=>{script.source=`return ${index};`;});
  const bundle=exportWorkspace(combined),restored=readWorkspaceBundle(bundle).workspace;
  assert.deepEqual(restored.scriptBindings,combined.scriptBindings);
  const destination=workspace();destination.scripts=[saved('child-original','Child','return "unrelated";')];
  mergeWorkspace(destination,restored);
  const imported=destination.scripts.slice(1),parents=imported.filter(script=>script.name==='Parent');
  for (const [index,parent] of parents.entries()) assert.deepEqual((await runSaved(destination,parent)).result,[index,index]);
  const firstChild=imported.find(script=>script.name==='Child'&&script.bindingId===parents[0].bindingId);
  firstChild.source='return "changed only here";';
  assert.deepEqual((await runSaved(destination,parents[0])).result,['changed only here','changed only here']);
  assert.deepEqual((await runSaved(destination,parents[1])).result,[1,1]);
  assert.equal((await runSaved(destination,destination.scripts[0])).result,'unrelated');
  destination.scripts=destination.scripts.filter(script=>script!==firstChild);
  await assert.rejects(runSaved(destination,parents[0]),/スクリプトが見つかりません/);
});

test('added inline request hooks and their historical versions use the same imported binding group',async()=>{
  const source=reusableWorkspace();
  const hook={before:'vars.set("token", await scripts.run("Child", input));',after:'return await scripts.run("child-original", input);'};
  source.tabs[0].request._minipost=clone(hook);source.collections[0].item[0].request._minipost=clone(hook);
  source.history=[{id:'history',tab:clone(source.tabs[0])}];
  source.revisions={'request:collection:item':[{value:{name:'Request',request:clone(source.tabs[0].request)}}]};
  const into=workspace();into.scripts=[saved('child-original','Child','return "unrelated";')];
  mergeWorkspace(into,source);mergeWorkspace(into,source);
  const importedParents=into.scripts.filter(script=>script.name==='Parent');
  for (const [index,parent] of importedParents.entries()) {
    const child=into.scripts.find(script=>script.name==='Child'&&script.bindingId===parent.bindingId);child.source=`return "copy-${index}";`;
    const tab=into.tabs[index+1],outputs=[];
    assert.equal(tab.request._minipost.scriptBindingId,parent.bindingId);
    assert.equal(requestAutomation(tab.request).scriptBindingId,parent.bindingId);
    assert.equal(into.history[index].tab.request._minipost.scriptBindingId,parent.bindingId);
    const collection=into.collections[index+1],key=`request:${collection._mpId}:${collection.item[0]._mpId}`;
    assert.equal(into.revisions[key][0].value.request._minipost.scriptBindingId,parent.bindingId);
    const result=await executeRequest({workspace:into,tab,primary:new PrimaryVariables(),script:executeScript,onScript:value=>outputs.push(value),send:async payload=>{
      assert.equal(payload.url,`https://example.test/copy-${index}`);return response();
    }});
    assert.deepEqual(result.automationErrors,[]);assert.equal(outputs.at(-1).result,`copy-${index}`);
  }
  // A saved hook owns its binding even when the request has a different inline binding.
  const otherTab=clone(into.tabs[2]);otherTab.request._minipost.afterScriptId=importedParents[0].id;
  const outputs=[];await executeRequest({workspace:into,tab:otherTab,primary:new PrimaryVariables(),script:executeScript,onScript:value=>outputs.push(value),send:async()=>response()});
  assert.deepEqual(outputs.at(-1).result,['copy-0','copy-0']);
});

test('existing unique-name inline hooks remain usable after same-name scripts are added',async()=>{
  const into=reusableWorkspace(),source=reusableWorkspace();
  into.tabs[0].request._minipost={before:'vars.set("token", await scripts.run("Child"));'};
  mergeWorkspace(into,source);into.scripts.at(-1).source='return "imported";';
  await executeRequest({workspace:into,tab:into.tabs[0],primary:new PrimaryVariables(),script:executeScript,send:async payload=>{
    assert.equal(payload.url,'https://example.test/original');return response();
  }});
});

test('binding metadata is optional for old backups and invalid binding dictionaries are rejected',()=>{
  const ws=reusableWorkspace();assert.equal(Object.hasOwn(newScript(),'bindingId'),false);
  assert.deepEqual(readWorkspaceBundle(exportWorkspace(ws)).workspace,ws);ensureScripts(ws);assert.deepEqual(ws.scriptBindings,{});
  assert.equal(validScriptBindings({group:{'original-id':'current-id','__proto__':'current-id'}}),true);
  for (const modify of [
    copy=>{copy.scriptBindings=[];},copy=>{copy.scriptBindings={group:{Child:17}};},
    copy=>{copy.scripts[0].bindingId=17;},copy=>{copy.tabs[0].request._minipost={scriptBindingId:17};}
  ]) {
    const broken=clone(ws);modify(broken);
    assert.throws(()=>readWorkspaceBundle({kind:'minipost.workspace',version:1,workspace:broken}));
  }
});
