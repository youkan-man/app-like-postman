/** Editing snapshots contain data shapes and catalog names; analysis never runs code. */
import {contextFor,enabled,newRequest,walkItems} from './core.mjs';
import {getRequestRibbonState} from './ribbons.mjs';
import {relationRequestEntries} from './relation-requests.mjs';

const names=values=>Object.fromEntries((values||[]).filter(row=>row.key&&enabled(row)).map(row=>[row.key,'']));
const jsonShapes=new WeakMap(),JSON_SHAPE_NODES=16000,JSON_SOURCE_LIMIT=1024*1024;

/** Cache only sanitized JSON shapes. Large bodies stay unknown to keep typing responsive. */
function requestJSONReader() {
  let remaining=JSON_SHAPE_NODES;
  const included=new WeakSet();
  return request=>{
    if(!request||typeof request!=='object')return {};
    const mode=request.body?.mode,source=request.body?.raw;
    let cached=jsonShapes.get(request);
    if(!cached||cached.mode!==mode||cached.source!==source){
      let count=0,result={};
      function shape(value,depth=0){
        if(++count>JSON_SHAPE_NODES||depth>48)throw new RangeError('JSON shape limit');
        if(value===null)return null;
        if(typeof value==='string')return '';
        if(typeof value==='number')return 0;
        if(typeof value==='boolean')return false;
        if(Array.isArray(value))return value.map(item=>shape(item,depth+1));
        return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,shape(item,depth+1)]));
      }
      if(mode==='raw'&&typeof source==='string'&&source.length<=JSON_SOURCE_LIMIT){
        if(!source.trim())result={requestJSON:undefined};
        else try{result={requestJSON:shape(JSON.parse(source))};}catch{/* Invalid or oversized shapes remain unknown. */}
      }else if(mode!=='raw'||typeof source!=='string')result={requestJSON:undefined};
      cached={mode,source,result,count};jsonShapes.set(request,cached);
    }
    if(!Object.hasOwn(cached.result,'requestJSON'))return {};
    if(!included.has(cached)){
      if(cached.count>remaining)return {};
      remaining-=cached.count;included.add(cached);
    }
    return cached.result;
  };
}

/** Request fields only need their types. Do not copy bodies, credentials or files. */
function requestShape(value,seen=new WeakMap()) {
  if(value===null||value===undefined)return value;
  if(typeof value==='string')return '';
  if(typeof value==='number')return 0;
  if(typeof value==='boolean')return false;
  if(typeof value!=='object')return undefined;
  if(seen.has(value))return seen.get(value);
  const result=Array.isArray(value)?[]:{};seen.set(value,result);
  for(const key of Object.keys(value))Object.defineProperty(result,key,{value:requestShape(value[key],seen),writable:true,enumerable:true,configurable:true});
  return result;
}
function requestSnapshot(request){const snapshot=requestShape(request);if(request?.type==='relation')snapshot.type='relation';else if(request?.type==='http')snapshot.type='http';return snapshot;}

function catalog(workspace,jsonShape) {
  const entries=[];
  for(const collection of workspace.collections||[])walkItems(collection.item,(item,parents)=>{
    if(item.request)entries.push({id:`${collection._mpId}:${item._mpId}`,name:item.name,path:[collection.info.name,...parents.map(parent=>parent.name),item.name].join(' / '),
      collectionId:collection._mpId,itemId:item._mpId,parentId:parents.length?`${collection._mpId}:${parents.at(-1)._mpId}`:collection._mpId,request:requestSnapshot(item.request),settings:requestShape(item.settings||{}),...jsonShape(item.request)});
  });
  for(const tab of workspace.tabs||[]){
    const entry=tab.collectionId&&tab.itemId&&entries.find(item=>item.collectionId===tab.collectionId&&item.itemId===tab.itemId);
    if(entry){entry.request=requestSnapshot(tab.request);entry.settings=requestShape(tab.settings||{});delete entry.requestJSON;Object.assign(entry,jsonShape(tab.request));}
    else entries.push({id:`draft:${tab.id}`,draftId:tab.id,name:tab.name,path:tab.name,request:requestSnapshot(tab.request),settings:requestShape(tab.settings||{}),...jsonShape(tab.request)});
  }
  return entries;
}

export function scriptEditorContext(workspace,primary,{script,tab,ribbonOwner=tab,result,phase}={}) {
  const current=tab||{request:newRequest()},view=contextFor(workspace,current,primary?.rows||[]),ribbonState=getRequestRibbonState(workspace,ribbonOwner);
  const jsonShape=requestJSONReader(),currentJSON=jsonShape(tab?.request),requests=catalog(workspace,jsonShape),folders=[];
  for(const collection of workspace.collections||[])walkItems(collection.item,(item,parents)=>{
    if(Array.isArray(item.item))folders.push({id:`${collection._mpId}:${item._mpId}`,collectionId:collection._mpId,itemId:item._mpId,
      parentId:parents.length?`${collection._mpId}:${parents.at(-1)._mpId}`:collection._mpId,name:item.name,
      path:[collection.info.name,...parents.map(parent=>parent.name),item.name].join(' / ')});
  });
  const context={
    scriptId:script?.id,
    scripts:(workspace.scripts||[]).map(item=>({id:item.id,name:item.name,source:item.id===script?.id?'':item.source,input:item.input,inputFormat:item.inputFormat,bindingId:item.bindingId})),
    bindings:workspace.scriptBindings||{},bindingId:tab?.request?._minipost?.scriptBindingId,
    data:workspace.scriptData||{},
    ribbonScopeId:ribbonState?.id||null,activeRibbonId:ribbonState?.activeRibbonId||'',ribbonBindings:ribbonState?.ribbonBindings||{},
    ribbons:(ribbonState?.ribbons||[]).map(ribbon=>({id:ribbon.id,key:ribbon.key,name:ribbon.name,
      groups:(ribbon.groups||[]).map(group=>({id:group.id,name:group.name,controls:(group.controls||[]).map(control=>({
        id:control.id,key:control.key,label:control.label,type:control.type,value:requestShape(control.value)
      }))}))})),
    variables:Object.fromEntries(Object.keys(view.vars).map(key=>[key,''])),
    primary:names(primary?.rows),environment:names(view.environment?.values),globals:names(workspace.globals),
    request:tab?requestSnapshot(tab.request):null,
    ...currentJSON,
    requests,folders,drafts:requests.filter(item=>item.draftId),
    collections:(workspace.collections||[]).map(item=>({id:item._mpId,name:item.info.name})),
    relations:relationRequestEntries(workspace).map(entry=>({id:entry.relation.id,name:entry.owner.name,
      ...(entry.collectionId?{requestId:`${entry.collectionId}:${entry.itemId}`,itemId:entry.itemId}:entry.draftId?{requestId:`draft:${entry.draftId}`,draftId:entry.draftId}:{})})),
    environments:(workspace.environments||[]).map(environment=>({id:environment.id,name:environment.name,
      values:(environment.values||[]).map(row=>({...requestShape(row),key:row.key}))}))
  };
  if(script){context.inputSource=script.input;context.inputFormat=script.inputFormat;}
  if(phase)context.phase=phase;
  if(phase!=='before'&&result&&!result.error){
    // JSON decoding stays in the language Worker. Binary content is only a string.
    context.rawResponse=result.type==='relation'?{type:'relation',run:requestShape(result.run),elapsed_ms:result.elapsed_ms,received_at:''}:{status:result.status,status_text:'',elapsed_ms:result.elapsed_ms,size:result.size,url:'',
      content_type:result.content_type,body_encoding:result.body_encoding,received_at:'',
      headers:(result.headers||[]).map(row=>({key:row.key,value:''})),redirects:requestShape(result.redirects||[]),
      body:result.body_encoding==='base64'?'':result.body??''};
  }
  return context;
}
