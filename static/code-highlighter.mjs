/** Display-only lexical highlighting. Semantic completion stays in its Worker. */
const escape = text => text.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const jsKeywords = new Set(('as async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield').split(' '));
const expressionKeywords = new Set(('await case delete do else extends in instanceof new of return throw typeof void yield').split(' '));
const controlKeywords = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);
const blockKeywords = new Set(['do', 'else', 'try', 'finally']);
const graphqlKeywords = new Set(('query mutation subscription fragment on schema scalar type interface implements union enum input directive extend repeatable true false null').split(' '));
const identifier = /[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/uy;
const jsNumber = /(?:0[xX][\dA-Fa-f](?:_?[\dA-Fa-f])*n?|0[bB][01](?:_?[01])*n?|0[oO][0-7](?:_?[0-7])*n?|\d(?:_?\d)*n|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)/y;
const dataNumber = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const operators = /(?:===|!==|>>>=|>>>|>>=|<<=|\*\*=|&&=|\|\|=|\?\?=|=>|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\?\.|\*\*|<<|>>|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|[+\-*\/%=&|^!~<>?.;])/y;
const isSpace = character => character !== undefined && /\s/u.test(character);
const isLineEnd = character => character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029';
const matchAt = (pattern, source, position) => {
  pattern.lastIndex = position;
  return pattern.exec(source)?.[0] || '';
};

// Large plain strings use one span. Very dense documents keep all their text
// while bounding the number of DOM elements inserted into the textarea mirror.
const MAX_SPANS = 12000;
function renderer(source) {
  const html = [];
  let kind, from = 0, to = 0, spans = 0, remainder = -1;
  function flush() {
    if (to <= from) return;
    const value = escape(source.slice(from, to));
    html.push(kind ? `<span class="syntax-${kind}">${value}</span>` : value);
    if (kind) spans++;
    from = to;
  }
  return {
    get done() { return remainder >= 0; },
    add(next, start, end) {
      if (remainder >= 0 || start === end) return;
      if (kind === next && start === to) { to = end; return; }
      flush();
      if (spans >= MAX_SPANS) { remainder = start; return; }
      kind = next; from = start; to = end;
    },
    finish() {
      flush();
      if (remainder >= 0) html.push(escape(source.slice(remainder)));
      return html.join('');
    }
  };
}

function placeholderEnd(source, start) {
  if (source[start] !== '{' || source[start + 1] !== '{') return -1;
  let position = start + 2;
  while (position < source.length && source[position] !== '{' && source[position] !== '}') position++;
  return source[position] === '}' && source[position + 1] === '}' ? position + 2 : -1;
}

function nextNonSpace(source, start) {
  while (isSpace(source[start])) start++;
  return source[start];
}

function lineEnd(source, start) {
  while (start < source.length && !isLineEnd(source[start])) start++;
  return start;
}

function quotedEnd(source, start, quote, multiline = false) {
  let position = start + quote.length;
  while (position < source.length) {
    if (source[position] === '\\') { position = Math.min(position + 2, source.length); continue; }
    if (source.startsWith(quote, position)) return position + quote.length;
    if (!multiline && isLineEnd(source[position])) return position;
    position++;
  }
  return position;
}

// Strings and ordinary request text may contain MiniPost variables. Comments
// and regexp literals intentionally retain their own lexical meaning.
function addWithVariables(out, source, start, end, kind, escaped = false) {
  let position = start, plain = start;
  while (position < end && !out.done) {
    if (escaped && source[position] === '\\') { position += 2; continue; }
    const variableEnd = placeholderEnd(source, position);
    if (variableEnd >= 0 && variableEnd <= end) {
      out.add(kind, plain, position);
      out.add('variable', position, variableEnd);
      plain = position = variableEnd;
    } else position++;
  }
  out.add(kind, plain, end);
}

function regexpEnd(source, start) {
  let position = start + 1, inClass = false;
  while (position < source.length && !isLineEnd(source[position])) {
    const character = source[position++];
    if (character === '\\') { if (!isLineEnd(source[position])) position = Math.min(position + 1, source.length); continue; }
    if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (character === '/' && !inClass) {
      // Consume flags as a single token, including incomplete flags while editing.
      return position + matchAt(identifier, source, position).length;
    }
  }
  return position;
}

function codeFrame(substitution = false) {
  return {type: 'code', substitution, expression: true, statement: !substitution,
    property: false, last: '', control: false, asyncStatement: false, parens: [], braces: [], bodies: []};
}

function javascript(source, out) {
  const frames = [codeFrame()];
  let position = 0;
  while (position < source.length && !out.done) {
    const frame = frames[frames.length - 1];
    if (frame.type === 'template') {
      const start = position;
      if (frame.opening) { position++; frame.opening = false; }
      while (position < source.length) {
        if (source[position] === '\\') { position = Math.min(position + 2, source.length); continue; }
        if (source[position] === '`') {
          position++;
          addWithVariables(out, source, start, position, 'string', true);
          frames.pop();
          frames[frames.length - 1].expression = false;
          break;
        }
        if (source[position] === '$' && source[position + 1] === '{') {
          addWithVariables(out, source, start, position, 'string', true);
          out.add('punctuation', position, position + 2);
          position += 2; frames.push(codeFrame(true));
          break;
        }
        position++;
      }
      if (position === source.length && frames[frames.length - 1] === frame)
        addWithVariables(out, source, start, position, 'string', true);
      continue;
    }
    const start = position, character = source[position], next = source[position + 1];
    if (isSpace(character)) {
      while (isSpace(source[++position])) {}
      out.add(null, start, position); continue;
    }
    if ((character === '/' && next === '/') || (position === 0 && character === '#' && next === '!')) {
      position = lineEnd(source, position); out.add('comment', start, position); continue;
    }
    if (character === '/' && next === '*') {
      const close = source.indexOf('*/', position + 2);
      position = close < 0 ? source.length : close + 2;
      out.add('comment', start, position); continue;
    }
    if (character === '"' || character === "'") {
      position = quotedEnd(source, position, character);
      addWithVariables(out, source, start, position, 'string', true);
      frame.expression = false; frame.statement = false; frame.property = false; frame.last = 'value'; continue;
    }
    if (character === '`') {
      frame.statement = false; frame.property = false; frame.last = 'value';
      frames.push({type: 'template', opening: true}); continue;
    }
    const variableEnd = placeholderEnd(source, position);
    if (variableEnd >= 0) {
      position = variableEnd; out.add('variable', start, position);
      frame.expression = false; frame.statement = false; frame.last = 'value'; continue;
    }
    const privateName = character === '#' ? matchAt(identifier, source, position + 1) : '';
    if (privateName) {
      position += 1 + privateName.length;
      out.add('key', start, position);
      frame.expression = false; frame.statement = false; frame.property = false; frame.last = 'value'; continue;
    }
    const word = matchAt(identifier, source, position);
    if (word) {
      const keyword = !frame.property && jsKeywords.has(word);
      if (keyword && (word === 'function' || word === 'class')) {
        frame.bodies.push({kind: word, parens: frame.parens.length, braces: frame.braces.length,
          expression: !(frame.statement || (frame.last === 'async' && frame.asyncStatement) || frame.last === 'export' || frame.last === 'default')});
      }
      if (keyword && word === 'async') frame.asyncStatement = frame.statement;
      position += word.length; out.add(keyword ? 'keyword' : null, start, position);
      frame.expression = keyword && expressionKeywords.has(word);
      frame.control = keyword && controlKeywords.has(word);
      frame.statement = frame.statement && keyword && (word === 'export' || word === 'default');
      frame.property = false; frame.last = keyword ? word : 'value'; continue;
    }
    const sign = character === '-' && frame.expression ? 1 : 0;
    const number = matchAt(jsNumber, source, position + sign);
    if (number) {
      position += sign + number.length; out.add('number', start, position);
      frame.expression = false; frame.statement = false; frame.property = false; frame.last = 'value'; continue;
    }
    if (character === '/' && frame.expression && next !== '=') {
      position = regexpEnd(source, position); out.add('string', start, position);
      frame.expression = false; frame.statement = false; frame.last = 'value'; continue;
    }
    if (character === '{') {
      const pending = frame.bodies[frame.bodies.length - 1];
      const body = pending && pending.parens === frame.parens.length && pending.braces === frame.braces.length &&
        (pending.kind === 'class' || frame.last === ')') ? frame.bodies.pop() : null;
      const block = !!body || frame.statement || !frame.expression || frame.last === '=>' || blockKeywords.has(frame.last) || frame.last === 'control-close';
      frame.braces.push({block, expression: body ? body.expression : frame.last === '=>'});
      frame.expression = true; frame.statement = block; frame.last = '{';
    } else if (character === '}') {
      if (frame.substitution && !frame.braces.length) {
        out.add('punctuation', position, ++position); frames.pop(); continue;
      }
      const closed = frame.braces.pop() || {block: true, expression: false};
      frame.expression = closed.block && !closed.expression; frame.statement = frame.expression; frame.last = '}';
    } else if (character === '(') {
      frame.parens.push(frame.control); frame.expression = true; frame.statement = false; frame.control = false; frame.last = '(';
    } else if (character === ')') {
      const control = frame.parens.pop() || false;
      frame.expression = control; frame.statement = control; frame.last = control ? 'control-close' : ')';
    } else if ('[]:,'.includes(character)) {
      frame.expression = character !== ']'; frame.statement = false; frame.last = character;
    } else {
      const operator = matchAt(operators, source, position);
      if (operator) {
        position += operator.length; out.add('punctuation', start, position);
        frame.property = operator === '.' || operator === '?.';
        if (operator !== '++' && operator !== '--') frame.expression = !frame.property;
        frame.statement = operator === ';'; frame.last = operator; frame.control = false; continue;
      }
      position++; out.add(null, start, position);
      frame.property = false; frame.control = false; frame.last = character; continue;
    }
    position++; out.add('punctuation', start, position); frame.property = false; frame.control = false;
  }
}

function dataLanguage(source, out, graphql) {
  let position = 0;
  while (position < source.length && !out.done) {
    const start = position, character = source[position];
    const variableEnd = placeholderEnd(source, position);
    if (variableEnd >= 0) { position = variableEnd; out.add('variable', start, position); continue; }
    if (graphql && character === '#') {
      position = lineEnd(source, position); out.add('comment', start, position); continue;
    }
    if (character === '"') {
      const quote = graphql && source.startsWith('"""', position) ? '"""' : '"';
      position = quotedEnd(source, position, quote, quote.length === 3);
      addWithVariables(out, source, start, position, !graphql && nextNonSpace(source, position) === ':' ? 'key' : 'string', true);
      continue;
    }
    if (graphql && character === '$') {
      const word = matchAt(identifier, source, position + 1);
      if (word) { position += word.length + 1; out.add('variable', start, position); continue; }
    }
    const word = matchAt(identifier, source, position);
    if (word) {
      position += word.length;
      const keyword = graphql ? graphqlKeywords.has(word) : ['true', 'false', 'null'].includes(word);
      out.add(keyword ? 'keyword' : null, start, position); continue;
    }
    const number = matchAt(dataNumber, source, position);
    if (number) { position += number.length; out.add('number', start, position); continue; }
    position++;
    out.add('{}[]:,()!@=|&'.includes(character) ? 'punctuation' : null, start, position);
  }
}

function markup(source, out) {
  let position = 0;
  while (position < source.length && !out.done) {
    const start = position;
    if (source.startsWith('<!--', position)) {
      const close = source.indexOf('-->', position + 4);
      position = close < 0 ? source.length : close + 3;
      out.add('comment', start, position); continue;
    }
    if (source.startsWith('<![CDATA[', position)) {
      const close = source.indexOf(']]>', position + 9);
      position = close < 0 ? source.length : close + 3;
      out.add('string', start, position); continue;
    }
    if (source[position] === '<' && /[\w:!?/]/.test(source[position + 1] || '')) {
      let section = position++, subset = 0;
      while (position < source.length && !out.done) {
        const character = source[position];
        if (character === '"' || character === "'") {
          out.add('tag', section, position);
          // XML/HTML attribute quotes are not escaped with JavaScript backslashes.
          const close = source.indexOf(character, position + 1);
          const end = close < 0 ? source.length : close + 1;
          addWithVariables(out, source, position, end, 'string');
          section = position = end; continue;
        }
        if (character === '[') subset++;
        else if (character === ']') subset = Math.max(0, subset - 1);
        position++;
        if (character === '>' && !subset) break;
      }
      addWithVariables(out, source, section, position, 'tag'); continue;
    }
    // Text chunks stop only at the next possible tag; variables are scanned once.
    position++;
    while (position < source.length && source[position] !== '<') position++;
    addWithVariables(out, source, start, position, null);
  }
}

export function highlight(source, language = 'text') {
  source = String(source);
  const out = renderer(source);
  if (language === 'javascript') javascript(source, out);
  else if (language === 'json' || language === 'graphql') dataLanguage(source, out, language === 'graphql');
  else if (language === 'xml' || language === 'html') markup(source, out);
  else addWithVariables(out, source, 0, source.length, null);
  return out.finish();
}
