import test from 'node:test';
import assert from 'node:assert/strict';
import {File} from 'node:buffer';
import {readSelectedFile,copyAttachments} from '../static/request-files.mjs';
import {uploadPlan,uploadFiles,UPLOAD_CHUNK_BYTES} from '../static/upload-transport.mjs';
import {executeRequest} from '../static/execution.mjs';
import {PrimaryVariables} from '../static/runtime.mjs';
const token='a'.repeat(64);

test('selection probes at most 64 KiB, keeps the Blob, and never creates Base64',async()=>{
  class Large extends Blob {
    get size(){return 512*1024*1024;}
    async arrayBuffer(){throw Error('full-file read');}
    slice(start,end){assert.equal(start,0);assert.equal(end,65536);return new Blob([new Uint8Array(end-start)]);}
  }
  const file=new Large();const chosen=await readSelectedFile(file);
  assert.equal(chosen.blob,file);assert.equal(chosen.size,512*1024*1024);assert.equal(chosen.data,undefined);
});
test('attachment copy preserves Blob identity but snapshots descriptor mutations',()=>{
  const file=new File(['abc'],'test.bin'),original={binary:[{name:'old',blob:file}]};
  const copied=copyAttachments(original);original.binary[0].name='new';original.binary[0].blob=new Blob(['other']);
  assert.equal(copied.binary[0].blob,file);assert.equal(copied.binary[0].name,'old');
});
test('raw and multipart metadata never serialize file bytes',()=>{
  const file=new Blob([Uint8Array.of(0,255)]);
  const raw=uploadPlan({url:'http://example.test/日本語',body:null,body_file:file});
  assert.equal(raw.files[0],file);assert.equal(raw.request.body_upload,0);assert.equal(raw.request.body_file,undefined);
  assert.ok(JSON.stringify(raw.request).length<100);
  const multi=uploadPlan({multipart:[{key:'files',filename:'日本語.bin',file},{key:'text',value:'a & b'},{key:'files',filename:'empty.bin',file:new Blob([])}]});
  assert.equal(multi.files.length,2);assert.deepEqual(multi.request.multipart.map(part=>part.upload),[0,undefined,1]);
  assert.ok(!JSON.stringify(multi.request).includes('base64'));
});
test('chunks stay bounded; acknowledgement and metadata refer to exact slices',async()=>{
  const native=globalThis.fetch,cleanups=[];
  globalThis.fetch=async(path,options)=>{cleanups.push([path,options.method]);return {};};
  try{
    const file=new Blob([new Uint8Array(2*UPLOAD_CHUNK_BYTES+7)]),calls=[],progress=[];
    const result=await uploadFiles(uploadPlan({body_file:file}),undefined,async(path,options)=>{
      calls.push([path,options]);if(path==='/api/uploads')return {ok:true,upload_id:token,chunk_bytes:UPLOAD_CHUNK_BYTES};
      assert.ok(options.body instanceof Blob);assert.ok(options.body.size<=UPLOAD_CHUNK_BYTES);
      return {ok:true,offset:Number(options.headers['X-MiniPost-Offset'])+options.body.size};
    },row=>progress.push(row));
    assert.equal(calls.length,4);assert.equal(result.request.upload_id,token);
    assert.equal(progress.at(-2).phase,'upload');assert.equal(progress.at(-2).completed,file.size);
    assert.equal(progress.at(-1).phase,'send');assert.equal(progress.at(-1).completed,undefined);assert.equal(progress.at(-1).total,undefined);
    await result.release();await result.release();assert.deepEqual(cleanups,[['/api/uploads/'+token,'DELETE']]);
  }finally{globalThis.fetch=native;}
});
test('failed upload releases staging and never retries a chunk',async()=>{
  const native=globalThis.fetch;let cleanups=0,calls=0;
  globalThis.fetch=async()=>{cleanups++;return {};};
  try{
    await assert.rejects(uploadFiles(uploadPlan({body_file:new Blob(['abc'])}),undefined,async path=>{
      calls++;if(path==='/api/uploads')return {upload_id:token,chunk_bytes:UPLOAD_CHUNK_BYTES};throw Error('disk full');
    }),/disk full/);
    assert.equal(calls,2);assert.equal(cleanups,1);
  }finally{globalThis.fetch=native;}
});
test('zero-byte files need no data chunk, and partial acknowledgement fails closed',async()=>{
  const native=globalThis.fetch;globalThis.fetch=async()=>({});
  try{
    let calls=0;const empty=await uploadFiles(uploadPlan({body_file:new Blob([])}),undefined,async()=>{calls++;return {upload_id:token,chunk_bytes:UPLOAD_CHUNK_BYTES};});
    assert.equal(calls,1);await empty.release();
    await assert.rejects(uploadFiles(uploadPlan({body_file:new Blob(['abc'])}),undefined,async path=>path==='/api/uploads'?{upload_id:token,chunk_bytes:UPLOAD_CHUNK_BYTES}:{offset:1}),/転送位置/);
  }finally{globalThis.fetch=native;}
});
test('abort before upload does not create a server transfer',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(uploadFiles(uploadPlan({body_file:new Blob(['abc'])}),controller.signal,()=>{throw Error('must not call');}),{name:'AbortError'});
});
test('asynchronous scripts preserve the selected File in execution, not an empty JSON object',async()=>{
  const file=new File(['original'],'firmware.bin'),files={binary:[{name:file.name,type:file.type,size:file.size,blob:file}]};
  let ready,release;const entered=new Promise(resolve=>ready=resolve),gate=new Promise(resolve=>release=resolve);
  let sent;
  const running=executeRequest({workspace:{collections:[],environments:[],globals:[]},primary:new PrimaryVariables(),
    tab:{request:{method:'PUT',url:'http://example.test/upload',body:{mode:'file'},_minipost:{before:'wait'}}},files,
    script:async()=>{ready();await gate;return {writes:{primary:[],environment:[],globals:[]},logs:[]};},
    send:async payload=>{sent=payload;return {status:200,body:'',headers:[]};}});
  await entered;files.binary[0].blob=new Blob(['replacement']);release();await running;
  assert.equal(sent.body_file,file);assert.equal(await sent.body_file.text(),'original');
});
