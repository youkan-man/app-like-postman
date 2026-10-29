/** Pointer drag works with mouse, touch and pen; the grip also supports keyboard. */
import {planCollectionMove} from './collection-move.mjs';

export function bindCollectionDrag(root, {workspace, move, error = () => {}}) {
  let drag = null, suppressClick = false;
  const indicator = document.createElement('div');
  indicator.className = 'tree-drop-indicator'; indicator.hidden = true;
  document.body.append(indicator);
  const live = document.createElement('span'); live.className = 'visually-hidden';
  live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); root.after(live);
  const rows = () => [...root.querySelectorAll('.tree-row[data-collection-id]')];
  const sourceOf = row => ({collectionId: row.dataset.collectionId, itemId: row.dataset.itemId || ''});
  const titleOf = row => row.querySelector('.tree-label')?.textContent || '';
  function prepareRows() {
    for (const row of rows()) {
      if (row.querySelector('.tree-drag-handle')) continue;
      const grip = document.createElement('button'); grip.type = 'button';
      grip.className = 'tree-drag-handle'; grip.textContent = '⠿';
      grip.setAttribute('aria-label', `${titleOf(row)}を移動`);
      grip.title = 'ドラッグで移動 · Spaceで移動先を選択';
      row.prepend(grip);
    }
  }
  const observer = new MutationObserver(() => {
    prepareRows();
    if (drag && !drag.row.isConnected) cancel();
  });
  observer.observe(root, {childList: true, subtree: true}); prepareRows();
  function clearTarget() {
    for (const row of rows()) row.removeAttribute('data-drop-position');
    indicator.hidden = true;
    if (drag) drag.target = null;
  }
  function setTarget(row, position) {
    clearTarget();
    if (!drag || !row) return;
    const intent = {...drag.source, targetCollectionId: row.dataset.collectionId, targetId: row.dataset.itemId || '', position};
    try {planCollectionMove(workspace(), intent);} catch {return;}
    row.dataset.dropPosition = position; drag.target = intent; drag.targetRow = row;
    const box = row.getBoundingClientRect(); indicator.hidden = false;
    indicator.style.left = `${Math.max(4, box.left)}px`;
    indicator.style.top = `${Math.min(innerHeight - 28, Math.max(4, box.top - 25))}px`;
    indicator.textContent = `${titleOf(row)}${position === 'inside' ? ' の中へ' : position === 'before' ? ' の前へ' : ' の後へ'}`;
    live.textContent = indicator.textContent;
  }
  function locate(x, y) {
    const row = document.elementFromPoint(x, y)?.closest('.tree-row[data-collection-id]');
    if (!row || !root.contains(row)) {clearTarget(); return;}
    const box = row.getBoundingClientRect(), fraction = (y - box.top) / box.height;
    const canContain = !row.dataset.itemId || row.querySelector('.tree-open[aria-expanded]');
    const position = !drag.source.itemId ? (fraction < .5 ? 'before' : 'after')
      : !row.dataset.itemId ? 'inside'
      : canContain && fraction > .25 && fraction < .75 ? 'inside'
      : fraction < .5 ? 'before' : 'after';
    setTarget(row, position);
  }
  function cancel() {
    if (!drag) return;
    drag.row.classList.remove('tree-dragging');
    drag.grip?.setAttribute('aria-pressed', 'false');
    const source = drag; clearTarget(); drag = null; document.body.classList.remove('tree-drag-active');
    cancelAnimationFrame(source.scrollFrame);
    if (source.pointerId !== undefined && root.hasPointerCapture(source.pointerId)) root.releasePointerCapture(source.pointerId);
  }
  function finish() {
    const intent = drag?.target, original = drag?.row;
    cancel();
    if (intent) {try {move(intent); live.textContent = '移動しました。';} catch (e) {error(e.message);}}
    else original?.querySelector('.tree-drag-handle')?.focus({preventScroll: true});
  }
  function start(row, grip, pointerId) {
    drag = {row, grip, source: sourceOf(row), pointerId, target: null, started: pointerId === undefined};
    grip?.setAttribute('aria-pressed', 'true');
    if (pointerId === undefined) row.classList.add('tree-dragging');
    return drag;
  }
  function autoScroll() {
    if (!drag?.started || drag.pointerId === undefined) return;
    const box = root.getBoundingClientRect();
    const speed = drag.y < box.top + 30 ? -10 : drag.y > box.bottom - 30 ? 10 : 0;
    if (speed) {root.scrollTop += speed; locate(drag.x, drag.y);}
    drag.scrollFrame = requestAnimationFrame(autoScroll);
  }
  root.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    const row = event.target.closest('.tree-row[data-collection-id]');
    if (!row) return;
    const grip = event.target.closest('.tree-drag-handle');
    if (!grip && (event.pointerType !== 'mouse' || !event.target.closest('.tree-open'))) return;
    start(row, row.querySelector('.tree-drag-handle'), event.pointerId);
    Object.assign(drag, {startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY});
    // Touch uses the grip so normal vertical scrolling remains available on rows.
    if (grip) event.preventDefault();
  });
  window.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.started && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
    if (!drag.started) {
      drag.started = true; drag.row.classList.add('tree-dragging'); document.body.classList.add('tree-drag-active');
      root.setPointerCapture(event.pointerId); autoScroll();
    }
    event.preventDefault(); locate(event.clientX, event.clientY);
  }, {passive: false});
  window.addEventListener('pointerup', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.started) {cancel(); return;}
    event.preventDefault(); suppressClick = true;
    finish(); setTimeout(() => {suppressClick = false;}, 0);
  });
  root.addEventListener('click', event => {
    if (suppressClick || event.target.closest('.tree-drag-handle')) {event.preventDefault(); event.stopImmediatePropagation();}
  }, true);
  window.addEventListener('pointercancel', event => {if (drag?.pointerId === event.pointerId) cancel();});
  // Touch initially captures to the grip. Its bubbling loss during transfer to
  // the list is not cancellation of the list's own capture.
  root.addEventListener('lostpointercapture', event => {if (event.target === root && drag?.pointerId === event.pointerId) cancel();});
  root.addEventListener('dragstart', event => {if (event.target.closest('.tree-row')) event.preventDefault();});
  document.addEventListener('keydown', event => {
    if (drag && event.key === 'Escape') {event.preventDefault(); event.stopImmediatePropagation(); cancel(); return;}
    const grip = event.target.closest?.('.tree-drag-handle');
    if (!grip) return;
    if (!drag && [' ', 'Enter'].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      start(grip.closest('.tree-row'), grip); live.textContent = '上下キーで移動先、右キーで内部、Enterで確定、Escapeでキャンセル。'; return;
    }
    if (!drag || drag.pointerId !== undefined) return;
    if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); event.stopImmediatePropagation(); finish(); return;}
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const candidates = rows().filter(row => row !== drag.row);
    let index = candidates.indexOf(drag.targetRow);
    if (event.key === 'ArrowUp') index = Math.max(0, index - 1);
    if (event.key === 'ArrowDown') index = Math.min(candidates.length - 1, index + 1);
    if (event.key === 'Home') index = 0;
    if (event.key === 'End') index = candidates.length - 1;
    const row = candidates[Math.max(0, index)]; if (!row) return;
    const position = !drag.source.itemId ? (event.key === 'ArrowUp' ? 'before' : 'after')
      : !row.dataset.itemId ? 'inside'
      : event.key === 'ArrowRight' ? 'inside' : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? 'before' : 'after';
    row.scrollIntoView({block: 'nearest'}); setTarget(row, position);
  }, true);
  return {cancel, disconnect() {cancel(); observer.disconnect(); indicator.remove(); live.remove();}};
}
