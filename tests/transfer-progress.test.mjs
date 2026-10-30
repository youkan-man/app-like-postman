import test from 'node:test';
import assert from 'node:assert/strict';
import {TransferProgress, transferPresentation} from '../static/transfer-progress.mjs';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('short requests never reveal a progress bar and release their timer', async () => {
  const changes = [], tracker = new TransferProgress(id => changes.push(id), {delayMs: 20});
  const task = tracker.begin('a'); task.update({phase:'upload',completed:10,total:100});
  assert.equal(tracker.get('a').visible, false); task.finish(); await wait(40);
  assert.equal(tracker.get('a'), undefined); assert.equal(changes.length, 2);
});
test('long requests reveal live byte progress without modifying another request', async () => {
  const tracker = new TransferProgress(() => {}, {delayMs: 10});
  const a = tracker.begin('a'), b = tracker.begin('b');
  a.update({phase:'upload',completed:256*1024*1024,total:512*1024*1024});
  await wait(25);
  assert.equal(tracker.get('a').visible,true);
  assert.equal(transferPresentation(tracker.get('a')).detail,'256 MiB / 512 MiB · 50%');
  assert.equal(tracker.get('b').phase,'prepare'); a.finish(); b.finish();
});
test('callbacks from a completed attempt cannot change or finish the next send', () => {
  const tracker = new TransferProgress(); const old = tracker.begin('a'), next = tracker.begin('a');
  old.update({phase:'upload',completed:99,total:100}); old.finish();
  assert.equal(tracker.get('a').phase,'prepare');next.finish();
});
test('cancel drops percentages and rejects late updates until completion', () => {
  const tracker = new TransferProgress(); const task = tracker.begin('a');
  task.update({phase:'upload',completed:20,total:100});tracker.cancelling('a');
  task.update({phase:'send',completed:100,total:100});
  assert.equal(tracker.get('a').phase,'stopping');assert.equal(transferPresentation(tracker.get('a')).known,false);task.finish();
});
test('response waiting is indeterminate, not a completed transfer', () => {
  assert.equal(transferPresentation({phase:'waiting',completed:100,total:100}).known,false);
  assert.equal(transferPresentation({phase:'waiting'}).label,'応答待ち');
  assert.equal(transferPresentation({phase:'send',completed:30,total:100,attempt:2}).label,'送信先へ再転送中（2回目）');
});
test('empty files, unknown totals and invalid counters do not make NaN progress', () => {
  assert.equal(transferPresentation({phase:'upload',completed:0,total:0}).detail,'0 B / 0 B · 100%');
  for (const completed of [undefined,NaN,Infinity,-1]) assert.equal(transferPresentation({phase:'upload',completed,total:100}).known,false);
  assert.equal(transferPresentation({phase:'upload',completed:1000,total:1001}).detail.endsWith('99.9%'),true);
});
