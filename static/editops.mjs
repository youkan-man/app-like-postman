/** Pure editing operations. Identity and names never leak across copies. */
import {clone, rows, uid} from './core.mjs';

export function copyName(name, names) {
  const base = `${name || 'Untitled'} copy`, used = new Set(names);
  let candidate = base, n = 2;
  while (used.has(candidate)) candidate = `${base} ${n++}`;
  return candidate;
}
export function duplicateItem(item) {
  const copy = clone(item);
  const rekey = node => {
    node._mpId = uid();
    if (Array.isArray(node.item)) node.item.forEach(rekey);
  };
  rekey(copy);
  return copy;
}
export function duplicateCollection(collection, names) {
  const copy = duplicateItem(collection);
  copy.info.name = copyName(collection.info.name, names);
  copy.info._postman_id = uid();
  return copy;
}
export function duplicateEnvironment(environment, names) {
  return {...clone(environment), id: uid(), name: copyName(environment.name, names)};
}
export function snapshotSettings(owner, kind) {
  if (kind === 'environment') return {kind, values: clone(rows(owner.values))};
  if (kind === 'scope') return {kind, variable: clone(rows(owner.variable)), auth: clone(owner.auth ?? null)};
  if (kind === 'request') return {kind, request: clone(owner.request), settings: clone(owner.settings || {})};
  throw new TypeError('Unsupported settings type');
}
export function applySettings(owner, kind, snapshot) {
  if (!snapshot || snapshot.kind !== kind) throw new TypeError('設定の種類が異なります。');
  const value = clone(snapshot);
  if (kind === 'environment') owner.values = value.values;
  else if (kind === 'scope') {owner.variable = value.variable; owner.auth = value.auth;}
  else if (kind === 'request') {owner.request = value.request; owner.settings = value.settings;}
  else throw new TypeError('Unsupported settings type');
}
