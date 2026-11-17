/** Virtual JavaScript project and live MiniPost type declarations.
 * Edited code is only copied into virtual files; it is never evaluated here.
 */
import {responseMetadata} from './runtime.mjs';
const own = (value, key) => value != null && Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const quote = value => JSON.stringify(String(value)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const union = types => {
  const unique = [...new Set(types)];
  return unique.includes('unknown') ? 'unknown' : unique.length ? unique.sort().join(' | ') : 'never';
};
const literalUnion = values => union([...new Set(values.filter(value => typeof value === 'string'))].map(quote));

/** Infer structural types, not literal values. Accessors are never invoked.
 * Budgets bound analysis of exceptionally large inputs; unvisited parts remain
 * unknown rather than pretending that a partial sample is the complete shape.
 */
function createShapeReader() {
  let remaining = 16000, truncated = false;
  const ancestors = new Set(), cached = new WeakMap();
  function shape(value, depth = 0) {
    if (value && typeof value === 'object' && cached.has(value)) return cached.get(value);
    if (--remaining < 0 || depth > 48) { truncated = true; return 'unknown'; }
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (['string','number','boolean','bigint'].includes(typeof value)) return typeof value;
    if (typeof value !== 'object') return 'unknown';
    if (ancestors.has(value)) return 'unknown';
    if (value instanceof Date) return 'Date';
    if (value instanceof RegExp) return 'RegExp';
    if (value instanceof Map) return 'Map<unknown, unknown>';
    if (value instanceof Set) return 'Set<unknown>';
    if (value instanceof ArrayBuffer) return 'ArrayBuffer';
    if (ArrayBuffer.isView(value)) {
      for (const name of ['DataView','Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array']) {
        if (typeof globalThis[name] === 'function' && value instanceof globalThis[name]) return name;
      }
      return 'ArrayBufferView';
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const types = new Set();
        for (let at = 0; at < value.length; at++) {
          if (remaining <= 0) { truncated = true; types.add('unknown'); break; }
          const descriptor = Object.getOwnPropertyDescriptor(value, at);
          types.add(descriptor && own(descriptor, 'value') ? shape(descriptor.value, depth + 1) : 'unknown');
        }
        const type = `Array<${types.size ? union([...types]) : 'unknown'}>`;
        cached.set(value,type); return type;
      }
      const entries = [];
      for (const key of Object.keys(value).sort()) {
        if (remaining <= 0) { truncated = true; entries.push('[key: string]: unknown'); break; }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const type = descriptor && own(descriptor, 'value') ? shape(descriptor.value, depth + 1) : 'unknown';
        entries.push(`${quote(key)}: ${type}`);
      }
      const type = entries.length ? `{ ${entries.join('; ')} }` : 'Record<string, unknown>';
      cached.set(value,type); return type;
    } finally { ancestors.delete(value); }
  }
  return {shape, get truncated() { return truncated; }};
}

function inputValue(script) {
  if (!script) return {known:false};
  if (script.inputFormat === 'text') return {known:true, value:String(script.input ?? '')};
  try { return {known:true, value:JSON.parse(String(script.input ?? 'null'))}; }
  catch { return {known:false}; }
}
function activeInput(context) {
  if (own(context, 'inputSource')) return inputValue({input:context.inputSource, inputFormat:context.inputFormat});
  if (context.phase === 'before') return {known:true, value:context.request ?? null};
  if (context.phase === 'after') return {known:true, value:context.response ?? null};
  return own(context, 'input') ? {known:true, value:context.input} : {known:false};
}
function responseJSON(context) {
  const raw = own(context,'rawResponse') ? context.rawResponse : context.raw;
  if (raw && !raw.error) {
    if (raw.body_encoding === 'base64') return {type:'never'};
    try { return {value:JSON.parse(raw.body || '')}; }
    catch { return {type:'never'}; }
  }
  // A decoded metadata object can describe JSON values directly. A string alone
  // cannot distinguish a JSON string from plain text, so it remains unknown.
  if (context.response && own(context.response,'body') && typeof context.response.body !== 'string') return {value:context.response.body};
  return {type:'unknown'};
}
function variableNames(value) {
  if (Array.isArray(value)) return value.filter(row => row?.key && row.enabled !== false && row.disabled !== true).map(row => String(row.key));
  return object(value) ? Object.keys(value) : [];
}

/** Match runtime ID-first lookup, then unique aliases, without resolving a
 * duplicated name to whichever entry happened to be enumerated first.
 */
function catalogReferences(entries, aliases) {
  const references = new Map(), candidates = new Map();
  for (const entry of entries) if (typeof entry.id === 'string' && !references.has(entry.id)) references.set(entry.id, entry);
  for (const entry of entries) for (const name of new Set(aliases(entry).filter(name => typeof name === 'string' && name))) {
    if (!candidates.has(name)) candidates.set(name, new Set());
    candidates.get(name).add(entry);
  }
  for (const [name, matches] of candidates) if (!references.has(name) && matches.size === 1) references.set(name, [...matches][0]);
  return references;
}
function callerBinding(context, caller) {
  const bindingId = caller ? caller.bindingId : context.scriptId == null || context.scriptId === '' ? context.bindingId : undefined;
  return bindingId && own(context.bindings,bindingId) && object(context.bindings[bindingId]) ? context.bindings[bindingId] : null;
}
function scriptReferences(scripts, binding) {
  const references = catalogReferences(scripts, script => [script.name]);
  if (object(binding)) for (const [reference, id] of Object.entries(binding)) {
    const matches = scripts.filter(script => script.id === id);
    if (matches.length === 1) references.set(reference, matches[0]);
    else references.delete(reference); // A deleted bound target never falls back.
  }
  return references;
}
const mapType = entries => entries.length ? `{\n${entries.map(([key,type]) => `  ${quote(key)}: ${type};`).join('\n')}\n}` : '{}';

const apiDeclarations = `
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type KnownString<K extends string> = K | (string & {});
export interface Variables<K extends string = string> {
  /** 変数の値を取得します。 */
  get(name: KnownString<K>): string | undefined;
  /** 変数の存在を確認します。 */
  has(name: KnownString<K>): boolean;
  /** 実行成功時に反映する変数を設定します。 */
  set(name: KnownString<K>, value: unknown): void;
  /** 変数を削除します。 */
  unset(name: KnownString<K>): void;
  /** 現在の変数をオブジェクトとして取得します。 */
  toObject(): Record<string, string> & { [P in K]: string };
}
export interface SharedData<D extends object> {
  /** 保存データを型を保って取得します。 */
  get<K extends keyof D & string>(key: K): D[K];
  get(key: string): unknown;
  /** 保存データの存在を確認します。 */
  has(key: KnownString<keyof D & string>): boolean;
  /** JSON値を設定します。変更は実行全体の成功時に反映します。 */
  set<T extends JsonValue>(key: KnownString<keyof D & string>, value: T): T;
  /** 保存データを削除します。 */
  delete(key: KnownString<keyof D & string>): boolean;
  keys(): string[];
  clear(): void;
}
export interface ScriptLibrary<R extends object, I extends { [P in keyof R]: unknown }> {
  /** 保存したスクリプトのIDと名前を取得します。 */
  list(): Array<{ id: ScriptId; name: ScriptName }>;
  /** 保存済みスクリプトへ入力を渡し、戻り値を受け取ります。 */
  run<K extends keyof R & string>(idOrName: K, input?: I[K]): Promise<R[K]>;
  /** 保存時と異なる入力も渡せます。スクリプト名から推論した戻り値の型は保持します。 */
  run<K extends keyof R & string>(idOrName: K, input: unknown): Promise<R[K]>;
  run(idOrName: string, input?: unknown): Promise<unknown>;
}
export interface ScriptConsole {
  log(...values: unknown[]): void;
  info(...values: unknown[]): void;
  debug(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
}
export interface VariableRow { key: string; value: string; enabled?: boolean; disabled?: boolean; description?: string; }
export interface RequestBody {
  mode?: string; raw?: string; options?: { raw?: { language?: string } };
  urlencoded?: VariableRow[]; formdata?: Array<VariableRow & { type?: string; src?: string }>;
  file?: { src?: string }; graphql?: { query?: string; variables?: string };
}
export interface Request {
  method: string;
  url: string | { raw?: string; protocol?: string; host?: string[]; port?: string; path?: string[]; query?: VariableRow[]; variable?: VariableRow[] };
  header?: VariableRow[]; body?: RequestBody; auth?: { type: string; [key: string]: unknown };
  description?: string; _minipost?: { before?: string; after?: string; beforeScriptId?: string; afterScriptId?: string; scriptBindingId?: string; enabled?: boolean; timeoutMs?: number; extractions?: unknown[] };
}
/** Preserve the current shape when reading, while allowing another supported request representation when writing. */
export type MutableRequest<S extends Request> = Omit<S, 'url' | 'header' | 'body' | 'auth'> & {
  get url(): S['url'];
  set url(value: Request['url']);
  get header(): S['header'];
  set header(value: Request['header']);
  get body(): S['body'];
  set body(value: Request['body']);
  get auth(): S['auth'];
  set auth(value: Request['auth']);
};
export interface RequestSettings { verify_tls?: boolean; follow_redirects?: boolean; timeout_ms?: number; [key: string]: unknown; }
export interface RequestDescriptor { id: string; name: string; path: string; collectionId?: string; itemId?: string; draftId?: string; }
export interface RequestEntry extends RequestDescriptor { request: Request; settings: RequestSettings; }
export interface Environment { id: string; name: string; values: VariableRow[]; }
export interface ResponseMetadata<B = unknown> {
  status: number; statusText: string; headers: Record<string, string | string[]>; cookies: string[]; body: B;
  elapsed_ms: number; size: number; url: string; content_type: string; received_at: string;
  redirects: unknown[]; body_encoding: string;
}
export type ResponseView = 'pretty' | 'raw' | 'headers' | 'cookies' | 'preview';
export interface MutableResponse<B, J, H extends object> extends Omit<ResponseMetadata<B>, 'body' | 'headers'> {
  /** 受信本文の構造を参照します。JSON値または文字列を代入して表示内容を変更できます。 */
  get body(): B;
  set body(value: JsonValue);
  get headers(): H & Record<string, string | string[]>;
  set headers(value: Record<string, string | string[]>);
  /** 本文を置き換えて値を返します。Content-Typeを省略すると文字列はtext/plain、ほかのJSON値はapplication/jsonになります。 */
  setBody<T extends JsonValue>(value: T, contentType?: string): T;
  /** ヘッダー名は大文字・小文字を区別しません。複数値の場合は先頭を取得します。 */
  getHeader(name: KnownString<keyof H & string>): string | undefined;
  /** ヘッダーを設定します。配列を渡すと複数の値を保持します。 */
  setHeader(name: KnownString<keyof H & string>, value: string | string[]): void;
  /** 指定したヘッダーを削除します。 */
  removeHeader(name: KnownString<keyof H & string>): void;
  /** 現在の本文を文字列として取得します。 */
  text(): string;
  /** 現在の本文をJSONとして取得します。バイナリ本文や無効なJSONはエラーになります。 */
  json(): J;
  /** 成功時にレスポンスの表示形式を切り替えます。 */
  show(view: ResponseView): void;
}
export interface PostmanResponse<B, H extends object> {
  code: number; status: string; responseTime: number; responseSize: number;
  headers: {
    get(name: KnownString<keyof H & string>): string | undefined;
    all(): H;
  };
  /** JSONレスポンスを取得します。 */
  json(): B;
  /** レスポンス本文を文字列で取得します。 */
  text(): string;
}
export interface Expectation {
  to: {
    equal(expected: unknown): void;
    eql(expected: unknown): void;
    include(expected: unknown): void;
  };
}
export interface PostmanAPI {
  variables: PrimaryVariables; environment: EnvironmentVariables; globals: GlobalVariables;
  request: CurrentRequest | null; response: PostmanResponse<ResponseJSON, ResponseHeaders> | null;
  /** 名前付きの検証を実行します。非同期関数にも対応します。 */
  test(name: string, fn: () => unknown): void | Promise<void>;
  expect(actual: unknown): Expectation;
}
export interface RequestsAPI {
  /** 保存済みリクエストと下書きの一覧を取得します。 */
  list(): Promise<RequestDescriptor[]>;
  /** ID、一意の名前またはパスから設定を取得します。 */
  get<K extends keyof RequestLookup & string>(reference: K): Promise<RequestLookup[K]>;
  get(reference: string | { id: string }): Promise<RequestEntry>;
  /** HTTP処理を一度実行します。送信前後の処理は自動では呼びません。 */
  send(reference: KnownString<keyof RequestLookup & string> | RequestEntry | Request, options?: { environmentId?: KnownString<EnvironmentId>; settings?: RequestSettings }): Promise<ResponseMetadata>;
}
export interface EnvironmentsAPI {
  list(): Promise<Array<{ id: EnvironmentId; name: EnvironmentName }>>;
  get<K extends keyof EnvironmentLookup & string>(idOrName: K): Promise<EnvironmentLookup[K]>;
  get(idOrName: string | { id: string }): Promise<Environment>;
}
export interface SavedScript { id: string; name: string; source: string; input: string; inputFormat: 'json' | 'text'; timeoutMs: number; bindingId?: string; }
export interface Workspace {
  version: number; environmentId: string | null; scripts: SavedScript[]; scriptData: StoreData;
  scriptBindings: Record<string, Record<string, string>>; environments: Environment[]; globals: VariableRow[];
  collections: Array<{ _mpId: string; info: { name: string; [key: string]: unknown }; item: unknown[]; variable?: VariableRow[] }>;
  tabs: Array<{ id: string; name: string; request: Request; settings?: RequestSettings; collectionId?: string; itemId?: string }>;
  history: unknown[]; relations: unknown[]; relationRuns?: unknown[]; revisions?: Record<string, unknown[]>;
}
export interface MiniPostAPI<R extends object, I extends { [P in keyof R]: unknown }> {
  /** 現在の実行が扱うリクエストです。request、pm.requestと同じ変更対象です。 */
  request: CurrentRequest | null;
  /** 現在の実行が扱うレスポンスです。responseと同じ変更対象です。送信前や独立実行ではnullです。 */
  response: CurrentResponse | null;
  requests: RequestsAPI; environments: EnvironmentsAPI;
  workspace: { read(): Promise<Workspace> };
  variables: PrimaryVariables; environment: EnvironmentVariables; globals: GlobalVariables;
  scripts: ScriptLibrary<R, I>; store: SharedData<StoreData>;
}
`;

function wrapper(source, suffix, declarationPath) {
  const imported = name => `import(${quote(declarationPath)}).${name}`;
  const types = {
    pm:'PostmanAPI', vars:'PrimaryVariables', response:'CurrentResponse | null', request:'CurrentRequest | null',
    console:'ScriptConsole', input:`Input_${suffix}`, scripts:`Scripts_${suffix}`, store:'SharedData<StoreData>', minipost:`MiniPost_${suffix}`
  };
  const annotations = Object.entries(types).map(([name,type]) => {
    const expanded = type === 'SharedData<StoreData>' ? `${imported('SharedData')}<${imported('StoreData')}>` : imported(type);
    return ` * @param {${expanded}} ${name}`;
  }).join('\n');
  const prefix = `/**\n${annotations}\n */\nexport async function __run(pm, vars, response, request, console, input, scripts, store, minipost) {\n{\n`;
  return {text:prefix + source + '\n}\n}\n', offset:prefix.length};
}

/** A fresh dictionary is derived from current workspace state on every update.
 * The language service retains parsed snapshots when generated files are equal.
 */
export function buildLanguageProject(source, context = {}) {
  source = String(source ?? '');
  if (context.phase === 'before') context = {...context,response:null,rawResponse:null,raw:null};
  else if (own(context,'rawResponse')) context = {...context,response:responseMetadata(context.rawResponse)};
  const reader = createShapeReader(), files = Object.create(null);
  const scripts = (Array.isArray(context.scripts) ? context.scripts : []).filter(script => script && typeof script.id === 'string' && typeof script.source === 'string');
  const paths = new Map(scripts.map((script,index) => [script, `/minipost/scripts/${index}.js`]));
  const active = scripts.find(script => script.id === context.scriptId);
  const input = activeInput(context);
  const suffixes = new Map(scripts.map((script,index) => [script, String(index)]));
  const declarations = [apiDeclarations];
  // Prioritize the active input, then reuse shared dictionaries for callers that
  // have the same binding group. Hundreds of scripts must not create hundreds
  // of copies of the complete script catalog in the language-service project.
  const inputTypes = new Map();
  const readInput = (caller,current) => {
    const parsed = current && input.known ? input : current && (own(context,'input') || own(context,'inputSource')) ? {known:false} : inputValue(caller);
    return parsed.known ? reader.shape(parsed.value) : 'unknown';
  };
  inputTypes.set(active || null,readInput(active,true));
  for (const script of scripts) if (script !== active) inputTypes.set(script,readInput(script,false));
  const shapeOr = (value, fallback) => value == null ? fallback : reader.shape(value);
  declarations.push(`export type ScriptId = ${literalUnion(scripts.map(script => script.id))};`);
  declarations.push(`export type ScriptName = ${literalUnion(scripts.map(script => script.name))};`);
  declarations.push(`export type PrimaryVariables = Variables<${literalUnion([...variableNames(context.variables),...variableNames(context.primary)])}>;`);
  declarations.push(`export type EnvironmentVariables = Variables<${literalUnion(variableNames(context.environment))}>;`);
  declarations.push(`export type GlobalVariables = Variables<${literalUnion(variableNames(context.globals))}>;`);
  declarations.push(`export type StoreData = ${object(context.data) ? reader.shape(context.data) : '{}'};`);
  declarations.push(`export type CurrentRequest = MutableRequest<Request${context.request ? ` & ${reader.shape(context.request)}` : ''}>;`);
  declarations.push(`export type ResponseBody = ${context.response && own(context.response, 'body') ? reader.shape(context.response.body) : 'unknown'};`);
  const json = responseJSON(context);
  declarations.push(`export type ResponseJSON = ${json.type || reader.shape(json.value)};`);
  declarations.push(`export type ResponseHeaders = ${shapeOr(context.response?.headers, 'Record<string, string | string[]>')};`);
  declarations.push('export type CurrentResponse = MutableResponse<ResponseBody, ResponseJSON, ResponseHeaders>;');

  const requests = Array.isArray(context.requests) ? context.requests.filter(object) : [];
  const requestReferences = catalogReferences(requests, entry => [entry.name,entry.path,entry.itemId,entry.draftId]);
  const requestTypes = new Map(requests.map((entry,index) => {
    const name = `Request_${index}`;
    declarations.push(`export type ${name} = RequestEntry & ${reader.shape(entry)};`);
    return [entry, name];
  }));
  declarations.push(`export type RequestLookup = ${mapType([...requestReferences].map(([reference,entry]) => [reference,requestTypes.get(entry)]))};`);
  const environments = Array.isArray(context.environments) ? context.environments.filter(object) : [];
  declarations.push(`export type EnvironmentId = ${literalUnion(environments.map(env => env.id))};`);
  declarations.push(`export type EnvironmentName = ${literalUnion(environments.map(env => env.name))};`);
  const environmentReferences = catalogReferences(environments, env => [env.name]);
  const environmentTypes = new Map(environments.map((entry,index) => {
    const name = `Environment_${index}`;
    declarations.push(`export type ${name} = Environment & ${reader.shape(entry)};`);
    return [entry,name];
  }));
  declarations.push(`export type EnvironmentLookup = ${mapType([...environmentReferences].map(([reference,entry]) => [reference,environmentTypes.get(entry)]))};`);

  const groups = new Map();
  const createCaller = (caller, suffix) => {
    declarations.push(`export type Input_${suffix} = ${inputTypes.get(caller)};`);
    const binding = callerBinding(context,caller);
    if (!groups.has(binding)) {
      const group = groups.size; groups.set(binding,group);
      const references = [...scriptReferences(scripts,binding)];
      const returnEntries = references.map(([reference,target]) => [reference,`Awaited<ReturnType<typeof import(${quote('./scripts/'+suffixes.get(target)+'.js')}).__run>>`]);
      const inputEntries = references.map(([reference,target]) => [reference,`Input_${suffixes.get(target)}`]);
      declarations.push(`export type ResultsGroup_${group} = ${mapType(returnEntries)};`);
      declarations.push(`export type InputsGroup_${group} = ${mapType(inputEntries)};`);
    }
    declarations.push(`export type Results_${suffix} = ResultsGroup_${groups.get(binding)};`);
    declarations.push(`export type Inputs_${suffix} = InputsGroup_${groups.get(binding)};`);
    declarations.push(`export type Scripts_${suffix} = ScriptLibrary<Results_${suffix}, Inputs_${suffix}>;`);
    declarations.push(`export type MiniPost_${suffix} = MiniPostAPI<Results_${suffix}, Inputs_${suffix}>;`);
  };
  let fileName = '/minipost/active.js', offset = 0;
  for (const script of scripts) {
    const current = script === active, suffix = suffixes.get(script);
    createCaller(script,suffix);
    const built = wrapper(current ? source : script.source,suffix,'../model');
    files[paths.get(script)] = built.text;
    if (current) { fileName = paths.get(script); offset = built.offset; }
  }
  if (!active) {
    createCaller(null,'active');
    const built = wrapper(source,'active','./model');
    files[fileName] = built.text; offset = built.offset;
  }
  files['/minipost/model.d.ts'] = declarations.join('\n\n') + '\n';
  return {files,fileName,offset,sourceLength:source.length,shapeTruncated:reader.truncated};
}
