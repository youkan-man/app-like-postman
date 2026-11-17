/** Request execution orchestrates pure compilation, isolated scripts and HTTP I/O. */
import {clone,contextFor,compileRequest} from './core.mjs';
import {requestAutomation,responseMetadata,extractionWrites} from './runtime.mjs';
import {applyScriptWrites} from './scripts.mjs';
import {throwIfAborted} from './relations.mjs';
import {runScript} from './script-runner.mjs';
import {sendThroughProxy} from './transport.mjs';
import {copyAttachments} from './request-files.mjs';
const valueMap=rows=>Object.fromEntries((rows||[]).filter(r=>r.key&&r.disabled!==true&&r.enabled!==false).map(r=>[r.key,r.value]));
export async function executeRequest({workspace,tab,files={},primary,environmentId=workspace.environmentId,signal,
  send=sendThroughProxy,script=runScript,onVariables=()=>{},onScript=()=>{},onProgress,scriptCall,onScriptLog}) {
  throwIfAborted(signal);
  const snapshot=clone(tab),view={...workspace,environmentId},automation=requestAutomation(snapshot.request),scripts=clone(workspace.scripts||[]);
  const attachments=copyAttachments(typeof files?.then==='function'?await files:files);throwIfAborted(signal);
  const environment=workspace.environments.find(e=>e.id===environmentId);
  async function run(source,result,phase) {
    if(!automation.enabled)return;
    const scriptId=automation[`${phase}ScriptId`];
    try {
      let timeoutMs=automation.timeoutMs;
      if(scriptId){const saved=scripts.find(item=>item.id===scriptId);if(!saved)throw new Error(`スクリプトが見つかりません: ${scriptId}`);source=saved.source;timeoutMs=saved.timeoutMs;}
      if(!source.trim())return;
      onProgress?.({phase:phase==='before'?'script':'processing'});
      const ctx=contextFor(view,snapshot,primary.rows),metadata=responseMetadata(result);
      const output=await script(source,{variables:ctx.vars,primary:primary.snapshot(),environment:valueMap(environment?.values),globals:valueMap(workspace.globals),request:snapshot.request,response:metadata,raw:result,
        scripts:clone(scripts),data:clone(workspace.scriptData||{}),scriptId,input:phase==='before'?clone(snapshot.request):metadata},
      {signal,timeoutMs,onCall:scriptCall,onLog:entry=>onScriptLog?.({phase,...entry})});
      throwIfAborted(signal);
      onVariables(applyScriptWrites(workspace,primary,environment,output));onScript({phase,logs:output.logs,result:output.result,error:null});
    } catch(error){onScript({phase,logs:error.logs||[],error:error.message});throw error;}
  }
  await run(automation.before,null,'before');
  throwIfAborted(signal);
  const compiled=compileRequest(view,snapshot,attachments,primary.rows);
  const result=await send(compiled.payload,signal,onProgress);throwIfAborted(signal);
  result.received_at=new Date().toISOString();result.automationErrors=[];
  try {primary.apply(extractionWrites(automation.extractions,responseMetadata(result)));onVariables(false);}
  catch(error){result.automationErrors.push(error.message);}
  try {await run(automation.after,result,'after');}
  catch(error){if(error.name==='AbortError')throw error;result.automationErrors.push(error.message);}
  return result;
}
