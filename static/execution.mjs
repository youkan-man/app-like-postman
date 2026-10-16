/** Request execution orchestrates pure compilation, isolated scripts and HTTP I/O. */
import {clone,contextFor,compileRequest} from './core.mjs';
import {requestAutomation,responseMetadata,extractionWrites,upsertVariable,checkName} from './runtime.mjs';
import {throwIfAborted} from './relations.mjs';
import {runScript} from './script-runner.mjs';
import {sendThroughProxy} from './transport.mjs';
const valueMap=rows=>Object.fromEntries((rows||[]).filter(r=>r.key&&r.disabled!==true&&r.enabled!==false).map(r=>[r.key,r.value]));
export async function executeRequest({workspace,tab,files={},primary,environmentId=workspace.environmentId,signal,
  send=sendThroughProxy,script=runScript,onVariables=()=>{},onScript=()=>{}}) {
  throwIfAborted(signal);
  const snapshot=clone(tab),view={...workspace,environmentId},automation=requestAutomation(snapshot.request);
  const environment=workspace.environments.find(e=>e.id===environmentId);
  async function run(source,result,phase) {
    if(!automation.enabled||!source.trim())return;
    const ctx=contextFor(view,snapshot,primary.rows);
    try {
      const output=await script(source,{variables:ctx.vars,primary:primary.snapshot(),environment:valueMap(environment?.values),globals:valueMap(workspace.globals),request:snapshot.request,response:responseMetadata(result),raw:result},{signal,timeoutMs:automation.timeoutMs});
      throwIfAborted(signal);
      const writes=output.writes;
      if(writes.environment.length&&!environment)throw new Error('環境を書き換えるには環境を選択してください。');
      for(const list of Object.values(writes))for(const row of list)checkName(row.key);
      const update=(list,changes)=>{for(const row of changes){if(row.remove){for(let i=list.length-1;i>=0;i--)if(list[i].key===row.key)list.splice(i,1);}else upsertVariable(list,row.key,row.value);}};
      primary.apply(writes.primary);
      if(environment)update(environment.values,writes.environment);
      update(workspace.globals,writes.globals);
      onVariables(Boolean(writes.environment.length||writes.globals.length));onScript({phase,logs:output.logs,error:null});
    } catch(error){onScript({phase,logs:error.logs||[],error:error.message});throw error;}
  }
  await run(automation.before,null,'before');
  throwIfAborted(signal);
  const compiled=compileRequest(view,snapshot,files,primary.rows);
  const result=await send(compiled.payload,signal);throwIfAborted(signal);
  result.received_at=new Date().toISOString();result.automationErrors=[];
  try {primary.apply(extractionWrites(automation.extractions,responseMetadata(result)));onVariables(false);}
  catch(error){result.automationErrors.push(error.message);}
  try {await run(automation.after,result,'after');}
  catch(error){if(error.name==='AbortError')throw error;result.automationErrors.push(error.message);}
  return result;
}
