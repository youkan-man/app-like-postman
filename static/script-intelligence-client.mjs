/** Shared, lazy language Worker. Pending edits are coalesced before analysis. */
let worker = null, requestId = 0, ownerId = 0, active = null;
const queue = [];
const stopped = () => new DOMException('解析要求を更新しました。', 'AbortError');

function settle(job, error, result) {
  if (job.settled) return;
  job.settled = true;
  if (error) job.reject(error); else job.resolve(result);
}

function fail(error) {
  const current = worker; worker = null;
  if (current) current.terminate();
  if (active) {clearTimeout(active.timer); settle(active, error); active = null;}
  for (const job of queue.splice(0)) settle(job, error);
}

function getWorker() {
  if (worker) return worker;
  if (typeof Worker !== 'function') throw new Error('このブラウザーではコード解析を開始できません。');
  const instance = new Worker(new URL('./script-intelligence-worker.mjs', import.meta.url), {type:'module'});
  instance.addEventListener('message', ({data}) => {
    if (worker !== instance || !active || data?.id !== active.id) return;
    const job = active; active = null; clearTimeout(job.timer);
    settle(job, data.error ? new Error(data.error.message || String(data.error)) : null, data.result);
    dispatch();
  });
  instance.addEventListener('error', event => {
    if (worker !== instance) return;
    event.preventDefault();
    fail(new Error(event.message || 'コード解析を読み込めませんでした。'));
  });
  instance.addEventListener('messageerror', () => {
    if (worker === instance) fail(new Error('コード解析の応答を読み取れませんでした。'));
  });
  worker = instance;
  return instance;
}

function dispatch() {
  if (active || !queue.length) return;
  active = queue.shift();
  try {
    const instance = getWorker(), job = active;
    // A broken Worker must not leave the editor in a permanent loading state.
    job.timer = setTimeout(() => {
      if (active === job) fail(new Error('コード解析が応答しません。もう一度お試しください。'));
    }, 30000);
    instance.postMessage(job.message);
  } catch (error) { fail(error); }
}

function cancel(owner) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].owner === owner) settle(queue.splice(i, 1)[0], stopped());
  }
  // Let an in-flight parse finish so the shared compiler can reuse its AST.
  // Its result is discarded; only the latest waiting edit will be dispatched.
  if (active?.owner === owner) settle(active, stopped());
}

export function createScriptIntelligenceClient() {
  const owner = ++ownerId;
  let disposed = false;
  function request(method, source, position, options, name) {
    if (disposed) return Promise.reject(stopped());
    cancel(owner);
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      queue.push({id,owner,resolve,reject,settled:false,message:{id,method,source,position,options,name}});
      dispatch();
    });
  }
  return {
    analyze:(source,position,options={}) => request('analyze',source,position,options),
    details:(source,position,name,options={}) => request('details',source,position,options,name),
    cancel:() => cancel(owner),
    dispose(){disposed = true; cancel(owner);}
  };
}
