/** Editing snapshots contain data shapes and catalog names; analysis never runs code. */
import {contextFor,enabled,newRequest,walkItems} from './core.mjs';
import {getRequestRibbonState} from './ribbons.mjs';

const names=values=>Object.fromEntries((values||[]).filter(row=>row.key&&enabled(row)).map(row=>[row.key,'']));

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

function catalog(workspace) {
  const entries=[];
  for(const collection of workspace.collections||[])walkItems(collection.item,(item,parents)=>{
    if(item.request)entries.push({id:`${collection._mpId}:${item._mpId}`,name:item.name,path:[collection.info.name,...parents.map(parent=>parent.name),item.name].join(' / '),
      collectionId:collection._mpId,itemId:item._mpId,request:requestShape(item.request),settings:requestShape(item.settings||{})});
  });
  for(const tab of workspace.tabs||[]){
    const entry=tab.collectionId&&tab.itemId&&entries.find(item=>item.collectionId===tab.collectionId&&item.itemId===tab.itemId);
    if(entry){entry.request=requestShape(tab.request);entry.settings=requestShape(tab.settings||{});}
    else entries.push({id:`draft:${tab.id}`,draftId:tab.id,name:tab.name,path:tab.name,request:requestShape(tab.request),settings:requestShape(tab.settings||{})});
  }
  return entries;
}

export function scriptEditorContext(workspace,primary,{script,tab,ribbonOwner=tab,result,phase}={}) {
  const current=tab||{request:newRequest()},view=contextFor(workspace,current,primary?.rows||[]),ribbonState=getRequestRibbonState(workspace,ribbonOwner);
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
    request:tab?requestShape(tab.request):null,
    requests:catalog(workspace),
    environments:(workspace.environments||[]).map(environment=>({id:environment.id,name:environment.name,
      values:(environment.values||[]).map(row=>({...requestShape(row),key:row.key}))}))
  };
  if(script){context.inputSource=script.input;context.inputFormat=script.inputFormat;}
  if(phase)context.phase=phase;
  if(phase!=='before'&&result&&!result.error){
    // JSON decoding stays in the language Worker. Binary content is only a string.
    context.rawResponse={status:result.status,status_text:'',elapsed_ms:result.elapsed_ms,size:result.size,url:'',
      content_type:result.content_type,body_encoding:result.body_encoding,received_at:'',
      headers:(result.headers||[]).map(row=>({key:row.key,value:''})),redirects:requestShape(result.redirects||[]),
      body:result.body_encoding==='base64'?'':result.body??''};
  }
  return context;
}
