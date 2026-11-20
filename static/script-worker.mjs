/** A script transaction. The browser host runs this function in an isolated Worker. */
import {createWorkspaceModel,workspaceChanges,applyWorkspaceChanges} from './workspace-api.mjs';
import {createScriptTools} from './script-tools.mjs';
import {createRequestEditor} from './script-request.mjs';

/** The exact dependency bundle used by the opaque-origin browser Worker. */
export function scriptExecutorSource() {
  return `const createRequestEditor = ${createRequestEditor.toString()};\nconst applyWorkspaceChanges = ${applyWorkspaceChanges.toString()};\nconst workspaceChanges = ${workspaceChanges.toString()};\nconst createWorkspaceModel = ${createWorkspaceModel.toString()};\nconst createScriptTools = ${createScriptTools.toString()};\nconst executeScript = ${executeScript.toString()};`;
}
export async function executeScript(source, context = {}, options = {}) {
  const logs = [], writes = {primary:[], environment:[], globals:[]}, dataWrites = [], ribbonWrites = [];
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
    const model = ctx.workspace ? createWorkspaceModel(ctx.workspace,{checkActive,
      requestRef:Object.hasOwn(ctx,'ribbonOwnerRef')?ctx.ribbonOwnerRef:ctx.requestRef || null,
      ribbonScopeId:ctx.ribbonScopeId || null,environmentId:ctx.environmentId || ''}) : null;
    const workspaceBefore = model ? copy(model.state) : null;
    const tools = createScriptTools({signal,checkActive});
    const same = (left, right, seen = new WeakMap()) => {
      if (Object.is(left, right)) return true;
      if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
      if (seen.has(left)) return seen.get(left) === right;
      seen.set(left, right);
      const keys = Object.keys(left);
      return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key], seen));
    };
    // Ribbon state is another part of this transaction: child scripts see pending
    // changes immediately, while the host commits only the explicitly changed fields.
    const ribbonScopeId = typeof ctx.ribbonScopeId === 'string' && ctx.ribbonScopeId ? ctx.ribbonScopeId : null;
    const ribbonWorkspace = model ? {
      get ribbons(){return model.getRibbonState()?.ribbons || [];},
      get activeRibbonId(){return model.getRibbonState()?.activeRibbonId || '';},
      set activeRibbonId(value){const state=model.getRibbonState();if(!state)throw new Error('リボンの実行先がありません。');state.activeRibbonId=value;}
    } : {ribbons:ribbonScopeId && Array.isArray(ctx.ribbons) ? ctx.ribbons : [], activeRibbonId:ribbonScopeId ? ctx.activeRibbonId || '' : ''};
    const ribbonRows = () => ribbonWorkspace.ribbons.flatMap(ribbon => (ribbon.groups || []).flatMap(group =>
      (group.controls || []).map(control => ({ribbon, group, control, reference:`${ribbon.key}.${control.key}`}))));
    const ribbonName = item => ({id:item.id, key:item.key, name:item.name});
    const ribbonJSON = value => {
      const pending = [value], seen = new Set();
      while (pending.length) {
        const item = pending.pop();
        if (!item || typeof item !== 'object' || seen.has(item)) continue;
        seen.add(item);
        if (Object.getOwnPropertySymbols(item).length) throw new TypeError('リボンの値にはJSONで表せる値を指定してください。');
        if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new TypeError('リボンの値にはJSONで表せる配列を指定してください。');
        for (const key of Object.keys(item)) pending.push(item[key]);
      }
      try { return jsonValue(value); }
      catch { throw new TypeError('リボンの値にはJSONで表せる値を指定してください。'); }
    };
    const normalizeRibbonValue = (control, value) => {
      if (control.type === 'text') {
        if (value === null) return '';
        if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return String(value);
        throw new TypeError('文字入力には文字列・数値・真偽値を指定してください。');
      }
      if (control.type === 'number') {
        if (value === null || typeof value === 'string' && !value.trim()) return null;
        if ((typeof value === 'number' || typeof value === 'string') && Number.isFinite(Number(value))) return Number(value);
        throw new TypeError('数値入力には有限の数値を指定してください。');
      }
      if (control.type === 'toggle') {
        if (typeof value === 'boolean') return value;
        throw new TypeError('チェックには真偽値を指定してください。');
      }
      if (control.type === 'select') {
        if (typeof value === 'string' && (value === '' || (control.options || []).some(option => option.value === value))) return value;
        throw new TypeError('選択欄の選択肢にある値を指定してください。');
      }
      if (control.type === 'button' || control.type === 'display') return ribbonJSON(value);
      throw new TypeError('リボンの項目形式が不正です。');
    };
    const stageRibbon = (type, id, value, expected, expectedShape) => {
      const existing = ribbonWrites.find(row => row.type === type && row.id === id);
      if (existing) existing.value = copy(value);
      else ribbonWrites.push({type, id, value:copy(value), expected:copy(expected), ...(expectedShape ? {expectedShape:copy(expectedShape)} : {})});
    };
    function ribbonAPI(bindingId) {
      const bind = (kind, reference) => {
        const bindings=model ? model.getRibbonState()?.ribbonBindings : ctx.ribbonBindings;
        const binding = bindingId && bindings && Object.hasOwn(bindings,bindingId) ? bindings[bindingId] : null;
        if (typeof reference !== 'string' || !reference) throw new TypeError('リボンのIDまたはキーを指定してください。');
        const entries = binding?.[kind];
        return entries && Object.hasOwn(entries, reference) ? {key:entries[reference], bound:true} : {key:reference, bound:false};
      };
      const resolveRibbon = reference => {
        const {key, bound} = bind('ribbons', reference);
        const exact = ribbonWorkspace.ribbons.filter(item => item.id === key);
        const matches = exact.length || bound ? exact : ribbonWorkspace.ribbons.filter(item => item.key === key || item.name === key);
        if (!matches.length) throw new Error(`リボンが見つかりません: ${reference}`);
        if (matches.length > 1) throw new Error(`リボンが複数あります。IDで指定してください: ${reference}`);
        return matches[0];
      };
      const resolveControl = reference => {
        const {key, bound} = bind('controls', reference), rows = ribbonRows();
        let matches = rows.filter(row => row.control.id === key);
        if (!matches.length && !bound) matches = rows.filter(row => row.reference === key);
        if (!matches.length && !bound) {
          const named = rows.filter(row => row.control.key === key), current = named.filter(row => row.ribbon.id === ribbonWorkspace.activeRibbonId);
          matches = current.length ? current : named;
        }
        if (!matches.length) throw new Error(`リボンの項目が見つかりません: ${reference}`);
        if (matches.length > 1) throw new Error(`リボンの項目が複数あります。IDまたはリボン名付きのキーで指定してください: ${reference}`);
        return matches[0];
      };
      const selectedRows = reference => {
        if (reference === undefined && !ribbonWorkspace.activeRibbonId) return [];
        const selected = reference === undefined ? ribbonWorkspace.ribbons.find(item => item.id === ribbonWorkspace.activeRibbonId) : resolveRibbon(reference);
        if (!selected) throw new Error('選択中のリボンが見つかりません。');
        return ribbonRows().filter(row => row.ribbon.id === selected.id);
      };
      const setFlag = (field, reference, value) => {
        checkActive();
        if (typeof value !== 'boolean') throw new TypeError('表示・有効状態には真偽値を指定してください。');
        const {control} = resolveControl(reference), before = control[field] !== false;
        if (before !== value) {stageRibbon(field, control.id, value, before);control[field] = value;}
        return value;
      };
      return {
        list() {checkActive();return ribbonWorkspace.ribbons.map(ribbonName);},
        active() {checkActive();const current = ribbonWorkspace.ribbons.find(item => item.id === ribbonWorkspace.activeRibbonId);return current ? ribbonName(current) : null;},
        controls(reference) {
          checkActive();
          return selectedRows(reference).map(({ribbon, group, control}) => ({id:control.id, key:control.key, label:control.label,
            type:control.type, value:copy(control.value), visible:control.visible !== false, enabled:control.enabled !== false,
            ribbonId:ribbon.id, ribbonKey:ribbon.key, ribbonName:ribbon.name, groupId:group.id, groupName:group.name}));
        },
        values(reference) {checkActive();return Object.fromEntries(selectedRows(reference).map(({control}) => [control.key, copy(control.value)]));},
        get(reference, field = 'value') {
          checkActive();
          if (!['value','visible','enabled'].includes(field)) throw new TypeError('リボンのフィールドはvalue・visible・enabledで指定してください。');
          const {control} = resolveControl(reference);
          return field === 'value' ? copy(control.value) : control[field] !== false;
        },
        set(reference, field, value) {
          if (arguments.length === 2) {value = field; field = 'value';}
          if (!['value','visible','enabled'].includes(field)) throw new TypeError('リボンのフィールドはvalue・visible・enabledで指定してください。');
          if (field !== 'value') return setFlag(field, reference, value);
          checkActive();const {control} = resolveControl(reference), next = normalizeRibbonValue(control, value);
          if (!same(control.value, next)) {
            stageRibbon('value', control.id, next, control.value, {type:control.type, options:control.options || []});
            control.value = copy(next);
          }
          return copy(next);
        },
        show(reference, visible = true) {return setFlag('visible', reference, visible);},
        enable(reference, enabled = true) {return setFlag('enabled', reference, enabled);},
        activate(reference) {
          checkActive();const selected = resolveRibbon(reference);
          if (ribbonWorkspace.activeRibbonId !== selected.id) {
            // Activation is one field even when a script switches several times.
            const previous = ribbonWrites.find(row => row.type === 'activate');
            if (previous) {previous.id = selected.id;previous.value = selected.id;}
            else stageRibbon('activate', selected.id, selected.id, ribbonWorkspace.activeRibbonId);
            ribbonWorkspace.activeRibbonId = selected.id;
          }
          return ribbonName(selected);
        }
      };
    }
    // A parent and every scripts.run() child share this one transaction. Input
    // remains a value argument; request/response are explicitly mutable state.
    const request = copy(ctx.request), response = copy(ctx.response);
    const initialRequest = copy(request), initialResponse = copy(response);
    // File selections belong to form-data row identities, not to their current
    // array positions. A Symbol follows ordinary object spread while remaining
    // absent from JSON and the structured-cloned request returned to the host.
    const fileRowIdentity = Symbol('MiniPost file row');
    const initialFormRows = Array.isArray(request?.body?.formdata) ? request.body.formdata : [];
    const initialFilePositions = initialFormRows.map(row => row?.type === 'file');
    initialFormRows.forEach((row, index) => {
      if (row && typeof row === 'object') Object.defineProperty(row, fileRowIdentity, {value:index, enumerable:true});
    });
    const fileRows = () => Array.from(Array.isArray(request?.body?.formdata) ? request.body.formdata : [], row => {
      const source = row?.[fileRowIdentity];
      return row?.type === 'file' && Number.isInteger(source) && initialFilePositions[source] ? source : null;
    });
    const initialFileRows = fileRows();
    if (request && typeof request === 'object' && !Array.isArray(request)) {
      const editor = createRequestEditor({read:() => request, change:callback => callback(request), checkActive});
      for (const [key, value] of Object.entries(editor)) if (!Object.hasOwn(request, key))
        Object.defineProperty(request, key, {value, enumerable:false});
    }
    let responseBodySet = false;
    const bodyChanged = () => response && (responseBodySet || !same(response.body, initialResponse?.body) || response.body_encoding !== initialResponse?.body_encoding);
    const responseText = () => {
      checkActive();
      if (!bodyChanged() && typeof ctx.raw?.body === 'string') return ctx.raw.body;
      if (typeof response.body === 'string') return response.body;
      return response.body === undefined ? '' : JSON.stringify(response.body);
    };
    const responseJSON = () => {
      checkActive();
      if (response.body_encoding === 'base64') throw new Error('バイナリ応答はJSONとして読めません');
      if (!bodyChanged() && typeof ctx.raw?.body === 'string') return JSON.parse(ctx.raw.body);
      return typeof response.body === 'string' ? JSON.parse(response.body) : copy(response.body);
    };
    const responseHeader = name => {
      checkActive();
      const key = Object.keys(response.headers || {}).find(key => key.toLowerCase() === String(name).toLowerCase());
      const value = key === undefined ? undefined : response.headers[key];
      return Array.isArray(value) ? value[0] : value;
    };
    const removeResponseHeader = name => {
      checkActive();
      for (const key of Object.keys(response.headers || {})) if (key.toLowerCase() === String(name).toLowerCase()) delete response.headers[key];
      if (String(name).toLowerCase() === 'content-type') response.content_type = '';
    };
    const setResponseHeader = (name, value) => {
      checkActive();
      if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new TypeError('レスポンスヘッダー名が不正です。');
      const values = Array.isArray(value) ? value : [value];
      if (!values.length || values.some(item => typeof item !== 'string' || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(item))) throw new TypeError('レスポンスヘッダー値が不正です。');
      removeResponseHeader(name);
      if (!response.headers || typeof response.headers !== 'object' || Array.isArray(response.headers)) response.headers = {};
      Object.defineProperty(response.headers, name.toLowerCase(), {value:copy(value), enumerable:true, configurable:true, writable:true});
      if (name.toLowerCase() === 'content-type') response.content_type = values[0];
    };
    const responseSize = () => {
      if (!bodyChanged()) return response.size;
      const value = responseText();
      return response.body_encoding === 'base64' ? atob(value).length : new TextEncoder().encode(value).byteLength;
    };
    if (response && typeof response === 'object') {
      const methods = {
        setBody(value, contentType) {
          checkActive();
          let body;
          try { body = jsonValue(value); } catch { throw new TypeError('レスポンス本文には文字列またはJSONの値を指定してください。'); }
          const type = contentType === undefined ? typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json' : contentType;
          setResponseHeader('content-type', type);
          response.body = body; response.body_encoding = 'text'; responseBodySet = true;
          return copy(body);
        },
        getHeader:responseHeader, setHeader:setResponseHeader, removeHeader:removeResponseHeader,
        text:responseText, json:responseJSON,
        show(view) {
          checkActive();
          if (!['pretty','raw','headers','cookies','preview'].includes(view)) throw new TypeError('レスポンスの表示形式が不正です。');
          response.view = view;
        }
      };
      for (const [name, value] of Object.entries(methods)) Object.defineProperty(response, name, {value, enumerable:false});
    }
    const maps = {
      primary:new Map(Object.entries(ctx.primary || {})),
      environment:new Map(Object.entries(ctx.environment || {})),
      globals:new Map(Object.entries(ctx.globals || {}))
    };
    const primaryRows=copy(ctx.primaryRows || Object.entries(ctx.primary || {}).map(([key,value])=>({key,value,enabled:true})));
    const primaryRowsBaseline=copy(ctx.primaryRowsCommitBaseline || primaryRows);
    const primaryTouchedKeys=new Set();
    const merged = new Map(Object.entries(ctx.variables || {}));
    const variableAPI = kind => ({
      get(key) { checkActive(); key = String(key); if(model&&kind!=='primary')return model.api[kind].get(key);if(maps[kind].has(key))return maps[kind].get(key);if(kind!=='primary')return undefined;if(!model)return merged.get(key);const values=model.contextVariables(ctx.requestRef,Object.fromEntries(maps.primary),ctx.variableContext);return Object.hasOwn(values,key)?values[key]:undefined; },
      has(key) { checkActive();return this.get(key)!==undefined; },
      set(key, value) {
        checkActive(); key = String(key); value = text(value); maps[kind].set(key, value);
        if(model&&kind!=='primary')model.api[kind].set(key,value);
        if (kind === 'primary') {primaryTouchedKeys.add(key);merged.set(key, value);const row=primaryRows.findLast(row=>row.key===key);if(row)Object.assign(row,{value,enabled:true,disabled:false});else primaryRows.push({key,value,enabled:true});}
        writes[kind].push({key, value});
      },
      unset(key) {
        checkActive(); key = String(key); maps[kind].delete(key);
        if(model&&kind!=='primary')model.api[kind].unset(key);
        if (kind === 'primary') {primaryTouchedKeys.add(key);merged.delete(key);for(let at=primaryRows.length-1;at>=0;at--)if(primaryRows[at].key===key)primaryRows.splice(at,1);}
        writes[kind].push({key, remove:true});
      },
      list(){checkActive();return model&&kind!=='primary'?model.api[kind].list():Object.entries(this.toObject()).map(([key,value])=>({key,value,enabled:true}));},
      clear(){
        checkActive();
        if(model&&kind!=='primary'){const count=model.api[kind].clear();maps[kind].clear();return count;}
        if(kind==='primary'){
          const count=primaryRows.length,keys=[...new Set(primaryRows.map(row=>row.key))];
          for(const key of keys){primaryTouchedKeys.add(key);if(typeof key==='string'&&key.trim()&&!/[{}\r\n]/.test(key))this.unset(key);else merged.delete(key);}
          maps.primary.clear();primaryRows.splice(0);return count;
        }
        const keys=Object.keys(this.toObject());for(const key of keys)this.unset(key);return keys.length;
      },
      toObject() { checkActive();if(model)return kind==='primary'?model.contextVariables(ctx.requestRef,Object.fromEntries(maps.primary),ctx.variableContext):model.api[kind].toObject();return copy(Object.fromEntries(kind === 'primary' ? new Map([...merged, ...maps[kind]]) : maps[kind])); }
    });
    const vars = variableAPI('primary'), environment = variableAPI('environment'), globals = variableAPI('globals');
    const initialData = ctx.data === undefined ? {} : ctx.data;
    if (!initialData || typeof initialData !== 'object' || Array.isArray(initialData)) throw new TypeError('共有データはオブジェクトで指定してください。');
    const data = new Map(Object.entries(jsonValue(initialData)));
    const currentData = () => model ? model.state.scriptData || {} : Object.fromEntries(data);
    const store = {
      get(key) { checkActive(); key=String(key);const current=currentData();return Object.hasOwn(current,key)?copy(current[key]):undefined; },
      has(key) { checkActive(); return Object.hasOwn(currentData(),String(key)); },
      set(key, value) {
        checkActive(); key = String(key); value = jsonValue(value);
        if(model){model.state.scriptData??={};Object.defineProperty(model.state.scriptData,key,{value:copy(value),enumerable:true,configurable:true,writable:true});}
        data.set(key, value); dataWrites.push({key, value:copy(value)}); return copy(value);
      },
      delete(key) { checkActive(); key = String(key); const existed = this.has(key);if(model?.state.scriptData)delete model.state.scriptData[key];data.delete(key); dataWrites.push({key, remove:true}); return existed; },
      keys() { checkActive(); return Object.keys(currentData()); },
      clear() { checkActive(); for (const key of Object.keys(currentData())) dataWrites.push({key, remove:true}); data.clear();if(model)model.state.scriptData={}; }
    };
    const catalog = () => model ? model.state.scripts || [] : Array.isArray(ctx.scripts) ? ctx.scripts : [];
    const findScript = (reference, binding) => {
      const key = String(reference), bound = binding && Object.hasOwn(binding, key);
      const byId = catalog().filter(script => script.id === (bound ? binding[key] : key));
      const matches = bound || byId.length ? byId : catalog().filter(script => script.name === key);
      if (!matches.length) throw new Error(`スクリプトが見つかりません: ${key}`);
      if (matches.length > 1) throw new Error(`スクリプト名またはIDが重複しています: ${key}。一意なIDで指定してください。`);
      return matches[0];
    };
    const call = async (method, args) => {
      checkActive();
      if (typeof onCall !== 'function') throw new Error(`この実行環境では ${method} を利用できません。`);
      const variables = Object.fromEntries(Object.entries(maps).map(([kind, values]) => [kind, model&&kind!=='primary'?model.api[kind].toObject():copy(Object.fromEntries(values))]));
      const result = await wait(onCall(method, copy(args), {signal,variables,primaryRows:copy(primaryRows),...(model?{workspace:copy(model.state),requestRef:ctx.requestRef || ctx.ribbonOwnerRef || null,ribbonScopeId}:{} )}));
      checkActive();
      if(method==='relations.run'&&result?.__minipostTransaction===true){
        if(!model)throw new Error('リレーション実行にはワークスペースが必要です。');
        for(const expected of result.primaryExpected||[])if(maps.primary.has(expected.key)!==expected.exists||expected.exists&&maps.primary.get(expected.key)!==expected.value)throw new Error('リレーション実行中に同じ一次変数が変更されました。リレーションの変更は保存していません。');
        for(const row of result.primaryWrites||[])if(typeof row.key!=='string'||!row.key.trim()||/[{}\r\n]/.test(row.key)||!row.remove&&typeof row.value!=='string')throw new TypeError('リレーションの一次変数変更形式が不正です。');
        const pendingPrimary={globals:copy(primaryRows)};
        if(result.primaryRowsWrites!==undefined){
          if(!Array.isArray(result.primaryRowsWrites)||result.primaryRowsWrites.some(change=>change?.path?.[0]!=='globals'))throw new TypeError('一次変数の変更形式が不正です。');
          applyWorkspaceChanges(pendingPrimary,result.primaryRowsWrites);
        }
        model.apply(result.workspaceWrites||[]);
        if(result.primaryRowsWrites!==undefined){
          for(const key of new Set([...primaryRows,...pendingPrimary.globals].map(row=>row.key)))if(!same(primaryRows.filter(row=>row.key===key),pendingPrimary.globals.filter(row=>row.key===key)))primaryTouchedKeys.add(key);
          primaryRows.splice(0,primaryRows.length,...pendingPrimary.globals);maps.primary.clear();for(const row of primaryRows)if(row.key&&row.enabled!==false&&row.disabled!==true)maps.primary.set(row.key,text(row.value));
        }
        for(const row of result.primaryWrites||[])row.remove?vars.unset(row.key):vars.set(row.key,row.value);
        for(const entry of result.logs||[])log(entry.level||'log',entry.message);
        return copy(result.value);
      }
      return copy(result);
    };
    const applicationAPI = {
      requests:{list:() => call('requests.list', []), get:reference => call('requests.get', [reference]), send:(reference, options) => call('requests.send', [reference, options])},
      environments:{list:() => call('environments.list', []), get:reference => call('environments.get', [reference])},
      workspace:{read:() => call('workspace.read', [])},
      variables:vars, environment, globals, store, request, response
    };
    if(model){Object.assign(applicationAPI,model.api);Object.assign(applicationAPI,{variables:vars,environment,globals,store,request,response});}
    applicationAPI.requests.send=(reference,options)=>call('requests.send',[reference,options]);
    applicationAPI.relations={...(applicationAPI.relations||{}),run:(reference,options)=>call('relations.run',[reference,options])};
    applicationAPI.responses={list:()=>call('responses.list',[]),get:reference=>call('responses.get',[reference])};
    applicationAPI.attachments={list:reference=>call('attachments.list',[reference]),read:(reference,slot,index=0,options={})=>call('attachments.read',[reference,slot,index,options])};
    applicationAPI.tools=tools;
    const scriptConsole = Object.fromEntries(['log', 'info', 'debug', 'warn', 'error'].map(level => [level, (...values) => log(level, ...values)]));
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    async function invoke(code, value, id) {
      checkActive();
      const input = copy(value), pendingTests = [];
      const caller = catalog().find(script => script.id === id);
      const bindingId = caller ? caller.bindingId : id == null || id === '' ? ctx.bindingId : undefined;
      const bindings=model?model.state.scriptBindings:ctx.bindings;
      const binding = bindingId && bindings && Object.hasOwn(bindings, bindingId) ? bindings[bindingId] : null;
      const scripts = {
        ...(model?model.api.scripts:{}),
        list() { checkActive(); return catalog().map(({id, name}) => ({id, name})); },
        async run(reference, input) { checkActive(); const script = findScript(reference, binding); return copy(await invoke(script.source, input, script.id)); }
      };
      const ribbon = ribbonAPI(bindingId);
      const minipost = {...applicationAPI, scripts, ribbon};
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
          get code() { return response.status; }, get status() { return response.statusText; },
          get responseTime() { return response.elapsed_ms; }, get responseSize() { return responseSize(); },
          headers:{get:responseHeader, all:() => {checkActive(); return copy(response.headers || {});}},
          json:responseJSON, text:responseText
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
      const fn = new AsyncFunction('pm', 'vars', 'response', 'request', 'console', 'input', 'scripts', 'store', 'minipost', 'ribbon', 'tools', '"use strict";\n{\n' + String(code || '') + '\n}\n//# sourceURL=minipost-script-' + encodeURIComponent(id || 'manual') + '.js');
      const result = await fn(pm, vars, response, request, scriptConsole, input, scripts, store, minipost, ribbon, tools);
      for (let at = 0; at < pendingTests.length;) {
        const batch = pendingTests.slice(at); at = pendingTests.length; await Promise.all(batch);
      }
      checkActive(); return copy(result);
    }
    const result = await wait(invoke(source, ctx.input, ctx.scriptId));
    checkActive();
    const output = {ok:true, result, writes:copy(writes), dataWrites:copy(dataWrites), ribbonScopeId, ribbonWrites:copy(ribbonWrites), logs:copy(logs)};
    if(model){
      model.validate();output.workspaceTransaction=true;output.workspaceWrites=workspaceChanges(workspaceBefore,model.state);
      const primaryBaseline=ctx.primaryCommitBaseline??ctx.primary??{};
      output.primaryExpected=[...new Set(writes.primary.map(row=>row.key))].map(key=>({key,exists:Object.hasOwn(primaryBaseline,key),...(Object.hasOwn(primaryBaseline,key)?{value:primaryBaseline[key]}:{})}));
      // Response extraction may appear in the readable context before its final
      // value is known. Commit only rows explicitly changed by this script.
      const remaining=new Map([...primaryTouchedKeys].map(key=>[key,primaryRows.filter(row=>row.key===key).slice()])),rebasedRows=[];
      for(const row of primaryRowsBaseline){if(!primaryTouchedKeys.has(row.key))rebasedRows.push(row);else{const next=remaining.get(row.key).shift();if(next)rebasedRows.push(next);}}
      for(const row of primaryRows)if(remaining.get(row.key)?.[0]===row){rebasedRows.push(row);remaining.get(row.key).shift();}
      output.primaryRowsWrites=workspaceChanges({globals:primaryRowsBaseline},{globals:rebasedRows});
      const before=createWorkspaceModel(workspaceBefore).api.requests.list(),after=model.api.requests.list(),ids=new Set([...before,...after].map(row=>row.id));
      output.changedRequests=[...ids].flatMap(id=>{const old=before.find(row=>row.id===id),next=after.find(row=>row.id===id);return same(old?.request,next?.request)?[]:[{id,before:old?.request??null,after:next?.request??null}];});
    }
    const attachmentRows = fileRows();
    if (!same(request, initialRequest) || !same(attachmentRows, initialFileRows)) {
      output.request = copy(request);
      output.attachmentRows = attachmentRows;
    }
    const replacedBody = responseBodySet && typeof ctx.raw?.body === 'string' && responseText() !== ctx.raw.body;
    if (!same(response, initialResponse) || replacedBody) {
      output.response = copy(response);
      if (replacedBody) output.response.body_replaced = true;
    }
    return output;
  } catch (cause) {
    const error = new Error(String(cause?.message ?? cause));
    error.name = cause?.name || 'Error';
    if (cause?.stack) error.stack = cause.stack;
    error.logs = copy(logs);
    throw error;
  } finally { finished = true; }
}
