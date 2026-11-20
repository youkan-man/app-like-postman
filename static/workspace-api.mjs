/** JSON model editing shared by the Worker and the committing host. */
import {createRequestEditor} from './script-request.mjs';

/** Stable selectors keep independent edits to other entities and fields intact. */
export function workspaceChanges(before, after) {
  const changes = [], copy = value => structuredClone(value);
  const roots = ['collections','environments','globals','tabs','scripts','scriptBindings','scriptData','relations','history','relationRuns','environmentId','activeId','activeRequest','theme','collapsed','editorSettings','settings','ribbons','activeRibbonId','ribbonBindings','revisions','settingHistory'];
  const same = (a,b) => {
    if (Object.is(a,b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b,key) && same(a[key],b[key]));
  };
  const arrayKey = (a,b) => ['_mpId','id','key'].find(key => a.concat(b).every(row => row && typeof row === 'object' && !Array.isArray(row) && typeof row[key] === 'string' && row[key]) &&
    new Set(a.map(row => row[key])).size === a.length && new Set(b.map(row => row[key])).size === b.length);
  function walk(a,b,path,hasA=true,hasB=true) {
    if (hasA === hasB && same(a,b)) return;
    if (hasA && hasB && Array.isArray(a) && Array.isArray(b)) {
      const key = a.length || b.length ? arrayKey(a,b) : null;
      if (key) {
        const left = new Map(a.map(row => [row[key],row])), right = new Map(b.map(row => [row[key],row]));
        for (const [id,row] of left) walk(row,right.get(id),[...path,{key,id}],true,right.has(id));
        for (const [id,row] of right) if (!left.has(id)) walk(undefined,row,[...path,{key,id}],false,true);
        const retained = a.filter(row => right.has(row[key])).map(row => row[key]), target = b.filter(row => left.has(row[key])).map(row => row[key]);
        // Appending is the usual create operation. Reordering is explicit and
        // checks the old members while retaining concurrently added members.
        const natural = retained.concat(b.filter(row => !left.has(row[key])).map(row => row[key]));
        if (!same(natural,b.map(row => row[key]))) changes.push({kind:'order',path:copy(path),key,expected:retained,value:b.map(row => row[key])});
        return;
      }
    }
    if (hasA && hasB && a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      if(path.at(-1)==='ribbonState'&&a.id===b.id)changes.push({path:[...path,'id'],expected:{exists:true,value:a.id},value:a.id});
      if(typeof a.type==='string'&&a.type===b.type&&Object.hasOwn(a,'value')&&!same(a.value,b.value)&&Object.hasOwn(a,'options')){
        changes.push({path:[...path,'type'],expected:{exists:true,value:a.type},value:a.type});
        if(same(a.options,b.options))changes.push({path:[...path,'options'],expected:{exists:true,value:copy(a.options)},value:copy(a.options)});
        if(path.includes('ribbons')&&path.includes('controls'))changes.push({path:[...path,'value'],expected:{exists:true,value:copy(a.value)},value:copy(a.value)});
      }
      for (const key of new Set([...Object.keys(a),...Object.keys(b)])) walk(a[key],b[key],[...path,key],Object.hasOwn(a,key),Object.hasOwn(b,key));
      return;
    }
    changes.push({path:copy(path),expected:hasA ? {exists:true,value:copy(a)} : {exists:false},...(hasB ? {value:copy(b)} : {remove:true})});
  }
  for (const key of roots) walk(before[key],after[key],[key],Object.hasOwn(before,key),Object.hasOwn(after,key));
  return changes;
}

/** Apply CAS edits to a private candidate. Never call this on live state until validated. */
export function applyWorkspaceChanges(workspace, changes) {
  if (!Array.isArray(changes)) throw new TypeError('ワークスペースの変更形式が不正です。');
  const roots = new Set(['collections','environments','globals','tabs','scripts','scriptBindings','scriptData','relations','history','relationRuns','environmentId','activeId','activeRequest','theme','collapsed','editorSettings','settings','ribbons','activeRibbonId','ribbonBindings','revisions','settingHistory']);
  const copy = value => structuredClone(value), own = (object,key) => Object.hasOwn(object,key);
  const same = (a,b) => {
    if (Object.is(a,b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => own(b,key) && same(a[key],b[key]));
  };
  const conflict = () => {throw new Error('スクリプト実行中に同じ項目が変更・削除されました。変更は保存していません。');};
  const selector = part => part && typeof part === 'object' && ['id','_mpId','key'].includes(part.key) && typeof part.id === 'string';
  function position(parent,part) {
    if (typeof part === 'string') {
      if (!parent || typeof parent !== 'object' || Array.isArray(parent)) conflict();
      return {exists:own(parent,part),key:part,value:own(parent,part)?parent[part]:undefined};
    }
    if (!selector(part) || !Array.isArray(parent)) conflict();
    const matches = parent.map((row,index) => row?.[part.key] === part.id ? index : -1).filter(index => index >= 0);
    if (matches.length > 1) conflict();
    return {exists:matches.length === 1,key:matches[0] ?? parent.length,value:matches.length?parent[matches[0]]:undefined};
  }
  for (const change of changes) {
    if (!change || !Array.isArray(change.path) || !change.path.length || !roots.has(change.path[0]) || change.path.some(part => typeof part !== 'string' && !selector(part))) throw new TypeError('ワークスペースの変更パスが不正です。');
    let parent = workspace;
    for (const part of change.path.slice(0,-1)) {const found=position(parent,part);if(!found.exists)conflict();parent=found.value;}
    const part=change.path.at(-1),found=position(parent,part);
    if (change.kind === 'order') {
      if (!found.exists || !Array.isArray(found.value) || !['id','_mpId','key'].includes(change.key) || !Array.isArray(change.expected) || !Array.isArray(change.value)) throw new TypeError('並び順の変更形式が不正です。');
      const rows=found.value,expected=new Set(change.expected),ids=rows.map(row=>row?.[change.key]);
      if (new Set(ids).size !== ids.length || !same(ids.filter(id=>expected.has(id)),change.expected)) conflict();
      const next=change.value.map(id=>rows.find(row=>row?.[change.key]===id));
      if (next.some(row=>!row) || new Set(change.value).size !== next.length) conflict();
      const used=new Set(change.value);rows.splice(0,rows.length,...next,...rows.filter(row=>!used.has(row?.[change.key])));
      continue;
    }
    if (!change.expected || typeof change.expected.exists !== 'boolean' || change.expected.exists !== found.exists || found.exists && !same(change.expected.value,found.value)) conflict();
    if (change.remove) {if(found.exists){if(Array.isArray(parent))parent.splice(found.key,1);else delete parent[found.key];}}
    else {
      if (!own(change,'value')) throw new TypeError('変更する値がありません。');
      if (Array.isArray(parent)) {if(found.exists)parent[found.key]=copy(change.value);else parent.push(copy(change.value));}
      else Object.defineProperty(parent,found.key,{value:copy(change.value),enumerable:true,configurable:true,writable:true});
    }
  }
  return changes.length > 0;
}

/** Preserve captured environment, script, request and row objects while committing. */
export function reconcileWorkspace(target, source) {
  const copy=value=>structuredClone(value);
  const moved=new Map(),duplicates=new Set();
  function collect(values){for(const value of values||[]){if(typeof value?._mpId==='string'){if(moved.has(value._mpId))duplicates.add(value._mpId);else moved.set(value._mpId,value);}if(Array.isArray(value?.item))collect(value.item);}}
  collect(target.collections);for(const key of duplicates)moved.delete(key);
  function create(value,collectionTree=false){return value&&typeof value==='object'?merge(Array.isArray(value)?[]:{},value,collectionTree):copy(value);}
  function merge(left,right,collectionTree=false,root=false) {
    if (Array.isArray(left) && Array.isArray(right)) {
      const key=['_mpId','id','key'].find(field=>left.concat(right).every(row=>row&&typeof row==='object'&&typeof row[field]==='string') && new Set(left.map(row=>row[field])).size===left.length && new Set(right.map(row=>row[field])).size===right.length);
      const next=right.map((row,index)=>{const current=key?left.find(item=>item[key]===row[key])||(collectionTree&&key==='_mpId'?moved.get(row[key]):undefined):left[index];return compatible(current,row)?merge(current,row,collectionTree):create(row,collectionTree);});
      left.splice(0,left.length,...next);return left;
    }
    for (const key of Object.keys(left)) if (!Object.hasOwn(right,key)) delete left[key];
    for (const key of Object.keys(right)) {
      const childTree=root&&key==='collections'||collectionTree&&key==='item';
      const next=Object.hasOwn(left,key)&&compatible(left[key],right[key])?merge(left[key],right[key],childTree):create(right[key],childTree);
      Object.defineProperty(left,key,{value:next,enumerable:true,configurable:true,writable:true});
    }
    return left;
  }
  function compatible(a,b){return a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b);}
  return merge(target,source,false,true);
}

/** Self-contained so the isolated Worker can receive this factory as source. */
export function createWorkspaceModel(initial, {checkActive=()=>{},requestRef=null,ribbonScopeId=null,environmentId='',onChange=()=>{}}={}) {
  const state=JSON.parse(JSON.stringify(initial)),copy=value=>structuredClone(value);
  const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const id=()=>globalThis.crypto?.randomUUID?.() || `script-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const isId=value=>typeof value==='string'&&value.length>0&&!value.includes(':')&&value!=='__proto__';
  const text=value=>value===undefined?'':typeof value==='object'?JSON.stringify(value):String(value);
  const field=(object,key,value)=>Object.defineProperty(object,key,{value,enumerable:true,configurable:true,writable:true});
  const name=value=>{if(typeof value!=='string'||!value.trim())throw new TypeError('空でない名前を指定してください。');return value;};
  function json(value,seen=new Set()) {
    if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return copy(value);
    if(!value||typeof value!=='object'||(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))||seen.has(value)||Object.getOwnPropertySymbols(value).length)throw new TypeError('JSONで表せる値を指定してください。');
    if(Array.isArray(value)&&(Object.keys(value).length!==value.length||Array.from({length:value.length},(_,i)=>Object.hasOwn(value,i)).includes(false)))throw new TypeError('配列の形式が不正です。');
    seen.add(value);const result=Array.isArray(value)?value.map(item=>json(item,seen)):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,json(item,seen)]));seen.delete(value);return result;
  }
  function object(value,label='設定'){if(!record(value))throw new TypeError(`${label}はオブジェクトで指定してください。`);return json(value);}
  function patch(target,value,blocked=[]) {
    value=object(value);
    for(const [key,next] of Object.entries(value)){
      if(blocked.includes(key))throw new TypeError(`${key} は変更できません。`);
      if(record(next)&&Object.hasOwn(target,key)&&record(target[key]))patch(target[key],next);else field(target,key,copy(next));
    }
    return target;
  }
  const same=(left,right)=>Object.is(left,right)||left!==null&&right!==null&&typeof left==='object'&&typeof right==='object'&&Array.isArray(left)===Array.isArray(right)&&Object.keys(left).length===Object.keys(right).length&&Object.keys(left).every(key=>Object.hasOwn(right,key)&&same(left[key],right[key]));
  function pathParts(path){
    if(Array.isArray(path))return path.map(part=>{if(typeof part!=='string'&&(!Number.isInteger(part)||part<0))throw new TypeError('パスの要素が不正です。');return String(part);});
    if(typeof path!=='string')throw new TypeError('パスは文字列または配列で指定してください。');
    if(path==='')return [];
    if(path.startsWith('/'))return path.slice(1).split('/').map(part=>{if(/~(?:[^01]|$)/.test(part))throw new TypeError('JSON Pointerのエスケープが不正です。');return part.replace(/~1/g,'/').replace(/~0/g,'~');});
    if(path==='$')return [];if(path.startsWith('$.'))path=path.slice(2);else if(path.startsWith('$['))path=path.slice(1);
    const result=[];let index=0,expectSegment=true;
    while(index<path.length){
      if(path[index]==='['){const start=index++;let part;if(path[index]==='"'){const begin=index++;let escaped=false;while(index<path.length){const char=path[index++];if(char==='"'&&!escaped)break;escaped=char==='\\'&&!escaped;}try{part=JSON.parse(path.slice(begin,index));}catch{throw new TypeError('パスの引用符が不正です。');}if(path[index++]!==']')throw new TypeError('パスの括弧が不正です。');}
        else{const end=path.indexOf(']',index);if(end<0)throw new TypeError('パスの括弧が不正です。');part=path.slice(index,end);if(!/^(?:0|[1-9]\d*|\*)$/.test(part))throw new TypeError('配列の添字が不正です。');index=end+1;}if(index<=start)throw new TypeError('パスが不正です。');result.push(part);expectSegment=false;}
      else if(path[index]==='.') {if(expectSegment)throw new TypeError('パスに空の要素があります。');index++;expectSegment=true;}
      else{if(!expectSegment)throw new TypeError('パスの区切りが不正です。');const begin=index;while(index<path.length&&!'.['.includes(path[index]))index++;const part=path.slice(begin,index);if(!part||part.includes(']'))throw new TypeError('パスが不正です。');result.push(part);expectSegment=false;}
    }
    if(expectSegment)throw new TypeError('パスの末尾が不正です。');return result;
  }
  function atPath(value,parts){for(const key of parts){if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))return undefined;value=value[key];}return value;}
  function withPath(value,parts,next){
    if(!parts.length)return json(next);
    const result=copy(value);let cursor=result;
    for(let index=0;index<parts.length;index++){
      const key=parts[index],last=index===parts.length-1;
      if(cursor===null||typeof cursor!=='object')throw new TypeError('パスの途中にオブジェクトまたは配列を指定してください。');
      if(Array.isArray(cursor)){if(!/^(?:0|[1-9]\d*)$/.test(key))throw new TypeError('配列には非負の添字を指定してください。');if(Number(key)>cursor.length)throw new RangeError('配列に空の要素は作成できません。');}
      if(last)field(cursor,key,json(next));
      else{if(!Object.hasOwn(cursor,key))field(cursor,key,/^(?:0|[1-9]\d*)$/.test(parts[index+1])?[]:{});cursor=cursor[key];}
    }
    return result;
  }
  function replaceFields(target,next,blocked=[]){
    for(const key of Object.keys(target))if(!blocked.includes(key)&&!Object.hasOwn(next,key))delete target[key];
    for(const [key,value] of Object.entries(next))if(!blocked.includes(key))field(target,key,copy(value));
  }
  function entityAccess(resolve,{view=value=>copy(value),target=value=>value,blocked=['id'],normalize=value=>value}={}){return {
    get(reference,path){checkActive();return copy(atPath(view(resolve(reference)),path===undefined?[]:pathParts(path)));},
    set(reference,...args){
      if(args.length!==1&&args.length!==2)throw new TypeError('値、またはパスと値を指定してください。');
      const parts=args.length===2?pathParts(args[0]):[];let identity;
      mutate(()=>{const entry=resolve(reference),before=view(entry);identity=before.id;let next=object(withPath(before,parts,args.at(-1)));
        for(const key of blocked)if(Object.hasOwn(next,key)&&(!Object.hasOwn(before,key)||!same(next[key],before[key])))throw new TypeError(`${key} は変更できません。`);
        next=normalize(next,before);replaceFields(target(entry),next,blocked);
      });
      return copy(atPath(view(resolve(identity)),parts));
    }
  };}
  const listRoot=key=>Array.isArray(state[key])?state[key]:[];
  const ensureRoot=key=>state[key]??(state[key]=[]);
  function choose(entries,reference,label) {
    const key=record(reference)?reference.id:reference;
    if(typeof key!=='string'||!key)throw new TypeError(`${label}のIDまたは名前を指定してください。`);
    const exact=entries.filter(entry=>entry.id===key),matches=exact.length?exact:entries.filter(entry=>entry.name===key||entry.path===key||entry.itemId===key||entry.draftId===key||entry.key===key);
    if(matches.length!==1)throw new Error(matches.length?`${label}が複数あります。IDで指定してください: ${key}`:`${label}がありません: ${key}`);
    return matches[0];
  }
  function collections(){return listRoot('collections').map(node=>({id:node._mpId,name:node.info?.name||'',node}));}
  function tree(){
    const result=[];
    function visit(nodes,collection,parents=[]){for(const node of nodes||[]){const entry={id:`${collection._mpId}:${node._mpId}`,collectionId:collection._mpId,itemId:node._mpId,parentId:parents.length?`${collection._mpId}:${parents.at(-1)._mpId}`:collection._mpId,path:[collection.info?.name,...parents.map(row=>row.name),node.name].join(' / '),name:node.name,node,siblings:nodes,parents};result.push(entry);if(Array.isArray(node.item))visit(node.item,collection,[...parents,node]);}}
    for(const collection of listRoot('collections'))visit(collection.item,collection);return result;
  }
  function draftRows(){return listRoot('tabs').filter(tab=>!tab.collectionId||!tab.itemId||!tree().some(entry=>entry.collectionId===tab.collectionId&&entry.itemId===tab.itemId&&entry.node.request)).map(node=>({id:`draft:${node.id}`,draftId:node.id,name:node.name,path:node.name,node}));}
  const requestRows=()=>[...tree().filter(entry=>entry.node.request),...draftRows()];
  if(ribbonScopeId){
    const owners=requestRows().filter(entry=>entry.node.ribbonState?.id===ribbonScopeId);
    if(owners.length!==1)throw new Error('リボンの実行先リクエストが見つからないか、重複しています。');
    requestRef=owners[0].id;
  }
  const folderRows=()=>tree().filter(entry=>Array.isArray(entry.node.item));
  const requestEntry=reference=>choose(requestRows(),reference??requestRef,'リクエスト');
  function descriptor(entry){const {node,siblings,parents,...meta}=entry;return {...copy(node),...meta};}
  function owner(reference=requestRef){return reference?requestEntry(reference).node:null;}
  function parent(reference){
    const all=[...collections(),...folderRows()],entry=choose(all,reference,'保存先');
    return {entry,items:entry.node.item||(entry.node.item=[]),collectionId:entry.collectionId||entry.id};
  }
  function transferReferences(entry,destination,nodes){
    if(destination.collectionId===entry.collectionId)return;
    const ids=new Set(nodes.map(value=>value._mpId));
    const update=ref=>{if(ref?.collectionId===entry.collectionId&&(ids.has(ref.itemId)||ids.has(ref.pendingFolderId)))ref.collectionId=destination.collectionId;};
    for(const tab of state.tabs||[])update(tab);update(state.activeRequest);
    const steps=values=>{for(const step of values||[]){update(step);steps(step.steps);steps(step.elseSteps);}};
    for(const relation of state.relations||[])steps(relation.steps);
    for(const value of state.history||[])update(value.tab);
    for(const node of nodes){const kind=Array.isArray(node.item)?'folder':'request',from=`${kind}:${entry.collectionId}:${node._mpId}`,to=`${kind}:${destination.collectionId}:${node._mpId}`;
      if(Object.hasOwn(state.revisions||{},to))throw new Error('移動先に同じIDの変更履歴があります。');
      if(Object.hasOwn(state.revisions||{},from)){field(state.revisions,to,state.revisions[from]);delete state.revisions[from];}
    }
  }
  function validateRows(value){if(!Array.isArray(value)||value.some(row=>!record(row)||typeof row.key!=='string'||row.value===undefined||row.enabled!==undefined&&typeof row.enabled!=='boolean'||row.disabled!==undefined&&typeof row.disabled!=='boolean'))throw new TypeError('変数・ヘッダーは key と value、および真偽値の状態を持つ配列で指定してください。');json(value);}
  function validateRequest(request){
    if(!record(request)||typeof request.method!=='string'||!request.method.trim()||(!record(request.url)&&typeof request.url!=='string'))throw new TypeError('リクエストの method と url を設定してください。');
    if(request.header!==undefined)validateRows(request.header);
    if(request.body!==undefined&&!record(request.body))throw new TypeError('body はオブジェクトで指定してください。');
    if(request.auth!==undefined&&request.auth!==null&&!record(request.auth))throw new TypeError('auth はオブジェクトまたは null で指定してください。');
  }
  function validateSettings(settings){
    if(!record(settings))throw new TypeError('リクエスト設定はオブジェクトで指定してください。');
    for(const key of ['verify_tls','follow_redirects'])if(settings[key]!==undefined&&typeof settings[key]!=='boolean')throw new TypeError(`${key} は真偽値で指定してください。`);
    if(settings.timeout_ms!==undefined&&(!Number.isFinite(settings.timeout_ms)||settings.timeout_ms<0))throw new TypeError('timeout_ms は0以上の数値で指定してください。');
  }
  const newRequest=()=>({method:'GET',url:{raw:'',query:[],variable:[]},header:[],body:{mode:'none',raw:''},auth:null});
  function validateScript(script){if(!isId(script.id)||typeof script.name!=='string'||typeof script.source!=='string'||script.input!==undefined&&typeof script.input!=='string'||script.inputFormat!==undefined&&!['json','text'].includes(script.inputFormat)||script.timeoutMs!==undefined&&(!Number.isFinite(script.timeoutMs)||script.timeoutMs<0)||script.bindingId!==undefined&&script.bindingId!==''&&!isId(script.bindingId))throw new TypeError('スクリプトの形式が不正です。');}
  function validateRelationShape(relation){
    if(!isId(relation.id)||typeof relation.name!=='string'||!Array.isArray(relation.steps))throw new TypeError('リレーションの形式が不正です。');
    for(const key of ['repeat','intervalMs','maxExecutions'])if(relation[key]!==undefined&&(!Number.isSafeInteger(relation[key])||relation[key]<(key==='repeat'?1:0)))throw new TypeError(`${key} は有効な整数で指定してください。`);
    const ids=new Set();function steps(values,depth=0){if(!Array.isArray(values)||depth>32)throw new TypeError('ステップの入れ子が不正です。');for(const step of values){if(!record(step)||!isId(step.id)||ids.has(step.id))throw new TypeError('ステップIDが不正または重複しています。');ids.add(step.id);if(step.type!==undefined&&!['request','repeat','forEach','while','if','wait','script','break','continue'].includes(step.type))throw new TypeError('ステップの種類が不正です。');if(step.steps!==undefined)steps(step.steps,depth+1);if(step.elseSteps!==undefined)steps(step.elseSteps,depth+1);}}steps(relation.steps);
  }
  const ribbonKey=value=>typeof value==='string'&&/^[\p{L}_][\p{L}\p{N}_-]*$/u.test(value)&&!['__proto__','constructor','prototype'].includes(value);
  function controlValue(control,value){
    if(control.type==='text'){if(value===null)return '';if(['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return String(value);}
    else if(control.type==='number'){if(value===null||typeof value==='string'&&!value.trim())return null;if(['string','number'].includes(typeof value)&&Number.isFinite(Number(value)))return Number(value);}
    else if(control.type==='toggle'){if(typeof value==='boolean')return value;}
    else if(control.type==='select'){if(typeof value==='string'&&(!value||(control.options||[]).some(option=>option.value===value)))return value;}
    else if(['button','display'].includes(control.type))return json(value);
    throw new TypeError('リボン項目の種類に合う値を指定してください。');
  }
  function validateRibbon(state){
    if(!isId(state.id)||!Array.isArray(state.ribbons)||typeof state.activeRibbonId!=='string'||!record(state.ribbonBindings))throw new TypeError('リボンの保存形式が不正です。');
    if(!Object.entries(state.ribbonBindings).every(([bindingId,bindings])=>isId(bindingId)&&record(bindings)&&['ribbons','controls'].every(kind=>bindings[kind]===undefined||record(bindings[kind])&&Object.values(bindings[kind]).every(isId))))throw new TypeError('リボンの参照設定が不正です。');
    const ids=new Set(),keys=new Set(),accept=value=>{if(!isId(value)||ids.has(value))throw new TypeError('リボンのIDが不正または重複しています。');ids.add(value);};
    function condition(value){if(value==null)return;if(!record(value)||!['all','any'].includes(value.mode)||!Array.isArray(value.rules)||value.rules.some(rule=>!record(rule)||!['ribbon','store','environment','globals','variables'].includes(rule.source)||typeof rule.key!=='string'||!['eq','ne','truthy','falsy','gt','gte','lt','lte','contains','empty','notEmpty'].includes(rule.operator)||!['truthy','falsy','empty','notEmpty'].includes(rule.operator)&&!Object.hasOwn(rule,'value')))throw new TypeError('リボンの条件が不正です。');}
    for(const ribbon of state.ribbons){accept(ribbon.id);if(!ribbonKey(ribbon.key)||keys.has(ribbon.key)||typeof ribbon.name!=='string'||!Array.isArray(ribbon.groups))throw new TypeError('リボンの形式が不正です。');keys.add(ribbon.key);const controlKeys=new Set();
      for(const group of ribbon.groups){accept(group.id);if(typeof group.name!=='string'||!Array.isArray(group.controls))throw new TypeError('リボングループの形式が不正です。');
        for(const control of group.controls){accept(control.id);if(!ribbonKey(control.key)||controlKeys.has(control.key)||typeof control.label!=='string'||!Array.isArray(control.actions))throw new TypeError('リボン項目の形式が不正です。');controlKeys.add(control.key);for(const flag of ['visible','enabled'])if(control[flag]!==undefined&&typeof control[flag]!=='boolean')throw new TypeError('表示・有効状態は真偽値で指定してください。');
          if(control.options!==undefined&&!Array.isArray(control.options)||(control.options||[]).some(option=>!record(option)||typeof option.value!=='string'||typeof option.label!=='string')||new Set((control.options||[]).map(option=>option.value)).size!==(control.options||[]).length)throw new TypeError('選択肢の形式が不正です。');
          control.value=controlValue(control,control.value);condition(control.visibleWhen);condition(control.enabledWhen);
          for(const action of control.actions){accept(action.id);condition(action.when);if(!['script','set','toggle','activate'].includes(action.type)||action.type==='script'&&typeof action.scriptId!=='string'||action.type!=='script'&&typeof action.target!=='string'||action.type==='set'&&!Object.hasOwn(action,'value'))throw new TypeError('リボン操作の形式が不正です。');}
        }
      }
    }
    if(state.activeRibbonId&&!state.ribbons.some(ribbon=>ribbon.id===state.activeRibbonId))throw new TypeError('選択中のリボンがありません。');
  }
  function validate(){
    json(state);
    const ids=new Set();for(const collection of listRoot('collections')){if(!isId(collection._mpId)||ids.has(collection._mpId)||!record(collection.info)||typeof collection.info.name!=='string'||!Array.isArray(collection.item))throw new TypeError('コレクションの形式が不正です。');ids.add(collection._mpId);if(collection.variable!==undefined)validateRows(collection.variable);}
    const itemIds=new Set();for(const entry of tree()){if(!isId(entry.itemId)||itemIds.has(entry.id)||typeof entry.name!=='string')throw new TypeError('リクエスト・フォルダーの形式が不正です。');itemIds.add(entry.id);if(entry.node.request)validateRequest(entry.node.request);if(entry.node.settings)validateSettings(entry.node.settings);if(entry.node.variable!==undefined)validateRows(entry.node.variable);if(entry.node.ribbonState)validateRibbon(entry.node.ribbonState);}
    for(const key of ['environments','scripts','relations','tabs']){const seen=new Set();for(const value of listRoot(key)){if(!isId(value.id)||seen.has(value.id)||typeof value.name!=='string')throw new TypeError(`${key} のIDまたは名前が不正です。`);seen.add(value.id);if(key==='environments')validateRows(value.values);if(key==='scripts')validateScript(value);if(key==='relations')validateRelationShape(value);if(key==='tabs'){validateRequest(value.request);if(value.settings)validateSettings(value.settings);if(value.ribbonState)validateRibbon(value.ribbonState);}}}
    const scopes=new Set();for(const entry of requestRows()){const scope=entry.node.ribbonState?.id;if(scope){if(scopes.has(scope))throw new Error('リクエストのリボンIDが重複しています。');scopes.add(scope);}}
    if(state.globals!==undefined)validateRows(state.globals);
    if(state.scriptBindings!==undefined&&(!record(state.scriptBindings)||!Object.entries(state.scriptBindings).every(([bindingId,bindings])=>isId(bindingId)&&record(bindings)&&Object.values(bindings).every(isId))))throw new TypeError('スクリプトの参照設定が不正です。');
    if(state.scriptData!==undefined&&!record(state.scriptData))throw new TypeError('共有データはオブジェクトで指定してください。');
    return true;
  }
  function mutate(fn){checkActive();const before=copy(state);try{const result=fn();validate();onChange();return copy(result);}catch(error){for(const key of Object.keys(state))delete state[key];for(const [key,value]of Object.entries(before))field(state,key,value);throw error;}}
  function variables(resolveRows){return {
    list(){checkActive();return copy(resolveRows(false)||[]);},
    get(key){checkActive();const rows=(resolveRows(false)||[]).filter(row=>row.key===String(key)&&row.enabled!==false&&row.disabled!==true);return rows.length?text(rows.at(-1).value):undefined;},
    has(key){return this.get(key)!==undefined;},
    set(key,value,metadata={}){return mutate(()=>{if(typeof key!=='string'||!key.trim()||/[{}\r\n]/.test(key))throw new TypeError('変数名が不正です。');const rows=resolveRows(true),meta=object(metadata);if(Object.hasOwn(meta,'key')||Object.hasOwn(meta,'value'))throw new TypeError('key と value は個別の引数で指定してください。');const next={key,value:text(value),enabled:true,...meta},found=rows.findLast(row=>row.key===key);if(found){Object.assign(found,next);if(!Object.hasOwn(meta,'disabled'))found.disabled=false;}else rows.push(next);return next.value;});},
    unset(key){return mutate(()=>{const rows=resolveRows(false)||[],before=rows.length;for(let at=rows.length-1;at>=0;at--)if(rows[at].key===String(key))rows.splice(at,1);return rows.length!==before;});},
    clear(){return mutate(()=>{const rows=resolveRows(false)||[],count=rows.length;rows.splice(0);return count;});},
    toObject(){checkActive();return Object.fromEntries((resolveRows(false)||[]).filter(row=>row.enabled!==false&&row.disabled!==true&&row.key).map(row=>[row.key,text(row.value)]));}
  };}
  function entityAPI(root,defaults,validator){return {
    ...entityAccess(reference=>choose(listRoot(root),reference,root)),
    list(){checkActive();return copy(listRoot(root));},
    create(spec={}){return mutate(()=>{spec=object(spec);if(Object.hasOwn(spec,'id'))throw new TypeError('IDは自動生成されます。');const value={...defaults(),...spec,id:id()};validator?.(value);ensureRoot(root).push(value);return value;});},
    update(reference,spec){return mutate(()=>{const value=choose(listRoot(root),reference,root);patch(value,spec,['id']);validator?.(value);return value;});},
    delete(reference){return mutate(()=>{const value=choose(listRoot(root),reference,root);state[root].splice(state[root].indexOf(value),1);if(root==='environments'&&state.environmentId===value.id)state.environmentId='';return true;});}
  };}
  const api={workspace:{read(){checkActive();return copy(state);}}};
  function collectionSnapshot(next,before){
    if(Object.hasOwn(next,'info')&&!record(next.info))throw new TypeError('info はオブジェクトで指定してください。');
    const hasName=Object.hasOwn(next,'name'),hasInfoName=Object.hasOwn(next.info||{},'name');
    if(!hasName&&!hasInfoName)throw new TypeError('コレクション名を指定してください。');
    if(hasName)name(next.name);if(hasInfoName)name(next.info.name);
    const aliasChanged=hasName&&next.name!==before.name,infoChanged=hasInfoName&&next.info.name!==before.info.name;
    if(aliasChanged&&infoChanged&&next.name!==next.info.name)throw new TypeError('name と info.name に同じコレクション名を指定してください。');
    const label=aliasChanged?next.name:infoChanged?next.info.name:hasName?next.name:next.info.name;
    next.info||={};field(next.info,'name',label);delete next.name;return next;
  }
  api.collections={
    ...entityAccess(reference=>choose(collections(),reference,'コレクション'),{view:descriptor,target:entry=>entry.node,blocked:['id','_mpId','item'],normalize:collectionSnapshot}),
    list(){checkActive();return collections().map(descriptor);},
    create(spec={}){return mutate(()=>{spec=object(spec);if(['id','_mpId','item'].some(key=>Object.hasOwn(spec,key)))throw new TypeError('IDと子項目は各作成APIで設定してください。');const {name:label='新しいコレクション',...rest}=spec,node={...rest,_mpId:id(),info:{schema:'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',...rest.info,name:name(label)},item:[]};ensureRoot('collections').push(node);return descriptor(collections().find(entry=>entry.node===node));});},
    update(reference,spec){return mutate(()=>{const entry=choose(collections(),reference,'コレクション'),next=object(spec);if(Object.hasOwn(next,'name')){entry.node.info.name=name(next.name);delete next.name;}patch(entry.node,next,['id','_mpId','item']);return descriptor(collections().find(value=>value.id===entry.id));});},
    delete(reference){return mutate(()=>{const entry=choose(collections(),reference,'コレクション');state.collections.splice(state.collections.indexOf(entry.node),1);state.tabs=(state.tabs||[]).filter(tab=>tab.collectionId!==entry.id);return true;});},
    variables(reference){return variables(create=>{const node=choose(collections(),reference,'コレクション').node;return node.variable||(create?(node.variable=[]):[]);});}
  };
  function itemSnapshot(next,before){
    name(next.name);
    if(before.ribbonState&&next.ribbonState&&next.ribbonState.id!==before.ribbonState.id)throw new TypeError('ribbonState.id は変更できません。');
    if(record(next.request)&&record(before.request)&&Object.hasOwn(next.request,'url')&&!same(next.request.url,before.request.url)){
      const request={url:copy(before.request.url)},editor=createRequestEditor({read:()=>request,change:callback=>callback(request)});
      editor.set('url',next.request.url);next.request.url=editor.get().url;
    }
    return next;
  }
  function itemAPI(kind){const folders=kind==='folders',entries=folders?folderRows:requestRows;return {
    ...entityAccess(reference=>choose(entries(),reference,folders?'フォルダー':'リクエスト'),{view:descriptor,target:entry=>entry.node,blocked:['id','_mpId','item','collectionId','itemId','draftId','parentId','path',...(folders?['request']:[])],normalize:itemSnapshot}),
    list(){checkActive();return entries().map(descriptor);},
    create(spec){return mutate(()=>{spec=object(spec);const destination=parent(spec.parent),node={_mpId:id(),name:name(spec.name||(folders?'新しいフォルダー':'新しいリクエスト'))};for(const [key,value] of Object.entries(spec))if(!['parent','id','_mpId','name'].includes(key))field(node,key,copy(value));if(folders){if(node.request)throw new TypeError('フォルダーに request は設定できません。');node.item=[];}else{if(node.item)throw new TypeError('リクエストに item は設定できません。');node.request={...newRequest(),...object(spec.request||{})};node.settings={verify_tls:false,follow_redirects:true,timeout_ms:30000,...spec.settings};}destination.items.push(node);return descriptor(tree().find(entry=>entry.node===node));});},
    update(reference,spec){return mutate(()=>{const entry=choose(entries(),reference,kind);patch(entry.node,spec,['id','_mpId','item','collectionId','itemId','draftId','parentId','path']);if(Object.hasOwn(spec,'name'))name(entry.node.name);return descriptor(entries().find(value=>value.node===entry.node));});},
    delete(reference){return mutate(()=>{const entry=choose(entries(),reference,kind);if(entry.draftId){state.tabs.splice(state.tabs.indexOf(entry.node),1);}else{const removed=new Set(tree().filter(value=>value.node===entry.node||value.parents.includes(entry.node)).map(value=>value.id));entry.siblings.splice(entry.siblings.indexOf(entry.node),1);state.tabs=(state.tabs||[]).filter(tab=>!removed.has(`${tab.collectionId}:${tab.itemId}`));}return true;});},
    move(reference,parentRef){return mutate(()=>{const entry=choose(entries(),reference,kind),destination=parent(parentRef);if(entry.draftId)throw new Error('下書きを保存するには requests.create を使用してください。');if(destination.entry.node===entry.node||destination.entry.parents?.includes(entry.node))throw new Error('自分自身または子フォルダーへ移動できません。');const nodes=[entry.node,...tree().filter(row=>row.parents.includes(entry.node)).map(row=>row.node)];transferReferences(entry,destination,nodes);entry.siblings.splice(entry.siblings.indexOf(entry.node),1);destination.items.push(entry.node);return descriptor(tree().find(value=>value.node===entry.node));});}
  };}
  api.folders=itemAPI('folders');api.folders.variables=reference=>variables(create=>{const node=choose(folderRows(),reference,'フォルダー').node;return node.variable||(create?(node.variable=[]):[]);});
  api.requests=itemAPI('requests');
  function requestEditor(reference){
    checkActive();const referenceId=requestEntry(reference).id;
    return createRequestEditor({checkActive,read:()=>requestEntry(referenceId).node.request,change:callback=>mutate(()=>callback(requestEntry(referenceId).node.request))});
  }
  api.requests.edit=requestEditor;
  api.requests.clone=(reference,options={})=>mutate(()=>{const entry=requestEntry(reference),spec=object(options),node=copy(entry.node);node.name=spec.name===undefined?`${node.name} コピー`:name(spec.name);if(node.ribbonState)node.ribbonState.id=id();if(entry.draftId&&!spec.parent){node.id=id();delete node.collectionId;delete node.itemId;ensureRoot('tabs').push(node);return descriptor(draftRows().find(value=>value.node===node));}node._mpId=id();delete node.id;const destination=parent(spec.parent||entry.parentId);destination.items.push(node);return descriptor(tree().find(value=>value.node===node));});
  api.drafts={
    list(){checkActive();return draftRows().map(descriptor);},get(reference,path){checkActive();return api.requests.get(choose(draftRows(),reference,'下書き').id,path);},
    set(reference,...args){checkActive();return api.requests.set(choose(draftRows(),reference,'下書き').id,...args);},
    edit(reference){checkActive();return requestEditor(choose(draftRows(),reference,'下書き').id);},
    create(spec={}){return mutate(()=>{spec=object(spec);if(['id','collectionId','itemId'].some(key=>Object.hasOwn(spec,key)))throw new TypeError('下書きのIDは自動生成されます。');const node={name:'新しいリクエスト',...spec,id:id(),request:{...newRequest(),...spec.request},settings:{verify_tls:false,follow_redirects:true,timeout_ms:30000,...spec.settings},dirty:true};ensureRoot('tabs').push(node);return descriptor(draftRows().find(value=>value.node===node));});},
    update(reference,spec){return api.requests.update(choose(draftRows(),reference,'下書き').id,spec);},delete(reference){return api.requests.delete(choose(draftRows(),reference,'下書き').id);}
  };
  api.environments=entityAPI('environments',()=>({name:'新しい環境',values:[]}),value=>validateRows(value.values));
  api.environments.variables=reference=>variables(create=>choose(listRoot('environments'),reference,'環境').values);
  api.environments.active=()=>{checkActive();const value=listRoot('environments').find(row=>row.id===state.environmentId);return value?copy(value):null;};
  api.environments.activate=reference=>mutate(()=>{state.environmentId=reference===null?'':choose(listRoot('environments'),reference,'環境').id;return state.environmentId;});
  api.scripts=entityAPI('scripts',()=>({name:'新しいスクリプト',source:'',input:'null',inputFormat:'json',timeoutMs:0}),validateScript);
  api.relations=entityAPI('relations',()=>({name:'新しいリレーション',repeat:1,intervalMs:0,maxExecutions:0,stopOnError:true,steps:[]}),validateRelationShape);
  api.environment=variables(create=>{const selected=listRoot('environments').find(value=>value.id===environmentId);if(!selected&&create)throw new Error('環境を書き換えるには環境を選択してください。');return selected?.values||[];});
  api.globals=variables(create=>state.globals||(create?(state.globals=[]):[]));
  function ribbonAPI(reference=requestRef){
    const getState=create=>{const selected=owner(reference);if(!selected){if(create)throw new Error('リボンを編集するリクエストを指定してください。');return null;}return selected.ribbonState||(create?(selected.ribbonState={id:id(),ribbons:[],activeRibbonId:'',ribbonBindings:{}}):null);};
    const select=ref=>choose(getState(false)?.ribbons||[],ref,'リボン');
    function nested(resolve,defaults,blocked=[]){return {
      ...entityAccess(ref=>choose(resolve(false)||[],ref,'リボン項目'),{blocked:['id',...blocked]}),
      list(){checkActive();return copy(resolve(false)||[]);},
      create(spec={}){return mutate(()=>{spec=object(spec);if(Object.hasOwn(spec,'id'))throw new TypeError('IDは自動生成されます。');const value={...defaults(spec),...spec,id:id()};resolve(true).push(value);return value;});},
      update(ref,spec){return mutate(()=>{const value=choose(resolve(false)||[],ref,'リボン項目');patch(value,spec,['id',...blocked]);return value;});},
      delete(ref){return mutate(()=>{const rows=resolve(false)||[],value=choose(rows,ref,'リボン項目');rows.splice(rows.indexOf(value),1);const current=getState(false);if(current?.activeRibbonId===value.id)current.activeRibbonId='';return true;});}
    };}
    const api=nested(create=>getState(create)?.ribbons||[],()=>({key:`ribbon_${id().replace(/[^A-Za-z0-9]/g,'').slice(-12)}`,name:'新しいリボン',groups:[]}));
    api.forRequest=ref=>ribbonAPI(requestEntry(ref).id);
    api.groups=ref=>nested(()=>select(ref).groups,()=>({name:'グループ',controls:[]}));
    api.controls=(ref,groupRef)=>nested(()=>choose(select(ref).groups,groupRef,'グループ').controls,spec=>{const type=spec.type||'button';return {key:`control_${id().replace(/[^A-Za-z0-9]/g,'').slice(-12)}`,label:'項目',type,value:type==='number'?0:type==='toggle'?false:type==='button'?null:'',options:[],visible:true,enabled:true,actions:[]};});
    return api;
  }
  api.ribbons=ribbonAPI();
  const settingKeys=new Set(['theme','editorSettings','settings']);
  const settingsSnapshot=()=>Object.fromEntries([...settingKeys].filter(key=>Object.hasOwn(state,key)).map(key=>[key,copy(state[key])]));
  function settingPath(path){const parts=path===undefined?[]:pathParts(path);if(parts.length&&!settingKeys.has(parts[0]))throw new TypeError('不明なワークスペース設定です。');return parts;}
  function checkSettings(spec){for(const key of Object.keys(spec)){if(!settingKeys.has(key))throw new TypeError(`変更できない設定です: ${key}`);if(key==='theme'&&!['light','dark'].includes(spec[key]))throw new TypeError('theme は light / dark で指定してください。');}}
  api.settings={
    get(path){checkActive();return copy(atPath(settingsSnapshot(),settingPath(path)));},
    set(...args){
      if(args.length!==1&&args.length!==2)throw new TypeError('値、またはパスと値を指定してください。');
      const parts=args.length===2?settingPath(args[0]):[];
      mutate(()=>{const next=object(withPath(settingsSnapshot(),parts,args.at(-1)));checkSettings(next);if(Object.hasOwn(next,'settings'))validateSettings(next.settings);if(Object.hasOwn(next,'editorSettings'))object(next.editorSettings,'エディター設定');for(const key of settingKeys)if(Object.hasOwn(next,key))field(state,key,copy(next[key]));else delete state[key];});
      return copy(atPath(settingsSnapshot(),parts));
    },
    update(spec){return mutate(()=>{spec=object(spec);checkSettings(spec);patch(state,spec);return api.settings.get();});}
  };
  api.history={list(){checkActive();return copy(listRoot('history'));},get(ref){checkActive();return copy(choose(listRoot('history'),ref,'送信履歴'));},delete(ref){return mutate(()=>{const value=choose(listRoot('history'),ref,'送信履歴');state.history.splice(state.history.indexOf(value),1);return true;});},clear(){return mutate(()=>{const count=listRoot('history').length;state.history=[];return count;});}};
  return {state,api,validate,owner,getRibbonState(reference=requestRef){return owner(reference)?.ribbonState||null;},
    contextVariables(reference,primary={},fallback){const values={};const apply=rows=>{for(const row of rows||[])if(row.key&&row.enabled!==false&&row.disabled!==true)field(values,row.key,text(row.value));};apply(state.globals);let selected;
      if(reference){try{selected=requestEntry(reference);}catch{}}
      if(!selected&&fallback?.request){const folder=tree().find(entry=>entry.collectionId===fallback.collectionId&&entry.itemId===fallback.pendingFolderId&&Array.isArray(entry.node.item));selected={collectionId:fallback.collectionId,parents:folder?[...folder.parents,folder.node]:[],node:{request:fallback.request}};}
      if(selected?.collectionId){apply(collections().find(row=>row.id===selected.collectionId)?.node.variable);for(const parent of selected.parents||[])apply(parent.variable);}
      apply(listRoot('environments').find(row=>row.id===environmentId)?.values);apply(selected?.node.request?.url?.variable);for(const [key,value]of Object.entries(primary))field(values,key,text(value));return values;
    },
    apply(changes){return mutate(()=>{applyWorkspaceChanges(state,changes);return true;});}};
}
