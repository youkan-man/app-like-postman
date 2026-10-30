import test from 'node:test';
import assert from 'node:assert/strict';
import {watchTransferProgress} from '../static/transfer-monitor.mjs';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async predicate=>{const deadline=Date.now()+2000;while(!predicate()){assert.ok(Date.now()<deadline,'telemetry deadline');await wait(5);}};
function mock(t,fetcher){const prior=globalThis.fetch;globalThis.fetch=fetcher;t.after(()=>{globalThis.fetch=prior;});}
const reply=progress=>({ok:true,status:200,json:async()=>({ok:true,progress})});
test('progress polling is serial and stops without late updates',async t=>{
  let active=0,peak=0,count=0;const events=[];
  mock(t,async()=>{peak=Math.max(peak,++active);await wait(6);active--;count++;return reply({phase:'send',completed:count,total:20});});
  const stop=watchTransferProgress('/progress',null,x=>events.push(x),{intervalMs:2});
  await until(()=>events.length>=3);stop();const n=events.length;await wait(20);
  assert.equal(peak,1);assert.ok(n>=2);assert.equal(events.length,n);
});
test('a missing finished session stops polling and is not a transfer failure',async t=>{
  let count=0;mock(t,async()=>{count++;return {ok:false,status:404};});
  watchTransferProgress('/progress',null,()=>assert.fail('no update expected'),{intervalMs:1});
  await wait(15);assert.equal(count,1);
});
test('poll failure becomes indeterminate and does not retry the upload or request',async t=>{
  const events=[];let count=0;
  mock(t,async path=>{assert.equal(path,'/progress');if(++count===1)throw Error('offline');return reply({phase:'waiting'});});
  const stop=watchTransferProgress('/progress',null,x=>events.push(x),{intervalMs:2});
  await until(()=>events.some(x=>x.phase==='waiting'));stop();assert.deepEqual(events[0],{phase:'send'});assert.ok(events.some(x=>x.phase==='waiting'));
});
test('abort cancels an outstanding progress fetch and removes its listener',async t=>{
  const controller=new AbortController();let aborted=false;
  mock(t,(path,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('stopped','AbortError'));})));
  watchTransferProgress('/progress',controller.signal,()=>assert.fail('late update'));controller.abort();await wait(5);assert.equal(aborted,true);
});
test('old backend without progress support adds no requests',async t=>{
  mock(t,async()=>assert.fail('no fetch'));
  watchTransferProgress(null,null,()=>{})();await wait(5);
});
