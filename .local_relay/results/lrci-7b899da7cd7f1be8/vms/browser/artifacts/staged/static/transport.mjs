import {uploadPlan, uploadFiles} from './upload-transport.mjs';
import {watchTransferProgress} from './transfer-monitor.mjs';
/** Distinguish a reverse-proxy HTML 502 from a MiniPost JSON failure. No retries. */
async function callProxy(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const failure = new Error('MiniPostへの接続に失敗しました。ブラウザとMiniPost間の接続・入口プロキシを確認してください。');
    failure.title = 'ERROR · MiniPost接続'; throw failure;
  }
  if (path === '/api/uploads' && response.status === 404) {
    throw new Error('MiniPostのバックエンドが大容量転送に未対応です。バックエンドも更新してください。');
  }
  const text = await response.text();
  let result;
  try {result = JSON.parse(text);} catch {}
  if (!result || typeof result.ok !== 'boolean') {
    const error = new Error(`入口 HTTP ${response.status}：MiniPostのJSON応答を取得できませんでした。\nリバースプロキシの接続先・タイムアウトとMiniPostの起動状態を確認してください。送信先APIの応答とは区別してください。`);
    error.title = `ERROR · 入口 HTTP ${response.status}`; throw error;
  }
  if (!response.ok || !result.ok) {
    const error = new Error(String(result.error || `MiniPost HTTP ${response.status}`));
    error.title = `ERROR · MiniPost ${response.status}${result.diagnostic?.code ? ' · ' + result.diagnostic.code : ''}`;
    throw error;
  }
  return result;
}

export async function sendThroughProxy(payload, signal, onProgress) {
  const staged = await uploadFiles(uploadPlan(payload), signal, callProxy, onProgress);
  onProgress?.({phase: 'send'});
  const stop = watchTransferProgress(staged.progress, signal, onProgress);
  try {
    return await callProxy('/api/request', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(staged.request), signal});
  } finally {stop(); await staged.release();}
}
