/** Lossless, versioned pooling for workspace archives. No user data is discarded. */
export const MAX_WORKSPACE_BYTES = 256 * 1024 * 1024;
export const PACKED_WORKSPACE_KIND = 'minipost.workspace.packed';
const MAX_DEPTH = 256;
const OMIT = Symbol('omit-json-value');
const encoder = new TextEncoder();
const jsonBytes = value => encoder.encode(JSON.stringify(value)).byteLength;
const invalid = () => new TypeError('保存データの圧縮形式が不正です。');
const tooLarge = () => new RangeError('展開後の保存データがサイズ上限を超えています。');
const tooDeep = () => new RangeError('保存データの階層が深すぎます。');

function byteLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('保存データのサイズ上限が不正です。');
  return value;
}

function addBytes(total, count, maxBytes) {
  // Subtract before adding so a crafted DAG cannot overflow the size counter.
  if (count > maxBytes - total) throw tooLarge();
  return total + count;
}

export function isPackedWorkspaceBundle(input) {
  return Boolean(input && typeof input === 'object' && !Array.isArray(input) && input.kind === PACKED_WORKSPACE_KIND);
}

/**
 * Each container refers only to preceding nodes. Identical strings and entire
 * unchanged subtrees are stored once, including copies in distant revisions.
 * Small archives keep the ordinary JSON format when pooling would add bytes.
 */
export function packWorkspaceBundle(bundle, {maxBytes = MAX_WORKSPACE_BYTES} = {}) {
  maxBytes = byteLimit(maxBytes);
  const nodes = [], costs = [], depths = [];
  const primitives = new Map(), containers = new Map(), keyCosts = new Map();
  const ancestors = new Set();
  let wireBytes = 0;

  function primitive(value) {
    if (primitives.has(value)) return primitives.get(value);
    const size = jsonBytes(value);
    if (size > maxBytes) throw tooLarge();
    const index = nodes.length;
    nodes.push(value); costs.push(size); depths.push(0); primitives.set(value, index);
    wireBytes += size;
    return index;
  }

  function visit(value, key, depth) {
    // Match JSON.stringify's usual value rules, including toJSON, sparse arrays,
    // omitted object properties, boxed primitives and non-finite numbers.
    if ((value !== null && typeof value === 'object') || typeof value === 'bigint') {
      if (typeof value.toJSON === 'function') value = value.toJSON(key);
    }
    if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
    if (typeof value === 'number') value = Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return primitive(value);
    if (['undefined', 'function', 'symbol'].includes(typeof value)) return OMIT;
    if (typeof value === 'bigint' || Object.prototype.toString.call(value) === '[object BigInt]')
      throw new TypeError('BigIntはJSON形式で保存できません。');
    if (++depth > MAX_DEPTH) throw tooDeep();
    if (ancestors.has(value)) throw new TypeError('循環参照を含むデータは保存できません。');
    ancestors.add(value);
    const array = Array.isArray(value), entries = [];
    let size = 2, nodeDepth = 1, count = 0;
    try {
      const keys = array ? null : Object.keys(value);
      const length = array ? value.length : keys.length;
      for (let at = 0; at < length; at++) {
        const childKey = array ? String(at) : keys[at];
        let child = visit(value[childKey], childKey, depth);
        if (child === OMIT) {
          if (!array) continue;
          child = primitive(null);
        }
        if (count++) size = addBytes(size, 1, maxBytes);
        if (!array) {
          if (!keyCosts.has(childKey)) keyCosts.set(childKey, jsonBytes(childKey));
          size = addBytes(size, keyCosts.get(childKey) + 1, maxBytes);
          entries.push(childKey);
        }
        size = addBytes(size, costs[child], maxBytes);
        nodeDepth = Math.max(nodeDepth, depths[child] + 1);
        entries.push(child);
      }
    } finally {
      ancestors.delete(value);
    }
    if (size > maxBytes) throw tooLarge();
    const node = [array ? 'a' : 'o', entries], signature = JSON.stringify(node);
    if (containers.has(signature)) return containers.get(signature);
    const index = nodes.length;
    nodes.push(node); costs.push(size); depths.push(nodeDepth); containers.set(signature, index);
    wireBytes += encoder.encode(signature).byteLength;
    return index;
  }

  const root = visit(bundle, '', 0);
  if (root === OMIT) throw new TypeError('JSON形式の保存データを指定してください。');
  const packed = {kind: PACKED_WORKSPACE_KIND, version: 1, root, nodes};
  const packedBytes = jsonBytes({...packed, nodes: []}) + wireBytes + Math.max(0, nodes.length - 1);
  return packedBytes < costs[root] ? packed : bundle;
}

/**
 * Validate and measure the complete DAG before allocating any expanded arrays
 * or objects. A reference is expanded afresh each time: saved histories must
 * remain independent editable snapshots after a round trip.
 */
export function unpackWorkspaceBundle(input, {maxBytes = MAX_WORKSPACE_BYTES} = {}) {
  maxBytes = byteLimit(maxBytes);
  if (!isPackedWorkspaceBundle(input)) return input;
  const {version, root, nodes} = input;
  if (version !== 1 || !Array.isArray(nodes) || !nodes.length ||
      !Number.isSafeInteger(root) || root < 0 || root >= nodes.length) throw invalid();
  const costs = new Float64Array(nodes.length), depths = new Uint16Array(nodes.length);
  const keyCosts = new Map();
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node === null || typeof node === 'string' || typeof node === 'boolean' ||
        (typeof node === 'number' && Number.isFinite(node))) {
      const size = jsonBytes(node);
      if (size > maxBytes) throw tooLarge();
      costs[index] = size;
      continue;
    }
    if (!Array.isArray(node) || node.length !== 2 || !['a', 'o'].includes(node[0]) || !Array.isArray(node[1])) throw invalid();
    const object = node[0] === 'o', entries = node[1], step = object ? 2 : 1, keys = object ? new Set() : null;
    if (object && entries.length % 2) throw invalid();
    let size = 2, depth = 1;
    for (let at = 0; at < entries.length; at += step) {
      if (at) size = addBytes(size, 1, maxBytes);
      if (object) {
        const key = entries[at];
        if (typeof key !== 'string' || keys.has(key)) throw invalid();
        keys.add(key);
        if (!keyCosts.has(key)) keyCosts.set(key, jsonBytes(key));
        size = addBytes(size, keyCosts.get(key) + 1, maxBytes);
      }
      const reference = entries[at + step - 1];
      if (!Number.isSafeInteger(reference) || reference < 0 || reference >= index) throw invalid();
      size = addBytes(size, costs[reference], maxBytes);
      depth = Math.max(depth, depths[reference] + 1);
    }
    if (size > maxBytes) throw tooLarge();
    if (depth > MAX_DEPTH) throw tooDeep();
    costs[index] = size; depths[index] = depth;
  }

  function expand(index) {
    const node = nodes[index];
    if (!Array.isArray(node)) return typeof node === 'number' && node === 0 ? 0 : node;
    const [type, entries] = node;
    if (type === 'a') return entries.map(expand);
    const value = {};
    for (let at = 0; at < entries.length; at += 2) {
      // Define an own data property even for __proto__ and inherited setters.
      Object.defineProperty(value, entries[at], {
        value: expand(entries[at + 1]), enumerable: true, writable: true, configurable: true
      });
    }
    return value;
  }
  return expand(root);
}
