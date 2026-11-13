/** Selection belongs to the current list view, never to the saved workspace. */
export class SelectionState {
  #selected = new Set();
  anchor = null;
  focused = null;

  get ids() { return [...this.#selected]; }
  has(id) { return this.#selected.has(id); }

  set(ids) {
    this.#selected = new Set(ids.filter(id => typeof id === 'string' && id));
    this.anchor = this.ids[0] ?? null;
    this.focused = this.ids.at(-1) ?? null;
  }

  clear() {
    this.#selected.clear();
    this.anchor = this.focused = null;
  }

  reconcile(order) {
    const present = new Set(order);
    this.#selected = new Set(this.ids.filter(id => present.has(id)));
    if (!present.has(this.anchor)) this.anchor = this.ids[0] ?? null;
    if (!present.has(this.focused)) this.focused = this.ids.at(-1) ?? null;
  }

  selectAll(order) {
    const anchor = this.anchor, focused = this.focused;
    this.set(order);
    if (this.has(anchor)) this.anchor = anchor;
    if (this.has(focused)) this.focused = focused;
  }

  select(id, order, {toggle = false, range = false, additive = false} = {}) {
    if (!order.includes(id)) return;
    if (range) {
      const anchor = order.includes(this.anchor) ? this.anchor
        : order.includes(this.focused) ? this.focused : id;
      const start = order.indexOf(anchor), end = order.indexOf(id);
      const span = order.slice(Math.min(start, end), Math.max(start, end) + 1);
      this.#selected = new Set(additive ? [...this.#selected, ...span] : span);
      this.anchor = anchor;
    } else if (toggle) {
      if (this.has(id)) this.#selected.delete(id);
      else this.#selected.add(id);
      this.anchor = id;
    } else {
      this.#selected = new Set([id]);
      this.anchor = id;
    }
    this.focused = id;
  }
}

const rowSelector = '[data-select-id]';
const openSelector = '[data-select-open], .tree-open, .history-open';
const sameIds = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);

function textEntry(target) {
  if (target?.isContentEditable || target?.closest?.('textarea, select, [role="textbox"]')) return true;
  const editable = target?.closest?.('[contenteditable]');
  if (editable && editable.getAttribute('contenteditable') !== 'false') return true;
  return !!target?.closest?.('input');
}

/**
 * Rows use data-select-id and their open buttons use data-select-open. Call
 * refresh() after replacing list contents. onChange must not rebuild the list.
 * onDelete owns confirmation, persistence and reporting any deletion error.
 */
export function bindListSelection(root, {onDelete = () => {}, onChange = () => {}} = {}) {
  const state = new SelectionState(), doc = root.ownerDocument;
  let rows = [], lastFocus = null, deleting = false, destroyed = false;

  function listRows() {
    return [...root.querySelectorAll(rowSelector)].filter(row => {
      if (!row.dataset.selectId) return false;
      // Inspect the list's own hidden branches, not the closed navigation drawer.
      for (let node = row; node && node !== root; node = node.parentElement) {
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.style?.display === 'none') return false;
      }
      return true;
    });
  }
  const order = () => rows.map(row => row.dataset.selectId);
  const rowOf = target => {
    const row = target?.closest?.(rowSelector);
    return row && root.contains(row) && rows.includes(row) ? row : null;
  };

  function paint() {
    for (const row of root.querySelectorAll(rowSelector)) {
      const selected = state.has(row.dataset.selectId);
      row.classList.toggle('list-selected', selected);
      row.setAttribute('aria-selected', String(selected));
    }
  }

  function update(change) {
    const before = state.ids;
    change(); paint();
    if (!sameIds(before, state.ids)) onChange(state.ids);
  }

  function focusRow(row, action = false) {
    const control = (action && row.querySelector('[aria-haspopup="menu"]'))
      || row.querySelector(openSelector) || row;
    control.focus({preventScroll: true});
    row.scrollIntoView?.({block: 'nearest'});
  }

  function restoreDetachedFocus() {
    if (destroyed) return;
    const focus = lastFocus;
    const restoreFocus = focus && !root.contains(focus.element)
      && (!doc.activeElement || doc.activeElement === doc.body || doc.activeElement === root);
    if (restoreFocus) {
      const row = rows.find(item => item.dataset.selectId === focus.id)
        || rows[Math.min(focus.index, rows.length - 1)];
      lastFocus = null;
      if (row) focusRow(row, focus.action);
      else root.focus({preventScroll: true});
    }
  }

  function refresh() {
    if (destroyed) return;
    rows = listRows();
    update(() => state.reconcile(order()));
    restoreDetachedFocus();
  }

  function click(event) {
    if (event.defaultPrevented || event.button > 0 || textEntry(event.target)) return;
    const row = rowOf(event.target);
    if (!row) return;
    const id = row.dataset.selectId, modifier = event.ctrlKey || event.metaKey;
    const action = event.target.closest?.('button, a, [role="button"]');
    // Opening an item replaces selection. Its menu keeps an existing group.
    if (!modifier && !event.shiftKey && action
      && !action.matches(openSelector) && state.has(id)) return;
    update(() => state.select(id, order(), {
      toggle: modifier, range: event.shiftKey, additive: modifier,
    }));
    if (modifier || event.shiftKey) {
      event.preventDefault(); event.stopPropagation();
    }
  }

  function contextmenu(event) {
    const row = rowOf(event.target);
    if (!row || textEntry(event.target) || state.has(row.dataset.selectId)) return;
    update(() => state.select(row.dataset.selectId, order()));
  }

  function focusin(event) {
    const row = rowOf(event.target);
    if (row) {
      lastFocus = {id: row.dataset.selectId, element: event.target, index: rows.indexOf(row),
        action: !event.target.matches?.(openSelector) && event.target.matches?.('[aria-haspopup="menu"]')};
      state.focused = row.dataset.selectId;
    }
  }

  function documentFocus(event) {
    // Menus and confirmation dialogs temporarily borrow the row's focus. Keep
    // its identity if the list is rebuilt while one of these surfaces is open.
    if (event.target === doc.body && lastFocus && !root.contains(lastFocus.element)) return;
    if (!root.contains(event.target) && !event.target.closest?.('[role="menu"], dialog')) lastFocus = null;
  }

  function surfaceInteraction(event) {
    if (event.target.closest?.('[role="menu"], dialog')) queueMicrotask(restoreDetachedFocus);
  }

  function consume(event) { event.preventDefault(); event.stopPropagation(); }

  function keydown(event) {
    if (event.defaultPrevented || event.isComposing || event.altKey || textEntry(event.target)) return;
    const modifier = event.ctrlKey || event.metaKey;
    const current = rowOf(event.target);
    if (modifier && !event.shiftKey && event.key.toLowerCase() === 'a') {
      if (!rows.length) return;
      consume(event); update(() => state.selectAll(order())); return;
    }
    if (event.key === ' ' && current && event.target.closest?.(openSelector)) {
      consume(event);
      if (!event.repeat) update(() => state.select(current.dataset.selectId, order(), {
        toggle: true, range: event.shiftKey, additive: modifier,
      }));
      return;
    }
    if (modifier) return;
    if (current && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      if (!state.has(current.dataset.selectId)) update(() => state.select(current.dataset.selectId, order()));
      return; // Let the existing row handler open its menu.
    }
    if (event.key === 'Escape') {
      if (!state.ids.length) return;
      consume(event); update(() => state.clear()); return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!state.ids.length) return;
      consume(event);
      if (deleting || event.repeat) return;
      deleting = true;
      try {
        const result = onDelete(state.ids);
        if (result && typeof result.then === 'function') {
          // The app reports errors; release the key guard for either outcome.
          result.then(() => {deleting = false;}, () => {deleting = false;});
        } else deleting = false;
      } catch (error) {
        deleting = false; throw error;
      }
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !rows.length) return;
    if (!current && event.target !== root) return;
    const ids = order(), currentId = current?.dataset.selectId ?? state.focused;
    const index = ids.indexOf(currentId);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : index < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
    consume(event);
    update(() => {
      if (event.shiftKey && !ids.includes(state.anchor) && ids.includes(currentId)) state.select(currentId, ids);
      state.select(ids[next], ids, {range: event.shiftKey});
    });
    focusRow(rows[next]);
  }

  root.addEventListener('click', click, true);
  root.addEventListener('contextmenu', contextmenu, true);
  root.addEventListener('keydown', keydown, true);
  root.addEventListener('focusin', focusin);
  doc.addEventListener('focusin', documentFocus);
  doc.addEventListener('click', surfaceInteraction, true);
  doc.addEventListener('keydown', surfaceInteraction, true);
  refresh();

  return {
    get ids() { return state.ids; },
    has(id) { return state.has(id); },
    set(ids) { update(() => {state.set(ids); state.reconcile(order());}); },
    clear() { update(() => state.clear()); },
    selectAll() { update(() => state.selectAll(order())); },
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      root.removeEventListener('click', click, true);
      root.removeEventListener('contextmenu', contextmenu, true);
      root.removeEventListener('keydown', keydown, true);
      root.removeEventListener('focusin', focusin);
      doc.removeEventListener('focusin', documentFocus);
      doc.removeEventListener('click', surfaceInteraction, true);
      doc.removeEventListener('keydown', surfaceInteraction, true);
      state.clear(); paint(); lastFocus = null;
    },
  };
}
