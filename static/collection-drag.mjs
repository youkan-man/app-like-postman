/** Pointer drag works with mouse, touch and pen; the grip also supports keyboard. */
import {findItem} from './core.mjs';
import {buildCollectionDropTargets, resolveCollectionDropTarget} from './collection-drop.mjs';

export function bindCollectionDrag(root, {workspace, move, error = () => {}}) {
  let drag = null, suppressClick = false;
  const line = document.createElement('div');
  line.className = 'tree-drop-line'; line.hidden = true; line.setAttribute('aria-hidden', 'true');
  document.body.append(line);
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
  function targets() {
    if (!drag) return [];
    const box = root.getBoundingClientRect();
    const geometry = [root.scrollTop, root.scrollLeft, box.left, box.top, box.width, box.height].join(':');
    if (drag.geometry !== geometry) {
      drag.geometry = geometry;
      const visibleRows = rows().map(row => {
        const rect = row.getBoundingClientRect();
        return {...sourceOf(row), element:row, top:rect.top, bottom:rect.bottom, left:rect.left, right:rect.right,
          indentLeft:rect.left + (parseFloat(getComputedStyle(row).paddingLeft) || 0),
          expanded:row.querySelector('.tree-open')?.getAttribute('aria-expanded') === 'true'};
      }).filter(row => row.bottom > row.top);
      drag.targets = buildCollectionDropTargets(workspace(), drag.source, visibleRows);
    }
    return drag.targets;
  }
  function clearTarget() {
    drag?.target?.anchor?.element?.removeAttribute('data-drop-position');
    line.hidden = true; delete line.dataset.dropKey;
    if (drag) drag.target = null;
  }
  function setTarget(target) {
    if (!drag || !target || target.noop) {clearTarget(); return;}
    const changed = drag.target?.key !== target.key || drag.target?.kind !== target.kind;
    if (changed) clearTarget();
    drag.target = target;
    if (target.kind === 'inside') {
      target.anchor.element.dataset.dropPosition = 'inside'; line.hidden = true;
    } else {
      const box = root.getBoundingClientRect();
      const left = Math.max(4, box.left, target.left), right = Math.min(innerWidth - 4, box.right, target.right);
      line.hidden = right <= left || target.y < box.top || target.y > box.bottom;
      line.dataset.dropKey = target.key;
      line.style.left = `${left}px`; line.style.top = `${target.y - 1}px`; line.style.width = `${Math.max(0, right - left)}px`;
    }
    if (changed) {
      const collection = workspace().collections.find(item => item._mpId === target.intent.targetCollectionId);
      const parent = target.parentId && target.parentId !== collection?._mpId ? findItem(collection, target.parentId)?.item : collection;
      live.textContent = target.kind === 'inside' ? `${titleOf(target.anchor.element)}へ移動`
        : `${drag.source.itemId ? parent?.name || parent?.info?.name || 'リクエスト' : 'コレクション'}の${target.index + 1}番目`;
    }
  }
  function locate(x, y) {
    const box = root.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) {clearTarget(); return;}
    const visible = targets().filter(target => target.kind === 'inside' || target.y >= box.top && target.y <= box.bottom);
    setTarget(resolveCollectionDropTarget(visible, {x,y}));
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
    const intent = drag?.target?.intent, original = drag?.row;
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
  function onScroll() {
    if (!drag?.started) return;
    const key = drag.target?.key; drag.geometry = null;
    if (drag.pointerId !== undefined) locate(drag.x, drag.y);
    else setTarget(targets().find(target => target.key === key));
  }
  root.addEventListener('scroll', onScroll, {passive:true});
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
      start(grip.closest('.tree-row'), grip); live.textContent = '上下キーで挿入位置、右キーで内部、Enterで確定、Escapeでキャンセル。'; return;
    }
    if (!drag || drag.pointerId !== undefined) return;
    if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); event.stopImmediatePropagation(); finish(); return;}
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const candidates = targets().filter(target => !target.noop).sort((a,b) => a.y - b.y || a.left - b.left);
    if (!candidates.length) return;
    const current = drag.target, index = candidates.findIndex(target => target.key === current?.key);
    let target;
    if (event.key === 'Home') target = candidates[0];
    else if (event.key === 'End') target = candidates.at(-1);
    else if (event.key === 'ArrowDown') target = candidates[Math.min(candidates.length - 1, index + 1)];
    else if (event.key === 'ArrowUp') target = candidates[Math.max(0, index - 1)];
    else if (event.key === 'ArrowRight') {
      const anchor = current?.anchor || candidates[0].anchor;
      target = candidates.find(item => item.kind === 'inside' && item.anchor.element === anchor.element);
    } else {
      const containerId = current?.kind === 'inside' ? current.anchor.itemId : current?.parentId;
      target = candidates.find(item => item.kind === 'gap' && item.anchor.itemId === containerId
        && item.intent.targetCollectionId === current?.intent.targetCollectionId);
    }
    if (!target) return;
    target.anchor.element.scrollIntoView({block:'nearest'});
    const key = target.key; drag.geometry = null;
    setTarget(targets().find(item => item.key === key));
  }, true);
  return {cancel, disconnect() {cancel(); observer.disconnect(); root.removeEventListener('scroll', onScroll); line.remove(); live.remove();}};
}
