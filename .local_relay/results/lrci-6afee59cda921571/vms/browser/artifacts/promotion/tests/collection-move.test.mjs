import test from 'node:test';
import assert from 'node:assert/strict';
import {moveCollectionItem} from '../static/collection-move.mjs';
import {RevisionStore} from '../static/revisions.mjs';
import {newRequest,findItem} from '../static/core.mjs';
const sample=()=>({collections:[{_mpId:'a',info:{name:'A'},item:[{_mpId:'folder',name:'F',item:[{_mpId:'one',name:'One',request:newRequest()}]},{_mpId:'two',name:'Two',request:newRequest()}]},{_mpId:'b',info:{name:'B'},item:[]}],tabs:[{id:'draft-one',collectionId:'a',itemId:'one',name:'One',request:newRequest()}],activeId:'draft-one',environments:[],globals:[],relations:[{id:'rel',name:'rel',steps:[{collectionId:'a',itemId:'one'}]}],history:[{tab:{collectionId:'a',itemId:'one'}}],revisions:{'request:a:one':[{id:'revision',value:{name:'One'}}]},collapsed:[]});
test('reorder preserves the actual object and IDs',()=>{
 const w=sample(),item=w.collections[0].item[1];
 moveCollectionItem(w,{collectionId:'a',itemId:'two',targetCollectionId:'a',targetId:'folder',position:'before'});
 assert.equal(w.collections[0].item[0],item);assert.equal(item._mpId,'two');
});
test('folder move transfers descendant refs, active draft and per-setting history',()=>{
 const w=sample(),store=new RevisionStore(w),draft=w.tabs[0],history=w.revisions['request:a:one'];
 const out=moveCollectionItem(w,{collectionId:'a',itemId:'folder',targetCollectionId:'b',position:'inside'},{transfer:(a,b)=>store.transfer(a,b)});
 assert.equal(out.transfers.length,2);assert.equal(w.tabs[0],draft);assert.equal(draft.collectionId,'b');assert.equal(w.activeId,'draft-one');
 assert.equal(w.relations[0].steps[0].collectionId,'b');assert.equal(w.history[0].tab.collectionId,'b');
 assert.equal(w.revisions['request:b:one'],history);assert.equal(w.revisions['request:a:one'],undefined);
 store.capture();assert.equal(history.length,1);assert.equal(findItem(w.collections[1],'one').item.name,'One');
});
test('invalid descendant, stale and non-folder drops are atomic',()=>{
 for(const intent of [
  {collectionId:'a',itemId:'folder',targetCollectionId:'a',targetId:'one',position:'inside'},
  {collectionId:'a',itemId:'one',targetCollectionId:'a',targetId:'two',position:'inside'},
  {collectionId:'a',itemId:'one',targetCollectionId:'missing',position:'inside'},
  {collectionId:'a',itemId:'one',targetCollectionId:'a',targetId:'missing',position:'after'}]){
  const w=sample(),before=JSON.stringify(w);assert.throws(()=>moveCollectionItem(w,intent));assert.equal(JSON.stringify(w),before);
 }
});
test('drop inside folder then move to root preserves identity and ordering',()=>{
 const w=sample(),two=w.collections[0].item[1];
 moveCollectionItem(w,{collectionId:'a',itemId:'two',targetCollectionId:'a',targetId:'folder',position:'inside'});
 assert.equal(w.collections[0].item[0].item[1],two);
 moveCollectionItem(w,{collectionId:'a',itemId:'two',targetCollectionId:'a',position:'inside'});
 assert.equal(w.collections[0].item[1],two);
});
test('adjacent reorder is a no-op, top-level collections can reorder',()=>{
 const w=sample();assert.equal(moveCollectionItem(w,{collectionId:'a',itemId:'two',targetCollectionId:'a',targetId:'folder',position:'after'}).changed,false);
 const a=w.collections[0];moveCollectionItem(w,{collectionId:'a',targetCollectionId:'b',position:'after'});assert.equal(w.collections[1],a);
});
test('ID collisions do not overwrite a target or its history',()=>{
 const w=sample();w.collections[1].item.push({_mpId:'one',name:'foreign',request:newRequest()});
 const before=JSON.stringify(w);assert.throws(()=>moveCollectionItem(w,{collectionId:'a',itemId:'one',targetCollectionId:'b',position:'inside'}));assert.equal(JSON.stringify(w),before);
});
