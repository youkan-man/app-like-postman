import test from 'node:test';
import assert from 'node:assert/strict';
import {TransferProgress,transferPresentation} from '../static/transfer-progress.mjs';

test('transfer quantity and percentage have separate display fields',()=>{
  const view=transferPresentation({visible:true,phase:'upload',completed:192*1024**2,total:512*1024**2});
  assert.equal(view.amount,'192 / 512 MiB');assert.equal(view.percent,37.5);
  assert.equal(view.detail,'192 MiB / 512 MiB · 37.5%');assert.equal(view.route,'ブラウザ → MiniPost');
});
test('the capacity pair retains one unit even near a unit boundary',()=>{
  assert.equal(transferPresentation({phase:'upload',completed:0,total:512*1024**2}).amount,'0 / 512 MiB');
  assert.equal(transferPresentation({phase:'send',completed:512*1024**2,total:1024**3}).amount,'0.5 / 1 GiB');
  assert.equal(transferPresentation({phase:'send',completed:17,total:100}).amount,'17 / 100 B');
});
test('waiting, scripts and cancellation never retain a percentage or byte amount',()=>{
  for(const phase of ['waiting','prepare','script','processing','stopping']){
    const view=transferPresentation({visible:true,phase,completed:512,total:512});
    assert.equal(view.known,false);assert.equal(view.percent,null);assert.equal(view.amount,'');
  }
  assert.equal(transferPresentation({phase:'waiting'}).route,'送信先 → MiniPost');
  assert.equal(transferPresentation({phase:'script'}).route,'');
});
test('target transfer direction and redirect attempt remain explicit',()=>{
  const view=transferPresentation({phase:'send',completed:7,total:10,attempt:2});
  assert.equal(view.route,'MiniPost → 送信先');assert.equal(view.percent,70);
  assert.equal(view.label,'送信先へ再転送中（2回目）');
});
test('invalid counters are indeterminate and overrun is clamped',()=>{
  for(const completed of [undefined,NaN,Infinity,-1]){
    const view=transferPresentation({phase:'upload',completed,total:100});
    assert.equal(view.percent,null);assert.equal(view.amount,'');
  }
  assert.equal(transferPresentation({phase:'upload',completed:1001,total:1000}).percent,100);
  assert.equal(transferPresentation({phase:'upload',completed:0,total:0}).amount,'0 / 0 B');
});
test('the visual model cannot resurrect a completed attempt or a stopping count',()=>{
  const changes=[],tracker=new TransferProgress(id=>changes.push(id),{delayMs:10000});
  const first=tracker.begin('a');first.update({phase:'send',completed:7,total:10});
  tracker.cancelling('a');first.update({phase:'send',completed:10,total:10});
  assert.equal(transferPresentation(tracker.get('a')).percent,null);
  const second=tracker.begin('a');first.finish();first.update({phase:'upload',completed:1,total:1});
  assert.equal(tracker.get('a').phase,'prepare');second.finish();assert.equal(tracker.get('a'),undefined);
});
