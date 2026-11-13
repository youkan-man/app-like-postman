/** Live variable inspection without changing native input editing or request values. */
import {contextFor, enabled, resolver, rows, uid, urlParts} from './core.mjs';

export const VARIABLE_HOVER_SELECTOR = '#url, #editorContent .kv-key input, #editorContent .kv-value input, #editorContent .field-stack input, #editorContent .source-input:not([aria-autocomplete]), [data-variable-hover]';
const dynamicKeys = new Set(['$timestamp', '$isoTimestamp', '$guid', '$randomUUID', '$randomInt']);

export function variableTokens(value) {
  return [...String(value ?? '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => ({key:match[1], start:match.index, end:match.index + match[0].length, text:match[0]}));
}

export function variableAtCaret(value, start, end = start) {
  return variableTokens(value).find(token => start >= token.start && end <= token.end) || null;
}

function isDynamic(key, vars, seen = new Set()) {
  if (seen.has(key)) return false;
  if (!Object.hasOwn(vars, key)) return dynamicKeys.has(key);
  seen.add(key);
  return variableTokens(vars[key]).some(token => isDynamic(token.key, vars, seen));
}

/** The compiler is the sole authority for precedence, recursion and errors. */
export function variablePreview(workspace, tab, key, primary = [], dynamic = {}) {
  const context = contextFor(workspace, tab, primary);
  const layers = [
    ['Globals', workspace.globals],
    ['コレクション: ' + (context.collection?.info?.name || ''), context.collection?.variable],
    ...context.parents.map(parent => ['フォルダー: ' + parent.name, parent.variable]),
    ['環境: ' + (context.environment?.name || ''), context.environment?.values],
    ['パス変数', urlParts(tab.request.url).variable],
    ['一次変数', primary]
  ];
  let scope = dynamicKeys.has(key) ? '動的変数' : '';
  for (const [name, values] of layers) if (rows(values).some(row => enabled(row) && row.key === key)) scope = name;
  if (!Object.hasOwn(context.vars, key) && !dynamicKeys.has(key)) return {key, scope:'', state:'missing', value:'', message:'未設定', dynamic:false};
  try {
    const value = resolver(context.vars, dynamic)(`{{${key}}}`);
    return {key, scope, state:value === '' ? 'empty' : 'resolved', value, message:value === '' ? '空文字' : '', dynamic:isDynamic(key, context.vars)};
  } catch (error) {
    return {key, scope, state:'error', value:'', message:error.message, dynamic:false};
  }
}

/** Measure native input text with the same font, wrapping and scroll offsets. */
export function variableTokenRects(control) {
  const tokens = variableTokens(control.value);
  if (!tokens.length) return [];
  const document = control.ownerDocument, window = document.defaultView;
  const style = window.getComputedStyle(control), box = control.getBoundingClientRect();
  const mirror = document.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  Object.assign(mirror.style, {position:'fixed', left:`${box.left}px`, top:`${box.top}px`, margin:'0', visibility:'hidden', pointerEvents:'none', overflow:'hidden', boxSizing:'border-box', zIndex:'-1'});
  for (const property of ['fontFamily','fontSize','fontWeight','fontStyle','fontVariant','fontStretch','fontKerning','fontFeatureSettings','fontVariationSettings','lineHeight','letterSpacing','wordSpacing','tabSize','textAlign','textIndent','textTransform','direction','wordBreak','overflowWrap','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth']) mirror.style[property] = style[property];
  mirror.style.borderStyle = 'solid';
  mirror.style.width = `${control.clientWidth + parseFloat(style.borderLeftWidth || 0) + parseFloat(style.borderRightWidth || 0)}px`;
  mirror.style.height = `${control.clientHeight + parseFloat(style.borderTopWidth || 0) + parseFloat(style.borderBottomWidth || 0)}px`;
  const multiline = control.tagName === 'TEXTAREA';
  mirror.style.whiteSpace = multiline && control.wrap !== 'off' ? 'pre-wrap' : 'pre';
  if (!multiline) mirror.style.lineHeight = `${Math.max(1, control.clientHeight - parseFloat(style.paddingTop || 0) - parseFloat(style.paddingBottom || 0))}px`;
  // Masked inputs retain their native appearance. One template covers the field;
  // keyboard selection can still inspect an individual template in mixed values.
  if (control.type === 'password') return tokens.map(token => ({...token, rects:[{left:box.left, right:box.right, top:box.top, bottom:box.bottom, width:box.width, height:box.height}]}));
  const text = document.createTextNode(control.value);
  mirror.append(text); document.body.append(mirror);
  try {
    mirror.scrollLeft = control.scrollLeft;
    mirror.scrollTop = control.scrollTop;
    const range = document.createRange();
    return tokens.map(token => {
      range.setStart(text, token.start); range.setEnd(text, token.end);
      return {...token, rects:[...range.getClientRects()].filter(rect => rect.width > 0).map(rect => ({left:rect.left, right:rect.right, top:rect.top, bottom:rect.bottom, width:rect.width, height:rect.height}))};
    });
  } finally {mirror.remove();}
}

/** Choose a real side of the field, then scroll within that side's space. */
export function variableTooltipPlacement(anchor, desiredHeight, {top = 0, height}, {margin = 8, gap = 6, maxHeight = 340} = {}) {
  const start = top + margin, end = top + height - margin;
  const aboveEdge = Math.min(end, anchor.top - gap), belowEdge = Math.max(start, anchor.bottom + gap);
  const above = Math.max(0, aboveEdge - start), below = Math.max(0, end - belowEdge);
  const wanted = Math.min(desiredHeight, maxHeight);
  const side = wanted <= above ? 'above' : wanted <= below ? 'below' : above >= below ? 'above' : 'below';
  return {side, edge:side === 'above' ? aboveEdge : belowEdge, maxHeight:Math.min(maxHeight, side === 'above' ? above : below)};
}

let tooltipSequence = 0;
export function bindVariableHover({root = document, workspace, active, primary = () => [], selector = VARIABLE_HOVER_SELECTOR} = {}) {
  const document = root.ownerDocument || root, window = document.defaultView;
  const tip = document.createElement('div'); tip.className = 'variable-tooltip'; tip.id = `variable-tooltip-${++tooltipSequence}`; tip.hidden = true; tip.setAttribute('role', 'tooltip');
  const heading = document.createElement('div'); heading.className = 'variable-tooltip-heading';
  const name = document.createElement('code'); name.className = 'variable-tooltip-name';
  const scope = document.createElement('span'); scope.className = 'variable-tooltip-scope';
  const value = document.createElement('pre'); value.className = 'variable-tooltip-value';
  const note = document.createElement('span'); note.className = 'variable-tooltip-note'; note.textContent = '送信時に再生成'; note.hidden = true;
  // Keep the accessible description value-first. Visually, the compact metadata
  // line moves to the far edge so the value always touches the field-facing edge.
  heading.append(name, scope, note); tip.append(value, heading); document.body.append(tip);
  let state = null, dismissed = null, animation = null, hideTimer = null, refreshTimer = null, pending = null, pointerInTip = false;
  const geometries = new WeakMap();
  const listeners = [];
  function listen(target, type, fn, options) {target.addEventListener(type, fn, options); listeners.push(() => target.removeEventListener(type, fn, options));}
  function eligible(target) {
    const control = target?.closest?.('input, textarea');
    return control?.matches(selector) && (control.tagName === 'TEXTAREA' || ['text','url','password','search'].includes(control.type)) && !control.disabled && !control.closest('[hidden]') ? control : null;
  }
  function clearDescription(control) {
    if (!control) return;
    const ids = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== tip.id);
    if (ids.length) control.setAttribute('aria-describedby', ids.join(' ')); else control.removeAttribute('aria-describedby');
  }
  function hide() {
    window.clearTimeout(hideTimer); window.clearInterval(refreshTimer); hideTimer = refreshTimer = null;
    if (state) clearDescription(state.control);
    state = null; tip.hidden = true; pointerInTip = false;
  }
  function postponeHide() {window.clearTimeout(hideTimer); hideTimer = window.setTimeout(hide, 130);}
  function locate(control) {
    const box = control.getBoundingClientRect();
    const signature = [control.value, control.scrollLeft, control.scrollTop, box.left, box.top, box.width, box.height, window.getComputedStyle(control).font].join('\u0000');
    let geometry = geometries.get(control);
    if (geometry?.signature !== signature) {geometry = {signature, tokens:variableTokenRects(control)}; geometries.set(control, geometry);}
    return {box, tokens:geometry.tokens};
  }
  function atPointer(control, x, y) {
    const {box, tokens} = locate(control);
    const left = box.left + control.clientLeft, top = box.top + control.clientTop;
    if (x < left || x > left + control.clientWidth || y < top || y > top + control.clientHeight) return null;
    if (control.type === 'password') return tokens.length === 1 ? {...tokens[0], anchor:box} : null;
    const multiline = control.tagName === 'TEXTAREA', line = parseFloat(window.getComputedStyle(control).lineHeight) || 20;
    for (const token of tokens) for (const rect of token.rects) {
      const extra = Math.max(0, (line - rect.height) / 2);
      if (x >= rect.left && x <= rect.right && (!multiline || y >= rect.top - extra && y <= rect.bottom + extra)) return {...token, anchor:multiline ? rect : box};
    }
    return null;
  }
  function position() {
    if (!state) return;
    const view = window.visualViewport, margin = 8, leftEdge = view?.offsetLeft || 0, topEdge = view?.offsetTop || 0;
    const width = view?.width || document.documentElement.clientWidth, height = view?.height || document.documentElement.clientHeight;
    const scrollTop = value.scrollTop, scrollLeft = value.scrollLeft;
    const maxWidth = Math.max(1, Math.min(520, width - 2 * margin));
    tip.style.maxWidth = `${maxWidth}px`; tip.style.minWidth = `${Math.min(120, maxWidth)}px`;
    tip.style.maxHeight = `${Math.max(1, Math.min(340, height - 2 * margin))}px`;
    tip.dataset.compact = 'false';
    const box = state.anchor, placement = variableTooltipPlacement(box, tip.getBoundingClientRect().height, {top:topEdge, height});
    if (placement.maxHeight < 42) {hide(); return;}
    tip.dataset.side = placement.side;
    tip.dataset.compact = String(placement.maxHeight < 56);
    tip.style.maxHeight = `${placement.maxHeight}px`;
    const tipBox = tip.getBoundingClientRect();
    const left = Math.max(leftEdge + margin, Math.min(state.x ?? box.left, leftEdge + width - tipBox.width - margin));
    const top = placement.side === 'above' ? placement.edge - tipBox.height : placement.edge;
    tip.style.left = `${left}px`; tip.style.top = `${top}px`;
    // Measuring an unconstrained preview must not move a reader's scroll on the
    // periodic live-value refresh, especially in a short visual viewport.
    value.scrollTop = scrollTop; value.scrollLeft = scrollLeft;
  }
  function render() {
    if (!state || !state.control.isConnected || state.control.closest('[hidden]') || !variableTokens(state.control.value).some(token => token.key === state.key && token.start === state.start)) {hide(); return;}
    let result;
    try {result = variablePreview(workspace(), active(), state.key, primary(), state.dynamic);}
    catch (error) {result = {state:'error', scope:'', message:error.message, value:''};}
    const nextName = `{{${state.key}}}`, nextValue = result.message || result.value;
    if (name.textContent !== nextName) name.textContent = nextName;
    if (scope.textContent !== result.scope) scope.textContent = result.scope;
    if (value.textContent !== nextValue) value.textContent = nextValue;
    note.hidden = !result.dynamic;
    tip.dataset.state = result.state; tip.hidden = false;
    position();
  }
  function show(control, token, mode, x) {
    window.clearTimeout(hideTimer);
    if (dismissed?.control === control && dismissed.start === token.start && dismissed.key === token.key) return;
    if (state?.control !== control || state.key !== token.key || state.start !== token.start) {
      hide(); dismissed = null;
      state = {control, ...token, mode, x, dynamic:{$timestamp:String(Math.floor(Date.now() / 1000)), $isoTimestamp:new Date().toISOString(), $guid:uid(), $randomUUID:uid(), $randomInt:String(Math.floor(Math.random() * 1001))}};
      const ids = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean); ids.push(tip.id); control.setAttribute('aria-describedby', [...new Set(ids)].join(' '));
      // Keep an open preview current when scripts or a relation update variables.
      refreshTimer = window.setInterval(render, 400);
    } else Object.assign(state, {mode, anchor:token.anchor, x});
    render();
  }
  function inspectPointer(event) {
    if (event.pointerType === 'touch' || tip.contains(event.target)) return;
    const control = eligible(event.target);
    if (!control) {if (state) postponeHide(); dismissed = null; return;}
    pending = {control, x:event.clientX, y:event.clientY};
    if (animation !== null) return;
    animation = window.requestAnimationFrame(() => {
      animation = null;
      const {control, x, y} = pending, token = atPointer(control, x, y);
      if (token) show(control, token, 'pointer', x); else {dismissed = null; hide();}
    });
  }
  function inspectCaret(control) {
    if (!control || control.selectionStart == null) {hide(); return;}
    const token = variableAtCaret(control.value, control.selectionStart, control.selectionEnd);
    if (!token) {dismissed = null; hide(); return;}
    const {box, tokens} = locate(control), found = tokens.find(item => item.start === token.start);
    const anchor = found?.rects.find(rect => rect.bottom >= box.top && rect.top <= box.bottom && rect.right >= box.left && rect.left <= box.right) || box;
    show(control, {...token, anchor:control.tagName === 'TEXTAREA' ? anchor : box}, 'keyboard');
  }
  listen(root, 'pointermove', inspectPointer);
  listen(root, 'pointerover', inspectPointer);
  listen(root, 'pointerout', event => {if (state && (event.target === state.control || tip.contains(event.target)) && !tip.contains(event.relatedTarget) && event.relatedTarget !== state.control) {postponeHide(); dismissed = null;}});
  listen(tip, 'pointerenter', () => {pointerInTip = true; window.clearTimeout(hideTimer);});
  listen(tip, 'pointerleave', () => {pointerInTip = false;});
  listen(root, 'focusin', event => {const control = eligible(event.target); if (control) {dismissed = null; if (state?.control !== control) hide();} else if (!tip.contains(event.target)) hide();});
  // Clicking selectable value text can blur an input with relatedTarget=null.
  // Keep the preview alive while the pointer is selecting its contents.
  listen(root, 'focusout', event => {if (event.target === state?.control && !pointerInTip && !tip.contains(event.relatedTarget)) hide();});
  const caretKeys = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Tab']);
  listen(root, 'keyup', event => {const control = eligible(event.target); if (control && caretKeys.has(event.key) && !event.isComposing) inspectCaret(control);});
  listen(root, 'click', event => {const control = eligible(event.target); if (control && state?.mode !== 'pointer') inspectCaret(control);});
  // Typing or filling a field should not open a popup over the next control.
  // Hovering or deliberately moving the caret can inspect the new value.
  listen(root, 'input', event => {if (event.isComposing) {hide(); return;} const control = eligible(event.target); if (control) {dismissed = null; geometries.delete(control); hide();} else render();});
  listen(root, 'change', () => render());
  listen(root, 'compositionstart', hide);
  listen(root, 'keydown', event => {
    if (event.key === 'Escape' && state) {
      // Dismissing this preview must not also cancel a request or close a dialog.
      event.preventDefault(); event.stopPropagation();
      dismissed = {control:state.control, key:state.key, start:state.start}; hide();
    }
  }, true);
  listen(document, 'selectionchange', () => {if (state?.mode === 'keyboard' && !tip.contains(document.getSelection()?.anchorNode)) {const control = eligible(document.activeElement); if (control) inspectCaret(control);}});
  listen(root, 'scroll', event => {if (!tip.contains(event.target)) hide();}, true);
  listen(window, 'resize', hide);
  listen(window, 'blur', hide);
  if (window.visualViewport) {listen(window.visualViewport, 'resize', hide); listen(window.visualViewport, 'scroll', hide);}
  return {refresh:render, hide, destroy() {hide(); for (const remove of listeners) remove(); if (animation !== null) window.cancelAnimationFrame(animation); tip.remove();}};
}
