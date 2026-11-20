import test from 'node:test';
import assert from 'node:assert/strict';
import {executeScript,scriptExecutorSource} from '../static/script-worker.mjs';
import {makeScriptContext,createScriptHost} from '../static/script-host.mjs';
import {applyScriptWrites} from '../static/scripts.mjs';
import {createWorkspaceModel,workspaceChanges,applyWorkspaceChanges} from '../static/workspace-api.mjs';
import {PrimaryVariables} from '../static/runtime.mjs';
import {validRibbonWorkspace} from '../static/ribbons.mjs';
import {validScripts,validScriptBindings} from '../static/scripts.mjs';
import {executeRequest} from '../static/execution.mjs';
import {normalizeRequest} from '../static/core.mjs';

const request=()=>({method:'GET',url:'https://example.invalid/start',header:[],body:{mode:'none',raw:''}});
const saved=(id,name=id,source='')=>({id,name,source,input:'null',inputFormat:'json',timeoutMs:0});
function fixture(){return {version:2,collections:[{_mpId:'collection',info:{name:'API'},item:[{_mpId:'request',name:'Fetch',request:request(),settings:{timeout_ms:30000}}]}],environments:[{id:'env',name:'Test',values:[{key:'host',value:'before',enabled:true}]}],environmentId:'env',globals:[{key:'global',value:'before',enabled:true}],tabs:[{id:'draft',name:'Draft',request:request(),settings:{}}],scripts:[saved('child')],scriptBindings:{},scriptData:{keep:1},relations:[],history:[],activeId:'draft',theme:'light'};}
const run=(workspace,primary,source,options={})=>executeScript(source,makeScriptContext(workspace,primary,{ribbonOwner:workspace.tabs[0]}),options);
const commit=(workspace,primary,output)=>applyScriptWrites(workspace,primary,workspace.environments.find(value=>value.id==='env'),output);

test('model CRUD builds collections, folders, requests and scripts with shared pending child changes',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();
  const output=await run(workspace,primary,`
    const collection=minipost.collections.create({name:'Generated'});
    const folder=minipost.folders.create({parent:collection.id,name:'Users'});
    minipost.collections.variables(collection.id).set('base','https://example.invalid');
    minipost.folders.variables(folder.id).set('version',2);
    const request=minipost.requests.create({parent:folder.id,name:'Create user',request:{method:'POST',url:'{{base}}/users',body:{mode:'raw',raw:'{}'}}});
    const child=scripts.create({name:'Write result',source:'minipost.requests.update(input,{request:{header:[{key:"X-Child",value:"yes"}]}});store.set("created",input);return minipost.requests.get(input);'});
    const result=await scripts.run(child.id,request.id);
    return {result,folder:minipost.folders.get(folder.id),variables:minipost.folders.variables(folder.id).toObject(),snapshot:minipost.workspace.read().collections.length};
  `);
  assert.equal(workspace.collections.length,1);assert.equal(workspace.scriptData.created,undefined);
  assert.equal(output.result.result.request.header[0].value,'yes');assert.deepEqual(output.result.variables,{version:'2'});assert.equal(output.result.snapshot,2);
  assert.equal(output.workspaceTransaction,true);assert.ok(output.workspaceWrites.every(change=>change.path.length));
  commit(workspace,primary,output);
  assert.equal(workspace.collections[1].item[0].item[0].request.method,'POST');assert.equal(workspace.scriptData.created,output.result.result.id);
  assert.equal(workspace.scripts[1].name,'Write result');
});

test('request, draft, environment and relation edits are typed and keep IDs stable',async()=>{
  const model=createWorkspaceModel(fixture()),api=model.api;
  const draft=api.drafts.create({name:'New draft',request:{method:'PUT',url:'https://example.invalid'}});
  assert.equal(api.drafts.update(draft.id,{settings:{verify_tls:true}}).id,draft.id);
  const environment=api.environments.create({name:'Production',values:[]});api.environments.variables(environment.id).set('token',false,{type:'secret'});
  assert.deepEqual(api.environments.variables(environment.id).list(),[{key:'token',value:'false',enabled:true,type:'secret'}]);
  api.environments.activate(environment.id);assert.equal(api.environments.active().id,environment.id);
  const relation=api.relations.create({name:'Flow',steps:[{id:'wait',type:'wait',delayMs:1}]});
  assert.equal(api.relations.update(relation.id,{repeat:2}).id,relation.id);
  assert.throws(()=>api.requests.update('collection:request',{id:'changed'}),/変更できません/);
  assert.throws(()=>api.drafts.update(draft.id,{settings:{verify_tls:'yes'}}),/真偽値/);
  assert.throws(()=>api.environments.update(environment.id,{values:{token:'x'}}),/配列/);
  assert.throws(()=>api.relations.update(relation.id,{steps:[{id:'same',type:'wait'},{id:'same',type:'wait'}]}),/重複/);
  assert.equal(api.drafts.get(draft.id).settings.verify_tls,true);
  assert.equal(api.environments.delete(environment.id),true);assert.equal(api.environments.active(),null);
});

test('all editable entity APIs round-trip snapshots, replace deleted fields and return detached normalized values',()=>{
  const model=createWorkspaceModel(fixture(),{requestRef:'draft:draft'}),api=model.api;
  const folder=api.folders.create({parent:'collection',name:'Folder'}),relation=api.relations.create({name:'Flow'});
  const ribbon=api.ribbons.create({key:'main',name:'Main'}),groups=api.ribbons.groups(ribbon.id),group=groups.create({name:'Group'}),controls=api.ribbons.controls(ribbon.id,group.id),control=controls.create({key:'count',label:'Count',type:'number',value:1});
  const cases=[
    [api.collections,'collection','name'],[api.folders,folder.id,'name'],[api.requests,'collection:request','name'],[api.drafts,'draft:draft','name'],
    [api.environments,'env','name'],[api.scripts,'child','name'],[api.relations,relation.id,'name'],[api.ribbons,ribbon.id,'name'],[groups,group.id,'name'],[controls,control.id,'label']
  ];
  for(const [scope,reference,label] of cases){
    const original=scope.get(reference);
    assert.deepEqual(scope.set(reference,original),original);
    assert.deepEqual(scope.set(reference,'metadata',{keep:{value:1},remove:'old'}),{keep:{value:1},remove:'old'});
    scope.set(reference,'obsolete','old');
    const next=scope.get(reference);next[label]+=' edited';delete next.metadata.remove;delete next.obsolete;
    const output=scope.set(reference,next);
    assert.equal(output[label],next[label]);assert.deepEqual(output.metadata,{keep:{value:1}});assert.equal(Object.hasOwn(output,'obsolete'),false);
    assert.equal(scope.get(reference,'metadata.remove'),undefined);assert.equal(scope.get(reference,'obsolete'),undefined);
    output.metadata.keep.value=999;assert.equal(scope.get(reference,['metadata','keep','value']),1);
    assert.equal(scope.set(reference,'id',original.id),original.id);
    const before=model.api.workspace.read(),invalid=scope.get(reference);invalid[label]='must roll back';invalid.id='changed';
    assert.throws(()=>scope.set(reference,invalid),/変更できません/);assert.deepEqual(model.api.workspace.read(),before);
  }
  assert.equal(controls.set(control.id,'value','7'),7);assert.equal(controls.get(control.id,'value'),7);
  assert.equal(api.requests.set('Fetch edited','name','Renamed request'),'Renamed request');
  const renamed=api.scripts.get('child');renamed.name='Renamed script';assert.equal(api.scripts.set('child edited',renamed).name,'Renamed script');
});

test('entity get and set share dot, bracket, pointer and array paths without exposing inherited properties',()=>{
  const model=createWorkspaceModel(fixture()),api=model.api.requests,ref='collection:request';
  api.set(ref,'metadata',{rows:[{value:'before'}],'literal.key':{'a/b':{'~value':0}},nullable:null});
  const paths=['metadata.rows[0].value','$.metadata.rows[0]["value"]','/metadata/rows/0/value',['metadata','rows',0,'value']];
  for(const [index,path] of paths.entries()){
    assert.equal(api.set({id:ref},path,index),index);
    for(const readPath of paths)assert.equal(api.get(ref,readPath),index);
  }
  assert.equal(api.set(ref,'metadata["literal.key"]["a/b"]["~value"]',8),8);
  assert.equal(api.get(ref,'/metadata/literal.key/a~1b/~0value'),8);
  assert.deepEqual(api.set(ref,['metadata','rows',1],{value:4}),{value:4});assert.equal(api.get(ref,'metadata.rows[1].value'),4);
  assert.equal(api.get(ref,'metadata.missing.child'),undefined);assert.equal(api.get(ref,'metadata.toString'),undefined);
  assert.equal(api.get(ref,'metadata.nullable.value'),undefined);
  assert.equal(api.set(ref,['metadata','__proto__','privateValue'],true),true);
  assert.equal(api.get(ref,['metadata','__proto__','privateValue']),true);assert.equal({}.privateValue,undefined);
  for(const root of ['', '$', []])assert.deepEqual(api.set(ref,root,api.get(ref,root)),api.get(ref));
  const before=model.api.workspace.read();
  for(const path of ['metadata..value','metadata["unterminated]','metadata[-1]','/metadata/~2value',['metadata',-1]]){
    assert.throws(()=>api.get(ref,path),TypeError);assert.throws(()=>api.set(ref,path,1),TypeError);
  }
  assert.throws(()=>api.set(ref,'metadata.rows[4]',{}),/空の要素/);
  assert.throws(()=>api.set(ref,'metadata.nullable.child',1),/途中/);
  assert.throws(()=>api.set(ref,'request.method',undefined),/JSON/);
  assert.deepEqual(model.api.workspace.read(),before);
});

test('collection snapshot aliases support either name field and reject contradictory renames atomically',()=>{
  const model=createWorkspaceModel(fixture()),api=model.api.collections;
  assert.equal(api.set('API','name','First'),'First');assert.equal(api.get('collection','info.name'),'First');
  let value=api.get('First');value.info.name='Second';assert.equal(api.set('First',value).name,'Second');
  value=api.get('Second');value.name='Third';assert.equal(api.set('Second',value).info.name,'Third');
  value=api.get('Third');value.name=value.info.name='Fourth';assert.equal(api.set(value.id,value).name,'Fourth');
  const before=model.api.workspace.read();value=api.get('Fourth');value.name='Left';value.info.name='Right';value.variable=[];
  assert.throws(()=>api.set('Fourth',value),/name と info.name/);assert.deepEqual(model.api.workspace.read(),before);
  assert.deepEqual(api.set('Fourth','info',{name:'Fifth',description:'only'}),{name:'Fifth',description:'only'});
  const children=api.get('Fifth','item');assert.equal(api.set('Fifth',{name:'Minimal'}).info.name,'Minimal');
  assert.deepEqual(api.get('collection','item'),children);assert.equal(api.get('collection','info.description'),undefined);
  assert.equal(Object.hasOwn(model.state.collections[0],'name'),false);
});

test('snapshot setters protect ownership, tree children and request ribbon scope while preserving omitted identities',()=>{
  const model=createWorkspaceModel(fixture(),{requestRef:'draft:draft'}),api=model.api;
  const folder=api.folders.create({parent:'collection',name:'Folder'});api.requests.move('collection:request',folder.id);
  api.ribbons.create({key:'main'});
  const checks=[
    [api.collections,'collection','_mpId','changed'],[api.collections,'collection','item',[]],
    [api.folders,folder.id,'item[0].name','changed'],[api.folders,folder.id,'request',request()],
    [api.requests,'collection:request','collectionId','other'],[api.requests,'collection:request','itemId','other'],
    [api.requests,'collection:request','parentId','collection'],[api.requests,'collection:request','path','other'],
    [api.requests,'collection:request','item',[]],[api.requests,'collection:request','_mpId','other'],
    [api.drafts,'draft:draft','draftId','other'],[api.drafts,'draft:draft','ribbonState.id','other-scope']
  ];
  const before=api.workspace.read();
  for(const [scope,ref,path,value] of checks){assert.throws(()=>scope.set(ref,path,value),/変更できません/);assert.deepEqual(api.workspace.read(),before);}
  assert.throws(()=>api.drafts.set('collection:request','name','invalid scope'),/ありません/);
  const next=api.drafts.get('draft:draft');delete next.id;delete next.draftId;delete next.path;next.name='Renamed draft';
  assert.equal(api.drafts.set('Draft',next).id,'draft:draft');assert.equal(model.state.tabs[0].id,'draft');
  const partial=api.folders.get(folder.id);delete partial.id;delete partial._mpId;delete partial.item;delete partial.parentId;
  assert.equal(api.folders.set(folder.id,partial).item[0]._mpId,'request');
});

test('settings use the same nested path and whole snapshot contract without reaching other workspace roots',()=>{
  const model=createWorkspaceModel(fixture()),api=model.api.settings;
  assert.equal(api.set('settings.timeout_ms',1500),1500);assert.equal(api.get('/settings/timeout_ms'),1500);
  assert.equal(api.set(['editorSettings','fontSize'],15),15);assert.equal(api.get('editorSettings["fontSize"]'),15);
  assert.equal(api.set('theme','dark'),'dark');assert.equal(api.get('settings.missing'),undefined);
  const next=api.get();next.settings={verify_tls:true};delete next.editorSettings;
  assert.deepEqual(api.set(next),{theme:'dark',settings:{verify_tls:true}});assert.equal(api.get('settings.timeout_ms'),undefined);
  const before=model.api.workspace.read();
  for(const [path,value] of [['settings.timeout_ms',-1],['theme','invalid'],['collections',[]],['editorSettings',null]])assert.throws(()=>api.set(path,value));
  assert.throws(()=>api.get('collections'),/不明/);assert.throws(()=>api.set({...api.get(),scripts:[]}),/変更できない/);
  assert.deepEqual(model.api.workspace.read(),before);
  assert.deepEqual(api.set([],{settings:{follow_redirects:false}}),{settings:{follow_redirects:false}});
  assert.deepEqual(api.get('$'),{settings:{follow_redirects:false}});assert.equal(api.get('theme'),undefined);
  api.update({settings:{timeout_ms:2000}});assert.deepEqual(api.get('settings'),{follow_redirects:false,timeout_ms:2000});
});

test('ribbon snapshot and path setters stay in their request owner and return coerced child values',()=>{
  const model=createWorkspaceModel(fixture(),{requestRef:'draft:draft'}),api=model.api;
  const make=(scope,value)=>{const ribbon=scope.create({key:'main',name:'Main'}),group=scope.groups(ribbon.id).create({name:'Group'}),control=scope.controls(ribbon.id,group.id).create({key:'count',type:'number',value});return {scope,ribbon,group,control};};
  const current=make(api.ribbons,1),other=make(api.ribbons.forRequest('Fetch'),100);
  const value=current.scope.get('Main');value.groups[0].controls[0].value='8';
  assert.equal(current.scope.set('Main',value).groups[0].controls[0].value,8);
  assert.equal(current.scope.set('Main','groups[0].controls[0].value','9'),9);
  const controls=current.scope.controls(current.ribbon.id,current.group.id);
  assert.equal(controls.set({id:current.control.id},'value','10'),10);
  assert.equal(other.scope.controls(other.ribbon.id,other.group.id).get('count','value'),100);
  const before=api.workspace.read();assert.throws(()=>controls.set('count','value','invalid'),/種類に合う/);assert.deepEqual(api.workspace.read(),before);
});

test('ambiguous names fail while full IDs and unique paths resolve',()=>{
  const model=createWorkspaceModel(fixture()),api=model.api;
  const duplicate=api.requests.create({parent:'collection',name:'Fetch'});
  assert.throws(()=>api.requests.get('Fetch'),/複数/);
  assert.equal(api.requests.get(duplicate.id).id,duplicate.id);
  const second=api.collections.create({name:'Other'});api.requests.move(duplicate.id,second.id);
  assert.equal(api.requests.get('Other / Fetch').itemId,duplicate.itemId);
  assert.throws(()=>api.folders.create({name:'Orphan'}),/保存先/);
});

test('ribbon definition CRUD and the existing value API see the same pending state',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();
  const output=await run(workspace,primary,`
    const ribbon=minipost.ribbons.create({name:'Main',key:'main'});
    const group=minipost.ribbons.groups(ribbon.id).create({name:'Inputs'});
    const count=minipost.ribbons.controls(ribbon.id,group.id).create({key:'count',label:'Count',type:'number',value:2});
    minipost.ribbon.activate(ribbon.id);minipost.ribbon.set('count','7');
    const other=minipost.ribbons.forRequest('collection:request').create({name:'Other',key:'main'});
    return {count:minipost.ribbons.controls(ribbon.id,group.id).get(count.id).value,active:minipost.ribbon.active(),other};
  `);
  assert.equal(output.result.count,7);assert.equal(output.result.active.key,'main');
  commit(workspace,primary,output);
  assert.equal(workspace.tabs[0].ribbonState.ribbons[0].groups[0].controls[0].value,7);
  assert.notEqual(workspace.tabs[0].ribbonState.id,workspace.collections[0].item[0].ribbonState.id);
});

test('model mutations and legacy variables/store share pending values across children',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();primary.set('session','before');
  workspace.scripts=[saved('child','Child',`return {host:pm.environment.get('host'),global:vars.get('global'),data:store.get('value')};`)];
  const output=await run(workspace,primary,`
    minipost.environments.variables('env').set('host',42);
    pm.globals.set('global','next');store.set('value',{n:1});vars.set('session','next');
    const result=await scripts.run('child');
    minipost.environments.activate(null);
    pm.environment.set('captured','still env');
    return result;
  `);
  assert.deepEqual(output.result,{host:'42',global:'next',data:{n:1}});assert.equal(workspace.environmentId,'env');
  commit(workspace,primary,output);assert.equal(workspace.environmentId,'');assert.equal(workspace.environments[0].values.at(-1).value,'still env');assert.equal(primary.get('session'),'next');
});

test('fine-grained commits preserve unrelated concurrent edits and captured object identities',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables(),environment=workspace.environments[0],script=workspace.scripts[0],item=workspace.collections[0].item[0],row=environment.values[0];
  const output=await run(workspace,primary,`minipost.requests.update('collection:request',{request:{method:'POST'}});scripts.update('child',{source:'return 3;'});pm.environment.set('host','after');`);
  item.request.url='https://example.invalid/user-edited';script.name='User title';environment.values.push({key:'unrelated',value:'kept'});workspace.scriptData.extra=true;
  commit(workspace,primary,output);
  assert.equal(workspace.environments[0],environment);assert.equal(environment.values[0],row);assert.equal(workspace.scripts[0],script);assert.equal(workspace.collections[0].item[0],item);
  assert.equal(item.request.method,'POST');assert.equal(item.request.url,'https://example.invalid/user-edited');assert.equal(script.name,'User title');assert.equal(environment.values.at(-1).key,'unrelated');assert.equal(workspace.scriptData.extra,true);
});

test('one conflicting field rolls back model, primary, environment, data and settings together',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();primary.set('value','before');
  const output=await run(workspace,primary,`minipost.requests.update('Fetch',{request:{method:'POST'}});pm.environment.set('host','pending');store.set('value',9);vars.set('value','pending');minipost.settings.update({theme:'dark'});`);
  workspace.collections[0].item[0].request.method='DELETE';const before=structuredClone(workspace);
  assert.throws(()=>commit(workspace,primary,output),/変更・削除/);
  assert.deepEqual(workspace,before);assert.equal(primary.get('value'),'before');
});

test('primary compare-and-swap rejects an edit made during the run without losing unrelated primary values',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();primary.set('value','before');
  const output=await run(workspace,primary,`vars.set('value','pending');store.set('pending',true);`);
  primary.set('value','user');primary.set('other','kept');const before=structuredClone(workspace);
  assert.throws(()=>commit(workspace,primary,output),/同じ一次変数/);assert.deepEqual(workspace,before);assert.deepEqual(primary.snapshot(),{value:'user',other:'kept'});
});

test('errors and aborts expose no persistent model writes',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables(),before=structuredClone(workspace);
  await assert.rejects(run(workspace,primary,`minipost.requests.delete('Fetch');store.set('partial',true);throw new Error('stop');`),/stop/);assert.deepEqual(workspace,before);
  const controller=new AbortController();
  await assert.rejects(run(workspace,primary,`minipost.collections.create({name:'Never'});await minipost.responses.list();`,{signal:controller.signal,onCall:async()=>{controller.abort();return [];}}),{name:'AbortError'});assert.deepEqual(workspace,before);
});

test('ordered script and direct ribbon stages commit atomically and retain their own earlier writes',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();
  const setup=await run(workspace,primary,`const r=minipost.ribbons.create({key:'main'});const g=minipost.ribbons.groups(r.id).create({name:'G'});minipost.ribbons.controls(r.id,g.id).create({key:'count',type:'number',value:0});ribbon.activate(r.id);`);commit(workspace,primary,setup);
  const staged=structuredClone(workspace),temporary=new PrimaryVariables();
  const first=await run(staged,temporary,`ribbon.set('count',1);store.set('first',true);`);commit(staged,temporary,first);
  const state=staged.tabs[0].ribbonState,control=state.ribbons[0].groups[0].controls[0];
  const direct={writes:{primary:[],environment:[],globals:[]},dataWrites:[],ribbonScopeId:state.id,ribbonWrites:[{type:'value',id:control.id,value:2,expected:1,expectedShape:{type:'number',options:[]}}]};commit(staged,temporary,direct);
  const last=await run(staged,temporary,`ribbon.set('count',ribbon.get('count')+1);vars.set('done','yes');`);
  assert.equal(commit(workspace,primary,{stages:[first,direct,last]}),true);assert.equal(workspace.tabs[0].ribbonState.ribbons[0].groups[0].controls[0].value,3);assert.equal(primary.get('done'),'yes');
  const other=fixture(),p=new PrimaryVariables(),one=await run(other,p,`store.set('first',true);`),before=structuredClone(other);
  assert.throws(()=>commit(other,p,{stages:[one,{...direct,ribbonScopeId:'missing'}]}));assert.deepEqual(other,before);
});

test('isolated source includes model and tools factories and reads pending model edits',async()=>{
  const isolated=Function(`${scriptExecutorSource()}\nreturn executeScript;`)(),workspace=fixture(),primary=new PrimaryVariables();
  const output=await isolated(`minipost.requests.update('Fetch',{request:{url:tools.url.build('https://example.invalid',{query:{page:2}})}});return minipost.requests.get('Fetch').request.url;`,makeScriptContext(workspace,primary));
  assert.equal(output.result,'https://example.invalid/?page=2');assert.ok(output.workspaceWrites.length);
});

test('serialized execution shares snapshot setters and saved request handles with child scripts',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables(),isolated=Function(`${scriptExecutorSource()}\nreturn executeScript;`)();
  workspace.scripts=[saved('child','Child',`const handle=minipost.requests.edit(input);handle.json.set('child',true);return {method:handle.get('method'),token:handle.headers.get('X-Token'),limit:handle.json.get('limit')};`)];
  const output=await isolated(`
    const value=minipost.requests.get('Fetch');value.name='Edited';value.request.method='POST';minipost.requests.set('Fetch',value);
    const handle=minipost.requests.edit(value.id);handle.headers.set('X-Token','saved');handle.query.set('page',2);handle.json.set({limit:5});
    minipost.settings.set('settings.timeout_ms',1200);minipost.environments.set('Test','values[0].value','pending');
    const child=await scripts.run('Child',value.id);
    return {child,body:handle.json.get(),timeout:minipost.settings.get('settings.timeout_ms'),name:minipost.requests.get(value.id,'name')};
  `,makeScriptContext(workspace,primary));
  assert.deepEqual(output.result,{child:{method:'POST',token:'saved',limit:5},body:{limit:5,child:true},timeout:1200,name:'Edited'});
  assert.equal(workspace.collections[0].item[0].name,'Fetch');assert.equal(workspace.settings,undefined);
  commit(workspace,primary,output);
  assert.equal(workspace.collections[0].item[0].name,'Edited');assert.equal(workspace.settings.timeout_ms,1200);
  assert.deepEqual(JSON.parse(workspace.collections[0].item[0].request.body.raw),{limit:5,child:true});
  assert.equal(workspace.environments[0].values[0].value,'pending');
});

test('saved and draft request handles resolve current model objects after replacement and rollback',()=>{
  const model=createWorkspaceModel(fixture()),api=model.api,savedEditor=api.requests.edit({id:'collection:request'}),draftEditor=api.drafts.edit('Draft');
  assert.equal(savedEditor.headers.set('X-Token','first'),'first');assert.equal(savedEditor.headers.get('x-token'),'first');
  const snapshot=api.requests.get('Fetch');snapshot.request.method='POST';api.requests.set('Fetch',snapshot);
  assert.equal(savedEditor.get('method'),'POST');
  assert.throws(()=>savedEditor.set('method',''),/リクエスト/);
  assert.equal(savedEditor.get('method'),'POST');assert.equal(savedEditor.headers.set('X-Token','after rollback'),'after rollback');
  assert.equal(api.requests.get('Fetch','request.header[0].value'),'after rollback');
  assert.equal(draftEditor.headers.get('X-Token'),undefined);assert.equal(draftEditor.set('method','PATCH'),'PATCH');
  const raw=draftEditor.get();raw.body={mode:'raw',raw:'{"draft":true}'};delete raw.auth;
  assert.deepEqual(draftEditor.set(raw),draftEditor.get());assert.deepEqual(draftEditor.json.get(),{draft:true});
  assert.equal(api.drafts.get('Draft','request.method'),'PATCH');assert.equal(api.requests.get('Fetch','request.method'),'POST');
  assert.throws(()=>api.drafts.edit('collection:request'),/ありません/);
  api.requests.delete('Fetch');assert.throws(()=>savedEditor.headers.get('X-Token'),/ありません/);
});

test('symmetric request writes compile pending named headers, query, JSON and form values on the same saved request',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables(),sent=[];
  const host=createScriptHost({workspace,primary,send:async payload=>{sent.push(structuredClone(payload));return {status:200,body:'{}',headers:[]};}});
  const output=await run(workspace,primary,`
    const target=minipost.requests.get('Fetch');target.request.method='POST';minipost.requests.set(target.id,target);
    const edit=minipost.requests.edit(target.id);edit.set('url','https://{{host}}/named?initial=1');
    pm.environment.set('host','example.invalid');edit.headers.set('X-Named','visible');edit.query.set('page',2);edit.query.set('tag',['one two','three+four']);
    edit.json.set({account:{active:true}});edit.json.set('account.name','雪');
    await minipost.requests.send(target.id);
    edit.form.set('message','a+b c');edit.form.set('tag',['first','second']);await minipost.requests.send(target.id);
    return {header:edit.headers.get('x-named'),page:edit.query.get('page'),form:edit.form.toObject(),method:minipost.requests.get(target.id,'request.method')};
  `,{onCall:host});
  assert.equal(sent.length,2);assert.equal(sent[0].method,'POST');assert.equal(sent[0].url,'https://example.invalid/named');
  assert.deepEqual(sent[0].query,[{key:'initial',value:'1'},{key:'page',value:'2'},{key:'tag',value:'one two'},{key:'tag',value:'three+four'}]);
  assert.equal(sent[0].headers.find(row=>row.key.toLowerCase()==='x-named').value,'visible');
  assert.equal(sent[0].headers.find(row=>row.key.toLowerCase()==='content-type').value,'application/json');
  assert.deepEqual(JSON.parse(sent[0].body),{account:{active:true,name:'雪'}});
  assert.equal(sent[1].headers.find(row=>row.key.toLowerCase()==='content-type').value,'application/x-www-form-urlencoded');
  assert.deepEqual(sent[1].form_urlencoded,[{key:'message',value:'a+b c'},{key:'tag',value:'first'},{key:'tag',value:'second'}]);
  assert.deepEqual(output.result,{header:'visible',page:'2',form:{message:'a+b c',tag:['first','second']},method:'POST'});
  assert.equal(workspace.collections[0].item[0].request.method,'GET');commit(workspace,primary,output);
  assert.equal(workspace.collections[0].item[0].request.body.mode,'urlencoded');
});

test('raw request path and snapshot setters reconcile cached URL text, components and query before sending',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables(),sent=[];
  workspace.collections[0].item[0].request=normalizeRequest({method:'GET',url:{raw:'https://old.invalid/first?old=1',protocol:'https',host:['old','invalid'],path:['first'],query:[{key:'old',value:'1'}]},header:[]});
  const host=createScriptHost({workspace,primary,send:async payload=>{sent.push(structuredClone(payload));return {status:200,body:'{}',headers:[]};}});
  const output=await run(workspace,primary,`
    const ref='collection:request';
    const raw=minipost.requests.set(ref,'request.url.raw','https://new.invalid/second?literal=a+b&encoded=a%2Bb');
    await minipost.requests.send(ref);
    const snapshot=minipost.requests.get(ref);snapshot.request.url.raw='https://snapshot.invalid/third?snapshot=1';minipost.requests.set(ref,snapshot);
    await minipost.requests.send(ref);
    minipost.requests.set(ref,['request','url','host'],['component','invalid']);minipost.requests.set(ref,'request.url.path',['fourth','item']);
    await minipost.requests.send(ref);
    minipost.requests.set(ref,'request.url.query',[{key:'kept',value:'a+b c'},{key:'hidden',value:'skip',disabled:true}]);
    await minipost.requests.send(ref);
    return {raw,url:minipost.requests.get(ref,'request.url'),effective:minipost.requests.edit(ref).get('url')};
  `,{onCall:host});
  assert.equal(sent.length,4);assert.deepEqual(sent.map(value=>value.url),['https://new.invalid/second','https://snapshot.invalid/third','https://component.invalid/fourth/item','https://component.invalid/fourth/item']);
  assert.deepEqual(sent[0].query,[{key:'literal',value:'a+b'},{key:'encoded',value:'a+b'}]);
  assert.deepEqual(sent[1].query,[{key:'snapshot',value:'1'}]);assert.deepEqual(sent[2].query,[{key:'snapshot',value:'1'}]);
  assert.deepEqual(sent[3].query,[{key:'kept',value:'a+b c'}]);
  assert.equal(output.result.raw,'https://new.invalid/second?literal=a%2Bb&encoded=a%2Bb');
  assert.equal(output.result.url.base,'https://component.invalid/fourth/item');assert.equal(output.result.url.query.length,2);
  assert.equal(output.result.effective,'https://component.invalid/fourth/item?kept=a%2Bb%20c');
  assert.equal(workspace.collections[0].item[0].request.url.base,'https://old.invalid/first');
});

test('whole snapshot setters keep field-level commits and reject concurrent conflicts atomically',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables(),item=workspace.collections[0].item[0];item.request.auth={type:'noauth'};
  const output=await run(workspace,primary,`
    const value=minipost.requests.get('Fetch');value.request.method='POST';delete value.request.auth;minipost.requests.set(value.id,value);
    minipost.settings.set('settings.timeout_ms',1200);store.set('saved',true);
  `);
  item.name='Concurrent title';item.request.url='https://example.invalid/concurrent';
  commit(workspace,primary,output);
  assert.equal(item.name,'Concurrent title');assert.equal(item.request.url,'https://example.invalid/concurrent');assert.equal(item.request.method,'POST');assert.equal(Object.hasOwn(item.request,'auth'),false);
  const conflict=await run(workspace,primary,`
    const value=minipost.requests.get('collection:request');value.request.method='PATCH';minipost.requests.set(value.id,value);
    minipost.requests.edit(value.id).headers.set('X-Pending','rollback');minipost.settings.set('settings.timeout_ms',9000);vars.set('pending','yes');
  `);
  item.request.method='DELETE';const before=structuredClone(workspace);
  assert.throws(()=>commit(workspace,primary,conflict),/変更・削除/);assert.deepEqual(workspace,before);assert.equal(primary.get('pending'),undefined);
});

test('host sends pending request and environment edits without committing to the live workspace',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();let sent;
  const host=createScriptHost({workspace,primary,send:async payload=>{sent=payload;return {status:200,body:'{}',headers:[]};}});
  const output=await run(workspace,primary,`minipost.requests.update('Fetch',{request:{url:'https://{{host}}/pending'}});pm.environment.set('host','pending.invalid');await minipost.requests.send('Fetch');return minipost.requests.get('Fetch').request.url;`,{onCall:host});
  assert.equal(sent.url,'https://pending.invalid/pending');assert.equal(workspace.collections[0].item[0].request.url,'https://example.invalid/start');assert.equal(output.result,'https://{{host}}/pending');
});

test('attachment metadata and bounded reads expose selected files without persisting binary data',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables(),blob=new Blob(['hello'],{type:'text/plain'}),host=createScriptHost({workspace,primary,filesFor:()=>({binary:[{name:'hello.txt',type:'text/plain',size:5,lastModified:1,blob}]})});
  const output=await run(workspace,primary,`return {files:await minipost.attachments.list('Fetch'),text:await minipost.attachments.read('Fetch','binary'),bytes:await minipost.attachments.read('Fetch','binary',0,{format:'bytes'})};`,{onCall:host});
  assert.deepEqual(output.result.files,[{slot:'binary',index:0,name:'hello.txt',type:'text/plain',size:5,lastModified:1}]);assert.equal(output.result.text,'hello');assert.deepEqual(output.result.bytes,[104,101,108,108,111]);assert.deepEqual(output.workspaceWrites,[]);
  await assert.rejects(host('attachments.read',['Fetch','binary',0,{maxBytes:4}]),/上限/);
});

test('pending changes to file row order cannot send an old selected file under another row',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();workspace.collections[0].item[0].request.body={mode:'formdata',formdata:[{key:'first',type:'file',src:['one.txt']},{key:'second',type:'file',src:['two.txt']}]};let sends=0;
  const host=createScriptHost({workspace,primary,filesFor:()=>({'form-0':[{blob:new Blob(['one']),name:'one.txt'}]}),send:async()=>{sends++;return {status:200,body:'',headers:[]};}});
  await assert.rejects(run(workspace,primary,`const value=minipost.requests.get('Fetch');minipost.requests.update(value.id,{request:{body:{formdata:value.request.body.formdata.reverse()}}});await minipost.requests.send(value.id);`,{onCall:host}),/選択し直/);assert.equal(sends,0);
});

test('session response snapshots are copies and missing current responses return null',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables(),response={id:'reply',requestId:'collection:request',name:'Fetch',response:{status:200,body:{count:1}}};
  const host=createScriptHost({workspace,primary,getResponses:()=>[response]});response.response.body.count=9;
  const output=await run(workspace,primary,`const values=await minipost.responses.list();values[0].response.body.count=20;return [await minipost.responses.get('reply'),await minipost.responses.get()];`,{onCall:host});
  assert.equal(output.result[0].response.body.count,1);assert.equal(output.result[1],null);
});

test('relation host callback reads pending edits and merges its workspace and primary changes back into the parent',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();workspace.relations=[{id:'flow',name:'Flow',repeat:1,steps:[]}];
  const host=createScriptHost({workspace,primary,runRelation:async(relation,context)=>{
    assert.equal(relation.id,'flow');assert.equal(context.workspace.scriptData.parent,1);assert.equal(context.primary.parent,'yes');
    context.workspace.collections[0].item[0].request.method='PATCH';context.workspace.scriptData.child=2;
    return {result:{status:'success'},primary:{...context.primary,child:'yes'},logs:[{level:'info',message:'child done'}]};
  }});
  const output=await run(workspace,primary,`store.set('parent',1);vars.set('parent','yes');const result=await minipost.relations.run('flow');return {result,method:minipost.requests.get('Fetch').request.method,child:store.get('child'),primary:vars.get('child')};`,{onCall:host});
  assert.deepEqual(output.result,{result:{status:'success'},method:'PATCH',child:2,primary:'yes'});assert.equal(workspace.scriptData.child,undefined);commit(workspace,primary,output);assert.equal(workspace.scriptData.child,2);assert.equal(primary.get('child'),'yes');
});

test('a failed relation cannot leak model changes even when the parent catches its error',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();workspace.relations=[{id:'flow',name:'Flow',steps:[]}];
  const host=createScriptHost({workspace,primary,runRelation:async(_relation,context)=>{context.workspace.scriptData.leak=true;throw new Error('relation failed');}});
  const output=await run(workspace,primary,`store.set('before',true);try{await minipost.relations.run('flow');}catch(error){store.set('caught',error.message);}return store.get('leak');`,{onCall:host});
  assert.equal(output.result,undefined);commit(workspace,primary,output);assert.deepEqual(workspace.scriptData,{keep:1,before:true,caught:'relation failed'});
});

test('diff order and ID selectors preserve concurrently inserted members without whole-array replacement',()=>{
  const before={scripts:[saved('a'),saved('b')]},after=structuredClone(before);after.scripts.reverse();after.scripts[0].name='Edited';
  const pending=structuredClone(before);pending.scripts.push(saved('other'));
  const changes=workspaceChanges(before,after);applyWorkspaceChanges(pending,changes);
  assert.deepEqual(pending.scripts.map(value=>value.id),['b','a','other']);assert.equal(pending.scripts[0].name,'Edited');
});

test('moving a folder repairs nested relation targets, saved editors, history and revision keys while preserving objects',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables(),item=workspace.collections[0].item[0];
  const folder={_mpId:'folder',name:'Folder',item:[item]};workspace.collections[0].item=[folder];
  workspace.tabs.push({id:'saved-tab',name:'Fetch',collectionId:'collection',itemId:'request',request:request()});
  workspace.activeRequest={collectionId:'collection',itemId:'request'};
  workspace.history=[{id:'sent',tab:structuredClone(workspace.tabs[1])}];
  workspace.revisions={'request:collection:request':[{value:{request:request()}}],'folder:collection:folder':[{value:{name:'Folder'}}]};
  workspace.relations=[{id:'flow',name:'Flow',steps:[{id:'loop',type:'repeat',repeat:1,steps:[{id:'send',collectionId:'collection',itemId:'request'}]}]}];
  const output=await run(workspace,primary,`const target=minipost.collections.create({name:'Target'});minipost.folders.move('collection:folder',target.id);return target.id;`);
  commit(workspace,primary,output);const target=output.result;
  assert.equal(workspace.collections[1].item[0],folder);assert.equal(folder.item[0],item);
  assert.equal(workspace.tabs[1].collectionId,target);assert.equal(workspace.activeRequest.collectionId,target);assert.equal(workspace.history[0].tab.collectionId,target);
  assert.equal(workspace.relations[0].steps[0].steps[0].collectionId,target);assert.ok(workspace.revisions[`request:${target}:request`]);assert.equal(workspace.revisions['request:collection:request'],undefined);
});

test('plain JSON keys never modify prototypes and invalid mutations leave prior pending edits intact',()=>{
  const model=createWorkspaceModel(fixture()),before=Object.prototype.polluted;
  model.api.requests.update('Fetch',{request:{description:'kept'}});
  model.api.requests.update('Fetch',JSON.parse('{"request":{"__proto__":{"polluted":true}}}'));
  assert.equal(Object.prototype.polluted,before);assert.equal(Object.hasOwn(model.api.requests.get('Fetch').request,'__proto__'),true);
  assert.throws(()=>model.api.requests.update('Fetch',{request:{method:4}}),/method/);assert.equal(model.api.requests.get('Fetch').request.description,'kept');
});

test('a temporary unsaved request has no model owner but retains collection, folder, URL and pending environment variables',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();workspace.collections[0].variable=[{key:'collection',value:'C'}];workspace.collections[0].item.push({_mpId:'folder',name:'Folder',variable:[{key:'folder',value:'F'}],item:[]});
  const tab={id:'temporary',name:'New request',collectionId:'collection',pendingFolderId:'folder',request:{...request(),url:{raw:'https://example.invalid',variable:[{key:'path',value:'P'}]}}};
  const context=makeScriptContext(workspace,primary,{tab});assert.equal(context.requestRef,null);assert.equal(context.ribbonOwnerRef,null);
  const output=await executeScript(`pm.environment.set('host','pending');return {values:vars.toObject(),ribbons:ribbon.list(),request:request.method};`,context);
  assert.deepEqual(output.result,{values:{global:'before',collection:'C',folder:'F',host:'pending',path:'P'},ribbons:[],request:'GET'});
  commit(workspace,primary,output);assert.equal(workspace.tabs.some(value=>value.id==='temporary'),false);assert.equal(workspace.environments[0].values[0].value,'pending');
  const standalone=await executeScript(`return {request,ribbons:ribbon.list(),refs:minipost.ribbons.list()};`,makeScriptContext(workspace,primary,{ribbonOwner:tab}));
  assert.deepEqual(standalone.result,{request:null,ribbons:[],refs:[]});
});

test('a concurrent parent primary edit rejects the entire relation merge before its model changes leak',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();primary.set('shared','before');workspace.relations=[{id:'flow',name:'Flow',steps:[]}];
  let release;const blocked=new Promise(resolve=>{release=resolve;});
  const host=createScriptHost({workspace,primary,runRelation:async(_relation,context)=>{await blocked;context.workspace.scriptData.leak='relation';return {result:{status:'success'},primary:{...context.primary,shared:'relation'}};}});
  const output=await run(workspace,primary,`const child=minipost.relations.run('flow');vars.set('shared','parent');await minipost.responses.list();try{await child;}catch(error){store.set('error',error.message);}return {value:vars.get('shared'),leak:store.get('leak')};`,{
    onCall:async(method,...args)=>{if(method==='responses.list'){release();return [];}return host(method,...args);}
  });
  assert.equal(output.result.value,'parent');assert.equal(output.result.leak,undefined);commit(workspace,primary,output);
  assert.equal(primary.get('shared'),'parent');assert.equal(workspace.scriptData.leak,undefined);assert.match(workspace.scriptData.error,/同じ一次変数/);
});

test('model metadata and ribbon values remain acceptable to the existing persistence validators',()=>{
  const model=createWorkspaceModel(fixture(),{requestRef:'draft:draft'}),api=model.api;
  const script=api.scripts.create({name:'Bound',bindingId:'group'}),ribbon=api.ribbons.create({name:'Ribbon',key:'main'}),group=api.ribbons.groups(ribbon.id).create({name:'Group'});
  const control=api.ribbons.controls(ribbon.id,group.id).create({type:'select',key:'choice',options:[{value:'a',label:'A'}],value:'a'});
  assert.throws(()=>api.scripts.update(script.id,{bindingId:'bad:group'}),/スクリプト/);
  assert.throws(()=>api.environments.variables('env').set('bad','x',{enabled:'yes'}),/真偽値/);
  assert.throws(()=>api.requests.update('Fetch',{request:{header:[{key:'X',value:'x',disabled:'yes'}]}}),/真偽値/);
  assert.throws(()=>api.ribbons.controls(ribbon.id,group.id).update(control.id,{options:null}),/選択肢/);
  assert.throws(()=>api.drafts.update('draft:draft',{ribbonState:{ribbonBindings:{group:{controls:{count:'invalid:id'}}}}}),/参照設定/);
  assert.throws(()=>model.apply([{path:['scriptBindings','bad:binding'],expected:{exists:false},value:{Child:'child'}}]),/参照設定/);
  assert.equal(validScripts(model.state.scripts),true);assert.equal(validScriptBindings(model.state.scriptBindings),true);assert.equal(validRibbonWorkspace(model.state),true);
});

test('a JSON ribbon value keeps its whole-value conflict boundary when only one nested field changes',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();
  const setup=await run(workspace,primary,`const r=minipost.ribbons.create({key:'main'});const g=minipost.ribbons.groups(r.id).create({});minipost.ribbons.controls(r.id,g.id).create({type:'display',key:'result',value:{script:1,user:1}});ribbon.activate(r.id);`);commit(workspace,primary,setup);
  const output=await run(workspace,primary,`ribbon.set('result',{script:2,user:1});store.set('pending',true);`);
  workspace.tabs[0].ribbonState.ribbons[0].groups[0].controls[0].value.user=2;const before=structuredClone(workspace);
  assert.throws(()=>commit(workspace,primary,output),/同じ項目/);assert.deepEqual(workspace,before);
});

test('scope-only ribbon actions resolve their owner, share child writes and commit ordered stages to that request',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();
  const setup=await run(workspace,primary,`const r=minipost.ribbons.create({key:'main'});const g=minipost.ribbons.groups(r.id).create({});minipost.ribbons.controls(r.id,g.id).create({type:'number',key:'count',value:3});minipost.ribbons.controls(r.id,g.id).create({type:'display',key:'result',value:{value:0}});ribbon.activate(r.id);`);commit(workspace,primary,setup);
  const owner=workspace.tabs[0],scopeId=owner.ribbonState.id;
  const other={...structuredClone(owner),id:'other',name:'Other'};other.ribbonState.id='other-scope';other.ribbonState.ribbons[0].groups[0].controls[0].value=100;workspace.tabs.push(other);workspace.activeId=other.id;
  workspace.scripts=[saved('child','Child',`const value=ribbon.get('main.count')*2;ribbon.set('main.result',{value});return value;`),saved('parent','Parent',`const value=await scripts.run('child',input);store.set('event',input);return value;`)];
  const staged=structuredClone(workspace),temporary=new PrimaryVariables(),payload={type:'click',values:{count:3}};
  const context=makeScriptContext(staged,temporary,{ribbonScopeId:scopeId,scriptId:'parent',input:payload});
  assert.equal(context.request,null);assert.equal(context.requestRef,null);assert.equal(context.ribbonOwnerRef,'draft:draft');
  const isolated=Function(`${scriptExecutorSource()}\nreturn executeScript;`)();
  const output=await isolated(staged.scripts[1].source,context);
  assert.equal(output.result,6);commit(staged,temporary,output);commit(workspace,primary,{stages:[output]});
  assert.deepEqual(owner.ribbonState.ribbons[0].groups[0].controls[1].value,{value:6});assert.deepEqual(other.ribbonState.ribbons[0].groups[0].controls[1].value,{value:0});assert.deepEqual(workspace.scriptData.event,payload);assert.equal(workspace.activeId,other.id);
});

test('a saved request scope resolves without an editor tab and explicit null owner stays disabled',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables(),model=createWorkspaceModel(workspace,{requestRef:'collection:request'});
  const ribbon=model.api.ribbons.create({key:'main'}),group=model.api.ribbons.groups(ribbon.id).create({});model.api.ribbons.controls(ribbon.id,group.id).create({type:'number',key:'count',value:4});
  const stored=model.state,item=stored.collections[0].item[0],context=makeScriptContext(stored,primary,{ribbonScopeId:item.ribbonState.id});
  assert.equal(context.ribbonOwnerRef,'collection:request');assert.equal(context.request,null);
  // Direct Worker clients may carry the captured scope without a host-derived
  // owner reference; the scope remains sufficient and takes precedence.
  delete context.ribbonOwnerRef;context.requestRef='draft:draft';
  const output=await executeScript(`return ribbon.set('main.count',ribbon.get('main.count')+1);`,context);commit(stored,primary,output);assert.equal(item.ribbonState.ribbons[0].groups[0].controls[0].value,5);
  const tab={id:'editor',collectionId:'collection',itemId:'request',request:item.request},empty=makeScriptContext(stored,primary,{tab,ribbonOwner:null,ribbonScopeId:null});
  assert.equal(empty.requestRef,'collection:request');assert.equal(empty.ribbonOwnerRef,null);
  const none=await executeScript(`return {live:ribbon.list(),definitions:minipost.ribbons.list()};`,empty);assert.deepEqual(none.result,{live:[],definitions:[]});
});

test('an initially empty request scope can create a ribbon from a request hook context',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables(),tab=workspace.tabs[0],context=makeScriptContext(workspace,primary,{tab,ribbonScopeId:null});
  assert.equal(context.ribbonScopeId,null);assert.equal(context.ribbonOwnerRef,'draft:draft');
  const output=await executeScript(`const r=minipost.ribbons.create({key:'main'});const g=minipost.ribbons.groups(r.id).create({});minipost.ribbons.controls(r.id,g.id).create({type:'number',key:'count',value:6});return ribbon.get('main.count');`,context);
  assert.equal(output.result,6);commit(workspace,primary,output);assert.equal(tab.ribbonState.ribbons[0].groups[0].controls[0].value,6);
});

test('scoped variable setters update the effective duplicate and reactivate imported disabled rows',()=>{
  const workspace=fixture(),values=()=>[{key:'duplicate',value:'first',description:'first row'},{key:'duplicate',value:'last',description:'last row'},{key:'hidden',value:'old',disabled:true,enabled:false,description:'keep'}];
  workspace.globals=values();workspace.environments[0].values=values();workspace.collections[0].variable=values();workspace.collections[0].item.push({_mpId:'folder',name:'Folder',variable:values(),item:[]});
  const model=createWorkspaceModel(workspace,{environmentId:'env'}),api=model.api;
  for(const scope of [api.globals,api.environment,api.environments.variables('env'),api.collections.variables('collection'),api.folders.variables('collection:folder')]){
    assert.equal(scope.set('duplicate','updated'),'updated');assert.equal(scope.get('duplicate'),'updated');
    assert.equal(scope.list()[0].value,'first');assert.equal(scope.list()[1].description,'last row');
    scope.set('hidden','visible');assert.equal(scope.get('hidden'),'visible');assert.equal(scope.list()[2].description,'keep');
    scope.set('hidden','disabled explicitly',{disabled:true});assert.equal(scope.get('hidden'),undefined);
    scope.set('hidden','visible again');assert.equal(scope.get('hidden'),'visible again');
    scope.set('hidden','disabled explicitly',{enabled:false});assert.equal(scope.get('hidden'),undefined);
  }
});

test('legacy environment and globals clear remove disabled and blank rows in their pending scope',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables(),values=[{key:'duplicate',value:'first'},{key:'duplicate',value:'last'},{key:'hidden',value:'old',disabled:true},{key:'',value:'blank'}];
  workspace.environments[0].values=structuredClone(values);workspace.globals=structuredClone(values);primary.set('keep','primary');
  const output=await run(workspace,primary,`
    pm.environment.set('duplicate','updated');pm.environment.set('hidden','visible');
    minipost.globals.set('duplicate','global');pm.globals.set('hidden','visible');
    const effective=[pm.environment.get('duplicate'),pm.environment.get('hidden'),vars.get('duplicate'),pm.globals.get('duplicate'),minipost.globals.get('hidden')];
    const removed=[pm.environment.clear(),minipost.globals.clear()];
    return {effective,removed,environment:pm.environment.list(),globals:pm.globals.list(),primary:vars.get('keep')};
  `);
  assert.deepEqual(output.result,{effective:['updated','visible','updated','global','visible'],removed:[4,4],environment:[],globals:[],primary:'primary'});
  assert.equal(workspace.globals.length,4);commit(workspace,primary,output);assert.deepEqual(workspace.globals,[]);assert.deepEqual(workspace.environments[0].values,[]);assert.equal(primary.get('keep'),'primary');
});

test('primary clear includes disabled and blank rows and still reads inherited variables',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();primary.rows=[{key:'duplicate',value:'first'},{key:'duplicate',value:'last'},{key:'hidden',value:'old',disabled:true},{key:'',value:'blank'}];
  workspace.scripts[0].source=`const count=pm.variables.clear();vars.set('remaining','ok');return count;`;
  const original=structuredClone(primary.rows),output=await run(workspace,primary,`const removed=await scripts.run('child');return {removed,global:vars.get('global'),host:vars.get('host'),remaining:vars.get('remaining')};`);
  assert.deepEqual(output.result,{removed:4,global:'before',host:'before',remaining:'ok'});assert.deepEqual(primary.rows,original);
  commit(workspace,primary,output);assert.deepEqual(primary.rows,[{key:'remaining',value:'ok',enabled:true,disabled:false}]);
});

test('primary row clears preserve unrelated concurrent additions but reject edits to a deleted disabled row atomically',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();primary.rows=[{key:'visible',value:'old'},{key:'hidden',value:'old',disabled:true,description:'original'}];
  const output=await run(workspace,primary,`vars.clear();store.set('committed',true);`);primary.set('unrelated','kept');
  commit(workspace,primary,output);assert.deepEqual(primary.snapshot(),{unrelated:'kept'});assert.equal(workspace.scriptData.committed,true);
  primary.rows.push({key:'hidden',value:'old',disabled:true,description:'original'});
  const conflict=await run(workspace,primary,`vars.clear();store.set('leak',true);`);primary.rows.at(-1).description='edited while running';const before=structuredClone(workspace),rows=structuredClone(primary.rows);
  assert.throws(()=>commit(workspace,primary,conflict),/同じ項目/);assert.deepEqual(workspace,before);assert.deepEqual(primary.rows,rows);
});

test('response extraction uses its original row baseline and explicit primary clear wins over extraction',async()=>{
  for(const clear of [false,true]){
    const workspace=fixture(),primary=new PrimaryVariables(),tab=workspace.tabs[0];primary.rows=[{key:'hidden',value:'old',disabled:true}];
    tab.request._minipost={after:`response.body.id=42;${clear?"vars.clear();vars.set('remaining','ok');":""}`,extractions:[{name:'extracted',path:'/body/id'}]};
    const response=await executeRequest({workspace,primary,tab,script:executeScript,send:async()=>({status:200,headers:[],body:'{"id":1}',body_encoding:'text'})});
    assert.deepEqual(response.automationErrors,[]);
    if(clear)assert.deepEqual(primary.snapshot(),{remaining:'ok'});else assert.equal(primary.get('extracted'),'42');
    assert.equal(primary.rows.some(row=>row.key==='hidden'),!clear);
  }
});

test('removed response fields never commit their read-only extraction preview',async()=>{
  for(const existing of [false,true]){
    const workspace=fixture(),primary=new PrimaryVariables(),tab=workspace.tabs[0];if(existing)primary.set('extracted','original');
    tab.request._minipost={after:`delete response.body.id;vars.set('other','explicit');`,extractions:[{name:'extracted',path:'/body/id'}]};
    const response=await executeRequest({workspace,primary,tab,script:executeScript,send:async()=>({status:200,headers:[],body:'{"id":1,"name":"old"}',body_encoding:'text'})});
    assert.deepEqual(response.automationErrors,[]);assert.equal(primary.get('extracted'),existing?'original':undefined);assert.equal(primary.get('other'),'explicit');
  }
});

test('nested relation row changes reject a parent edit to a disabled primary row without leaking model writes',async()=>{
  const workspace=fixture(),primary=new PrimaryVariables();primary.rows=[{key:'hidden',value:'old',disabled:true}];workspace.relations=[{id:'flow',name:'Flow',steps:[]}];
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const host=createScriptHost({workspace,primary,runRelation:async(_relation,context)=>{await pending;context.workspace.scriptData.leak='relation';return {result:{status:'succeeded'},primary:{},primaryRows:[]};}});
  const output=await run(workspace,primary,`const child=minipost.relations.run('flow');vars.set('hidden','parent');await minipost.responses.list();try{await child;}catch(error){store.set('error',error.message);}return {value:vars.get('hidden'),leak:store.get('leak')};`,{
    onCall:async(method,...args)=>{if(method==='responses.list'){release();return [];}return host(method,...args);}
  });
  assert.deepEqual(output.result,{value:'parent',leak:undefined});commit(workspace,primary,output);assert.equal(primary.get('hidden'),'parent');assert.equal(workspace.scriptData.leak,undefined);assert.match(workspace.scriptData.error,/同じ項目/);
});
