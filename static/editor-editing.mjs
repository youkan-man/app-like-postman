/** Pure textarea edit plans. Offsets use the DOM's UTF-16 code units. */
const horizontal = /^[\t ]*/;
const closing = {'(':')', '[':']', '{':'}'};

function range(source, start, end) {
  source = String(source ?? '');
  const offset = value => Math.max(0, Math.min(source.length, Number.isFinite(value) ? Math.trunc(value) : source.length));
  start = offset(start); end = offset(end);
  return {source, start:Math.min(start, end), end:Math.max(start, end)};
}

function lineStart(source, position) {
  if (position <= 0) return 0;
  return Math.max(source.lastIndexOf('\n', position - 1), source.lastIndexOf('\r', position - 1)) + 1;
}

function lineEnd(source, position) {
  for (let i = position; i < source.length; i++) if (source[i] === '\r' || source[i] === '\n') return i;
  return source.length;
}

function indentation(value) {
  return typeof value === 'string' && /^[\t ]+$/.test(value) ? value : '  ';
}

function width(text, tabSize) {
  let column = 0;
  for (const character of text) column += character === '\t' ? tabSize - column % tabSize : 1;
  return column;
}

function shortenedIndent(prefix, columns, tabSize) {
  const target = Math.max(0, width(prefix, tabSize) - columns);
  // Prefer removing a complete leading unit so indent/outdent preserves the
  // original tabs instead of needlessly converting them to equivalent spaces.
  let removed = 0, count = 0;
  while (count < prefix.length && removed < columns) {
    const next = removed + (prefix[count] === '\t' ? tabSize - removed % tabSize : 1);
    if (next > columns) break;
    removed = next; count++;
  }
  const suffix = prefix.slice(count);
  if (removed === columns && width(suffix, tabSize) === target) return suffix;
  let result = '', column = 0;
  for (const character of prefix) {
    const next = column + (character === '\t' ? tabSize - column % tabSize : 1);
    if (next > target) break;
    result += character; column = next;
  }
  return result + ' '.repeat(target - column);
}

function applyChanges(source, start, end, changes) {
  if (!changes.length) return null;
  const from = changes[0].from, to = changes.at(-1).to;
  let text = '', previous = from;
  for (const change of changes) {
    text += source.slice(previous, change.from) + change.text;
    previous = change.to;
  }
  text += source.slice(previous, to);
  function translate(position, includeInsertion) {
    let delta = 0;
    for (const change of changes) {
      if (position < change.from) break;
      const removed = change.to - change.from;
      if (!removed && position === change.from && !includeInsertion) break;
      if (position >= change.to) delta += change.text.length - removed;
      else return change.from + delta + Math.max(0, Math.min(change.text.length, position - change.from + change.text.length - removed));
    }
    return position + delta;
  }
  return {from, to, text, selectionStart:translate(start, start === end), selectionEnd:translate(end, true)};
}

/** Indent selected lines as one edit; a selection never loses its code. */
export function indentEdit(source, start, end, {direction='forward', indent='  ', tabSize=2}={}) {
  ({source, start, end} = range(source, start, end));
  indent = indentation(indent);
  tabSize = Number.isInteger(tabSize) && tabSize > 0 && tabSize <= 32 ? tabSize : 2;
  const backward = direction === 'backward';
  const first = lineStart(source, start);
  if (!backward && start === end) {
    const column = width(source.slice(first, start), tabSize);
    const text = indent === '\t' ? '\t' : ' '.repeat(tabSize - column % tabSize);
    return {from:start, to:end, text, selectionStart:start + text.length, selectionEnd:start + text.length};
  }
  // A selection ending at column zero does not include that following line.
  let last = lineStart(source, end);
  if (end > start && last === end) last = lineStart(source, end - (source[end - 2] === '\r' && source[end - 1] === '\n' ? 2 : 1));
  const changes = [], unit = width(indent, tabSize);
  for (let position = first; position <= last;) {
    if (backward) {
      const prefix = source.slice(position, lineEnd(source, position)).match(horizontal)[0];
      const text = shortenedIndent(prefix, unit, tabSize);
      if (text !== prefix) changes.push({from:position, to:position + prefix.length, text});
    } else changes.push({from:position, to:position, text:indent});
    const eol = lineEnd(source, position);
    if (eol >= source.length) break;
    position = eol + (source[eol] === '\r' && source[eol + 1] === '\n' ? 2 : 1);
  }
  return applyChanges(source, start, end, changes);
}

/** Only classify enough lexical context to indent an opening delimiter safely. */
function contextAt(source, position, language) {
  const javascript = language === 'javascript', graphql = language === 'graphql';
  const frames = [{kind:'code', interpolation:false, braces:0}], parentheses = [];
  let last = null, lastAt = -1, expression = true, control = false;
  const expressionWords = new Set(['return','throw','case','delete','void','typeof','instanceof','in','of','yield','await','new','else','do']);
  const controlWords = new Set(['if','while','for','with','switch','catch']);
  for (let i = 0; i < position;) {
    const frame = frames.at(-1), character = source[i], next = i + 1 < position ? source[i + 1] : undefined;
    if (frame.kind === 'line-comment') {
      if (character === '\r' || character === '\n') frames.pop();
      i++; continue;
    }
    if (frame.kind === 'block-comment') {
      if (character === '*' && next === '/') {frames.pop(); i += 2;} else i++;
      continue;
    }
    if (frame.kind === 'string' || frame.kind === 'block-string') {
      if (character === '\\') {i += 2; continue;}
      const delimiter = frame.kind === 'block-string' ? '"""' : frame.quote;
      if (i + delimiter.length <= position && source.startsWith(delimiter, i)) {frames.pop(); i += delimiter.length; last = 'literal'; expression = false;}
      else i++;
      continue;
    }
    if (frame.kind === 'template') {
      if (character === '\\') {i += 2; continue;}
      if (character === '`') {frames.pop(); last = 'literal'; expression = false; i++; continue;}
      if (character === '$' && next === '{') {
        frames.push({kind:'code', interpolation:true, braces:0}); last = '{'; lastAt = i + 1; expression = true; i += 2;
      } else i++;
      continue;
    }
    if (frame.kind === 'regexp') {
      if (character === '\\') {i += 2; continue;}
      if (character === '[') frame.characterClass = true;
      else if (character === ']') frame.characterClass = false;
      else if (character === '/' && !frame.characterClass) {
        frames.pop(); last = 'literal'; expression = false; i++;
        while (i < position && /[A-Za-z]/.test(source[i])) i++;
        continue;
      }
      i++; continue;
    }
    if (/\s/.test(character)) {i++; continue;}
    if ((javascript && character === '/' && next === '/') || (graphql && character === '#')) {
      frames.push({kind:'line-comment'}); i += character === '#' ? 1 : 2; continue;
    }
    if (javascript && character === '/' && next === '*') {frames.push({kind:'block-comment'}); i += 2; continue;}
    if (character === '"' || character === "'") {
      const block = graphql && i + 3 <= position && source.startsWith('"""', i);
      frames.push({kind:block ? 'block-string' : 'string', quote:character}); last = 'literal'; i += block ? 3 : 1; continue;
    }
    if (javascript && character === '`') {frames.push({kind:'template'}); last = 'literal'; i++; continue;}
    if (javascript && character === '/' && expression) {frames.push({kind:'regexp', characterClass:false}); last = 'literal'; i++; continue;}
    if (/[A-Za-z_$\u0080-\uffff]/.test(character)) {
      let to = i + 1;
      while (to < position && /[\w$\u0080-\uffff]/.test(source[to])) to++;
      const word = source.slice(i, to);
      expression = expressionWords.has(word); control = controlWords.has(word); last = word; lastAt = i; i = to; continue;
    }
    if (character === '(') {parentheses.push(control); expression = true;}
    else if (character === ')') expression = Boolean(parentheses.pop());
    else if (character === '{') {if (frame.interpolation) frame.braces++; expression = true;}
    else if (character === '}' && frame.interpolation && frame.braces === 0) {frames.pop(); last = 'literal'; expression = false; i++; continue;}
    else if (character === '}') {if (frame.interpolation) frame.braces--; expression = false;}
    else expression = /[\[,:;=!?+\-*%&|^~<>/]/.test(character);
    control = false; last = character; lastAt = i; i++;
  }
  return {kind:frames.at(-1).kind, last, lastAt};
}

/** Continue indentation and split adjacent opening/closing delimiters. */
export function newlineEdit(source, start, end, {indent='  ', language='text'}={}) {
  ({source, start, end} = range(source, start, end));
  indent = indentation(indent);
  const beginning = lineStart(source, start), finish = lineEnd(source, start);
  const before = source.slice(beginning, start), base = before.match(horizontal)[0];
  const eol = source[finish] === '\r' ? (source[finish + 1] === '\n' ? '\r\n' : '\r') : source[finish] === '\n' ? '\n' : (source.match(/\r\n|\r|\n/)?.[0] || '\n');
  const structured = ['javascript','json','graphql'].includes(language);
  const context = structured ? contextAt(source, start, language) : null;
  const opens = context && ['code','line-comment'].includes(context.kind) && context.lastAt >= beginning && closing[context.last];
  const inner = base + (opens ? indent : '');
  let text = eol + inner, to = end;
  if (opens && context.kind === 'code') {
    const following = source.slice(end).match(/^[\t ]*/)[0];
    if (source[end + following.length] === closing[context.last]) {
      text += eol + base;
      to += following.length;
    }
  }
  const caret = start + eol.length + inner.length;
  return {from:start, to, text, selectionStart:caret, selectionEnd:caret};
}
