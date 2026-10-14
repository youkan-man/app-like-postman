import test from 'node:test';
import assert from 'node:assert/strict';
import {copyName, duplicateItem, duplicateCollection, duplicateEnvironment, snapshotSettings, applySettings} from '../static/editops.mjs';

const collection = () => ({_mpId:'c', info:{name:'Collection',_postman_id:'pc'}, variable:[{key:'var',value:'original'}],auth:{type:'bearer',bearer:[{key:'token',value:'synthetic'}]},item:[{_mpId:'f',name:'Folder',item:[{_mpId:'r',name:'Request',request:{method:'GET',url:'http://example.test'}}]}]});
test('copy name avoids repeated collisions', () => assert.equal(copyName('dev',['dev copy','dev copy 2']), 'dev copy 3'));
test('subtree copies get distinct IDs at every level without modifying the original', () => {
  const source=collection().item[0], copy=duplicateItem(source);
  assert.notEqual(source._mpId,copy._mpId); assert.notEqual(source.item[0]._mpId,copy.item[0]._mpId);
  copy.item[0].request.method='POST';assert.equal(source.item[0].request.method,'GET');
});
test('collection copy preserves content but replaces export and UI identities', () => {
  const source=collection(), copy=duplicateCollection(source,['Collection copy']);
  assert.equal(copy.info.name,'Collection copy 2');assert.notEqual(copy.info._postman_id,source.info._postman_id);
  copy.variable[0].value='changed';assert.equal(source.variable[0].value,'original');
});
test('environment duplication deep-copies disabled and secret metadata', () => {
  const source={id:'e',name:'env',values:[{key:'secret',value:'test',type:'secret',disabled:true,description:{content:'desc'}}]};
  const copy=duplicateEnvironment(source,[]);assert.notEqual(copy.id,source.id);
  assert.equal(copy.values[0].type,'secret');assert.equal(copy.values[0].disabled,true);
  copy.values[0].description.content='new';assert.equal(source.values[0].description.content,'desc');
});
test('environment settings paste preserves target name and id', () => {
  const source={values:[{key:'x',value:'before'}]}, target={id:'target',name:'keep',values:[]};
  const snapshot=snapshotSettings(source,'environment');source.values[0].value='later';
  applySettings(target,'environment',snapshot);assert.equal(target.values[0].value,'before');assert.equal(target.name,'keep');assert.equal(target.id,'target');
  target.values[0].value='new';assert.equal(snapshot.values[0].value,'before');
});
test('scope paste replaces variables and auth but not child requests', () => {
  const source=collection(), target=collection(), snapshot=snapshotSettings(source,'scope');
  target.item=[];target.info.name='target';applySettings(target,'scope',snapshot);
  assert.equal(target.info.name,'target');assert.deepEqual(target.item,[]);assert.deepEqual(target.auth,source.auth);
  target.auth.bearer[0].value='different';assert.equal(source.auth.bearer[0].value,'synthetic');
});
test('request copy includes transport settings but preserves destination tab identity', () => {
  const snapshot=snapshotSettings({request:{method:'POST'},settings:{verify_tls:true,loopback_target:'docker-host'}},'request');
  const target={id:'other',name:'other'};applySettings(target,'request',snapshot);
  assert.equal(target.id,'other');assert.equal(target.settings.verify_tls,true);assert.equal(target.request.method,'POST');
});
test('incompatible clipboard types fail without changing target', () => {
  const target={values:[{key:'old',value:'keep'}]};assert.throws(()=>applySettings(target,'environment',{kind:'scope',variable:[]}),TypeError);
  assert.equal(target.values[0].key,'old');
});
