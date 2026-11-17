import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {executeScript} from '../static/script-worker.mjs';

test('standalone scripts return typed data and keep undefined distinct from null', async () => {
  const input = {values:[3, 1, 2], enabled:false, date:new Date('2026-01-02T03:04:05Z'), bytes:new Uint8Array([0, 255]), map:new Map([['key', 7]])};
  const output = await executeScript('return {sorted:input.values.sort(), enabled:input.enabled, date:input.date, bytes:input.bytes, map:input.map};', {input});
  assert.equal(output.ok, true);
  assert.deepEqual(output.result.sorted, [1, 2, 3]);
  assert.deepEqual(input.values, [3, 1, 2]);
  assert.equal(output.result.enabled, false);
  assert.ok(output.result.date instanceof Date);
  assert.deepEqual(output.result.bytes, new Uint8Array([0, 255]));
  assert.deepEqual(output.result.map, new Map([['key', 7]]));
  const missing = await executeScript('return undefined;');
  assert.ok(Object.hasOwn(missing, 'result')); assert.equal(missing.result, undefined);
  assert.equal((await executeScript('return null;')).result, null);
  assert.equal((await executeScript('return 0;')).result, 0);
});

test('local request and response declarations work with awaited host API calls', async () => {
  const calls = [];
  const output = await executeScript(`
    const request = await minipost.requests.get('echo');
    const response = await minipost.requests.send(request);
    return await Promise.resolve({id:request.id, status:response.status, body:response.body});
  `, {request:{method:'UNUSED'}, response:{status:500}}, {
    onCall:async (method, args) => {
      calls.push([method, args]);
      return method === 'requests.get' ? {id:'echo-id', method:'POST'} : {status:200, body:{ok:true}};
    }
  });
  assert.deepEqual(output.result, {id:'echo-id', status:200, body:{ok:true}});
  assert.deepEqual(calls, [['requests.get', ['echo']], ['requests.send', [{id:'echo-id', method:'POST'}, undefined]]]);
});

test('user lexical declarations can shadow injected names without changing sibling scripts', async () => {
  const output = await executeScript(`
    const values = [];
    const input = 4, console = {log:value => values.push(value)};
    let request = 'local request', response = 'local response';
    const pm = 'local pm', vars = 'local vars', scripts = 'local scripts', store = 'local store';
    console.log(input);
    const child = await minipost.scripts.run('child', {n:7});
    const minipostResult = minipost.store.get('child');
    return {values, request, response, pm, vars, scripts, store, child, minipostResult};
  `, {input:{n:99}, scripts:[{id:'child', name:'Child', source:'console.log("child API"); store.set("child", input.n); return input.n * 2;'}]});
  assert.deepEqual(output.result, {values:[4], request:'local request', response:'local response', pm:'local pm', vars:'local vars', scripts:'local scripts', store:'local store', child:14, minipostResult:7});
  assert.deepEqual(output.logs, [{level:'log', message:'child API'}]);
  assert.deepEqual(output.dataWrites, [{key:'child', value:7}]);
  assert.equal((await executeScript('const minipost = {local:true}; return minipost.local;')).result, true);
});

test('unshadowed injected APIs and return await retain their existing behavior', async () => {
  const output = await executeScript(`
    console.log(request.method, response.status);
    vars.set('answer', input.answer);
    await new Promise(resolve => setTimeout(resolve, 1));
    return await Promise.resolve({answer:pm.variables.get('answer'), method:pm.request.method, status:pm.response.code});
  `, {input:{answer:42}, request:{method:'GET'}, response:{status:201}});
  assert.deepEqual(output.result, {answer:'42', method:'GET', status:201});
  assert.deepEqual(output.logs, [{level:'log', message:'GET 201'}]);
  assert.deepEqual(output.writes.primary, [{key:'answer', value:'42'}]);
});

test('child scripts have isolated input and share only explicit transaction APIs', async () => {
  const context = {input:{items:[1]}, primary:{old:'kept'}, data:{count:1}, scripts:[{id:'child-id', name:'child', source:`
    input.items.push(2);
    vars.set('child', {ready:true});
    store.set('count', store.get('count') + 1);
    return input;
  `}]};
  const output = await executeScript(`
    const result = await scripts.run('child', input);
    return {result, input, count:store.get('count'), child:vars.get('child'), list:scripts.list()};
  `, context);
  assert.deepEqual(output.result, {result:{items:[1, 2]}, input:{items:[1]}, count:2, child:'{"ready":true}', list:[{id:'child-id', name:'child'}]});
  assert.deepEqual(context.input, {items:[1]});
  assert.deepEqual(context.data, {count:1});
  assert.deepEqual(output.dataWrites, [{key:'count', value:2}]);
  assert.deepEqual(output.writes.primary, [{key:'child', value:'{"ready":true}'}]);
});

test('script lookup prefers an exact ID and rejects ambiguous or missing names', async () => {
  const scripts = [
    {id:'target', name:'same', source:'return "id";'},
    {id:'second', name:'target', source:'return "name";'},
    {id:'third', name:'same', source:'return "other";'}
  ];
  assert.equal((await executeScript('return await scripts.run("target");', {scripts})).result, 'id');
  await assert.rejects(executeScript('return await scripts.run("same");', {scripts}), /重複/);
  await assert.rejects(executeScript('return await scripts.run("missing");', {scripts}), /見つかりません/);
});

test('imported callers keep their original ID and unique-name references bound to the imported copy', async () => {
  const source = 'return {byId:await scripts.run("helper-old"), byName:await minipost.scripts.run("Helper"), list:scripts.list()};';
  const scripts = [
    {id:'helper-old', name:'Helper', source:'return "original";'},
    {id:'helper-copy', name:'Helper', source:'return "copy";'},
    {id:'parent-copy', name:'Parent', source, bindingId:'import-copy'}
  ];
  const output = await executeScript(source, {scriptId:'parent-copy', scripts, bindings:{'import-copy':{'helper-old':'helper-copy', Helper:'helper-copy'}}});
  assert.deepEqual(output.result, {byId:'copy', byName:'copy', list:scripts.map(({id, name}) => ({id, name}))});
});

test('each nested caller uses its own binding while sharing the variable and store transaction', async () => {
  const source = `
    const child = await scripts.run('child-old');
    const parent = await minipost.scripts.run('target');
    return {child, parent, value:vars.get('child'), shared:store.get('shared')};
  `;
  const scripts = [
    {id:'parent-copy', name:'Parent', source, bindingId:'parent-binding'},
    {id:'child-copy', name:'Child', bindingId:'child-binding', source:'vars.set("child", "done"); store.set("shared", true); return await minipost.scripts.run("target");'},
    {id:'parent-target', name:'Target', source:'return "parent target";'},
    {id:'child-target', name:'Target', source:'return "child target";'}
  ];
  const output = await executeScript(source, {scriptId:'parent-copy', scripts, bindings:{
    'parent-binding':{'child-old':'child-copy', target:'parent-target'},
    'child-binding':{target:'child-target'}
  }});
  assert.deepEqual(output.result, {child:'child target', parent:'parent target', value:'done', shared:true});
  assert.deepEqual(output.writes.primary, [{key:'child', value:'done'}]);
  assert.deepEqual(output.dataWrites, [{key:'shared', value:true}]);
});

test('a deleted bound target cannot fall back to an existing original ID or a coincidental name', async () => {
  const source = 'return await scripts.run("original-id");';
  const scripts = [
    {id:'caller', name:'Caller', source, bindingId:'import'},
    {id:'original-id', name:'Original', source:'throw new Error("wrong original executed");'},
    {id:'unrelated', name:'deleted-copy', source:'throw new Error("wrong name executed");'}
  ];
  await assert.rejects(executeScript(source, {scriptId:'caller', scripts, bindings:{import:{'original-id':'deleted-copy'}}}), /スクリプトが見つかりません: original-id/);
});

test('only an inline root inherits context.bindingId; a saved child without bindings resolves normally', async () => {
  const source = 'return {direct:await scripts.run("target-old"), nested:await minipost.scripts.run("child-old")};';
  const scripts = [
    {id:'target-old', name:'Target', source:'return "original";'},
    {id:'target-copy', name:'Target', source:'return "copy";'},
    {id:'plain-child', name:'Child', source:'return await scripts.run("target-old");'}
  ];
  const context = {scripts, bindingId:'inline-binding', bindings:{'inline-binding':{'target-old':'target-copy', 'child-old':'plain-child'}}};
  assert.deepEqual((await executeScript(source, context)).result, {direct:'copy', nested:'original'});
  assert.equal((await executeScript('return await scripts.run("target-old");', {...context, scriptId:'plain-child'})).result, 'original');
});

test('binding lookup only uses own keys and leaves unbound references on the normal resolution path', async () => {
  const source = 'return {own:await scripts.run("__proto__"), inherited:await scripts.run("toString"), fallback:await scripts.run("Unique name")};';
  const scripts = [
    {id:'caller', name:'Caller', source, bindingId:'__proto__'},
    {id:'bound', name:'Bound', source:'return "bound";'},
    {id:'toString', name:'Object name', source:'return "own script";'},
    {id:'unbound', name:'Unique name', source:'return "unique";'}
  ];
  const bindings = JSON.parse('{"__proto__":{"__proto__":"bound"}}');
  const output = await executeScript(source, {scriptId:'caller', scripts, bindings});
  assert.deepEqual(output.result, {own:'bound', inherited:'own script', fallback:'unique'});
});

test('scripts can call themselves recursively with a normal terminating condition', async () => {
  const source = 'return input <= 1 ? 1 : input * await scripts.run("factorial", input - 1);';
  const output = await executeScript(source, {input:6, scriptId:'factorial', scripts:[{id:'factorial', name:'Factorial', source}]});
  assert.equal(output.result, 720);
});

test('a failed parent or child returns no commit and leaves original state unchanged', async () => {
  const context = {primary:{value:'before'}, environment:{token:'before'}, data:{entry:{old:true}}, scripts:[{id:'failing', name:'failing', source:'store.set("entry", {old:false}); vars.set("value", "after"); console.log("child reached"); throw new Error("child failed");'}]};
  await assert.rejects(executeScript('pm.environment.set("token", "after"); await scripts.run("failing");', context), error => {
    assert.equal(error.message, 'child failed');
    assert.deepEqual(error.logs, [{level:'log', message:'child reached'}]);
    assert.equal(Object.hasOwn(error, 'writes'), false);
    assert.equal(Object.hasOwn(error, 'dataWrites'), false);
    return true;
  });
  assert.deepEqual(context.primary, {value:'before'});
  assert.deepEqual(context.environment, {token:'before'});
  assert.deepEqual(context.data, {entry:{old:true}});
});

test('JSON store operations preserve types and prevent mutation through borrowed references', async () => {
  const output = await executeScript(`
    const value = {list:[1, false, null]}; store.set('entry', value); value.list.push(99);
    const borrowed = store.get('entry'); borrowed.list.push(88);
    const kept = store.get('entry'); const keys = store.keys();
    const existed = store.delete('old'); const missing = store.delete('absent');
    const has = store.has('entry'); store.clear();
    store.set('__proto__', {safe:true});
    return {kept, keys, existed, missing, has, after:store.keys(), special:store.get('__proto__')};
  `, {data:{old:1}});
  assert.deepEqual(output.result, {kept:{list:[1, false, null]}, keys:['old', 'entry'], existed:true, missing:false, has:true, after:['__proto__'], special:{safe:true}});
  assert.deepEqual(output.dataWrites, [
    {key:'entry', value:{list:[1, false, null]}}, {key:'old', remove:true}, {key:'absent', remove:true},
    {key:'entry', remove:true}, {key:'__proto__', value:{safe:true}}
  ]);
  assert.equal({}.safe, undefined);
});

test('non-JSON shared data is rejected without silently coercing or deleting values', async () => {
  for (const value of ['undefined', 'NaN', 'Infinity', '1n', 'new Date()', 'new Map()', '()=>1', '[undefined]', '({a:undefined})']) {
    await assert.rejects(executeScript(`store.set('invalid', ${value});`), /JSON/);
  }
  await assert.rejects(executeScript('const cyclic = {}; cyclic.self = cyclic; store.set("cycle", cyclic);'), /循環参照/);
});

test('awaited asynchronous work completes and logs arrive before completion', async () => {
  let release, firstLog;
  const gate = new Promise(resolve => {release = resolve;});
  const observed = new Promise(resolve => {firstLog = resolve;});
  let complete = false;
  const run = executeScript(`
    console.info('started');
    await minipost.workspace.read();
    await new Promise(resolve => setTimeout(resolve, 5));
    console.log('finished');
    return Promise.resolve(42);
  `, {}, {onLog:entry => firstLog(entry), onCall:() => gate}).then(result => {complete = true; return result;});
  assert.deepEqual(await observed, {level:'info', message:'started'});
  assert.equal(complete, false);
  release({});
  const output = await run;
  assert.equal(output.result, 42);
  assert.deepEqual(output.logs.map(entry => entry.message), ['started', 'finished']);
});

test('RPC receives typed arguments and the latest uncommitted variable snapshot', async () => {
  const calls = [], hostResult = {status:201, body:{created:true}}, controller = new AbortController();
  const output = await executeScript(`
    vars.set('token', 'new'); pm.environment.set('host', 'new-host'); pm.globals.unset('old');
    const result = await minipost.requests.send(input.request, {tag:input.tag});
    result.body.created = false;
    await minipost.requests.list(); await minipost.requests.get('request-id');
    await minipost.environments.list(); await minipost.environments.get('environment-id');
    await minipost.workspace.read();
    return result;
  `, {input:{request:{method:'POST', url:'https://example.invalid'}, tag:7}, primary:{token:'old'}, environment:{host:'old-host'}, globals:{old:'value'}}, {
    signal:controller.signal,
    onCall:async (method, args, meta) => {calls.push({method, args, variables:meta.variables}); assert.equal(meta.signal, controller.signal); return hostResult;}
  });
  assert.deepEqual(calls.map(call => call.method), ['requests.send', 'requests.list', 'requests.get', 'environments.list', 'environments.get', 'workspace.read']);
  assert.deepEqual(calls[0].args, [{method:'POST', url:'https://example.invalid'}, {tag:7}]);
  assert.deepEqual(calls[0].variables, {primary:{token:'new'}, environment:{host:'new-host'}, globals:{}});
  assert.deepEqual(calls[2].args, ['request-id']);
  assert.equal(output.result.body.created, false);
  assert.equal(hostResult.body.created, true);
});

test('host operation errors are normal catchable script errors', async () => {
  const output = await executeScript('try { await minipost.requests.get("missing"); } catch (error) { return error.message; }', {}, {
    onCall:() => {throw new Error('request not found');}
  });
  assert.equal(output.result, 'request not found');
  await assert.rejects(executeScript('await minipost.requests.list();'), /この実行環境/);
});

test('legacy request response and string variable APIs remain available', async () => {
  const output = await executeScript(`
    pm.test('response', () => pm.expect(pm.response.code).to.equal(200));
    pm.variables.set('fromBody', pm.response.json().answer);
    pm.environment.set('enabled', false); pm.globals.set('empty', undefined);
    return {inherited:vars.get('base'), body:response.body, request:request.method, alias:pm.request === request, header:pm.response.headers.get('Content-Type'), text:pm.response.text(), aliases:minipost.variables === vars && minipost.environment === pm.environment && minipost.store === store && minipost.scripts === scripts};
  `, {variables:{base:'yes'}, request:{method:'POST'}, response:{status:200, body:{answer:42}, headers:{'content-type':'application/json'}}, raw:{body:'{"answer":42}'}});
  assert.deepEqual(output.result, {inherited:'yes', body:{answer:42}, request:'POST', alias:true, header:'application/json', text:'{"answer":42}', aliases:true});
  assert.deepEqual(output.writes, {primary:[{key:'fromBody', value:'42'}], environment:[{key:'enabled', value:'false'}], globals:[{key:'empty', value:''}]});
  assert.deepEqual(output.logs, [{level:'test', message:'PASS response'}]);
});

test('async pm.test waits for assertions, including a child script, without requiring an explicit await', async () => {
  const output = await executeScript(`
    pm.test('asynchronous child', async () => {
      const result = await scripts.run('child');
      pm.expect(result).to.equal(3);
    });
    return 'done';
  `, {scripts:[{id:'child', name:'child', source:'pm.test("nested", async () => {await new Promise(resolve => setTimeout(resolve, 5)); pm.expect(1).to.equal(1);}); return 3;'}]});
  assert.equal(output.result, 'done');
  assert.deepEqual(output.logs.map(entry => entry.message), ['PASS nested', 'PASS asynchronous child']);
  await assert.rejects(executeScript('pm.test("failure", async () => {await Promise.resolve(); pm.expect(1).to.equal(2);});'), error => {
    assert.deepEqual(error.logs.map(entry => entry.message), ['FAIL failure: Expected 1 to equal 2']); return true;
  });
});

test('aborting pending work preserves earlier logs and prevents a successful transaction', async () => {
  const controller = new AbortController();
  const run = executeScript('console.log("before wait"); store.set("notCommitted", true); await minipost.workspace.read(); return true;', {}, {
    signal:controller.signal,
    onCall:() => new Promise(() => {queueMicrotask(() => controller.abort());})
  });
  await assert.rejects(run, error => {assert.equal(error.name, 'AbortError'); assert.deepEqual(error.logs, [{level:'log', message:'before wait'}]); return true;});
});

test('an abort inside the host callback consumes its rejected Promise without an unhandled rejection', async () => {
  const controller = new AbortController();
  await assert.rejects(executeScript('await minipost.workspace.read();', {}, {
    signal:controller.signal,
    onCall:() => {controller.abort(); return Promise.reject(new Error('host cancelled'));}
  }), {name:'AbortError'});
});

test('an uncloneable return value fails the transaction and preserves preceding logs', async () => {
  await assert.rejects(executeScript('store.set("pending", true); console.log("before return"); return () => 1;'), error => {
    assert.equal(error.name, 'DataCloneError');
    assert.deepEqual(error.logs, [{level:'log', message:'before return'}]);
    assert.equal(Object.hasOwn(error, 'dataWrites'), false);
    return true;
  });
});

test('logs are retained beyond 200 entries and excessive output is explicitly reported', async () => {
  const output = await executeScript('for (let i = 0; i < 250; i++) console.log(i);');
  assert.equal(output.logs.length, 250); assert.equal(output.logs.at(-1).message, '249');
  const excessive = await executeScript('for (let i = 0; i < 10005; i++) console.log(i);');
  assert.equal(excessive.logs.length, 10001);
  assert.equal(excessive.logs.at(-1).level, 'warn'); assert.match(excessive.logs.at(-1).message, /省略/);
});

test('the serializable Worker executor has no hidden module dependencies', async () => {
  const isolated = new Function(`return (${executeScript.toString()});`)();
  const output = await isolated('store.set("value", input); return await scripts.run("double", input);', {input:4, scripts:[{id:'double', name:'Double', source:'return input * 2;'}]});
  assert.equal(output.result, 8); assert.deepEqual(output.dataWrites, [{key:'value', value:4}]);
});

test('the actual Worker protocol continues through logs and asynchronous RPC replies', async () => {
  const source = await readFile(new URL('../static/script-runner.mjs', import.meta.url), 'utf8');
  const module = new Function('executeScript', source.replace(/^import .*;$/m, '').replace('export function runScript', 'function runScript') + '\nreturn {workerSource};')(executeScript);
  const messages = []; let self;
  self = {postMessage:message => {
    messages.push(structuredClone(message));
    if (message.type === 'call') queueMicrotask(() => self.onmessage({data:{type:'call-result', id:message.id, ok:true, value:{answer:21}}}));
  }};
  new Function('self', module.workerSource)(self);
  await self.onmessage({data:{type:'start', source:'console.log("start"); const result = await minipost.workspace.read(); console.log("received"); return result.answer * 2;', context:{}}});
  assert.deepEqual(messages.map(message => message.type), ['log', 'call', 'log', 'result']);
  assert.equal(messages.at(-1).result.result, 42);
  assert.deepEqual(messages[1].variables, {primary:{}, environment:{}, globals:{}});
});
