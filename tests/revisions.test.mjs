import test from 'node:test';
import assert from 'node:assert/strict';
import {RevisionStore, settingsIndex, requestSettings} from '../static/revisions.mjs';
import {newRequest, normalizeRequest, rows} from '../static/core.mjs';
const sample = () => ({collections:[{_mpId:'c',info:{name:'Collection'},variable:[{key:'base',value:'original'}],item:[{_mpId:'f',name:'Folder',item:[{_mpId:'r',name:'Request',request:newRequest()}]}]}], environments:[{id:'e',name:'Development',values:[{key:'token',value:'first'}]}],globals:[],tabs:[],activeId:'',environmentId:'e'});
test('opening and repeated persistence without edits never creates revisions', () => {
 const w=sample(),store=new RevisionStore(w);store.capture();w.environmentId='';store.capture();
 w.environments[0].values=rows(w.environments[0].values);w.collections[0].auth=null;store.capture();assert.deepEqual(w.revisions,{});
});
test('environment changes have a baseline and remain separate from other settings', () => {
 const w=sample(),store=new RevisionStore(w);w.environments[0].values[0].value='second';store.capture();
 assert.equal(w.revisions['environment:e'].length,2);assert.equal(w.revisions['environment:e'][0].value.values[0].value,'first');
 assert.equal(w.revisions['environment:e'][1].value.values[0].value,'second');assert.deepEqual(Object.keys(w.revisions),['environment:e']);
});
test('restore appends a revision without changing identity, deleting history or sending', () => {
 const w=sample(),store=new RevisionStore(w);w.environments[0].name='Renamed';store.capture();const old=w.revisions['environment:e'][0];store.restore('environment:e',old);
 assert.equal(w.environments[0].name,'Development');assert.equal(w.environments[0].id,'e');assert.equal(w.revisions['environment:e'].length,3);assert.equal(w.revisions['environment:e'][2].reason,'復元');
});
test('legacy request drafts are indexed independently and normalized on selection', () => {
 const w=sample();w.tabs=[{id:'d',name:'Unsaved',request:newRequest(),dirty:true}];const store=new RevisionStore(w);w.tabs[0].request=normalizeRequest(w.tabs[0].request);store.capture();assert.deepEqual(w.revisions,{});
 w.tabs[0].request.method='POST';store.capture();assert.equal(w.revisions['draft:d'].length,2);assert.equal(w.tabs.length,1);
});
test('saved request and live draft share one history identity', () => {
 const w=sample();w.tabs=[{id:'d',collectionId:'c',itemId:'r',name:'Request',request:newRequest()}];const store=new RevisionStore(w);
 w.tabs[0].request.method='POST';store.capture();assert.deepEqual(Object.keys(w.revisions),['request:c:r']);assert.equal(settingsIndex(w).get('request:c:r').value.request.method,'POST');
 store.restore('request:c:r',w.revisions['request:c:r'][0]);assert.equal(w.tabs[0].request.method,'GET');assert.equal(w.tabs[0].dirty,true);
});
test('draft history follows first collection save', () => {
 const w=sample();w.tabs=[{id:'d',name:'Draft',request:newRequest()}];const store=new RevisionStore(w);w.tabs[0].name='Edited';store.capture();store.transfer('draft:d','request:c:new');
 assert.equal(w.revisions['request:c:new'].length,2);assert.equal(w.revisions['draft:d'],undefined);
});
test('all scope kinds have separate history without copying child snapshots', () => {
 const w=sample(),store=new RevisionStore(w);w.globals.push({key:'g',value:'1'});w.collections[0].variable[0].value='2';w.collections[0].item[0].name='F2';store.capture();
 assert.deepEqual(Object.keys(w.revisions).sort(),['collection:c','folder:c:f','globals']);assert.equal('item' in w.revisions['collection:c'][1].value,false);
});
test('new record and later mutation do not share snapshot references', () => {
 const w=sample(),store=new RevisionStore(w);w.environments.push({id:'e2',name:'New',values:[]});store.capture();w.environments[1].values.push({key:'x',value:'y'});assert.deepEqual(w.revisions['environment:e2'][0].value.values,[]);
});
test('request settings drop old routing options while preserving timeout and TLS', () => {
 assert.deepEqual(requestSettings({verify_tls:true,timeout_ms:100,loopback_target:'docker-host'}),{verify_tls:true,follow_redirects:true,timeout_ms:100});
});
test('reload keeps revisions, unchanged state does not append them', () => {
 const w=sample(),store=new RevisionStore(w);w.environments[0].name='Renamed';store.capture();const saved=JSON.parse(JSON.stringify(w)),again=new RevisionStore(saved);again.capture();assert.equal(saved.revisions['environment:e'].length,2);
});
