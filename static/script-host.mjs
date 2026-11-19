/** App capabilities available to scripts. Execution does not depend on an open request. */
import {clone,uid,rows,enabled,walkItems,normalizeRequest,compileRequest,contextFor,newRequest} from './core.mjs';
import {responseMetadata} from './runtime.mjs';
import {sendThroughProxy} from './transport.mjs';
import {getRequestRibbonState,findRequestRibbonState} from './ribbons.mjs';

const valueMap = values => Object.fromEntries(rows(values).filter(row => row.key && enabled(row)).map(row => [row.key,row.value]));
const variableRows = values => Object.entries(values || {}).map(([key,value]) => ({key,value,enabled:true}));

/** Capture one owner's ribbon state without consulting the changing UI selection. */
export function scriptRibbonSnapshot(workspace,{ribbonOwner,ribbonScopeId}={}) {
  if (ribbonScopeId!==undefined && ribbonScopeId!==null && (typeof ribbonScopeId!=='string' || !ribbonScopeId)) throw new TypeError('リボンの実行先が不正です。');
  const state=ribbonScopeId===undefined ? getRequestRibbonState(workspace,ribbonOwner) : ribbonScopeId===null ? null : findRequestRibbonState(workspace,ribbonScopeId);
  if (ribbonScopeId && !state) throw new Error('実行対象のリクエストまたはリボンが削除・変更されました。');
  return {ribbonScopeId:state?.id || null,ribbons:clone(state?.ribbons || []),activeRibbonId:state?.activeRibbonId || '',ribbonBindings:clone(state?.ribbonBindings || {})};
}

export function makeScriptContext(workspace, primary, {input,scriptId,tab,ribbonOwner=tab,ribbonScopeId,result,environmentId=workspace.environmentId}={}) {
  const view={...workspace,environmentId};
  const context=contextFor(view,tab || {request:newRequest()},primary.rows);
  return {
    ...scriptRibbonSnapshot(workspace,{ribbonOwner,ribbonScopeId}),
    input,scriptId,scripts:clone(workspace.scripts || []),bindings:clone(workspace.scriptBindings || {}),bindingId:tab?.request?._minipost?.scriptBindingId,data:clone(workspace.scriptData || {}),
    variables:context.vars,primary:primary.snapshot(),environment:valueMap(context.environment?.values),globals:valueMap(workspace.globals),
    request:tab ? clone(tab.request) : null,response:responseMetadata(result),raw:result
  };
}

export function scriptRequestCatalog(workspace) {
  const entries=[];
  for(const collection of workspace.collections || []) walkItems(collection.item,(item,parents)=>{
    if(!item.request)return;
    entries.push({id:`${collection._mpId}:${item._mpId}`,name:item.name,path:[collection.info.name,...parents.map(p=>p.name),item.name].join(' / '),
      collectionId:collection._mpId,itemId:item._mpId,request:clone(item.request),settings:clone(item.settings || {})});
  });
  for(const tab of workspace.tabs || []) {
    const saved=tab.collectionId&&tab.itemId&&entries.find(entry=>entry.collectionId===tab.collectionId&&entry.itemId===tab.itemId);
    if(saved){saved.request=clone(tab.request);saved.settings=clone(tab.settings || {});continue;}
    entries.push({id:`draft:${tab.id}`,draftId:tab.id,name:tab.name,path:tab.name,request:clone(tab.request),settings:clone(tab.settings || {})});
  }
  return entries;
}

function resolve(entries, reference, label) {
  const key=typeof reference==='object'&&reference!==null?reference.id:reference;
  if(typeof key!=='string'||!key)throw new Error(`${label}のIDまたは名前を指定してください。`);
  const exact=entries.find(entry=>entry.id===key);
  if(exact)return exact;
  const matches=entries.filter(entry=>entry.name===key||entry.path===key||entry.itemId===key||entry.draftId===key);
  if(matches.length>1)throw new Error(`「${key}」は複数あります。${label}のIDを指定してください。`);
  if(!matches.length)throw new Error(`${label}がありません: ${key}`);
  return matches[0];
}

export function createScriptHost({workspace,primary,environmentId=workspace.environmentId,filesFor=()=>({}),onResponse=()=>{},send=sendThroughProxy}) {
  // One run sees a consistent catalog. Variable snapshots supplied by the worker
  // include its pending writes without committing them to the live workspace.
  const snapshot=clone(workspace),catalog=scriptRequestCatalog(snapshot);
  return async function call(method,args=[],{signal,variables}={}) {
    if(signal?.aborted)throw new DOMException('スクリプトを停止しました。','AbortError');
    const [reference,options={}]=args;
    if(method==='workspace.read')return clone(snapshot);
    if(method==='requests.list')return catalog.map(({request,settings,...entry})=>clone(entry));
    if(method==='requests.get')return clone(resolve(catalog,reference,'リクエスト'));
    if(method==='environments.list')return snapshot.environments.map(({id,name})=>({id,name}));
    if(method==='environments.get')return clone(resolve(snapshot.environments,reference,'環境'));
    if(method!=='requests.send')throw new Error(`利用できないAPIです: ${method}`);
    if(options===null||typeof options!=='object'||Array.isArray(options))throw new Error('送信オプションはオブジェクトで指定してください。');
    let entry;
    if(reference&&typeof reference==='object'&&('url' in reference||'request' in reference)) {
      const saved=catalog.find(item=>item.id===reference.id);
      entry={...saved,id:saved?.id||uid(),name:reference.name||saved?.name||'Script request',request:normalizeRequest(reference.request || reference),settings:clone(reference.settings || saved?.settings || {})};
    }else entry=resolve(catalog,reference,'リクエスト');
    const selected=options.environmentId ?? environmentId;
    if(selected&&!snapshot.environments.some(env=>env.id===selected))throw new Error('送信に使用する環境がありません。');
    const view=clone(snapshot);view.environmentId=selected;
    const env=view.environments.find(item=>item.id===environmentId);
    if(variables){view.globals=variableRows(variables.globals);if(env)env.values=variableRows(variables.environment);}
    const tab={id:entry.draftId || entry.itemId || entry.id,name:entry.name,collectionId:entry.collectionId,itemId:entry.itemId,
      request:normalizeRequest(entry.request),settings:{...entry.settings,...options.settings}};
    // History reopens this target, so retain its canonical ribbon snapshot too.
    const ribbonState=getRequestRibbonState(snapshot,tab);
    if(ribbonState)tab.ribbonState=clone(ribbonState);
    const attachments=await filesFor(tab,signal);
    if(signal?.aborted)throw new DOMException('スクリプトを停止しました。','AbortError');
    const compiled=compileRequest(view,tab,attachments,variables?variableRows(variables.primary):primary.rows);
    const result=await send(compiled.payload,signal);
    if(signal?.aborted)throw new DOMException('スクリプトを停止しました。','AbortError');
    if(result.error)throw new Error(result.error);
    result.received_at=new Date().toISOString();
    onResponse(tab,result,selected);
    // An explicit send sends once. Request UI hooks do not recursively run here.
    return responseMetadata(result);
  };
}

export function formatScriptValue(value) {
  if(value===undefined)return '戻り値なし';
  if(typeof value==='string')return value;
  const ancestors=new WeakSet();
  function represent(current){
    if(typeof current==='bigint')return `${current}n`;
    if(current===undefined)return '[undefined]';
    if(typeof current==='number'&&!Number.isFinite(current))return String(current);
    if(current===null||typeof current!=='object')return current;
    if(ancestors.has(current))return '[循環参照]';
    ancestors.add(current);
    try {
      if(current instanceof Date)return current.toJSON();
      if(current instanceof RegExp)return String(current);
      if(current instanceof Map)return {type:'Map',entries:[...current].map(represent)};
      if(current instanceof Set)return {type:'Set',values:[...current].map(represent)};
      if(ArrayBuffer.isView(current))return {type:current.constructor.name,values:Array.from(current instanceof DataView?new Uint8Array(current.buffer,current.byteOffset,current.byteLength):current,represent)};
      if(current instanceof ArrayBuffer)return {type:'ArrayBuffer',values:Array.from(new Uint8Array(current))};
      if(Array.isArray(current))return current.map(represent);
      return Object.fromEntries(Object.entries(current).map(([key,item])=>[key,represent(item)]));
    }finally{ancestors.delete(current);}
  }
  return JSON.stringify(represent(value),null,2) ?? String(value);
}
