import test from 'node:test';
import assert from 'node:assert/strict';
import {RequestSession} from '../static/request-session.mjs';
import {newRequest, clone, contextFor, findItem} from '../static/core.mjs';
import {RevisionStore, requestKey} from '../static/revisions.mjs';
import {exportWorkspace, readWorkspaceBundle, mergeWorkspace} from '../static/workspace-data.mjs';
import {moveCollectionItem} from '../static/collection-move.mjs';

let sequence = 0;
const blank = () => ({id:`draft-${++sequence}`, name:'Untitled request', request:newRequest(), dirty:false});
function fixture() {
  const item = {_mpId:'request',name:'Saved request',request:{method:'GET',url:'https://example.test/{{token}}'}};
  const folder = {_mpId:'folder',name:'Folder',variable:[{key:'token',value:'folder-token'}],item:[item]};
  const collection = {_mpId:'collection',info:{name:'Collection'},item:[folder]};
  const workspace = {version:2,collections:[collection],globals:[],environments:[],tabs:[],activeId:'',history:[]};
  const session = new RequestSession(workspace, blank);
  const entry = {id:'history',tab:{...blank(),name:item.name,request:clone(item.request),collectionId:collection._mpId,itemId:item._mpId}};
  workspace.history.push(entry);
  return {workspace,session,entry,collection,folder,item};
}
test('blank editors and opening or editing history never enter saved drafts, revisions or backups', () => {
  const {workspace,session,entry,item} = fixture(), revisions = new RevisionStore(workspace);
  assert.equal(session.isBlank(session.active),true);
  for (let n=0;n<20;n++) {
    const editor = session.openHistory({...entry,id:`history-${n}`});
    editor.name = `Temporary edit ${n}`; editor.request.url = `https://example.test/edit-${n}`; editor.dirty = true;
    revisions.capture();
    assert.equal(session.get(editor.id),editor);
  }
  const restored = readWorkspaceBundle(exportWorkspace(workspace)).workspace;
  assert.deepEqual(restored.tabs,[]);
  assert.equal(Object.keys(restored.revisions).some(key => key.startsWith('draft:')),false);
  assert.equal(item.request.url,'https://example.test/{{token}}');
  assert.equal(entry.tab.request.url,'https://example.test/{{token}}');
});
test('reopening history in the session retains edits and the attachment identity', () => {
  const {workspace,session,entry} = fixture();
  const editor = session.openHistory(entry);
  editor.request.body = {mode:'file',file:{src:'chosen.bin'}};
  editor.name = 'Edited history';
  session.openHistory({...entry,id:'other'});
  assert.equal(session.openHistory(entry),editor);
  assert.equal(session.active.request.body.file.src,'chosen.bin');
  assert.equal(session.get(editor.id),editor);
  assert.deepEqual(workspace.tabs,[]);
});
test('history retains folder variables and auth while remaining detached from the saved request', () => {
  const {workspace,session,entry,item,folder} = fixture();
  folder.auth = {type:'bearer',bearer:[{key:'token',value:'{{token}}'}]};
  const editor = session.openHistory(entry);
  assert.equal(editor.itemId,undefined);
  assert.equal(editor.pendingFolderId,folder._mpId);
  assert.equal(contextFor(workspace,editor).vars.token,'folder-token');
  assert.equal(contextFor(workspace,editor).auth.type,'bearer');
  editor.request.url = 'https://example.test/edited';
  assert.equal(item.request.url,'https://example.test/{{token}}');
});
test('explicitly saving a temporary editor creates exactly one recoverable draft', () => {
  const {workspace,session,entry} = fixture();
  const editor = session.openHistory(entry);
  editor.name = 'Keep this'; editor.request.url = 'https://example.test/kept';
  const id = editor.id;
  session.addDraft(editor); session.addDraft(editor);
  assert.equal(session.isTemporary(editor),false);
  assert.equal(workspace.tabs.length,1);
  assert.equal(workspace.tabs[0].id,id);
  const reloaded = new RequestSession(readWorkspaceBundle(exportWorkspace(workspace)).workspace,blank);
  assert.equal(reloaded.active.name,'Keep this');
  assert.equal(reloaded.active.request.url,'https://example.test/kept');
  // A later history opening is a new temporary edit, not a write to the saved draft.
  assert.notEqual(session.openHistory(entry).id,id);
  assert.equal(workspace.tabs.length,1);
});
test('saved requests restore their selection using a reference, without cached drafts', () => {
  const {workspace,session,collection,item} = fixture();
  const editor = session.openSaved(collection,item);
  assert.equal(session.openSaved(collection,item),editor);
  assert.deepEqual(workspace.tabs,[]);
  assert.deepEqual(workspace.activeRequest,{collectionId:'collection',itemId:'request'});
  const reloaded = new RequestSession(readWorkspaceBundle(exportWorkspace(workspace)).workspace,blank);
  assert.equal(reloaded.active.itemId,item._mpId);
  assert.equal(reloaded.active.name,item.name);
  assert.equal(reloaded.workspace.tabs.length,0);
});
test('saving history to a collection detaches the editor from subsequent history openings', () => {
  const {workspace,session,entry,collection} = fixture();
  const editor = session.openHistory(entry);
  editor.request.url = 'https://example.test/variant';
  const saved = {_mpId:'variant',name:'Saved variant',request:clone(editor.request)};
  collection.item.push(saved); Object.assign(editor,{collectionId:collection._mpId,itemId:saved._mpId});
  session.markSaved(editor);
  const reopened = session.openHistory(entry);
  assert.notEqual(reopened.id,editor.id);
  assert.equal(reopened.itemId,undefined);
  assert.equal(reopened.request.url,'https://example.test/{{token}}');
  reopened.request.url = 'https://example.test/independent';
  assert.equal(saved.request.url,'https://example.test/variant');
  assert.deepEqual(workspace.tabs,[]);
});
test('selecting an existing draft restores that draft instead of the previous saved request', () => {
  const {workspace,session,collection,item} = fixture();
  const draft = session.addDraft(); draft.name = 'Existing draft';
  session.openSaved(collection,item); session.select(draft.id);
  assert.equal(workspace.activeRequest,undefined);
  assert.equal(new RequestSession(clone(workspace),blank).active.id,draft.id);
});
test('deleting the final draft clears its revisions without generating a replacement draft', () => {
  const {workspace,session} = fixture();
  const revisions = new RevisionStore(workspace), draft = session.addDraft();
  revisions.capture();
  assert.ok(workspace.revisions[`draft:${draft.id}`]);
  session.remove([draft.id]); revisions.remove(`draft:${draft.id}`); revisions.capture();
  assert.deepEqual(workspace.tabs,[]);
  assert.equal(workspace.revisions[`draft:${draft.id}`],undefined);
  assert.equal(revisions.previous.has(`draft:${draft.id}`),false);
  assert.equal(session.isBlank(session.active),true);
  const reloaded = new RequestSession(clone(workspace),blank);
  assert.equal(reloaded.isBlank(reloaded.active),true);
  assert.deepEqual(reloaded.workspace.tabs,[]);
});
test('old drafts, including previously orphaned drafts, are preserved unchanged', () => {
  const {workspace} = fixture();
  const draft = {...blank(),name:'Old draft',collectionId:'removed',itemId:'old-request'};
  workspace.tabs.push(draft); workspace.activeId = draft.id;
  const session = new RequestSession(workspace,blank);
  session.syncSaved();
  assert.equal(session.active,draft);
  assert.deepEqual(workspace.tabs,[draft]);
});
test('deleting a saved request keeps its old editor temporary instead of exposing a new draft', () => {
  const {workspace,collection,item,folder} = fixture();
  const cached = {...blank(),collectionId:collection._mpId,itemId:item._mpId,request:clone(item.request)};
  workspace.tabs.push(cached); workspace.activeId = cached.id;
  const session = new RequestSession(workspace,blank);
  session.openSaved(collection,item); folder.item = []; session.syncSaved();
  assert.equal(session.active,cached);
  assert.equal(session.isTemporary(cached),true);
  assert.deepEqual(workspace.tabs,[]);
  assert.equal(workspace.activeRequest,undefined);
});
test('moving a saved request updates its editor and reload reference even while history is active', () => {
  const {workspace,session,collection,item,entry} = fixture();
  const editor = session.openSaved(collection,item);
  session.openHistory(entry);
  const target = {_mpId:'target',info:{name:'Target'},item:[]}; workspace.collections.push(target);
  moveCollectionItem(workspace,{collectionId:collection._mpId,itemId:item._mpId,targetCollectionId:target._mpId}, {editors:session.all()});
  session.rememberSelection();
  assert.equal(editor.collectionId,target._mpId);
  assert.deepEqual(workspace.tabs,[]);
  assert.equal(new RequestSession(clone(workspace),blank).active.collectionId,target._mpId);
});
test('moving a folder preserves variable context for temporary history and explicitly saved drafts', () => {
  const {workspace,session,entry,collection,folder} = fixture();
  const temporary = session.openHistory(entry);
  const draft = session.addDraft({...clone(temporary),id:'kept-draft'});
  workspace.history.push({id:'draft-history',tab:clone(draft)});
  const target = {_mpId:'target',info:{name:'Target'},item:[]}; workspace.collections.push(target);
  moveCollectionItem(workspace,{collectionId:collection._mpId,itemId:folder._mpId,targetCollectionId:target._mpId}, {editors:session.all()});
  for (const tab of [temporary,draft,workspace.history[1].tab]) {
    assert.equal(tab.collectionId,target._mpId);
    assert.equal(contextFor(workspace,tab).vars.token,'folder-token');
  }
  const merged = mergeWorkspace({version:2,collections:[],globals:[],environments:[],tabs:[],history:[]},workspace);
  assert.equal(contextFor(merged,merged.history[1].tab).vars.token,'folder-token');
});
test('revision restoration refreshes a temporary saved editor without creating a draft', () => {
  const {workspace,session,collection,item} = fixture();
  const editor = session.openSaved(collection,item), revisions = new RevisionStore(workspace);
  item.request.url = 'https://example.test/after'; session.syncSaved(); revisions.capture();
  const key = requestKey(workspace,editor);
  revisions.restore(key,workspace.revisions[key][0]); session.syncSaved();
  assert.equal(editor.request.url.raw,'https://example.test/{{token}}');
  assert.deepEqual(workspace.tabs,[]);
});
test('merging an empty workspace restores saved selection with remapped IDs', () => {
  const {workspace,session,collection,item} = fixture(); session.openSaved(collection,item);
  const into = {version:2,collections:[],globals:[],environments:[],tabs:[],history:[],activeId:''};
  mergeWorkspace(into,workspace);
  assert.notEqual(into.activeRequest.collectionId,collection._mpId);
  const target = into.collections.find(value => value._mpId === into.activeRequest.collectionId);
  assert.equal(findItem(target,into.activeRequest.itemId).item.name,item.name);
  assert.equal(new RequestSession(into,blank).active.name,item.name);
  assert.deepEqual(into.tabs,[]);
});
