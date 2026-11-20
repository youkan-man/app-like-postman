import test from 'node:test';
import assert from 'node:assert/strict';
import {newRelation,newRelationStep,newStep,NEXT,END} from '../static/relations.mjs';
import {relationStepLocations,canMoveRelationStep,moveRelationStep,insertRelationStep,wrapRelationStep} from '../static/relation-tree.mjs';

const node=(id,type='wait',extra={})=>({...newRelationStep(type),id,...extra});
const request=id=>({...newStep({collectionId:'collection',itemId:id}),id});
const relation=steps=>({...newRelation('Editing'),steps});

test('cross-level moves preserve node identities and internal branches, and repair references outside sibling scope',()=>{
  const a=request('a'),b=request('b'),c=request('c'),inside=request('inside'),loop=node('loop','repeat',{steps:[inside]}),flow=relation([a,b,c,loop]);
  a.onTrue=b.id;b.onTrue=c.id;b.onFalse=b.id;c.onFalse=END;
  assert.equal(canMoveRelationStep(flow,b.id,{parentId:loop.id}),true);
  assert.equal(moveRelationStep(flow,b.id,{parentId:loop.id}),b);
  assert.deepEqual(flow.steps,[a,c,loop]);assert.deepEqual(loop.steps,[inside,b]);
  assert.equal(a.onTrue,NEXT);assert.equal(b.onTrue,NEXT);assert.equal(b.onFalse,b.id);assert.equal(c.onFalse,END);
  inside.onTrue=b.id;moveRelationStep(flow,b.id,{index:1});
  assert.equal(flow.steps[1],b);assert.equal(inside.onTrue,NEXT);assert.deepEqual(loop.steps,[inside]);
});

test('moving a branch subtree retains descendants and their internal request targets',()=>{
  const a=request('a'),b=request('b');a.onTrue=b.id;
  const branch=node('branch','if',{steps:[a,b],elseSteps:[node('other')]}),outer=node('outer','repeat'),flow=relation([branch,outer]);
  moveRelationStep(flow,branch.id,{parentId:outer.id});
  assert.equal(outer.steps[0],branch);assert.equal(branch.steps[0],a);assert.equal(a.onTrue,b.id);
  assert.deepEqual(relationStepLocations(flow).map(entry=>entry.label),['1','1.1','1.1.T.1','1.1.T.2','1.1.F.1']);
});

test('wrap retains the step ID, redirects incoming sibling branches, and supports nesting existing blocks',()=>{
  const before=request('before'),selected=request('selected'),after=request('after'),flow=relation([before,selected,after]);
  before.onTrue=selected.id;selected.onTrue=after.id;
  const wrapper=wrapRelationStep(flow,selected.id,'repeat');
  assert.equal(flow.steps[1],wrapper);assert.equal(wrapper.steps[0],selected);assert.equal(selected.id,'selected');
  assert.equal(before.onTrue,wrapper.id);assert.equal(selected.onTrue,NEXT);
  const outer=wrapRelationStep(flow,wrapper.id,'if');assert.equal(outer.steps[0],wrapper);assert.equal(before.onTrue,outer.id);assert.deepEqual(outer.elseSteps,[]);
});

test('if branch moves and insertion target the requested body without changing its sibling branch',()=>{
  const left=request('left'),right=request('right'),condition=node('condition','if',{steps:[left],elseSteps:[right]}),flow=relation([condition]);
  moveRelationStep(flow,left.id,{parentId:condition.id,branch:'elseSteps',index:0});
  assert.deepEqual(condition.steps,[]);assert.deepEqual(condition.elseSteps,[left,right]);
  const added=node('added');insertRelationStep(flow,added,{parentId:condition.id,branch:'steps'});assert.equal(condition.steps[0],added);
});

test('reordering siblings handles insertion offsets and detects no-op destinations',()=>{
  const first=node('first'),second=node('second'),third=node('third'),flow=relation([first,second,third]);
  assert.equal(canMoveRelationStep(flow,first.id,{index:1}),false);
  moveRelationStep(flow,first.id,{index:3});assert.deepEqual(flow.steps,[second,third,first]);
  moveRelationStep(flow,first.id,{index:0});assert.deepEqual(flow.steps,[first,second,third]);
});

test('cycles, invalid destinations and escaping loop controls leave the entire tree unchanged',()=>{
  const child=node('child','if',{steps:[node('break','break')]}),loop=node('loop','repeat',{steps:[child]}),flow=relation([loop,node('leaf')]),before=structuredClone(flow);
  for(const [id,target] of [[loop.id,{parentId:child.id}],[loop.id,{parentId:loop.id}],[child.id,{index:1}],[child.id,{parentId:'leaf'}],[child.id,{parentId:loop.id,branch:'elseSteps'}]]){
    assert.equal(canMoveRelationStep(flow,id,target),false);assert.throws(()=>moveRelationStep(flow,id,target));assert.deepEqual(flow,before);
  }
  assert.throws(()=>insertRelationStep(flow,node('orphan','continue'),{index:1}),/ループ内/);assert.deepEqual(flow,before);
  const target=node('target','while');insertRelationStep(flow,target,{});moveRelationStep(flow,child.id,{parentId:target.id});assert.equal(target.steps[0],child);
});

test('moves, insertions and wrapping enforce maximum depth before mutating any array',()=>{
  let nested=node('leaf');for(let index=31;index>=0;index--)nested=node('group-'+index,'repeat',{steps:[nested]});
  const flow=relation([nested,node('moving')]),before=structuredClone(flow);
  assert.equal(relationStepLocations(flow).find(entry=>entry.step.id==='leaf').depth,32);
  assert.throws(()=>wrapRelationStep(flow,'leaf','repeat'),/32/);assert.deepEqual(flow,before);
  assert.throws(()=>moveRelationStep(flow,'group-0',{parentId:'group-31'}),/自分自身/);assert.deepEqual(flow,before);
  assert.throws(()=>insertRelationStep(flow,node('too-deep','repeat'),{parentId:'group-31'}),/32/);assert.deepEqual(flow,before);
  const wrapper=wrapRelationStep(flow,'moving','repeat');
  assert.throws(()=>moveRelationStep(flow,wrapper.id,{parentId:'group-31'}),/32/);
});
