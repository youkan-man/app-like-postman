import test from 'node:test';
import assert from 'node:assert/strict';
import {historyEntry, historyUrl, sentRequests} from '../static/sent-history.mjs';
import {exportWorkspace, readWorkspaceBundle, mergeWorkspace} from '../static/workspace-data.mjs';
import {contextFor, compileRequest} from '../static/core.mjs';

const tab = () => ({id:'draft',name:'Send values',request:{method:'POST',url:'{{base}}/items',body:{mode:'raw',raw:'{{token}}'}}});
const sent = () => ({method:'POST',url:'https://example.test/items?q=before',headers:[{key:'Authorization',value:'Bearer before'}],body_mode:'text',body:'before',body_size:6,transmission:'sent'});
test('history retains transport values and original editable template independently', () => {
  const draft = tab(), result = {status:201,sent_requests:[sent()]};
  const entry = historyEntry(draft,result,{environmentId:'env',environmentName:'At send'});
  draft.request.url='changed';result.sent_requests[0].body='after';result.sent_requests[0].headers[0].value='after';
  assert.equal(entry.tab.request.url,'{{base}}/items');
  assert.equal(entry.sent_requests[0].body,'before');
  assert.equal(entry.sent_requests[0].headers[0].value,'Bearer before');
  assert.equal(entry.environmentName,'At send');
  assert.equal(historyUrl(entry),'https://example.test/items?q=before');
});
test('legacy history and a proven unsent request are distinguishable', () => {
  assert.equal(sentRequests(historyEntry(tab(),{status:200})),null);
  const error = Object.assign(new Error('Connection refused'),{sent_requests:[]});
  const entry = historyEntry(tab(),error);
  assert.deepEqual(sentRequests(entry),[]);assert.equal(entry.error,'Connection refused');assert.equal(entry.status,'ERR');
});
test('redirect evidence preserves each hop without duplicating sent_request', () => {
  const first=sent(),last={...sent(),url:'https://example.test/final',method:'GET',body_mode:'none',body:null};
  const entry=historyEntry(tab(),{status:200,sent_request:first,sent_requests:[first,last]});
  assert.equal(entry.sent_requests.length,2);assert.equal(entry.sent_requests[1].method,'GET');
  assert.equal(Object.hasOwn(entry,'sent_request'),false);
});
test('full export, restore and merge keep captured values exactly as sent', () => {
  const entry=historyEntry(tab(),{status:200,sent_requests:[{...sent(),body:'a'.repeat(70000)+'\n日本語'}]});
  const workspace={version:2,collections:[],environments:[],globals:[],tabs:[tab()],history:[entry]};
  const restored=readWorkspaceBundle(exportWorkspace(workspace)).workspace;
  const merged=mergeWorkspace({...workspace,history:[],tabs:[]},restored);
  assert.deepEqual(merged.history[0].sent_requests,entry.sent_requests);
  assert.notEqual(merged.history[0].id,entry.id);
  assert.equal(merged.history[0].sent_requests[0].body.length,70004);
});
test('history drafts retain their source folder variable and auth context without editing the original', () => {
  const original={_mpId:'request',name:'Original',request:{method:'GET',url:'https://example.test/{{token}}'}};
  const inner={_mpId:'inner',name:'Inner',variable:[{key:'token',value:'inner-token'}],item:[original]};
  const outer={_mpId:'outer',name:'Outer',auth:{type:'bearer',bearer:[{key:'token',value:'{{token}}'}]},item:[inner]};
  const workspace={collections:[{_mpId:'collection',info:{name:'Collection'},item:[outer]}],globals:[],environments:[]};
  const draft={...tab(),collectionId:'collection',pendingFolderId:'inner',request:structuredClone(original.request)};
  assert.equal(contextFor(workspace,draft).vars.token,'inner-token');
  const payload=compileRequest(workspace,draft).payload;
  assert.equal(payload.url,'https://example.test/inner-token');
  assert.equal(payload.headers.find(h=>h.key==='Authorization').value,'Bearer inner-token');
  draft.request.url='https://example.test/changed';
  assert.equal(original.request.url,'https://example.test/{{token}}');
});
