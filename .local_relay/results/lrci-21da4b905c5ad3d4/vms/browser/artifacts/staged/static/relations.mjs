/** Relation model, safe condition evaluation and abortable sequencing. Network is injected. */
import {clone, uid, findItem, resolver} from './core.mjs';
import {readPath, variableText, responseMetadata} from './runtime.mjs';
export const END = '$end';
export const NEXT = '$next';
export function newRelation(name = '新しいリレーション') {
  return {id:uid(),name,repeat:1,intervalMs:0,maxExecutions:0,stopOnError:true,steps:[]};
}
export function newStep(reference = {}) {
  return {id:uid(),collectionId:reference.collectionId || '',itemId:reference.itemId || '',...(reference.draftId?{draftId:reference.draftId}:{}),delayMs:0,repeat:1,intervalMs:0,
    condition:{enabled:false,source:'response',path:'/status',operator:'eq',value:'200'},onTrue:NEXT,onFalse:NEXT};
}
export const OPERATORS = [['eq','等しい'],['ne','等しくない'],['gt','より大きい'],['gte','以上'],['lt','より小さい'],['lte','以下'],['contains','含む'],['exists','存在する'],['missing','存在しない'],['truthy','真'],['falsy','偽']];
export function evaluateCondition(condition, context) {
  if (!condition?.enabled) return true;
  const source = condition.source === 'primary' ? context.primary : context.response;
  const left = condition.source === 'primary' && Object.hasOwn(source || {},condition.path) ? source[condition.path] : readPath(source,condition.path || '');
  const expected = ['exists','missing','truthy','falsy'].includes(condition.operator) ? '' : resolver(context.variables || context.primary || {})(condition.value || '');
  switch (condition.operator) {
    case 'eq': return left !== undefined && variableText(left) === expected;
    case 'ne': return left === undefined || variableText(left) !== expected;
    case 'gt': case 'gte': case 'lt': case 'lte': {
      if(left === undefined || left === null || String(left).trim()==='' || expected.trim()==='') return false;
      const a=Number(left),b=Number(expected); if(!Number.isFinite(a)||!Number.isFinite(b)) return false;
      return {gt:a>b,gte:a>=b,lt:a<b,lte:a<=b}[condition.operator];
    }
    case 'contains': return left !== undefined && variableText(left).includes(expected);
    case 'exists': return left !== undefined;
    case 'missing': return left === undefined;
    case 'truthy': return Boolean(left) && left !== 'false' && left !== '0';
    case 'falsy': return !left || left === 'false' || left === '0';
    default: throw new Error(`不明な比較演算子: ${condition.operator}`);
  }
}
export function validateRelation(relation, workspace) {
  if (!relation?.name?.trim() || !Array.isArray(relation.steps) || !relation.steps.length) throw new Error('名前と実行ステップを設定してください。');
  const ids = new Set(relation.steps.map(s=>s.id));
  if (ids.size !== relation.steps.length) throw new Error('ステップIDが重複しています。');
  const count = (value,label,allowZero=false) => {if (!Number.isSafeInteger(Number(value)) || Number(value)<(allowZero?0:1)) throw new Error(`${label}を${allowZero?'0':'1'}以上の整数にしてください。`);};
  count(relation.repeat,'全体の繰り返し回数'); count(relation.intervalMs,'全体の間隔',true); count(relation.maxExecutions ?? 0,'最大実行数',true);
  for(const step of relation.steps) {
    if(!step.id) throw new Error('ステップIDがありません。');
    const collection=workspace.collections.find(c=>c._mpId===step.collectionId),item=step.draftId?workspace.tabs.find(t=>t.id===step.draftId):findItem(collection,step.itemId)?.item;
    if(!item?.request) throw new Error('削除済み、または未選択のリクエストがあります。');
    count(step.repeat,'ステップの繰り返し回数'); count(step.delayMs,'開始前の待機',true); count(step.intervalMs,'繰り返し間隔',true);
    for(const target of [step.onTrue,step.onFalse]) if(target!==NEXT && target!==END && !ids.has(target)) throw new Error('分岐先のステップがありません。');
    if(step.condition?.enabled && (!['primary','response'].includes(step.condition.source) || !OPERATORS.some(([op])=>op===step.condition.operator))) throw new Error('分岐条件が不正です。');
  }
}
export function throwIfAborted(signal) {if(signal?.aborted) throw new DOMException('実行を停止しました。','AbortError');}
export function wait(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve,reject)=>{
    const deadline=Date.now()+ms;let timer;
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(new DOMException('実行を停止しました。','AbortError'));};
    const tick=()=>{const remaining=deadline-Date.now();if(remaining<=0){cleanup();resolve();}else timer=setTimeout(tick,Math.min(remaining,2147483647));};
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(tick,Math.min(ms,2147483647));
  });
}
export async function runRelation(relation, {workspace, execute, primary, variables=()=>primary(), signal, filesFor, onProgress=()=>{}}) {
  validateRelation(relation,workspace);
  const plan=clone(relation), snapshots=new Map();
  for(const step of plan.steps){const c=workspace.collections.find(c=>c._mpId===step.collectionId),i=step.draftId?workspace.tabs.find(t=>t.id===step.draftId):findItem(c,step.itemId).item;snapshots.set(step.id,{id:step.draftId||uid(),collectionId:c?._mpId,itemId:i._mpId,name:i.name,request:clone(i.request),settings:clone(i.settings||{})});}
  const attachments=new Map();
  const attachmentJobs=filesFor?[...snapshots].map(async([id,tab])=>{throwIfAborted(signal);attachments.set(id,await filesFor(tab,signal));}):[];
  const run={id:uid(),relationId:plan.id,name:plan.name,startedAt:new Date().toISOString(),status:'running',entries:[]};
  let executions=0;
  onProgress({...run,current:null});
  try {
    await Promise.all(attachmentJobs);
    for(let round=0;round<plan.repeat;round++) {
      if(round) await wait(plan.intervalMs,signal);
      let index=0;
      while(index<plan.steps.length) {
        throwIfAborted(signal);
        const step=plan.steps[index],tab=snapshots.get(step.id);
        onProgress({...run,current:{stepId:step.id,index,phase:'waiting'}});
        await wait(step.delayMs,signal);
        let result=null;
        for(let iteration=0;iteration<step.repeat;iteration++) {
          if(plan.maxExecutions && executions>=plan.maxExecutions) throw new Error('指定した最大実行数に達しました。');
          if(iteration) await wait(step.intervalMs,signal);
          throwIfAborted(signal); executions++;
          const entry={stepId:step.id,index,requestName:tab.name,round:round+1,iteration:iteration+1,startedAt:new Date().toISOString(),status:'running'};
          run.entries.push(entry); onProgress({...run,current:entry});
          try {
            result=null;
            result=await execute(clone(tab),{signal,files:attachments.get(step.id)});
            throwIfAborted(signal);
            entry.httpStatus=result.status; entry.elapsed_ms=result.elapsed_ms;
            const failed=result.status>=400 || result.automationErrors?.length;
            entry.status=failed?'failed':'succeeded';
            if(failed) entry.error=result.automationErrors?.join('\n') || `HTTP ${result.status}`;
            if(failed && plan.stopOnError) throw new Error(entry.error);
          } catch(error) {
            entry.status=error.name==='AbortError'?'cancelled':'failed';entry.error=error.message;
            if(error.name==='AbortError'||plan.stopOnError) throw error;
          } finally {entry.finishedAt=new Date().toISOString();onProgress({...run,current:entry});}
        }
        const matched=evaluateCondition(step.condition,{primary:primary(),variables:variables(tab),response:responseMetadata(result)});
        const target=step.condition?.enabled ? (matched?step.onTrue:step.onFalse) : NEXT;
        const last=run.entries.at(-1);last.branch=step.condition?.enabled?{matched,target,targetIndex:plan.steps.findIndex(s=>s.id===target)}:null;onProgress({...run,current:last});
        if(target===END) break;
        index=target===NEXT?index+1:plan.steps.findIndex(s=>s.id===target);
        // Even a no-delay cycle must yield, so Stop remains usable.
        await wait(0,signal);
      }
    }
    run.status=run.entries.some(e=>e.status==='failed')?'completed_with_errors':'succeeded';
  } catch(error) {run.status=error.name==='AbortError'?'cancelled':'failed';run.error=error.message;}
  run.finishedAt=new Date().toISOString();onProgress({...run,current:null});return run;
}
