import test from 'node:test';
import assert from 'node:assert/strict';
import {executeScript,scriptExecutorSource} from '../static/script-worker.mjs';
import {makeScriptContext,createScriptHost} from '../static/script-host.mjs';
import {applyScriptWrites} from '../static/scripts.mjs';
import {createWorkspaceModel,workspaceChanges,applyWorkspaceChanges} from '../static/workspace-api.mjs';
import {PrimaryVariables} from '../static/runtime.mjs';
import {validRibbonWorkspace} from '../static/ribbons.mjs';
import {validScripts,validScriptBindings} from '../static/scripts.mjs';

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
