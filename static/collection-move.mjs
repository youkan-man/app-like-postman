/** Move existing objects; never duplicate IDs, drafts, files or relation targets. */
import {findItem, walkItems} from './core.mjs';

export function planCollectionMove(workspace, intent) {
  const {collectionId, itemId, targetCollectionId, targetId, position = 'inside'} = intent;
  if (!['before', 'after', 'inside'].includes(position)) throw new Error('移動先の位置が不正です。');
  const source = workspace.collections.find(c => c._mpId === collectionId);
  const target = workspace.collections.find(c => c._mpId === targetCollectionId);
  if (!source || !target) throw new Error('移動元または移動先が削除されています。');
  if (!itemId) {
    if (targetId || position === 'inside') throw new Error('コレクションはコレクションの前後に移動してください。');
    return {item: source, source, target, from: workspace.collections, into: workspace.collections,
      anchor: target, position, nodes: [], collection: true};
  }
  const located = findItem(source, itemId);
  const destination = targetId ? findItem(target, targetId) : null;
  if (!located || (targetId && !destination)) throw new Error('移動する項目が変更されました。');
  const item = located.item, nodes = [item];
  if (item.item) walkItems(item.item, child => nodes.push(child));
  const ids = new Set(nodes.map(node => node._mpId));
  if (source === target && targetId && ids.has(targetId)) throw new Error('自分自身や配下のフォルダーには移動できません。');
  let parent;
  if (position === 'inside') parent = destination?.item || target;
  else {
    if (!destination) throw new Error('コレクション直下へは内部にドロップしてください。');
    parent = destination.parents.at(-1) || target;
  }
  if (!Array.isArray(parent.item)) throw new Error('リクエストの中には移動できません。');
  if (source !== target) {
    let conflict = false;
    walkItems(target.item, node => {if (ids.has(node._mpId)) conflict = true;});
    if (conflict) throw new Error('移動先に同じIDの項目があります。データは変更していません。');
    for (const node of nodes) {
      const kind = node.item ? 'folder' : 'request';
      if (workspace.revisions?.[`${kind}:${target._mpId}:${node._mpId}`])
        throw new Error('移動先に同じIDの変更履歴があります。データは変更していません。');
    }
  }
  return {item, source, target, from: (located.parents.at(-1) || source).item,
    into: parent.item, parent, anchor: destination?.item, position, nodes, ids};
}

export function moveCollectionItem(workspace, intent, {transfer} = {}) {
  const plan = planCollectionMove(workspace, intent);
  const {item, from, into, position, anchor, nodes, source, target, ids} = plan;
  const oldIndex = from.indexOf(item);
  let index = position === 'inside' ? into.length : into.indexOf(anchor) + (position === 'after' ? 1 : 0);
  if (from === into && index > oldIndex) index--;
  if (from === into && index === oldIndex) return {...plan, changed: false, transfers: []};
  const transfers = source !== target && !plan.collection ? nodes.map(node => {
    const kind = node.item ? 'folder' : 'request';
    return {from: `${kind}:${source._mpId}:${node._mpId}`, to: `${kind}:${target._mpId}:${node._mpId}`};
  }) : [];
  from.splice(oldIndex, 1); into.splice(index, 0, item);
  if (transfers.length) {
    const updateReference = ref => {
      if (ref?.collectionId === source._mpId && ids.has(ref.itemId)) ref.collectionId = target._mpId;
    };
    for (const tab of workspace.tabs || []) updateReference(tab);
    for (const relation of workspace.relations || []) for (const step of relation.steps || []) updateReference(step);
    // History contains a snapshot, but its request identity should follow a move.
    for (const entry of workspace.history || []) updateReference(entry.tab);
    for (const pair of transfers) {
      if (transfer) transfer(pair.from, pair.to);
      else if (workspace.revisions && Object.hasOwn(workspace.revisions, pair.from)) {
        workspace.revisions[pair.to] = workspace.revisions[pair.from]; delete workspace.revisions[pair.from];
      }
    }
  }
  return {...plan, changed: true, transfers};
}
