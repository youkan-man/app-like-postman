/** Lossless server snapshots. Serialize before yielding so later edits stay local. */
import {MAX_WORKSPACE_BYTES, packWorkspaceBundle} from './workspace-codec.mjs';

export const WORKSPACE_ACCEPT = 'application/vnd.minipost.workspace.packed+json';
const COMPRESSION_THRESHOLD = 32 * 1024;

export async function prepareWorkspaceUpload(bundle, {compressionStream = globalThis.CompressionStream} = {}) {
  // Pool repeated request bodies, script source and history subtrees first.
  // gzip alone cannot share identical data farther apart than its window.
  const body = JSON.stringify(packWorkspaceBundle(bundle));
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength > MAX_WORKSPACE_BYTES) throw new Error('保存データは256 MiB以下にしてください。');
  const headers = {'Content-Type': 'application/json'};
  if (bytes.byteLength >= COMPRESSION_THRESHOLD && typeof compressionStream === 'function') {
    try {
      const compressed = await new Response(new Blob([bytes]).stream().pipeThrough(new compressionStream('gzip'))).arrayBuffer();
      if (compressed.byteLength < bytes.byteLength) return {headers: {...headers, 'Content-Encoding': 'gzip'}, body: compressed};
    } catch {
      // Pooling remains effective in browsers without working compression.
    }
  }
  return {headers, body};
}
