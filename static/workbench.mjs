/** Layout-only state: request data and network I/O remain owned by app.js. */
const $ = id => document.getElementById(id);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const KEY = 'minipost.layout.v1';

export function initWorkbench() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
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
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
  const effectiveSplit = () => wide.matches ? state.split : 'stack';
  const visible = () => narrow.matches ? mobileOpen : state.open;

  function apply() {
    const open = visible(), split = effectiveSplit();
    root.dataset.navigation = open ? 'open' : 'closed';
    root.dataset.layout = split;
    root.dataset.wrap = String(state.wrap);
    root.style.setProperty('--sidebar', `${state.sidebar}px`);
    const ratio = state[split === 'side' ? 'sideRatio' : 'stackRatio'];
    root.style.setProperty('--request-fr', `${ratio}fr`);
    root.style.setProperty('--response-fr', `${1 - ratio}fr`);
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
    $('responseResize').setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
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
    const split = effectiveSplit();
    state[split === 'side' ? 'sideRatio' : 'stackRatio'] = clamp(split === 'side' ? (event.clientX - box.x) / box.width : (event.clientY - box.y) / box.height, .25, .75);
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
    state[key] = event.key === 'Home' ? .25 : event.key === 'End' ? .75 : clamp(state[key] + (event.key === keys[1] ? .05 : -.05), .25, .75); apply(); save();
  };
  narrow.addEventListener('change', () => { mobileOpen = false; apply(); });
  wide.addEventListener('change', apply);
  apply();
  return { closeNavigation };
}

/** Keyboard navigation shared by the static editor and response tab strips. */
export function bindTabStrip(root, selector) {
  root.addEventListener('keydown', event => {
    const tabs = [...root.querySelectorAll(selector)], current = event.target.closest(selector);
    if (!current || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let index = tabs.indexOf(current);
    index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
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
