/** Let a pane's fixed controls scroll its content without replacing native scrolling. */
const scrollable = (element, axis) => {
  const style = getComputedStyle(element);
  return /^(auto|scroll)$/.test(axis === 'x' ? style.overflowX : style.overflowY)
    && (axis === 'x' ? element.scrollWidth > element.clientWidth + 1 : element.scrollHeight > element.clientHeight + 1);
};

function axes(event) {
  let x = event.deltaX, y = event.deltaY;
  if (event.shiftKey && !x) {x = y; y = 0;}
  return {x, y};
}

function deltas(event, target) {
  let {x, y} = axes(event);
  if (event.deltaMode === 1) {
    const line = parseFloat(getComputedStyle(target).lineHeight) || 16;
    x *= line; y *= line;
  } else if (event.deltaMode === 2) {
    x *= target.clientWidth; y *= target.clientHeight;
  }
  return {x, y};
}

function canMove(element, x, y) {
  return (x && scrollable(element, 'x') && (x < 0 ? element.scrollLeft > 0 : element.scrollLeft < element.scrollWidth - element.clientWidth - 1))
    || (y && scrollable(element, 'y') && (y < 0 ? element.scrollTop > 0 : element.scrollTop < element.scrollHeight - element.clientHeight - 1));
}

export function bindWheelScroll(surface, targets) {
  function wheel(event) {
    if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || (!event.deltaX && !event.deltaY)) return;
    const origin = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!origin || !surface.contains(origin) || origin.closest('select,input[type=number],input[type=range]')) return;
    if (origin.closest('textarea,[role=listbox],[role=menu]')) return;
    const editor = origin.closest('.source-editor');
    if (editor && editor !== surface) return;
    const direction = axes(event), horizontal = Boolean(direction.x), vertical = Boolean(direction.y);
    const hasRange = element => (horizontal && scrollable(element, 'x')) || (vertical && scrollable(element, 'y'));
    // A textarea, menu, list or other nested scroller keeps its own native wheel
    // handling, including normal chaining when it reaches an edge.
    for (let node = origin; node && node !== surface; node = node.parentElement) {
      if (hasRange(node)) return;
    }
    // Short panes scroll their controls natively before their content.
    if (canMove(surface, direction.x, direction.y)) return;
    const candidates = typeof targets === 'function' ? targets() : targets;
    const target = candidates.find(element => element?.getClientRects().length && canMove(element, direction.x, direction.y));
    if (!target || target.contains(origin)) return;
    const {x, y} = deltas(event, target);
    // A source editor can cancel pending completion even when this wheel came
    // from a sibling toolbar and never passed through the editor itself.
    target.dispatchEvent(new Event('minipost-wheel-scroll'));
    const top = target.scrollTop, left = target.scrollLeft;
    target.scrollBy({left:x, top:y, behavior:'instant'});
    if (target.scrollTop !== top || target.scrollLeft !== left) event.preventDefault();
  }
  surface.addEventListener('wheel', wheel, {passive:false});
  return () => surface.removeEventListener('wheel', wheel);
}
