import test from 'node:test';
import assert from 'node:assert/strict';
import {clone,newRequest} from '../static/core.mjs';
import {newRelation,newStep,runRelation} from '../static/relations.mjs';
import {newRibbonState,cloneRibbonState,newRibbon,newRibbonGroup,newRibbonControl} from '../static/ribbons.mjs';
import {historyEntry} from '../static/sent-history.mjs';

test('relation history carries the initial owned ribbon snapshot through saved and draft request repeats',async()=>{
  const state=newRibbonState(),ribbon=newRibbon('Tools','tools'),group=newRibbonGroup(),control=newRibbonControl('number');
  control.key='count';control.value=4;group.controls.push(control);ribbon.groups.push(group);state.ribbons.push(ribbon);state.activeRibbonId=ribbon.id;
  const item={_mpId:'request',name:'Saved',request:newRequest(),ribbonState:state};
  const draft={id:'draft',name:'Draft',request:newRequest(),ribbonState:cloneRibbonState(state)};
  draft.ribbonState.ribbons[0].groups[0].controls[0].value=8;
  const collection={_mpId:'collection',info:{name:'Requests'},item:[item]};
  const workspace={collections:[collection],tabs:[draft],environments:[],globals:[],history:[]};
  const original={saved:clone(item.ribbonState),draft:clone(draft.ribbonState)};
  const relation=newRelation('Flow');
  relation.steps=[newStep({collectionId:collection._mpId,itemId:item._mpId}),newStep({draftId:draft.id})];
  for(const step of relation.steps)step.repeat=2;
  let changed=false;
  const response={status:200,headers:[],body:'ok'};
  const run=await runRelation(relation,{workspace,primary:()=>({}),
    onProgress:()=>{
      if(changed)return;changed=true;
      // Editing either owner after planning must not rewrite the planned history.
      item.ribbonState.ribbons[0].groups[0].controls[0].value=40;
      draft.ribbonState.ribbons[0].groups[0].controls[0].value=80;
      item.ribbonState.activeRibbonId='';draft.ribbonState.activeRibbonId='';
    },
    execute:async tab=>{
      const expected=tab.id===draft.id?original.draft:original.saved;
      assert.deepEqual(tab.ribbonState,expected);
      workspace.history.push(historyEntry(tab,response));
      // Each repeat receives a separate copy, as the HTTP template already does.
      tab.ribbonState.ribbons[0].groups[0].controls[0].value=999;
      return response;
    }
  });
  assert.equal(run.status,'succeeded',run.error);
  assert.equal(workspace.history.length,4);
  for(const [index,entry] of workspace.history.entries())assert.deepEqual(entry.tab.ribbonState,index<2?original.saved:original.draft);
  assert.equal(item.ribbonState.ribbons[0].groups[0].controls[0].value,40);
  assert.equal(draft.ribbonState.ribbons[0].groups[0].controls[0].value,80);
});
