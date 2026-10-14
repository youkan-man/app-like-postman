/** Browser-first MiniPost workspace archive and per-setting revision log. */
import {clone, uid} from './core.mjs';
export const BUNDLE_KIND = 'minipost.workspace';
export const BUNDLE_VERSION = 1;
const MAX_REVISIONS = 60;
const DEFAULT_SETTINGS = {verify_tls: false, follow_redirects: true, timeout_ms: 30000};
const safeClone = value => clone(value ?? null);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function visit(items, fn) {
  for (const item of items || []) {
    fn(item);
    if (Array.isArray(item.item)) visit(item.item, fn);
  }
}
function itemById(workspace, id) {
  for (const c of workspace.collections) {
    let found;
    visit(c.item, item => {if (item._mpId === id) found = item;});
    if (found) return found;
  }
  return null;
}
export function settingSnapshots(ws) {
  const result = new Map([['globals', safeClone(ws.globals || [])]]);
  for (const env of ws.environments || []) {
    result.set('environment:' + env.id, {name: env.name, values: safeClone(env.values || [])});
  }
  for (const c of ws.collections || []) {
    result.set('collection:' + c._mpId, {name: c.info?.name || '', variable: safeClone(c.variable || []), auth: safeClone(c.auth)});
    visit(c.item, item => {
      if (Array.isArray(item.item))
        result.set('folder:' + item._mpId, {name: item.name, variable: safeClone(item.variable || []), auth: safeClone(item.auth)});
      else if (item.request)
        result.set('request:' + item._mpId, {name: item.name, request: safeClone(item.request), settings: safeClone(item._mpSettings || DEFAULT_SETTINGS)});
    });
  }
  // The active editor is authoritative for local drafts and unsaved request edits.
  for (const tab of ws.tabs || []) {
    const key = 'request:' + (tab.itemId || tab.id);
    result.set(key, {name: tab.name, request: safeClone(tab.request), settings: safeClone(tab.settings || DEFAULT_SETTINGS)});
  }
  return result;
}
function changedFields(before, after) {
  const fields = [];
  const inspect = (a, b, prefix = '') => {
    for (const key of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
      if (equal(a?.[key], b?.[key])) continue;
      if (prefix === '' && key === 'request' && a?.[key] && b?.[key]) inspect(a[key], b[key], 'request.');
      else fields.push(prefix + key);
    }
  };
  inspect(before, after);
  return fields.slice(0, 12);
}
export function recordSettingsChanges(ws, previous, now = new Date().toISOString()) {
  const next = settingSnapshots(ws);
  ws.settingHistory ||= {};
  for (const [key, after] of next) {
    if (!previous.has(key)) continue;
    const before = previous.get(key);
    if (equal(before, after)) continue;
    const entries = ws.settingHistory[key] ||= [];
    const last = entries[entries.length - 1];
    // A typing burst is a single restorable revision, not one revision per character.
    if (last && Date.parse(now) - Date.parse(last.at) < 1400 && !last.restored) {
      last.at = now;
      last.after = safeClone(after);
      last.fields = changedFields(last.before, after);
    } else {
      entries.push({at: now, before: safeClone(before), after: safeClone(after), fields: changedFields(before, after)});
    }
    if (entries.length > MAX_REVISIONS) entries.splice(0, entries.length - MAX_REVISIONS);
  }
  return next;
}
export function restoreSetting(ws, key, value) {
  const restored = safeClone(value);
  if (key === 'globals') {
    if (!Array.isArray(restored)) throw new Error('Globals履歴が不正です。');
    ws.globals = restored;
  } else if (key.startsWith('environment:')) {
    const obj = ws.environments.find(x => x.id === key.slice(12));
    if (!obj) throw new Error('環境は削除されています。');
    obj.name = restored.name;
    obj.values = restored.values;
  } else if (key.startsWith('collection:')) {
    const obj = ws.collections.find(x => x._mpId === key.slice(11));
    if (!obj) throw new Error('コレクションは削除されています。');
    obj.info.name = restored.name;
    obj.variable = restored.variable;
    obj.auth = restored.auth;
  } else if (key.startsWith('folder:')) {
    const obj = itemById(ws, key.slice(7));
    if (!obj || !Array.isArray(obj.item)) throw new Error('フォルダーは削除されています。');
    obj.name = restored.name; obj.variable = restored.variable; obj.auth = restored.auth;
  } else if (key.startsWith('request:')) {
    const id = key.slice(8), item = itemById(ws, id);
    if (item) {
      item.name = restored.name;
      item.request = restored.request;
      item._mpSettings = restored.settings;
    }
    let found = Boolean(item);
    for (const tab of ws.tabs) if (tab.id === id || tab.itemId === id) {
      tab.name = restored.name; tab.request = safeClone(restored.request);
      tab.settings = safeClone(restored.settings); tab.dirty = false; found = true;
    }
    if (!found) throw new Error('リクエストは削除されています。');
  } else throw new Error('履歴の種類が不明です。');
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
export function readWorkspaceBundle(input) {
  const obj = typeof input === 'string' ? JSON.parse(input) : input;
  if (!isWorkspaceBundle(obj) || obj.version !== BUNDLE_VERSION)
    throw new Error('MiniPost全体バックアップの形式またはバージョンが不正です。');
  const ws = obj.workspace;
  if (!ws || ws.version !== 2 || !Array.isArray(ws.collections) || !Array.isArray(ws.environments)
    || !Array.isArray(ws.globals) || !Array.isArray(ws.tabs) || !Array.isArray(ws.history)
    || (ws.settingHistory && (typeof ws.settingHistory !== 'object' || Array.isArray(ws.settingHistory))))
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
      if (renamed === 'globals') {
        into[property].globals = [...(into[property].globals || []), ...values].slice(-MAX_REVISIONS);
      } else into[property][renamed] = values;
    }
  }
  if (!into.environmentId && imported.environmentId) into.environmentId = remap(imported.environmentId);
  if (!into.activeId && imported.activeId) into.activeId = remap(imported.activeId);
  return into;
}
