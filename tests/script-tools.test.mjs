import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {createScriptTools} from '../static/script-tools.mjs';

const tools=createScriptTools();
const plain=value=>JSON.parse(JSON.stringify(value));
const workerTools=crypto=>vm.runInNewContext(`(${createScriptTools.toString()})()`,{crypto,TextEncoder,TextDecoder,URL,URLSearchParams,atob,btoa,structuredClone,setTimeout,clearTimeout,DOMException});

test('factory can be serialized with no module dependencies and every public namespace is usable',()=>{
  const rebuilt=new Function(`return (${createScriptTools.toString()})();`)();
  assert.deepEqual(Object.keys(rebuilt),['url','query','headers','cookies','request','json','csv','encoding','crypto','assert','data','flow']);
  assert.equal(rebuilt.query.stringify({日本語:'雪 ☃',zero:0,no:false}),'%E6%97%A5%E6%9C%AC%E8%AA%9E=%E9%9B%AA+%E2%98%83&zero=0&no=false');
  assert.deepEqual(rebuilt.json.get({items:[{id:3}]},'items[0].id'),3);
});

test('query helpers preserve duplicates, empty values, disabled rows and insertion order',()=>{
  const rows=tools.query.parse('?q=a+b&q=%E9%9B%AA&empty=&flag');
  assert.deepEqual(rows,[{key:'q',value:'a b'},{key:'q',value:'雪'},{key:'empty',value:''},{key:'flag',value:''}]);
  assert.deepEqual(tools.query.getAll(rows,'q'),['a b','雪']);
  assert.equal(tools.query.get(rows,'missing'),undefined);
  assert.deepEqual(tools.query.toObject(rows),{q:['a b','雪'],empty:'',flag:''});
  assert.deepEqual(tools.query.set(rows,'q',0),[{key:'q',value:'0'},{key:'empty',value:''},{key:'flag',value:''}]);
  assert.equal(tools.query.stringify([{key:'no',value:1,enabled:false},{key:'yes',value:false}]),'yes=false');
  assert.deepEqual(tools.query.remove(tools.query.append(rows,'q','last'),'q'),[{key:'empty',value:''},{key:'flag',value:''}]);
  assert.equal(rows.length,4);
  assert.throws(()=>tools.query.parse([['one']]),TypeError);
});

test('header parsing and edits retain duplicate Set-Cookie and match names case-insensitively',()=>{
  const rows=tools.headers.parse('Content-Type: application/json\r\nSet-Cookie: a=1\r\nset-cookie: b=2\r\nX-Empty:');
  assert.equal(tools.headers.get(rows,'CONTENT-TYPE'),'application/json');
  assert.deepEqual(tools.headers.getAll(rows,'Set-Cookie'),['a=1','b=2']);
  assert.deepEqual(tools.headers.toObject(rows),{'content-type':'application/json','set-cookie':['a=1','b=2'],'x-empty':''});
  assert.equal(tools.headers.stringify(tools.headers.set(rows,'SET-cookie','c=3')).split('\r\n').at(-1),'SET-cookie: c=3');
  assert.throws(()=>tools.headers.set(rows,'bad name','value'),TypeError);
  assert.throws(()=>tools.headers.append(rows,'X-Test','a\r\nInjected: true'),TypeError);
  assert.throws(()=>tools.headers.parse('missing colon'),TypeError);
});

test('URL construction handles Unicode, duplicate query values, relative base and encoded segments',()=>{
  const value=tools.url.build('/api',{base:'https://example.test/root',path:'/users/雪',query:{tag:['a','b'],space:'a b'},hash:'part'});
  assert.equal(value,'https://example.test/users/%E9%9B%AA?tag=a&tag=b&space=a+b#part');
  const parsed=tools.url.parse(value);
  assert.equal(parsed.hostname,'example.test');assert.equal(parsed.hash,'part');assert.deepEqual(parsed.query.slice(0,2),[{key:'tag',value:'a'},{key:'tag',value:'b'}]);
  assert.equal(tools.url.join('https://example.test/api?x=1','a/b','雪'),'https://example.test/api/a%2Fb/%E9%9B%AA?x=1');
  assert.throws(()=>tools.url.parse('/relative'),TypeError);
});

test('cookie parsing keeps equals in values and Set-Cookie date commas are never split',()=>{
  assert.deepEqual(tools.cookies.parse('token=a=b; user=%E9%9B%AA'),{token:'a=b',user:'雪'});
  assert.equal(tools.cookies.stringify({token:'a=b',user:'雪'}),'token=a%3Db; user=%E9%9B%AA');
  const set=tools.cookies.parseSetCookie('sid=abc; Expires=Wed, 21 Oct 2030 07:28:00 GMT; HttpOnly; SameSite=Lax');
  assert.deepEqual(set,{name:'sid',value:'abc',attributes:{expires:'Wed, 21 Oct 2030 07:28:00 GMT',httponly:true,samesite:'Lax'}});
  assert.equal(tools.cookies.serialize('sid','雪',{HttpOnly:true,Secure:false,Path:'/api'}),'sid=%E9%9B%AA; HttpOnly; Path=/api');
  assert.throws(()=>tools.cookies.serialize('bad name','x'),TypeError);
  assert.throws(()=>tools.cookies.serialize('ok','x',{Path:'/; domain=evil'}),TypeError);
});

test('request builder produces native MiniPost JSON/form/auth shapes without mutating the input',()=>{
  const options={method:'post',url:'{{base}}/records?old=1#part',query:{tag:['a','b']},headers:{'X-Test':'1'},json:{name:'雪'},bearer:'token'};
  const snapshot=structuredClone(options),request=tools.request.build(options);
  assert.equal(request.method,'POST');assert.equal(request.url,'{{base}}/records?old=1&tag=a&tag=b#part');
  assert.equal(request.body.raw,'{"name":"雪"}');assert.equal(request.body.options.raw.language,'json');
  assert.equal(tools.headers.get(request.header,'content-type'),'application/json');
  assert.deepEqual(request.auth,{type:'bearer',bearer:[{key:'token',value:'token',type:'string'}]});
  const form=tools.request.build({method:'POST',url:'https://example.test',form:{a:['x','y']},basic:{username:'user',password:'pass'}});
  assert.equal(form.body.mode,'urlencoded');assert.deepEqual(form.body.urlencoded,[{key:'a',value:'x'},{key:'a',value:'y'}]);
  assert.equal(form.auth.type,'basic');assert.deepEqual(options,snapshot);
  assert.throws(()=>tools.request.build({url:'x',json:{},body:'x'}),TypeError);
  assert.throws(()=>tools.request.build({url:'x',json:{bad:NaN}}),TypeError);
  assert.throws(()=>tools.request.build({url:'x',basic:{},bearer:'x'}),TypeError);
});

test('JSON Pointer and dot/bracket paths preserve escaped keys, missing values and false/null values',()=>{
  const source={'a/b':{'~key':false},items:[{'x.y':null}, {name:'雪'}]};
  assert.equal(tools.json.get(source,'/a~1b/~0key','fallback'),false);
  assert.equal(tools.json.get(source,'items[0]["x.y"]','fallback'),null);
  assert.equal(tools.json.get(source,'$.items[1].name'),'雪');
  assert.equal(tools.json.get(source,'items[2]','fallback'),'fallback');
  assert.equal(tools.json.has(source,'items[0]["x.y"]'),true);
  assert.equal(tools.json.pointer(['a/b','~key',0]),'/a~1b/~0key/0');
  for(const path of ['/bad~2key','a..b','a[bad]','a.','a["bad]'])assert.throws(()=>tools.json.get(source,path),TypeError,path);
});

test('immutable JSON writes create containers, append/remove arrays and cannot modify prototypes',()=>{
  const source={items:[{n:1},{n:2}]};
  const changed=tools.json.update(source,'items[0].n',value=>value+4);
  assert.equal(changed.items[0].n,5);assert.equal(source.items[0].n,1);
  assert.deepEqual(tools.json.set(source,'/items/-',{n:3}).items,[{n:1},{n:2},{n:3}]);
  assert.deepEqual(tools.json.remove(source,'items[0]').items,[{n:2}]);
  assert.deepEqual(tools.json.set({},'path[0].name','new'),{path:[{name:'new'}]});
  assert.throws(()=>tools.json.set([], '/4', true),RangeError);
  const hostile=tools.json.set({},'/__proto__/polluted',true);
  assert.equal(own(hostile,'__proto__'),true);assert.equal(hostile.__proto__.polluted,true);assert.equal({}.polluted,undefined);
  assert.equal(tools.json.get({},'/constructor/prototype'),undefined);
});
function own(value,key){return Object.hasOwn(value,key);}

test('JSON select/flatten/diff preserve empty containers and emit usable JSON Patch paths',()=>{
  const source={users:[{id:1,name:'A'},{id:2,name:'B'}],empty:[],nil:null};
  assert.deepEqual(tools.json.select(source,'users[*].id'),[{path:'/users/0/id',value:1},{path:'/users/1/id',value:2}]);
  assert.deepEqual(tools.json.flatten({a:{'b/c':0},empty:{},nil:null}),{'/a/b~1c':0,'/empty':{},'/nil':null});
  const before={list:[1,2,3],old:true},after={list:[9,2],next:{ok:true}};
  const patch=tools.json.diff(before,after);let result=before;
  for(const operation of patch)result=operation.op==='remove'?tools.json.remove(result,operation.path):tools.json.set(result,operation.path,operation.value);
  assert.deepEqual(result,after);
  assert.deepEqual(tools.json.pick(source,['empty','nil','missing']),{empty:[],nil:null});
  assert.deepEqual(tools.json.omit({a:1,b:2},['a']),{b:2});
  assert.deepEqual(tools.json.merge({nested:{a:1},list:[1]},{nested:{b:2},list:[2]}),{nested:{a:1,b:2},list:[2]});
});

test('JSON schema inference and validation report useful paths and reject unsupported or malformed schemas',()=>{
  const value={id:2,names:['雪','🙂'],active:false},schema=tools.json.schema(value);
  assert.equal(tools.json.validate(value,schema).valid,true);
  const result=tools.json.validate({id:-1,names:['x','x'],extra:true},{type:'object',required:['id','names','active'],additionalProperties:false,
    properties:{id:{type:'integer',minimum:0},names:{type:'array',uniqueItems:true,items:{type:'string',minLength:2}},active:{type:'boolean'}}});
  assert.equal(result.valid,false);assert.ok(result.errors.some(error=>error.path==='/id'&&error.keyword==='minimum'));
  assert.ok(result.errors.some(error=>error.path==='/names/0'&&error.keyword==='minLength'));
  assert.ok(result.errors.some(error=>error.keyword==='required'));assert.ok(result.errors.some(error=>error.keyword==='additionalProperties'));
  assert.equal(tools.json.validate('🙂',{type:'string',minLength:1,maxLength:1}).valid,true);
  assert.equal(tools.json.validate(2,{oneOf:[{type:'number'},{type:'integer'}]}).valid,false);
  assert.equal(tools.json.validate(null,{anyOf:[{type:'string'},{type:'null'}]}).valid,true);
  for(const rule of [{$ref:'#/x'},{type:[]},{type:['string','string']},{minimum:'0'},{multipleOf:0},{properties:{x:{unknown:true}}},
    {title:1},{examples:{}},{required:['id','id']},{enum:[{id:1},{id:1}]}])assert.throws(()=>tools.json.validate(null,rule),TypeError);
});

test('JSON helpers reject cycles, sparse arrays and non-JSON instances instead of silently dropping content',()=>{
  const cyclic={};cyclic.self=cyclic;
  const extra=[1];extra.custom=true;
  for(const value of [cyclic,[,1],extra,new Date(),{value:Infinity},{value:undefined}])assert.throws(()=>tools.json.schema(value),TypeError);
});

test('CSV parser roundtrips Unicode, quoted delimiters, escaped quotes and embedded CRLF',()=>{
  const records=[{name:'雪,山',note:'"quoted"\r\nnext'},{name:'🙂',note:''}];
  const encoded=tools.csv.stringify(records);
  assert.equal(encoded,'name,note\r\n"雪,山","""quoted""\r\nnext"\r\n🙂,');
  assert.deepEqual(tools.csv.parse('\uFEFF'+encoded,{header:true}),records);
  assert.deepEqual(tools.csv.parse('a\tb\n1\t2\n',{delimiter:'\t',header:true}),[{a:'1',b:'2'}]);
  assert.deepEqual(tools.csv.parse(''),[]);assert.deepEqual(tools.csv.parse('""'),[['']]);
  assert.deepEqual(tools.csv.parse('\n\n'),[[''],['']]);
  assert.deepEqual(tools.csv.parse('\n\nx\n',{skipEmptyLines:true}),[['x']]);
  assert.deepEqual(tools.csv.parse('__proto__,value\na,b',{header:true})[0],JSON.parse('{"__proto__":"a","value":"b"}'));
});

test('CSV malformed quoting, duplicate headers and mismatched columns fail explicitly',()=>{
  for(const source of ['a,"unfinished','"closed"trailing','a"quote,b'])assert.throws(()=>tools.csv.parse(source),TypeError);
  assert.throws(()=>tools.csv.parse('a,a\n1,2',{header:true}),TypeError);
  assert.throws(()=>tools.csv.parse('a,b\n1',{header:true}),TypeError);
  assert.throws(()=>tools.csv.stringify([{a:1},[2]]),TypeError);
  assert.throws(()=>tools.csv.parse('a,b',{delimiter:'\n'}),TypeError);
});

test('UTF-8/Base64/hex encoding handles supplementary Unicode and binary values with strict validation',()=>{
  const text='日本語🙂\u0000',encoded=tools.encoding.base64.encode(text);
  assert.equal(encoded,Buffer.from(text).toString('base64'));
  assert.equal(tools.encoding.base64.decode(encoded),text);
  assert.equal(tools.encoding.hex.decode(tools.encoding.hex.encode(text)),text);
  const input=Uint8Array.from([0,128,255]),safe=tools.encoding.base64.encode(input,{urlSafe:true});
  assert.equal(safe,'AID_');assert.deepEqual(tools.encoding.base64.decode(safe,{urlSafe:true,asBytes:true}),input);
  assert.deepEqual(tools.encoding.hex.decode('0080ff',{asBytes:true}),input);
  assert.throws(()=>tools.encoding.base64.decode('AB=='),TypeError);
  assert.throws(()=>tools.encoding.base64.decode('???'),TypeError);
  assert.throws(()=>tools.encoding.hex.decode('abc'),TypeError);
  assert.throws(()=>tools.encoding.utf8.decode([255]),TypeError);
  assert.equal(tools.encoding.utf8.decode([255],{fatal:false}),'�');
  assert.equal(tools.encoding.url.decode(tools.encoding.url.encode('a/b 雪')),'a/b 雪');
});

test('SHA-256 pure Worker fallback matches known vectors, byte boundaries and million-character input',async()=>{
  const fallback=workerTools(undefined);
  assert.equal(await fallback.crypto.hash(''),'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await fallback.crypto.hash('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await fallback.crypto.hash('a'.repeat(1000000)),'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  for(const length of [1,55,56,63,64,65,127,128,129]){
    const source='雪🙂'.repeat(length);assert.equal(await fallback.crypto.hash(source),createHash('sha256').update(source).digest('hex'));
  }
  assert.equal(await fallback.crypto.hash('abc','SHA256','base64'),createHash('sha256').update('abc').digest('base64'));
  assert.equal((await fallback.crypto.hash('abc','SHA-256','bytes')).length,32);
  await assert.rejects(fallback.crypto.hash('a','SHA-512'),/WebCrypto/);
  await assert.rejects(fallback.crypto.hash('a','MD5'),/SHA-256/);
});

test('HMAC-SHA256 fallback and native WebCrypto match RFC vectors, long/empty keys and Unicode',async()=>{
  const fallback=workerTools(undefined),native=workerTools(webcrypto);
  assert.equal(await fallback.crypto.hmac('key','The quick brown fox jumps over the lazy dog'),'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  const key=Uint8Array.from({length:20},()=>11);
  assert.equal(await fallback.crypto.hmac(key,'Hi There'),'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  for(const secret of ['','雪🙂','long'.repeat(100)])for(const data of ['','payload','日本語'.repeat(200)]){
    const expected=createHmac('sha256',secret).update(data).digest('hex');
    assert.equal(await fallback.crypto.hmac(secret,data),expected);assert.equal(await native.crypto.hmac(secret,data),expected);
  }
  assert.equal(await native.crypto.hash('abc','SHA-512'),createHash('sha512').update('abc').digest('hex'));
});

test('UUID and long random bytes use getRandomValues without requiring randomUUID or subtle',()=>{
  const fallback=workerTools({getRandomValues:webcrypto.getRandomValues.bind(webcrypto)});
  const ids=Array.from({length:20},()=>fallback.crypto.uuid());
  assert.ok(ids.every(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)));
  assert.equal(new Set(ids).size,20);assert.equal(fallback.crypto.randomBytes(70000).length,70000);
  assert.throws(()=>workerTools(undefined).crypto.uuid(),/乱数/);
  assert.throws(()=>fallback.crypto.randomBytes(-1),/整数/);
});

test('assertions distinguish equality, JSON equality, sync throws and async rejection',async()=>{
  assert.equal(tools.assert.ok(1),1);assert.equal(tools.assert.equal(false,false),false);
  assert.deepEqual(tools.assert.deepEqual({a:1,b:[2]},{b:[2],a:1}),{a:1,b:[2]});
  assert.throws(()=>tools.assert.equal(0,false),{name:'AssertionError'});
  assert.throws(()=>tools.assert.schema({count:-1},{properties:{count:{minimum:0}}}),{name:'AssertionError'});
  assert.equal(tools.assert.throws(()=>{throw new Error('expected');},/expected/).message,'expected');
  assert.throws(()=>tools.assert.throws(async()=>{}),/assert.rejects/);
  assert.equal((await tools.assert.rejects(async()=>{throw Error('async expected');},'expected')).message,'async expected');
  await assert.rejects(tools.assert.rejects(async()=>1),{name:'AssertionError'});
});

test('data utilities group arbitrary keys safely, retain stable order and do not mutate inputs',()=>{
  const rows=[{kind:'__proto__',n:3},{kind:'b',n:1},{kind:'b',n:1}],before=structuredClone(rows);
  const groups=tools.data.groupBy(rows,'kind');assert.equal(own(groups,'__proto__'),true);assert.equal(groups.__proto__.length,1);
  assert.deepEqual(tools.data.countBy(rows,'kind'),JSON.parse('{"__proto__":1,"b":2}'));
  assert.deepEqual(tools.data.uniqueBy(rows,'n'),[rows[0],rows[1]]);
  assert.deepEqual(tools.data.sortBy(rows,'n'),[rows[1],rows[2],rows[0]]);assert.deepEqual(rows,before);
  assert.deepEqual(tools.data.range(4),[0,1,2,3]);assert.deepEqual(tools.data.range(3,-1,-1),[3,2,1,0]);
  assert.deepEqual(tools.data.chunk([1,2,3,4,5],2),[[1,2],[3,4],[5]]);
  assert.throws(()=>tools.data.range(1,4,0),TypeError);assert.throws(()=>tools.data.chunk([],0),TypeError);
});

test('retry applies attempt numbers and predicates, poll returns the accepted value and enforces a running deadline',async()=>{
  const attempts=[];
  const result=await tools.flow.retry(attempt=>{attempts.push(attempt);if(attempt<3)throw Error('retry');return {attempt};},{delayMs:0});
  assert.deepEqual(result,{attempt:3});assert.deepEqual(attempts,[1,2,3]);
  let count=0;await assert.rejects(tools.flow.retry(()=>{count++;throw Error('stop');},{shouldRetry:()=>false,delayMs:0}),/stop/);assert.equal(count,1);
  assert.equal(await tools.flow.poll(attempt=>attempt,{until:value=>value===3,intervalMs:0,maxAttempts:4}),3);
  await assert.rejects(tools.flow.poll(()=>false,{intervalMs:0,maxAttempts:2}),{name:'TimeoutError'});
  await assert.rejects(tools.flow.poll(()=>new Promise(()=>{}),{timeoutMs:15}),{name:'TimeoutError'});
});

test('batch limits concurrency, preserves input order and supports settled or falsy rejected errors',async()=>{
  let running=0,maximum=0;
  const results=await tools.flow.batch([4,3,2,1],async value=>{running++;maximum=Math.max(maximum,running);await tools.flow.delay(value);running--;return value*2;},{concurrency:2});
  assert.deepEqual(results,[8,6,4,2]);assert.equal(maximum,2);
  const settled=await tools.flow.batch([1,2,3],value=>{if(value===2)throw Error('two');return value;},{settle:true,concurrency:1});
  assert.deepEqual(settled.map(item=>item.status),['fulfilled','rejected','fulfilled']);assert.equal(settled[1].reason.message,'two');
  let rejected=false;try{await tools.flow.batch([1,2],()=>{throw null;},{concurrency:1});}catch(error){rejected=true;assert.equal(error,null);}assert.equal(rejected,true);
});

test('abort signals cancel delay, retry and pending batch callbacks without scheduling new work',async()=>{
  for(const operation of [api=>api.flow.delay(10000),api=>api.flow.retry(()=>new Promise(()=>{})),api=>api.flow.batch([1,2],()=>new Promise(()=>{}),{concurrency:1})]){
    const controller=new AbortController(),api=createScriptTools({signal:controller.signal}),running=operation(api);
    controller.abort();await assert.rejects(running,{name:'AbortError'});
    assert.throws(()=>api.query.parse('a=1'),{name:'AbortError'});
  }
});
