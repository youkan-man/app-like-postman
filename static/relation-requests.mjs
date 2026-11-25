/** Relations live in the same saved items and drafts as other request types. */
import {SCHEMA,clone,uid,newRequest,isRelationRequest,normalizeRequest,walkItems,findItem} from './core.mjs';
import {cloneRelationSteps,walkRelationSteps,RELATION_STEP_TYPES} from './relations.mjs';

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validId=value=>typeof value==='string'&&value.length>0&&!value.includes(':')&&value!=='__proto__';

/** Draft blocks may be incomplete, but their tree must always be safe to edit. */
export function validRelationSteps(steps,ids=new Set(),depth=0) {
  if(!Array.isArray(steps)||depth>32)return false;
  return steps.every(step=>{
    if(!record(step)||!validId(step.id)||ids.has(step.id))return false;
    ids.add(step.id);
    const type=step.type||'request';
    if(!RELATION_STEP_TYPES.some(([value])=>value===type))return false;
    if(step.scriptId!==undefined&&typeof step.scriptId!=='string')return false;
    const block=['repeat','forEach','while','if'].includes(type);
    if(block?!validRelationSteps(step.steps,ids,depth+1):step.steps!==undefined)return false;
    if(type==='if'?!validRelationSteps(step.elseSteps,ids,depth+1):step.elseSteps!==undefined)return false;
    return true;
  });
}

export function validRelationDefinition(relation) {
  return record(relation)&&validId(relation.id)&&typeof relation.name==='string'&&validRelationSteps(relation.steps);
}

export function newRelationRequest(name='新しいリレーション',definition={}) {
  const request=newRequest('relation');
  request.relation={...request.relation,...clone(definition),name:String(name)};
  return request;
}

/** Return the editable definition; its owner's request name is authoritative. */
export function relationForRequest(request,name) {
  if(!isRelationRequest(request))return null;
  if(!record(request.relation))request.relation=newRequest('relation').relation;
  if(name!==undefined)request.relation.name=String(name);
  return request.relation;
}

export function relationRequestEntries(workspace,{legacy=true}={}) {
  const result=[],seen=new Set();
  const append=(owner,reference)=>{
    if(!isRelationRequest(owner?.request)||!record(owner.request.relation))return;
    const relation=relationForRequest(owner.request,owner.name);
    result.push({relation,owner,request:owner.request,...reference});seen.add(relation.id);
  };
  for(const collection of workspace.collections||[])walkItems(collection.item,item=>{
    if(item.request)append(item,{collectionId:collection._mpId,itemId:item._mpId});
  });
  for(const tab of workspace.tabs||[]) {
    const collection=(workspace.collections||[]).find(value=>value._mpId===tab.collectionId);
    if(findItem(collection,tab.itemId)?.item.request)continue;
    append(tab,{draftId:tab.id});
  }
  if(legacy)for(const relation of workspace.relations||[])if(!seen.has(relation.id)) {
    result.push({relation,owner:relation,request:null,legacy:true});seen.add(relation.id);
  }
  return result;
}

export function findRelationRequest(workspace,reference) {
  const entries=relationRequestEntries(workspace);
  if(record(reference)) {
    if(reference.draftId)return entries.find(entry=>entry.draftId===reference.draftId)||null;
    if(reference.collectionId&&reference.itemId)return entries.find(entry=>entry.collectionId===reference.collectionId&&entry.itemId===reference.itemId)||null;
    reference=reference.relationId||reference.id||reference.name;
  }
  const exact=entries.find(entry=>entry.relation.id===reference||entry.draftId===reference||
    (entry.draftId&&`draft:${entry.draftId}`===reference)||
    (entry.collectionId&&`${entry.collectionId}:${entry.itemId}`===reference));
  if(exact)return exact;
  const items=entries.filter(entry=>entry.itemId===reference);if(items.length===1)return items[0];
  const named=entries.filter(entry=>entry.owner.name===reference);
  return named.length===1?named[0]:null;
}

/** Copies retain settings, but never share relation or step identities. */
export function duplicateRequest(request,{name,from,to}={}) {
  const copy=clone(request);
  if(record(copy?.relation)) {
    copy.relation.id=uid();copy.relation.steps=cloneRelationSteps(copy.relation.steps||[]);
    if(name!==undefined)copy.relation.name=String(name);
    if(from&&to)walkRelationSteps(copy.relation.steps,step=>{
      const matches=from.draftId?step.draftId===from.draftId:
        !step.draftId&&step.collectionId===from.collectionId&&step.itemId===from.itemId;
      if(!matches)return;
      delete step.draftId;
      Object.assign(step,{collectionId:to.collectionId||'',itemId:to.itemId||''},to.draftId?{draftId:to.draftId}:{});
    });
  }
  return copy;
}

/** Visit saved, draft and historical definitions, including retained type settings. */
export function visitRequestRelations(workspace,visit,{history=true,revisions=true}={}) {
  const seen=new Set(),request=value=>{
    if(record(value?.relation)&&!seen.has(value.relation)){seen.add(value.relation);visit(value.relation);}
  };
  for(const collection of workspace.collections||[])walkItems(collection.item,item=>request(item.request));
  for(const tab of workspace.tabs||[])request(tab.request);
  if(history)for(const entry of workspace.history||[])request(entry.tab?.request);
  if(revisions)for(const property of ['revisions','settingHistory'])for(const [key,entries]of Object.entries(workspace[property]||{}))
    if(/^(?:request|draft):/.test(key))for(const entry of entries)for(const value of [entry.value,entry.before,entry.after])request(value?.request||value);
}

const comparable=value=>JSON.stringify(sort(value));
function sort(value) {
  if(Array.isArray(value))return value.map(sort);
  if(record(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])]));
  return value;
}

/** Legacy catalogs are moved once; existing identities and run logs survive. */
export function ensureRelationRequests(workspace) {
  const legacy=workspace.relations||[];
  if(!legacy.length){workspace.relations=[];return workspace;}
  const existing=relationRequestEntries(workspace,{legacy:false}),byId=new Map(existing.map(entry=>[entry.relation.id,entry]));
  // Check conflicts before changing any saved data.
  for(const relation of legacy) {
    const present=byId.get(relation.id);
    if(present&&comparable(present.relation)!==comparable(normalizeRequest({type:'relation',relation}).relation))
      throw new Error('同じIDのリレーションが重複しています。');
  }
  workspace.collections||=[];
  const used=new Set(workspace.collections.map(collection=>collection._mpId));
  for(const collection of workspace.collections)walkItems(collection.item,item=>used.add(item._mpId));
  let collection=workspace.collections.find(value=>value._minipostRelationMigration===true);
  const relationOwner=new Map();
  for(const relation of legacy) {
    let entry=byId.get(relation.id);
    if(!entry) {
      if(!collection){collection={_mpId:uid(),info:{name:'リレーション',schema:SCHEMA},item:[],_minipostRelationMigration:true};workspace.collections.push(collection);}
      const itemId=used.has(relation.id)?uid():relation.id;used.add(itemId);
      const owner={_mpId:itemId,name:relation.name,request:newRelationRequest(relation.name,relation),settings:{verify_tls:false,follow_redirects:true,timeout_ms:30000}};
      collection.item.push(owner);
      entry={relation:owner.request.relation,owner,request:owner.request,collectionId:collection._mpId,itemId};byId.set(relation.id,entry);
    }
    relationOwner.set(relation.id,entry);
  }
  for(const property of ['revisions','settingHistory']) {
    const archive=workspace[property];if(!record(archive))continue;
    for(const [id,entry]of relationOwner) {
      const oldKey=`relation:${id}`;if(!Array.isArray(archive[oldKey]))continue;
      const key=entry.draftId?`draft:${entry.draftId}`:`request:${entry.collectionId}:${entry.itemId}`;
      const wrap=value=>{
        if(!record(value)||value.request)return value;
        const name=value.name??entry.owner.name;
        return {name,request:newRelationRequest(name,{...value,id}),settings:clone(entry.owner.settings||{})};
      };
      const migrated=archive[oldKey].map(value=>{
        const next=clone(value);for(const field of ['value','before','after'])if(Object.hasOwn(next,field))next[field]=wrap(next[field]);return next;
      });
      const entries=[...migrated,...(archive[key]||[])],seen=new Set();
      archive[key]=entries.filter(value=>{const identity=value.id||comparable(value);if(seen.has(identity))return false;seen.add(identity);return true;})
        .sort((a,b)=>String(a.at||'').localeCompare(String(b.at||'')));
      delete archive[oldKey];
    }
  }
  workspace.relations=[];
  return workspace;
}

/** Repair references wherever a retained relation can later be restored. */
export function remapRequestRelationReferences(workspace,update) {
  visitRequestRelations(workspace,relation=>walkRelationSteps(relation.steps,update));
  for(const relation of workspace.relations||[])walkRelationSteps(relation.steps,update);
}
