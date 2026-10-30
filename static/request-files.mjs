/** Session-only attachments. File bytes never enter workspace JSON or revisions. */
const aborted = () => new DOMException('ファイルの読込・送信を停止しました。', 'AbortError');
function check(signal) {if (signal?.aborted) throw aborted();}
export function waitForFile(task, signal) {
  check(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => {cleanup(); reject(aborted());};
    const cleanup = () => signal?.removeEventListener('abort', cancel);
    signal?.addEventListener('abort', cancel, {once: true});
    Promise.resolve(task).then(value => {cleanup(); resolve(value);}, error => {cleanup(); reject(error);});
  });
}
export async function readSelectedFile(file, signal) {
  check(signal);
  if (!(file instanceof Blob)) throw new TypeError('ファイルを選び直してください。');
  // A bounded readability probe, not a copy of the entire file. Keep the
  // immutable File/Blob handle for native, slice-based upload at Send time.
  const probe = file.size <= 65536 ? file : file.slice(0, 65536);
  await waitForFile(probe.arrayBuffer(), signal);
  check(signal);
  return {name: file.name || 'blob', type: file.type || 'application/octet-stream', size: file.size,
    lastModified: file.lastModified || 0, blob: file};
}
function fileKeys(request) {
  const body = request?.body;
  if (body?.disabled) return [];
  if (body?.mode === 'file') return ['binary'];
  if (body?.mode !== 'formdata') return [];
  return (body.formdata || []).flatMap((row, index) => row?.key && row.type === 'file' &&
    row.disabled !== true && row.enabled !== false ? [`form-${index}`] : []);
}
export class RequestFiles {
  constructor({read = readSelectedFile} = {}) {this.entries = new Map(); this.readFile = read;}
  get(id) {
    const slots = this.entries.get(id);
    return slots ? Object.fromEntries([...slots].filter(([,slot]) => slot.state === 'ready').map(([key,slot]) => [key, slot.files])) : undefined;
  }
  describe(id, key) {return this.entries.get(id)?.get(key);}
  keyOf(id, slot) {return [...(this.entries.get(id) || [])].find(([,value]) => value === slot)?.[0];}
  remove(id, key) {
    const slots = this.entries.get(id), slot = slots?.get(key);
    if (slot) {slot.controller.abort(); slots.delete(key);}
  }
  delete(id) {for (const slot of this.entries.get(id)?.values() || []) slot.controller.abort(); this.entries.delete(id);}
  clear() {for (const id of this.entries.keys()) this.delete(id);}
  /** Move both completed and in-flight selections together with their row. */
  spliceRows(id, at, removed, added) {
    const slots = this.entries.get(id); if (!slots) return;
    const next = new Map();
    for (const [key,slot] of slots) {
      const match = /^form-(\d+)$/.exec(key);
      if (!match) {next.set(key,slot); continue;}
      const index = Number(match[1]);
      if (index >= at && index < at + removed) {slot.controller.abort(); continue;}
      next.set(`form-${index < at ? index : index - removed + added}`, slot);
    }
    this.entries.set(id, next);
  }
  /** Latest selection wins. A cancelled chooser never calls this method. */
  read(id, key, files) {
    if (!files.length) return Promise.resolve(null);
    this.remove(id, key);
    let slots = this.entries.get(id); if (!slots) this.entries.set(id, slots = new Map());
    const slot = {state: 'loading', names: files.map(file => file.name), files: [], error: null, controller: new AbortController()};
    slots.set(key, slot);
    slot.done = Promise.all(files.map(file => this.readFile(file, slot.controller.signal))).then(values => {
      if (this.keyOf(id, slot) === undefined || slot.controller.signal.aborted) return null;
      slot.files = values; slot.state = 'ready'; return slot;
    }, error => {
      if (this.keyOf(id, slot) === undefined || slot.controller.signal.aborted) return null;
      slot.error = error; slot.state = 'error'; return slot;
    });
    return slot.done;
  }
  /** Capture at Send, then await only reads already selected at that moment.
   * No later picker, script wait or row edit can silently change these bytes.
   */
  async snapshot(id, request, signal) {
    check(signal);
    const captured = fileKeys(request).map(key => {
      const slot = this.entries.get(id)?.get(key);
      return {key, slot, files: slot?.state === 'ready' ? slot.files.map(file => ({...file})) : null};
    });
    const output = {};
    for (const item of captured) {
      if (!item.slot) continue; // compileRequest reports the missing file name.
      if (!item.files) {
        await waitForFile(item.slot.done, signal); check(signal);
        if (this.entries.get(id)?.get(item.key) !== item.slot)
          throw new Error('送信待機中にファイルの選択または行が変更されました。内容を確認して再送信してください。');
        if (item.slot.state !== 'ready')
          throw new Error(`ファイル「${item.slot.names.join(', ')}」を読み込めません: ${item.slot.error?.message || '再選択してください。'}`);
        item.files = item.slot.files.map(file => ({...file}));
      }
      output[item.key] = item.files;
    }
    check(signal); return output;
  }
}

/** Snapshot descriptors without JSON-stringifying immutable Blob handles. */
export function copyAttachments(files = {}) {
  return Object.fromEntries(Object.entries(files).map(([key, entries]) => [key, entries.map(file => ({...file}))]));
}
