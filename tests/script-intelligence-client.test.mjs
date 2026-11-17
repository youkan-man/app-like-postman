import test from 'node:test';
import assert from 'node:assert/strict';

test('language Worker transport coalesces edits, isolates editor cancellation and recovers after load errors', async () => {
  const previous = globalThis.Worker;
  class FakeWorker {
    static instances = [];
    constructor(url, options) {
      this.url = String(url); this.options = options; this.listeners = new Map(); this.messages = [];
      FakeWorker.instances.push(this);
    }
    addEventListener(name, listener) {this.listeners.set(name, listener);}
    postMessage(message) {this.messages.push(message);}
    terminate() {this.terminated = true;}
    reply(result) {this.listeners.get('message')({data:{id:this.messages.at(-1).id,result}});}
    error(message) {
      const event = {message,preventDefault(){this.prevented = true;}};
      this.listeners.get('error')(event); return event;
    }
  }
  globalThis.Worker = FakeWorker;
  try {
    const {createScriptIntelligenceClient} = await import('../static/script-intelligence-client.mjs');
    const first = createScriptIntelligenceClient(), second = createScriptIntelligenceClient();
    assert.equal(FakeWorker.instances.length, 0, 'creating editors does not load the compiler');

    const old = first.analyze('old', 3);
    const oldStopped = assert.rejects(old, {name:'AbortError'});
    const replaced = first.analyze('intermediate', 12);
    const replacedStopped = assert.rejects(replaced, {name:'AbortError'});
    const latest = first.analyze('latest', 6, {explicit:true,context:{input:{value:1}}});
    const worker = FakeWorker.instances[0];
    assert.match(worker.url, /script-intelligence-worker\.mjs$/);
    assert.equal(worker.options.type, 'module');
    assert.deepEqual(worker.messages.map(message => message.source), ['old']);
    await Promise.all([oldStopped,replacedStopped]);
    worker.reply({completion:{items:[{label:'stale'}]}});
    assert.deepEqual(worker.messages.map(message => message.source), ['old','latest']);
    assert.equal(worker.messages.at(-1).options.explicit, true);
    worker.reply({completion:{items:[{label:'current'}]}});
    assert.deepEqual(await latest, {completion:{items:[{label:'current'}]}});

    const active = first.analyze('first editor', 12);
    const activeStopped = assert.rejects(active, {name:'AbortError'});
    const other = second.analyze('second editor', 13);
    const final = first.analyze('changed first editor', 20);
    await activeStopped;
    worker.reply({discard:true});
    assert.equal(worker.messages.at(-1).source, 'second editor');
    worker.reply({owner:'second'});
    assert.deepEqual(await other, {owner:'second'});
    assert.equal(worker.messages.at(-1).source, 'changed first editor');
    worker.reply({owner:'first'});
    assert.deepEqual(await final, {owner:'first'});

    const details = first.details('record.name', 11, 'name', {context:{data:{saved:1}}});
    assert.equal(worker.messages.at(-1).method, 'details');
    assert.equal(worker.messages.at(-1).name, 'name');
    worker.reply({label:'name',signature:'name: string'});
    assert.equal((await details).signature, 'name: string');

    const broken = first.analyze('retry me', 8), waiting = second.analyze('pending', 7);
    const rejected = [assert.rejects(broken, /load failed/),assert.rejects(waiting, /load failed/)];
    assert.equal(worker.error('load failed').prevented, true);
    await Promise.all(rejected);
    assert.equal(worker.terminated, true);
    const retried = first.analyze('retry me', 8);
    const replacement = FakeWorker.instances[1];
    assert.equal(FakeWorker.instances.length, 2);
    replacement.reply({recovered:true});
    assert.deepEqual(await retried, {recovered:true});

    const disposed = second.analyze('detached editor', 15);
    const disposedStopped = assert.rejects(disposed, {name:'AbortError'});
    second.dispose();
    await disposedStopped;
    replacement.reply({discard:true});
    await assert.rejects(second.analyze('unreachable', 11), {name:'AbortError'});
    first.dispose();
  } finally {globalThis.Worker = previous;}
});
