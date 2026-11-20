/** Relation model and abortable sequencing. Network and script effects are injected. */
import {clone,uid,findItem,resolver} from './core.mjs';
import {readPath,variableText,responseMetadata,checkName} from './runtime.mjs';
export const END='$end',NEXT='$next';
export const RELATION_STEP_TYPES=[['request','リクエスト'],['repeat','繰り返し'],['forEach','配列ループ'],['while','条件ループ'],['if','条件分岐'],['wait','待機'],['script','スクリプト'],['break','ループ終了'],['continue','次の周へ']];
export const OPERATORS=[['eq','等しい'],['ne','等しくない'],['gt','より大きい'],['gte','以上'],['lt','より小さい'],['lte','以下'],['contains','含む'],['exists','存在する'],['missing','存在しない'],['truthy','真'],['falsy','偽']];
const TYPES=new Set(RELATION_STEP_TYPES.map(([type])=>type)),LOOPS=new Set(['repeat','forEach','while']);
export const relationStepType=step=>step.type||'request';
export function newCondition(enabled=true){return {enabled,source:'response',path:'/status',operator:'eq',value:'200'};}
export function newRelation(name='新しいリレーション'){return {id:uid(),name,repeat:1,intervalMs:0,maxExecutions:0,stopOnError:true,steps:[]};}
export function newStep(reference={}){
  return {id:uid(),collectionId:reference.collectionId||'',itemId:reference.itemId||'',...(reference.draftId?{draftId:reference.draftId}:{}),delayMs:0,repeat:1,intervalMs:0,
    condition:newCondition(false),onTrue:NEXT,onFalse:NEXT};
}
export function newRelationStep(type='request',reference={}){
  if(type==='request')return newStep(reference);
  if(!TYPES.has(type))throw new Error('ステップの種類が不正です。');
  const step={id:uid(),type};
  if(type==='repeat')Object.assign(step,{repeat:2,intervalMs:0,steps:[]});
  if(type==='forEach')Object.assign(step,{source:'literal',value:'[]',path:'',itemVariable:'item',indexVariable:'index',intervalMs:0,steps:[]});
  if(type==='while')Object.assign(step,{condition:newCondition(),maxIterations:1000,intervalMs:0,steps:[]});
  if(type==='if')Object.assign(step,{condition:newCondition(),steps:[],elseSteps:[]});
  if(type==='wait')step.delayMs=1000;
  if(type==='script')Object.assign(step,{scriptId:'',inputFormat:'saved',input:'null',resultVariable:''});
  return step;
}
/** Shared by duplication, reference repair and backup remapping. */
export function walkRelationSteps(steps,visit,path=[]){
  for(const [index,step] of (steps||[]).entries()){
    const current=[...path,index];visit(step,{siblings:steps,index,path:current});
    if(Array.isArray(step.steps))walkRelationSteps(step.steps,visit,[...current,'steps']);
    if(Array.isArray(step.elseSteps))walkRelationSteps(step.elseSteps,visit,[...current,'elseSteps']);
  }
}
export function cloneRelationSteps(steps){
  const result=clone(steps),ids=new Map();walkRelationSteps(result,step=>ids.set(step.id,uid()));
  walkRelationSteps(result,step=>{step.id=ids.get(step.id);for(const key of ['onTrue','onFalse'])if(ids.has(step[key]))step[key]=ids.get(step[key]);});
  return result;
}
function readValue(source,path=''){
  if(Object.hasOwn(source||{},path))return source[path];
  // Primary values are template text; nested paths can still address JSON objects.
  const expanded=source&&typeof source==='object'&&!Array.isArray(source)?Object.fromEntries(Object.entries(source).map(([key,value])=>{
    if(typeof value==='string'&&/^\s*[\[{]/.test(value)){try{return [key,JSON.parse(value)];}catch{}}
    return [key,value];
  })):source;
  return readPath(expanded,path);
}
export function evaluateCondition(condition,context){
  if(!condition?.enabled)return true;
  const source=condition.source==='primary'?context.primary:condition.source==='variables'?context.variables:condition.source==='result'?context.result:context.response;
  const left=readValue(source,condition.path||'');
  const expected=['exists','missing','truthy','falsy'].includes(condition.operator)?'':resolver(context.variables||context.primary||{})(condition.value??'');
  switch(condition.operator){
    case 'eq':return left!==undefined&&variableText(left)===expected;
    case 'ne':return left===undefined||variableText(left)!==expected;
    case 'gt':case 'gte':case 'lt':case 'lte':{
      if(left===undefined||left===null||String(left).trim()===''||expected.trim()==='')return false;
      const a=Number(left),b=Number(expected);if(!Number.isFinite(a)||!Number.isFinite(b))return false;
      return {gt:a>b,gte:a>=b,lt:a<b,lte:a<=b}[condition.operator];
    }
    case 'contains':return left!==undefined&&variableText(left).includes(expected);
    case 'exists':return left!==undefined;
    case 'missing':return left===undefined;
    case 'truthy':return Boolean(left)&&left!=='false'&&left!=='0';
    case 'falsy':return !left||left==='false'||left==='0';
    default:throw new Error('不明な比較演算子: '+condition.operator);
  }
}
export function validateRelation(relation,workspace){
  if(!relation?.name?.trim()||!Array.isArray(relation.steps)||!relation.steps.length)throw new Error('名前と実行ステップを設定してください。');
  const count=(value,label,allowZero=false)=>{if(!Number.isSafeInteger(Number(value))||Number(value)<(allowZero?0:1))throw new Error(label+'を'+(allowZero?'0':'1')+'以上の整数にしてください。');};
  const condition=(value,required=false)=>{
    if(required&&!value?.enabled)throw new Error('条件を設定してください。');
    if(value?.enabled){
      if(!['primary','response','variables','result'].includes(value.source)||!OPERATORS.some(([op])=>op===value.operator)||typeof value.path!=='string'||(value.value!=null&&typeof value.value!=='string'))throw new Error('分岐条件が不正です。');
      readPath({},value.path);
    }
  };
  count(relation.repeat,'全体の繰り返し回数');count(relation.intervalMs,'全体の間隔',true);count(relation.maxExecutions??0,'最大実行数',true);
  const ids=new Set(),ancestors=new Set();
  function visit(steps,loopDepth=0,depth=0){
    if(!Array.isArray(steps))throw new Error('ブロック内のステップが不正です。');
    if(depth>32)throw new Error('ステップの入れ子は32段までです。');
    const siblings=new Set(steps.map(step=>step?.id));
    for(const step of steps){
      if(!step||typeof step!=='object'||!step.id||typeof step.id!=='string')throw new Error('ステップIDがありません。');
      if(ids.has(step.id)||ancestors.has(step))throw new Error('ステップIDが重複しています。');ids.add(step.id);ancestors.add(step);
      const type=relationStepType(step);if(!TYPES.has(type))throw new Error('ステップの種類が不正です。');
      if(type==='request'){
        const collection=workspace.collections?.find(c=>c._mpId===step.collectionId),item=step.draftId?workspace.tabs?.find(t=>t.id===step.draftId):findItem(collection,step.itemId)?.item;
        if(!item?.request)throw new Error('削除済み、または未選択のリクエストがあります。');
        count(step.repeat,'ステップの繰り返し回数');count(step.delayMs,'開始前の待機',true);count(step.intervalMs,'繰り返し間隔',true);
        for(const target of [step.onTrue,step.onFalse])if(target!==NEXT&&target!==END&&!siblings.has(target))throw new Error('分岐先は同じブロックのステップを選択してください。');
        condition(step.condition);
      }else if(type==='script'){
        if(!workspace.scripts?.some(script=>script.id===step.scriptId))throw new Error('削除済み、または未選択のスクリプトがあります。');
        const format=step.inputFormat===undefined?'saved':step.inputFormat;
        if(!['saved','json','text','response'].includes(format)||(step.input!==undefined&&typeof step.input!=='string')||(['json','text'].includes(format)&&typeof step.input!=='string'))throw new Error('スクリプトの入力が不正です。');
        if(step.resultVariable)checkName(step.resultVariable);
      }else if(type==='wait')count(step.delayMs,'待機時間',true);
      else if(type==='break'||type==='continue'){
        if(!loopDepth)throw new Error('ループ終了・次の周へはループ内に追加してください。');
      }else{
        if(type==='repeat')count(step.repeat,'繰り返し回数');
        if(type==='while'){condition(step.condition,true);count(step.maxIterations,'ループの上限回数');}
        if(type==='if')condition(step.condition,true);
        if(LOOPS.has(type))count(step.intervalMs,'ループの間隔',true);
        if(type==='forEach'){
          if(!['literal','primary','response','variables','result'].includes(step.source)||(step.path!==undefined&&typeof step.path!=='string')||(step.value!==undefined&&typeof step.value!=='string')||(step.source==='literal'&&typeof step.value!=='string'))throw new Error('配列の参照元が不正です。');
          readPath({},step.path??'');checkName(step.itemVariable);checkName(step.indexVariable);
          if(step.itemVariable.trim()===step.indexVariable.trim())throw new Error('要素と番号には異なる変数名を指定してください。');
        }
        visit(step.steps,loopDepth+(LOOPS.has(type)?1:0),depth+1);
        if(type==='if')visit(step.elseSteps,loopDepth,depth+1);
        if(!step.steps.length&&!(type==='if'&&step.elseSteps.length))throw new Error('ブロックにステップを追加してください。');
      }
      if(!LOOPS.has(type)&&type!=='if'&&(step.steps!==undefined||step.elseSteps!==undefined))throw new Error('このステップに子ステップは設定できません。');
      if(type!=='if'&&step.elseSteps!==undefined)throw new Error('不成立時のステップは条件分岐に設定してください。');
      ancestors.delete(step);
    }
  }
  visit(relation.steps);
}
export function throwIfAborted(signal){if(signal?.aborted)throw new DOMException('実行を停止しました。','AbortError');}
export function wait(ms,signal){
  throwIfAborted(signal);
  return new Promise((resolve,reject)=>{
    const deadline=Date.now()+ms;let timer;
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(new DOMException('実行を停止しました。','AbortError'));};
    const tick=()=>{const remaining=deadline-Date.now();if(remaining<=0){cleanup();resolve();}else timer=setTimeout(tick,Math.min(remaining,2147483647));};
    signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(tick,Math.min(ms,2147483647));
  });
}
/** writePrimary must also allow cleanup after abort. executeScript commits its
 * own writes and returns the runScript {result,logs} shape. */
export async function runRelation(relation,{workspace,execute,executeScript,writePrimary,capturePrimary,primary=()=>({}),variables=()=>primary(),signal,onProgress=()=>{}}){
  validateRelation(relation,workspace);
  const plan=clone(relation),snapshots=new Map(),scripts=new Map();
  walkRelationSteps(plan.steps,step=>{
    const type=relationStepType(step);
    if((type==='forEach'||type==='script'&&step.resultVariable)&&typeof writePrimary!=='function')throw new Error('一次変数の更新処理が設定されていません。');
    if(type==='request'){
      if(typeof execute!=='function')throw new Error('リクエストの実行処理が設定されていません。');
      const c=workspace.collections?.find(c=>c._mpId===step.collectionId),i=step.draftId?workspace.tabs.find(t=>t.id===step.draftId):findItem(c,step.itemId).item;
      snapshots.set(step.id,{id:step.draftId||uid(),collectionId:c?._mpId,itemId:i._mpId,name:i.name,request:clone(i.request),settings:clone(i.settings||{}),...(i.ribbonState?{ribbonState:clone(i.ribbonState)}:{})});
    }
    if(type==='script'){
      if(typeof executeScript!=='function')throw new Error('スクリプトの実行処理が設定されていません。');
      scripts.set(step.id,clone(workspace.scripts.find(script=>script.id===step.scriptId)));
    }
  });
  const run={id:uid(),relationId:plan.id,name:plan.name,startedAt:new Date().toISOString(),status:'running',entries:[]};
  let executions=0,round=0,lastResponse=null,lastResult,lastTab;
  const currentContext=(tab=lastTab)=>({primary:primary(),variables:variables(tab),response:responseMetadata(lastResponse),result:lastResult});
  const progress=current=>onProgress({...run,current});
  const consume=()=>{throwIfAborted(signal);if(plan.maxExecutions&&executions>=plan.maxExecutions)throw new Error('指定した最大実行数に達しました。');executions++;};
  const location=(step,index,path,loops)=>({stepId:step.id,index,stepPath:[...path,index+1].join('.'),type:relationStepType(step),round:round+1,loops:clone(loops)});
  async function leaf(step,index,path,loops,iteration,fn,name){
    consume();const entry={...location(step,index,path,loops),requestName:name,iteration,startedAt:new Date().toISOString(),status:'running'};
    run.entries.push(entry);progress(entry);const began=Date.now();
    try{await fn(entry);throwIfAborted(signal);entry.status='succeeded';}
    catch(error){entry.status=error.name==='AbortError'?'cancelled':'failed';entry.error=error.message;if(error.name==='AbortError'||plan.stopOnError)throw error;}
    finally{entry.finishedAt=new Date().toISOString();entry.elapsed_ms??=Date.now()-began;progress(entry);}
    return entry;
  }
  function scriptInput(step,script){
    const inputFormat=step.inputFormat===undefined?'saved':step.inputFormat;
    if(inputFormat==='response')return responseMetadata(lastResponse);
    const format=inputFormat==='saved'?(script.inputFormat||'json'):inputFormat;
    const raw=inputFormat==='saved'?(script.input||''):resolver(currentContext().variables||{})(step.input);
    if(format==='text')return raw;
    try{return JSON.parse(raw.trim()||'null');}catch{throw new Error('スクリプトの入力を有効なJSONにしてください。');}
  }
  async function sequence(steps,path=[],loops=[]){
    let index=0;
    while(index<steps.length){
      throwIfAborted(signal);const step=steps[index],type=relationStepType(step),position=location(step,index,path,loops);
      progress({...position,phase:type==='wait'||type==='request'?'waiting':'control'});
      if(type==='request'){
        const tab=snapshots.get(step.id);lastTab=tab;await wait(step.delayMs,signal);
        for(let iteration=0;iteration<step.repeat;iteration++){
          if(iteration)await wait(step.intervalMs,signal);
          await leaf(step,index,path,loops,iteration+1,async entry=>{
            lastResponse=null;lastResponse=await execute(clone(tab),{signal});throwIfAborted(signal);
            entry.httpStatus=lastResponse.status;entry.elapsed_ms=lastResponse.elapsed_ms;
            if(lastResponse.error||lastResponse.status>=400||lastResponse.automationErrors?.length)throw new Error(lastResponse.error||lastResponse.automationErrors?.join('\n')||'HTTP '+lastResponse.status);
          },tab.name);
        }
        const matched=evaluateCondition(step.condition,currentContext(tab)),target=step.condition?.enabled?(matched?step.onTrue:step.onFalse):NEXT;
        const last=run.entries.at(-1);last.branch=step.condition?.enabled?{matched,target,targetIndex:steps.findIndex(s=>s.id===target)}:null;progress(last);
        if(target===END)return 'end';
        index=target===NEXT?index+1:steps.findIndex(s=>s.id===target);await wait(0,signal);continue;
      }
      if(type==='script'){
        const script=scripts.get(step.id);
        await leaf(step,index,path,loops,1,async entry=>{
          lastResult=undefined;
          const output=await executeScript(clone(script),{signal,input:scriptInput(step,script),step:clone(step),response:responseMetadata(lastResponse),raw:lastResponse?clone(lastResponse):null});
          throwIfAborted(signal);lastResult=output?.result;entry.logs=output?.logs||[];
          if(step.resultVariable)await writePrimary([{key:step.resultVariable,value:lastResult}]);
        },script.name);
      }else if(type==='wait')await leaf(step,index,path,loops,1,()=>wait(step.delayMs,signal),'待機');
      else if(type==='break'||type==='continue'){consume();return type;}
      else if(type==='if'){
        consume();const matched=evaluateCondition(step.condition,currentContext());
        const control=await sequence(matched?step.steps:step.elseSteps,[...path,index+1,matched?'T':'F'],loops);if(control)return control;
      }else{
        let values;
        if(type==='forEach'){
          const context=currentContext();values=step.source==='literal'?resolver(context.variables||{})(step.value):readValue(context[step.source],step.path);
          if(typeof values==='string'){try{values=JSON.parse(values);}catch{throw new Error('配列ループの参照先をJSON配列にしてください。');}}
          if(!Array.isArray(values))throw new Error('配列ループの参照先は配列ではありません。');values=clone(values);
        }
        const bindingKeys=type==='forEach'?[step.itemVariable.trim(),step.indexVariable.trim()]:[],before=primary();
        const restore=bindingKeys.map(key=>Object.hasOwn(before,key)?{key,value:before[key]}:{key,remove:true});
        const restoreRows=bindingKeys.length&&capturePrimary?capturePrimary(bindingKeys):null;
        try{
          let iteration=0;
          while(type==='while'?evaluateCondition(step.condition,currentContext()):iteration<(type==='forEach'?values.length:step.repeat)){
            throwIfAborted(signal);
            if(type==='while'&&iteration>=step.maxIterations)throw new Error('条件ループの上限回数に達しました。');
            consume();if(iteration)await wait(step.intervalMs,signal);
            if(type==='forEach')await writePrimary([{key:bindingKeys[0],value:values[iteration]},{key:bindingKeys[1],value:iteration}]);
            iteration++;
            const control=await sequence(step.steps,[...path,index+1],[...loops,{stepId:step.id,iteration}]);
            if(control==='end')return control;if(control==='break')break;
            // Includes continue and all-control bodies; Stop must get an event turn.
            await wait(0,signal);
          }
        }finally{if(restoreRows)await restoreRows();else if(restore.length)await writePrimary(restore);}
      }
      index++;await wait(0,signal);
    }
  }
  progress(null);
  try{
    for(round=0;round<plan.repeat;round++){
      throwIfAborted(signal);if(round)await wait(plan.intervalMs,signal);await sequence(plan.steps);
    }
    run.status=run.entries.some(entry=>entry.status==='failed')?'completed_with_errors':'succeeded';
  }catch(error){run.status=error.name==='AbortError'?'cancelled':'failed';run.error=error.message;}
  run.finishedAt=new Date().toISOString();progress(null);return run;
}
