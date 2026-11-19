/** Explicit JavaScript execution in an opaque-origin, network-denied Worker. */
import {executeScript} from './script-worker.mjs';

const workerSource = `
const executeScript = ${executeScript.toString()};
const pendingCalls = new Map();
let callId = 0, started = false;
self.onmessage = async ({data}) => {
  if (data?.type === 'call-result') {
    const pending = pendingCalls.get(data.id);
    if (!pending) return;
    pendingCalls.delete(data.id);
    if (data.ok) pending.resolve(data.value);
    else { const error = new Error(data.error || '操作を実行できません。'); error.name = data.name || 'Error'; pending.reject(error); }
    return;
  }
  if (data?.type !== 'start' || started) return;
  started = true;
  try {
    const result = await executeScript(data.source, data.context, {
      onLog:log => self.postMessage({type:'log', log}),
      onCall:(method, args, {variables}) => new Promise((resolve, reject) => {
        const id = ++callId; pendingCalls.set(id, {resolve, reject});
        try { self.postMessage({type:'call', id, method, args, variables}); }
        catch (error) { pendingCalls.delete(id); reject(error); }
      })
    });
    self.postMessage({type:'result', result});
  } catch (error) {
    self.postMessage({type:'result', result:{ok:false, error:String(error?.message || error), name:error?.name, stack:error?.stack, logs:error?.logs || []}});
  }
};`;

const bridgeSource = `
let active = null, channel = null;
addEventListener('message', event => {
  if (event.source !== parent) return;
  const data = event.data;
  if (data?.channel === channel && data.abort) { active?.terminate(); active = null; return; }
  if (data?.channel === channel && data.type === 'call-result') { active?.postMessage(data); return; }
  if (active || data?.type !== 'start') return;
  channel = data.channel;
  const url = URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}], {type:'text/javascript'}));
  try {
    active = new Worker(url); URL.revokeObjectURL(url);
    active.onmessage = event => {
      parent.postMessage({channel, ...event.data}, '*');
      if (event.data?.type === 'result') { active?.terminate(); active = null; }
    };
    active.onerror = event => {
      parent.postMessage({channel, type:'result', result:{ok:false, error:event.message}}, '*');
      active?.terminate(); active = null;
    };
    active.postMessage({type:'start', source:data.source, context:data.context});
  } catch (error) {
    URL.revokeObjectURL(url);
    parent.postMessage({channel, type:'result', result:{ok:false, error:String(error.message)}}, '*');
    active?.terminate(); active = null;
  }
});
parent.postMessage({ready:true}, '*');`;

export function runScript(source, context = {}, {signal, timeoutMs = 5000, onLog, onCall} = {}) {
  if (signal?.aborted) {
    const error = new DOMException('スクリプトを停止しました。', 'AbortError'); error.logs = [];
    return Promise.reject(error);
  }
  if (!String(source || '').trim()) return Promise.resolve({ok:true, result:undefined, writes:{primary:[], environment:[], globals:[]}, dataWrites:[], ribbonWrites:[], logs:[]});
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    const channel = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
    const calls = new AbortController(), logs = [], seenCalls = new Set();
    frame.className = 'script-sandbox'; frame.hidden = true; frame.title = 'スクリプト実行'; frame.setAttribute('sandbox', 'allow-scripts');
    let settled = false, started = false, timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      window.removeEventListener('message', receive); signal?.removeEventListener('abort', abort);
      calls.abort();
      try { frame.contentWindow?.postMessage({channel, abort:true}, '*'); } catch {}
      frame.remove();
      if (error) { error.logs = error.logs?.length ? error.logs : logs.slice(); reject(error); }
      else resolve(value);
    };
    const abort = () => finish(new DOMException('スクリプトを停止しました。', 'AbortError'));
    const answerCall = async data => {
      if (seenCalls.has(data.id)) return;
      seenCalls.add(data.id);
      let reply;
      try {
        if (typeof onCall !== 'function') throw new Error(`この実行環境では ${data.method} を利用できません。`);
        if (!Array.isArray(data.args)) throw new Error('スクリプトの操作引数が不正です。');
        const value = await onCall(data.method, data.args, {signal:calls.signal, variables:data.variables});
        reply = {ok:true, value};
      } catch (error) { reply = {ok:false, error:String(error?.message || error), name:error?.name || 'Error'}; }
      if (settled) return;
      try { frame.contentWindow?.postMessage({channel, type:'call-result', id:data.id, ...reply}, '*'); }
      catch (error) {
        try { frame.contentWindow?.postMessage({channel, type:'call-result', id:data.id, ok:false, error:String(error.message)}, '*'); }
        catch (failure) { finish(failure); }
      }
    };
    const receive = event => {
      if (settled || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (data?.ready && !started) {
        started = true;
        try { frame.contentWindow.postMessage({channel, type:'start', source:String(source), context}, '*'); }
        catch (error) { finish(error); }
        return;
      }
      if (data?.channel !== channel) return;
      if (data.type === 'log') {
        if (!data.log || typeof data.log.message !== 'string') return;
        logs.push(data.log);
        try { const pending = onLog?.(structuredClone(data.log)); pending?.catch?.(() => {}); } catch {}
        return;
      }
      if (data.type === 'call') { void answerCall(data); return; }
      if (data.type !== 'result') return;
      const result = data.result;
      if (!result?.ok) {
        const error = new Error(result?.error || 'スクリプトを実行できません。');
        error.name = result?.name || 'Error'; error.logs = result?.logs || logs;
        if (result?.stack) error.stack = result.stack;
        finish(error);
      } else if (!result.writes || !['primary', 'environment', 'globals'].every(key => Array.isArray(result.writes[key])) || !Array.isArray(result.dataWrites) || (result.ribbonWrites !== undefined && !Array.isArray(result.ribbonWrites)) || !Array.isArray(result.logs)) {
        finish(new Error('スクリプトの結果形式が不正です。'));
      } else finish(null, result);
    };
    window.addEventListener('message', receive); signal?.addEventListener('abort', abort, {once:true});
    if (timeoutMs > 0) timer = setTimeout(() => finish(new Error(`スクリプトが${timeoutMs} msの制限時間を超えました。`)), timeoutMs);
    frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; connect-src 'none';"><script>${bridgeSource.replace(/<\/script/gi, '<\\/script')}<\/script>`;
    document.body.append(frame);
  });
}
