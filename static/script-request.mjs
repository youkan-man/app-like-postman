/** Named request editing shared by the current request and saved request handles.
 * Keep dependencies inside this function: the isolated Worker serializes it.
 */
export function createRequestEditor({read, change, checkActive = () => {}}) {
  const own = (value, key) => Object.hasOwn(value, key);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const define = (target, key, value) => Object.defineProperty(target, key, {value, enumerable:true, configurable:true, writable:true});
  const enabled = row => record(row) && row.disabled !== true && row.enabled !== false;
  const text = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const equal = (left, right) => left === right || !!left && !!right && typeof left === 'object' && typeof right === 'object' &&
    Array.isArray(left) === Array.isArray(right) && Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every(key => own(right, key) && equal(left[key], right[key]));
  function clone(value, symbols = false, seen = new Map()) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    const result = Array.isArray(value) ? [] : {};
    seen.set(value, result);
    for (const key of Object.keys(value)) define(result, key, clone(value[key], symbols, seen));
    if (symbols) for (const key of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, key)) define(result, key, value[key]);
    }
    return result;
  }
  // Handles for the same saved request share the most recent successful URL
  // baseline. Keep it outside request data so it cannot enter exports or writes.
  if (!Object.hasOwn(createRequestEditor, 'urlBaselines')) Object.defineProperty(createRequestEditor, 'urlBaselines', {value:new WeakMap()});
  const urlBaselines = createRequestEditor.urlBaselines;
  let lastTarget;
  function observe(target) {
    if (!urlBaselines.has(target)) {
      const previous = lastTarget && urlBaselines.get(lastTarget);
      urlBaselines.set(target, {url:clone(previous ? previous.url : target.url)});
    }
    lastTarget = target;
    const state = urlBaselines.get(target);
    if (!equal(state.url, target.url)) {
      // Another handle or a model setter may already have reconciled the URL.
      // Recognize that completed edit without absorbing stale raw/base caches.
      try {
        if (effectiveURL(target.url) === effectiveURL(normalizeURL(state.url, target.url))) state.url = clone(target.url);
      } catch {}
    }
    return state;
  }
  function jsonValue(value, seen = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
      throw new TypeError('JSONで表せる値を指定してください。');
    if (seen.has(value)) throw new TypeError('循環参照は保存できません。');
    seen.add(value);
    const result = Array.isArray(value) ? [] : {};
    if (Array.isArray(value) && (Object.keys(value).length !== value.length || Array.from({length:value.length}, (_, index) => own(value, index)).includes(false)))
      throw new TypeError('配列に空の要素は作成できません。');
    for (const key of Object.keys(value)) define(result, key, jsonValue(value[key], seen));
    seen.delete(value);
    return result;
  }
  function pathParts(path) {
    if (Array.isArray(path)) return path.map(part => {if (typeof part !== 'string' && (!Number.isInteger(part) || part < 0)) throw new TypeError('パスの要素が不正です。'); return String(part);});
    if (typeof path !== 'string') throw new TypeError('パスは文字列または配列で指定してください。');
    if (path === '' || path === '$') return [];
    if (path.startsWith('/')) return path.slice(1).split('/').map(part => {if (/~(?:[^01]|$)/.test(part)) throw new TypeError('JSON Pointerのエスケープが不正です。'); return part.replace(/~1/g, '/').replace(/~0/g, '~');});
    if (path.startsWith('$.')) path = path.slice(2); else if (path.startsWith('$[')) path = path.slice(1);
    const result = []; let index = 0, expectSegment = true;
    while (index < path.length) {
      if (path[index] === '[') {
        index++; let part;
        if (path[index] === '"') {
          const begin = index++; let escaped = false;
          while (index < path.length) {const char = path[index++]; if (char === '"' && !escaped) break; escaped = char === '\\' && !escaped;}
          try {part = JSON.parse(path.slice(begin, index));} catch {throw new TypeError('パスの引用符が不正です。');}
          if (path[index++] !== ']') throw new TypeError('パスの括弧が不正です。');
        } else {
          const end = path.indexOf(']', index); if (end < 0) throw new TypeError('パスの括弧が不正です。');
          part = path.slice(index, end); if (!/^(?:0|[1-9]\d*|\*)$/.test(part)) throw new TypeError('配列の添字が不正です。'); index = end + 1;
        }
        result.push(part); expectSegment = false;
      } else if (path[index] === '.') {
        if (expectSegment) throw new TypeError('パスに空の要素があります。'); index++; expectSegment = true;
      } else {
        if (!expectSegment) throw new TypeError('パスの区切りが不正です。');
        const begin = index; while (index < path.length && !'.['.includes(path[index])) index++;
        const part = path.slice(begin, index); if (!part || part.includes(']')) throw new TypeError('パスが不正です。');
        result.push(part); expectSegment = false;
      }
    }
    if (expectSegment) throw new TypeError('パスの末尾が不正です。');
    return result;
  }
  function lookup(value, parts) {
    for (const part of parts) {if (value === null || typeof value !== 'object' || !own(value, part)) return {found:false}; value = value[part];}
    return {found:true, value};
  }
  function replacePath(value, parts, next, remove = false) {
    if (!parts.length) return remove ? null : next;
    let cursor = value;
    for (let index = 0; index < parts.length; index++) {
      const key = parts[index], last = index === parts.length - 1;
      if (cursor === null || typeof cursor !== 'object') throw new TypeError('パスの途中にオブジェクトまたは配列が必要です。');
      if (Array.isArray(cursor) && !(/^(?:0|[1-9]\d*)$/.test(key) || last && key === '-' && !remove)) throw new TypeError('配列には非負の添字を指定してください。');
      const at = Array.isArray(cursor) ? key === '-' ? cursor.length : Number(key) : key;
      if (Array.isArray(cursor) && at > cursor.length) throw new RangeError('配列に空の要素は作成できません。');
      if (last) {
        if (remove) {if (own(cursor, at)) {if (Array.isArray(cursor)) cursor.splice(at, 1); else delete cursor[at];}}
        else define(cursor, at, next);
      } else {
        if (!own(cursor, at)) {if (remove) return value; define(cursor, at, /^(?:0|[1-9]\d*|-)$/.test(parts[index + 1]) ? [] : {});}
        cursor = cursor[at];
      }
    }
    return value;
  }
  function request() {checkActive(); const value = read(); if (!record(value)) throw new Error('操作するリクエストがありません。'); observe(value); return value;}
  function pairRows(value) {
    if (typeof value === 'string') return value.split(/\r?\n/).filter(Boolean).map(line => {const at = line.indexOf(':'); return {key:at < 0 ? line : line.slice(0, at), value:at < 0 ? '' : line.slice(at + 1).trim()};});
    if (record(value)) return Object.entries(value).map(([key, value]) => ({key, value:text(value)}));
    return Array.isArray(value) ? value.filter(record).map(row => ({...row, key:text(row.key), value:text(row.value)})) : [];
  }
  function splitURL(raw = '') {
    const hashAt = raw.indexOf('#'), hash = hashAt < 0 ? '' : raw.slice(hashAt), rest = hashAt < 0 ? raw : raw.slice(0, hashAt), at = rest.indexOf('?');
    const decode = value => {try {return decodeURIComponent(value);} catch {return value;}};
    const query = at < 0 ? [] : rest.slice(at + 1).split('&').filter(Boolean).map(part => {const equals = part.indexOf('='); return {key:decode(equals < 0 ? part : part.slice(0, equals)), value:decode(equals < 0 ? '' : part.slice(equals + 1)), disabled:false};});
    return {base:at < 0 ? rest : rest.slice(0, at), hash, query};
  }
  function urlParts(value) {
    if (!record(value)) {const raw = text(value); return {raw, ...splitURL(raw), variable:[]};}
    let raw = value.raw;
    if (raw == null) {
      const host = Array.isArray(value.host) ? value.host.join('.') : text(value.host), path = Array.isArray(value.path) ? value.path.join('/') : text(value.path);
      raw = (value.protocol ? `${value.protocol}://` : '') + host + (value.port ? `:${value.port}` : '') + (path ? '/' + path.replace(/^\//, '') : '') + (value.hash ? `#${String(value.hash).replace(/^#/, '')}` : '');
    }
    const parts = value._mpTextParts ? {base:value.base, hash:value.hash || '', query:[]} : splitURL(text(raw));
    return {...value, ...parts, raw:text(raw), query:Array.isArray(value.query) ? pairRows(value.query) : parts.query, variable:pairRows(value.variable)};
  }
  const encode = value => text(value).split(/(\{\{[\s\S]*?\}\})/).map(part => part.startsWith('{{') && part.endsWith('}}') ? part : encodeURIComponent(part)).join('');
  function effectiveURL(value) {
    const parts = urlParts(value), query = parts.query.filter(enabled).filter(row => row.key).map(row => `${encode(row.key)}=${encode(row.value)}`).join('&');
    return text(parts.base) + (query ? '?' + query : '') + parts.hash;
  }
  function normalizeURL(previous, input) {
    if (typeof input === 'string') return {...urlParts(previous), ...splitURL(input), raw:input, _mpTextParts:true, _mpTypedUrl:true};
    if (!record(input)) throw new TypeError('URLは文字列またはURLオブジェクトで指定してください。');
    const old = record(previous) ? previous : {}, oldParts = urlParts(previous), url = clone(input);
    for (const key of ['raw', 'base', 'protocol', 'port', 'hash']) if (own(url, key) && typeof url[key] !== 'string') throw new TypeError(`URLの${key}は文字列で指定してください。`);
    for (const key of ['host', 'path']) if (own(url, key) && typeof url[key] !== 'string' && (!Array.isArray(url[key]) || url[key].some(value => typeof value !== 'string'))) throw new TypeError(`URLの${key}が不正です。`);
    for (const key of ['query', 'variable']) if (own(url, key) && (!Array.isArray(url[key]) || url[key].some(row => !record(row) || typeof row.key !== 'string' || typeof row.value !== 'string'))) throw new TypeError(`URLの${key}は名前と値の配列で指定してください。`);
    const rawChanged = own(url, 'raw') && url.raw !== (record(previous) ? old.raw : previous);
    const components = ['protocol', 'host', 'port', 'path'].filter(key => !equal(url[key], old[key]));
    const parts = rawChanged ? splitURL(url.raw) : !own(url, 'raw') ? urlParts(url) : urlParts(previous);
    let base = !rawChanged && url.base !== old.base && typeof url.base === 'string' ? url.base : parts.base;
    if (components.length && own(url, 'raw')) {
      const match = String(base || '').match(/^(?:([A-Za-z][A-Za-z\d+.-]*):\/\/)?([^/?#]*)([\s\S]*)$/);
      let protocol = match?.[1] || '', authority = match?.[2] || '', path = match?.[3] || '';
      const at = authority.lastIndexOf('@'), user = at >= 0 ? authority.slice(0, at + 1) : '';
      let host = authority.slice(at + 1), port = '';
      const address = host.match(/^(\[[^\]]*\]|[^:]*)(?::(.*))?$/); if (address) {host = address[1]; port = address[2] || '';}
      if (components.includes('protocol')) protocol = url.protocol || '';
      if (components.includes('host')) host = Array.isArray(url.host) ? url.host.join('.') : url.host || '';
      if (components.includes('port')) port = url.port || '';
      if (components.includes('path')) {const value = Array.isArray(url.path) ? url.path.join('/') : url.path || ''; path = value ? '/' + value.replace(/^\//, '') : '';}
      base = (protocol ? protocol + '://' : '') + user + host + (port ? ':' + port : '') + path;
    }
    const query = own(url, 'query') && !equal(url.query, oldParts.query) ? url.query : parts.query;
    let hash = parts.hash || '';
    if (url.hash !== oldParts.hash && typeof url.hash === 'string') hash = url.hash ? url.hash.startsWith('#') ? url.hash : '#' + url.hash : '';
    const result = {...url, base, hash, query, variable:url.variable ?? old.variable ?? [], _mpTextParts:true, _mpTypedUrl:true};
    result.raw = effectiveURL(result); return result;
  }
  function currentURL(value) {
    const before = lastTarget && urlBaselines.get(lastTarget)?.url;
    return equal(before, value) ? value : normalizeURL(before, value);
  }
  function validate(value) {
    if (!record(value)) throw new TypeError('リクエストはオブジェクトで指定してください。');
    if (own(value, 'method') && (typeof value.method !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value.method))) throw new TypeError('リクエストのメソッドが不正です。');
    if (own(value, 'url') && typeof value.url !== 'string' && !record(value.url)) throw new TypeError('URLは文字列またはURLオブジェクトで指定してください。');
    if (own(value, 'header') && (!Array.isArray(value.header) || value.header.some(row => !record(row) || typeof row.key !== 'string' || typeof row.value !== 'string'))) throw new TypeError('ヘッダーは名前と値の配列で指定してください。');
    if (own(value, 'body') && (!record(value.body) || own(value.body, 'mode') && !['none', 'raw', 'urlencoded', 'formdata', 'file', 'graphql'].includes(value.body.mode))) throw new TypeError('リクエスト本文の形式が不正です。');
    if (value.body?.mode === 'raw' && own(value.body, 'raw') && typeof value.body.raw !== 'string') throw new TypeError('raw本文は文字列で指定してください。');
  }
  function commit(target, next) {
    validate(next);
    // Validate descriptors before touching the live object, including user-frozen
    // requests and names occupied by the non-enumerable editing facade.
    for (const key of new Set([...Object.keys(target), ...Object.keys(next)])) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor && !descriptor.configurable && (!descriptor.enumerable || !descriptor.writable || !own(next, key))) throw new TypeError(`変更できないフィールドです: ${key}`);
      if (!descriptor && !Object.isExtensible(target)) throw new TypeError('リクエストにフィールドを追加できません。');
    }
    for (const key of Object.keys(target)) if (!own(next, key)) delete target[key];
    for (const key of Object.keys(next)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor && !descriptor.configurable) target[key] = next[key]; else define(target, key, next[key]);
    }
  }
  function mutate(callback) {
    checkActive();
    const result = change(target => {
      if (!record(target)) throw new Error('操作するリクエストがありません。');
      observe(target);
      const next = clone(target, true);
      if (own(next, 'url')) next.url = clone(currentURL(next.url));
      const changed = callback(next, target);
      commit(target, next); return clone(changed, true);
    });
    // A saved-request adapter can still reject and roll back after the callback.
    // Refresh this baseline only after the complete transaction has succeeded.
    const target = request(); observe(target).url = clone(target.url);
    return result;
  }
  // File-row Symbols travel through in-worker snapshots, just as they do through
  // direct object spread. The host's structured-clone boundary removes them.
  const fieldValue = (value, parts) => parts.length === 1 && parts[0] === 'url' ? effectiveURL(currentURL(value.url)) : lookup(clone(value, true), parts).value;
  function scalar(value) {
    if (value === null) return '';
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return String(value);
    throw new TypeError('文字列・有限の数値・真偽値・nullを指定してください。');
  }
  function nameValue(name, kind) {
    if (typeof name !== 'string' || !name) throw new TypeError('項目名を指定してください。');
    if (kind === 'headers' && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new TypeError('ヘッダー名が不正です。');
    return name;
  }
  const matches = (row, name, kind) => enabled(row) && (kind !== 'form' || row.type !== 'file') &&
    (kind === 'headers' ? text(row.key).toLowerCase() === name.toLowerCase() : row.key === name);
  function namedRows(value, kind) {
    if (kind === 'headers') return pairRows(value.header);
    if (kind === 'query') return urlParts(currentURL(value.url)).query;
    const body = value.body; return body?.mode === 'formdata' ? body.formdata || [] : body?.mode === 'urlencoded' ? pairRows(body.urlencoded) : [];
  }
  function replaceRows(rows, name, values, kind, multipart = false) {
    const next = []; let index = 0, insertAt = -1;
    for (const row of rows) {
      if (matches(row, name, kind)) {
        if (index < values.length) next.push({...row, value:values[index++]});
        insertAt = next.length;
      } else next.push(row);
    }
    const extra = values.slice(index).map(value => ({key:name, value, disabled:false, ...(multipart ? {type:'text'} : {})}));
    if (extra.length) next.splice(insertAt < 0 ? next.length : insertAt, 0, ...extra);
    return next;
  }
  function writeRows(value, kind, rows) {
    if (kind === 'headers') value.header = rows;
    else if (kind === 'query') {
      value.url = {...urlParts(value.url), query:rows, _mpTextParts:true, _mpTypedUrl:true}; value.url.raw = effectiveURL(value.url);
    } else {
      const body = record(value.body) ? value.body : {};
      if (body.mode === 'formdata') value.body = {...body, disabled:false, formdata:rows};
      else {
        value.body = {...body, mode:'urlencoded', disabled:false, urlencoded:rows};
        value.header = replaceRows(pairRows(value.header), 'Content-Type', ['application/x-www-form-urlencoded'], 'headers');
      }
    }
  }
  function named(kind) {return {
    get(name) {return this.getAll(name)[0];},
    getAll(name) {nameValue(name, kind); return namedRows(request(), kind).filter(row => matches(row, name, kind)).map(row => text(row.value));},
    set(name, value) {
      nameValue(name, kind); const values = (Array.isArray(value) ? value : [value]).map(scalar);
      if (kind === 'headers' && values.some(value => /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value))) throw new TypeError('ヘッダー値が不正です。');
      return mutate(next => {
        const rows = namedRows(next, kind), existing = rows.some(row => matches(row, name, kind));
        if (values.length || existing) writeRows(next, kind, replaceRows(rows, name, values, kind, next.body?.mode === 'formdata'));
        return namedRows(next, kind).find(row => matches(row, name, kind))?.value;
      });
    },
    has(name) {return this.getAll(name).length > 0;},
    delete(name) {
      nameValue(name, kind);
      return mutate(next => {const rows = namedRows(next, kind), remaining = rows.filter(row => !matches(row, name, kind)); if (remaining.length === rows.length) return false; writeRows(next, kind, remaining); return true;});
    },
    toObject() {
      const result = {};
      for (const row of namedRows(request(), kind)) if (enabled(row) && row.key && (kind !== 'form' || row.type !== 'file')) {
        const key = kind === 'headers' ? String(row.key).toLowerCase() : row.key, value = text(row.value);
        define(result, key, own(result, key) ? Array.isArray(result[key]) ? [...result[key], value] : [result[key], value] : value);
      }
      return result;
    }
  };}
  function readJSON(value) {
    if (value.body?.mode !== 'raw' || !text(value.body.raw).trim()) return undefined;
    try {return JSON.parse(value.body.raw);} catch {throw new TypeError('リクエスト本文はJSONではありません。');}
  }
  function writeJSON(value, body) {
    const before = record(value.body) ? value.body : {};
    value.body = {...before, mode:'raw', raw:JSON.stringify(body, null, 2), disabled:false,
      options:{...before.options, raw:{...before.options?.raw, language:'json'}}};
    value.header = replaceRows(pairRows(value.header), 'Content-Type', ['application/json'], 'headers');
  }
  request();
  return {
    get(path = '') {const parts = pathParts(path); return fieldValue(request(), parts);},
    set(path, value) {
      const root = arguments.length === 1, parts = root ? [] : pathParts(path), input = root ? path : value;
      jsonValue(input);
      const supplied = clone(input, true);
      return mutate((next, previous) => {
        if (!parts.length) {
          if (!record(supplied)) throw new TypeError('リクエストはオブジェクトで指定してください。');
          if (own(supplied, 'url') && (!equal(supplied.url, previous.url) || !equal(previous.url, urlBaselines.get(lastTarget)?.url))) supplied.url = normalizeURL(urlBaselines.get(lastTarget)?.url, supplied.url);
          for (const key of Object.keys(next)) delete next[key]; for (const key of Object.keys(supplied)) define(next, key, supplied[key]);
        } else {
          if (parts[0] === 'url') {
            const before = clone(next.url);
            if (parts.length === 1) next.url = normalizeURL(before, supplied);
            else {next.url = replacePath(urlParts(next.url), parts.slice(1), supplied); next.url = normalizeURL(before, next.url);}
          } else replacePath(next, parts, supplied);
        }
        return fieldValue(next, parts);
      });
    },
    headers:named('headers'), query:named('query'), form:named('form'),
    json:{
      get(path = '') {const parts = pathParts(path); return clone(lookup(readJSON(request()), parts).value);},
      set(path, value) {
        const root = arguments.length === 1, parts = root ? [] : pathParts(path), supplied = jsonValue(root ? path : value);
        return mutate(next => {
          let body = parts.length ? readJSON(next) : undefined;
          if (body === undefined && parts.length) body = /^(?:0|[1-9]\d*|-)$/.test(parts[0]) ? [] : {};
          body = replacePath(body, parts, supplied); writeJSON(next, body); return clone(supplied);
        });
      },
      delete(path) {
        const parts = pathParts(path);
        return mutate(next => {const body = readJSON(next); if (body === undefined || !lookup(body, parts).found) return false; writeJSON(next, replacePath(body, parts, null, true)); return true;});
      }
    }
  };
}
