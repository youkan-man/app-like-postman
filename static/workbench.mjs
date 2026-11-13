/** Layout-only state: request data and network I/O remain owned by app.js. */
const $ = id => document.getElementById(id);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const KEY = 'minipost.layout.v1';

export function initWorkbench(storage = localStorage) {
  let saved = {};
  try { saved = JSON.parse(storage.getItem(KEY)) || {}; } catch {}
  const state = {
    sidebar: Number.isFinite(saved.sidebar) ? clamp(saved.sidebar, 200, 520) : 260,
    open: saved.open !== false,
    split: saved.split === 'side' ? 'side' : 'stack',
    stackRatio: Number.isFinite(saved.stackRatio) ? clamp(saved.stackRatio, .25, .75) : .46,
    sideRatio: Number.isFinite(saved.sideRatio) ? clamp(saved.sideRatio, .25, .75) : .5,
    wrap: saved.wrap !== false,
  };
  const narrow = matchMedia('(max-width: 820px)');
  const wide = matchMedia('(min-width: 1180px)');
  let mobileOpen = false;
  const root = document.documentElement;
  const save = () => { try { storage.setItem(KEY, JSON.stringify(state)); } catch {} };
  const effectiveSplit = () => wide.matches ? state.split : 'stack';
  const visible = () => narrow.matches ? mobileOpen : state.open;
  const pixels = value => Number.parseFloat(value) || 0;
  let renderedRatio = state.stackRatio, pendingLayout = false, lastSource = null, lastSourceFrame = '';

  function activeSource() {
    if (!['body', 'scripts'].includes(root.dataset.editorPage)) return null;
    return [...$('editorContent').querySelectorAll('.source-editor')].find(editor => editor.getClientRects().length) || null;
  }
  function editableHeight(source) {
    const style = getComputedStyle(source.querySelector('.source-input'));
    const status = source.querySelector('.source-status')?.getBoundingClientRect().height || 0;
    return Math.ceil(4 * (pixels(style.lineHeight) || pixels(style.fontSize) * 1.65)
      + pixels(style.paddingTop) + pixels(style.paddingBottom) + status + 2);
  }
  function splitBounds(split) {
    if (root.dataset.responseEmpty !== 'false' || !$('exchange').getClientRects().length) return {min:.25, max:.75};
    const exchange = $('exchange').getBoundingClientRect(), handle = $('responseResize').getBoundingClientRect();
    const available = (split === 'side' ? exchange.width - handle.width : exchange.height - handle.height);
    if (available <= 0) return {min:.25, max:.75};
    let requestMin, responseMin;
    if (split === 'side') {
      const urlbar = document.querySelector('.urlbar'), style = getComputedStyle(urlbar);
      requestMin = $('method').getBoundingClientRect().width + $('send').getBoundingClientRect().width + 96
        + pixels(style.marginLeft) + pixels(style.marginRight) + pixels(style.borderLeftWidth) + pixels(style.borderRightWidth);
      responseMin = 280;
    } else {
      const request = document.querySelector('.request-editor').getBoundingClientRect();
      requestMin = $('editorContent').getBoundingClientRect().top - request.top + 72;
      const source = activeSource();
      if (source) {
        let top = source.getBoundingClientRect().top - request.top;
        // Ancestor scrolling does not change the amount of space the controls need.
        for (let parent = source.parentElement; parent && !parent.classList.contains('request-editor'); parent = parent.parentElement) top += parent.scrollTop;
        top += document.querySelector('.request-editor').scrollTop;
        const section = source.closest('.editor-section');
        requestMin = Math.max(requestMin, top + editableHeight(source)
          + pixels(getComputedStyle($('editorContent')).paddingBottom) + pixels(getComputedStyle(section).paddingBottom));
      }
      const response = document.querySelector('.response-panel').getBoundingClientRect();
      responseMin = $('responseContent').getBoundingClientRect().top - response.top + 64;
    }
    // Keep both panes within the workbench. On a short screen the request's own
    // settings scroller gives access to controls that cannot all fit at once.
    const max = clamp(1 - responseMin / available, .25, .75);
    return {min:Math.min(max, Math.max(.25, requestMin / available)), max};
  }
  function revealCode(source) {
    if (!source) return;
    const fields = source.closest('.editor-section-body'), box = fields.getBoundingClientRect();
    const bottom = Math.min(box.bottom, document.querySelector('.request-editor').getBoundingClientRect().bottom);
    const required = Math.min(editableHeight(source), fields.clientHeight);
    const below = source.getBoundingClientRect().top + required - bottom;
    if (required > 0 && below > 1) fields.scrollTop += below;
  }
  function applySplit(split) {
    const bounds = splitBounds(split), key = split === 'side' ? 'sideRatio' : 'stackRatio';
    renderedRatio = clamp(state[key], bounds.min, bounds.max);
    // Fractional factors below 1 leave unused space when another track reaches
    // its minimum. Larger equivalent weights always consume the available pane.
    const requestWeight = Math.round(renderedRatio * 100000) / 1000;
    const request = `${requestWeight}fr`, response = `${100 - requestWeight}fr`;
    if (root.style.getPropertyValue('--request-fr') !== request) root.style.setProperty('--request-fr', request);
    if (root.style.getPropertyValue('--response-fr') !== response) root.style.setProperty('--response-fr', response);
    $('responseResize').setAttribute('aria-valuemin', String(Math.round(bounds.min * 100)));
    $('responseResize').setAttribute('aria-valuemax', String(Math.round(bounds.max * 100)));
    $('responseResize').setAttribute('aria-valuenow', String(Math.round(renderedRatio * 100)));
    const source = activeSource(), fields = source?.closest('.editor-section-body');
    const frame = fields ? [split, fields.clientWidth, fields.clientHeight, document.querySelector('.request-editor').clientHeight].join(':') : '';
    if (source !== lastSource || frame !== lastSourceFrame) revealCode(source);
    lastSource = source; lastSourceFrame = frame;
  }
  function queueLayout() {
    if (pendingLayout) return;
    pendingLayout = true;
    requestAnimationFrame(() => { pendingLayout = false; apply(); });
  }

  function apply() {
    const open = visible(), split = effectiveSplit();
    root.dataset.navigation = open ? 'open' : 'closed';
    root.dataset.layout = split;
    root.dataset.wrap = String(state.wrap);
    root.style.setProperty('--sidebar', `${state.sidebar}px`);
    applySplit(split);
    $('navigation').inert = !open;
    $('navigation').setAttribute('aria-label', 'コレクション・環境・履歴');
    $('navigation').setAttribute('role', narrow.matches ? 'dialog' : 'region');
    if (narrow.matches && open) $('navigation').setAttribute('aria-modal', 'true');
    else $('navigation').removeAttribute('aria-modal');
    $('navBackdrop').hidden = !(narrow.matches && open);
    $('navClose').hidden = !narrow.matches;
    document.querySelector('.main').inert = narrow.matches && open;
    document.querySelector('.topbar').inert = narrow.matches && open;
    $('toggleSidebar').setAttribute('aria-expanded', String(open));
    $('toggleSidebar').title = open ? '一覧を閉じる' : '一覧を開く';
    $('layoutToggle').disabled = !wide.matches;
    $('layoutToggle').setAttribute('aria-pressed', String(split === 'side'));
    $('layoutToggle').title = wide.matches ? (split === 'side' ? '上下に並べる' : '左右に並べる') : '左右表示は広い画面で選択できます';
    $('wrapResponse').setAttribute('aria-pressed', String(state.wrap));
    $('responseResize').setAttribute('aria-orientation', split === 'side' ? 'vertical' : 'horizontal');
    $('sidebarResize').setAttribute('aria-valuenow', String(Math.round(state.sidebar)));
  }
  function closeNavigation() {
    if (!narrow.matches || !mobileOpen) return;
    mobileOpen = false; apply(); $('toggleSidebar').focus();
  }
  $('toggleSidebar').onclick = () => {
    if (narrow.matches) mobileOpen = !mobileOpen;
    else state.open = !state.open;
    apply(); save();
    if (narrow.matches && mobileOpen) $('navClose').focus();
  };
  $('navClose').onclick = closeNavigation;
  $('navBackdrop').onclick = closeNavigation;
  $('navigation').addEventListener('keydown', event => {
    if (!narrow.matches || !mobileOpen || $('modal').open || !$('itemMenu').hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeNavigation(); }
    if (event.key !== 'Tab') return;
    const controls = [...$('navigation').querySelectorAll('button,input,select,[tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  $('layoutToggle').onclick = () => { state.split = effectiveSplit() === 'side' ? 'stack' : 'side'; apply(); save(); };
  $('wrapResponse').onclick = () => { state.wrap = !state.wrap; apply(); save(); };
  function resize(handle, move) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); handle.setPointerCapture(event.pointerId);
      const onMove = event => move(event);
      const stop = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
        handle.removeEventListener('lostpointercapture', stop);
        save();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
      handle.addEventListener('lostpointercapture', stop);
    });
  }
  resize($('sidebarResize'), event => {
    state.sidebar = clamp(event.clientX - (document.querySelector('.rail')?.getBoundingClientRect().width || 0), 200, 520); apply();
  });
  resize($('responseResize'), event => {
    const box = $('exchange').getBoundingClientRect();
    const split = effectiveSplit(), handle = $('responseResize').getBoundingClientRect();
    const ratio = split === 'side' ? (event.clientX - box.x - handle.width / 2) / (box.width - handle.width)
      : (event.clientY - box.y - handle.height / 2) / (box.height - handle.height);
    state[split === 'side' ? 'sideRatio' : 'stackRatio'] = clamp(ratio, .25, .75);
    apply();
  });
  $('sidebarResize').onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); state.sidebar = event.key === 'Home' ? 200 : event.key === 'End' ? 520 : clamp(state.sidebar + (event.key === 'ArrowRight' ? 20 : -20), 200, 520); apply(); save();
  };
  $('responseResize').onkeydown = event => {
    const split = effectiveSplit(), keys = split === 'side' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (![...keys, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const key = split === 'side' ? 'sideRatio' : 'stackRatio';
    state[key] = event.key === 'Home' ? .25 : event.key === 'End' ? .75 : clamp(renderedRatio + (event.key === keys[1] ? .05 : -.05), .25, .75); apply(); save();
  };
  narrow.addEventListener('change', () => { mobileOpen = false; apply(); });
  wide.addEventListener('change', apply);
  // Observe layout controls, not editable text/highlighting. The exchange's own
  // size is independent of its split, so changing a ratio does not resize-loop.
  const layoutObserver = new ResizeObserver(queueLayout);
  for (const element of document.querySelectorAll('#exchange,.request-title,.urlbar,#editorTabs,#requestWarning,.response-heading,.response-toolbar,#automationError')) layoutObserver.observe(element);
  const controlsObserver = new ResizeObserver(queueLayout);
  function watchEditorControls() {
    controlsObserver.disconnect();
    for (const element of $('editorContent').querySelectorAll('.editor-section-heading,.body-toolbar,.script-tools,.script-phase-tabs,.script-phase-panel .section-tools')) controlsObserver.observe(element);
  }
  new MutationObserver(records => {
    if (!records.some(record => record.target.matches('#editorContent,.editor-section,.editor-section-body,.script-phase-panel'))) return;
    watchEditorControls(); queueLayout();
  }).observe($('editorContent'), {childList:true, subtree:true, attributes:true, attributeFilter:['hidden']});
  new MutationObserver(queueLayout).observe(root, {attributes:true, attributeFilter:['data-editor-page','data-response-empty','data-workspace-view']});
  watchEditorControls();
  apply();
  return { closeNavigation };
}

/** Keyboard navigation shared by the static editor and response tab strips. */
export function bindTabStrip(root, selector) {
  root.addEventListener('keydown', event => {
    const tabs = [...root.querySelectorAll(selector)], current = event.target.closest(selector);
    const vertical = root.getAttribute('aria-orientation') === 'vertical';
    const previous = vertical ? 'ArrowUp' : 'ArrowLeft', next = vertical ? 'ArrowDown' : 'ArrowRight';
    if (!current || ![previous, next, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let index = tabs.indexOf(current);
    index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === next ? 1 : -1) + tabs.length) % tabs.length;
    tabs[index].click(); tabs[index].focus(); tabs[index].scrollIntoView({block: 'nearest', inline: 'nearest'});
  });
}

/** Anchored item actions: one visible trigger also supports keyboard and touch. */
let menuAnchor, menuAnchorRect;
export function closeItemMenu(restore = true) {
  const menu = $('itemMenu');
  if (menu.hidden) return;
  menu.hidden = true; menuAnchor?.setAttribute('aria-expanded', 'false');
  if (restore && menuAnchor?.isConnected) menuAnchor.focus();
}
export function openItemMenu(anchor, actions, event) {
  closeItemMenu(false); menuAnchor = anchor;
  const menu = $('itemMenu');
  (anchor.closest('dialog[open]') || document.body).append(menu);
  menu.replaceChildren();
  anchor.setAttribute('aria-haspopup', 'menu'); anchor.setAttribute('aria-expanded', 'true');
  menu.setAttribute('aria-label', anchor.getAttribute('aria-label') || '操作');
  for (const action of actions) {
    if (!action) { const line = document.createElement('hr'); line.setAttribute('role', 'separator'); menu.append(line); continue; }
    const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitem'); item.textContent = action.label;
    if (action.danger) item.className = 'danger';
    item.disabled = Boolean(action.disabled);
    item.onclick = () => { closeItemMenu(); action.run(); }; menu.append(item);
  }
  menu.hidden = false;
  const box = anchor.getBoundingClientRect(); menuAnchorRect = box;
  const pointer = event?.type === 'contextmenu' && (event.clientX || event.clientY);
  menu.style.left = `${clamp(pointer ? event.clientX : box.right - menu.offsetWidth, 8, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${clamp(pointer ? event.clientY : box.bottom + 4, 8, innerHeight - menu.offsetHeight - 8)}px`;
  menu.querySelector('button:not(:disabled)')?.focus({preventScroll: true});
}
export function bindItemMenu() {
  const menu = $('itemMenu');
  menu.onkeydown = event => {
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    if (event.key === 'Escape' || event.key === 'Tab') { closeItemMenu(); if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); } return; }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const current = items.indexOf(document.activeElement);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target) && !menuAnchor?.contains(event.target)) closeItemMenu(false); });
  window.addEventListener('resize', () => closeItemMenu());
  document.addEventListener('scroll', event => {
    if (menu.hidden || menu.contains(event.target) || !menuAnchor?.isConnected) return;
    const box = menuAnchor.getBoundingClientRect();
    // Ignore queued scroll events from revealing the trigger before opening.
    if (Math.abs(box.x - menuAnchorRect.x) > .5 || Math.abs(box.y - menuAnchorRect.y) > .5) closeItemMenu(false);
  }, true);
}

// Variable editing keeps the request visible on desktop; compact screens use
// native modal focus containment. Resizing preserves the same form nodes.
let surfaceReturn, surfaceTransition = false;
function restoreSurfaceFocus() {
  if (!surfaceReturn) return;
  const {node, id, label} = surfaceReturn;
  const target = node?.isConnected ? node : id ? $(id) : label ? document.querySelector(`[aria-label="${CSS.escape(label)}"]`) : null;
  (target && target.getClientRects().length && !target.closest('[inert]') ? target : $('requestName')).focus();
}
export function openSurface(kind = 'dialog') {
  const modal = $('modal');
  if (!modal.open) {
    const node = document.activeElement;
    surfaceReturn = {node, id: node?.id, label: node?.getAttribute('aria-label')};
  }
  modal.dataset.kind = kind;
  const useModal = kind !== 'drawer' || matchMedia('(max-width: 1000px)').matches;
  if (modal.open && modal.matches(':modal') !== useModal) { surfaceTransition = true; modal.close(); }
  if (!modal.open) { if (useModal) modal.showModal(); else modal.show(); }
  modal.setAttribute('aria-modal', String(useModal));
  ($('modalBody').querySelector('input:not([hidden]):not([type=file]), textarea, select') || $('closeModal')).focus();
  surfaceTransition = false;
}
export function bindSurface() {
  const modal = $('modal');
  modal.addEventListener('close', () => { if (!surfaceTransition && !modal.open) restoreSurfaceFocus(); });
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !modal.matches(':modal')) { event.preventDefault(); event.stopPropagation(); modal.close(); }
  });
  matchMedia('(max-width: 1000px)').addEventListener('change', () => {
    if (modal.open && modal.dataset.kind === 'drawer') {
      const focused = document.activeElement; openSurface('drawer');
      if (modal.contains(focused)) focused.focus();
    }
  });
}
