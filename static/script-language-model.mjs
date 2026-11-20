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
function callerBinding(context, caller, property = 'bindings') {
  const bindingId = caller ? caller.bindingId : context.scriptId == null || context.scriptId === '' ? context.bindingId : undefined;
  return bindingId && own(context[property],bindingId) && object(context[property][bindingId]) ? context[property][bindingId] : null;
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

/** Ribbon keys follow the runtime's ID, qualified-key, active-ribbon, unique-key
 * lookup order. Import bindings are caller-specific and never fall back when a
 * previously bound control is removed.
 */
function ribbonCatalog(context) {
  const ribbons = (context.ribbonScopeId && Array.isArray(context.ribbons) ? context.ribbons : []).filter(item => object(item) && typeof item.id === 'string');
  const controls = ribbons.flatMap(ribbon => (ribbon.groups || []).flatMap(group => (group.controls || [])
    .filter(control => object(control) && typeof control.id === 'string')
    .map(control => ({ribbon,control}))));
  const ribbonReferences = catalogReferences(ribbons,item => [item.key,item.name]);
  const controlReferences = catalogReferences(controls.map(item => ({...item,id:item.control.id})),item => [`${item.ribbon.key}.${item.control.key}`]);
  const keys = new Map();
  for (const row of controlReferences.values()) {
    const key = row.control.key;
    if (typeof key !== 'string') continue;
    if (!keys.has(key)) keys.set(key,new Map());
    keys.get(key).set(row.control.id,row);
  }
  for (const [key,entries] of keys) {
    if (controlReferences.has(key)) continue;
    const matches = [...entries.values()], active = matches.filter(row => row.ribbon.id === context.activeRibbonId);
    if (active.length === 1) controlReferences.set(key,active[0]);
    else if (!active.length && matches.length === 1) controlReferences.set(key,matches[0]);
  }
  const bind = (references,bindings,entries,id) => {
    const result = new Map(references);
    if (object(bindings)) for (const [reference,target] of Object.entries(bindings)) {
      const matches = entries.filter(entry => id(entry) === target);
      if (matches.length === 1) result.set(reference,matches[0]);
      else result.delete(reference);
    }
    return result;
  };
  return {ribbons,controls,
    references(binding) {return {
      ribbons:bind(ribbonReferences,binding?.ribbons,ribbons,item => item.id),
      controls:bind(controlReferences,binding?.controls,controls,item => item.control.id)
    };}
  };
}

const apiDeclarations = `
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type KnownString<K extends string> = K | (string & {});
export type ByteInput = string | ArrayBuffer | ArrayBufferView | number[];
export type PairInput = string | Array<{ key: string; value?: unknown; enabled?: boolean; disabled?: boolean } | [string, unknown]> | Record<string, unknown>;
export interface PairTools {
  parse(value: PairInput): VariableRow[]; stringify(value: PairInput): string;
  get(value: PairInput, key: string): string | undefined; getAll(value: PairInput, key: string): string[];
  set(value: PairInput, key: string, next: unknown): VariableRow[]; append(value: PairInput, key: string, next: unknown): VariableRow[];
  remove(value: PairInput, key: string): VariableRow[]; toObject(value: PairInput): Record<string, string | string[]>;
}
export type JSONPath = string | ReadonlyArray<string | number>;
export type PathMember<T, K> = K extends keyof NonNullable<T> ? NonNullable<T>[K] : NonNullable<T> extends ReadonlyArray<infer V> ? K extends number | \`\${number}\` ? V : unknown : unknown;
export type PathTuple<T, P> = P extends readonly [infer H, ...infer R] ? PathTuple<PathMember<T, H>, R> : P extends readonly [] ? T : unknown;
export type PointerKey<P extends string> = P extends \`\${infer A}~1\${infer B}\` ? PointerKey<\`\${A}/\${B}\`> : P extends \`\${infer A}~0\${infer B}\` ? \`\${A}~\${PointerKey<B>}\` : P;
export type PointerValue<T, P extends string> = P extends \`\${infer H}/\${infer R}\` ? PointerValue<PathMember<T, PointerKey<H>>, R> : PathMember<T, PointerKey<P>>;
export type BracketKey<P extends string> = P extends \`"\${infer K}"\` ? K : P;
export type DotPathValue<T, P extends string> = P extends '' ? T : P extends \`.\${infer R}\` ? DotPathValue<T, R> : P extends \`\${infer H}[\${infer I}]\${infer R}\` ? DotPathValue<PathMember<DotPathValue<T,H>,BracketKey<I>>,R> : P extends \`\${infer H}.\${infer R}\` ? DotPathValue<PathMember<T,H>,R> : PathMember<T,P>;
export type PathValue<T, P> = P extends readonly unknown[] ? PathTuple<T,P> : P extends string ? string extends P ? unknown : P extends '' | '$' ? T : P extends \`/\${infer R}\` ? PointerValue<T,R> : P extends \`$.\${infer R}\` ? DotPathValue<T,R> : P extends \`$[\${infer R}\` ? DotPathValue<T,\`[\${R}\`> : DotPathValue<T,P> : unknown;
export type PointerParts<P extends string> = P extends \`\${infer H}/\${infer R}\` ? [PointerKey<H>,...PointerParts<R>] : [PointerKey<P>];
export type DotParts<P extends string> = P extends '' ? [] : P extends \`.\${infer R}\` ? DotParts<R> : P extends \`\${infer H}[\${infer I}]\${infer R}\` ? [...DotParts<H>,BracketKey<I>,...DotParts<R>] : P extends \`\${infer H}.\${infer R}\` ? [H,...DotParts<R>] : [P];
export type PathParts<P> = P extends readonly unknown[] ? P : P extends string ? string extends P ? string[] : P extends '' | '$' ? [] : P extends \`/\${infer R}\` ? PointerParts<R> : P extends \`$.\${infer R}\` ? DotParts<R> : P extends \`$[\${infer R}\` ? DotParts<\`[\${R}\`> : DotParts<P> : string[];
export type SetMember<T,K,V> = T extends readonly (infer E)[] ? Array<E | V> : Omit<NonNullable<T>,K & PropertyKey> & Record<K & PropertyKey,V>;
export type SetParts<T,P,V> = P extends readonly [] ? V : P extends readonly [infer H,...infer R] ? SetMember<T,H,SetParts<PathMember<T,H>,R,V>> : JsonValue;
export type RemoveParts<T,P> = P extends readonly [] ? null : P extends readonly [infer H] ? T extends readonly unknown[] ? T : Omit<T,H & PropertyKey> : P extends readonly [infer H,...infer R] ? SetMember<T,H,RemoveParts<PathMember<T,H>,R>> : JsonValue;
export type SelectParts<T,P> = P extends readonly [] ? T : P extends readonly [infer H,...infer R] ? SelectParts<H extends '*' ? T extends readonly (infer E)[] ? E : T[keyof T] : PathMember<T,H>,R> : unknown;
export type DeepMerge<A,B> = B extends readonly unknown[] ? B : B extends object ? A extends object ? { [K in keyof A | keyof B]: K extends keyof B ? K extends keyof A ? DeepMerge<A[K],B[K]> : B[K] : K extends keyof A ? A[K] : never } : B : B;
export type MergeValues<V,A = {}> = V extends readonly [] ? A : V extends readonly [infer H,...infer R] ? MergeValues<R,DeepMerge<A,H>> : JsonValue;
export type JSONSchema = boolean | { $schema?: string; title?: string; description?: string; default?: JsonValue; examples?: JsonValue[];
  type?: 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object' | Array<'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object'>;
  enum?: JsonValue[]; const?: JsonValue; properties?: Record<string,JSONSchema>; required?: string[]; additionalProperties?: JSONSchema;
  items?: JSONSchema; minItems?: number; maxItems?: number; uniqueItems?: boolean; minLength?: number; maxLength?: number; pattern?: string;
  minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; multipleOf?: number;
  anyOf?: JSONSchema[]; allOf?: JSONSchema[]; oneOf?: JSONSchema[]; not?: JSONSchema };
export interface ValidationResult { valid: boolean; errors: Array<{ path: string; keyword: string; message: string }> }
export interface JSONTools {
  pointer(path: JSONPath): string;
  get<T, const P extends JSONPath>(value: T, path: P): PathValue<T,P>;
  get<T, const P extends JSONPath, F>(value: T, path: P, fallback: F): PathValue<T,P> | F;
  has(value: unknown, path: JSONPath): boolean;
  set<T, const P extends JSONPath, V extends JsonValue>(value: T, path: P, next: V): SetParts<T,PathParts<P>,V>;
  update<T, const P extends JSONPath, V extends JsonValue>(value: T, path: P, fn: (current: PathValue<T,P>) => V): SetParts<T,PathParts<P>,V>;
  remove<T, const P extends JSONPath>(value: T, path: P): RemoveParts<T,PathParts<P>>;
  select<T, const P extends JSONPath>(value: T, path: P): Array<{ path: string; value: SelectParts<T,PathParts<P>> }>;
  flatten(value: JsonValue): Record<string,JsonValue>;
  diff(before: JsonValue, after: JsonValue): Array<{ op: 'add' | 'remove' | 'replace'; path: string; value?: JsonValue }>;
  pick<T, K extends keyof T>(value: T, keys: readonly K[]): Pick<T,K>;
  omit<T, K extends keyof T>(value: T, keys: readonly K[]): Omit<T,K>;
  merge<V extends JsonValue[]>(...values: V): MergeValues<V>;
  schema(value: JsonValue): JSONSchema; validate(value: JsonValue, schema: JSONSchema): ValidationResult;
}
export interface DecodeBytes {
  decode(value: string, options: { asBytes: true; fatal?: boolean; urlSafe?: boolean }): Uint8Array;
  decode(value: string, options?: { asBytes?: false; fatal?: boolean; urlSafe?: boolean }): string;
}
export interface ScriptTools {
  url: {
    parse(value: string, base?: string): { href: string; origin: string; protocol: string; hostname: string; port: string; username: string; password: string; path: string; hash: string; query: VariableRow[] };
    build(value: string, options?: { base?: string; path?: string; query?: PairInput; hash?: string; username?: string; password?: string }): string;
    join(base: string, ...segments: Array<string | number>): string;
  };
  query: PairTools; headers: PairTools;
  cookies: {
    parse(value: string): Record<string,string>; stringify(value: PairInput): string;
    parseSetCookie(value: string): { name: string; value: string; attributes: Record<string,string | true> };
    serialize(name: string, value: unknown, attributes?: Record<string,string | number | boolean | Date | null>): string;
  };
  request: { build(options: { method?: string; url: string; query?: PairInput; headers?: PairInput; json?: JsonValue; form?: PairInput; body?: string | RequestBody; basic?: { username: string; password: string }; bearer?: string }): Request & { url: string; header: VariableRow[] } };
  json: JSONTools;
  csv: {
    parse(source: string, options: { header: true; delimiter?: string; skipEmptyLines?: boolean }): Array<Record<string,string>>;
    parse(source: string, options?: { header?: false; delimiter?: string; skipEmptyLines?: boolean }): string[][];
    stringify(values: Array<Record<string,unknown> | unknown[]>, options?: { delimiter?: string; header?: boolean; columns?: string[]; lineEnding?: '\\r\\n' | '\\n' | '\\r'; trailingNewline?: boolean }): string;
  };
  encoding: {
    utf8: { encode(value: ByteInput): Uint8Array; decode(value: ByteInput, options?: { fatal?: boolean }): string };
    base64: DecodeBytes & { encode(value: ByteInput, options?: { urlSafe?: boolean; padding?: boolean }): string };
    hex: DecodeBytes & { encode(value: ByteInput): string };
    url: { encode(value: string): string; decode(value: string): string };
  };
  crypto: {
    hash(value: ByteInput, algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512', format: 'bytes'): Promise<Uint8Array>;
    hash(value: ByteInput, algorithm?: 'SHA-256' | 'SHA-384' | 'SHA-512', format?: 'hex' | 'base64' | 'base64url'): Promise<string>;
    hmac(key: ByteInput, value: ByteInput, algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512', format: 'bytes'): Promise<Uint8Array>;
    hmac(key: ByteInput, value: ByteInput, algorithm?: 'SHA-256' | 'SHA-384' | 'SHA-512', format?: 'hex' | 'base64' | 'base64url'): Promise<string>;
    randomBytes(length: number): Uint8Array; uuid(): string;
  };
  assert: {
    ok<T>(value: T, message?: string): NonNullable<T>; equal<T>(actual: T, expected: unknown, message?: string): T;
    deepEqual<T>(actual: T, expected: unknown, message?: string): T; match<T>(value: T, pattern: string | RegExp, message?: string): T;
    schema<T extends JsonValue>(value: T, schema: JSONSchema): T;
    throws(fn: () => unknown, match?: string | RegExp): unknown; rejects(fn: () => unknown | Promise<unknown>, match?: string | RegExp): Promise<unknown>;
  };
  data: {
    range(end: number): number[]; range(start: number, end: number, step?: number): number[];
    chunk<T>(items: T[], size: number): T[][];
    uniqueBy<T>(items: T[], key?: JSONPath | ((item: T, index: number) => unknown)): T[];
    groupBy<T>(items: T[], key: JSONPath | ((item: T, index: number) => unknown)): Record<string,T[]>;
    countBy<T>(items: T[], key: JSONPath | ((item: T, index: number) => unknown)): Record<string,number>;
    sortBy<T>(items: T[], key: JSONPath | ((item: T, index: number) => unknown), options?: { descending?: boolean }): T[];
  };
  flow: {
    delay(milliseconds: number): Promise<void>;
    retry<T>(fn: (attempt: number) => T | Promise<T>, options?: { attempts?: number; delayMs?: number; factor?: number; maxDelayMs?: number; shouldRetry?: (error: unknown, attempt: number) => boolean | Promise<boolean> }): Promise<Awaited<T>>;
    poll<T>(fn: (attempt: number) => T | Promise<T>, options?: { until?: (value: Awaited<T>, attempt: number) => boolean | Promise<boolean>; intervalMs?: number; timeoutMs?: number; maxAttempts?: number }): Promise<Awaited<T>>;
    batch<T,R>(items: T[], fn: (item: T, index: number) => R | Promise<R>, options: { concurrency?: number; settle: true }): Promise<Array<PromiseSettledResult<Awaited<R>>>>;
    batch<T,R>(items: T[], fn: (item: T, index: number) => R | Promise<R>, options?: { concurrency?: number; settle?: false }): Promise<Array<Awaited<R>>>;
  };
}
export interface Variables<K extends string = string> {
  list(): VariableRow[];
  /** 変数の値を取得します。 */
  get(name: KnownString<K>): string | undefined;
  /** 変数の存在を確認します。 */
  has(name: KnownString<K>): boolean;
  /** 実行成功時に反映する変数を設定します。 */
  set(name: KnownString<K>, value: unknown): void;
  /** 変数を削除します。 */
  unset(name: KnownString<K>): void;
  clear(): number;
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
export interface RibbonDescriptor { id: string; key: string; name: string; }
export type RibbonControlType = 'button' | 'text' | 'number' | 'select' | 'toggle' | 'display';
export interface RibbonControlDescriptor<V = JsonValue> {
  id: string; key: string; label: string; type: RibbonControlType; value: V;
  visible: boolean; enabled: boolean;
  ribbonId: string; ribbonKey: string; ribbonName: string; groupId: string; groupName: string;
}
export interface RibbonDefinition extends RibbonDescriptor {
  groups: RibbonGroup[];
}
export type RibbonBindings = Record<string, { ribbons?: Record<string, string>; controls?: Record<string, string> }>;
export interface RequestRibbonState {
  id: string; ribbons: RibbonDefinition[]; activeRibbonId: string; ribbonBindings: RibbonBindings;
}
export interface RibbonAPI<C extends object, W extends { [P in keyof C]: unknown }, R extends object, A extends object> {
  /** 実行対象リクエストのリボンのID・キー・名前を取得します。 */
  list(): RibbonDescriptor[];
  /** 実行対象リクエストで選択中のリボンを取得します。 */
  active(): RibbonDescriptor | null;
  /** リボンを切り替えます。変更は実行全体の成功時に反映します。 */
  activate(reference: KnownString<keyof R & string>): RibbonDescriptor;
  /** 選択中または指定したリボンの項目を取得します。 */
  controls(): Array<RibbonControlDescriptor<A[keyof A]>>;
  controls<K extends keyof R & string>(reference: K): Array<RibbonControlDescriptor<R[K][keyof R[K]]>>;
  controls(reference: string): RibbonControlDescriptor[];
  /** 項目の値を取得します。同じ実行で設定した値も読み取れます。 */
  get<K extends keyof C & string>(reference: K): C[K];
  get(reference: string): unknown;
  /** 項目の型に合わせて値を設定します。入力の変更処理を再実行しません。 */
  set<K extends keyof C & string, T extends W[K]>(reference: K, value: T): JsonValue extends W[K] ? T : C[K];
  set<T extends JsonValue>(reference: string, value: T): T;
  /** 選択中のリボンの値を項目のキーでまとめて取得します。 */
  values(): A;
  /** 指定したリボンの値を項目のキーでまとめて取得します。 */
  values<K extends keyof R & string>(reference: K): R[K];
  values(reference: string): Record<string, JsonValue>;
  /** 項目の表示を設定します。表示条件がある場合は併せて評価します。 */
  show(reference: KnownString<keyof C & string>, visible?: boolean): boolean;
  /** 項目の有効状態を設定します。有効条件がある場合は併せて評価します。 */
  enable(reference: KnownString<keyof C & string>, enabled?: boolean): boolean;
}
export interface ScriptLibrary<R extends object, I extends { [P in keyof R]: unknown }> {
  /** 保存したスクリプトのIDと名前を取得します。 */
  list(): Array<{ id: ScriptId; name: ScriptName }>;
  get(reference: KnownString<keyof SavedScriptLookup & string> | EntityRef): SavedScript;
  create(spec?: Partial<Omit<SavedScript, 'id'>>): SavedScript;
  update(reference: KnownString<keyof SavedScriptLookup & string> | EntityRef, patch: Partial<Omit<SavedScript, 'id'>>): SavedScript;
  delete(reference: KnownString<keyof SavedScriptLookup & string> | EntityRef): boolean;
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
  header?: VariableRow[]; body?: RequestBody; auth?: { type: string; [key: string]: unknown } | null;
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
export interface RequestDescriptor { id: string; name: string; path: string; collectionId?: string; itemId?: string; draftId?: string; parentId?: string; }
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
  list(): RequestEntry[];
  /** ID、一意の名前またはパスから設定を取得します。 */
  get<K extends keyof RequestLookup & string>(reference: K): RequestLookup[K];
  get(reference: string | EntityRef): RequestEntry;
  create(spec: RequestSpec & { parent: ParentRef }): RequestEntry;
  update(reference: RequestRef, patch: RequestSpec): RequestEntry;
  delete(reference: RequestRef): boolean;
  move(reference: RequestRef, parent: ParentRef): RequestEntry;
  clone(reference: RequestRef, options?: { name?: string; parent?: ParentRef }): RequestEntry;
  /** HTTP処理を一度実行します。送信前後の処理は自動では呼びません。 */
  send(reference: KnownString<keyof RequestLookup & string> | RequestEntry | Request, options?: { environmentId?: KnownString<EnvironmentId>; settings?: RequestSettings }): Promise<ResponseMetadata>;
}
export interface EnvironmentsAPI {
  list(): Environment[];
  get<K extends keyof EnvironmentLookup & string>(idOrName: K): EnvironmentLookup[K];
  get(idOrName: string | EntityRef): Environment;
  create(spec?: { name?: string; values?: VariableRow[] }): Environment;
  update(reference: EnvironmentRef, patch: { name?: string; values?: VariableRow[] }): Environment;
  delete(reference: EnvironmentRef): boolean;
  variables(reference: EnvironmentRef): ModelVariables;
  active(): Environment | null;
  activate(reference: EnvironmentRef | null): string;
}
export interface SavedScript { id: string; name: string; source: string; input: string; inputFormat: 'json' | 'text'; timeoutMs: number; bindingId?: string; }
export interface CollectionItem {
  _mpId: string; name: string; request?: Request; settings?: RequestSettings;
  item?: CollectionItem[]; variable?: VariableRow[]; ribbonState?: RequestRibbonState;
}
export interface EntityRef { id: string; }
export type RequestRef = KnownString<keyof RequestLookup & string> | EntityRef;
export type EnvironmentRef = KnownString<keyof EnvironmentLookup & string> | EntityRef;
export type ParentRef = KnownString<keyof CollectionLookup & string | keyof FolderLookup & string> | EntityRef;
export type DeepPatch<T> = T extends Array<unknown> ? T : T extends object ? { [P in keyof T]?: DeepPatch<T[P]> } : T;
export interface ModelVariables {
  list(): VariableRow[]; get(key: string): string | undefined; has(key: string): boolean;
  set(key: string, value: unknown, metadata?: { enabled?: boolean; disabled?: boolean; description?: string; type?: string }): string;
  unset(key: string): boolean; clear(): number; toObject(): Record<string,string>;
}
export interface EntityAPI<L extends object, T, S> {
  list(): T[];
  get<K extends keyof L & string>(reference: K): L[K];
  get(reference: string | EntityRef): T;
  create(spec?: S): T;
  update(reference: KnownString<keyof L & string> | EntityRef, patch: DeepPatch<S>): T;
  delete(reference: KnownString<keyof L & string> | EntityRef): boolean;
}
export interface Collection { id: string; name: string; _mpId: string; info: { name: string; schema?: string; description?: string }; item: CollectionItem[]; variable?: VariableRow[]; }
export interface CollectionSpec { name?: string; info?: { name?: string; description?: string; schema?: string }; variable?: VariableRow[]; auth?: Request['auth']; }
export interface CollectionsAPI extends EntityAPI<CollectionLookup,Collection,CollectionSpec> { variables(reference: KnownString<keyof CollectionLookup & string> | EntityRef): ModelVariables; }
export interface Folder extends RequestDescriptor { collectionId: string; itemId: string; parentId: string; item: CollectionItem[]; variable?: VariableRow[]; }
export interface FoldersAPI {
  list(): Folder[];
  get<K extends keyof FolderLookup & string>(reference: K): FolderLookup[K]; get(reference: string | EntityRef): Folder;
  create(spec: { parent: ParentRef; name?: string; variable?: VariableRow[]; auth?: Request['auth'] }): Folder;
  update(reference: KnownString<keyof FolderLookup & string> | EntityRef, patch: { name?: string; variable?: VariableRow[]; auth?: Request['auth'] }): Folder;
  delete(reference: KnownString<keyof FolderLookup & string> | EntityRef): boolean;
  move(reference: KnownString<keyof FolderLookup & string> | EntityRef, parent: ParentRef): Folder;
  variables(reference: KnownString<keyof FolderLookup & string> | EntityRef): ModelVariables;
}
export interface RequestSpec { name?: string; request?: DeepPatch<Request>; settings?: RequestSettings; ribbonState?: RequestRibbonState; }
export interface Draft extends RequestEntry { draftId: string; dirty?: boolean; }
export type DraftsAPI = EntityAPI<DraftLookup,Draft,RequestSpec>;
export interface RelationCondition { enabled: boolean; source: 'response' | 'primary' | 'variables' | 'result'; path: string; operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists' | 'missing' | 'truthy' | 'falsy'; value?: string; }
export interface RelationStep {
  id: string; type?: 'request' | 'repeat' | 'forEach' | 'while' | 'if' | 'wait' | 'script' | 'break' | 'continue';
  collectionId?: string; itemId?: string; draftId?: string; repeat?: number; delayMs?: number; intervalMs?: number;
  condition?: RelationCondition; onTrue?: string; onFalse?: string; steps?: RelationStep[]; elseSteps?: RelationStep[];
  source?: 'literal' | 'response' | 'primary' | 'variables' | 'result'; value?: string; path?: string; itemVariable?: string; indexVariable?: string; maxIterations?: number;
  scriptId?: string; inputFormat?: 'saved' | 'json' | 'text' | 'response'; input?: string; resultVariable?: string;
}
export interface Relation { id: string; name: string; repeat: number; intervalMs: number; maxExecutions: number; stopOnError: boolean; steps: RelationStep[]; environmentId?: string; }
export interface RelationRun { id: string; relationId: string; name: string; status: string; startedAt: string; finishedAt?: string; error?: string; entries: Array<{ stepId: string; type: string; status: string; stepPath: string; requestName: string; iteration: number; httpStatus?: number; elapsed_ms?: number; error?: string; result?: unknown }> }
export interface RelationsAPI extends EntityAPI<RelationLookup,Relation,Partial<Omit<Relation,'id'>>> { run(reference: KnownString<keyof RelationLookup & string> | EntityRef, options?: { environmentId?: KnownString<EnvironmentId> }): Promise<RelationRun>; }
export interface RibbonCondition { mode: 'all' | 'any'; rules: Array<{ source: 'ribbon' | 'store' | 'environment' | 'globals' | 'variables'; key: string; operator: 'eq' | 'ne' | 'truthy' | 'falsy' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'empty' | 'notEmpty'; value?: JsonValue }> }
export interface RibbonAction { id: string; type: 'script' | 'set' | 'toggle' | 'activate'; scriptId?: string; target?: string; value?: JsonValue; when?: RibbonCondition | null; }
export interface RibbonControl { id: string; key: string; label: string; type: RibbonControlType; value: JsonValue; options?: Array<{ value: string; label: string }>; visible?: boolean; enabled?: boolean; visibleWhen?: RibbonCondition | null; enabledWhen?: RibbonCondition | null; actions?: RibbonAction[]; }
export interface RibbonGroup { id: string; name: string; controls: RibbonControl[]; }
export type RibbonGroupAPI<L extends object = {}> = EntityAPI<L,RibbonGroup,Partial<Omit<RibbonGroup,'id'>>>;
export type RibbonControlAPI<L extends object = {}> = EntityAPI<L,RibbonControl,Partial<Omit<RibbonControl,'id'>>>;
export interface RibbonsModelAPI extends EntityAPI<RibbonDefinitionLookup,RibbonDefinition,Partial<Omit<RibbonDefinition,'id'>>> {
  forRequest(reference: RequestRef): RibbonsForRequestAPI;
  groups<R extends keyof RibbonGroupsLookup & string>(reference: R): RibbonGroupsLookup[R];
  groups(reference: string | EntityRef): RibbonGroupAPI;
  controls<R extends keyof RibbonControlGroupsLookup & string,G extends keyof RibbonControlGroupsLookup[R] & string>(reference: R, group: G): RibbonControlGroupsLookup[R][G];
  controls(reference: string | EntityRef, group: string | EntityRef): RibbonControlAPI;
}
export interface RibbonsForRequestAPI extends EntityAPI<{},RibbonDefinition,Partial<Omit<RibbonDefinition,'id'>>> {
  forRequest(reference: RequestRef): RibbonsForRequestAPI;
  groups(reference: string | EntityRef): RibbonGroupAPI;
  controls(reference: string | EntityRef, group: string | EntityRef): RibbonControlAPI;
}
export interface WorkspaceSettings { theme?: 'light' | 'dark'; editorSettings?: { tabSize?: number; fontSize?: number; [key: string]: unknown }; settings?: RequestSettings; }
export interface HistoryEntry { id: string; name: string; method?: string; url?: string; status?: number; [key: string]: unknown; }
export interface StoredResponse { id: string; requestId: string; name: string; response: ResponseMetadata; }
export interface Attachment { slot: string; index: number; name: string; type: string; size: number; lastModified: number; }
export interface AttachmentsAPI {
  list(reference?: RequestRef): Promise<Attachment[]>;
  read(reference: RequestRef, slot: string, index: number | undefined, options: { format: 'bytes'; maxBytes?: number }): Promise<number[]>;
  read(reference: RequestRef, slot: string, index?: number, options?: { format?: 'text' | 'base64'; maxBytes?: number }): Promise<string>;
}
export interface Workspace {
  version: number; environmentId: string | null; scripts: SavedScript[]; scriptData: StoreData;
  scriptBindings: Record<string, Record<string, string>>; environments: Environment[]; globals: VariableRow[];
  /** 以前の共通リボンの保管用です。現在の操作対象は各リクエストのribbonStateです。 */
  ribbons: RibbonDefinition[]; activeRibbonId: string; ribbonBindings: RibbonBindings;
  collections: Array<{ _mpId: string; info: { name: string; [key: string]: unknown }; item: CollectionItem[]; variable?: VariableRow[] }>;
  tabs: Array<{ id: string; name: string; request: Request; settings?: RequestSettings; collectionId?: string; itemId?: string; ribbonState?: RequestRibbonState }>;
  history: HistoryEntry[]; relations: Relation[]; relationRuns?: RelationRun[]; revisions?: Record<string, unknown[]>;
  theme?: WorkspaceSettings['theme']; settings?: RequestSettings; editorSettings?: WorkspaceSettings['editorSettings'];
}
export interface MiniPostAPI<R extends object, I extends { [P in keyof R]: unknown }, B> {
  /** 現在の実行が扱うリクエストです。request、pm.requestと同じ変更対象です。 */
  request: CurrentRequest | null;
  /** 現在の実行が扱うレスポンスです。responseと同じ変更対象です。送信前や独立実行ではnullです。 */
  response: CurrentResponse | null;
  collections: CollectionsAPI; folders: FoldersAPI; requests: RequestsAPI; drafts: DraftsAPI;
  environments: EnvironmentsAPI; relations: RelationsAPI; ribbons: RibbonsModelAPI;
  workspace: { read(): Workspace };
  settings: { get(): WorkspaceSettings; get<K extends keyof WorkspaceSettings>(key: K): WorkspaceSettings[K]; update(patch: DeepPatch<WorkspaceSettings>): WorkspaceSettings };
  history: { list(): HistoryEntry[]; get(reference: string | EntityRef): HistoryEntry; delete(reference: string | EntityRef): boolean; clear(): number };
  responses: { list(): Promise<StoredResponse[]>; get(reference?: RequestRef): Promise<StoredResponse | null> };
  attachments: AttachmentsAPI;
  variables: PrimaryVariables; environment: EnvironmentVariables; globals: GlobalVariables;
  scripts: ScriptLibrary<R, I>; store: SharedData<StoreData>; ribbon: B; tools: ScriptTools;
}
`;

function wrapper(source, suffix, declarationPath) {
  const imported = name => `import(${quote(declarationPath)}).${name}`;
  const types = {
    pm:'PostmanAPI', vars:'PrimaryVariables', response:'CurrentResponse | null', request:'CurrentRequest | null',
    console:'ScriptConsole', input:`Input_${suffix}`, scripts:`Scripts_${suffix}`, store:'SharedData<StoreData>', minipost:`MiniPost_${suffix}`, ribbon:`Ribbon_${suffix}`, tools:'ScriptTools'
  };
  const annotations = Object.entries(types).map(([name,type]) => {
    const expanded = type === 'SharedData<StoreData>' ? `${imported('SharedData')}<${imported('StoreData')}>` : imported(type);
    return ` * @param {${expanded}} ${name}`;
  }).join('\n');
  const prefix = `/**\n${annotations}\n */\nexport async function __run(pm, vars, response, request, console, input, scripts, store, minipost, ribbon, tools) {\n{\n`;
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
  const scriptNameCounts=new Map();
  for(const script of scripts)scriptNameCounts.set(script.name,(scriptNameCounts.get(script.name)||0)+1);
  declarations.push(`export type ScriptReference = ScriptId | Exclude<ScriptName, ${literalUnion(['',...[...scriptNameCounts].filter(([,count])=>count>1).map(([name])=>name)])}>;`);
  declarations.push('export type SavedScriptLookup = Record<ScriptReference, SavedScript>;');
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

  // CRUD references are rebuilt from current catalog names. Keep the generated
  // definitions proportional to catalog size rather than copying full trees.
  for (const [property,type] of [['collections','Collection'],['folders','Folder'],['drafts','Draft'],['relations','Relation']]) {
    const entries=(Array.isArray(context[property])?context[property]:property==='drafts'?requests.filter(entry=>entry.draftId):[]).filter(object);
    const references=catalogReferences(entries,entry=>[entry.name,entry.path,entry.itemId,entry.draftId]);
    declarations.push(`export type ${type}Lookup = ${mapType([...references].map(([reference])=>[reference,type]))};`);
  }

  const ribbonCatalogData = ribbonCatalog(context), ribbonValueTypes = new Map(), ribbonWriteTypes = new Map();
  const modelRibbonReferences=catalogReferences(ribbonCatalogData.ribbons,item=>[item.name,item.key]);
  declarations.push(`export type RibbonDefinitionLookup = ${mapType([...modelRibbonReferences].map(([reference])=>[reference,'RibbonDefinition']))};`);
  const ribbonGroupAPIs=new Map(),ribbonControlGroupTypes=new Map();
  for(const [index,ribbon] of ribbonCatalogData.ribbons.entries()) {
    const groups=ribbon.groups||[],groupReferences=catalogReferences(groups,item=>[item.name]);
    const groupLookup=`ModelRibbonGroups_${index}`;
    declarations.push(`export type ${groupLookup} = ${mapType([...groupReferences].map(([reference])=>[reference,'RibbonGroup']))};`);
    ribbonGroupAPIs.set(ribbon,`RibbonGroupAPI<${groupLookup}>`);
    const controlAPIs=new Map();
    for(const [at,group] of groups.entries()) {
      const lookup=`ModelRibbonControls_${index}_${at}`,refs=catalogReferences(group.controls||[],item=>[item.key]);
      declarations.push(`export type ${lookup} = ${mapType([...refs].map(([reference])=>[reference,'RibbonControl']))};`);
      controlAPIs.set(group,`RibbonControlAPI<${lookup}>`);
    }
    const name=`ModelRibbonControlGroups_${index}`;
    declarations.push(`export type ${name} = ${mapType([...groupReferences].map(([reference,group])=>[reference,controlAPIs.get(group)]))};`);
    ribbonControlGroupTypes.set(ribbon,name);
  }
  declarations.push(`export type RibbonGroupsLookup = ${mapType([...modelRibbonReferences].map(([reference,ribbon])=>[reference,ribbonGroupAPIs.get(ribbon)]))};`);
  declarations.push(`export type RibbonControlGroupsLookup = ${mapType([...modelRibbonReferences].map(([reference,ribbon])=>[reference,ribbonControlGroupTypes.get(ribbon)]))};`);
  for (const {control} of ribbonCatalogData.controls) {
    const type = {text:'string',number:'number | null',toggle:'boolean',select:'string'}[control.type] || reader.shape(control.value);
    ribbonValueTypes.set(control,type);
    ribbonWriteTypes.set(control,{text:'string | number | boolean | null',number:'number | string | null',toggle:'boolean',select:'string'}[control.type] || 'JsonValue');
  }
  const ribbonTypes = new Map(ribbonCatalogData.ribbons.map((ribbon,index) => {
    const name = `RibbonValues_${index}`;
    declarations.push(`export type ${name} = ${mapType(ribbonCatalogData.controls.filter(row => row.ribbon === ribbon)
      .map(({control}) => [control.key,ribbonValueTypes.get(control)]))};`);
    return [ribbon,name];
  }));
  const activeRibbon = ribbonCatalogData.ribbons.find(ribbon => ribbon.id === context.activeRibbonId);
  declarations.push(`export type ActiveRibbonValues = ${ribbonTypes.get(activeRibbon) || '{}'};`);

  const groups = new Map(), ribbonGroups = new Map();
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
    const ribbonBinding = callerBinding(context,caller,'ribbonBindings');
    if (!ribbonGroups.has(ribbonBinding)) {
      const group = ribbonGroups.size; ribbonGroups.set(ribbonBinding,group);
      const references = ribbonCatalogData.references(ribbonBinding);
      declarations.push(`export type RibbonReadGroup_${group} = ${mapType([...references.controls].map(([reference,{control}]) => [reference,ribbonValueTypes.get(control)]))};`);
      declarations.push(`export type RibbonWriteGroup_${group} = ${mapType([...references.controls].map(([reference,{control}]) => [reference,ribbonWriteTypes.get(control)]))};`);
      declarations.push(`export type RibbonLookupGroup_${group} = ${mapType([...references.ribbons].map(([reference,ribbon]) => [reference,ribbonTypes.get(ribbon)]))};`);
      declarations.push(`export type RibbonGroup_${group} = RibbonAPI<RibbonReadGroup_${group}, RibbonWriteGroup_${group}, RibbonLookupGroup_${group}, ActiveRibbonValues>;`);
    }
    const ribbonGroup = ribbonGroups.get(ribbonBinding);
    declarations.push(`export type Ribbon_${suffix} = RibbonGroup_${ribbonGroup};`);
    declarations.push(`export type MiniPost_${suffix} = MiniPostAPI<Results_${suffix}, Inputs_${suffix}, Ribbon_${suffix}>;`);
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
