import test from 'node:test';
import assert from 'node:assert/strict';
import {clone,newRequest,importPostman,exportCollection} from '../static/core.mjs';
import {duplicateItem,duplicateCollection} from '../static/editops.mjs';
import {RequestSession} from '../static/request-session.mjs';
import {RevisionStore,requestKey} from '../static/revisions.mjs';
import {moveCollectionItem} from '../static/collection-move.mjs';
import {historyEntry} from '../static/sent-history.mjs';
import {exportWorkspace,readWorkspaceBundle,mergeWorkspace} from '../static/workspace-data.mjs';
import {newScript} from '../static/scripts.mjs';
import {newRibbon,newRibbonGroup,newRibbonControl,newRibbonState,cloneRibbonState,
  validRibbonWorkspace,validRibbonState,ensureRequestRibbonState,getRequestRibbonOwner,getRequestRibbonState,
  findRequestRibbonState,requestRibbonWorkspace,prepareRibbonWrites,resolveRibbonControl} from '../static/ribbons.mjs';

let sequence=0;
const blank=()=>({id:`draft-${++sequence}`,name:'Untitled',request:newRequest(),settings:{},dirty:false});
const first=state=>state.ribbons[0].groups[0].controls[0];
function state() {
  const value=newRibbonState(),ribbon=newRibbon('Tools','tools'),group=newRibbonGroup('Actions'),control=newRibbonControl('number','Count');
  control.key='count';group.controls.push(control);ribbon.groups.push(group);value.ribbons.push(ribbon);value.activeRibbonId=ribbon.id;
  return value;
}
function fixture() {
  const a={_mpId:'a',name:'A',request:newRequest(),ribbonState:state()};
  const b={_mpId:'b',name:'B',request:newRequest(),ribbonState:cloneRibbonState(a.ribbonState)};
  const folder={_mpId:'folder',name:'Folder',item:[a,b]};
  const collection={_mpId:'collection',info:{name:'Requests'},item:[folder]};
  const workspace={version:2,collections:[collection],environments:[],globals:[],tabs:[],history:[],activeId:'',...clone(state())};
  delete workspace.id;
  const session=new RequestSession(workspace,blank);
  return {workspace,session,collection,folder,a,b};
}

test('request scopes use the saved owner and never fall back to preserved shared ribbons',()=>{
  const {workspace,session,collection,a,b}=fixture(),tab=session.openSaved(collection,a),untouched=clone(workspace);
  assert.equal(getRequestRibbonOwner(workspace,tab),a);
  assert.equal(getRequestRibbonState(workspace,tab),a.ribbonState);
  assert.equal(tab.ribbonState,a.ribbonState);
  assert.equal(getRequestRibbonState(workspace,{...tab,id:'another-editor'}),a.ribbonState);
  assert.deepEqual(workspace,untouched);
  const temporary=blank();temporary.ribbonState=cloneRibbonState(a.ribbonState);
  assert.equal(getRequestRibbonState(workspace,temporary),null);
  assert.throws(()=>ensureRequestRibbonState(workspace,temporary),/下書き/);
  const empty=requestRibbonWorkspace(workspace,null);
  assert.deepEqual([empty.ribbons,empty.activeRibbonId,empty.ribbonBindings],[[],'',{}]);
  assert.ok(workspace.ribbons.length);
  delete b.ribbonState;
  const other=session.openSaved(collection,b);
  assert.equal(getRequestRibbonState(workspace,other),null);
  const created=ensureRequestRibbonState(workspace,other);
  assert.equal(other.ribbonState,created);assert.equal(b.ribbonState,created);
  assert.deepEqual(created.ribbons,[]);assert.notEqual(created.id,a.ribbonState.id);
});

test('scoped views serialize current request data and forward only its ribbon fields',()=>{
  const {workspace,a,b}=fixture(),view=requestRibbonWorkspace(workspace,a.ribbonState);
  assert.equal(view.ribbons,a.ribbonState.ribbons);
  assert.equal(view.collections,workspace.collections);
  view.activeRibbonId='';assert.equal(a.ribbonState.activeRibbonId,'');assert.ok(b.ribbonState.activeRibbonId);
  view.ribbonBindings={group:{controls:{count:first(a.ribbonState).id}}};
  assert.equal(a.ribbonState.ribbonBindings,view.ribbonBindings);
  const encoded=clone(view);assert.deepEqual(encoded.ribbons,a.ribbonState.ribbons);assert.equal(encoded.activeRibbonId,'');
  assert.notEqual(view.ribbons,workspace.ribbons);
});

test('same internal IDs in different requests stay isolated through scripts and active request switches',()=>{
  const {workspace,session,collection,a,b}=fixture(),control=first(a.ribbonState),other=first(b.ribbonState);
  assert.equal(control.id,other.id);assert.notEqual(a.ribbonState.id,b.ribbonState.id);
  session.openSaved(collection,a);const scopeId=a.ribbonState.id;
  session.openSaved(collection,b);
  const commit=prepareRibbonWrites(workspace,[{type:'value',id:control.id,value:8,expected:0}],{scopeId});
  commit();assert.equal(control.value,8);assert.equal(other.value,0);assert.equal(first(workspace).value,0);
  assert.equal(findRequestRibbonState(workspace,scopeId),a.ribbonState);
  assert.throws(()=>prepareRibbonWrites(workspace,[{type:'value',id:control.id,value:99}],{scopeId:null}),/見つかりません/);
  assert.equal(prepareRibbonWrites(workspace,[],{scopeId:null})(),false);
});

test('deleted or replaced owners cannot redirect delayed writes to another request',()=>{
  const {workspace,folder,a,b}=fixture(),scopeId=a.ribbonState.id,id=first(a.ribbonState).id;
  const commit=prepareRibbonWrites(workspace,[{type:'value',id,value:8,expected:0}],{scopeId});
  const snapshot=clone(a.ribbonState);a.ribbonState=clone(snapshot);
  assert.throws(commit,/変更されました/);assert.equal(first(a.ribbonState).value,0);
  first(a.ribbonState).value=3;
  assert.throws(()=>prepareRibbonWrites(workspace,[{type:'visible',id,value:false,expected:true},{type:'value',id,value:8,expected:0}],{scopeId}),/変更されました/);
  assert.equal(first(a.ribbonState).visible,true);
  folder.item=folder.item.filter(item=>item!==a);
  workspace.history.push({id:'snapshot',tab:{...blank(),ribbonState:snapshot}});
  assert.equal(findRequestRibbonState(workspace,scopeId),null);
  assert.throws(()=>prepareRibbonWrites(workspace,[{type:'value',id,value:8}],{scopeId}),/見つかりません/);
  assert.equal(first(b.ribbonState).value,0);
});

test('request movement and draft registration preserve the owning ribbon scope',()=>{
  const {workspace,session,collection,a}=fixture(),tab=session.openSaved(collection,a),scope=a.ribbonState;
  const target={_mpId:'target',info:{name:'Target'},item:[]};workspace.collections.push(target);
  moveCollectionItem(workspace,{collectionId:collection._mpId,itemId:a._mpId,targetCollectionId:target._mpId},{editors:session.all()});
  assert.equal(getRequestRibbonState(workspace,tab),scope);
  const draft=session.addDraft(),draftState=ensureRequestRibbonState(workspace,draft);
  draftState.ribbons.push(newRibbon('Draft','draft'));
  const saved={_mpId:'saved-draft',name:draft.name,request:clone(draft.request)};target.item.push(saved);
  Object.assign(draft,{collectionId:target._mpId,itemId:saved._mpId});session.markSaved(draft);
  assert.equal(getRequestRibbonState(workspace,draft),draftState);
  assert.equal(findRequestRibbonState(workspace,draftState.id),draftState);
  assert.equal(validRibbonWorkspace(workspace),true);
});

test('a copied saved editor becomes an independent draft even when its caller copied the old scope ID',()=>{
  const {workspace,session,collection,a}=fixture(),tab=session.openSaved(collection,a);
  const copy=session.addDraft({...clone(tab),id:'copy',itemId:undefined});
  assert.notEqual(copy.ribbonState.id,a.ribbonState.id);
  assert.equal(first(copy.ribbonState).id,first(a.ribbonState).id);
  first(copy.ribbonState).value=5;
  assert.equal(first(a.ribbonState).value,0);assert.equal(validRibbonWorkspace(workspace),true);
});

test('keeping the editor of a deleted request cannot revive the scope of an in-flight script',()=>{
  const {workspace,session,collection,folder,a}=fixture(),tab=session.openSaved(collection,a),scopeId=a.ribbonState.id;
  folder.item=folder.item.filter(item=>item!==a);session.syncSaved();
  assert.equal(session.isTemporary(tab),true);assert.notEqual(tab.ribbonState.id,scopeId);
  session.addDraft(tab);
  assert.equal(findRequestRibbonState(workspace,scopeId),null);
  assert.throws(()=>prepareRibbonWrites(workspace,[{type:'value',id:first(a.ribbonState).id,value:8}],{scopeId}),/見つかりません/);
  assert.equal(first(getRequestRibbonState(workspace,tab)).value,0);
});

test('request, folder and collection copies fork scopes while preserving literal control references',()=>{
  const {collection,folder,a}=fixture(),before=clone(collection);
  for (const copy of [duplicateItem(a),duplicateItem(folder).item[0],duplicateCollection(collection,[]).item[0].item[0]]) {
    assert.notEqual(copy.ribbonState.id,a.ribbonState.id);
    assert.deepEqual(copy.ribbonState.ribbons,a.ribbonState.ribbons);
    first(copy.ribbonState).value=12;assert.equal(first(a.ribbonState).value,0);
  }
  assert.deepEqual(collection,before);
  const imported=importPostman(exportCollection(collection)).collections[0];
  assert.notEqual(imported.item[0].item[0].ribbonState.id,a.ribbonState.id);
  assert.deepEqual(imported.item[0].item[0].ribbonState.ribbons,a.ribbonState.ribbons);
  const invalid=exportCollection(collection);invalid.item[0].item[0].ribbonState.ribbons={};
  assert.throws(()=>importPostman(invalid),/リボン形式/);
});

test('history snapshots freeze ribbon values and opening history forks its editable scope',()=>{
  const {workspace,session,collection,a}=fixture(),tab=session.openSaved(collection,a);
  first(a.ribbonState).value=4;
  const entry=historyEntry(tab,{status:200});workspace.history.push(entry);
  first(a.ribbonState).value=9;
  assert.equal(first(entry.tab.ribbonState).value,4);
  const edit=session.openHistory(entry);
  assert.notEqual(edit.ribbonState.id,a.ribbonState.id);
  assert.equal(first(edit.ribbonState).value,4);
  assert.equal(session.openHistory(entry),edit);
  session.addDraft(edit);first(getRequestRibbonState(workspace,edit)).value=11;
  assert.equal(first(a.ribbonState).value,9);assert.equal(first(entry.tab.ribbonState).value,4);
});

test('request revisions restore ribbon definitions, values and active state to canonical saved editors',()=>{
  const {workspace,session,collection,a}=fixture(),tab=session.openSaved(collection,a),revisions=new RevisionStore(workspace),key=requestKey(workspace,tab);
  first(a.ribbonState).value=7;a.ribbonState.activeRibbonId='';revisions.capture();
  assert.equal(workspace.revisions[key].length,2);
  assert.equal(first(workspace.revisions[key][0].value.ribbonState).value,0);
  revisions.restore(key,workspace.revisions[key][0]);session.syncSaved();
  assert.equal(first(a.ribbonState).value,0);assert.ok(a.ribbonState.activeRibbonId);
  assert.equal(tab.ribbonState,a.ribbonState);
  const old=clone(workspace.revisions[key][0]);delete old.value.ribbonState;
  revisions.restore(key,old);session.syncSaved();
  assert.equal(getRequestRibbonState(workspace,tab),null);assert.equal(tab.ribbonState,undefined);assert.ok(workspace.ribbons.length);
});

test('multiple stale saved editor caches cannot replace the canonical ribbon in a revision',()=>{
  const {workspace,session,collection,a}=fixture(),tab=session.openSaved(collection,a);
  workspace.tabs.push({...clone(tab),id:'cache-one'},{...clone(tab),id:'cache-two'});
  const revisions=new RevisionStore(workspace);
  a.ribbonState=clone(a.ribbonState);first(a.ribbonState).value=6;revisions.capture();
  assert.equal(first(workspace.revisions[requestKey(workspace,tab)].at(-1).value.ribbonState).value,6);
  session.syncSaved();
  for(const cache of workspace.tabs) assert.equal(cache.ribbonState,a.ribbonState);
});

test('backups validate owned states without imposing global control keys or IDs',()=>{
  const {workspace,session,collection,a,b}=fixture();session.openSaved(collection,a);
  assert.equal(validRibbonState(a.ribbonState),true);assert.equal(validRibbonWorkspace(workspace),true);
  assert.deepEqual(readWorkspaceBundle(exportWorkspace(workspace)).workspace,workspace);
  const corruptions=[
    value=>{value.collections[0].item[0].item[1].ribbonState.id=a.ribbonState.id;},
    value=>{value.collections[0].item[0].item[0].ribbonState.activeRibbonId='gone';},
    value=>{value.history=[{tab:{...blank(),ribbonState:{id:'bad',ribbons:[]}}}];},
    value=>{value.revisions={'request:collection:a':[{value:{name:'bad',request:newRequest(),ribbonState:{id:'bad'}}}]};}
  ];
  for(const corrupt of corruptions) {const value=clone(workspace);corrupt(value);assert.equal(validRibbonWorkspace(value),false);assert.throws(()=>readWorkspaceBundle(exportWorkspace(value)));}
  assert.notEqual(a.ribbonState.id,b.ribbonState.id);
});

test('append import remaps each owning scope and script group without changing private ribbon identities',()=>{
  const {workspace:source,session,collection,a,b}=fixture(),script={...newScript('Update'),id:'script',bindingId:'binding'};
  source.scripts=[script];source.scriptBindings={binding:{Update:script.id}};
  for(const owner of [a,b]) {
    owner.ribbonState.ribbonBindings={binding:{ribbons:{Tools:owner.ribbonState.ribbons[0].id},controls:{Count:first(owner.ribbonState).id}}};
    first(owner.ribbonState).actions=[{id:'action',type:'script',scriptId:script.id}];
    owner.request._minipost={beforeScriptId:script.id,before:'return ribbon.get("Count")',scriptBindingId:'binding'};
  }
  const tab=session.openSaved(collection,a);source.tabs.push(tab);
  source.history.push(historyEntry(tab,{status:200}));
  const revisions=new RevisionStore(source);first(a.ribbonState).value=2;revisions.capture();
  const before=clone(source),into={version:2,collections:[],environments:[],globals:[],tabs:[],history:[]};
  mergeWorkspace(into,source);mergeWorkspace(into,source);
  assert.deepEqual(source,before);
  for(let index=0;index<2;index++) {
    const imported=into.collections[index].item[0].item,importedScript=into.scripts[index],cache=into.tabs[index];
    assert.notEqual(imported[0].ribbonState.id,a.ribbonState.id);
    assert.notEqual(imported[0].ribbonState.id,imported[1].ribbonState.id);
    assert.equal(cache.ribbonState.id,imported[0].ribbonState.id);
    assert.equal(into.history[index].tab.ribbonState.id,imported[0].ribbonState.id);
    for(const owner of imported) {
      assert.equal(first(owner.ribbonState).id,first(a.ribbonState).id);
      assert.equal(first(owner.ribbonState).actions[0].scriptId,importedScript.id);
      assert.equal(owner.request._minipost.beforeScriptId,importedScript.id);
      assert.equal(resolveRibbonControl(owner.ribbonState,'Count',{bindingId:importedScript.bindingId}).control,first(owner.ribbonState));
    }
    const key=`request:${into.collections[index]._mpId}:${imported[0]._mpId}`;
    assert.equal(into.revisions[key][0].value.ribbonState.id,imported[0].ribbonState.id);
    assert.equal(first(into.revisions[key][0].value.ribbonState).actions[0].scriptId,importedScript.id);
  }
  assert.notEqual(into.collections[0].item[0].item[0].ribbonState.id,into.collections[1].item[0].item[0].ribbonState.id);
  assert.equal(validRibbonWorkspace(into),true);
  assert.deepEqual(readWorkspaceBundle(exportWorkspace(into)).workspace,clone(into));
});
