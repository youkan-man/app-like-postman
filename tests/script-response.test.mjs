import test from 'node:test';
import assert from 'node:assert/strict';
import {executeScript,scriptExecutorSource} from '../static/script-worker.mjs';
import {executeRequest} from '../static/execution.mjs';
import {responseMetadata,PrimaryVariables} from '../static/runtime.mjs';
import {applyResponseMutation,restoreOriginalResponse,applyRequestMutation} from '../static/script-response.mjs';
import {evaluateCondition} from '../static/relations.mjs';
import {normalizeRequest} from '../static/core.mjs';
import {RequestFiles} from '../static/request-files.mjs';

function wire(overrides={}){
  return {ok:true,status:200,status_text:'OK',headers:[{key:'Content-Type',value:'application/json'},{key:'X-Trace',value:'original'}],
    body:'{\n  "id": 1, "name": "original"\n}',body_encoding:'text',body_base64:'eyJvcmlnaW5hbCI6dHJ1ZX0=',content_type:'application/json',
    elapsed_ms:17,size:33,url:'https://service.invalid/received',received_at:'2026-11-17T10:00:00Z',redirects:[{status:302,url:'https://service.invalid/start'}],
    sent_requests:[{method:'GET',url:'https://service.invalid/received',headers:[{key:'x-request',value:'evidence'}]}],...overrides};
}
const context=response=>({response:responseMetadata(response),raw:response,request:{method:'GET',url:'https://service.invalid/start',header:[]}});
function setup(automation={}){
  const workspace={version:2,collections:[],environments:[{id:'env',name:'Env',values:[]}],environmentId:'env',globals:[],scripts:[],scriptData:{kept:1},tabs:[],history:[]};
  const tab={id:'draft',name:'Request',request:{method:'GET',url:'https://service.invalid/start',header:[],body:{mode:'none'},_minipost:automation},settings:{}};
  workspace.tabs.push(tab);
  return {workspace,tab,primary:new PrimaryVariables()};
}

test('reading a response does not reserialize its original text or binary bytes',async()=>{
  for(const original of [wire(),wire({body:'AP+A',body_base64:'AP+A',body_encoding:'base64',content_type:'application/octet-stream',headers:[]})]){
    const output=await executeScript('return {text:response.text(),same:response===minipost.response,header:response.getHeader("X-TRACE")};',context(original));
    assert.equal(output.result.text,original.body);assert.equal(output.result.same,true);
    assert.equal(Object.hasOwn(output,'response'),false);assert.equal(Object.hasOwn(output,'request'),false);
    assert.equal(applyResponseMutation(original,responseMetadata(original)),original);
  }
  const original=wire({body:'"a JSON string"'});
  assert.equal((await executeScript('return pm.response.json();',context(original))).result,'a JSON string');
});

test('nested scripts share one staged response and request while pm reads current values',async()=>{
  const original=wire(),ctx=context(original);ctx.scripts=[{id:'child',name:'Child',source:`
    response.body.id += 2; minipost.request.method = 'PATCH'; response.status = 202;
    response.statusText = 'Accepted'; response.setHeader('X-Child', ['one','two']);
    return {same:response===minipost.response,code:pm.response.code,body:pm.response.json()};
  `}];
  const output=await executeScript(`
    response.body.id = 5;
    const child = await scripts.run('child');
    response.show('raw');
    return {child,id:response.json().id,method:pm.request.method,header:pm.response.headers.get('X-CHILD'),text:pm.response.text(),status:pm.response.status,size:pm.response.responseSize};
  `,ctx);
  assert.equal(output.result.child.same,true);assert.equal(output.result.child.code,202);
  assert.equal(output.result.id,7);assert.equal(output.result.method,'PATCH');assert.equal(output.result.header,'one');
  assert.equal(output.result.status,'Accepted');assert.equal(output.result.text,'{"id":7,"name":"original"}');
  assert.equal(output.result.size,new TextEncoder().encode(output.result.text).byteLength);
  assert.equal(output.response.body.id,7);assert.equal(output.response.view,'raw');assert.equal(output.request.method,'PATCH');
  assert.equal(Object.hasOwn(output.response,'setBody'),false);assert.equal(Object.hasOwn(output.response,'json'),false);
  assert.deepEqual(ctx.response,responseMetadata(original));assert.equal(ctx.request.method,'GET');
});

test('the serialized Worker executor includes mutation helpers without module closures',async()=>{
  const isolated=Function(`${scriptExecutorSource()}\nreturn executeScript;`)();
  const output=await isolated('response.setBody({message:"日本語"}); response.show("pretty"); return pm.response.responseSize;',context(wire()));
  assert.equal(output.result,new TextEncoder().encode('{"message":"日本語"}').byteLength);
  assert.equal(output.response.view,'pretty');
});

test('response conversion preserves send evidence and corrects content bytes and headers',async()=>{
  const original=wire({headers:[{key:'Content-Type',value:'application/json'},{key:'Content-Length',value:'999'},{key:'Content-Encoding',value:'gzip'},{key:'X-Trace',value:'original'}]});
  const output=await executeScript(`
    response.setBody({message:'日本語',ready:true}); response.setHeader('Set-Cookie',['a=1','b=2']);
    response.removeHeader('X-TRACE'); response.status=201; response.statusText='Created';
    response.elapsed_ms=9999; response.url='https://fake.invalid'; response.received_at='fake'; response.size=999;
  `,context(original));
  const changed=applyResponseMutation(original,output.response),metadata=responseMetadata(changed);
  assert.deepEqual(metadata.body,{message:'日本語',ready:true});assert.equal(changed.status,201);
  assert.equal(changed.size,new TextEncoder().encode(changed.body).byteLength);
  assert.equal(metadata.headers['content-length'],String(changed.size));assert.equal(metadata.headers['content-encoding'],undefined);
  assert.equal(metadata.headers['x-trace'],undefined);assert.deepEqual(metadata.cookies,['a=1','b=2']);
  assert.equal(changed.body_base64,undefined);
  for(const key of ['elapsed_ms','url','received_at','sent_requests','redirects'])assert.deepEqual(changed[key],original[key]);
  assert.deepEqual(changed.original_response,original);
  assert.equal(original.headers[1].value,'999');assert.equal(original.body,wire().body);
});

test('view-only effects do not mark original bytes as modified and restore removes the view',async()=>{
  const original=wire();
  const output=await executeScript('response.show("headers");',context(original));
  const changed=applyResponseMutation(original,output.response);
  assert.equal(changed.response_view,'headers');assert.equal(changed.original_response,undefined);
  assert.equal(changed.body,original.body);assert.equal(changed.body_base64,original.body_base64);
  assert.deepEqual(restoreOriginalResponse(changed),original);
  assert.equal(restoreOriginalResponse(original),original);
});

test('repeating an explicit view request creates a new presentation without modifying bytes',async()=>{
  const original=wire();
  const first=await executeScript('response.show("raw");',context(original));
  const one=applyResponseMutation(original,first.response);
  const second=await executeScript('response.show("raw");',context(one));
  const two=applyResponseMutation(one,second.response);
  assert.notEqual(two,one,'a later explicit show must be applied even after manual view selection');
  assert.deepEqual(two,one);assert.equal(two.original_response,undefined);
  assert.equal(two.body,original.body);assert.equal(two.body_base64,original.body_base64);
  assert.equal(applyResponseMutation(two,responseMetadata(two)),two,'ordinary reads do not reapply a prior view');
});

test('repeated processing retains one original and restoring recovers all original wire fields',async()=>{
  const original=wire();
  const first=await executeScript('response.setBody({stage:1}); response.show("pretty");',context(original));
  const one=applyResponseMutation(original,first.response);
  const second=await executeScript('response.body.stage=2; response.show("raw");',context(one));
  const two=applyResponseMutation(one,second.response);
  assert.deepEqual(two.original_response,original);assert.equal(two.original_response.original_response,undefined);
  assert.deepEqual(restoreOriginalResponse(two),original);
});

test('setBody handles text and all JSON primitive types without retaining binary encodings',async()=>{
  const binary=wire({body:'AAEC',body_encoding:'base64',body_base64:'AAEC',content_type:'application/octet-stream',headers:[]});
  for(const [source,expected,type] of [['response.setBody("日本語")','日本語','text/plain; charset=utf-8'],['response.setBody(false)','false','application/json'],['response.setBody(null)','null','application/json'],['response.setBody(0)','0','application/json'],['response.setBody("<b>OK</b>","text/html")','<b>OK</b>','text/html']]){
    const output=await executeScript(source,context(binary));const changed=applyResponseMutation(binary,output.response);
    assert.equal(changed.body,expected);assert.equal(changed.content_type,type);assert.equal(changed.body_encoding,'text');
    assert.equal(changed.body_base64,undefined);assert.equal(changed.size,new TextEncoder().encode(expected).byteLength);
  }
  const output=await executeScript('response.body="AP+A";response.body_encoding="base64";response.content_type="application/octet-stream";',context(wire()));
  const changed=applyResponseMutation(wire(),output.response);assert.equal(changed.body,'AP+A');assert.equal(changed.size,3);
});

test('setBody distinguishes a replacement text string from the same parsed JSON string',async()=>{
  const original=wire({body:'"hello"'});
  const output=await executeScript('response.setBody("hello"); return pm.response.text();',context(original));
  assert.equal(output.result,'hello');assert.equal(applyResponseMutation(original,output.response).body,'hello');
  const noOp=wire({body:'{"id":1}',size:8});
  assert.equal(Object.hasOwn(await executeScript('response.setBody({id:1});',context(noOp)),'response'),false);
  const changedHeaders=responseMetadata(original);changedHeaders.headers['content-type']='text/plain';
  assert.equal(applyResponseMutation(original,changedHeaders).body,'"hello"','a header-only change preserves exact body bytes');
});

test('direct header changes synchronize Content-Type without rewriting an untouched binary body',()=>{
  const original=wire({body:'AP+A',body_base64:'AP+A',body_encoding:'base64',content_type:'application/octet-stream',size:3,headers:[{key:'Content-Type',value:'application/octet-stream'}]});
  const metadata=responseMetadata(original);metadata.headers['content-type']='image/png';
  const changed=applyResponseMutation(original,metadata);
  assert.equal(changed.content_type,'image/png');assert.equal(changed.body_base64,'AP+A');assert.equal(changed.body,original.body);assert.equal(changed.size,3);
});

test('invalid response effects are rejected without changing the received response',()=>{
  const original=wire(),before=structuredClone(original);
  for(const change of [meta=>meta.status=99,meta=>meta.status=200.5,meta=>meta.statusText='bad\r\nstatus',meta=>meta.headers.bad='bad\nvalue',meta=>meta.headers['bad name']='value',meta=>meta.body=undefined,meta=>meta.body=new Date(),meta=>meta.body_encoding='gzip',meta=>meta.view='unknown',meta=>{meta.body='!base64';meta.body_encoding='base64';}]){
    const metadata=responseMetadata(original);change(metadata);assert.throws(()=>applyResponseMutation(original,metadata));assert.deepEqual(original,before);
  }
});

test('before scripts change the actual transmitted snapshot without rewriting saved request data',async()=>{
  const state=setup({before:`vars.set('value','changed'); request.method='POST'; request.url='https://service.invalid/new';
    request.header.push({key:'X-Script',value:'{{value}}'}); request.body={mode:'raw',raw:'{"value":"{{value}}"}',options:{raw:{language:'json'}}};
    store.set('updated',true);`});
  const saved=structuredClone(state.tab),sent=[];
  await executeRequest({...state,script:executeScript,send:async payload=>{sent.push(payload);return wire();}});
  assert.equal(sent.length,1);assert.equal(sent[0].method,'POST');assert.equal(sent[0].url,'https://service.invalid/new');
  assert.equal(sent[0].headers.find(row=>row.key==='X-Script').value,'changed');assert.deepEqual(JSON.parse(sent[0].body),{value:'changed'});
  assert.deepEqual(state.tab,saved);assert.equal(state.workspace.scriptData.updated,true);
});

test('file row reorder, insertion, removal and spread edits preserve the selected bytes',async()=>{
  const state=setup({before:`
    request.body.formdata.reverse();
    request.body.formdata.unshift({key:'note',value:'kept',type:'text'});
    request.body.formdata.splice(2,1);
    request.body.formdata=request.body.formdata.map(row=>({...row,key:row.key+'-changed'}));
  `});
  state.tab.request.method='POST';
  state.tab.request.body={mode:'formdata',formdata:[{key:'first',type:'file'},{key:'second',type:'file'}]};
  const saved=structuredClone(state.tab);
  const files={'form-0':[{name:'first.txt',data:'Zmlyc3Q='}],'form-1':[{name:'second.txt',data:'c2Vjb25k'}]};
  await executeRequest({...state,files,script:executeScript,send:async payload=>{
    assert.deepEqual(payload.multipart.map(row=>({key:row.key,filename:row.filename,value:row.value,data:row.data})),[
      {key:'note-changed',value:'kept',filename:undefined,data:undefined},
      {key:'second-changed',filename:'second.txt',data:'c2Vjb25k',value:undefined}
    ]);return wire();
  }});
  assert.deepEqual(state.tab,saved);assert.equal(files['form-0'][0].name,'first.txt');
});

test('identity-only reversal of equal file rows still reverses their distinct selected files',async()=>{
  const state=setup({before:'request.body.formdata.reverse();'});
  state.tab.request.body={mode:'formdata',formdata:[{key:'upload',type:'file'},{key:'upload',type:'file'}]};
  const files={'form-0':[{name:'first.txt',data:'Zmlyc3Q='}],'form-1':[{name:'second.txt',data:'c2Vjb25k'}]};
  const output=await executeScript(state.tab.request._minipost.before,{request:state.tab.request});
  assert.deepEqual(output.request,state.tab.request);assert.deepEqual(output.attachmentRows,[1,0]);
  assert.equal(Object.getOwnPropertySymbols(output.request.body.formdata[0]).length,0);
  await executeRequest({...state,files,script:executeScript,send:async payload=>{
    assert.deepEqual(payload.multipart.map(row=>[row.filename,row.data]),[['second.txt','c2Vjb25k'],['first.txt','Zmlyc3Q=']]);return wire();
  }});
});

test('recreated ambiguous file rows fail before sending or committing script writes',async()=>{
  const state=setup({before:`vars.set('fileMutation','bad');store.set('fileMutation',true);
    request.body.formdata=JSON.parse(JSON.stringify(request.body.formdata)).reverse();`});
  state.tab.request.body={mode:'formdata',formdata:[{key:'upload',type:'file'},{key:'upload',type:'file'}]};
  let sent=false;
  await assert.rejects(executeRequest({...state,script:executeScript,
    files:{'form-0':[{name:'first.txt',data:'Zmlyc3Q='}],'form-1':[{name:'second.txt',data:'c2Vjb25k'}]},
    send:async()=>{sent=true;return wire();}}),/選択を引き継げません/);
  assert.equal(sent,false);assert.equal(state.primary.get('fileMutation'),undefined);assert.deepEqual(state.workspace.scriptData,{kept:1});
});

test('manual file row mutations preserve pending reads and retain inactive binary selections',async()=>{
  let finish;
  const pending=new Promise(resolve=>finish=resolve);
  const attachments=new RequestFiles({read:async file=>file.name==='second.txt'?pending:{name:file.name,data:'Zmlyc3Q='}});
  await attachments.read('request','form-0',[{name:'first.txt'}]);
  const reading=attachments.read('request','form-1',[{name:'second.txt'}]);
  await attachments.read('request','binary',[{name:'binary.txt'}]);
  const previous={method:'POST',url:'https://service.invalid',body:{mode:'formdata',formdata:[{key:'first',type:'file'},{key:'second',type:'file'}]}};
  const output=await executeScript('request.body.formdata.reverse();request.body.formdata.splice(1,1);',{request:previous});
  attachments.validateRows('request',previous,output.request,output.attachmentRows);
  assert.equal(attachments.get('request')['form-0'][0].name,'first.txt','validation has no effects');
  attachments.remapRows('request',previous,output.request,output.attachmentRows);
  finish({name:'second.txt',data:'c2Vjb25k'});await reading;
  assert.equal(attachments.get('request')['form-0'][0].name,'second.txt');
  assert.equal(attachments.get('request')['form-1'],undefined);assert.equal(attachments.get('request').binary[0].name,'binary.txt');
  assert.equal((await attachments.snapshot('request',output.request))['form-0'][0].data,'c2Vjb25k');
});

test('duplicating a ready file row has independent clearing while a pending duplication fails atomically',async()=>{
  const previous={method:'POST',url:'https://service.invalid',body:{mode:'formdata',formdata:[{key:'file',type:'file'}]}};
  const output=await executeScript('request.body.formdata.push({...request.body.formdata[0],key:"copy"});',{request:previous});
  const ready=new RequestFiles({read:async()=>({name:'file.txt',data:'AA=='})});await ready.read('r','form-0',[{name:'file.txt'}]);
  ready.remapRows('r',previous,output.request,output.attachmentRows);
  const second=ready.describe('r','form-1');ready.remove('r','form-0');
  assert.equal(second.controller.signal.aborted,false);assert.equal(ready.get('r')['form-1'][0].name,'file.txt');
  let finish;
  const pending=new RequestFiles({read:()=>new Promise(resolve=>finish=resolve)}),reading=pending.read('r','form-0',[{name:'slow.txt'}]);
  assert.throws(()=>pending.validateRows('r',previous,output.request,output.attachmentRows),/読込中/);
  assert.equal(pending.describe('r','form-0').controller.signal.aborted,false);assert.equal(pending.describe('r','form-1'),undefined);
  finish({name:'slow.txt',data:'AQ=='});await reading;assert.equal(pending.get('r')['form-0'][0].name,'slow.txt');
});

test('raw URL edits rebuild cached parts and preserve explicit query edits and path variables',async()=>{
  const state=setup({before:`request.url.raw='https://changed.invalid/next/:id?fromRaw=1';request.url.query.push({key:'explicit',value:'yes'});`});
  state.tab.request=normalizeRequest({...state.tab.request,url:'https://original.invalid/old?before=1'});
  state.tab.request.url.variable=[{key:'id',value:'42'}];
  const saved=structuredClone(state.tab);
  await executeRequest({...state,script:executeScript,send:async payload=>{
    assert.equal(payload.url,'https://changed.invalid/next/:id');assert.equal(payload.path_variables.id,'42');
    assert.deepEqual(payload.query,[{key:'before',value:'1'},{key:'explicit',value:'yes'}]);return wire();
  }});
  assert.deepEqual(state.tab,saved);
  state.tab.request._minipost.before='request.url.raw="https://raw.invalid/new?fresh=2";';
  await executeRequest({...state,script:executeScript,send:async payload=>{
    assert.equal(payload.url,'https://raw.invalid/new');assert.deepEqual(payload.query,[{key:'fresh',value:'2'}]);return wire();
  }});
});

test('URL host/path/protocol/port mutations update the effective target despite cached raw fields',async()=>{
  const state=setup({before:`request.url.host=['changed','invalid'];request.url.path=['new','item'];request.url.protocol='http';request.url.port='8080';`});
  state.tab.request=normalizeRequest({...state.tab.request,url:{raw:'https://old.invalid/old?kept=1',protocol:'https',host:['old','invalid'],path:['old']}});
  await executeRequest({...state,script:executeScript,send:async payload=>{
    assert.equal(payload.url,'http://changed.invalid:8080/new/item');assert.deepEqual(payload.query,[{key:'kept',value:'1'}]);return wire();
  }});
  const original={method:'GET',url:'https://original.invalid/a',header:[]};
  const changed={...original,url:{protocol:'https',host:['replacement','invalid'],path:['b'],query:[{key:'q',value:'c'}]}};
  assert.equal(applyRequestMutation(original,changed).url.raw,'https://replacement.invalid/b?q=c');
});

test('after scripts transform response before final extraction and downstream request compilation',async()=>{
  const state=setup({after:`if(vars.get('id')!=='1')throw new Error('missing preview'); response.body.id=42; response.status=202;
    response.show('raw'); vars.set('explicit','script wins');`,extractions:[{name:'id',path:'/body/id'},{name:'explicit',path:'/body/name'}]});
  const final=await executeRequest({...state,script:executeScript,send:async()=>wire()});
  assert.equal(final.status,202);assert.equal(final.response_view,'raw');assert.equal(responseMetadata(final).body.id,42);
  assert.equal(state.primary.get('id'),'42');assert.equal(state.primary.get('explicit'),'script wins');assert.deepEqual(final.automationErrors,[]);
  assert.equal(evaluateCondition({enabled:true,source:'response',path:'/body/id',operator:'eq',value:'42'},{response:responseMetadata(final)}),true);
  const next={...state.tab,request:{method:'GET',url:'https://service.invalid/{{id}}',header:[]}};
  await executeRequest({...state,tab:next,script:executeScript,send:async payload=>{assert.equal(payload.url,'https://service.invalid/42');return wire();}});
});

test('invalid after response, forbidden request edit, and extraction errors roll back all script effects',async()=>{
  for(const [source,extractions] of [
    ['response.status=999;',[]],['request.method="DELETE";response.body.id=9;',[]],
    ['response.body={missing:true};',[{name:'id',path:'/body/id',missing:'error'}]],
    ['response.body.id=9;throw new Error("failed");',[]]
  ]){
    const state=setup({after:`vars.set('partial','bad');pm.environment.set('partial','bad');store.set('partial','bad');${source}`,extractions});
    const received=wire();const final=await executeRequest({...state,script:executeScript,send:async()=>received});
    assert.equal(final.body,received.body);assert.equal(final.status,200);assert.equal(final.original_response,undefined);assert.equal(final.automationErrors.length,1);
    assert.equal(state.primary.get('partial'),undefined);assert.deepEqual(state.workspace.environments[0].values,[]);assert.deepEqual(state.workspace.scriptData,{kept:1});
    if(extractions.length)assert.equal(state.primary.get('id'),'1');
  }
});

test('invalid request effects fail before sending or committing accompanying variable/store writes',async()=>{
  for(const change of ['request.method="bad method";','request.url="file:///tmp/example";','request.body={mode:"raw",raw:{bad:true}};']){
    const state=setup({before:`vars.set('partial','bad');store.set('partial',true);${change}`});let sent=false;
    await assert.rejects(executeRequest({...state,script:executeScript,send:async()=>{sent=true;return wire();}}));
    assert.equal(sent,false);assert.equal(state.primary.get('partial'),undefined);assert.deepEqual(state.workspace.scriptData,{kept:1});
  }
  const request={method:'GET',url:'https://service.invalid',header:[]};assert.equal(applyRequestMutation(request,structuredClone(request)),request);
});

test('failed child and cancelled asynchronous script leave request/response contexts untouched',async()=>{
  const original=wire(),ctx=context(original),before=context(original);
  ctx.scripts=[{id:'child',name:'Child',source:'response.body.id=9;request.method="DELETE";throw new Error("child failed");'}];
  await assert.rejects(executeScript('response.status=202; await scripts.run("child");',ctx),/child failed/);
  assert.deepEqual(ctx.response,before.response);assert.deepEqual(ctx.request,before.request);
  const controller=new AbortController();let release;
  const task=executeScript('response.body.id=10;request.method="PATCH";vars.set("partial","bad");await minipost.workspace.read();',ctx,{signal:controller.signal,onCall:()=>new Promise(resolve=>release=resolve)});
  controller.abort();release({});await assert.rejects(task,{name:'AbortError'});
  assert.deepEqual(ctx.response,before.response);assert.deepEqual(ctx.request,before.request);
});
