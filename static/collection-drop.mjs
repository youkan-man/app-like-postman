/** Pure geometry for one insertion slot per visible boundary. */
import {planCollectionMove} from './collection-move.mjs';

const identity = (collectionId, itemId = '') => JSON.stringify([collectionId, itemId || '']);
const middle = row => (row.top + row.bottom) / 2;

function indexWorkspace(workspace) {
  const nodes = new Map();
  for (const collection of workspace.collections || []) {
    const root = {node: collection, collection, parent: null, list: workspace.collections, ancestors: [], depth: 0};
    nodes.set(identity(collection._mpId), root);
    function visit(items, parent, ancestors) {
      for (const item of items || []) {
        nodes.set(identity(collection._mpId, item._mpId), {
          node: item, collection, parent, list: items, ancestors, depth: ancestors.length,
        });
        if (Array.isArray(item.item)) visit(item.item, item, [...ancestors, item]);
      }
    }
    visit(collection.item, collection, [collection]);
  }
  return nodes;
}

function withoutBlock(rect, blocked) {
  if (!blocked || blocked.bottom <= rect.top || blocked.top >= rect.bottom) return [rect];
  const result = [];
  if (rect.top < blocked.top) result.push({...rect, bottom: blocked.top});
  if (rect.bottom > blocked.bottom) result.push({...rect, top: blocked.bottom});
  return result;
}

/**
 * rows are visible preorder descriptors:
 * {collectionId,itemId,top,bottom,left,right,indentLeft,expanded,...}.
 * Any extra fields (for example element) are preserved through anchor.
 *
 * A target contains {key,kind,intent,anchor,parentId,index,noop,y,left,right,
 * top,bottom,hitRegions}. index is the insertion index AFTER source removal.
 * hitRegions belong to each target, so callers may filter the returned array.
 */
export function buildCollectionDropTargets(workspace, source, rows) {
  const nodes = indexWorkspace(workspace);
  const origin = nodes.get(identity(source.collectionId, source.itemId));
  if (!origin) return [];
  const movingCollection = !source.itemId;
  const seenRows = new Set();
  const visible = rows.filter(row => {
    const key = identity(row.collectionId, row.itemId);
    if (seenRows.has(key) || !nodes.has(key) || ![row.top, row.bottom, row.left, row.right].every(Number.isFinite)
      || row.bottom <= row.top || row.right <= row.left) return false;
    seenRows.add(key); return true;
  }).map(row => ({row, meta: nodes.get(identity(row.collectionId, row.itemId))}))
    .sort((a, b) => a.row.top - b.row.top || a.row.bottom - b.row.bottom);
  const inSource = entry => entry.meta.node === origin.node || entry.meta.ancestors.includes(origin.node);
  const sourceRows = visible.filter(inSource);
  const blocked = sourceRows.length ? {
    top: Math.min(...sourceRows.map(entry => entry.row.top)),
    bottom: Math.max(...sourceRows.map(entry => entry.row.bottom)),
  } : null;
  const available = visible.filter(entry => !inSource(entry));
  const targets = [], seenTargets = new Set();

  function add(kind, anchor, position, geometry) {
    const entry = nodes.get(identity(anchor.collectionId, anchor.itemId));
    const parent = movingCollection ? null : position === 'inside' ? entry.node : entry.parent;
    const into = movingCollection ? workspace.collections : parent?.item;
    if (!Array.isArray(into)) return;
    let index = position === 'inside' ? into.length : into.indexOf(entry.node) + (position === 'after' ? 1 : 0);
    const oldIndex = origin.list.indexOf(origin.node);
    if (origin.list === into && index > oldIndex) index--;
    const parentId = parent?._mpId ?? null;
    const slot = movingCollection ? ['collections', index] : ['items', anchor.collectionId, parentId, index];
    const key = `${kind}:${JSON.stringify(slot)}`;
    if (seenTargets.has(key)) return;
    const intent = {...source, targetCollectionId: anchor.collectionId,
      ...(anchor.itemId ? {targetId: anchor.itemId} : {}), position};
    // Validate once per canonical target, never on pointer movement.
    try {planCollectionMove(workspace, intent);} catch {return;}
    seenTargets.add(key);
    const {hitTop = geometry.top, hitBottom = geometry.bottom,
      hitLeft = anchor.left, hitRight = anchor.right} = geometry;
    const hitRegions = withoutBlock({top: hitTop, bottom: hitBottom, left: hitLeft, right: hitRight}, blocked);
    if (!hitRegions.length) return;
    targets.push({key, kind, intent, anchor, rowdescriptor: anchor, parentId, index,
      noop: origin.list === into && index === oldIndex,
      y: geometry.y, left: geometry.left, right: geometry.right,
      top: geometry.top, bottom: geometry.bottom, hitRegions});
  }

  function gap(anchor, position, before, after, {top, bottom} = {}) {
    const y = before && after ? (before.bottom + after.top) / 2 : before ? before.bottom : after.top;
    const hitTop = top ?? (before ? middle(before) : y - (after.bottom - after.top) / 2);
    const hitBottom = bottom ?? (after ? middle(after) : y + (before.bottom - before.top) / 2);
    add('gap', anchor, position, {
      y, left: anchor.indentLeft ?? anchor.left, right: anchor.right,
      top: hitTop, bottom: hitBottom,
      hitLeft: Math.min(before?.left ?? anchor.left, after?.left ?? anchor.left),
      hitRight: Math.max(before?.right ?? anchor.right, after?.right ?? anchor.right),
    });
  }

  if (movingCollection) {
    // A collection is a whole visible block, including expanded descendants.
    const blocks = available.filter(entry => !entry.row.itemId).map(entry => {
      const members = available.filter(value => value.meta.collection === entry.meta.collection);
      return {anchor: entry.row, top: entry.row.top,
        bottom: Math.max(...members.map(value => value.row.bottom)), left: entry.row.left, right: entry.row.right};
    });
    for (let index = 0; index < blocks.length; index++) {
      gap(blocks[index].anchor, 'before', blocks[index - 1], blocks[index]);
    }
    const last = blocks.at(-1);
    if (last) gap(last.anchor, 'after', last, null);
  } else {
    // Each displayed item contributes its one incoming boundary. At a change
    // of depth, the next row's actual parent owns that boundary. Hidden rows
    // never become anchors; a filtered gap means "before the next shown item".
    for (let index = 0; index < available.length; index++) {
      const {row, meta} = available[index], previous = available[index - 1]?.row;
      if (row.itemId) {
        const parentHeader = previous && nodes.get(identity(previous.collectionId, previous.itemId))?.node === meta.parent;
        gap(row, 'before', previous, row, parentHeader
          ? {top: previous.top + (previous.bottom - previous.top) * .75} : {});
      }
      if (Array.isArray(meta.node.item)) {
        add('inside', row, 'inside', {
          y: middle(row), left: row.indentLeft ?? row.left, right: row.right,
          top: row.top, bottom: row.bottom,
          hitTop: row.top + (row.bottom - row.top) * .25,
          hitBottom: row.bottom - (row.bottom - row.top) * .25,
        });
      }
      // Collection headers do not accept "before" item intents. Finish the
      // preceding collection at its final visible item's parent instead.
      const next = available[index + 1]?.row;
      if (row.itemId && (!next || !next.itemId)) {
        gap(row, 'after', row, next, next ? {bottom: next.top + (next.bottom - next.top) * .25} : {});
      }
    }
  }
  return targets.sort((a, b) => a.y - b.y || (a.kind === b.kind ? a.left - b.left : a.kind === 'inside' ? -1 : 1));
}

/** Resolve only reachable hit regions; invalid source-subtree space stays empty. */
export function resolveCollectionDropTarget(targets, {x, y}) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const hits = targets.filter(target => target.hitRegions.some(rect =>
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom));
  const inside = hits.filter(target => target.kind === 'inside');
  const candidates = inside.length ? inside : hits;
  return candidates.sort((a, b) => Math.abs(y - a.y) - Math.abs(y - b.y) || a.y - b.y)[0] || null;
}
