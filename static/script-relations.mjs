/** A script-invoked relation operates on its caller's pending workspace. */
import {clone,contextFor,newRequest} from './core.mjs';
import {PrimaryVariables} from './runtime.mjs';
import {runRelation,throwIfAborted} from './relations.mjs';
import {makeScriptContext,createScriptHost} from './script-host.mjs';
import {runScript} from './script-runner.mjs';
import {executeRequest} from './execution.mjs';
import {applyScriptWrites} from './scripts.mjs';

export function createScriptRelationRunner({filesFor=()=>({}),requestFor=()=>null,onResponse=()=>{},getResponses=()=>[],script=runScript,send}={}) {
  async function run(relation,context,ancestors=[]) {
    const {workspace,signal,environmentId,requestRef,ribbonScopeId}=context;
    throwIfAborted(signal);
    if(ancestors.includes(relation.id))throw new Error('同じリレーションを再帰的に実行できません。');
    if(ancestors.length>=16)throw new Error('リレーションの呼び出しが深すぎます。');
    const stack=[...ancestors,relation.id],primary=new PrimaryVariables(),logs=[];
    primary.apply(Object.entries(context.primary||{}).map(([key,value])=>({key,value})));
    const nested=(next,options)=>run(next,options,stack);
    const host=()=>createScriptHost({workspace,primary,environmentId,requestRef,filesFor,onResponse,getResponses,runRelation:nested,...(send?{send}:{})});
    const environment=()=>workspace.environments?.find(item=>item.id===environmentId);
    const rememberLogs=output=>{for(const entry of output.logs||[])logs.push(clone(entry));};
    const result=await runRelation(relation,{
      workspace,signal,primary:()=>primary.snapshot(),writePrimary:writes=>primary.apply(writes),
      variables:tab=>contextFor({...workspace,environmentId},tab||{request:newRequest()},primary.rows).vars,
      execute:async(tab,{signal})=>{
        const files=await filesFor(tab,signal);throwIfAborted(signal);
        const original=requestFor(tab),shape=request=>({mode:request?.body?.mode,file:request?.body?.file,binary:request?.body?.binary,formdata:request?.body?.formdata});
        if(original&&JSON.stringify(shape(original.request))!==JSON.stringify(shape(tab.request))&&Object.values(files||{}).some(value=>Array.isArray(value)&&value.length))
          throw new Error('スクリプトが添付ファイル欄を変更しました。ファイルを選択し直してから送信してください。');
        const response=await executeRequest({workspace,tab,files,primary,environmentId,signal,script,scriptCall:host(),onScript:rememberLogs,...(send?{send}:{})});
        throwIfAborted(signal);onResponse(tab,response,environmentId);return response;
      },
      executeScript:async(saved,{signal,input,raw})=>{
        const snapshot=makeScriptContext(workspace,primary,{input,scriptId:saved.id,result:raw,environmentId,ribbonScopeId});
        // A relation script keeps the original caller's explicit request owner.
        snapshot.requestRef=requestRef||null;
        const output=await script(saved.source,snapshot,{signal,timeoutMs:saved.timeoutMs,onCall:host()});
        throwIfAborted(signal);
        if(Object.hasOwn(output,'request')||Object.hasOwn(output,'response'))throw new Error('リレーションのスクリプトではリクエスト・レスポンスを書き換えられません。');
        applyScriptWrites(workspace,primary,environment(),output);rememberLogs(output);return output;
      }
    });
    if(result.status==='cancelled')throw new DOMException(result.error||'リレーションを停止しました。','AbortError');
    if(result.status==='failed')throw Object.assign(new Error(result.error||'リレーションの実行に失敗しました。'),{logs});
    throwIfAborted(signal);
    workspace.relationRuns||=[];workspace.relationRuns.push(clone(result));
    return {result,primary:primary.snapshot(),logs};
  }
  return (relation,context)=>run(relation,context,context.ancestorRelationIds||[]);
}
