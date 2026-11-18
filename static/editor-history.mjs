/** Linear textarea edit journal. Entries retain changed text, not document copies. */
const asText = value => String(value ?? '');

function selection(value, length) {
  const offset = position => Number.isFinite(position) ? Math.max(0, Math.min(length, Math.trunc(position))) : length;
  const start = offset(value?.start), end = offset(value?.end);
  return {start:Math.min(start, end), end:Math.max(start, end),
    direction:['forward','backward','none'].includes(value?.direction) ? value.direction : 'none'};
}

function delta(before, after) {
  let from = 0, suffix = 0;
  while (from < before.length && from < after.length && before.charCodeAt(from) === after.charCodeAt(from)) from++;
  while (before.length - suffix > from && after.length - suffix > from &&
    before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)) suffix++;
  return {from, removed:before.slice(from, before.length - suffix), inserted:after.slice(from, after.length - suffix)};
}

function replay(source, entry, reverse) {
  const removed = reverse ? entry.inserted : entry.removed, inserted = reverse ? entry.removed : entry.inserted;
  if (entry.from > source.length || source.slice(entry.from, entry.from + removed.length) !== removed) return null;
  return source.slice(0, entry.from) + inserted + source.slice(entry.from + removed.length);
}

function plan(entry, reverse) {
  const removed = reverse ? entry.inserted : entry.removed, inserted = reverse ? entry.removed : entry.inserted;
  const saved = reverse ? entry.beforeSelection : entry.afterSelection;
  return {from:entry.from, to:entry.from + removed.length, text:inserted,
    selectionStart:saved.start, selectionEnd:saved.end, selectionDirection:saved.direction};
}

export function createTextHistory({maxEntries=500, maxText=4_000_000}={}) {
  const limit = (value, fallback) => Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
  maxEntries = limit(maxEntries, 500); maxText = limit(maxText, 4_000_000);
  const entries = [];
  let cursor = 0, retainedText = 0, current = null;

  function reset(source) {
    entries.length = 0; cursor = 0; retainedText = 0; current = asText(source);
  }

  function matches(source) {
    if (current === source) return true;
    reset(source); return false;
  }

  function record(before, after, beforeSelection, afterSelection) {
    before = asText(before); after = asText(after);
    if (current === null) current = before;
    if (before !== current) {reset(after); return false;}
    if (before === after) return false;
    // Editing after Undo creates a new branch; no discarded Redo can reappear
    // just because later text happens to equal one of its earlier states.
    for (const entry of entries.splice(cursor)) retainedText -= entry.removed.length + entry.inserted.length;
    const entry = {...delta(before, after), beforeSelection:selection(beforeSelection, before.length),
      afterSelection:selection(afterSelection, after.length)};
    entries.push(entry); cursor = entries.length; current = after;
    retainedText += entry.removed.length + entry.inserted.length;
    // Preserve the most recent edit even when that one edit exceeds a budget.
    while (entries.length > 1 && (entries.length > maxEntries || retainedText > maxText)) {
      const oldest = entries.shift(); cursor--;
      retainedText -= oldest.removed.length + oldest.inserted.length;
    }
    return true;
  }

  function step(source, reverse) {
    source = asText(source);
    if (!matches(source) || (reverse ? cursor === 0 : cursor === entries.length)) return null;
    const entry = entries[reverse ? cursor - 1 : cursor], next = replay(source, entry, reverse);
    if (next === null) {reset(source); return null;}
    cursor += reverse ? -1 : 1; current = next;
    return plan(entry, reverse);
  }

  function reconcile(before, after, inputType) {
    before = asText(before); after = asText(after);
    if (before !== current || !['historyUndo','historyRedo'].includes(inputType)) {reset(after); return null;}
    const reverse = inputType === 'historyUndo';
    let position = cursor, candidate = before;
    // Native input can merge several records into one Undo unit. Walk only in
    // the requested direction from the current cursor, never search old text.
    while (reverse ? position > 0 : position < entries.length) {
      const entry = entries[reverse ? position - 1 : position];
      candidate = replay(candidate, entry, reverse);
      if (candidate === null) break;
      position += reverse ? -1 : 1;
      if (candidate === after) {
        cursor = position; current = after;
        return {...(reverse ? entry.beforeSelection : entry.afterSelection)};
      }
    }
    // The browser may have older history than this bounded journal. Its result
    // remains authoritative, but none of our stale records may be applied to it.
    reset(after); return null;
  }

  return {record, undo:source => step(source, true), redo:source => step(source, false), reconcile, reset};
}
