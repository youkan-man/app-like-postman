/** Persistent ribbon definitions and pure state operations. No DOM or script execution. */
import {clone, uid} from './core.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.length > 0 && !value.includes(':') && value !== '__proto__';
const types = new Set(['button','text','number','select','toggle','display']);
const sources = new Set(['ribbon','store','environment','globals','variables']);
const operators = new Set(['eq','ne','truthy','falsy','gt','gte','lt','lte','contains','empty','notEmpty']);
const unary = new Set(['truthy','falsy','empty','notEmpty']);
const same = (left,right) => {
  if (Object.is(left,right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys=Object.keys(left);
  return keys.length===Object.keys(right).length && keys.every(key=>Object.hasOwn(right,key) && same(left[key],right[key]));
};

export function validRibbonKey(key) {
  return typeof key==='string' && /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(key) && !['__proto__','prototype','constructor'].includes(key);
}

function validJSON(value) {
  const stack=[{value}],ancestors=new Set();
  while (stack.length) {
    const entry=stack.pop(),current=entry.value;
    if (entry.leaving) {ancestors.delete(current);continue;}
    if (current===null || typeof current==='string' || typeof current==='boolean') continue;
    if (typeof current==='number') {if(!Number.isFinite(current))return false;continue;}
    if (!current || typeof current!=='object' || ancestors.has(current) || Object.getOwnPropertySymbols(current).length) return false;
    if (!Array.isArray(current) && ![Object.prototype,null].includes(Object.getPrototypeOf(current))) return false;
    if (Array.isArray(current) && (Object.keys(current).length!==current.length || Array.from({length:current.length},(_,i)=>Object.hasOwn(current,i)).includes(false))) return false;
    ancestors.add(current);stack.push({value:current,leaving:true});
    for (const key of Object.keys(current)) stack.push({value:current[key]});
  }
  return true;
}

/** Values stored in a ribbon always keep their declared control type. */
export function normalizeRibbonValue(control,value) {
  switch (control?.type) {
    case 'text':
      if (value===null) return '';
      if (typeof value==='string' || typeof value==='boolean' || (typeof value==='number' && Number.isFinite(value))) return String(value);
      throw new TypeError('テキストの値には文字列・数値・真偽値を指定してください。');
    case 'number': {
      if (value===null || (typeof value==='string' && value.trim()==='')) return null;
      if (!['number','string'].includes(typeof value) || !Number.isFinite(Number(value))) throw new TypeError('数値の値には有限の数値を指定してください。');
      return Number(value);
    }
    case 'toggle':
      if (typeof value!=='boolean') throw new TypeError('切り替えの値には true または false を指定してください。');
      return value;
    case 'select':
      if (typeof value!=='string' || (value!=='' && !(control.options || []).some(option=>option.value===value))) throw new TypeError('選択肢にある値を指定してください。');
      return value;
    case 'button': case 'display':
      if (!validJSON(value)) throw new TypeError('リボンの値にはJSONで表せる値を指定してください。');
      return clone(value);
    default: throw new TypeError('リボン項目の種類が不正です。');
  }
}

const makeKey = prefix => `${prefix}_${uid().replace(/[^A-Za-z0-9]/g,'').slice(-12)}`;
export function newRibbon(name='新しいリボン',key='') {
  return {id:uid(),key:key || makeKey('ribbon'),name:String(name),groups:[]};
}
export function newRibbonGroup(name='グループ') {return {id:uid(),name:String(name),controls:[]};}
export function newRibbonControl(type='button',label) {
  if (!types.has(type)) throw new TypeError('リボン項目の種類が不正です。');
  const labels={button:'ボタン',text:'テキスト',number:'数値',select:'選択',toggle:'切り替え',display:'表示'};
  return {id:uid(),key:makeKey(type),label:String(label ?? labels[type]),type,
    value:type==='button'?null:type==='number'?0:type==='toggle'?false:'',options:[],visible:true,enabled:true,actions:[]};
}

export function validRibbonCondition(condition) {
  if (condition==null) return true;
  return record(condition) && ['all','any'].includes(condition.mode) && Array.isArray(condition.rules) && condition.rules.every(rule=>
    record(rule) && sources.has(rule.source) && typeof rule.key==='string' && operators.has(rule.operator) &&
    (unary.has(rule.operator) ? rule.value===undefined || validJSON(rule.value) : Object.hasOwn(rule,'value') && validJSON(rule.value)));
}

function validAction(action) {
  if (!record(action) || !validId(action.id) || !validRibbonCondition(action.when)) return false;
  if (action.type==='script') return typeof action.scriptId==='string';
  if (!['set','toggle','activate'].includes(action.type) || typeof action.target!=='string') return false;
  return action.type!=='set' || (Object.hasOwn(action,'value') && validJSON(action.value));
}

export function validRibbons(value) {
  if (!Array.isArray(value)) return false;
  const ids=new Set(),ribbonKeys=new Set();
  const acceptId=id=>{if(!validId(id)||ids.has(id))return false;ids.add(id);return true;};
  return value.every(ribbon=>{
    if (!record(ribbon) || !acceptId(ribbon.id) || !validRibbonKey(ribbon.key) || ribbonKeys.has(ribbon.key) || typeof ribbon.name!=='string' || !Array.isArray(ribbon.groups)) return false;
    ribbonKeys.add(ribbon.key);const controlKeys=new Set();
    return ribbon.groups.every(group=>record(group) && acceptId(group.id) && typeof group.name==='string' && Array.isArray(group.controls) && group.controls.every(control=>{
      if (!record(control) || !acceptId(control.id) || !validRibbonKey(control.key) || controlKeys.has(control.key) || typeof control.label!=='string' || !types.has(control.type) ||
        (control.visible!==undefined && typeof control.visible!=='boolean') || (control.enabled!==undefined && typeof control.enabled!=='boolean') ||
        !validRibbonCondition(control.visibleWhen) || !validRibbonCondition(control.enabledWhen) || !Array.isArray(control.actions) ||
        !control.actions.every(action=>validAction(action) && acceptId(action.id))) return false;
      if (control.options!==undefined && (!Array.isArray(control.options) || !control.options.every(option=>record(option) && typeof option.value==='string' && typeof option.label==='string') || new Set(control.options.map(option=>option.value)).size!==control.options.length)) return false;
      try {if(!same(normalizeRibbonValue(control,control.value),control.value))return false;} catch {return false;}
      controlKeys.add(control.key);return true;
    }));
  });
}

export function validRibbonBindings(value) {
  return record(value) && Object.entries(value).every(([id,bindings])=>validId(id) && record(bindings) &&
    ['ribbons','controls'].every(kind=>bindings[kind]===undefined || (record(bindings[kind]) && Object.values(bindings[kind]).every(validId))));
}

export function validRibbonWorkspace(workspace) {
  return (workspace.ribbons===undefined || validRibbons(workspace.ribbons)) &&
    (workspace.activeRibbonId===undefined || (typeof workspace.activeRibbonId==='string' && (!workspace.activeRibbonId || (workspace.ribbons || []).some(ribbon=>ribbon.id===workspace.activeRibbonId)))) &&
    (workspace.ribbonBindings===undefined || validRibbonBindings(workspace.ribbonBindings));
}

export function ensureRibbons(workspace) {
  if (!validRibbonWorkspace(workspace)) throw new Error('保存されたリボンの形式が不正です。');
  workspace.ribbons ??= [];workspace.activeRibbonId ??= '';workspace.ribbonBindings ??= {};
  return workspace;
}

export function listRibbonControls(workspace) {
  return (workspace.ribbons || []).flatMap(ribbon=>ribbon.groups.flatMap(group=>group.controls.map(control=>({ribbon,group,control,reference:`${ribbon.key}.${control.key}`}))));
}

function boundReference(workspace,kind,reference,bindingId) {
  const bindings=bindingId && Object.hasOwn(workspace.ribbonBindings || {},bindingId) ? workspace.ribbonBindings[bindingId]?.[kind] : null;
  return bindings && Object.hasOwn(bindings,reference) ? bindings[reference] : undefined;
}

export function resolveRibbon(workspace,reference,{bindingId}={}) {
  if (reference===undefined || reference===null || reference==='') reference=workspace.activeRibbonId || '';
  if (typeof reference!=='string' || !reference) throw new Error('リボンを選択してください。');
  const ribbons=workspace.ribbons || [],bound=boundReference(workspace,'ribbons',reference,bindingId);
  if (bound!==undefined) {
    const target=ribbons.find(ribbon=>ribbon.id===bound);
    if (!target) throw new Error(`リボンが見つかりません: ${reference}`);
    return target;
  }
  const exact=ribbons.find(ribbon=>ribbon.id===reference);if(exact)return exact;
  const matches=ribbons.filter(ribbon=>ribbon.key===reference || ribbon.name===reference);
  if (matches.length>1) throw new Error(`リボン名が重複しています。IDまたはキーで指定してください: ${reference}`);
  if (!matches.length) throw new Error(`リボンが見つかりません: ${reference}`);
  return matches[0];
}

export function resolveRibbonControl(workspace,reference,{ribbonId,bindingId}={}) {
  if (typeof reference!=='string' || !reference) throw new Error('リボン項目のIDまたはキーを指定してください。');
  const controls=listRibbonControls(workspace),bound=boundReference(workspace,'controls',reference,bindingId);
  if (bound!==undefined) {
    const target=controls.find(row=>row.control.id===bound);
    if(!target)throw new Error(`リボン項目が見つかりません: ${reference}`);
    return target;
  }
  const exact=controls.find(row=>row.control.id===reference);if(exact)return exact;
  let matches=controls.filter(row=>row.reference===reference);
  if (!matches.length && !reference.includes('.')) {
    const selected=ribbonId ? resolveRibbon(workspace,ribbonId,{bindingId}).id : workspace.activeRibbonId;
    matches=controls.filter(row=>row.control.key===reference && row.ribbon.id===selected);
    if (!matches.length) matches=controls.filter(row=>row.control.key===reference);
  }
  if (matches.length>1) throw new Error(`リボン項目のキーが重複しています。リボンのキーを付けて指定してください: ${reference}`);
  if (!matches.length) throw new Error(`リボン項目が見つかりません: ${reference}`);
  return matches[0];
}

function rowValues(rows) {return Object.fromEntries((rows || []).filter(row=>row?.key && row.disabled!==true && row.enabled!==false).map(row=>[row.key,row.value]));}
function scopedValue(source,key) {
  if (source && Object.hasOwn(source,key)) return source[key];
  let value=source;
  const path=key.startsWith('/') ? key.slice(1).split('/').map(part=>part.replace(/~1/g,'/').replace(/~0/g,'~')) : key.replace(/^\$\.?/,'').replace(/\[(\d+)\]/g,'.$1').split('.');
  for (const part of path) {
    if (!value || typeof value!=='object' || !Object.hasOwn(value,part)) return undefined;
    value=value[part];
  }
  return value;
}
function conditionValue(rule,context) {
  const {workspace,primary,ribbonId,bindingId}=context;
  if (rule.source==='ribbon') return resolveRibbonControl(workspace,rule.key,{ribbonId,bindingId}).control.value;
  if (rule.source==='store') return scopedValue(workspace.scriptData || {},rule.key);
  const environment=Object.hasOwn(context,'environment') ? context.environment : (workspace.environments || []).find(env=>env.id===workspace.environmentId);
  const globals=rowValues(workspace.globals),env=Array.isArray(environment?.values) ? rowValues(environment.values) : (environment || {});
  if (rule.source==='globals') return scopedValue(globals,rule.key);
  if (rule.source==='environment') return scopedValue(env,rule.key);
  const local=typeof primary?.snapshot==='function' ? primary.snapshot() : primary?.rows ? rowValues(primary.rows) : (primary || {});
  return scopedValue({...globals,...env,...local},rule.key);
}
const empty = value => value===undefined || value===null || value==='' || (Array.isArray(value) && value.length===0) || (record(value) && Object.keys(value).length===0);
function compare(value,operator,expected) {
  switch(operator) {
    case 'eq': return same(value,expected);
    case 'ne': return !same(value,expected);
    case 'truthy': return Boolean(value);
    case 'falsy': return !value;
    case 'empty': return empty(value);
    case 'notEmpty': return !empty(value);
    case 'contains': return typeof value==='string' && typeof expected==='string' ? value.includes(expected) : Array.isArray(value) ? value.some(item=>same(item,expected)) : record(value) && typeof expected==='string' && Object.hasOwn(value,expected);
    default: {
      const numeric=input=>typeof input==='number' && Number.isFinite(input) ? input : typeof input==='string' && input.trim()!=='' && Number.isFinite(Number(input)) ? Number(input) : NaN;
      const left=numeric(value),right=numeric(expected);if(!Number.isFinite(left)||!Number.isFinite(right))return false;
      return operator==='gt'?left>right:operator==='gte'?left>=right:operator==='lt'?left<right:operator==='lte' && left<=right;
    }
  }
}

export function evaluateRibbonCondition(condition,context) {
  if (condition==null) return true;
  if (!validRibbonCondition(condition)) return false;
  if (!condition.rules.length) return true;
  const evaluate=rule=>{if(!rule.key)return false;try{return compare(conditionValue(rule,context),rule.operator,rule.value);}catch{return false;}};
  return condition.mode==='any' ? condition.rules.some(evaluate) : condition.rules.every(evaluate);
}

export function ribbonControlState(control,context) {
  return {visible:control.visible!==false && evaluateRibbonCondition(control.visibleWhen,context),
    enabled:control.enabled!==false && evaluateRibbonCondition(control.enabledWhen,context)};
}

/** Prepare the complete transaction before the host commits any script outputs. */
export function prepareRibbonWrites(workspace,writes=[]) {
  if (!Array.isArray(writes)) throw new Error('リボンの変更形式が不正です。');
  if (!writes.length) return ()=>false;
  if (!validRibbonWorkspace(workspace)) throw new Error('保存されたリボンの形式が不正です。');
  const plans=new Map();
  for (const write of writes) {
    if (!record(write) || !['value','visible','enabled','activate'].includes(write.type) || typeof write.id!=='string') throw new Error('リボンの変更形式が不正です。');
    let target,current,value;
    if (write.type==='activate') {
      target=(workspace.ribbons || []).find(ribbon=>ribbon.id===write.id);
      if (!target) throw new Error(`リボンが見つかりません: ${write.id}`);
      if (write.value!==target.id) throw new Error('切り替えるリボンのIDが一致しません。');
      current=workspace.activeRibbonId || '';value=target.id;
    } else {
      target=listRibbonControls(workspace).find(row=>row.control.id===write.id)?.control;
      if (!target) throw new Error(`リボン項目が見つかりません: ${write.id}`);
      current=write.type==='value' ? target.value : target[write.type]!==false;
      if (write.type==='value') {
        if (write.expectedShape!==undefined && !same(write.expectedShape,{type:target.type,options:target.options || []})) throw new Error(`実行中にリボン項目の設定が変更されました: ${target.label}`);
        value=normalizeRibbonValue(target,write.value);
      } else {
        if (typeof write.value!=='boolean') throw new TypeError('表示・有効状態には true または false を指定してください。');
        value=write.value;
      }
    }
    const key=write.type==='activate' ? 'activate' : `${write.type}:${target.id}`;
    const previous=plans.get(key);
    if (Object.hasOwn(write,'expected') && !same(current,write.expected) && !(previous && same(previous.value,write.expected))) throw new Error(`実行中にリボンの値が変更されました: ${target.label || target.name}`);
    plans.set(key,{type:write.type,target,value,current:previous ? previous.current : clone(current)});
  }
  return ()=>{
    let changed=false;
    for (const plan of plans.values()) {
      if (same(plan.current,plan.value)) continue;
      if (plan.type==='activate') workspace.activeRibbonId=plan.value;
      else plan.target[plan.type]=clone(plan.value);
      changed=true;
    }
    return changed;
  };
}
