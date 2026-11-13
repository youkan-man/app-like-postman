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
const toggleSelector = 'input[data-select-toggle]';
const openSelector = '[data-select-open], .tree-open, .history-open';
const sameIds = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);

function textEntry(target) {
  if (target?.isContentEditable || target?.closest?.('textarea, select, [role="textbox"]')) return true;
  const editable = target?.closest?.('[contenteditable]');
  if (editable && editable.getAttribute('contenteditable') !== 'false') return true;
  const input = target?.closest?.('input');
  return !!input && (input.type !== 'checkbox' || !input.matches(toggleSelector));
}

/**
 * Rows use data-select-id; checkboxes use data-select-toggle. Call refresh()
 * after replacing list contents. onChange updates the toolbar, not the list.
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
      const checkbox = row.querySelector(toggleSelector);
      if (checkbox) checkbox.checked = selected;
    }
  }

  function update(change) {
    const before = state.ids;
    change(); paint();
    if (!sameIds(before, state.ids)) onChange(state.ids);
  }

  function focusRow(row, checkbox = false) {
    const control = (checkbox && row.querySelector(toggleSelector))
      || row.querySelector(openSelector) || row;
    control.focus({preventScroll: true});
    row.scrollIntoView?.({block: 'nearest'});
  }

  function refresh() {
    if (destroyed) return;
    const previousOrder = order(), focus = lastFocus;
    const restoreFocus = focus && !root.contains(focus.element)
      && (!doc.activeElement || doc.activeElement === doc.body || doc.activeElement === root);
    rows = listRows();
    update(() => state.reconcile(order()));
    if (restoreFocus) {
      const index = Math.max(0, previousOrder.indexOf(focus.id));
      const row = rows.find(item => item.dataset.selectId === focus.id)
        || rows[Math.min(index, rows.length - 1)];
      lastFocus = null;
      if (row) focusRow(row, focus.checkbox);
      else root.focus({preventScroll: true});
    }
  }

  function click(event) {
    if (event.defaultPrevented || event.button > 0 || textEntry(event.target)) return;
    const row = rowOf(event.target);
    if (!row) return;
    const id = row.dataset.selectId, modifier = event.ctrlKey || event.metaKey;
    const checkbox = event.target.closest?.(toggleSelector);
    const action = event.target.closest?.('button, a, [role="button"]');
    // Opening an item replaces selection. Its menu keeps an existing group.
    if (!checkbox && !modifier && !event.shiftKey && action
      && !action.matches(openSelector) && state.has(id)) return;
    update(() => state.select(id, order(), {
      toggle: !!checkbox || modifier, range: event.shiftKey, additive: modifier,
    }));
    if (checkbox) {
      // Native checkboxes activate before click dispatch. Cancelling the click
      // would restore their old checked state after paint().
      event.stopPropagation();
    } else if (modifier || event.shiftKey) {
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
      lastFocus = {id: row.dataset.selectId, element: event.target,
        checkbox: event.target.matches?.(toggleSelector)};
      state.focused = row.dataset.selectId;
    }
  }

  function documentFocus(event) {
    if (!root.contains(event.target)) lastFocus = null;
  }

  function consume(event) { event.preventDefault(); event.stopPropagation(); }

  function keydown(event) {
    if (event.defaultPrevented || event.isComposing || event.altKey || textEntry(event.target)) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && !event.shiftKey && event.key.toLowerCase() === 'a') {
      if (!rows.length) return;
      consume(event); update(() => state.selectAll(order())); return;
    }
    if (modifier) return;
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
    const current = rowOf(event.target);
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
      state.clear(); paint(); lastFocus = null;
    },
  };
}
