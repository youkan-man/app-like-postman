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

function validTabSize(value) {
  return Number.isInteger(value) && value > 0 && value <= 32 ? value : 2;
}

function lineEnding(source, position) {
  return source[position] === '\r' ? (source[position + 1] === '\n' ? '\r\n' : '\r') : source[position] === '\n' ? '\n' : '';
}

function selectedLines(source, start, end) {
  const from = lineStart(source, start);
  let last = lineStart(source, end);
  if (end > start && last === end) last = lineStart(source, end - (source[end - 2] === '\r' && source[end - 1] === '\n' ? 2 : 1));
  return {from, last, to:lineEnd(source, last)};
}

/** Backspace in indentation removes one visual tab stop, never code. */
export function smartBackspaceEdit(source, start, end, {tabSize=2}={}) {
  ({source, start, end} = range(source, start, end));
  if (start !== end || start === 0) return null;
  const beginning = lineStart(source, start), prefix = source.slice(beginning, start);
  if (!prefix || /[^\t ]/.test(prefix)) return null;
  tabSize = validTabSize(tabSize);
  const target = Math.floor((width(prefix, tabSize) - 1) / tabSize) * tabSize;
  let index = 0, column = 0;
  while (column < target) {
    column += prefix[index] === '\t' ? tabSize - column % tabSize : 1;
    index++;
  }
  const from = beginning + index;
  return {from, to:start, text:'', selectionStart:from, selectionEnd:from};
}

/** Home moves between the first nonblank character and column zero. */
export function smartHomeSelection(source, start, end, {extend=false, direction='none'}={}) {
  ({source, start, end} = range(source, start, end));
  const backward = direction === 'backward';
  const focus = backward ? start : end, anchor = backward ? end : start;
  const beginning = lineStart(source, focus), finish = lineEnd(source, focus);
  const prefix = source.slice(beginning, finish).match(horizontal)[0];
  const content = beginning + prefix.length < finish ? beginning + prefix.length : beginning;
  const target = focus === content ? beginning : content;
  if (!extend) return {selectionStart:target, selectionEnd:target, selectionDirection:'none'};
  return {selectionStart:Math.min(anchor, target), selectionEnd:Math.max(anchor, target),
    selectionDirection:target < anchor ? 'backward' : target > anchor ? 'forward' : 'none'};
}

function indentColumns(prefix, tabSize, minimum, maximum) {
  const columns = new Map(minimum === 0 ? [[0, 0]] : []);
  let column = 0;
  for (let index = 0; index < prefix.length; index++) {
    column += prefix[index] === '\t' ? tabSize - column % tabSize : 1;
    if (column > maximum) break;
    if (column >= minimum) columns.set(column, index + 1);
  }
  return columns;
}

/** Toggle line comments without introducing invalid comments into JSON/text. */
export function toggleLineCommentEdit(source, start, end, {language='text', tabSize=2}={}) {
  const marker = language === 'javascript' ? '//' : language === 'graphql' ? '#' : null;
  if (!marker) return null;
  ({source, start, end} = range(source, start, end));
  tabSize = validTabSize(tabSize);
  const block = selectedLines(source, start, end), lines = [];
  for (let position = block.from; position <= block.last;) {
    const finish = lineEnd(source, position), text = source.slice(position, finish);
    const prefix = text.match(horizontal)[0];
    lines.push({position, finish, prefix, content:text.slice(prefix.length)});
    if (finish === source.length) break;
    position = finish + lineEnding(source, finish).length;
  }
  // Keep spacing-only separators inside a selected code block unchanged.
  const nonblank = lines.filter(line => line.content.length);
  const targets = nonblank.length ? nonblank : lines;
  const remove = nonblank.length > 0 && nonblank.every(line => line.content.startsWith(marker));
  const changes = [];
  if (remove) {
    for (const line of targets) {
      const from = line.position + line.prefix.length;
      const to = from + marker.length + (source[from + marker.length] === ' ' ? 1 : 0);
      changes.push({from, to, text:''});
    }
  } else {
    // Align at a shared indentation column. Never split/convert an existing tab
    // merely to put a comment inside its visual width; toggling is lossless.
    const minimum = targets.reduce((result, line) => Math.min(result, width(line.prefix, tabSize)), Infinity);
    // Every tab-stop boundary is reachable in every prefix. Only the final
    // partial stop can differ, so retain at most tabSize + 1 columns per line.
    const base = Math.floor(minimum / tabSize) * tabSize;
    const columns = targets.map(line => indentColumns(line.prefix, tabSize, base, minimum));
    let shared = new Set(columns[0].keys());
    for (const positions of columns.slice(1)) shared = new Set([...shared].filter(column => positions.has(column)));
    let column = base;
    for (const value of shared) column = Math.max(column, value);
    for (let index = 0; index < targets.length; index++) {
      const from = targets[index].position + columns[index].get(column);
      changes.push({from, to:from, text:marker + ' '});
    }
  }
  return applyChanges(source, start, end, changes);
}

/** Move or duplicate whole touched lines while keeping the selection in them. */
export function moveLinesEdit(source, start, end, {direction='down', duplicate=false}={}) {
  ({source, start, end} = range(source, start, end));
  if (direction !== 'up' && direction !== 'down') return null;
  const block = selectedLines(source, start, end);
  const content = source.slice(block.from, block.to), following = lineEnding(source, block.to);
  const previousEnd = block.from - (source[block.from - 2] === '\r' && source[block.from - 1] === '\n' ? 2 : 1);
  const previousStart = block.from ? lineStart(source, previousEnd) : 0;
  const preceding = block.from ? source.slice(previousEnd, block.from) : '';
  let from, to, text, movedStart, movedEnding;
  if (duplicate) {
    const separator = following || preceding || source.match(/\r\n|\r|\n/)?.[0] || '\n';
    if (direction === 'up') {
      from = to = block.from; text = content + separator;
      movedStart = block.from; movedEnding = separator;
    } else {
      from = to = block.to; text = separator + content;
      movedStart = block.to + separator.length; movedEnding = following;
    }
  } else {
    // A terminal newline is retained; its empty position is not swapped with a
    // content line. An explicitly present blank line before it remains movable.
    if (block.from === source.length && block.from > 0) return null;
    if (direction === 'up') {
      if (!block.from) return null;
      from = previousStart; to = block.to;
      text = content + preceding + source.slice(previousStart, previousEnd);
      movedStart = previousStart; movedEnding = preceding;
    } else {
      const nextStart = block.to + following.length;
      if (!following || nextStart >= source.length) return null;
      const nextEnd = lineEnd(source, nextStart), next = source.slice(nextStart, nextEnd);
      from = block.from; to = nextEnd;
      text = next + following + content;
      movedStart = block.from + next.length + following.length;
      movedEnding = lineEnding(source, nextEnd);
    }
  }
  function translate(position) {
    // A selection through the next column-zero stays through the moved line's
    // newline, even when the adjacent line uses a different line-ending width.
    if (position > block.to) return movedStart + content.length + movedEnding.length;
    return movedStart + Math.max(0, Math.min(content.length, position - block.from));
  }
  return {from, to, text, selectionStart:translate(start), selectionEnd:translate(end)};
}
