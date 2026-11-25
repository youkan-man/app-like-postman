import test from 'node:test';
import assert from 'node:assert/strict';
import {historyEntry, historyUrl, sentRequests, relationStatusLabel, isRelationHistory} from '../static/sent-history.mjs';
import {exportWorkspace, readWorkspaceBundle, mergeWorkspace} from '../static/workspace-data.mjs';
import {contextFor, compileRequest} from '../static/core.mjs';
import {newRelationRequest} from '../static/relation-requests.mjs';
import {newRelationStep} from '../static/relations.mjs';
import {RequestSession} from '../static/request-session.mjs';

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

test('relation history captures the plan and run independently without an HTTP outcome or inactive URL', () => {
  const request=newRelationRequest('Workflow'),step=newRelationStep('wait');request.relation.steps.push(step);
  request.method='POST';request.url='https://inactive.example.test';
  const draft={id:'workflow-draft',name:'Workflow',request};
  const run={id:'run',relationId:request.relation.id,name:'Workflow',status:'succeeded',entries:[{stepId:step.id,requestName:'待機',status:'succeeded',elapsed_ms:8}]};
  const entry=historyEntry(draft,{type:'relation',run,elapsed_ms:12},{environmentId:'env',environmentName:'Production'});
  request.relation.steps[0].delayMs=999;run.entries[0].status='failed';
  assert.equal(entry.type,'relation');assert.equal(entry.status,'succeeded');
  assert.equal(entry.relation_run.entries[0].status,'succeeded');assert.equal(entry.elapsed_ms,12);
  assert.notEqual(entry.tab.request.relation.steps[0].delayMs,999);
  assert.equal(entry.environmentName,'Production');assert.equal(historyUrl(entry),'');assert.equal(sentRequests(entry),null);
  assert.equal(relationStatusLabel(entry.status),'完了');
});

test('failed and cancelled relation execution history survives backup and merge', () => {
  const request=newRelationRequest('Workflow');request.relation.steps.push(newRelationStep('wait'));
  const draft={id:'workflow',name:'Workflow',request};
  const history=['failed','cancelled','completed_with_errors'].map(status=>historyEntry(draft,{type:'relation',run:{id:'run-'+status,relationId:request.relation.id,name:'Workflow',status,entries:[],error:'Stopped'}}));
  const workspace={version:2,collections:[],environments:[],globals:[],tabs:[draft],history};
  const restored=readWorkspaceBundle(exportWorkspace(workspace)).workspace;
  const merged=mergeWorkspace({version:2,collections:[],environments:[],globals:[],tabs:[],history:[]},restored);
  assert.deepEqual(merged.history.map(entry=>entry.status),['failed','cancelled','completed_with_errors']);
  for(const entry of merged.history){assert.equal(entry.tab.request.type,'relation');assert.equal(entry.relation_run.status,entry.status);assert.equal(entry.relation_run.error,'Stopped');assert.equal(historyUrl(entry),'');}
  assert.equal(historyEntry(draft,new Error('Invalid step')).status,'failed');
});

test('a relation result from an HTTP before-script displays the captured run and replays its original template', () => {
  const draft=tab();draft.request._minipost={enabled:true,before:"request.set('type','relation');"};
  const original=structuredClone(draft.request);
  const run={id:'converted-run',relationId:'converted-flow',name:draft.name,status:'succeeded',entries:[{stepId:'wait',requestName:'待機',status:'succeeded'}]};
  const entry=historyEntry(draft,{type:'relation',run,elapsed_ms:1});
  run.entries[0].status='failed';draft.request._minipost.before='changed';
  assert.equal(isRelationHistory(entry),true);assert.equal(entry.type,'relation');
  assert.equal(entry.status,'succeeded');assert.equal(entry.relation_run.entries[0].status,'succeeded');
  assert.equal(historyUrl(entry),'');assert.equal(sentRequests(entry),null);
  assert.deepEqual(entry.tab.request,original);
  const workspace={collections:[],tabs:[],history:[entry],environments:[],globals:[]};
  const session=new RequestSession(workspace,tab),replay=session.openHistory(entry);
  assert.deepEqual(replay.request,original);
  assert.equal(replay.request.type,undefined);assert.equal(replay.request.method,'POST');
  assert.equal(replay.request._minipost.before,"request.set('type','relation');");
});
