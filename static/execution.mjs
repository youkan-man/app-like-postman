/** Request execution orchestrates pure compilation, isolated scripts and HTTP I/O. */
import {clone,contextFor,compileRequest} from './core.mjs';
import {requestAutomation,responseMetadata,extractionWrites,PrimaryVariables} from './runtime.mjs';
import {applyScriptWrites} from './scripts.mjs';
import {applyRequestMutation,applyResponseMutation} from './script-response.mjs';
import {throwIfAborted} from './relations.mjs';
import {runScript} from './script-runner.mjs';
import {scriptRibbonSnapshot} from './script-host.mjs';
import {sendThroughProxy} from './transport.mjs';
import {copyAttachments,remapScriptAttachments} from './request-files.mjs';
const valueMap=rows=>Object.fromEntries((rows||[]).filter(r=>r.key&&r.disabled!==true&&r.enabled!==false).map(r=>[r.key,r.value]));
export async function executeRequest({workspace,tab,files={},primary,environmentId=workspace.environmentId,signal,
  send=sendThroughProxy,script=runScript,onVariables=()=>{},onScript=()=>{},onProgress,scriptCall,onScriptLog}) {
  throwIfAborted(signal);
  const snapshot=clone(tab),view={...workspace,environmentId},automation=requestAutomation(snapshot.request),scripts=clone(workspace.scripts||[]),bindings=clone(workspace.scriptBindings||{});
  const ribbonScopeId=scriptRibbonSnapshot(workspace,{ribbonOwner:tab}).ribbonScopeId;
  let attachments=copyAttachments(typeof files?.then==='function'?await files:files);throwIfAborted(signal);
  const environment=workspace.environments.find(e=>e.id===environmentId);
  async function run(source,result,phase,preview=[]) {
    if(!automation.enabled)return;
    const scriptId=automation[`${phase}ScriptId`];
    try {
      let timeoutMs=automation.timeoutMs;
      if(scriptId){const saved=scripts.find(item=>item.id===scriptId);if(!saved)throw new Error(`スクリプトが見つかりません: ${scriptId}`);source=saved.source;timeoutMs=saved.timeoutMs;}
      if(!source.trim())return;
      onProgress?.({phase:phase==='before'?'script':'processing'});
      const previewRows=preview.map(row=>({key:row.key,value:row.value}));
      const ctx=contextFor(view,snapshot,[...primary.rows,...previewRows]),metadata=responseMetadata(result);
      const output=await script(source,{variables:ctx.vars,primary:{...primary.snapshot(),...Object.fromEntries(previewRows.map(row=>[row.key,row.value]))},environment:valueMap(environment?.values),globals:valueMap(workspace.globals),request:snapshot.request,response:metadata,raw:result,
        ...scriptRibbonSnapshot(workspace,{ribbonScopeId}),
        scripts:clone(scripts),bindings:clone(bindings),bindingId:automation.scriptBindingId,data:clone(workspace.scriptData||{}),scriptId,input:phase==='before'?clone(snapshot.request):metadata},
      {signal,timeoutMs,onCall:scriptCall,onLog:entry=>onScriptLog?.({phase,...entry})});
      throwIfAborted(signal);
      const changedRequest=Object.hasOwn(output,'request')?applyRequestMutation(snapshot.request,output.request):snapshot.request;
      if(phase!=='before'&&Object.hasOwn(output,'request'))throw new Error('送信後のリクエストは変更できません。送信前スクリプトで変更してください。');
      const changedAttachments=Object.hasOwn(output,'request')?remapScriptAttachments(snapshot.request,changedRequest,attachments,output.attachmentRows):attachments;
      const changedResponse=Object.hasOwn(output,'response')?applyResponseMutation(result,output.response):result;
      let changes=output;
      if(phase==='after'){
        // The preview is read-only context for existing scripts. Only extraction
        // from the processed response is committed; explicit script writes win.
        const extracted=extractionWrites(automation.extractions,responseMetadata(changedResponse));
        changes={...output,writes:{...output.writes,primary:[...extracted,...(output.writes?.primary||[])]}};
      }else if(Object.hasOwn(output,'request')){
        // Compile against staged variable writes before changing any live state.
        const staged={...view,collections:clone(workspace.collections||[]),tabs:clone(workspace.tabs||[]),globals:clone(workspace.globals),scriptData:clone(workspace.scriptData||{}),
          environments:workspace.environments.map(item=>({...item,values:clone(item.values)}))};
        const stagedPrimary=new PrimaryVariables();stagedPrimary.rows=clone(primary.rows);
        applyScriptWrites(staged,stagedPrimary,staged.environments.find(item=>item.id===environmentId),changes);
        compileRequest(staged,{...snapshot,request:changedRequest},changedAttachments,stagedPrimary.rows);
      }
      onVariables(applyScriptWrites(workspace,primary,environment,changes));
      if(phase==='before'){snapshot.request=changedRequest;attachments=changedAttachments;}
      onScript({phase,logs:output.logs,result:output.result,error:null});
      return changedResponse;
    } catch(error){onScript({phase,logs:error.logs||[],error:error.message});throw error;}
  }
  await run(automation.before,null,'before');
  throwIfAborted(signal);
  const compiled=compileRequest(view,snapshot,attachments,primary.rows);
  const received=await send(compiled.payload,signal,onProgress);throwIfAborted(signal);
  let result={...received,received_at:new Date().toISOString(),automationErrors:[]},preview=[];
  try {preview=extractionWrites(automation.extractions,responseMetadata(result));}catch{}
  try {
    const processed=await run(automation.after,result,'after',preview);
    if(processed)return processed;
  }
  catch(error){if(error.name==='AbortError')throw error;result.automationErrors.push(error.message);}
  try {primary.apply(extractionWrites(automation.extractions,responseMetadata(result)));onVariables(false);}
  catch(error){if(!result.automationErrors.includes(error.message))result.automationErrors.push(error.message);}
  return result;
}
