/** Per-setting revisions. Opening/selecting is not an edit. No automatic sends. */
import {clone, uid, rows, normalizeRequest, findItem, walkItems} from './core.mjs';
const defaults = {verify_tls: false, follow_redirects: true, timeout_ms: 30000};
export const requestSettings = value => Object.fromEntries(Object.entries({...defaults, ...value}).filter(([key]) => Object.hasOwn(defaults, key)));
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, sort(value[k])]));
  return value;
}
function normalizeAuth(value) {
  if (!value) return null;
  const auth = clone(value);
  if (auth.type && auth[auth.type]) auth[auth.type] = rows(auth[auth.type]);
  return auth;
}
const scope = owner => ({variable: rows(owner.variable), auth: normalizeAuth(owner.auth)});
const requestValue = owner => {
  const request = normalizeRequest(owner.request);
  request.auth = normalizeAuth(request.auth);
  return {name: owner.name, request, settings: requestSettings(owner.settings)};
};
export function requestKey(workspace, draft) {
  const collection = workspace.collections.find(c => c._mpId === draft.collectionId);
  return findItem(collection, draft.itemId)?.item.request ? `request:${draft.collectionId}:${draft.itemId}` : `draft:${draft.id}`;
}
export function settingsIndex(workspace) {
  const result = new Map();
  const put = (key, kind, name, value, owner) => result.set(key, {key, kind, name, value, owner});
  for (const relation of workspace.relations || []) {const {id,...value}=relation;put(`relation:${id}`, 'relation', relation.name, clone(value), relation);}
  put('globals', 'globals', 'Globals', {values: rows(workspace.globals)}, workspace);
  for (const env of workspace.environments) put(`environment:${env.id}`, 'environment', env.name, {name: env.name, values: rows(env.values)}, env);
  for (const collection of workspace.collections) {
    put(`collection:${collection._mpId}`, 'collection', collection.info.name, {name: collection.info.name, ...scope(collection)}, collection);
    walkItems(collection.item, item => {
      if (item.item) put(`folder:${collection._mpId}:${item._mpId}`, 'folder', item.name, {name: item.name, ...scope(item)}, item);
      else if (item.request) put(`request:${collection._mpId}:${item._mpId}`, 'request', item.name, requestValue(item), item);
    });
  }
  // Legacy tabs are preserved as drafts, not rendered as open tabs.
  for (const draft of workspace.tabs) put(requestKey(workspace, draft), 'request', draft.name, requestValue(draft), draft);
  return result;
}
export class RevisionStore {
  constructor(workspace) {
    this.workspace = workspace;
    if (!workspace.revisions || typeof workspace.revisions !== 'object' || Array.isArray(workspace.revisions)) workspace.revisions = {};
    this.previous = new Map([...settingsIndex(workspace)].map(([key, row]) => [key, clone(row.value)]));
  }
  capture(reason = '変更') {
    for (const [key, row] of settingsIndex(this.workspace)) {
      const before = this.previous.get(key);
      if (canonical(before) === canonical(row.value)) continue;
      const entries = Array.isArray(this.workspace.revisions[key]) ? this.workspace.revisions[key] : (this.workspace.revisions[key] = []);
      const at = new Date().toISOString();
      if (!entries.length && before !== undefined) entries.push({id: uid(), at, reason: '変更前', changed: [], value: clone(before)});
      entries.push({id: uid(), at, reason: before === undefined ? '作成' : reason,
        changed: Object.keys(row.value).filter(k => canonical(before?.[k]) !== canonical(row.value[k])), value: clone(row.value)});
      this.previous.set(key, clone(row.value));
    }
  }
  transfer(from, to) {
    if (from === to) return;
    if (Array.isArray(this.workspace.revisions[from])) this.workspace.revisions[to] = this.workspace.revisions[from];
    delete this.workspace.revisions[from];
    if (this.previous.has(from)) this.previous.set(to, this.previous.get(from));
    this.previous.delete(from);
  }
  restore(key, entry) {
    const row = settingsIndex(this.workspace).get(key);
    if (!row) throw new Error('復元先の設定がありません。');
    this.capture();
    const value = clone(entry.value), owner = row.owner;
    if (row.kind === 'globals') this.workspace.globals = value.values;
    else if (row.kind === 'relation') {const id=owner.id;for(const key of Object.keys(owner))if(key!=='id')delete owner[key];Object.assign(owner,value,{id});}
    else if (row.kind === 'environment') {owner.name = value.name; owner.values = value.values;}
    else if (row.kind === 'request') {
      const [kind, collectionId, itemId] = key.split(':');
      let targets;
      if (kind === 'request') {
        const collection = this.workspace.collections.find(c => c._mpId === collectionId);
        const stored = findItem(collection, itemId)?.item;
        if (!stored?.request) throw new Error('復元先の保存済みリクエストがありません。');
        targets = [stored, ...this.workspace.tabs.filter(tab => tab.collectionId === collectionId && tab.itemId === itemId)];
      } else targets = [owner];
      for (const target of targets) {
        target.name = value.name;
        target.request = clone(value.request);
        target.settings = requestSettings(value.settings);
        if (this.workspace.tabs.includes(target)) target.dirty = kind !== 'request';
      }
    } else {
      if (row.kind === 'collection') owner.info.name = value.name; else owner.name = value.name;
      owner.variable = value.variable; owner.auth = value.auth;
    }
    this.capture('復元');
  }
}
