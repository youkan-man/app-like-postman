/** Session-owned values and pure response/variable extraction. No network or DOM. */
export const PRIMARY_KEY = 'minipost.primary.v1';
export const RESPONSE_KEY = 'minipost.responses.v1';
export const variableText = value => value == null ? (value === null ? 'null' : '') : typeof value === 'object' ? JSON.stringify(value) : String(value);
export function checkName(name) {
  name = String(name ?? '').trim();
  if (!name || /[{}\r\n]/.test(name)) throw new Error('変数名を入力してください（波括弧・改行は使用できません）。');
  return name;
}
export function upsertVariable(list, key, value) {
  key = checkName(key);
  const row = list.findLast(r => r.key === key);
  if (row) {row.value = variableText(value); row.disabled = false; row.enabled = true;}
  else list.push({key, value: variableText(value), enabled:true});
  return list;
}
export class PrimaryVariables {
  constructor(storage = null, onError = () => {}) {
    this.storage = storage; this.onError = onError; this.rows = [];
    try {const saved = JSON.parse(storage?.getItem(PRIMARY_KEY) || '[]'); if (Array.isArray(saved)) this.rows = saved.filter(r => r && typeof r.key === 'string').map(r => ({...r, value:variableText(r.value)}));}
    catch (error) {onError(error);}
  }
  get(key) {return this.rows.findLast(r => r.key === key && r.disabled !== true && r.enabled !== false)?.value;}
  set(key,value) {upsertVariable(this.rows,key,value); this.save();}
  unset(key) {this.rows = this.rows.filter(r => r.key !== key); this.save();}
  clear() {this.rows = []; this.save();}
  save() {try {this.storage?.setItem(PRIMARY_KEY, JSON.stringify(this.rows));} catch (error) {this.onError(error);}}
  snapshot() {return Object.fromEntries(this.rows.filter(r => r.key && r.disabled !== true && r.enabled !== false).map(r => [r.key,r.value]));}
  apply(writes = []) {
    // Validate the entire transaction before committing any script output.
    const next = this.rows.map(r => ({...r}));
    for (const row of writes) {
      const key = checkName(row.key);
      if (row.remove) {for (let i=next.length-1;i>=0;i--) if(next[i].key===key) next.splice(i,1);}
      else upsertVariable(next,key,row.value);
    }
    this.rows = next; this.save();
  }
}
export function extractVariableNames(value) {
  const found = new Set();
  const visit = input => {
    if (typeof input === 'string') {for (const match of input.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) if (!match[1].startsWith('$')) found.add(match[1]);}
    else if (Array.isArray(input)) input.forEach(visit);
    else if (input && typeof input === 'object') Object.values(input).forEach(visit);
  };
  visit(value); return [...found];
}
export function responseMetadata(result) {
  if (!result || result.error) return null;
  const headers = Object.create(null), cookies = [];
  for (const row of result.headers || []) {
    const key = row.key.toLowerCase();
    if (Object.hasOwn(headers,key)) headers[key] = [...(Array.isArray(headers[key]) ? headers[key] : [headers[key]]),row.value];
    else headers[key] = row.value;
    if (key === 'set-cookie') cookies.push(row.value);
  }
  let body = result.body ?? '';
  if (result.body_encoding !== 'base64') {try {body = JSON.parse(body);} catch {}}
  return {status:result.status, statusText:result.status_text || '', headers, cookies, body,
    elapsed_ms:result.elapsed_ms, size:result.size, url:result.url || '', content_type:result.content_type || '',
    received_at:result.received_at || '', redirects:result.redirects || [], body_encoding:result.body_encoding || 'text'};
}
export const pointerEscape = value => String(value).replace(/~/g,'~0').replace(/\//g,'~1');
export function readPath(root, path) {
  if (path === '' || path === '$') return root;
  let keys;
  if (path.startsWith('/')) {
    if (/~(?![01])/u.test(path)) throw new Error('JSON Pointerの ~ は ~0 または ~1 で指定してください。');
    keys = path.slice(1).split('/').map(v => v.replace(/~1/g,'/').replace(/~0/g,'~'));
  } else {
    // Support simple dot paths and numeric array indices, not executable expressions.
    const normalized = path.replace(/^\$\.?/,'').replace(/\[(\d+)\]/g,'.$1');
    if (/[\[\]]/.test(normalized)) throw new Error('特殊なキー名には /body/key のJSON Pointer形式を使用してください。');
    keys = normalized.split('.');
  }
  let value = root;
  for (const key of keys) {
    if (value == null || typeof value !== 'object' || !Object.hasOwn(value,key)) return undefined;
    value = value[key];
  }
  return value;
}
export function metadataElements(metadata, limit = 5000) {
  const result = [];
  function walk(value, path, depth) {
    if (result.length >= limit || depth > 64) return;
    result.push({path, value, type:value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, depth});
    if (value && typeof value === 'object') for (const [key,child] of Object.entries(value)) walk(child,`${path}/${pointerEscape(key)}`,depth+1);
  }
  if(metadata) for (const [key,value] of Object.entries(metadata)) walk(value,'/'+pointerEscape(key),0);
  return {elements:result,truncated:result.length>=limit};
}
export function extractionWrites(rules, metadata) {
  if (!metadata) throw new Error('レスポンスを受信してから抽出してください。');
  const writes = [];
  for (const rule of rules || []) {
    if (rule.enabled === false) continue;
    const name = checkName(rule.name), value = readPath(metadata,String(rule.path || ''));
    if (value === undefined) {
      if (rule.missing === 'empty') writes.push({key:name,value:''});
      else if (rule.missing === 'error') throw new Error(`抽出元がありません: ${rule.path}`);
    } else writes.push({key:name,value:variableText(value)});
  }
  return writes;
}
export function requestAutomation(request) {
  const auto = request._minipost || {};
  return {before:String(auto.before || ''),after:String(auto.after || ''),enabled:auto.enabled !== false,
    timeoutMs:Number.isFinite(auto.timeoutMs) ? Math.max(0,auto.timeoutMs) : 5000,
    extractions:Array.isArray(auto.extractions) ? auto.extractions : []};
}
