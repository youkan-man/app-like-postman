/** Saved scripts can be edited at their point of use without changing pages. */
import {createCodeEditor} from './code-editor.mjs';
import {scriptEditorContext} from './script-editor-context.mjs';

const editors=new Set();
let observer=null;

/** Resolve the current model by ID; never write a captured or deleted object. */
export function updateSavedScriptSource(workspace,id,source,expectedSource){
  if(typeof source!=='string')throw new TypeError('コードは文字列で指定してください。');
  const script=workspace?.scripts?.find(item=>item.id===id);
  if(!script)throw new Error('スクリプトがありません。');
  if(typeof expectedSource==='string'&&script.source!==expectedSource&&script.source!==source)
    throw new Error('別の操作でコードが更新されました。最新の内容を表示します。');
  const changed=script.source!==source;if(changed)script.source=source;
  return {script,changed};
}

function observeEditors(){
  if(observer||typeof MutationObserver!=='function'||typeof document==='undefined')return;
  observer=new MutationObserver(()=>{
    for(const editor of editors){
      if(editor.element.isConnected)editor.mounted=true;
      else if(editor.mounted)editor.dispose();
    }
  });
  observer.observe(document.documentElement,{childList:true,subtree:true});
}

/** Refresh after model writes, imports, or revision restores. */
export function refreshEmbeddedScriptEditors(workspace){
  for(const editor of [...editors]){
    if(editor.mounted&&!editor.element.isConnected){editor.dispose();continue;}
    if(!workspace||editor.workspace()===workspace)editor.refresh();
  }
}

export function createEmbeddedScriptEditor({workspace,primary,scriptId,persist=()=>{},label='スクリプト',
  intelligenceContext,onError=()=>{}}={}){
  const w=typeof workspace==='function'?workspace:()=>workspace;
  const reference=typeof scriptId==='function'?scriptId:()=>scriptId;
  const element=document.createElement('div');element.className='embedded-script-editor';
  let boundWorkspace=w(),boundId=reference()||'',baseline='',available=false,disposed=false,deferred=false;
  const current=()=>w()?.scripts?.find(item=>item.id===reference());
  const editor=createCodeEditor({value:current()?.source||'',language:'javascript',label,readOnly:!current(),intellisense:true,
    intelligenceContext:()=>{
      const script=current();return intelligenceContext?intelligenceContext(script):scriptEditorContext(w(),primary,{script});
    },
    onChange:source=>{
      if(disposed||!available)return;
      // A picker/model change must not redirect an old editor's input into a
      // different script. A concurrent source update must not be overwritten.
      if(boundWorkspace!==w()||boundId!==reference()){deferred=true;refresh();return;}
      try{
        const result=updateSavedScriptSource(w(),boundId,source,baseline);baseline=result.script.source;
        if(result.changed){refreshEmbeddedScriptEditors(w());persist();}
      }catch(error){deferred=true;refresh();onError(error);}
    }
  });
  element.append(editor.element);
  const textarea=editor.textarea;

  function present(){
    element.dataset.scriptId=String(boundId);element.dataset.available=String(available);
    element.hidden=!available;
  }
  function refresh(){
    if(disposed)return false;
    if(element.isConnected)controller.mounted=true;
    const nextWorkspace=w(),nextId=reference()||'',script=nextWorkspace?.scripts?.find(item=>item.id===nextId);
    const rebound=nextWorkspace!==boundWorkspace||nextId!==boundId,wasAvailable=available;
    if(editor.isComposing){deferred=true;return Boolean(script);}
    if(rebound){boundWorkspace=nextWorkspace;boundId=nextId;}
    available=Boolean(script);
    editor.setReadOnly(!available);
    baseline=script?.source||'';
    editor.syncValue(baseline,{resetHistory:rebound||available!==wasAvailable});deferred=false;present();return available;
  }
  const compositionEnd=()=>{if(deferred)refresh();};
  textarea.addEventListener('compositionend',compositionEnd);
  function dispose(){
    if(disposed)return;disposed=true;editors.delete(controller);textarea.removeEventListener('compositionend',compositionEnd);editor.dispose();
    if(!editors.size){observer?.disconnect();observer=null;}
  }
  const controller={element,textarea,refresh,dispose,workspace:w,mounted:false,get available(){return available;}};
  editors.add(controller);refresh();observeEditors();
  // Normal callers mount synchronously. Remember that mount so later subtree
  // replacement releases Worker/search resources even without an explicit call.
  queueMicrotask(()=>{if(!disposed&&element.isConnected)controller.mounted=true;});
  return controller;
}
