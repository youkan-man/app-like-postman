/** Whole-workspace import/export owns data compatibility; revision behavior is owned by revisions.mjs. */
import {clone, uid} from './core.mjs';
export const BUNDLE_KIND = 'minipost.workspace';
export const BUNDLE_VERSION = 1;
const safeClone = value => clone(value ?? null);
function visit(items, fn) {
  for (const item of items || []) {
    fn(item);
    if (Array.isArray(item.item)) visit(item.item, fn);
  }
}
export function exportWorkspace(ws, layout = null) {
  return {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exported_at: new Date().toISOString(),
    workspace: safeClone(ws),
    layout: layout && typeof layout === 'object' ? safeClone(layout) : null
  };
}
export function isWorkspaceBundle(input) {
  return !!(input && typeof input === 'object' && input.kind === BUNDLE_KIND);
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' && id.length > 0 && !id.includes(':') && id !== '__proto__';
const request = value => record(value) && typeof value.method === 'string' && value.url != null;
function validItems(items, depth = 0) {
  if (!Array.isArray(items) || depth > 40) return false;
  return items.every(item => record(item) && validId(item._mpId) && typeof item.name === 'string' &&
    (Array.isArray(item.item) ? validItems(item.item, depth + 1) : request(item.request)));
}
function validRevisions(map) {
  if (map == null) return true;
  if (!record(map)) return false;
  for (const [key, entries] of Object.entries(map)) {
    if (key !== 'globals' && !/^(?:environment|collection|folder|request|draft|relation):[^:]+(?::[^:]+)?$/.test(key)) return false;
    if (!Array.isArray(entries) || !entries.every(entry => record(entry) && (record(entry.value) || (Object.hasOwn(entry, 'before') && Object.hasOwn(entry, 'after'))))) return false;
  }
  return true;
}
function validRelations(relations) {
  return relations == null || (Array.isArray(relations) && relations.every(r => record(r) && validId(r.id) && typeof r.name === 'string' && Array.isArray(r.steps) && r.steps.every(s => record(s) && validId(s.id))));
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
    (ws.environmentId == null || typeof ws.environmentId === 'string') &&
    validRelations(ws.relations) && (ws.relationRuns == null || Array.isArray(ws.relationRuns)) && validRevisions(ws.revisions) && validRevisions(ws.settingHistory);
}
export function readWorkspaceBundle(input) {
  const obj = typeof input === 'string' ? JSON.parse(input) : input;
  if (!isWorkspaceBundle(obj) || obj.version !== BUNDLE_VERSION)
    throw new Error('MiniPost全体バックアップの形式またはバージョンが不正です。');
  const ws = obj.workspace;
  if (!validWorkspace(ws))
    throw new Error('保存されたワークスペースの構造が不正です。');
  return {workspace: safeClone(ws), layout: obj.layout && typeof obj.layout === 'object' ? safeClone(obj.layout) : null};
}
export function mergeWorkspace(into, source) {
  // Regenerate external IDs to avoid silently overwriting existing entities.
  const ids = new Map(), remap = id => {
    if (!id) return id;
    if (!ids.has(id)) ids.set(id, uid());
    return ids.get(id);
  };
  const imported = safeClone(source);
  imported.collections.forEach(c => {
    c._mpId = remap(c._mpId);
    visit(c.item, item => {item._mpId = remap(item._mpId);});
  });
  imported.environments.forEach(e => {e.id = remap(e.id);});
  imported.tabs.forEach(t => {
    t.id = remap(t.id); t.itemId = remap(t.itemId); t.collectionId = remap(t.collectionId);
    t.pendingFolderId = remap(t.pendingFolderId);
  });
  imported.history.forEach(h => {
    h.id = remap(h.id); h.environmentId = remap(h.environmentId);
    if (h.tab) {
      h.tab.id = remap(h.tab.id); h.tab.collectionId = remap(h.tab.collectionId);
      h.tab.itemId = remap(h.tab.itemId);
    }
  });
  for (const relation of imported.relations || []) {
    relation.id = remap(relation.id); relation.environmentId = remap(relation.environmentId);
    for (const step of relation.steps) {
      step.id = remap(step.id); step.collectionId = remap(step.collectionId); step.itemId = remap(step.itemId); step.draftId = remap(step.draftId);
      if (step.onTrue && !step.onTrue.startsWith('$')) step.onTrue = remap(step.onTrue);
      if (step.onFalse && !step.onFalse.startsWith('$')) step.onFalse = remap(step.onFalse);
    }
  }
  for (const run of imported.relationRuns || []) {
    run.id = remap(run.id); run.relationId = remap(run.relationId);
    for (const entry of run.entries || []) {entry.stepId = remap(entry.stepId);if (entry.branch?.target && !entry.branch.target.startsWith('$')) entry.branch.target = remap(entry.branch.target);}
  }
  into.relations ||= []; into.relations.push(...(imported.relations || []));
  into.relationRuns ||= []; into.relationRuns.push(...(imported.relationRuns || []));
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
      if (parts[0] === 'relation') for (const entry of values) {const value=entry.value;if(value){value.environmentId=remap(value.environmentId);for(const step of value.steps || []){step.id=remap(step.id);step.collectionId=remap(step.collectionId);step.itemId=remap(step.itemId);step.draftId=remap(step.draftId);for(const field of ['onTrue','onFalse'])if(step[field] && !step[field].startsWith('$'))step[field]=remap(step[field]);}}}
      if (renamed === 'globals') {
        into[property].globals = [...(into[property].globals || []), ...values];
      } else into[property][renamed] = values;
    }
  }
  if (!into.environmentId && imported.environmentId) into.environmentId = remap(imported.environmentId);
  if (!into.activeId && imported.activeId) into.activeId = remap(imported.activeId);
  return into;
}
