/** Session-only attachments. Row identity, not a changing row index, owns bytes. */
const abortError = () => new DOMException('ファイルの読込待機を中止しました。', 'AbortError');
export async function encodeFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks = [];
  for (let at = 0; at < bytes.length; at += 32768) chunks.push(String.fromCharCode(...bytes.subarray(at, at + 32768)));
  return {name: file.name, type: file.type || 'application/octet-stream', size: bytes.length, data: btoa(chunks.join(''))};
}
function waitFor(promise, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => {signal.removeEventListener('abort', abort); reject(abortError());};
    signal.addEventListener('abort', abort, {once: true});
    promise.then(value => {signal.removeEventListener('abort', abort); resolve(value);}, error => {signal.removeEventListener('abort', abort); reject(error);});
  });
}
export class RequestFiles {
  constructor() {this.requests = new Map();}
  get(id, slot) {return this.requests.get(id)?.get(slot);}
  delete(id) {this.requests.delete(id);}
  clear() {this.requests.clear();}
  remove(id, slot) {this.requests.get(id)?.delete(slot);}
  copyRow(id, source, destination) {
    const entry = this.get(id, source);
    if (entry?.status === 'ready') this.requests.get(id).set(destination, {status: 'ready', files: entry.files.map(file => ({...file}))});
  }
  async select(id, slot, files, {valid = () => true, onReady = () => {}, onChange = () => {}, read = encodeFile} = {}) {
    if (!files.length) return false; // Cancelling the chooser retains its selection.
    let bucket = this.requests.get(id);
    if (!bucket) this.requests.set(id, bucket = new Map());
    const entry = {status: 'loading', files: [], error: null};
    bucket.set(slot, entry); // Never fall back to the previous file while replacing it.
    const current = () => this.requests.get(id) === bucket && bucket.get(slot) === entry && valid();
    // Install the promise before notifying UI; Send can be pressed at any time.
    entry.pending = Promise.resolve().then(() => Promise.all(files.map(read))).then(encoded => {
      if (!current()) return false;
      entry.files = encoded; entry.status = 'ready';
      onReady(encoded); return true;
    }).catch(error => {
      if (current()) {entry.status = 'error'; entry.error = error;}
      return false;
    }).finally(() => {entry.pending = null; if (current()) onChange(); else if (bucket.get(slot) === entry) bucket.delete(slot);});
    onChange();
    return entry.pending;
  }
  async snapshot(id, body, {signal} = {}) {
    const slots = !body || body.disabled ? [] : body.mode === 'file' ? [['binary', 'binary']] : body.mode === 'formdata' ?
      (body.formdata || []).flatMap((row, index) => row && row.type === 'file' && row.key && row.disabled !== true && row.enabled !== false ? [[`form-${index}`, row]] : []) : [];
    // A newer selection may supersede a pending read. Re-evaluate after every wait.
    for (;;) {
      if (signal?.aborted) throw abortError();
      const pending = slots.map(([, slot]) => this.get(id, slot)?.pending).filter(Boolean);
      if (!pending.length) break;
      await waitFor(Promise.all(pending), signal);
    }
    const result = {};
    for (const [key, slot] of slots) {
      const entry = this.get(id, slot);
      if (entry?.status === 'error') throw new Error('ファイルを読み込めません。選び直してください: ' + (entry.error?.message || '読込失敗'));
      if (entry?.status === 'ready') result[key] = entry.files.map(file => ({...file}));
    }
    return result;
  }
}
