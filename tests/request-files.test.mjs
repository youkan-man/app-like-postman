import {File} from 'node:buffer';
import test from 'node:test';
import assert from 'node:assert/strict';
import {RequestFiles, readSelectedFile} from '../static/request-files.mjs';
import {compileRequest, newRequest} from '../static/core.mjs';
import {executeRequest} from '../static/execution.mjs';
import {PrimaryVariables} from '../static/runtime.mjs';
const binary = () => ({method:'POST',url:'http://example.test/upload',body:{mode:'file'}});
const file = (name, bytes) => new File([Uint8Array.from(bytes)], name, {type:'application/octet-stream'});
const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const stored = name => ({name,type:'application/octet-stream',size:1,data:'AA=='});
for (const length of [0,1,2,255,256,49151,49152,49153,6*1024*1024]) {
  test(`file-backed selection preserves every byte: ${length} bytes`,async()=>{
    const input=Buffer.alloc(length);for(let i=0;i<length;i++)input[i]=i%256;
    const result=await readSelectedFile(file('日本語.bin',input));
    assert.equal(result.data,undefined);assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),input);assert.equal(result.size,length);
  });
}
test('send awaits the newly selected file, never the previous selection',async()=>{
  const slow=deferred();const attachments=new RequestFiles({read:async input=>input.name==='new'?slow.promise:stored(input.name)});
  await attachments.read('request','binary',[{name:'old'}]);
  const reading=attachments.read('request','binary',[{name:'new'}]);
  assert.equal(attachments.get('request').binary,undefined);
  let finished=false;const sending=attachments.snapshot('request',binary()).then(value=>{finished=true;return value;});
  await Promise.resolve();assert.equal(finished,false);
  slow.resolve(stored('new'));await reading;
  assert.equal((await sending).binary[0].name,'new');
});
test('an older slow read cannot replace a newer selection',async()=>{
  const slow=deferred(),attachments=new RequestFiles({read:async input=>input.name==='slow'?slow.promise:stored(input.name)});
  const old=attachments.read('r','binary',[{name:'slow'}]);
  await attachments.read('r','binary',[{name:'fast'}]);slow.resolve(stored('slow'));await old;
  assert.equal(attachments.get('r').binary[0].name,'fast');
});
test('failed replacement cannot send the previous file',async()=>{
  const attachments=new RequestFiles({read:async input=>{if(input.name==='bad')throw Error('cannot read');return stored(input.name);}});
  await attachments.read('r','binary',[{name:'good'}]);await attachments.read('r','binary',[{name:'bad'}]);
  await assert.rejects(attachments.snapshot('r',binary()),/cannot read/);assert.equal(attachments.get('r').binary,undefined);
});
test('empty chooser result preserves the existing file and cancellation leaves no data change',async()=>{
  const attachments=new RequestFiles({read:async input=>stored(input.name)});
  await attachments.read('r','binary',[{name:'keep'}]);await attachments.read('r','binary',[]);
  assert.equal(attachments.get('r').binary[0].name,'keep');
});
test('multipart insertion and deletion move ready and pending files with their rows',async()=>{
  const pending=deferred(),attachments=new RequestFiles({read:async input=>input.name==='pending'?pending.promise:stored(input.name)});
  await attachments.read('r','form-0',[{name:'a'}]);const reading=attachments.read('r','form-1',[{name:'pending'}]);
  attachments.spliceRows('r',0,0,1);pending.resolve(stored('pending'));const slot=await reading;
  assert.equal(attachments.keyOf('r',slot),'form-2');assert.equal(attachments.get('r')['form-1'][0].name,'a');
  attachments.spliceRows('r',1,1,0);assert.equal(attachments.get('r')['form-1'][0].name,'pending');assert.equal(attachments.get('r')['form-2'],undefined);
});
test('deleted row and deleted request never reappear when their file reads finish',async()=>{
  for(const scope of ['row','request','all']){
    const pending=deferred(),attachments=new RequestFiles({read:async()=>pending.promise});
    const reading=attachments.read('r','form-0',[{name:'slow'}]);
    if(scope==='row')attachments.spliceRows('r',0,1,0);else if(scope==='request')attachments.delete('r');else attachments.clear();
    pending.resolve(stored('slow'));assert.equal(await reading,null);assert.equal(attachments.get('r')?.['form-0'],undefined);
  }
});
test('Send snapshot cannot be changed by reselecting or removing a ready file',async()=>{
  const attachments=new RequestFiles({read:async input=>stored(input.name)});
  await attachments.read('r','binary',[{name:'at-send'}]);const sending=attachments.snapshot('r',binary());
  await attachments.read('r','binary',[{name:'later'}]);attachments.remove('r','binary');
  assert.equal((await sending).binary[0].name,'at-send');
});
test('changing rows while Send awaits a read fails instead of sending a different row',async()=>{
  const pending=deferred(),attachments=new RequestFiles({read:async()=>pending.promise});
  const reading=attachments.read('r','form-0',[{name:'slow'}]);
  const sending=attachments.snapshot('r',{body:{mode:'formdata',formdata:[{key:'upload',type:'file'}]}});
  const rejected=assert.rejects(sending,/行が変更/);
  attachments.spliceRows('r',0,0,1);pending.resolve(stored('slow'));await reading;await rejected;
});
test('Stop cancels waiting for a file without sending or destroying the selection',async()=>{
  const pending=deferred(),attachments=new RequestFiles({read:async()=>pending.promise}),controller=new AbortController();
  const reading=attachments.read('r','binary',[{name:'slow'}]);const sending=attachments.snapshot('r',binary(),controller.signal);
  const rejected=assert.rejects(sending,{name:'AbortError'});controller.abort();await rejected;
  pending.resolve(stored('slow'));await reading;assert.equal(attachments.get('r').binary[0].name,'slow');
});
test('disabled binary and multipart rows neither read nor wait for files',async()=>{
  const pending=deferred(),attachments=new RequestFiles({read:async()=>pending.promise});
  const reading=attachments.read('r','form-0',[{name:'slow'}]);
  assert.deepEqual(await attachments.snapshot('r',{body:{mode:'formdata',formdata:[{key:'off',type:'file',disabled:true}]}}),{});
  assert.deepEqual(await attachments.snapshot('r',{body:{mode:'file',disabled:true}}),{});
  attachments.clear();pending.resolve(stored('slow'));await reading;
});
test('binary compile preserves empty and all-byte files and user Content-Type',async()=>{
  const attachments=new RequestFiles(),workspace={collections:[],environments:[],globals:[]};
  for(const length of [0,256]){
    const bytes=Uint8Array.from({length},(_,i)=>i);await attachments.read('r','binary',[file('bytes.bin',bytes)]);
    const request={...binary(),header:[{key:'Content-Type',value:'custom/binary'}]};
    const payload=compileRequest(workspace,{request},await attachments.snapshot('r',request)).payload;
    assert.equal(payload.body_base64,undefined);assert.deepEqual(Buffer.from(await payload.body_file.arrayBuffer()),Buffer.from(bytes));
    assert.equal(payload.headers.find(row=>row.key==='Content-Type').value,'custom/binary');
  }
});
test('file bytes are frozen before an asynchronous pre-request script',async()=>{
  const gate=deferred(),entered=deferred(),workspace={collections:[],environments:[],globals:[]};
  const request={...binary(),_minipost:{before:'wait'}};const files={binary:[stored('original')]};let payload;
  const executing=executeRequest({workspace,tab:{request},files,primary:new PrimaryVariables(),
    script:async()=>{entered.resolve();await gate.promise;return {writes:{primary:[],environment:[],globals:[]},logs:[]};},
    send:async value=>{payload=value;return {status:200,body:'',headers:[]};}});
  await entered.promise;files.binary[0].data='AQ==';gate.resolve();await executing;
  assert.equal(payload.body_base64,'AA==');
});
