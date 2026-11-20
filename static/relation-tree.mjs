/** Structural editing keeps step identities and sibling-only branch targets. */
import {NEXT,END,newRelationStep,relationStepType} from './relations.mjs';

const loops=new Set(['repeat','forEach','while']),groups=new Set([...loops,'if']);
const branches=step=>relationStepType(step)==='if'?['steps','elseSteps']:groups.has(relationStepType(step))?['steps']:[];

export function relationStepLocations(relation){
  const found=[],ids=new Set(),objects=new Set();
  function visit(siblings,parent=null,branch='steps',ancestors=[],depth=0,loopDepth=0,prefix=''){
    if(!Array.isArray(siblings)||depth>32)throw new Error('ステップの入れ子は32段までです。');
    for(const [index,step] of siblings.entries()){
      if(!step||typeof step!=='object'||typeof step.id!=='string'||!step.id||ids.has(step.id)||objects.has(step))throw new Error('ステップIDが不正または重複しています。');
      ids.add(step.id);objects.add(step);
      const label=prefix+(index+1),entry={step,siblings,index,parent,parentId:parent?.id??null,branch,ancestors,depth,loopDepth,label};found.push(entry);
      for(const key of branches(step))visit(step[key],step,key,[...ancestors,step.id],depth+1,loopDepth+Number(loops.has(relationStepType(step))),label+'.'+(relationStepType(step)==='if'?(key==='steps'?'T.':'F.') : ''));
    }
  }
  visit(relation.steps);return found;
}

function destination(relation,locations,{parentId=null,branch='steps',index}={}){
  const owner=parentId===null?null:locations.find(entry=>entry.step.id===parentId);
  if(parentId!==null&&!owner)throw new Error('移動先のブロックがありません。');
  if(owner?!branches(owner.step).includes(branch):branch!=='steps')throw new Error('移動先のブロックが不正です。');
  const siblings=owner?owner.step[branch]:relation.steps,at=index??siblings.length;
  if(!Number.isSafeInteger(at)||at<0||at>siblings.length)throw new Error('移動先が不正です。');
  return {siblings,index:at,owner,depth:owner?owner.depth+1:0,loopDepth:owner?owner.loopDepth+Number(loops.has(relationStepType(owner.step))):0};
}

function checkSubtree(step,{depth,loopDepth},knownIds=new Set()){
  const seen=new Set();
  function visit(value,level,insideLoop){
    if(level>32)throw new Error('ステップの入れ子は32段までです。');
    if(!value||typeof value!=='object'||typeof value.id!=='string'||!value.id||knownIds.has(value.id)||seen.has(value.id))throw new Error('ステップIDが不正または重複しています。');
    seen.add(value.id);const type=relationStepType(value);
    if(['break','continue'].includes(type)&&!insideLoop)throw new Error('ループ終了・次の周へはループ内に移動してください。');
    for(const branch of branches(value)){
      if(!Array.isArray(value[branch])||level+1>32)throw new Error('ステップの入れ子は32段までです。');
      for(const child of value[branch])visit(child,level+1,insideLoop+Number(loops.has(type)));
    }
  }
  visit(step,depth,loopDepth);
}

function repairBranches(siblings){
  const ids=new Set(siblings.map(step=>step.id));
  for(const step of siblings)if(relationStepType(step)==='request')for(const key of ['onTrue','onFalse'])if(step[key]!==undefined&&step[key]!==NEXT&&step[key]!==END&&!ids.has(step[key]))step[key]=NEXT;
}

function planMove(relation,id,target){
  const locations=relationStepLocations(relation),source=locations.find(entry=>entry.step.id===id);
  if(!source)throw new Error('移動するステップがありません。');
  const next=destination(relation,locations,target);
  if(next.owner&&(next.owner.step===source.step||next.owner.ancestors.includes(id)))throw new Error('自分自身の中へ移動できません。');
  checkSubtree(source.step,next);
  const index=next.index-Number(next.siblings===source.siblings&&source.index<next.index);
  return {source,next,index,changed:next.siblings!==source.siblings||index!==source.index};
}

export function canMoveRelationStep(relation,id,target){try{return planMove(relation,id,target).changed;}catch{return false;}}

export function moveRelationStep(relation,id,target){
  const {source,next,index,changed}=planMove(relation,id,target);if(!changed)return source.step;
  source.siblings.splice(source.index,1);next.siblings.splice(index,0,source.step);
  repairBranches(source.siblings);if(next.siblings!==source.siblings)repairBranches(next.siblings);
  return source.step;
}

export function insertRelationStep(relation,step,target){
  const locations=relationStepLocations(relation),next=destination(relation,locations,target);
  checkSubtree(step,next,new Set(locations.map(entry=>entry.step.id)));
  next.siblings.splice(next.index,0,step);repairBranches(next.siblings);return step;
}

export function wrapRelationStep(relation,id,type){
  if(!groups.has(type))throw new Error('ブロックの種類が不正です。');
  const locations=relationStepLocations(relation),source=locations.find(entry=>entry.step.id===id);
  if(!source)throw new Error('囲むステップがありません。');
  const wrapper=newRelationStep(type);wrapper.steps.push(source.step);
  checkSubtree(wrapper,{depth:source.depth,loopDepth:source.loopDepth},new Set(locations.filter(entry=>entry.step!==source.step&&!entry.ancestors.includes(id)).map(entry=>entry.step.id)));
  source.siblings.splice(source.index,1,wrapper);
  for(const step of source.siblings)if(relationStepType(step)==='request')for(const key of ['onTrue','onFalse'])if(step[key]===id)step[key]=wrapper.id;
  repairBranches(wrapper.steps);repairBranches(source.siblings);return wrapper;
}
