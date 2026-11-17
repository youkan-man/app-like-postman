/** A script transaction. The browser host runs this function in an isolated Worker. */
export async function executeScript(source, context = {}, options = {}) {
  const logs = [], writes = {primary:[], environment:[], globals:[]}, dataWrites = [];
  const {signal, onLog, onCall} = options;
  let finished = false, omittedLogs = false;
  const copy = value => structuredClone(value);
  const abortError = () => new DOMException('スクリプトを停止しました。', 'AbortError');
  const checkActive = () => { if (signal?.aborted || finished) throw abortError(); };
  const wait = promise => {
    const pending = Promise.resolve(promise);
    if (signal?.aborted || finished) { pending.catch(() => {}); return Promise.reject(abortError()); }
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(abortError()); };
      signal.addEventListener('abort', abort, {once:true});
      pending.then(value => {
        signal.removeEventListener('abort', abort);
        signal.aborted ? reject(abortError()) : resolve(value);
      }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  };
  const text = value => value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const display = value => {
    if (value === undefined) return 'undefined';
    if (value instanceof Error) return value.message;
    try { return text(value); } catch { return String(value); }
  };
  const emit = entry => {
    logs.push(entry);
    try { const pending = onLog?.(copy(entry)); pending?.catch?.(() => {}); } catch {}
  };
  const log = (level, ...values) => {
    if (finished || signal?.aborted) return;
    if (logs.length >= 10000) {
      if (!omittedLogs) {
        omittedLogs = true;
        emit({level:'warn', message:'ログが10,000件を超えたため、以降のログを省略しました。'});
      }
      return;
    }
    emit({level, message:values.map(display).join(' ')});
  };
  function jsonValue(value, seen = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
      throw new TypeError('共有データにはJSONの値（文字列・数値・真偽値・null・配列・オブジェクト）を指定してください。');
    if (seen.has(value)) throw new TypeError('共有データに循環参照は保存できません。');
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
      result = [];
      for (let at = 0; at < value.length; at++) result.push(jsonValue(value[at], seen));
    } else result = Object.fromEntries(Object.keys(value).map(key => [key, jsonValue(value[key], seen)]));
    seen.delete(value);
    return result;
  }
  try {
    checkActive();
    const ctx = copy(context);
    const maps = {
      primary:new Map(Object.entries(ctx.primary || {})),
      environment:new Map(Object.entries(ctx.environment || {})),
      globals:new Map(Object.entries(ctx.globals || {}))
    };
    const merged = new Map(Object.entries(ctx.variables || {}));
    const variableAPI = kind => ({
      get(key) { checkActive(); key = String(key); return maps[kind].has(key) ? maps[kind].get(key) : kind === 'primary' ? merged.get(key) : undefined; },
      has(key) { checkActive(); key = String(key); return maps[kind].has(key) || (kind === 'primary' && merged.has(key)); },
      set(key, value) {
        checkActive(); key = String(key); value = text(value); maps[kind].set(key, value);
        if (kind === 'primary') merged.set(key, value);
        writes[kind].push({key, value});
      },
      unset(key) {
        checkActive(); key = String(key); maps[kind].delete(key);
        if (kind === 'primary') merged.delete(key);
        writes[kind].push({key, remove:true});
      },
      toObject() { checkActive(); return copy(Object.fromEntries(kind === 'primary' ? new Map([...merged, ...maps[kind]]) : maps[kind])); }
    });
    const vars = variableAPI('primary'), environment = variableAPI('environment'), globals = variableAPI('globals');
    const initialData = ctx.data === undefined ? {} : ctx.data;
    if (!initialData || typeof initialData !== 'object' || Array.isArray(initialData)) throw new TypeError('共有データはオブジェクトで指定してください。');
    const data = new Map(Object.entries(jsonValue(initialData)));
    const store = {
      get(key) { checkActive(); return copy(data.get(String(key))); },
      has(key) { checkActive(); return data.has(String(key)); },
      set(key, value) {
        checkActive(); key = String(key); value = jsonValue(value);
        data.set(key, value); dataWrites.push({key, value:copy(value)}); return copy(value);
      },
      delete(key) { checkActive(); key = String(key); const existed = data.delete(key); dataWrites.push({key, remove:true}); return existed; },
      keys() { checkActive(); return [...data.keys()]; },
      clear() { checkActive(); for (const key of data.keys()) dataWrites.push({key, remove:true}); data.clear(); }
    };
    const catalog = Array.isArray(ctx.scripts) ? ctx.scripts : [];
    const findScript = (reference, binding) => {
      const key = String(reference), bound = binding && Object.hasOwn(binding, key);
      const byId = catalog.filter(script => script.id === (bound ? binding[key] : key));
      const matches = bound || byId.length ? byId : catalog.filter(script => script.name === key);
      if (!matches.length) throw new Error(`スクリプトが見つかりません: ${key}`);
      if (matches.length > 1) throw new Error(`スクリプト名またはIDが重複しています: ${key}。一意なIDで指定してください。`);
      return matches[0];
    };
    const call = async (method, args) => {
      checkActive();
      if (typeof onCall !== 'function') throw new Error(`この実行環境では ${method} を利用できません。`);
      const variables = Object.fromEntries(Object.entries(maps).map(([kind, values]) => [kind, copy(Object.fromEntries(values))]));
      const result = await wait(onCall(method, copy(args), {signal, variables}));
      checkActive(); return copy(result);
    };
    const applicationAPI = {
      requests:{list:() => call('requests.list', []), get:reference => call('requests.get', [reference]), send:(reference, options) => call('requests.send', [reference, options])},
      environments:{list:() => call('environments.list', []), get:reference => call('environments.get', [reference])},
      workspace:{read:() => call('workspace.read', [])},
      variables:vars, environment, globals, store
    };
    const scriptConsole = Object.fromEntries(['log', 'info', 'debug', 'warn', 'error'].map(level => [level, (...values) => log(level, ...values)]));
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    async function invoke(code, value, id) {
      checkActive();
      const input = copy(value), request = copy(ctx.request), response = copy(ctx.response), pendingTests = [];
      const caller = catalog.find(script => script.id === id);
      const bindingId = caller ? caller.bindingId : id == null || id === '' ? ctx.bindingId : undefined;
      const binding = bindingId && ctx.bindings && Object.hasOwn(ctx.bindings, bindingId) ? ctx.bindings[bindingId] : null;
      const scripts = {
        list() { checkActive(); return catalog.map(({id, name}) => ({id, name})); },
        async run(reference, input) { checkActive(); const script = findScript(reference, binding); return copy(await invoke(script.source, input, script.id)); }
      };
      const minipost = {...applicationAPI, scripts};
      const test = (name, fn) => {
        checkActive();
        const pass = () => { log('test', 'PASS ' + name); };
        const fail = error => { log('test', 'FAIL ' + name + ': ' + String(error?.message || error)); throw error; };
        let result;
        try { result = fn(); } catch (error) { return fail(error); }
        if (result && typeof result.then === 'function') {
          const pending = Promise.resolve(result).then(pass, fail);
          pending.catch(() => {}); pendingTests.push(pending); return pending;
        }
        pass();
      };
      const pm = {
        variables:vars, environment, globals, request,
        response:response ? {
          code:response.status, status:response.statusText, responseTime:response.elapsed_ms, responseSize:response.size,
          headers:{get:name => {const value = response.headers?.[String(name).toLowerCase()]; return Array.isArray(value) ? value[0] : value;}, all:() => copy(response.headers || {})},
          json:() => {if (ctx.raw?.body_encoding === 'base64') throw new Error('バイナリ応答はJSONとして読めません'); return JSON.parse(ctx.raw?.body || '');},
          text:() => ctx.raw?.body || ''
        } : null,
        test,
        expect:actual => ({to:{
          equal:expected => {if (!Object.is(actual, expected)) throw new Error('Expected ' + text(actual) + ' to equal ' + text(expected));},
          eql:expected => {if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Expected deep equality');},
          include:expected => {if (!String(actual).includes(String(expected))) throw new Error('Expected value to include ' + text(expected));}
        }})
      };
      // Keep host bindings outside the user's lexical scope so ordinary local
      // declarations such as `const request` can shadow them without collisions.
      const fn = new AsyncFunction('pm', 'vars', 'response', 'request', 'console', 'input', 'scripts', 'store', 'minipost', '"use strict";\n{\n' + String(code || '') + '\n}\n//# sourceURL=minipost-script-' + encodeURIComponent(id || 'manual') + '.js');
      const result = await fn(pm, vars, response, request, scriptConsole, input, scripts, store, minipost);
      for (let at = 0; at < pendingTests.length;) {
        const batch = pendingTests.slice(at); at = pendingTests.length; await Promise.all(batch);
      }
      checkActive(); return copy(result);
    }
    const result = await wait(invoke(source, ctx.input, ctx.scriptId));
    checkActive();
    return {ok:true, result, writes:copy(writes), dataWrites:copy(dataWrites), logs:copy(logs)};
  } catch (cause) {
    const error = new Error(String(cause?.message ?? cause));
    error.name = cause?.name || 'Error';
    if (cause?.stack) error.stack = cause.stack;
    error.logs = copy(logs);
    throw error;
  } finally { finished = true; }
}
