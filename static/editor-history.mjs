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

function plan(before, after, saved) {
  const {from, removed, inserted} = delta(before, after);
  return {from, to:from + removed.length, text:inserted,
    selectionStart:saved.start, selectionEnd:saved.end, selectionDirection:saved.direction};
}

function typingChange(before, after, entry, {inputType, timestamp}) {
  const start = entry.beforeSelection, end = entry.afterSelection;
  if (!Number.isFinite(timestamp) || end.start !== end.end) return null;
  let from = start.start, to = start.end, inserted = 0, canJoin = start.start === start.end;
  if (inputType === 'insertText') {
    inserted = after.length - before.length + to - from;
    if (inserted <= 0 || end.start !== from + inserted) return null;
    // A selected replacement or a multi-character fill starts a typing group;
    // later adjacent characters may join it, but it never joins an older group.
    canJoin &&= inserted === (after.codePointAt(from) > 0xFFFF ? 2 : 1);
  } else if (canJoin && (inputType === 'deleteContentBackward' || inputType === 'deleteContentForward')) {
    const removed = before.length - after.length;
    if (removed <= 0) return null;
    if (inputType === 'deleteContentBackward') from -= removed; else to += removed;
    if (from < 0 || to > before.length || end.start !== from) return null;
  } else return null;
  // Anchor the operation at its caret, not at the ambiguous minimal delta for
  // repeated text (inserting "a" inside "aaa" can otherwise look like appending).
  if (before.slice(0, from) !== after.slice(0, from) || before.slice(to) !== after.slice(from + inserted)) return null;
  return {inputType, timestamp, from, to, inserted, canJoin};
}

function adjacent(previous, next, beforeSelection) {
  const saved = previous.entry.afterSelection;
  return next.canJoin && previous.inputType === next.inputType && next.timestamp > previous.timestamp && next.timestamp - previous.timestamp <= 1000 &&
    saved.start === beforeSelection.start && saved.end === beforeSelection.end && saved.direction === beforeSelection.direction &&
    (next.inputType === 'insertText' ? next.from === previous.from + previous.inserted :
      next.inputType === 'deleteContentBackward' ? next.to === previous.from : next.from === previous.from);
}

export function createTextHistory({maxEntries=500, maxText=4_000_000}={}) {
  const limit = (value, fallback) => Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
  maxEntries = limit(maxEntries, 500); maxText = limit(maxText, 4_000_000);
  const entries = [];
  let cursor = 0, retainedText = 0, current = null, groupSequence = 0, group = null;

  function breakGroup() {group = null;}

  function reset(source) {
    entries.length = 0; cursor = 0; retainedText = 0; current = asText(source); breakGroup();
  }

  function matches(source) {
    if (current === source) return true;
    reset(source); return false;
  }

  function record(before, after, beforeSelection, afterSelection, options={}) {
    before = asText(before); after = asText(after);
    if (current === null) current = before;
    if (before !== current) {reset(after); return false;}
    if (before === after) {breakGroup(); return false;}
    // Editing after Undo creates a new branch; no discarded Redo can reappear
    // just because later text happens to equal one of its earlier states.
    for (const entry of entries.splice(cursor)) retainedText -= entry.removed.length + entry.inserted.length;
    const entry = {...delta(before, after), beforeSelection:selection(beforeSelection, before.length),
      afterSelection:selection(afterSelection, after.length)};
    const typing = typingChange(before, after, entry, options);
    entry.group = group && typing && entries.at(-1) === group.entry && adjacent(group, typing, entry.beforeSelection) ? group.entry.group : ++groupSequence;
    group = typing ? {...typing, entry} : null;
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
    breakGroup(); source = asText(source);
    if (!matches(source) || (reverse ? cursor === 0 : cursor === entries.length)) return null;
    const id = entries[reverse ? cursor - 1 : cursor].group;
    let position = cursor, next = source, saved;
    while (reverse ? position > 0 : position < entries.length) {
      const entry = entries[reverse ? position - 1 : position];
      if (entry.group !== id) break;
      next = replay(next, entry, reverse);
      if (next === null) {reset(source); return null;}
      saved = reverse ? entry.beforeSelection : entry.afterSelection;
      position += reverse ? -1 : 1;
    }
    cursor = position; current = next;
    return plan(source, next, saved);
  }

  function reconcile(before, after, inputType) {
    breakGroup(); before = asText(before); after = asText(after);
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

  return {record, undo:source => step(source, true), redo:source => step(source, false), reconcile, reset, breakGroup};
}
