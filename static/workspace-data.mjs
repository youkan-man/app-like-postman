/** Whole-workspace import/export owns data compatibility; revision behavior is owned by revisions.mjs. */
import {clone, uid} from './core.mjs';
import {validScripts, validScriptData, validScriptBindings} from './scripts.mjs';
import {validRibbonWorkspace, listRibbonControls, resolveRibbon, resolveRibbonControl} from './ribbons.mjs';
import {walkRelationSteps} from './relations.mjs';
import {visitRequestRelations,validRelationDefinition,validRelationSteps} from './relation-requests.mjs';
import {isPackedWorkspaceBundle, unpackWorkspaceBundle} from './workspace-codec.mjs';
export const BUNDLE_KIND = 'minipost.workspace';
export const BUNDLE_VERSION = 1;
const safeClone = value => clone(value ?? null);
function visit(items, fn) {
  for (const item of items || []) {
    fn(item);
    if (Array.isArray(item.item)) visit(item.item, fn);
  }
}
export function exportWorkspace(ws, layout = null, {copy = true} = {}) {
  return {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exported_at: new Date().toISOString(),
    workspace: copy ? safeClone(ws) : ws,
    layout: layout && typeof layout === 'object' ? (copy ? safeClone(layout) : layout) : null
  };
}
export function isWorkspaceBundle(input) {
  return !!(input && typeof input === 'object' && (input.kind === BUNDLE_KIND || isPackedWorkspaceBundle(input)));
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' && id.length > 0 && !id.includes(':') && id !== '__proto__';
const request = value => record(value) && (value.type === undefined || ['http','relation'].includes(value.type)) &&
  (value.type === 'relation' ? validRelationDefinition(value.relation) : typeof value.method === 'string' && value.url != null) &&
  (value.relation === undefined || validRelationDefinition(value.relation)) &&
  ['beforeScriptId','afterScriptId','scriptBindingId'].every(key => value._minipost?.[key] === undefined || typeof value._minipost[key] === 'string');
function validItems(items, depth = 0) {
  if (!Array.isArray(items) || depth > 40) return false;
  return items.every(item => record(item) && validId(item._mpId) && typeof item.name === 'string' &&
    (Array.isArray(item.item) ? validItems(item.item, depth + 1) : request(item.request)));
}
function validRevisions(map) {
  if (map == null) return true;
  if (!record(map)) return false;
  for (const [key, entries] of Object.entries(map)) {
    if (key !== 'globals' && !/^(?:environment|collection|folder|request|draft|relation|script):[^:]+(?::[^:]+)?$/.test(key)) return false;
    if (!Array.isArray(entries) || !entries.every(entry => record(entry) && (record(entry.value) || (Object.hasOwn(entry, 'before') && Object.hasOwn(entry, 'after'))))) return false;
    if (key.startsWith('relation:') && entries.some(entry => [entry.value,entry.before,entry.after].some(value =>
      record(value) && value.steps !== undefined && !validRelationSteps(value.steps)))) return false;
    if (/^(request|draft):/.test(key) && entries.some(entry => [entry.value,entry.before,entry.after].some(value => {
      const payload=value?.request||value;
      return record(payload) && (payload.type==='relation'||payload.relation!==undefined) && !request(payload);
    }))) return false;
  }
  return true;
}
function validRelations(relations) {
  if (relations == null) return true;
  const ids = new Set();
  return Array.isArray(relations) && relations.every(relation => {
    if (!record(relation) || !validId(relation.id) || ids.has(relation.id) || typeof relation.name !== 'string') return false;
    ids.add(relation.id);
    return validRelationSteps(relation.steps);
  });
}
function validRelationRequestIds(workspace) {
  const ids=new Set(),saved=new Set();let valid=true;
  const check=owner=>{
    const id=owner.request?.relation?.id;if(!id)return;
    if(ids.has(id))valid=false;else ids.add(id);
  };
  for(const collection of workspace.collections||[])visit(collection.item,item=>{
    if(item.request){saved.add(`${collection._mpId}:${item._mpId}`);check(item);}
  });
  for(const tab of workspace.tabs||[])if(!saved.has(`${tab.collectionId}:${tab.itemId}`))check(tab);
  return valid;
}
function validWorkspace(ws) {
  return record(ws) && ws.version === 2 &&
    Array.isArray(ws.collections) && ws.collections.every(c =>
      record(c) && validId(c._mpId) && record(c.info) &&
      typeof c.info.name === 'string' && validItems(c.item)) &&
    Array.isArray(ws.environments) && ws.environments.every(e =>
      record(e) && validId(e.id) && typeof e.name === 'string' && Array.isArray(e.values)) &&
    Array.isArray(ws.globals) && ws.globals.every(record) &&
    Array.isArray(ws.tabs) && ws.tabs.every(t =>
      record(t) && validId(t.id) && typeof t.name === 'string' && request(t.request)) &&
    Array.isArray(ws.history) && ws.history.every(h => record(h) && record(h.tab) &&
      request(h.tab.request) && typeof h.tab.name === 'string') &&
    (ws.collapsed == null || Array.isArray(ws.collapsed)) &&
    (ws.activeId == null || typeof ws.activeId === 'string') &&
    (ws.activeRequest == null || (record(ws.activeRequest) && validId(ws.activeRequest.collectionId) && validId(ws.activeRequest.itemId))) &&
    (ws.environmentId == null || typeof ws.environmentId === 'string') &&
    (ws.scripts === undefined || validScripts(ws.scripts)) && (ws.scriptData === undefined || validScriptData(ws.scriptData)) &&
    (ws.scriptBindings === undefined || validScriptBindings(ws.scriptBindings)) &&
    validRibbonWorkspace(ws) &&
    validRelations(ws.relations) && validRelationRequestIds(ws) && (ws.relationRuns == null || Array.isArray(ws.relationRuns)) && validRevisions(ws.revisions) && validRevisions(ws.settingHistory);
}
export function readWorkspaceBundle(input) {
  const obj = unpackWorkspaceBundle(typeof input === 'string' ? JSON.parse(input) : input);
  if (!isWorkspaceBundle(obj) || obj.version !== BUNDLE_VERSION)
    throw new Error('MiniPost全体バックアップの形式またはバージョンが不正です。');
  const ws = obj.workspace;
  if (!validWorkspace(ws))
    throw new Error('保存されたワークスペースの構造が不正です。');
  return {workspace: safeClone(ws), layout: obj.layout && typeof obj.layout === 'object' ? safeClone(obj.layout) : null};
}
function scriptReferences(scripts, remap) {
  const names = new Map(), references = new Map();
  for (const script of scripts) {
    references.set(script.id,remap(script.id));
    names.set(script.name,names.has(script.name) ? null : script.id);
  }
  for (const [name,id] of names) if (id && !references.has(name)) references.set(name,remap(id));
  return Object.fromEntries(references);
}
function visitScriptOwners(workspace, requestFn, scriptRevisionFn) {
  for (const collection of workspace.collections || []) visit(collection.item,item=>requestFn(item.request));
  for (const tab of workspace.tabs || []) requestFn(tab.request);
  for (const entry of workspace.history || []) requestFn(entry.tab?.request);
  for (const property of ['revisions','settingHistory']) for (const [key,entries] of Object.entries(workspace[property] || {})) {
    for (const entry of entries) for (const value of [entry.value,entry.before,entry.after]) {
      if (/^(request|draft):/.test(key)) requestFn(value?.request || value);
      else if (key.startsWith('script:') && record(value) && typeof value.source === 'string') scriptRevisionFn(value);
    }
  }
}
function visitRibbonOwners(workspace, fn) {
  for (const collection of workspace.collections || []) visit(collection.item,item=>{if(item.request)fn(item);});
  for (const tab of workspace.tabs || []) fn(tab);
  for (const entry of workspace.history || []) if (entry.tab) fn(entry.tab);
  for (const property of ['revisions','settingHistory']) for (const [key,entries] of Object.entries(workspace[property] || {})) {
    if (!/^(request|draft):/.test(key)) continue;
    for (const entry of entries) for (const value of [entry.value,entry.before,entry.after]) if (record(value)) fn(value);
  }
}
function bindRequest(request, bindingFor) {
  const config=request?._minipost;
  if (config && (config.scriptBindingId || config.before || config.after)) config.scriptBindingId=bindingFor(config.scriptBindingId || '');
}
/** Fix existing unambiguous calls before adding same-name imports to the catalog. */
function preserveScriptBindings(workspace) {
  const references=scriptReferences(workspace.scripts || [],id=>id),bindings=workspace.scriptBindings ||= {};
  let defaultId;
  for (const id of Object.keys(bindings)) bindings[id]={...references,...bindings[id]};
  const bindingFor=id=>{
    if (id) return id;
    if (!defaultId) {defaultId=uid();bindings[defaultId]={...references};}
    return defaultId;
  };
  for (const script of workspace.scripts || []) if (!script.bindingId) script.bindingId=bindingFor('');
  visitScriptOwners(workspace,request=>bindRequest(request,bindingFor),value=>{if(!value.bindingId)value.bindingId=bindingFor('');});
}
function uniqueReferences(entries) {
  const result=new Map();
  for (const [reference,id] of entries) {
    if (!result.has(reference)) result.set(reference,id);
    else if (result.get(reference)!==id) result.set(reference,null);
  }
  return [...result].filter(([,id])=>id!==null);
}
/** Keep the exact ribbon references visible to each pre-import script group. */
function ribbonReferences(workspace,remap) {
  const ribbons=workspace.ribbons || [],controls=listRibbonControls(workspace);
  const ribbonAliases=uniqueReferences(ribbons.flatMap(ribbon=>[[ribbon.key,ribbon.id],[ribbon.name,ribbon.id]]));
  const controlAliases=uniqueReferences(controls.map(row=>[row.control.key,row.control.id]));
  return {
    ribbons:Object.fromEntries([...ribbonAliases,...ribbons.map(ribbon=>[ribbon.id,ribbon.id])].map(([reference,id])=>[reference,remap(id)])),
    controls:Object.fromEntries([...controlAliases,...controls.map(row=>[row.reference,row.control.id]),...controls.map(row=>[row.control.id,row.control.id])].map(([reference,id])=>[reference,remap(id)]))
  };
}
function preserveRibbonBindings(workspace) {
  const references=ribbonReferences(workspace,id=>id),bindings=workspace.ribbonBindings ||= {};
  const bindingIds=new Set([...Object.keys(workspace.scriptBindings || {}),...Object.keys(bindings)]);
  for (const id of bindingIds) bindings[id]={
    ribbons:{...references.ribbons,...bindings[id]?.ribbons},controls:{...references.controls,...bindings[id]?.controls}
  };
}
function remapRibbonDefinitions(imported,original,into,remap) {
  const keys=new Set((into.ribbons || []).map(ribbon=>ribbon.key));
  const controlRef=(reference,ribbonId)=>{
    if (!reference) return reference;
    try {return remap(resolveRibbonControl(original,reference,{ribbonId}).control.id);}
    catch {return remap(`missing-ribbon-control:${ribbonId}:${reference}`);}
  };
  const ribbonRef=reference=>{
    if (!reference) return reference;
    try {return remap(resolveRibbon(original,reference).id);}
    catch {return remap(`missing-ribbon:${reference}`);}
  };
  const condition=(value,ribbonId)=>{
    for (const rule of value?.rules || []) if (rule.source==='ribbon') rule.key=controlRef(rule.key,ribbonId);
  };
  for (const ribbon of imported.ribbons || []) {
    const oldId=ribbon.id; ribbon.id=remap(ribbon.id);
    const base=ribbon.key;let suffix=2;
    while(keys.has(ribbon.key))ribbon.key=`${base}_${suffix++}`;
    keys.add(ribbon.key);
    for (const group of ribbon.groups) {
      group.id=remap(group.id);
      for (const control of group.controls) {
        control.id=remap(control.id);condition(control.visibleWhen,oldId);condition(control.enabledWhen,oldId);
        for (const action of control.actions) {
          action.id=remap(action.id);condition(action.when,oldId);
          if (action.type==='script') action.scriptId=remap(action.scriptId);
          else if (action.type==='activate') action.target=ribbonRef(action.target);
          else action.target=controlRef(action.target,oldId);
        }
      }
    }
  }
  if (imported.activeRibbonId) imported.activeRibbonId=remap(imported.activeRibbonId);
}
export function mergeWorkspace(into, source) {
  for (const workspace of [into,source]) {
    if ((workspace.scripts !== undefined && !validScripts(workspace.scripts)) ||
      (workspace.scriptData !== undefined && !validScriptData(workspace.scriptData)) ||
      (workspace.scriptBindings !== undefined && !validScriptBindings(workspace.scriptBindings))) throw new Error('スクリプトまたはスクリプトデータの形式が不正です。');
    if (!validRibbonWorkspace(workspace)) throw new Error('リボンの形式が不正です。');
    if (!validRelations(workspace.relations)) throw new Error('リレーションの形式が不正です。');
    visitRequestRelations(workspace,relation=>{if(!validRelationDefinition(relation))throw new Error('リレーションの形式が不正です。');});
    visitScriptOwners(workspace,payload=>{
      if(record(payload)&&(payload.type!==undefined||payload.relation!==undefined)&&!request(payload))
        throw new Error('リクエストの形式が不正です。');
    },()=>{});
    if(!validRelationRequestIds(workspace))throw new Error('同じIDのリレーションが重複しています。');
  }
  // Regenerate external IDs to avoid silently overwriting existing entities.
  const ids = new Map(), remap = id => {
    if (!id) return id;
    if (!ids.has(id)) ids.set(id, uid());
    return ids.get(id);
  };
  const remapScriptReferences = request => {
    if (!request?._minipost) return;
    for (const key of ['beforeScriptId','afterScriptId']) if (request._minipost[key]) request._minipost[key] = remap(request._minipost[key]);
  };
  const imported = safeClone(source);
  const references=scriptReferences(imported.scripts || [],remap),sourceBindings=imported.scriptBindings || {},bindingIds=new Map(),bindings={};
  const originalRibbons={ribbons:safeClone(imported.ribbons || []),activeRibbonId:imported.activeRibbonId || ''};
  const ribbonRefs=ribbonReferences(originalRibbons,remap),sourceRibbonBindings=imported.ribbonBindings || {},ribbonBindings={};
  const remapBinding=id=>{
    if (!bindingIds.has(id)) {
      const nextId=uid();bindingIds.set(id,nextId);
      const previous=Object.fromEntries(Object.entries(sourceBindings[id] || {}).map(([reference,target])=>[reference,remap(target)]));
      bindings[nextId]={...references,...previous};
      const previousRibbons=sourceRibbonBindings[id] || {};
      ribbonBindings[nextId]=Object.fromEntries(['ribbons','controls'].map(kind=>[kind,{
        ...ribbonRefs[kind],...Object.fromEntries(Object.entries(previousRibbons[kind] || {}).map(([reference,target])=>[reference,remap(target)]))
      }]));
    }
    return bindingIds.get(id);
  };
  for (const id of Object.keys(sourceBindings)) remapBinding(id);
  for (const id of Object.keys(sourceRibbonBindings)) remapBinding(id);
  for (const script of imported.scripts || []) {script.bindingId=remapBinding(script.bindingId || '');script.id = remap(script.id);}
  visitScriptOwners(imported,request=>bindRequest(request,remapBinding),value=>{value.bindingId=remapBinding(value.bindingId || '');});
  const scopeIds=new Map();
  visitRibbonOwners(imported,owner=>{
    const state=owner.ribbonState;if(!state)return;
    if (!scopeIds.has(state.id)) scopeIds.set(state.id,uid());
    state.id=scopeIds.get(state.id);
    // Inner identities are private to the request. Keeping them preserves IDs
    // embedded in script source, conditions and action targets without rewriting code.
    for (const {control} of listRibbonControls(state)) for (const action of control.actions)
      if (action.type==='script' && action.scriptId) action.scriptId=remap(action.scriptId);
    state.ribbonBindings=Object.fromEntries(Object.entries(state.ribbonBindings).map(([id,value])=>[remapBinding(id),value]));
  });
  imported.scriptBindings=bindings;
  imported.ribbonBindings=ribbonBindings;
  remapRibbonDefinitions(imported,originalRibbons,into,remap);
  imported.collections.forEach(c => {
    c._mpId = remap(c._mpId);
    visit(c.item, item => {item._mpId = remap(item._mpId);remapScriptReferences(item.request);});
  });
  imported.environments.forEach(e => {e.id = remap(e.id);});
  imported.tabs.forEach(t => {
    t.id = remap(t.id); t.itemId = remap(t.itemId); t.collectionId = remap(t.collectionId);
    t.pendingFolderId = remap(t.pendingFolderId);
    remapScriptReferences(t.request);
  });
  imported.history.forEach(h => {
    h.id = remap(h.id); h.environmentId = remap(h.environmentId);
    if (h.tab) {
      h.tab.id = remap(h.tab.id); h.tab.collectionId = remap(h.tab.collectionId);
      h.tab.itemId = remap(h.tab.itemId); h.tab.pendingFolderId = remap(h.tab.pendingFolderId);
      remapScriptReferences(h.tab.request);
    }
  });
  function remapRelationValue(relation) {
    if (relation.id) relation.id = remap(relation.id);
    if (relation.environmentId) relation.environmentId = remap(relation.environmentId);
    walkRelationSteps(relation.steps, step => {
      step.id = remap(step.id); step.collectionId = remap(step.collectionId); step.itemId = remap(step.itemId); step.draftId = remap(step.draftId);
      if (step.scriptId) step.scriptId = remap(step.scriptId);
      if (step.onTrue && !step.onTrue.startsWith('$')) step.onTrue = remap(step.onTrue);
      if (step.onFalse && !step.onFalse.startsWith('$')) step.onFalse = remap(step.onFalse);
    });
  }
  for (const relation of imported.relations || []) remapRelationValue(relation);
  visitRequestRelations(imported,remapRelationValue,{revisions:false});
  function remapRelationRun(run) {
    if(!record(run))return;
    run.id = remap(run.id); run.relationId = remap(run.relationId);
    if(run.environmentId)run.environmentId=remap(run.environmentId);
    for (const entry of run.entries || []) {
      entry.stepId = remap(entry.stepId);
      if (entry.branch?.target && !entry.branch.target.startsWith('$')) entry.branch.target = remap(entry.branch.target);
      for(const loop of entry.loops||[])if(loop.stepId)loop.stepId=remap(loop.stepId);
      if(entry.relationRun)remapRelationRun(entry.relationRun);
    }
  }
  for (const run of imported.relationRuns || []) remapRelationRun(run);
  for (const entry of imported.history || []) if(entry.relation_run)remapRelationRun(entry.relation_run);
  preserveScriptBindings(into);
  preserveRibbonBindings(into);
  Object.assign(into.scriptBindings,imported.scriptBindings);
  Object.assign(into.ribbonBindings,imported.ribbonBindings);
  into.ribbons ||= [];into.ribbons.push(...(imported.ribbons || []));
  into.relations ||= []; into.relations.push(...(imported.relations || []));
  into.relationRuns ||= []; into.relationRuns.push(...(imported.relationRuns || []));
  into.scripts ||= []; into.scripts.push(...(imported.scripts || []));
  into.scriptData ||= {};
  for (const [key,value] of Object.entries(imported.scriptData || {})) if (!Object.hasOwn(into.scriptData,key))
    Object.defineProperty(into.scriptData,key,{value,enumerable:true,configurable:true,writable:true});
  into.collections.push(...imported.collections);
  into.environments.push(...imported.environments);
  into.globals.push(...imported.globals);
  into.history.push(...imported.history);
  into.tabs.push(...imported.tabs);
  into.collapsed ||= [];
  into.collapsed.push(...(imported.collapsed || []).map(remap));
  for (const property of ['revisions', 'settingHistory']) {
    into[property] ||= {};
    for (const [key, values] of Object.entries(imported[property] || {})) {
      const parts = key.split(':');
      const renamed = [parts[0], ...parts.slice(1).map(remap)].join(':');
      if (parts[0] === 'relation') for (const entry of values)
        for (const value of [entry.value,entry.before,entry.after]) if (record(value)) remapRelationValue(value);
      if (parts[0] === 'request' || parts[0] === 'draft') for (const entry of values)
        for (const value of [entry.value,entry.before,entry.after]) {
          const payload=value?.request || value;
          remapScriptReferences(payload);
          if(record(payload?.relation))remapRelationValue(payload.relation);
        }
      if (renamed === 'globals') {
        into[property].globals = [...(into[property].globals || []), ...values];
      } else into[property][renamed] = values;
    }
  }
  if (!into.environmentId && imported.environmentId) into.environmentId = remap(imported.environmentId);
  if (!into.activeRequest && !into.activeId && imported.activeRequest) into.activeRequest = {
    collectionId:remap(imported.activeRequest.collectionId), itemId:remap(imported.activeRequest.itemId)
  };
  if (!into.activeId && imported.activeId) into.activeId = remap(imported.activeId);
  if (!into.activeRibbonId && imported.activeRibbonId) into.activeRibbonId=imported.activeRibbonId;
  return into;
}
