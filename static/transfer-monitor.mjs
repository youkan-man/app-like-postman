/** Optional, bounded telemetry. Losing it must never retry or fail a real request. */
export function watchTransferProgress(endpoint, signal, onProgress, {intervalMs = 400, timeoutMs = 2000} = {}) {
  if (!endpoint || typeof onProgress !== 'function' || signal?.aborted) return () => {};
  let stopped = false, timer, current, phase = 'send';
  const stop = () => {
    if (stopped) return; stopped = true; clearTimeout(timer); current?.abort();
    signal?.removeEventListener('abort', stop);
  };
  signal?.addEventListener('abort', stop, {once:true});
  const tick = async () => {
    if (stopped) return;
    const controller = new AbortController(); current = controller;
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {cache:'no-store', signal:controller.signal, headers:{Accept:'application/json'}});
      if (stopped) return;
      // A consumed/expired session is normal; the real request owns its result.
      if ([404,405].includes(response.status)) {stop();return;}
      if (!response.ok) throw new Error('Progress unavailable');
      const result = await response.json();
      if (!stopped && result.ok && ['send','waiting'].includes(result.progress?.phase)) {
        phase = result.progress.phase; onProgress(result.progress);
      }
    } catch {
      // No invented percentage while the telemetry path is unavailable.
      if (!stopped) onProgress({phase});
    } finally {
      clearTimeout(deadline); if (current === controller) current = null;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };
  void tick(); return stop;
}
