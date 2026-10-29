/** Postman import and request compilation. No browser or third-party dependencies. */
export const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
export const clone = value => JSON.parse(JSON.stringify(value));
export const uid = () => globalThis.crypto?.randomUUID?.() || `mp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const text = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
export const enabled = row => row && row.disabled !== true && row.enabled !== false;
export function rows(value) {
  if (typeof value === 'string') return value.split(/\r?\n/).filter(Boolean).map(line => {
    const at = line.indexOf(':');
    return {key: at < 0 ? line : line.slice(0, at), value: at < 0 ? '' : line.slice(at + 1).trim(), disabled: false};
  });
  // Collection v2.0 auth helpers use attribute objects; v2.1 uses key/value arrays.
  // Keep the same editor/compiler representation without mutating the imported object.
  if (value && typeof value === 'object' && !Array.isArray(value)) value = Object.entries(value).map(([key, value]) => ({key, value}));
  return (Array.isArray(value) ? value : []).filter(row => row && typeof row === 'object').map(row => ({...row, key: text(row.key), value: text(row.value), disabled: !enabled(row)}));
}
export function splitUrl(raw = '') {
  const hashAt = raw.indexOf('#');
  const hash = hashAt < 0 ? '' : raw.slice(hashAt);
  const rest = hashAt < 0 ? raw : raw.slice(0, hashAt);
  const at = rest.indexOf('?');
  const decode = value => {try {return decodeURIComponent(value);} catch {return value;}};
  const query = at < 0 ? [] : rest.slice(at + 1).split('&').filter(Boolean).map(part => {
    const equals = part.indexOf('=');
    return {key: decode(equals < 0 ? part : part.slice(0, equals)), value: decode(equals < 0 ? '' : part.slice(equals + 1)), disabled: false};
  });
  return {base: at < 0 ? rest : rest.slice(0, at), hash, query};
}
export function urlParts(value) {
  if (typeof value === 'string' || !value) {
    const raw = text(value);
    return {raw, ...splitUrl(raw), variable: []};
  }
  let raw = value.raw;
  if (raw == null) {
    const host = Array.isArray(value.host) ? value.host.join('.') : text(value.host);
    const path = Array.isArray(value.path) ? value.path.join('/') : text(value.path);
    raw = (value.protocol ? `${value.protocol}://` : '') + host + (value.port ? `:${value.port}` : '') + (path ? '/' + path.replace(/^\//, '') : '') + (value.hash ? `#${value.hash}` : '');
  }
  const parts = value._mpTextParts ? {base: value.base, hash: value.hash || '', query: []} : splitUrl(text(raw));
  return {...value, ...parts, raw: text(raw), query: Array.isArray(value.query) ? rows(value.query) : parts.query, variable: rows(value.variable)};
}
export function displayUrl(value) {
  const u = urlParts(value);
  if (u._mpTypedUrl) return u.raw;
  const query = u.query.filter(enabled).filter(row => row.key).map(row => `${text(row.key)}=${text(row.value)}`).join('&');
  // Only legacy imported path escapes are decoded for readable display. URI
  // reserved escapes (%2F, %3F, %23, ...) retain their structural meaning.
  let base = u.base;
  try {base = decodeURI(base);} catch {}
  return base + (query ? `?${query}` : '') + u.hash;
}
export function setUrlText(request, value) {
  const previous = urlParts(request.url);
  request.url = {...previous, ...splitUrl(value), raw: value, _mpTextParts: true, _mpTypedUrl: true};
}
export function setQuery(request, query) {
  request.url = {...urlParts(request.url), query, _mpTextParts: true, _mpTypedUrl: false};
  request.url.raw = displayUrl(request.url);
}
export function newRequest() {
  return {method: 'GET', header: [], url: {raw: '', query: [], variable: []}, body: {mode: 'none', raw: ''}, auth: null};
}
export function normalizeRequest(value) {
  const r = typeof value === 'string' ? {...newRequest(), url: value} : clone(value || newRequest());
  r.method = text(r.method || 'GET').toUpperCase();
  r.header = rows(r.header);
  const u = urlParts(r.url);
  r.url = {...u, raw: displayUrl(u), _mpTextParts: true};
  return r;
}
function attachIds(items) {
  return items.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Collectionのitemはオブジェクトで指定してください。');
    const result = {...clone(item), _mpId: uid(), name: text(item.name || (item.item ? 'Folder' : 'Request'))};
    if (Array.isArray(item.item)) result.item = attachIds(item.item);
    else if (item.request) result.request = normalizeRequest(item.request);
    else throw new Error(`「${result.name}」にrequestまたはitemがありません。`);
    return result;
  });
}
export function walkItems(items, visit, parents = []) {
  for (const item of items || []) {
    visit(item, parents);
    if (Array.isArray(item.item)) walkItems(item.item, visit, [...parents, item]);
  }
}
export function findItem(collection, id) {
  let found;
  walkItems(collection?.item, (item, parents) => {if (item._mpId === id) found = {item, parents};});
  return found;
}
export function importPostman(input, filename = 'Import') {
  let data = typeof input === 'string' ? JSON.parse(input.replace(/^\uFEFF/, '')) : clone(input);
  const result = {collections: [], environments: [], globals: [], warnings: []};
  function accept(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}: PostmanのJSONオブジェクトではありません。`);
    // An expanded Postman data dump includes archive.json containing IDs, not data.
    // Ignore only a recognized index; malformed JSON and malformed resources still fail
    // the caller's atomic batch import. Never fetch paths or URLs from the index.
    const indexKeys = ['collections', 'environments'];
    const indexName = text(name).split(/[\\/]/).pop().toLowerCase() === 'archive.json';
    if (indexName && indexKeys.some(key => Array.isArray(value[key])) &&
        indexKeys.every(key => value[key] == null || (Array.isArray(value[key]) && value[key].every(id => typeof id === 'string'))) &&
        !['info', 'item', 'values', 'collection', 'environment', 'globals'].some(key => Object.hasOwn(value, key))) {
      result.warnings.push(`${name}: data dumpの索引です。設定本体は含まれません。同じフォルダー内のCollection / EnvironmentのJSONを一緒に選択してください。`);
      return;
    }
    if (value.collection && !value.item) return accept(value.collection, name);
    if (value.environment && !value.values) return accept(value.environment, name);
    if (Array.isArray(value.collections) || Array.isArray(value.environments)) {
      for (const c of value.collections || []) accept(c, name);
      for (const e of value.environments || []) accept({...e, _postman_variable_scope: 'environment'}, name);
      if (value.globals) accept(Array.isArray(value.globals) ? {values: value.globals, _postman_variable_scope: 'globals'} : {...value.globals, _postman_variable_scope: 'globals'}, name);
      return;
    }
    if (value.globals && !value.values) return accept(Array.isArray(value.globals) ? {values: value.globals, _postman_variable_scope: 'globals'} : {...value.globals, _postman_variable_scope: 'globals'}, name);
    if (value.info && Array.isArray(value.item)) {
      const schema = text(value.info.schema);
      if (schema && !/\/v2\.(0|1)(\.0)?\//.test(schema)) throw new Error(`${name}: Collection v2.0 / v2.1に対応しています。`);
      const collection = {...value, _mpId: uid(), info: {...value.info, name: text(value.info.name || name)}, item: attachIds(value.item)};
      result.collections.push(collection);
      const events = [...(collection.event || [])];
      walkItems(collection.item, item => {
        events.push(...(item.event || []));
        const auth = item.request?.auth || item.auth;
        if (auth && !['noauth', 'basic', 'bearer', 'apikey', 'oauth2'].includes(auth.type)) result.warnings.push(`${item.name}: ${auth.type}認証は保持しますが送信には未対応です。`);
        const mode = item.request?.body?.mode;
        if (mode && !['raw', 'urlencoded', 'formdata', 'file', 'graphql', 'none'].includes(mode)) result.warnings.push(`${item.name}: Bodyモード「${mode}」は未対応です。`);
      });
      if (events.some(event => event.disabled !== true)) result.warnings.push(`${collection.info.name}: Scriptsは保持・表示しますが実行しません。スクリプトで生成する値は変数欄で設定してください。`);
      if (collection.auth && !['noauth', 'basic', 'bearer', 'apikey', 'oauth2'].includes(collection.auth.type)) result.warnings.push(`${collection.info.name}: ${collection.auth.type}認証は送信未対応です。`);
      return;
    }
    if (Array.isArray(value.values)) {
      const scope = value._postman_variable_scope || (/globals/i.test(name) ? 'globals' : 'environment');
      if (scope === 'globals') result.globals.push(...rows(value.values));
      else if (scope === 'environment') result.environments.push({...value, id: uid(), name: text(value.name || name), values: rows(value.values)});
      else throw new Error(`${name}: 変数スコープ「${scope}」は未対応です。`);
      return;
    }
    throw new Error(`${name}: Collection v2.0/v2.1、Environment、GlobalsのJSONを選択してください。ZIPは展開してから読み込んでください。`);
  }
  accept(data, filename);
  return result;
}
export function exportCollection(collection) {
  function clean(value) {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '_mpId').map(([key, v]) => [key, clean(v)]));
    return value;
  }
  const result = clean(clone(collection));
  result.info = {...result.info, schema: result.info?.schema || SCHEMA};
  const legacyAuth = /\/v2\.0(?:\.0)?\//.test(result.info.schema);
  function exportAuth(owner) {
    const auth = owner?.auth;
    if (!auth || typeof auth !== 'object' || !auth.type || auth.type === 'noauth') return;
    const attributes = auth[auth.type];
    // The auth editor writes arrays. Match the declared collection schema on export.
    if (legacyAuth && Array.isArray(attributes)) {
      auth[auth.type] = Object.fromEntries(attributes.filter(enabled).filter(a => a.key).map(a => [a.key, a.value]));
    } else if (!legacyAuth && attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
      auth[auth.type] = Object.entries(attributes).map(([key, value]) => ({key, value}));
    }
  }
  exportAuth(result);
  walkItems(result.item, item => {
    exportAuth(item);
    if (!item.request) return;
    const r = item.request;
    exportAuth(r);
    if (r.body?.mode === 'none') delete r.body;
    r.url = {...r.url, raw: displayUrl(r.url)};
  });
  return result;
}
export function contextFor(workspace, tab, primaryVariables = []) {
  const collection = workspace.collections.find(c => c._mpId === tab.collectionId);
  const located = findItem(collection, tab.itemId);
  const parents = located?.parents || [];
  const environment = workspace.environments.find(e => e.id === workspace.environmentId);
  const vars = Object.create(null);
  function apply(list) {for (const v of rows(list)) if (enabled(v) && v.key) vars[v.key] = text(v.value);}
  apply(workspace.globals); apply(collection?.variable);
  for (const parent of parents) apply(parent.variable);
  apply(environment?.values); apply(urlParts(tab.request.url).variable); apply(primaryVariables);
  let auth = collection?.auth || null;
  for (const parent of parents) if (parent.auth) auth = parent.auth;
  if (tab.request.auth) auth = tab.request.auth;
  const events = [...(collection?.event || []), ...parents.flatMap(p => p.event || []), ...(located?.item.event || [])];
  return {collection, parents, environment, vars, auth, events};
}
export function resolver(variables, dynamic = {}) {
  const cache = Object.create(null);
  const dynamicVars = { $timestamp: String(Math.floor(Date.now() / 1000)), $isoTimestamp: new Date().toISOString(), $guid: uid(), $randomUUID: uid(), $randomInt: String(Math.floor(Math.random() * 1001)), ...dynamic };
  function replace(value, stack = []) {
    return text(value).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, key) => {
      if (stack.includes(key)) throw new Error(`変数が循環しています: ${[...stack, key].join(' → ')}`);
      if (Object.hasOwn(cache, key)) return cache[key];
      const source = Object.hasOwn(variables, key) ? variables : dynamicVars;
      if (!Object.hasOwn(source, key)) throw new Error(`変数 {{${key}}} が未設定です。環境・コレクションの変数を確認してください。`);
      return cache[key] = replace(source[key], [...stack, key]);
    });
  }
  return replace;
}
export function toBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function compileRequest(workspace, tab, files = {}, primaryVariables = []) {
  const context = contextFor(workspace, tab, primaryVariables);
  const resolve = resolver(context.vars);
  const r = tab.request;
  const u = urlParts(r.url);
  let base = resolve(u.base.trimStart());
  if (!base) throw new Error('URLを入力してください。');
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(base)) base = `http://${base}`;
  if (!/^https?:\/\//i.test(base)) throw new Error('HTTP / HTTPSに対応しています。');
  const pathVariables = {};
  // Keep raw text in the transport JSON. The backend encodes path values,
  // Unicode and query components exactly once, after resolving structure.
  for (const match of base.matchAll(/(?:^|\/):([\w-]+)(?=\/|[?#]|$)/g)) {
    if (!Object.hasOwn(context.vars, match[1])) throw new Error(`パス変数 :${match[1]} が未設定です。`);
    pathVariables[match[1]] = resolve(context.vars[match[1]]);
  }
  const query = u.query.filter(enabled).filter(p => p.key).map(p => ({key: resolve(p.key), value: resolve(p.value)}));
  const setQueryValue = (key, value) => {
    for (let index = query.length - 1; index >= 0; index--) if (query[index].key === key) query.splice(index, 1);
    query.push({key, value, replace: true});
  };
  const headers = rows(r.header).filter(enabled).filter(h => h.key).map(h => ({key: resolve(h.key), value: resolve(h.value)}));
  function setHeader(key, value) {
    for (let i = headers.length - 1; i >= 0; i--) if (headers[i].key.toLowerCase() === key.toLowerCase()) headers.splice(i, 1);
    headers.push({key, value});
  }
  function defaultHeader(key, value) {if (!headers.some(h => h.key.toLowerCase() === key.toLowerCase())) headers.push({key, value});}
  const auth = context.auth;
  if (auth && auth.type !== 'noauth') {
    const attrs = Object.fromEntries(rows(auth[auth.type]).filter(enabled).map(a => [a.key, resolve(a.value)]));
    if (auth.type === 'bearer') setHeader('Authorization', `Bearer ${attrs.token || ''}`);
    else if (auth.type === 'basic') setHeader('Authorization', `Basic ${toBase64(`${attrs.username || ''}:${attrs.password || ''}`)}`);
    else if (auth.type === 'apikey') {
      if (!attrs.key) throw new Error('API Keyのキー名を入力してください。');
      if (attrs.in === 'query') setQueryValue(attrs.key, attrs.value || '');
      else setHeader(attrs.key, attrs.value || '');
    } else if (auth.type === 'oauth2') {
      const token = attrs.accessToken || attrs.access_token;
      if (!token) throw new Error('OAuth 2.0の取得済みaccessTokenを設定してください。トークン取得フローは未対応です。');
      if (attrs.addTokenTo === 'queryParams') setQueryValue('access_token', token);
      else setHeader('Authorization', `${attrs.headerPrefix || 'Bearer'} ${token}`);
    } else throw new Error(`${auth.type}認証の送信は未対応です。Authorizationで方式を変更してください。`);
  }
  const body = r.body || {};
  const payload = {method: r.method || 'GET', url: base, query, path_variables: pathVariables, headers, body: null, verify_tls: tab.settings?.verify_tls ?? false, follow_redirects: tab.settings?.follow_redirects ?? true, timeout_ms: tab.settings?.timeout_ms ?? 30000};
  if (!body.disabled && body.mode && body.mode !== 'none') {
    if (body.mode === 'raw') {
      payload.body = resolve(body.raw || '');
      const language = body.options?.raw?.language || 'text';
      const types = {json: 'application/json', xml: 'application/xml', html: 'text/html', javascript: 'application/javascript', text: 'text/plain; charset=utf-8'};
      defaultHeader('Content-Type', types[language] || types.text);
    } else if (body.mode === 'urlencoded') {
      payload.form_urlencoded = rows(body.urlencoded).filter(enabled).filter(p => p.key).map(p => ({key: resolve(p.key), value: resolve(p.value)}));
      defaultHeader('Content-Type', 'application/x-www-form-urlencoded');
    } else if (body.mode === 'formdata') {
      payload.multipart = [];
      (body.formdata || []).forEach((p, index) => {
        if (!enabled(p) || !p.key) return;
        if (p.type === 'file') {
          const chosen = files[`form-${index}`];
          if (!chosen?.length) throw new Error(`ファイル「${p.key}」を選択してください。Postmanのローカルパスからは自動取得できません。`);
          for (const f of chosen) payload.multipart.push({key: resolve(p.key), filename: f.name, content_type: p.contentType ? resolve(p.contentType) : f.type || 'application/octet-stream', data: f.data});
        } else payload.multipart.push({key: resolve(p.key), value: resolve(p.value), content_type: p.contentType ? resolve(p.contentType) : undefined});
      });
    } else if (body.mode === 'file') {
      const f = files.binary?.[0];
      if (!f) throw new Error('送信するバイナリファイルを選択してください。');
      payload.body_base64 = f.data;
      defaultHeader('Content-Type', f.type || 'application/octet-stream');
    } else if (body.mode === 'graphql') {
      let variables = resolve(body.graphql?.variables || '{}');
      if (typeof body.graphql?.variables === 'object') variables = resolve(JSON.stringify(body.graphql.variables));
      payload.body = JSON.stringify({query: resolve(body.graphql?.query || ''), variables: JSON.parse(variables || '{}')});
      defaultHeader('Content-Type', 'application/json');
    } else throw new Error(`Bodyモード「${body.mode}」は未対応です。`);
  }
  return {payload, warnings: context.events.some(e => e.disabled !== true) ? ['インポートしたScriptsは実行していません。'] : []};
}
