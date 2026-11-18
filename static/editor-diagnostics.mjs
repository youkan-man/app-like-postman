/** Source-bound diagnostics; decoration never changes source text or offsets. */
let sequence = 0, activeDiagnostics = null;

export function createEditorDiagnostics({root, area, select, onUpdate=()=>{}}) {
  const doc = root.ownerDocument, view = doc.defaultView;
  const button = doc.createElement('button'); button.type = 'button'; button.className = 'source-diagnostics-toggle'; button.hidden = true;
  const panel = doc.createElement('div'); panel.className = 'source-problem'; panel.id = `source-problem-${++sequence}`; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '構文エラー');
  const message = doc.createElement('div'); message.className = 'source-problem-message'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const dismiss = doc.createElement('button'); dismiss.type = 'button'; dismiss.textContent = '×'; dismiss.setAttribute('aria-label', '構文エラーを閉じる');
  panel.append(message, dismiss);
  button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', panel.id); button.setAttribute('aria-expanded', 'false'); button.title = '次の構文エラー (F8)';
  let items = [], source = '', index = -1, disposed = false;
  const observer = typeof view.MutationObserver === 'function' ? new view.MutationObserver(() => {if (!root.isConnected) dispose();}) : null;
  const valid = () => !disposed && source === area.value;
  function isOpen() {return !disposed && !panel.hidden;}
  function present() {
    const item = items[index]; if (!item) return;
    const lines = source.slice(0, item.from).split(/\r\n|\r|\n/);
    message.textContent = `${index + 1} / ${items.length} · ${lines.length} 行 ${lines.at(-1).length + 1} 列\n${item.message}`;
    position();
  }
  function position() {
    if (!isOpen()) return;
    if (!root.isConnected) {dispose(); return;}
    const viewport = view.visualViewport, gap = 6, left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || view.innerWidth, height = viewport?.height || view.innerHeight;
    panel.style.width = `${Math.min(420, Math.max(0, width - gap * 2))}px`; panel.style.maxHeight = `${Math.max(0, height - gap * 2)}px`;
    const anchor = root.getBoundingClientRect(), size = panel.getBoundingClientRect(), above = anchor.top - gap - size.height;
    panel.style.left = `${Math.max(left + gap, Math.min(anchor.right - size.width, left + width - gap - size.width))}px`;
    panel.style.top = `${above >= top + gap ? above : Math.max(top + gap, Math.min(anchor.bottom + gap, top + height - gap - size.height))}px`;
  }
  function outside(event) {
    if (!isOpen() || panel.contains(event.target) || button.contains(event.target) || (event.type === 'focusin' && event.target === area)) return;
    close();
  }
  function listen(add) {
    const method = add ? 'addEventListener' : 'removeEventListener';
    doc[method]('pointerdown', outside, true); doc[method]('focusin', outside);
    doc[method]('scroll', position, true); view[method]('resize', position);
    view.visualViewport?.[method]('resize', position); view.visualViewport?.[method]('scroll', position);
  }
  function close({focus=false}={}) {
    if (panel.hidden) return;
    panel.hidden = true; panel.remove(); button.setAttribute('aria-expanded', 'false'); listen(false); observer?.disconnect();
    if (activeDiagnostics === api) activeDiagnostics = null;
    if (focus && root.isConnected) {
      const start = area.selectionStart, end = area.selectionEnd, direction = area.selectionDirection;
      select(start, end, {focus:true}); area.setSelectionRange(start, end, direction);
    }
  }
  function next(direction=1) {
    if (!valid()) {clear(); return false;}
    if (!items.length || !root.isConnected) return false;
    const step = direction < 0 ? -1 : 1;
    index = index < 0 ? (step < 0 ? items.length - 1 : 0) : (index + step + items.length) % items.length;
    if (activeDiagnostics && activeDiagnostics !== api) activeDiagnostics.close();
    activeDiagnostics = api;
    const item = items[index]; select(item.from, item.to, {focus:true});
    if (!isOpen()) {
      (root.closest('dialog') || doc.body).append(panel); panel.hidden = false; button.setAttribute('aria-expanded', 'true'); listen(true);
      observer?.observe(doc.body, {childList:true, subtree:true});
    }
    present(); return true;
  }
  function set(values, snapshot) {
    if (disposed) return;
    snapshot = String(snapshot ?? '');
    if (snapshot !== area.value) {clear(); return;}
    const previous = source === snapshot ? items[index] : null;
    const offset = value => Math.max(0, Math.min(snapshot.length, Math.trunc(value)));
    items = (Array.isArray(values) ? values : []).filter(item => item && Number.isFinite(item.from) && Number.isFinite(item.to) && item.to >= item.from)
      .map(item => ({...item, from:offset(item.from), to:offset(item.to), message:String(item.message ?? '')})).sort((a, b) => a.from - b.from || a.to - b.to);
    source = snapshot;
    index = previous ? items.findIndex(item => item.from === previous.from && item.to === previous.to && item.code === previous.code && item.message === previous.message) : -1;
    button.textContent = `構文エラー ${items.length}件`; button.hidden = !items.length;
    if (items.length) area.setAttribute('aria-invalid', 'true'); else area.removeAttribute('aria-invalid');
    if (index < 0) close(); else if (isOpen()) present();
    onUpdate();
  }
  function clear() {
    if (disposed) return;
    items = []; source = ''; index = -1; button.hidden = true; button.textContent = '構文エラー 0件'; area.removeAttribute('aria-invalid'); close(); onUpdate();
  }
  function decorate(pre) {
    // A caller may decorate an existing highlight tree more than once.
    for (const span of pre.querySelectorAll('.source-diagnostic')) span.replaceWith(...span.childNodes);
    if (!valid() || !items.length || !source.length) return;
    const ranges = [];
    for (const item of items) {
      let from = item.from, to = item.to;
      if (from === to) {if (to === source.length) from--; else to++;}
      // Never split a displayed Unicode code point across separate DOM spans.
      if (from > 0 && /[\uDC00-\uDFFF]/.test(source[from]) && /[\uD800-\uDBFF]/.test(source[from - 1])) from--;
      if (to < source.length && /[\uDC00-\uDFFF]/.test(source[to]) && /[\uD800-\uDBFF]/.test(source[to - 1])) to++;
      ranges.push({from, to});
    }
    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    const merged = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range.from <= last.to) last.to = Math.max(last.to, range.to); else merged.push({...range});
    }
    const walker = doc.createTreeWalker(pre, 4), nodes = [];
    let offset = 0, rangeIndex = 0;
    for (let node; (node = walker.nextNode());) {nodes.push({node, start:offset, end:offset + node.data.length}); offset += node.data.length;}
    for (const {node, start, end} of nodes) {
      if (start === end) continue;
      while (rangeIndex < merged.length && merged[rangeIndex].to <= start) rangeIndex++;
      if (rangeIndex === merged.length || merged[rangeIndex].from >= end) continue;
      const fragment = doc.createDocumentFragment(), text = node.data; let cursor = 0;
      for (let i = rangeIndex; i < merged.length && merged[i].from < end; i++) {
        const from = Math.max(start, merged[i].from) - start, to = Math.min(end, merged[i].to) - start;
        fragment.append(doc.createTextNode(text.slice(cursor, from)));
        const mark = doc.createElement('span'); mark.className = 'source-diagnostic'; mark.textContent = text.slice(from, to); fragment.append(mark); cursor = to;
      }
      fragment.append(doc.createTextNode(text.slice(cursor))); node.replaceWith(fragment);
    }
  }
  function keydown(event) {
    if (event.key === 'Enter') {event.stopPropagation(); if (event.ctrlKey || event.metaKey) event.preventDefault();}
    if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {event.preventDefault(); event.stopPropagation(); close({focus:true});}
  }
  function clicked() {next();}
  function dismissed() {close({focus:true});}
  button.addEventListener('click', clicked); button.addEventListener('keydown', keydown);
  dismiss.addEventListener('click', dismissed); panel.addEventListener('keydown', keydown);
  function dispose() {
    close(); disposed = true; observer?.disconnect(); panel.remove(); button.remove(); area.removeAttribute('aria-invalid');
    button.removeEventListener('click', clicked); button.removeEventListener('keydown', keydown);
    dismiss.removeEventListener('click', dismissed); panel.removeEventListener('keydown', keydown);
  }
  const api = {button, set, clear, decorate, next, close, isOpen, position, dispose};
  return api;
}
