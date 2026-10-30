/** Transfer file-backed Blobs without Base64, JSON copies or full-buffer reads. */
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
const blob = value => typeof Blob !== 'undefined' && value instanceof Blob;

export function uploadPlan(payload) {
  const request = {...payload}, files = [];
  const add = file => {if (!blob(file)) throw new TypeError('添付ファイルを選び直してください。');files.push(file);return files.length - 1;};
  if (Object.hasOwn(request, 'body_file')) {request.body_upload = add(request.body_file);delete request.body_file;}
  if (request.multipart) request.multipart = request.multipart.map(part => {
    const next = {...part};
    if (Object.hasOwn(next, 'file')) {next.upload = add(next.file);delete next.file;}
    return next;
  });
  return {request, files};
}

export async function uploadFiles(plan, signal, call, onProgress = () => {}) {
  if (!plan.files.length) return {request: plan.request, release: async () => {}};
  if (signal?.aborted) throw new DOMException('送信を停止しました。', 'AbortError');
  const created = await call('/api/uploads', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({sizes: plan.files.map(file => file.size)}), signal});
  if (!/^[a-f0-9]{64}$/.test(created.upload_id) || !Number.isSafeInteger(created.chunk_bytes) || created.chunk_bytes < 1) {
    throw new Error('大容量転送に対応したMiniPostバックエンドへ更新してください。');
  }
  const endpoint = '/api/uploads/' + created.upload_id;
  let released = false;
  const release = async () => {
    if (released) return;released = true;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
    try {await fetch(endpoint, {method: 'DELETE', signal: controller.signal, keepalive: true});}
    catch {} finally {clearTimeout(timer);}
  };
  try {
    const chunkBytes = Math.min(UPLOAD_CHUNK_BYTES, created.chunk_bytes);
    const total = plan.files.reduce((sum, file) => sum + file.size, 0);
    let completed = 0;
    onProgress({phase: 'upload', completed, total});
    for (const [index, file] of plan.files.entries()) {
      for (let offset = 0; offset < file.size; offset += chunkBytes) {
        if (signal?.aborted) throw new DOMException('送信を停止しました。', 'AbortError');
        const end = Math.min(offset + chunkBytes, file.size);
        const result = await call(`${endpoint}/${index}`, {method: 'POST',
          headers: {'Content-Type': 'application/octet-stream', 'X-MiniPost-Offset': String(offset)},
          body: file.slice(offset, end), signal});
        if (result.offset !== end) throw new Error('ファイルの転送位置が一致しません。送信していません。');
        completed += end - offset;onProgress({phase: 'upload', completed, total});
      }
    }
    onProgress({phase: 'send'});
    return {request: {...plan.request, upload_id: created.upload_id}, release,
      progress: created.progress === true ? endpoint + '/progress' : null};
  } catch (error) {await release();throw error;}
}
