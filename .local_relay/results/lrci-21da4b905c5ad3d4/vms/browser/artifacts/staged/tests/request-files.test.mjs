import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {File} from 'node:buffer';
import {RequestFiles, encodeFile} from '../static/request-files.mjs';
import {runRelation, newRelation, newStep} from '../static/relations.mjs';
const binary={mode:'file'};
const data=(name, bytes=[0,1,255])=>new File([new Uint8Array(bytes)], name, {type:'application/octet-stream'});
const delayed=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('all 256 byte values and zero-length files encode without loss',async()=>{
 for(const bytes of [[],Array.from({length:256},(_,n)=>n)]) {const file=await encodeFile(data('日本語.bin',bytes));assert.deepEqual([...Buffer.from(file.data,'base64')],bytes);assert.equal(file.size,bytes.length);}
});
test('replacement immediately removes old bytes and Send waits for new bytes',async()=>{
 const s=new RequestFiles();await s.select('a','binary',[data('old')]);const next=delayed();
 const choosing=s.select('a','binary',[data('new')],{read:()=>next.promise});let finished=false;const sending=s.snapshot('a',binary).then(value=>{finished=true;return value;});
 await new Promise(r=>setImmediate(r));assert.equal(finished,false);assert.deepEqual(s.get('a','binary').files,[]);
 next.resolve(await encodeFile(data('new',[5,8])));await choosing;assert.equal((await sending).binary[0].data,'BQg=');
});
test('last selection wins even if an older read finishes last',async()=>{
 const s=new RequestFiles(),old=delayed();const pending=s.select('a','binary',[data('old')],{read:()=>old.promise});
 await s.select('a','binary',[data('new')]);old.resolve(await encodeFile(data('old')));await pending;
 assert.equal((await s.snapshot('a',binary)).binary[0].name,'new');
});
test('failed replacement does not silently reuse old bytes',async()=>{
 const s=new RequestFiles();await s.select('a','binary',[data('old')]);await s.select('a','binary',[data('bad')],{read:()=>Promise.reject(new Error('disk failure'))});
 await assert.rejects(s.snapshot('a',binary),/disk failure/);
});
test('multipart reads follow original row identity through insert and removal',async()=>{
 const s=new RequestFiles(),row={key:'upload',type:'file'},inserted={key:'other',type:'file'},pending=delayed();
 const selecting=s.select('a',row,[data('target')],{read:()=>pending.promise});const body={mode:'formdata',formdata:[inserted,row]};
 pending.resolve(await encodeFile(data('target')));await selecting;const files=await s.snapshot('a',body);
 assert.equal(files['form-1'][0].name,'target');assert.equal(files['form-0'],undefined);
 body.formdata.splice(0,1);assert.equal((await s.snapshot('a',body))['form-0'][0].name,'target');
});
test('invalidated owner and cleared selections cannot be resurrected by late reads',async()=>{
 for(const invalidate of ['owner','clear','delete']){const s=new RequestFiles(),pending=delayed();let valid=true;
 const selecting=s.select('a','binary',[data('gone')],{valid:()=>valid,read:()=>pending.promise});
 if(invalidate==='owner')valid=false;else if(invalidate==='clear')s.remove('a','binary');else s.delete('a');
 pending.resolve(await encodeFile(data('gone')));await selecting;assert.deepEqual(await s.snapshot('a',binary),{});}
});
test('cancelled waiting for a read never sends old data or blocks later operations',async()=>{
 const s=new RequestFiles(),pending=delayed(),abort=new AbortController();const choose=s.select('a','binary',[data('new')],{read:()=>pending.promise});
 const waiting=s.snapshot('a',binary,{signal:abort.signal});abort.abort();await assert.rejects(waiting,{name:'AbortError'});
 pending.resolve(await encodeFile(data('new')));await choose;assert.equal((await s.snapshot('a',binary)).binary[0].name,'new');
});
test('request files are isolated, disabled rows ignored, and returned bytes immutable',async()=>{
 const s=new RequestFiles(),row={key:'up',type:'file',disabled:true};await s.select('a',row,[data('a')]);await s.select('b','binary',[data('b')]);
 assert.deepEqual(await s.snapshot('a',{mode:'formdata',formdata:[row]}),{});row.disabled=false;
 const files=await s.snapshot('a',{mode:'formdata',formdata:[row]});files['form-0'][0].data='';
 assert.notEqual((await s.snapshot('a',{mode:'formdata',formdata:[row]}))['form-0'][0].data,'');assert.equal((await s.snapshot('b',binary)).binary[0].name,'b');
});
test('request payload and attachment indices remain paired when editing during a wait',async()=>{
 const s=new RequestFiles(),row={key:'upload',type:'file'},body={mode:'formdata',formdata:[row]},pending=delayed();
 const chosen=s.select('a',row,[data('captured')],{read:()=>pending.promise});const snapshot=s.snapshot('a',body);
 body.formdata.unshift({key:'inserted',type:'file'});pending.resolve(await encodeFile(data('captured')));await chosen;
 assert.equal((await snapshot)['form-0'][0].name,'captured');
});
test('production UI contains no browser-native alert, confirm or prompt calls',()=>{
 for(const path of fs.readdirSync('static').filter(p=>/\.(?:mjs|js)$/.test(p)))assert.doesNotMatch(fs.readFileSync('static/'+path,'utf8'),/(?<![\w$])(?:window\.)?(?:alert|confirm|prompt)\s*\(/,path);
});
test('relation captures attachment payloads before a delayed step is edited',async()=>{
 const tab={id:'d',name:'File',request:{method:'POST',url:'http://example.test',body:binary}};
 const w={collections:[],tabs:[tab]},r=newRelation('Files');r.steps=[newStep({draftId:'d'})];r.steps[0].delayMs=2;r.steps[0].repeat=2;
 let current='initial',captured;const result=await runRelation(r,{workspace:w,primary:()=>({}),filesFor:()=>({binary:[{data:current}]}),onProgress:()=>{current='changed';},execute:async(t,{files})=>{captured=files.binary[0].data;return {status:200};}});
 assert.equal(result.status,'succeeded');assert.equal(captured,'initial');
});
