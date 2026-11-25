/** A script-invoked relation operates on its caller's pending workspace. */
import {clone,contextFor,newRequest,isRelationRequest} from './core.mjs';
import {PrimaryVariables} from './runtime.mjs';
import {runRelation,throwIfAborted} from './relations.mjs';
import {makeScriptContext,createScriptHost,scriptRequestReference,scriptRibbonSnapshot,scriptRequestCatalog} from './script-host.mjs';
import {runScript} from './script-runner.mjs';
import {executeRequest} from './execution.mjs';
import {applyScriptWrites} from './scripts.mjs';
import {relationForRequest} from './relation-requests.mjs';

export function createScriptRelationRunner({filesFor=()=>({}),requestFor=()=>null,onResponse=()=>{},getResponses=()=>[],script=runScript,send,onVariables=()=>{},onScript=()=>{},onScriptLog}={}) {
  async function run(relation,context,ancestors=[]) {
    const {workspace,signal,environmentId=workspace.environmentId||'',requestRef,ribbonScopeId}=context;
    throwIfAborted(signal);
    if(ancestors.includes(relation.id))throw new Error('同じリレーションを再帰的に実行できません。');
    if(ancestors.length>=16)throw new Error('リレーションの呼び出しが深すぎます。');
    const stack=[...ancestors,relation.id],primary=context.primaryState||new PrimaryVariables(),logs=[];
    const ownerTab=context.ownerTab||scriptRequestCatalog(workspace,{preferCanonical:true}).find(entry=>entry.id===requestRef);
    if(!context.primaryState){
      if(Array.isArray(context.primaryRows))primary.rows=clone(context.primaryRows);
      else primary.apply(Object.entries(context.primary||{}).map(([key,value])=>({key,value})));
    }
    const nested=(next,options)=>run(next,options,stack);
    const host=()=>createScriptHost({workspace,primary,environmentId,requestRef,filesFor,onResponse,getResponses,runRelation:nested,...(send?{send}:{})});
    const environment=()=>workspace.environments?.find(item=>item.id===environmentId);
    const rememberLogs=output=>{for(const entry of output.logs||[])logs.push(clone(entry));onScript(output);};
    const result=await runRelation(relation,{
      workspace,signal,environmentId,onProgress:context.onProgress,primary:()=>primary.snapshot(),
      writePrimary:writes=>{primary.apply(writes);onVariables(false);},
      capturePrimary:keys=>{const restore=primary.capture(keys);return ()=>{restore();onVariables(false);};},
      variables:tab=>contextFor({...workspace,environmentId},tab||ownerTab||{request:newRequest()},primary.rows).vars,
      execute:async(tab,{signal})=>{
        if(isRelationRequest(tab.request)){
          const definition=relationForRequest(tab.request,tab.name),selected=definition.environmentId||environmentId,began=Date.now();
          if(selected&&!(workspace.environments||[]).some(item=>item.id===selected))throw new Error('実行に使用する環境がありません。');
          const output=await run(definition,{workspace,signal,environmentId:selected,primaryState:primary,ownerTab:tab,
            requestRef:scriptRequestReference(tab),ribbonScopeId:scriptRibbonSnapshot(workspace,{ribbonOwner:tab}).ribbonScopeId,captureFailure:true},stack);
          logs.push(...output.logs.map(clone));
          const response={type:'relation',run:output.result,elapsed_ms:Date.now()-began,received_at:new Date().toISOString()};
          onResponse(tab,response,selected);return response;
        }
        const files=await filesFor(tab,signal);throwIfAborted(signal);
        const original=requestFor(tab),shape=request=>({mode:request?.body?.mode,file:request?.body?.file,binary:request?.body?.binary,formdata:request?.body?.formdata});
        if(original&&JSON.stringify(shape(original.request))!==JSON.stringify(shape(tab.request))&&Object.values(files||{}).some(value=>Array.isArray(value)&&value.length))
          throw new Error('スクリプトが添付ファイル欄を変更しました。ファイルを選択し直してから送信してください。');
        const response=await executeRequest({workspace,tab,files,primary,environmentId,signal,script,scriptCall:host(),onScript:rememberLogs,onVariables,onScriptLog,
          filesFor,requestFor,getResponses,onResponse,relationAncestors:stack,...(send?{send}:{})});
        if(response.type!=='relation')throwIfAborted(signal);onResponse(tab,response,environmentId);return response;
      },
      executeScript:async(saved,{signal,input,raw})=>{
        const snapshot=makeScriptContext(workspace,primary,{input,scriptId:saved.id,result:raw,environmentId,ribbonScopeId});
        // Variables and ribbon operations keep the captured relation owner.
        snapshot.requestRef=requestRef||null;
        if(ownerTab){snapshot.variableContext=clone({collectionId:ownerTab.collectionId,pendingFolderId:ownerTab.pendingFolderId,request:ownerTab.request});snapshot.variables=contextFor({...workspace,environmentId},ownerTab,primary.rows).vars;}
        try{
          const output=await script(saved.source,snapshot,{signal,timeoutMs:saved.timeoutMs,onCall:host(),onLog:entry=>onScriptLog?.({phase:'relation',...entry})});
          throwIfAborted(signal);
          if(Object.hasOwn(output,'request')||Object.hasOwn(output,'response'))throw new Error('リレーションのスクリプトではリクエスト・レスポンスを書き換えられません。');
          onVariables(applyScriptWrites(workspace,primary,environment(),output),output);rememberLogs({...output,phase:'relation'});return output;
        }catch(error){rememberLogs({phase:'relation',logs:error.logs||[],error:error.message});throw error;}
      }
    });
    if(!context.captureFailure){
      if(result.status==='cancelled')throw new DOMException(result.error||'リレーションを停止しました。','AbortError');
      if(result.status==='failed')throw Object.assign(new Error(result.error||'リレーションの実行に失敗しました。'),{logs});
      throwIfAborted(signal);
    }
    workspace.relationRuns||=[];workspace.relationRuns.push(clone(result));
    return {result,primary:primary.snapshot(),primaryRows:clone(primary.rows),logs};
  }
  return (relation,context)=>run(relation,context,context.ancestorRelationIds||[]);
}
