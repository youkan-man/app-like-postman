/** Literal source search and single-transaction replacements. DOM offsets are UTF-16. */
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const offset = (value, length, fallback) => Number.isFinite(value) ? Math.max(0, Math.min(length, Math.trunc(value))) : fallback;

export function findMatches(source, query, {caseSensitive=false, from=0, to}={}) {
  source = String(source ?? ''); query = String(query ?? '');
  if (!query) return [];
  from = offset(from, source.length, 0); to = offset(to, source.length, source.length);
  if (to < from) return [];
  const pattern = new RegExp(escapePattern(query), caseSensitive ? 'gu' : 'giu');
  pattern.lastIndex = from;
  const matches = [];
  for (let match; (match = pattern.exec(source));) {
    const end = match.index + match[0].length;
    if (end > to) break;
    if (match.index >= from) matches.push({from:match.index, to:end});
  }
  return matches;
}

/** A single replacement requires the complete current match to be selected. */
export function replaceEdit(source, query, replacement, {caseSensitive=false, all=false, selectionStart=0, selectionEnd=selectionStart}={}) {
  source = String(source ?? ''); replacement = String(replacement ?? '');
  const matches = findMatches(source, query, {caseSensitive});
  if (!matches.length) return null;
  const chosen = all ? matches : matches.filter(match => match.from === selectionStart && match.to === selectionEnd);
  if (!chosen.length) return null;
  const from = chosen[0].from, to = chosen.at(-1).to;
  const parts = []; let previous = from;
  for (const match of chosen) {
    parts.push(source.slice(previous, match.from), replacement); previous = match.to;
  }
  parts.push(source.slice(previous, to));
  const text = parts.join('');
  if (text === source.slice(from, to)) return null;
  return {from, to, text, selectionStart:from, selectionEnd:from + replacement.length, selectionDirection:'forward'};
}

let sequence = 0, activeSearch = null;

/** Compact, editor-owned search. The portal never changes the source pane's size. */
export function createEditorSearch({root, area, readOnly=false, edit, select}) {
  const doc = root.ownerDocument, view = doc.defaultView;
  const panel = doc.createElement('div'); panel.className = 'source-search'; panel.id = `source-search-${++sequence}`; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', `${area.getAttribute('aria-label') || 'コード'}の検索`);
  const row = doc.createElement('div'); row.className = 'source-search-row';
  function makeButton(text, label, action, className='') {
    const control = doc.createElement('button'); control.type = 'button'; control.textContent = text;
    control.className = className; control.setAttribute('aria-label', label); control.title = label;
    control.addEventListener('click', action); return control;
  }
  function makeInput(label, placeholder) {
    const input = doc.createElement('input'); input.type = 'text'; input.placeholder = placeholder;
    input.setAttribute('aria-label', label); input.setAttribute('autocomplete', 'off'); input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off'); input.spellcheck = false; return input;
  }
  const search = makeInput('コードを検索', '検索'); search.className = 'source-search-query';
  const replacement = makeInput('置換後の文字列', '置換後'); replacement.className = 'source-search-replacement';
  const count = doc.createElement('span'); count.className = 'source-search-count'; count.setAttribute('role', 'status'); count.setAttribute('aria-live', 'polite');
  const toggle = makeButton('›', '置換を表示', () => setReplacing(replaceRow.hidden)); toggle.hidden = readOnly; toggle.className = 'source-search-toggle'; toggle.setAttribute('aria-expanded', 'false');
  const matchCase = makeButton('Aa', '大文字と小文字を区別', () => {
    caseSensitive = !caseSensitive; matchCase.setAttribute('aria-pressed', String(caseSensitive)); refresh(); move(1, {includeCurrent:true});
  }); matchCase.setAttribute('aria-pressed', 'false');
  const previous = makeButton('↑', '前の一致', () => move(-1));
  const next = makeButton('↓', '次の一致', () => move(1));
  const dismiss = makeButton('×', '検索を閉じる', () => close());
  row.append(toggle, search, matchCase, count, previous, next, dismiss);
  const replaceRow = doc.createElement('div'); replaceRow.className = 'source-search-replace-row'; replaceRow.id = `${panel.id}-replace`; replaceRow.hidden = true;
  toggle.setAttribute('aria-controls', replaceRow.id);
  const replaceOneButton = makeButton('置換', '選択した一致を置換', () => replace(false));
  const replaceAllButton = makeButton('すべて置換', 'すべての一致を置換', () => replace(true));
  replaceRow.append(replacement, replaceOneButton, replaceAllButton); panel.append(row, replaceRow);
  const button = makeButton('検索', readOnly ? 'コードを検索' : 'コードを検索・置換', () => open(false), 'source-search-button');
  button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', panel.id); button.setAttribute('aria-expanded', 'false');
  let matches = [], caseSensitive = false, disposed = false, selecting = false;
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {if (!root.isConnected) dispose();}) : null;

  function isOpen() {return !disposed && !panel.hidden;}
  function selectedIndex() {return matches.findIndex(match => match.from === area.selectionStart && match.to === area.selectionEnd);}
  function presentCount() {
    const index = selectedIndex();
    const text = !search.value ? '' : index >= 0 ? `${index + 1} / ${matches.length}` : `${matches.length} 件`;
    if (count.textContent !== text) count.textContent = text;
    count.title = search.value ? `${matches.length} 件の一致` : '';
    previous.disabled = next.disabled = !matches.length;
    replaceOneButton.disabled = replaceAllButton.disabled = readOnly || !matches.length;
  }
  function refresh() {
    if (!isOpen()) return;
    if (!root.isConnected) {dispose(); return;}
    matches = findMatches(area.value, search.value, {caseSensitive}); presentCount();
  }
  function choose(index, {focus=false}={}) {
    if (!matches.length || index < 0) return false;
    const match = matches[index]; selecting = true;
    try {select(match.from, match.to, {focus});} finally {selecting = false;}
    presentCount(); position(); return true;
  }
  function move(direction, {includeCurrent=false, focus=false}={}) {
    refresh(); if (!matches.length) return false;
    const selected = selectedIndex();
    let index;
    if (selected >= 0) index = includeCurrent ? selected : (selected + direction + matches.length) % matches.length;
    else if (direction < 0) {
      index = matches.findLastIndex(match => match.from < area.selectionStart);
      if (index < 0) index = matches.length - 1;
    } else {
      const start = includeCurrent ? area.selectionStart : area.selectionEnd;
      index = matches.findIndex(match => match.from >= start);
      if (index < 0) index = 0;
    }
    return choose(index, {focus});
  }
  function replace(all) {
    if (readOnly) return;
    refresh(); if (!matches.length) return;
    if (!all && selectedIndex() < 0) {move(1, {includeCurrent:true}); return;}
    const focus = doc.activeElement;
    const plan = replaceEdit(area.value, search.value, replacement.value, {caseSensitive, all, selectionStart:area.selectionStart, selectionEnd:area.selectionEnd});
    if (!plan) {if (!all) move(1); return;}
    const after = plan.from + plan.text.length;
    if (!edit(plan)) return;
    refresh();
    if (!all && matches.length) {
      const index = matches.findIndex(match => match.from >= after); choose(index < 0 ? 0 : index);
    }
    if (isOpen() && panel.contains(focus)) {
      // The final replacement disables its button; keep typing in the panel.
      (focus.disabled ? replacement : focus).focus({preventScroll:true});
    }
    position();
  }
  function setReplacing(visible) {
    const replacing = Boolean(visible) && !readOnly;
    replaceRow.hidden = !replacing; toggle.textContent = replacing ? '⌄' : '›'; toggle.setAttribute('aria-expanded', String(replacing));
    toggle.setAttribute('aria-label', replacing ? '置換を閉じる' : '置換を表示'); toggle.title = replacing ? '置換を閉じる' : '置換を表示';
    position();
  }
  function position() {
    if (!isOpen()) return;
    if (!root.isConnected) {dispose(); return;}
    const viewport = view.visualViewport, gap = 6;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || view.innerWidth, height = viewport?.height || view.innerHeight;
    const right = left + width, bottom = top + height;
    panel.style.width = `${Math.min(420, Math.max(0, width - gap * 2))}px`;
    panel.style.maxHeight = `${Math.max(0, height - gap * 2)}px`;
    const anchor = root.getBoundingClientRect(), size = panel.getBoundingClientRect();
    const x = Math.max(left + gap, Math.min(anchor.right - size.width, right - gap - size.width));
    const above = anchor.top - gap - size.height;
    const y = above >= top + gap ? above : Math.max(top + gap, Math.min(anchor.bottom + gap, bottom - gap - size.height));
    panel.style.left = `${x}px`; panel.style.top = `${y}px`;
  }
  function outside(event) {
    if (isOpen() && !root.contains(event.target) && !panel.contains(event.target)) close({focus:false});
  }
  function open(replacing=false) {
    if (disposed || !root.isConnected) return false;
    const wasOpen = isOpen();
    if (activeSearch && activeSearch !== api) activeSearch.close({focus:false});
    activeSearch = api;
    if (!wasOpen) {
      const selected = area.value.slice(area.selectionStart, area.selectionEnd);
      // A single-line field cannot preserve line breaks; never silently flatten
      // a selected block or copy an entire large document into the search box.
      if (selected && selected.length <= 4096 && !/[\r\n]/.test(selected)) search.value = selected;
      (root.closest('dialog') || doc.body).append(panel); panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      doc.addEventListener('pointerdown', outside, true); doc.addEventListener('focusin', outside);
      doc.addEventListener('scroll', position, {capture:true, passive:true}); view.addEventListener('resize', position);
      view.visualViewport?.addEventListener('resize', position); view.visualViewport?.addEventListener('scroll', position);
      observer?.observe(doc.body, {childList:true, subtree:true});
    }
    setReplacing(replacing); refresh(); move(1, {includeCurrent:true}); position();
    search.focus({preventScroll:true}); search.select(); return true;
  }
  function close({focus=true}={}) {
    if (panel.hidden) return;
    panel.hidden = true; panel.remove(); button.setAttribute('aria-expanded', 'false');
    observer?.disconnect();
    doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('focusin', outside);
    doc.removeEventListener('scroll', position, true); view.removeEventListener('resize', position);
    view.visualViewport?.removeEventListener('resize', position); view.visualViewport?.removeEventListener('scroll', position);
    if (activeSearch === api) activeSearch = null;
    if (focus && root.isConnected) select(area.selectionStart, area.selectionEnd, {focus:true});
  }
  function handleKeydown(event) {
    if (disposed) return false;
    const inside = panel.contains(event.target);
    if (event.isComposing || event.keyCode === 229) {if (inside && ['Enter','Escape'].includes(event.key)) event.stopPropagation(); return false;}
    const key = event.key.toLowerCase(), command = (event.ctrlKey || event.metaKey) && !event.altKey;
    if (command && (key === 'f' || key === 'h')) {event.preventDefault(); event.stopPropagation(); open(key === 'h'); return true;}
    if (event.key === 'F3' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation();
      const saved = {from:area.selectionStart, to:area.selectionEnd};
      if (!isOpen()) {open(false); select(saved.from, saved.to, {focus:false});}
      if (search.value) move(event.shiftKey ? -1 : 1, {focus:event.target === area});
      return true;
    }
    if (!inside) return false;
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); close(); return true;}
    if (event.key === 'Enter') {
      // Button activation remains native, but Enter never reaches the global
      // script/request execution shortcut while the search controls have focus.
      event.stopPropagation();
      if (event.target.tagName === 'BUTTON' && !command && !event.altKey) return true;
      event.preventDefault();
      if (!command && !event.altKey) {
        if (event.target === replacement && !event.shiftKey) replace(false);
        else move(event.shiftKey ? -1 : 1);
      }
      return true;
    }
    return false;
  }
  function selectionChanged() {if (isOpen() && !selecting) presentCount();}
  search.addEventListener('input', () => {refresh(); move(1, {includeCurrent:true});});
  panel.addEventListener('keydown', handleKeydown); button.addEventListener('keydown', handleKeydown);
  area.addEventListener('select', selectionChanged);
  function dispose() {close({focus:false}); disposed = true; observer?.disconnect(); area.removeEventListener('select', selectionChanged); panel.remove();}
  const api = {button, open, close, refresh, handleKeydown, isOpen, position, dispose};
  return api;
}
