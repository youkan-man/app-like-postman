/** App capabilities available to scripts. Execution does not depend on an open request. */
import {clone,uid,rows,enabled,walkItems,normalizeRequest,compileRequest,contextFor,newRequest,isRelationRequest} from './core.mjs';
import {responseMetadata,upsertVariable} from './runtime.mjs';
import {sendThroughProxy} from './transport.mjs';
import {getRequestRibbonState,findRequestRibbonState} from './ribbons.mjs';
import {createWorkspaceModel,workspaceChanges} from './workspace-api.mjs';
import {relationForRequest,findRelationRequest} from './relation-requests.mjs';

const valueMap = values => Object.fromEntries(rows(values).filter(row => row.key && enabled(row)).map(row => [row.key,row.value]));
const variableRows = values => Object.entries(values || {}).map(([key,value]) => ({key,value,enabled:true}));
export function scriptRequestReference(tab) {return tab?.collectionId&&tab?.itemId ? `${tab.collectionId}:${tab.itemId}` : tab?.id ? `draft:${tab.id}` : null;}

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
  const ribbonSnapshot=scriptRibbonSnapshot(workspace,{ribbonOwner,ribbonScopeId});
  const catalog=scriptRequestCatalog(workspace,{preferCanonical:true}),references=new Set(catalog.map(entry=>entry.id));
  const existingReference=value=>{const reference=scriptRequestReference(value);return references.has(reference)?reference:null;};
  let ownerReference=existingReference(ribbonOwner);
  if(ribbonSnapshot.ribbonScopeId){
    // UI actions and nested relations capture the durable scope ID without an
    // open request tab. Resolve its canonical owner before entering the Worker.
    const owners=catalog.filter(entry=>getRequestRibbonState(workspace,{...entry,id:entry.draftId||entry.id})?.id===ribbonSnapshot.ribbonScopeId);
    if(owners.length!==1)throw new Error('リボンの実行先リクエストが見つからないか、重複しています。');
    ownerReference=owners[0].id;
  }
  return {
    ...ribbonSnapshot,
    workspace:clone(workspace),environmentId:environmentId || '',requestRef:existingReference(tab),ribbonOwnerRef:ownerReference,
    variableContext:tab?clone({collectionId:tab.collectionId,pendingFolderId:tab.pendingFolderId,request:tab.request}):null,
    input,scriptId,scripts:clone(workspace.scripts || []),bindings:clone(workspace.scriptBindings || {}),bindingId:tab?.request?._minipost?.scriptBindingId,data:clone(workspace.scriptData || {}),
    variables:context.vars,primary:primary.snapshot(),primaryRows:clone(primary.rows || variableRows(primary.snapshot())),environment:valueMap(context.environment?.values),globals:valueMap(workspace.globals),
    request:tab ? clone(tab.request) : null,response:responseMetadata(result),raw:result
  };
}

export function scriptRequestCatalog(workspace,{preferCanonical=false}={}) {
  const entries=[];
  for(const collection of workspace.collections || []) walkItems(collection.item,(item,parents)=>{
    if(!item.request)return;
    entries.push({id:`${collection._mpId}:${item._mpId}`,name:item.name,path:[collection.info.name,...parents.map(p=>p.name),item.name].join(' / '),
      collectionId:collection._mpId,itemId:item._mpId,request:clone(item.request),settings:clone(item.settings || {})});
  });
  for(const tab of workspace.tabs || []) {
    const saved=tab.collectionId&&tab.itemId&&entries.find(entry=>entry.collectionId===tab.collectionId&&entry.itemId===tab.itemId);
    if(saved){if(!preferCanonical){saved.request=clone(tab.request);saved.settings=clone(tab.settings || {});}continue;}
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

export function createScriptHost({workspace,primary,environmentId=workspace.environmentId,requestRef=null,filesFor=()=>({}),getResponses=()=>[],runRelation,onResponse=()=>{},send=sendThroughProxy}) {
  // One run sees a consistent catalog. Variable snapshots supplied by the worker
  // include its pending writes without committing them to the live workspace.
  const snapshot=clone(workspace),originalCatalog=scriptRequestCatalog(snapshot),responses=clone(getResponses() || []);
  return async function call(method,args=[],{signal,variables,primaryRows:callerPrimaryRows,workspace:pending,requestRef:callerRequestRef=requestRef,ribbonScopeId}={}) {
    if(signal?.aborted)throw new DOMException('スクリプトを停止しました。','AbortError');
    const source=pending || snapshot,catalog=pending?scriptRequestCatalog(source,{preferCanonical:true}):originalCatalog;
    const [reference,options={}]=args;
    if(method==='workspace.read')return clone(source);
    if(method==='requests.list')return catalog.map(({request,settings,...entry})=>clone(entry));
    if(method==='requests.get')return clone(resolve(catalog,reference,'リクエスト'));
    if(method==='environments.list')return (source.environments || []).map(({id,name})=>({id,name}));
    if(method==='environments.get')return clone(resolve(source.environments || [],reference,'環境'));
    if(method==='responses.list')return clone(responses);
    if(method==='responses.get'){
      const key=reference??callerRequestRef;if(!key)return null;
      const matches=responses.filter(value=>value.id===key||value.requestId===key||value.name===key);
      if(matches.length>1)throw new Error('レスポンスが複数あります。IDで指定してください。');
      return matches.length?clone(matches[0]):null;
    }
    if(method==='attachments.list'||method==='attachments.read'){
      const entry=resolve(catalog,reference??callerRequestRef,'リクエスト');
      const tab={id:entry.draftId||entry.itemId,collectionId:entry.collectionId,itemId:entry.itemId,name:entry.name,request:normalizeRequest(entry.request),settings:entry.settings};
      const files=await filesFor(tab,signal);if(signal?.aborted)throw new DOMException('スクリプトを停止しました。','AbortError');
      const list=Object.entries(files||{}).flatMap(([slot,values])=>(Array.isArray(values)?values:[]).map((file,index)=>({slot,index,name:file.name||file.blob?.name||'',type:file.type||file.blob?.type||'',size:file.size??file.blob?.size??0,lastModified:file.lastModified??file.blob?.lastModified??0})));
      if(method==='attachments.list')return list;
      const [,slot,index=0,readOptions={}]=args;
      if(!readOptions||typeof readOptions!=='object'||Array.isArray(readOptions))throw new TypeError('読取オプションはオブジェクトで指定してください。');
      const {format='text',maxBytes=10485760}=readOptions;
      if(!['text','base64','bytes'].includes(format)||!Number.isSafeInteger(index)||index<0||!Number.isSafeInteger(maxBytes)||maxBytes<0)throw new TypeError('ファイルの読取形式・範囲が不正です。');
      const file=files?.[slot]?.[index],blob=file?.blob||file;
      if(!blob||typeof blob.arrayBuffer!=='function')throw new Error('選択済みファイルがありません。');
      if(blob.size>maxBytes)throw new Error(`ファイルが読取上限 ${maxBytes} bytes を超えています。`);
      const bytes=new Uint8Array(await blob.arrayBuffer());if(signal?.aborted)throw new DOMException('スクリプトを停止しました。','AbortError');
      if(format==='bytes')return Array.from(bytes);
      if(format==='text')return new TextDecoder().decode(bytes);
      let binary='';for(let at=0;at<bytes.length;at+=8192)binary+=String.fromCharCode(...bytes.subarray(at,at+8192));return btoa(binary);
    }
    async function invokeRelation(relation,entry){
      if(typeof runRelation!=='function')throw new Error('この実行環境ではリレーションを実行できません。');
      if(!options||typeof options!=='object'||Array.isArray(options))throw new TypeError('実行オプションはオブジェクトで指定してください。');
      const staged=clone(source),before=clone(staged),selected=options.environmentId??(relation.environmentId||environmentId),began=Date.now();
      if(selected&&!(staged.environments||[]).some(value=>value.id===selected))throw new Error('実行に使用する環境がありません。');
      const saved=findRelationRequest(staged,relation.id);
      const owner=entry?{...entry,id:entry.draftId||entry.itemId||entry.id}:saved?.request?{...saved.owner,id:saved.draftId||saved.itemId,collectionId:saved.collectionId,itemId:saved.itemId}:null;
      const ownerRef=owner?scriptRequestReference(owner):callerRequestRef;
      const ownerScope=owner?scriptRibbonSnapshot(staged,{ribbonOwner:owner}).ribbonScopeId:ribbonScopeId;
      const originalPrimary=clone(variables?.primary||primary.snapshot()),initialPrimary=clone(originalPrimary);
      const originalPrimaryRows=clone(callerPrimaryRows || (variables?variableRows(originalPrimary):primary.rows || variableRows(originalPrimary)));
      const result=await runRelation(clone(relation),{workspace:staged,primary:initialPrimary,primaryRows:clone(originalPrimaryRows),signal,environmentId:selected,requestRef:ownerRef,ribbonScopeId:ownerScope,...(owner?{ownerTab:owner}:{})});
      if(signal?.aborted)throw new DOMException('スクリプトを停止しました。','AbortError');
      createWorkspaceModel(staged).validate();
      const finalPrimary=result?.primary??initialPrimary,primaryWrites=[];
      for(const key of new Set([...Object.keys(originalPrimary),...Object.keys(finalPrimary)]))if(!Object.hasOwn(finalPrimary,key))primaryWrites.push({key,remove:true});else if(finalPrimary[key]!==originalPrimary[key])primaryWrites.push({key,value:finalPrimary[key]});
      const primaryExpected=primaryWrites.map(({key})=>({key,exists:Object.hasOwn(originalPrimary,key),...(Object.hasOwn(originalPrimary,key)?{value:originalPrimary[key]}:{})}));
      const finalPrimaryRows=clone(result?.primaryRows || originalPrimaryRows);
      if(!result?.primaryRows)for(const row of primaryWrites){if(row.remove){for(let at=finalPrimaryRows.length-1;at>=0;at--)if(finalPrimaryRows[at].key===row.key)finalPrimaryRows.splice(at,1);}else upsertVariable(finalPrimaryRows,row.key,row.value);}
      const value=entry?{type:'relation',run:result?.result,elapsed_ms:Date.now()-began,received_at:new Date().toISOString()}:result?.result;
      if(entry)onResponse(owner,value,selected);
      return {__minipostTransaction:true,value,workspaceWrites:workspaceChanges(before,staged),primaryWrites,primaryExpected,
        primaryRowsWrites:workspaceChanges({globals:originalPrimaryRows},{globals:finalPrimaryRows}),logs:result?.logs||[]};
    }
    if(method==='relations.run')return invokeRelation(createWorkspaceModel(source).api.relations.get(reference));
    if(method!=='requests.send')throw new Error(`利用できないAPIです: ${method}`);
    if(options===null||typeof options!=='object'||Array.isArray(options))throw new Error('送信オプションはオブジェクトで指定してください。');
    let entry;
    if(reference&&typeof reference==='object'&&('url' in reference||'request' in reference||reference.type==='relation')) {
      const saved=catalog.find(item=>item.id===reference.id);
      entry={...saved,id:saved?.id||uid(),name:reference.name||saved?.name||'Script request',request:normalizeRequest(reference.request || reference),settings:clone(reference.settings || saved?.settings || {})};
    }else entry=resolve(catalog,reference,'リクエスト');
    if(isRelationRequest(entry.request))return invokeRelation(relationForRequest(clone(entry.request),entry.name),entry);
    const selected=options.environmentId ?? environmentId;
    if(selected&&!(source.environments||[]).some(env=>env.id===selected))throw new Error('送信に使用する環境がありません。');
    const view=clone(source);view.environmentId=selected;
    const env=view.environments.find(item=>item.id===environmentId);
    if(variables){view.globals=variableRows(variables.globals);if(env)env.values=variableRows(variables.environment);}
    const tab={id:entry.draftId || entry.itemId || entry.id,name:entry.name,collectionId:entry.collectionId,itemId:entry.itemId,
      request:normalizeRequest(entry.request),settings:{...entry.settings,...options.settings}};
    // History reopens this target, so retain its canonical ribbon snapshot too.
    const ribbonState=getRequestRibbonState(source,tab);
    if(ribbonState)tab.ribbonState=clone(ribbonState);
    const attachments=await filesFor(tab,signal);
    const previous=originalCatalog.find(value=>value.id===entry.id);
    const fileShape=request=>({mode:request?.body?.mode,binary:request?.body?.binary,file:request?.body?.file,formdata:request?.body?.formdata});
    if(pending&&previous&&JSON.stringify(fileShape(previous.request))!==JSON.stringify(fileShape(tab.request))&&Object.values(attachments||{}).some(value=>Array.isArray(value)&&value.length))throw new Error('スクリプトが添付ファイル欄を変更しました。ファイルを選択し直してから送信してください。');
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
