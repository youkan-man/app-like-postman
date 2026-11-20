import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {createRequestEditor} from '../static/script-request.mjs';
import {executeScript,scriptExecutorSource} from '../static/script-worker.mjs';
import {compileRequest,normalizeRequest} from '../static/core.mjs';
import {createWorkspaceModel} from '../static/workspace-api.mjs';
import {applyRequestMutation} from '../static/script-response.mjs';
import {executeRequest} from '../static/execution.mjs';
import {PrimaryVariables} from '../static/runtime.mjs';

const request = overrides => ({method:'GET',url:'https://example.test/items',header:[],body:{mode:'none',raw:''},...overrides});
const editor = value => createRequestEditor({read:() => value,change:callback => callback(value)});
const workspace = value => ({version:2,collections:[],environments:[],globals:[],environmentId:'',scripts:[],scriptBindings:{},scriptData:{},tabs:[{id:'draft',name:'Request',request:value,settings:{}}],activeId:'draft'});

test('request fields use identical paths, return isolated snapshots, and preserve raw metadata', () => {
  const value = request({body:{mode:'raw',raw:'before',options:{raw:{language:'text'},keep:true}},auth:{type:'noauth'},'a.b':{value:null}}), api = editor(value);
  assert.equal(api.get('method'),'GET');
  assert.equal(api.set('method','POST'),'POST');
  assert.equal(api.set(['a.b','value'],0),0);
  assert.equal(api.get('["a.b"].value'),0);
  assert.equal(api.set('/body/raw','after'),'after');
  assert.deepEqual(api.get('body.options'),{raw:{language:'text'},keep:true});
  const snapshot = api.get(); snapshot.body.raw = 'isolated';
  assert.equal(value.body.raw,'after');
  assert.deepEqual(api.set(snapshot),snapshot);
  assert.equal(api.get('/body/raw'),'isolated');
  assert.deepEqual(api.get('auth'),{type:'noauth'});
  assert.equal(api.get('missing'),undefined);
});

test('named headers handle casing, duplicates and disabled alternatives without dropping metadata', () => {
  const value = request({header:[
    {key:'X-Mode',value:'disabled',disabled:true,description:'keep off'},
    {key:'x-mode',value:'one',description:'first'},
    {key:'X-Other',value:'untouched',enabled:true,description:'keep'},
    {key:'X-MODE',value:'two',description:'second'}
  ]}), api = editor(value);
  assert.equal(api.headers.get('x-MoDe'),'one');
  assert.deepEqual(api.headers.getAll('X-mode'),['one','two']);
  assert.equal(api.headers.set('x-mode',[2,false,null]),'2');
  assert.deepEqual(api.headers.toObject(),{'x-mode':['2','false',''],'x-other':'untouched'});
  assert.equal(value.header[0].value,'disabled'); assert.equal(value.header[0].disabled,true);
  assert.equal(value.header.find(row => row.value === '2').description,'first');
  assert.equal(value.header.find(row => row.value === 'false').description,'second');
  assert.equal(value.header.find(row => row.key === 'X-Other').description,'keep');
  assert.equal(api.headers.delete('X-MODE'),true); assert.equal(api.headers.has('x-mode'),false);
  assert.deepEqual(value.header.filter(row => row.key.toLowerCase() === 'x-mode'),[{key:'X-Mode',value:'disabled',disabled:true,description:'keep off'}]);
  assert.equal(api.headers.set('X-Mode','active'),'active');
  assert.equal(value.header.filter(row => row.key.toLowerCase() === 'x-mode').length,2);
  const before = structuredClone(value);
  for (const [name,input] of [['X-Mode','line\r\nbreak'],['Bad Name','x'],['X-Mode',{}],['X-Mode',Infinity]]) assert.throws(() => api.headers.set(name,input));
  assert.deepEqual(value,before);
});

test('URL and query operations preserve templates, literal keys, escapes and disabled rows on the wire', () => {
  const value = request({url:{raw:'https://{{host}}/a%2Fb?old=stale',query:[
    {key:'a.b',value:'雪 空+&=',description:'first'},
    {key:'a.b',value:'two'},
    {key:'hidden',value:'kept',disabled:true,description:'off'},
    {key:'template',value:'{{term}}'}
  ],variable:[{key:'id',value:'42'}]}}), api = editor(value);
  assert.equal(api.get('url'),'https://{{host}}/a%2Fb?a.b=%E9%9B%AA%20%E7%A9%BA%2B%26%3D&a.b=two&template={{term}}');
  assert.deepEqual(api.query.getAll('a.b'),['雪 空+&=','two']);
  api.query.set('a.b',['literal%2F','+ &']); api.query.set('page',2); api.query.set('hidden',false);
  assert.equal(api.query.get('hidden'),'false');
  assert.deepEqual(value.url.query.find(row => row.disabled),{key:'hidden',value:'kept',disabled:true,description:'off'});
  assert.equal(value.url.query[0].description,'first');
  const ws = workspace(value); ws.globals = [{key:'host',value:'example.test'},{key:'term',value:'a&b'}];
  const payload = compileRequest(ws,ws.tabs[0]).payload;
  assert.equal(payload.url,'https://example.test/a%2Fb');
  assert.deepEqual(payload.query,[{key:'a.b',value:'literal%2F'},{key:'a.b',value:'+ &'},{key:'template',value:'a&b'},{key:'page',value:'2'},{key:'hidden',value:'false'}]);
  const roundtrip = request({url:api.get('url')});
  assert.deepEqual(editor(roundtrip).query.toObject(),api.query.toObject());
  assert.deepEqual(value.url.variable,[{key:'id',value:'42'}]);
  assert.equal(api.query.delete('hidden'),true); assert.equal(api.query.delete('hidden'),false);
  assert.equal(value.url.query.find(row => row.key === 'hidden').disabled,true);
});

test('URL string, raw and component setters keep effective URL and compilation consistent', () => {
  for (const original of ['https://{{host}}/old?old=1#old',{raw:'https://{{host}}/old?old=1#old'}]) {
    const value = request({url:original}), before = structuredClone(value), api = editor(value);
    api.set('url.raw','https://{{host}}/next?name=one%26two&name=%2B#next');
    assert.deepEqual(api.query.getAll('name'),['one&two','+']); assert.equal(api.query.has('old'),false);
    assert.equal(api.get('url'),'https://{{host}}/next?name=one%26two&name=%2B#next');
    api.set('url.path',['last','雪']);
    assert.equal(api.get('url'),'https://{{host}}/last/雪?name=one%26two&name=%2B#next');
    const applied = applyRequestMutation(before,value), ws = workspace(applied); ws.globals = [{key:'host',value:'example.test'}];
    const payload = compileRequest(ws,ws.tabs[0]).payload;
    assert.equal(payload.url,'https://example.test/last/雪');
    assert.deepEqual(payload.query,[{key:'name',value:'one&two'},{key:'name',value:'+'}]);
  }
  const value = request({url:{raw:'https://old.test/',variable:[{key:'id',value:'kept'}]}}), api = editor(value);
  assert.equal(api.set('url','https://{{host}}/new?a=1%262'),'https://{{host}}/new?a=1%262');
  assert.deepEqual(value.url.variable,[{key:'id',value:'kept'}]);
  assert.equal(api.set('url',{protocol:'https',host:['example','test'],path:['v2'],query:[{key:'x',value:'a&b'}]}),'https://example.test/v2?x=a%26b');
});

test('legacy raw URL edits remain effective when followed by named reads and writes', async () => {
  const value = normalizeRequest(request({url:'https://old.invalid/old?keep=1'}));
  const output = await executeScript(`
    request.url.raw='https://new.invalid/new?fresh=2';
    const before={url:request.get('url'),fresh:request.query.get('fresh'),old:request.query.has('keep')};
    request.query.set('page',3);
    return {before,after:request.get('url')};
  `,{request:value});
  assert.deepEqual(output.result,{before:{url:'https://new.invalid/new?fresh=2',fresh:'2',old:false},after:'https://new.invalid/new?fresh=2&page=3'});
  const applied = applyRequestMutation(value,output.request), ws = workspace(applied);
  assert.equal(compileRequest(ws,ws.tabs[0]).payload.url,'https://new.invalid/new');
  assert.deepEqual(compileRequest(ws,ws.tabs[0]).payload.query,[{key:'fresh',value:'2'},{key:'page',value:'3'}]);
  const simultaneous = await executeScript(`request.url.raw='https://new.invalid/new?ignored=raw';request.url.query=[{key:'chosen',value:'manual&value'}];request.query.set('page',4);return request.get('url');`,{request:value});
  assert.equal(simultaneous.result,'https://new.invalid/new?chosen=manual%26value&page=4');
  const component = editor(value); value.url.host = ['next','invalid']; value.url.path = ['v2'];
  assert.equal(component.get('url'),'https://next.invalid/v2?keep=1');
  component.set('url.host[0]','last'); component.set('url.path[0]','v3'); component.query.set('page',5);
  assert.equal(component.get('url'),'https://last.invalid/v3?keep=1&page=5');
});

test('multiple saved handles track URL model replacements and later raw edits', () => {
  const model = createWorkspaceModel(workspace(normalizeRequest(request({url:'https://old.invalid/old?keep=1'}))));
  const a = model.api.requests.edit('draft:draft'), b = model.api.drafts.edit('draft:draft');
  a.query.set('from','a');
  assert.equal(b.query.get('from'),'a');
  model.api.requests.set('draft:draft','request.url.raw','https://model.invalid/model?fresh=2');
  assert.equal(a.get('url'),'https://model.invalid/model?fresh=2');
  assert.equal(b.get('url'),'https://model.invalid/model?fresh=2');
  assert.equal(model.api.requests.edit('draft:draft').get('url'),'https://model.invalid/model?fresh=2');
  model.state.tabs[0].request.url.raw = 'https://later.invalid/later?last=3';
  b.query.set('page',4);
  assert.equal(a.get('url'),'https://later.invalid/later?last=3&page=4');
  assert.deepEqual(a.query.toObject(),{last:'3',page:'4'});
});

test('a rejected outer transaction does not advance the request URL baseline', () => {
  let value = normalizeRequest(request({url:'https://old.invalid/old?keep=1'})), reject = true;
  const api = createRequestEditor({read:() => value,change:callback => {
    const before = structuredClone(value);
    try {const result = callback(value); if (reject) throw new Error('rejected'); return result;} catch(error) {value=before;throw error;}
  }});
  assert.throws(() => api.query.set('page',4),/rejected/);
  reject = false; value.url.raw = 'https://new.invalid/new?fresh=2';
  api.query.set('page',5);
  assert.equal(api.get('url'),'https://new.invalid/new?fresh=2&page=5');
});

test('JSON root, dot, bracket, pointer and array paths share one parsed body and retain null', () => {
  const value = request({body:{mode:'raw',raw:'{"a.b":{"items":[{"value":null}]},"nothing":null}',options:{raw:{language:'text',keep:true},other:1},description:'body'},header:[{key:'CONTENT-TYPE',value:'text/plain',description:'type'}]}), api = editor(value);
  assert.equal(api.json.get('["a.b"].items[0].value'),null);
  assert.equal(api.json.set(['a.b','items',0,'value'],false),false);
  assert.equal(api.json.get('/a.b/items/0/value'),false);
  assert.deepEqual(api.json.set('/a.b/items/-',{value:2}),{value:2});
  assert.deepEqual(api.json.get(['a.b','items']),[{value:false},{value:2}]);
  assert.equal(api.json.delete('/a.b/items/0'),true); assert.equal(api.json.delete('/missing'),false);
  assert.deepEqual(api.json.get('a.b'),undefined);
  assert.equal(api.json.set('/__proto__/safe',true),true);
  assert.equal(api.json.get(['__proto__','safe']),true); assert.equal({}.safe,undefined);
  assert.equal(api.headers.get('content-type'),'application/json');
  assert.equal(value.header[0].description,'type');
  assert.deepEqual(value.body.options,{raw:{language:'json',keep:true},other:1});
  assert.equal(value.body.description,'body');
  assert.equal(api.json.set(null),null); assert.equal(api.json.get(),null);
  const before = structuredClone(value);
  assert.throws(() => api.json.set('child',1),/途中/); assert.deepEqual(value,before);
  assert.equal(api.json.delete(''),true); assert.equal(value.body.raw,'null');
});

test('JSON writes initialize absent body, replace malformed JSON, and reject incomplete writes atomically', () => {
  const value = request(), api = editor(value);
  assert.equal(api.json.get(),undefined); assert.equal(api.json.get('field'),undefined); assert.equal(api.json.delete(''),false);
  assert.equal(api.json.set('items[0].id',7),7); assert.deepEqual(api.json.get(),{items:[{id:7}]});
  const before = structuredClone(value);
  for (const action of [() => api.json.set('items[3]',1),() => api.json.set('/bad~2key',1),() => api.json.set('items[0]',NaN),() => api.json.set({a:undefined}),() => api.set('method','bad method'),() => api.set('url.query',[{key:'x',value:5}])]) assert.throws(action);
  assert.deepEqual(value,before);
  value.body.raw = 'not JSON'; assert.throws(() => api.json.get(),/JSON/);
  assert.deepEqual(api.json.set({recovered:true}),{recovered:true}); assert.deepEqual(api.json.get(),{recovered:true});
});

test('form writes switch JSON to urlencoded and preserve repeated literal fields in the wire payload', () => {
  const value = request(), api = editor(value);
  api.json.set({old:true}); api.form.set('tag',['one','two']); api.form.set('enabled',false); api.form.set('a.b','雪 空+'); api.form.set('empty',null);
  assert.equal(value.body.mode,'urlencoded'); assert.equal(api.json.get(),undefined);
  assert.deepEqual(api.form.toObject(),{tag:['one','two'],enabled:'false','a.b':'雪 空+',empty:''});
  const ws = workspace(value), payload = compileRequest(ws,ws.tabs[0]).payload;
  assert.deepEqual(payload.form_urlencoded,[{key:'tag',value:'one'},{key:'tag',value:'two'},{key:'enabled',value:'false'},{key:'a.b',value:'雪 空+'},{key:'empty',value:''}]);
  assert.equal(payload.headers.find(row => row.key.toLowerCase() === 'content-type').value,'application/x-www-form-urlencoded');
  api.json.set({again:null}); assert.equal(api.form.has('tag'),false); assert.equal(api.headers.get('content-type'),'application/json');
  assert.equal(api.form.set('tag',[]),undefined); assert.equal(value.body.mode,'raw');
});

test('multipart text access excludes files and keeps disabled rows and body options', () => {
  const identity = Symbol('file row'), file = {key:'upload',type:'file',src:'local.bin',description:'file',contentType:'custom/file',[identity]:4};
  const value = request({body:{mode:'formdata',formdata:[file,{key:'note',value:'off',disabled:true},{key:'note',value:'old',type:'text',contentType:'text/custom',description:'note'}],options:{keep:true}}}), api = editor(value);
  assert.equal(api.form.has('upload'),false); assert.equal(api.form.delete('upload'),false);
  api.form.set('note',['new','extra']); api.form.set('upload','text with same key');
  assert.deepEqual(api.form.getAll('note'),['new','extra']);
  assert.equal(value.body.formdata[0][identity],4); assert.equal(value.body.formdata[0].src,'local.bin');
  assert.equal(value.body.formdata[1].disabled,true); assert.equal(value.body.formdata[2].contentType,'text/custom');
  assert.deepEqual(value.body.options,{keep:true}); assert.equal(value.body.mode,'formdata');
  const snapshot = api.get(); snapshot.body.formdata.reverse(); api.set(snapshot);
  assert.equal(value.body.formdata.at(-1)[identity],4);
});

test('current request facade is non-enumerable, shared with child scripts, and respects raw collisions', async () => {
  const value = request();
  const output = await executeScript(`
    request.query.set('stage','parent'); request.json.set({count:1});
    const child = await scripts.run('child');
    return {child,count:request.json.get('count'),url:request.get('url'),alias:request===pm.request&&request===minipost.request,
      keys:Object.keys(request),hidden:request.get('json')};
  `,{request:value,scripts:[{id:'child',name:'Child',source:`request.json.set('count',request.json.get('count')+1);request.headers.set('X-Child',true);return request.query.get('stage');`}]});
  assert.equal(output.result.child,'parent'); assert.equal(output.result.count,2); assert.equal(output.result.alias,true);
  assert.equal(output.result.hidden,undefined);
  for (const name of ['get','set','headers','query','form','json']) assert.equal(output.result.keys.includes(name),false);
  assert.equal(output.request.header.find(row => row.key === 'X-Child').value,'true');
  assert.deepEqual(value,request());
  const raw = await executeScript(`return {headers:request.headers,json:request.json,get:request.get('headers')};`,{request:request({headers:{raw:'kept'},json:'raw metadata'})});
  assert.deepEqual(raw.result,{headers:{raw:'kept'},json:'raw metadata',get:{raw:'kept'}});
  assert.equal((await executeScript('return request;')).result,undefined);
});

test('caught mutation errors and failed scripts do not leak partial request state', async () => {
  const value = request();
  const output = await executeScript(`
    request.json.set({items:[1],blocked:null});
    const before = request.get();
    for(const write of [()=>request.json.set('blocked.child',1),()=>request.headers.set('X-Test','bad\\r\\nheader'),()=>request.set('method','bad method')]) {
      try {write();} catch {}
    }
    return {before,after:request.get()};
  `,{request:value});
  assert.deepEqual(output.result.before,output.result.after);
  await assert.rejects(executeScript(`request.json.set({changed:true});throw new Error('stop');`,{request:value}),/stop/);
  assert.deepEqual(value,request());
  let expired = false; const api = createRequestEditor({read:() => value,change:fn => fn(value),checkActive:() => {if (expired) throw new Error('inactive');}});
  expired = true; assert.throws(() => api.get('method'),/inactive/); assert.throws(() => api.query.set('x',1),/inactive/); assert.deepEqual(value,request());
});

test('real request execution sends named hook edits and keeps identical file rows mapped to their files', async () => {
  const value = request({method:'POST',body:{mode:'formdata',formdata:[{key:'upload',type:'file'},{key:'upload',type:'file'},{key:'caption',type:'text',value:'old'}]},_minipost:{before:`
    const snapshot=request.get(); snapshot.body.formdata.reverse(); request.set(snapshot);
    request.form.set('caption','new'); request.query.set('stage','before'); request.headers.set('X-Ready',true);
  `}}), ws = workspace(value); let payload;
  await executeRequest({workspace:ws,tab:ws.tabs[0],primary:new PrimaryVariables(),script:executeScript,
    files:{'form-0':[{name:'first.bin',type:'application/octet-stream',data:'AA=='}],'form-1':[{name:'second.bin',type:'application/octet-stream',data:'AQ=='}]},
    send:async next => {payload=next; return {status:200,headers:[],body:'ok'};}});
  assert.deepEqual(payload.query,[{key:'stage',value:'before'}]);
  assert.equal(payload.headers.find(row => row.key === 'X-Ready').value,'true');
  assert.deepEqual(payload.multipart.map(row => row.filename ?? row.value),['new','second.bin','first.bin']);
  assert.deepEqual(payload.multipart.filter(row => row.filename).map(row => row.data),['AQ==','AA==']);
  assert.equal(value.body.formdata[2].value,'old');
  const hook = request({_minipost:{before:`request.set('method','POST');request.set('url','https://example.test/changed');request.query.set('stage','before');request.headers.set('X-Ready',true);request.json.set({ok:true});`}}), hookWorkspace = workspace(hook);
  await executeRequest({workspace:hookWorkspace,tab:hookWorkspace.tabs[0],primary:new PrimaryVariables(),script:executeScript,send:async next => {payload=next;return {status:200,headers:[],body:'ok'};}});
  assert.equal(payload.method,'POST');assert.equal(payload.url,'https://example.test/changed');assert.deepEqual(JSON.parse(payload.body),{ok:true});
  assert.deepEqual(payload.query,[{key:'stage',value:'before'}]);assert.equal(payload.headers.find(row => row.key.toLowerCase() === 'content-type').value,'application/json');
});

test('the serialized dependency bundle works in an actual Worker without imported helper modules', async () => {
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');\n${scriptExecutorSource()}\nparentPort.once('message',async ({source,context})=>{try{parentPort.postMessage(await executeScript(source,context));}catch(error){parentPort.postMessage({error:error.message});}});`,{eval:true});
  try {
    const result = new Promise((resolve,reject) => {worker.once('message',resolve);worker.once('error',reject);});
    worker.postMessage({source:`request.set('method','POST');request.query.set('a.b',[1,2]);request.json.set({rows:[{value:null}]});request.json.set('rows[0].value',false);return {method:request.get('method'),query:request.query.toObject(),json:request.json.get()};`,context:{request:request()}});
    const output = await result;
    assert.equal(output.error,undefined); assert.deepEqual(output.result,{method:'POST',query:{'a.b':['1','2']},json:{rows:[{value:false}]}});
    assert.equal(output.request.body.mode,'raw');assert.equal(Object.hasOwn(output.request,'get'),false);
  } finally {await worker.terminate();}
});

test('ribbon get/set use the same field selectors with existing value calls preserved', async () => {
  const context = {ribbonScopeId:'scope',activeRibbonId:'main',ribbons:[{id:'main',key:'main',name:'Main',groups:[{id:'group',controls:[{id:'control',key:'count',label:'Count',type:'number',value:1,actions:[]}]}]}]};
  const output = await executeScript(`
    ribbon.set('count',2);ribbon.set('main.count','value',3);
    ribbon.set('control','visible',!ribbon.get('control','visible'));
    ribbon.set('count','enabled',false);
    return {value:ribbon.get('count'),visible:ribbon.get('main.count','visible'),enabled:ribbon.get('control','enabled')};
  `,context);
  assert.deepEqual(output.result,{value:3,visible:false,enabled:false});
  assert.deepEqual(output.ribbonWrites.map(row => [row.type,row.value]),[['value',3],['visible',false],['enabled',false]]);
  await assert.rejects(executeScript(`ribbon.set('count','unknown',true);`,context),/フィールド/);
  await assert.rejects(executeScript(`ribbon.set('count','visible','false');`,context),/真偽値/);
  assert.equal(context.ribbons[0].groups[0].controls[0].value,1);
});
