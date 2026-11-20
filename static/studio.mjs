import {confirmAction} from './confirm-dialog.mjs';
/** Workspace pages own editing state; runtime, scripts and relation execution are separate. */
import {SCHEMA,clone,uid,rows,enabled,findItem,walkItems,contextFor,newRequest} from './core.mjs';
import {PrimaryVariables,RESPONSE_KEY,extractVariableNames,upsertVariable,responseMetadata,metadataElements,extractionWrites,requestAutomation,variableText,checkName} from './runtime.mjs';
import {createCodeEditor} from './code-editor.mjs';
import {createEmbeddedScriptEditor,refreshEmbeddedScriptEditors} from './embedded-script-editor.mjs';
import {executeRequest} from './execution.mjs';
import {runScript} from './script-runner.mjs';
import {initScriptWorkspace} from './script-workspace.mjs';
import {initRibbonWorkspace} from './ribbon-workspace.mjs';
import {applyScriptWrites} from './scripts.mjs';
import {createScriptHost,makeScriptContext,formatScriptValue} from './script-host.mjs';
import {createScriptRelationRunner} from './script-relations.mjs';
import {scriptEditorContext} from './script-editor-context.mjs';
import {applyResponseMutation,restoreOriginalResponse,applyRequestMutation} from './script-response.mjs';
import {newRelation,newStep,newRelationStep,relationStepType,walkRelationSteps,cloneRelationSteps,RELATION_STEP_TYPES,runRelation,OPERATORS,NEXT,END} from './relations.mjs';
import {relationStepLocations,canMoveRelationStep,moveRelationStep,insertRelationStep,wrapRelationStep} from './relation-tree.mjs';
import {requestKey} from './revisions.mjs';
export function responseRequestKey(workspace,tab){
  const original=workspace.collections.find(collection=>collection._mpId===tab.collectionId);
  if(!tab.itemId||findItem(original,tab.itemId)?.item.request)return requestKey(workspace,tab);
  const matches=[];
  for(const collection of workspace.collections)walkItems(collection.item,item=>{if(item._mpId===tab.itemId&&item.request)matches.push(collection._mpId);});
  return matches.length===1?'request:'+matches[0]+':'+tab.itemId:requestKey(workspace,tab);
}
export function initStudio(api) {
  const {$,element:el,button:btn,input,select,field,kvEditor,openItemMenu,bindContext,showModal,closeModal,persist,toast}=api;
  const w=api.workspace;
  let storeWarning=false;
  const storageError=()=>{if(!storeWarning){storeWarning=true;toast('セッションの保存容量を超えました。値と受信結果は画面上に保持しています。');}};
  let session=null;try {session=sessionStorage;}catch {}
  const primary=new PrimaryVariables(session,storageError),snapshots=new Map(),scriptLogs=new Map(),scriptPhases=new Map();
  try {for(const [key,value] of JSON.parse(session?.getItem(RESPONSE_KEY)||'[]')) snapshots.set(key,value);}catch {}
  let envSelection=w().environmentId||'',relationId='',surfaceKey='',creationContext=null,controller=null,running=null;
  const manualControllers=new Set();
    w().relations ||= [];w().relationRuns ||= [];
  const runScriptRelation=createScriptRelationRunner({filesFor:api.filesFor,getResponses,requestFor:api.requestFor,
    onResponse:(tab,result,environmentId)=>{rememberResponse(tab,result);api.recordBackground(tab,result,environmentId);}});
  const scriptWorkspace=initScriptWorkspace({...api,primary,runScriptRelation,getResponses,openScripts:()=>{surfaceKey='';setSurface('scripts');},runningChanged:refreshStop,
    recordResponse:(tab,result,environmentId)=>{rememberResponse(tab,result);api.recordBackground(tab,result,environmentId);}});
  const ribbonWorkspace=initRibbonWorkspace({...api,primary,runScriptRelation,getResponses,openRibbons:()=>{surfaceKey='';setSurface('ribbons');},openScript:id=>scriptWorkspace.open(id),runningChanged:refreshStop,
    showRibbonRequest:()=>{setSurface('collections');api.renderAll();},
    recordResponse:(tab,result,environmentId)=>{rememberResponse(tab,result);api.recordBackground(tab,result,environmentId);}});
  function refreshStop(){$('stopRelationGlobal').hidden=!(controller||manualControllers.size||scriptWorkspace.isRunning()||ribbonWorkspace.isRunning());ribbonWorkspace.refresh();}
  function setSurface(side){api.setSide(side);api.renderSidebar();syncView(side);api.closeNavigation();}
  function changedEnvironment(){persist();api.renderEnvironments();}
  function rememberResponse(tab,result){
    if(result.error)return;
    snapshots.set(responseRequestKey(w(),tab),clone(result));
    try{session?.setItem(RESPONSE_KEY,JSON.stringify([...snapshots]));}catch{storageError();}
  }
  function responseFor(tab){return snapshots.get(responseRequestKey(w(),tab));}
  function getResponses(){
    return [...snapshots].map(([id,result])=>{
      const saved=id.startsWith('request:'),requestId=saved?id.slice('request:'.length):id;
      const [collectionId,itemId]=saved?requestId.split(':'):[];
      const owner=saved?findItem(w().collections.find(collection=>collection._mpId===collectionId),itemId)?.item:w().tabs.find(tab=>'draft:'+tab.id===id);
      return {id,requestId,name:owner?.name||id,response:responseMetadata(result)};
    });
  }
  function transferResponse(before,after){
    if(before===after)return;
    for(const values of [snapshots,scriptLogs,scriptPhases])if(values.has(before)){values.set(after,values.get(before));values.delete(before);}
    try{session?.setItem(RESPONSE_KEY,JSON.stringify([...snapshots]));}catch{storageError();}
  }
  function forgetResponse(key){snapshots.delete(key);scriptLogs.delete(key);scriptPhases.delete(key);try{session?.setItem(RESPONSE_KEY,JSON.stringify([...snapshots]));}catch{storageError();}}
  function scriptLogText(entry){return [...(entry?.logs||[]).map(row=>row.message),...(entry?.error?[entry.error]:entry&&Object.hasOwn(entry,'result')?[formatScriptValue(entry.result)]:[])].join('\n');}
  function noteScript(tab,entry){scriptLogs.set(responseRequestKey(w(),tab),entry);const log=$('scriptLog');if(log&&responseRequestKey(w(),api.active())===responseRequestKey(w(),tab))log.textContent=scriptLogText(entry)||'完了';}
  function replaceResponse(tab,result){rememberResponse(tab,result);api.replaceResponse(tab,result);}
  async function runContextScript(tab,{source,scriptId,timeoutMs,phase}) {
    const workspace=w(),snapshot=clone(tab),baseline=phase==='after'?responseFor(tab):null;
    if(phase==='after'&&!baseline)throw new Error('レスポンスを受信してから実行してください。');
    if(api.isRequestRunning(tab))throw new Error('受信が完了してから実行してください。');
    const originalRequest=JSON.stringify(tab.request),manual=new AbortController(),live=[];
    manualControllers.add(manual);refreshStop();noteScript(tab,{phase,logs:live});
    try {
      const env=contextFor(workspace,snapshot,primary.rows).environment;
      const context={...makeScriptContext(workspace,primary,{tab:snapshot,result:baseline,input:phase==='before'?clone(snapshot.request):responseMetadata(baseline),scriptId}),phase};
      const host=createScriptHost({workspace,primary,filesFor:api.filesFor,getResponses,runRelation:runScriptRelation,onResponse:(sent,response,envId)=>{rememberResponse(sent,response);api.recordBackground(sent,response,envId);}});
      const out=await runScript(source,context,{timeoutMs,signal:manual.signal,onCall:host,onLog:entry=>{live.push(entry);noteScript(tab,{phase,logs:live});}});
      if(manual.signal.aborted)throw new DOMException('スクリプトを停止しました。','AbortError');
      if(w()!==workspace)throw new Error('ワークスペースが変更されたため、処理結果を反映できません。');
      if(phase==='after'&&out.request)throw new Error('受信後に送信済みリクエストは変更できません。送信前スクリプトで変更してください。');
      const response=out.response?applyResponseMutation(baseline,out.response):baseline;
      const request=out.request?applyRequestMutation(snapshot.request,out.request):snapshot.request;
      // Validate every effect before committing variables or either visible value.
      if(phase==='after'&&(responseFor(tab)!==baseline||api.isRequestRunning(tab)))throw new Error('実行中にレスポンスが更新されたため、処理結果を反映できません。');
      if(phase==='before'&&(api.requestFor(tab)!==tab||JSON.stringify(tab.request)!==originalRequest||api.isRequestRunning(tab)))throw new Error('実行中にリクエストが変更されたため、処理結果を反映できません。');
      if(out.request)api.validateRequestReplacement(tab,request,out.attachmentRows);
      const committed=phase==='after'&&out.response?{...out,writes:{...out.writes,primary:[...extractionWrites(requestAutomation(snapshot.request).extractions,responseMetadata(response)),...(out.writes.primary||[])]}}:out;
      if(applyScriptWrites(workspace,primary,env,committed))persist();api.workspaceChanged?.(committed);
      if(out.request)api.replaceRequest(tab,request,out.attachmentRows);
      if(response!==baseline)replaceResponse(tab,response);
      noteScript(tab,{phase,logs:out.logs,result:out.result});
      return out;
    }catch(error){noteScript(tab,{phase,error:error.message,logs:error.logs?.length?error.logs:live});throw error;}
    finally{manualControllers.delete(manual);refreshStop();}
  }
  function runResponseScript(tab=api.active()) {
    const baseline=responseFor(tab);
    if(!baseline){toast('レスポンスを受信してから実行してください。');return;}
    const scripts=w().scripts||[];
    if(!scripts.length){toast('実行するスクリプトを保存してください。');return;}
    let selected=scripts[0].id;
    const picker=select(scripts.map(script=>[script.id,script.name]),selected,value=>selected=value);
    picker.setAttribute('aria-label','実行するスクリプト');
    showModal('レスポンスにスクリプトを実行',field('スクリプト',picker),async()=>{
      const saved=w().scripts.find(script=>script.id===selected);
      if(!saved)throw new Error('選択したスクリプトが見つかりません。');
      if(responseFor(tab)!==baseline)throw new Error('レスポンスが更新されました。対象を確認して開き直してください。');
      closeModal();
      try{await runContextScript(tab,{source:saved.source,scriptId:saved.id,timeoutMs:saved.timeoutMs,phase:'after'});toast('スクリプトを実行しました。');}
      catch(error){toast(error.message);}
    },'実行');
  }
  function responseMenu(anchor,event){
    const tab=api.active(),result=responseFor(tab),busy=api.isRequestRunning(tab);
    const selection=window.getSelection(),selected=selection?.anchorNode&&$('responseContent').contains(selection.anchorNode)?String(selection):'';
    openItemMenu(anchor,[
      ...(selected?[{label:'選択箇所をコピー',run:()=>api.copyText(selected)},null]:[]),
      {label:'スクリプトを実行',disabled:!result||busy||!w().scripts?.length,run:()=>runResponseScript(tab)},
      {label:'受信後スクリプトを編集',run:()=>{api.selectEditorPage('scripts');scriptPhases.set(requestKey(w(),tab),'after');api.renderEditor();}},
      {label:'受信時のレスポンスに戻す',disabled:!result?.original_response||busy,run:()=>{
        if(responseFor(tab)!==result||api.isRequestRunning(tab)){toast('レスポンスが更新されました。対象を確認して開き直してください。');return;}
        replaceResponse(tab,restoreOriginalResponse(result));
      }}
    ],event);
  }
  async function execute(tab,{signal,environmentId=w().environmentId,files={},onProgress,relationAncestors=[]}={}) {
    const host=createScriptHost({workspace:w(),primary,environmentId,filesFor:api.filesFor,getResponses,runRelation:(relation,context)=>runScriptRelation(relation,{...context,ancestorRelationIds:relationAncestors}),onResponse:(sent,result,env)=>{rememberResponse(sent,result);api.recordBackground(sent,result,env);}});
    const live={};
    const result=await executeRequest({workspace:w(),tab,files,primary,environmentId,signal,onProgress,scriptCall:host,
      onScriptLog:({phase,...entry})=>{(live[phase]||=[]).push(entry);noteScript(tab,{phase,logs:live[phase]});},
      onVariables:(saved,changes)=>{if(saved)persist();api.workspaceChanged?.(changes);ribbonWorkspace.refresh();if(api.side()==='environments'&&!document.activeElement?.closest('.variables-page')){surfaceKey='';syncView('environments');}},onScript:entry=>noteScript(tab,entry)});
    rememberResponse(tab,result);return result;
  }
  function scopeRows(){if(envSelection==='primary')return primary.rows;if(envSelection==='globals')return w().globals;return w().environments.find(e=>e.id===envSelection)?.values;}
  function scopeChanged(){if(envSelection==='primary')primary.save();else changedEnvironment();ribbonWorkspace.refresh();}
  function addVariable(scope=envSelection,at=null){
    envSelection=scope;const list=scopeRows();if(!list){toast('変数を追加する環境を選択してください。');return;}
    const index=at===null?list.length:at;list.splice(index,0,{key:'',value:'',enabled:true});scopeChanged();surfaceKey='';setSurface('environments');
    $('workspacePage').querySelector(`[aria-label="Key ${index+1}"]`)?.focus();
  }
  function editEnvironment(env,globals=false){
    if(!globals&&!env){createEnvironment();return;}
    if(!globals){w().environmentId=env.id;envSelection=env.id;}else envSelection='globals';
    persist();api.renderEnvironments();surfaceKey='';setSurface('environments');
  }
  function environmentChosen(id){envSelection=id;surfaceKey='';if(api.side()==='environments')syncView('environments');}
  function createEnvironment(afterId=null){
    let name='新しい環境';const box=field('環境名',input(name,'環境名',value=>name=value));
    showModal('環境を作成',box,()=>{
      if(!name.trim())throw new Error('環境名を入力してください。');
      const env={id:uid(),name:name.trim(),values:[]},at=w().environments.findIndex(e=>e.id===afterId);
      w().environments.splice(afterId&&at>=0?at+1:w().environments.length,0,env);persist();closeModal();editEnvironment(env);
    },'作成');
  }
  function environmentPage(){
    const page=$('workspacePage');page.replaceChildren();
    const env=w().environments.find(e=>e.id===envSelection),isPrimary=envSelection==='primary',isGlobals=envSelection==='globals';
    page.dataset.settingsId=env?.id||'';page.dataset.settingsKind=isPrimary?'primary':isGlobals?'globals':'environment';
    const heading=el('div','workspace-page-heading variables-page-heading');heading.append(el('h1','',isPrimary?'一次変数':isGlobals?'Globals':'環境変数'));
    if(env){
      const name=input(env.name,'Environment name',v=>{env.name=v;persist();api.renderEnvironments();api.renderSidebar();});name.id='environmentName';heading.append(name);
      heading.append(btn('変更履歴',()=>api.showRevisions(`environment:${env.id}`),'button'));
      const more=btn('⋯',event=>openItemMenu(event.currentTarget,[{label:'エクスポート',run:()=>api.exportEnvironment(env)}]),'icon-button');more.setAttribute('aria-label','変数ページの操作');heading.append(more);
    } else if(isGlobals)heading.append(btn('変更履歴',()=>api.showRevisions('globals'),'button'));
    else if(isPrimary)heading.append(btn('すべて消去',async()=>{if(await confirmAction('一次変数をすべて消去しますか？')){primary.clear();surfaceKey='';syncView('environments');}},'button'));
    page.append(heading);
    if(!env&&!isPrimary&&!isGlobals){const empty=el('div','workspace-empty');empty.append(el('h2','','環境を選択してください'),btn('環境を作成',()=>createEnvironment(),'button primary'));page.append(empty);return;}
    const body=el('div','workspace-page-body variables-page');body.append(kvEditor(scopeRows(),scopeChanged,{secret:!isPrimary}));page.append(body);
    body.oncontextmenu=event=>{if(event.defaultPrevented||event.target.closest('input,textarea,select,tr'))return;event.preventDefault();openItemMenu(body,[{label:'変数を追加',run:()=>addVariable(envSelection)}],event);};
  }
  function renderSidebarSection(side){
    if(side==='ribbons'){ribbonWorkspace.sidebar();return true;}
    if(side==='scripts'){scriptWorkspace.sidebar();return true;}
    if(!['environments','relations'].includes(side))return false;
    const root=$('sidebarContent'),query=$('search').value.toLowerCase();root.replaceChildren();
    $('sidebarAdd').hidden=false;$('clearHistory').hidden=true;
    $('search').placeholder=side==='environments'?'環境を検索':'リレーションを検索';
    $('sidebarAdd').setAttribute('aria-label',side==='environments'?'環境を追加':'リレーションを追加');
    function row(title,selected,open,menu,attributes={}){
      const line=el('div',`tree-row${selected?' selected':''}`),button=btn(title,open,'tree-open'),more=btn('⋯',()=>{},'icon-button');more.setAttribute('aria-label',`${title}の操作`);
      Object.assign(line.dataset,attributes);if(attributes.scope==='globals')button.id='globalVariables';line.append(button,more);bindContext(line,more,menu);root.append(line);
    }
    if(side==='environments'){
      row('一次変数',envSelection==='primary',()=>{envSelection='primary';surfaceKey='';api.renderSidebar();syncView(side);api.closeNavigation();},(a,e)=>openItemMenu(a,[{label:'変数を追加',run:()=>addVariable('primary')},{label:'すべて消去',danger:true,run:async()=>{if(await confirmAction('一次変数をすべて消去しますか？')){primary.clear();surfaceKey='';syncView(side);}}}],e),{scope:'primary'});
      row('Globals',envSelection==='globals',()=>editEnvironment(null,true),(a,e)=>api.environmentMenu(null,true,a,e),{scope:'globals'});
      for(const env of w().environments.filter(e=>e.name.toLowerCase().includes(query)))row(env.name,envSelection===env.id,()=>{api.chooseEnvironment(env.id);editEnvironment(env);},(a,e)=>openItemMenu(a,[{label:'変数を追加',run:()=>addVariable(env.id)},{label:'環境を追加',run:()=>createEnvironment(env.id)},...api.environmentActions(env,false)],e),{environmentId:env.id});
    } else {
      for(const relation of (w().relations||[]).filter(r=>r.name.toLowerCase().includes(query)))row(relation.name,relation.id===relationId,()=>openRelation(relation.id),(a,e)=>openItemMenu(a,[
        {label:'実行',disabled:Boolean(controller),run:()=>{openRelation(relation.id);startRelation(relation);}},
        ...(controller&&running?.relationId===relation.id?[{label:'停止',run:()=>controller?.abort()}]:[]),
        {label:'リレーションを追加',run:()=>createRelation(relation.id)},
        {label:'ステップを追加',run:()=>{openRelation(relation.id);chooseStep($('addRelationStep'),relation);}},
        {label:'複製',run:()=>duplicateRelation(relation)},
        {label:'削除',danger:true,run:async()=>{
          if(controller&&running?.relationId===relation.id)return toast('実行中です。停止してから削除してください。');
          if(await confirmAction('「'+relation.name+'」を削除しますか？')){
            if(controller&&running?.relationId===relation.id)return toast('実行中です。停止してから削除してください。');
            w().relations=w().relations.filter(r=>r!==relation);persist();surfaceKey='';api.renderSidebar();syncView('relations');
          }
        }}
      ],e),{relationId:relation.id});
      if(!root.children.length)root.append(el('p','sidebar-empty','リレーションはありません'));
    }
    return true;
  }
  function syncView(side,force=false){
    $('addTab').disabled=side==='history';$('addTab').title=side==='history'?'送信履歴はリクエスト送信時に追加されます':'選択中のカテゴリに追加';
    const kind=['environments','relations','history','scripts','ribbons'].includes(side)?side:'request';document.documentElement.dataset.workspaceView=kind;
    $('exchange').hidden=kind!=='request';$('workspacePage').hidden=!['environments','relations','scripts','ribbons'].includes(kind);
    $('historyPage').hidden=kind!=='history';
    ribbonWorkspace.refresh();
    if(kind==='ribbons'){surfaceKey='ribbons';ribbonWorkspace.render(force);return;}
    if(kind==='scripts'){surfaceKey='scripts';scriptWorkspace.render(force);return;}
    if(kind==='history'){surfaceKey='';api.renderHistoryPage();return;}
    if(kind==='request'){surfaceKey='';return;}
    if(kind==='environments'&&!['globals','primary'].includes(envSelection)&&!w().environments.some(e=>e.id===envSelection))envSelection=w().environmentId||'';
    if(kind==='relations'&&!w().relations?.some(r=>r.id===relationId))relationId=w().relations?.[0]?.id||'';
    const key=kind+':'+(kind==='environments'?envSelection:relationId);
    if(force||surfaceKey!==key){surfaceKey=key;kind==='environments'?environmentPage():relationPage();}
  }
  function captureContext(context){creationContext=context;}
  function createItem(kind,context={}){
    const collection=w().collections.find(c=>c._mpId===context.collectionId),parent=context.parentId?findItem(collection,context.parentId)?.item:collection;
    if(!parent){if(kind==='request'){api.addDraft();return;}toast('追加先のコレクションを選択してください。');return;}
    let name=kind==='request'?'新しいリクエスト':'新しいフォルダー',placement='after';
    const box=el('div');box.append(field('名前',input(name,'追加する名前',value=>name=value)));
    box.append(el('p','workspace-note',`追加先: ${collection.info.name}${parent!==collection?' / '+parent.name:''}`));
    showModal(kind==='request'?'リクエストを追加':'フォルダーを追加',box,()=>{
      if(!name.trim())throw new Error('名前を入力してください。');
      const c=w().collections.find(c=>c._mpId===context.collectionId),p=context.parentId?findItem(c,context.parentId)?.item:c;
      if(!p||!Array.isArray(p.item))throw new Error('追加先が変更されました。追加先を選び直してください。');
      const sibling=p.item.findIndex(i=>i._mpId===context.siblingId);if(context.siblingId&&sibling<0)throw new Error('挿入位置の項目が削除されています。');
      const item={_mpId:uid(),name:name.trim(),...(kind==='folder'?{item:[]}:{request:newRequest()})};
      p.item.splice(context.siblingId?sibling+(placement==='after'?1:0):p.item.length,0,item);
      const ancestors=new Set([c._mpId,p._mpId,...(context.parentId?findItem(c,context.parentId)?.parents||[]:[]).map(node=>node._mpId)]);
      w().collapsed=(w().collapsed||[]).filter(id=>!ancestors.has(id));persist();closeModal();
      if(item.request)api.openRequest(c,item);else{captureContext({collectionId:c._mpId,parentId:item._mpId});setSurface('collections');api.renderAll();}
    },'追加');
  }
  function creationMenu(anchor,event,root=false){
    const side=api.side();if(side==='history')return;let actions;
    if(side==='environments')actions=[{label:'環境を作成',run:()=>createEnvironment()},{label:envSelection==='primary'?'一次変数を追加':envSelection==='globals'?'Globalsに変数を追加':'表示中の環境に変数を追加',disabled:!scopeRows(),run:()=>addVariable()}];
    else if(side==='scripts')actions=[{label:'スクリプトを作成',run:()=>scriptWorkspace.create()}];
    else if(side==='ribbons')actions=[{label:'リボンを作成',run:()=>ribbonWorkspace.create()}];
    else if(side==='relations')actions=[{label:'リレーションを作成',run:()=>createRelation()},{label:'ステップを追加',disabled:!w().relations?.some(r=>r.id===relationId),run:()=>chooseStep($('addRelationStep'),w().relations.find(r=>r.id===relationId))}];
    else {
      const context=root?null:creationContext;
      actions=[{label:context?'リクエストを追加':'リクエストを作成',run:()=>context?createItem('request',context):api.addDraft()},
        {label:'フォルダーを追加',disabled:!context,run:()=>createItem('folder',context)},
        {label:'コレクションを作成',run:api.newCollection}];
    }
    openItemMenu(anchor,actions,event);
  }
  function extractEnvironment(tab){
    const names=extractVariableNames(tab.request),ctx=contextFor(w(),tab);if(!names.length){toast('このリクエストには {{変数名}} がありません。');return;}
    let envId=w().environmentId||'__new__',newName='抽出した環境',overwrite=false;
    const box=el('div','extraction-dialog'),list=el('div','extraction-list');
    const nameField=field('新しい環境名',input(newName,'新しい環境名',value=>newName=value));
    const overwriteField=el('label','settings-line'),overwriteCheck=el('input');
    overwriteCheck.type='checkbox';overwriteCheck.onchange=()=>overwrite=overwriteCheck.checked;
    overwriteField.append(overwriteCheck,'既存の同名変数を上書き');
    function updateTarget(){nameField.hidden=envId!=='__new__';overwriteField.hidden=envId==='__new__';}
    const target=select([['__new__','新しい環境'],...w().environments.map(e=>[e.id,e.name])],envId,value=>{envId=value;updateTarget();});target.setAttribute('aria-label','抽出先環境');
    box.append(field('抽出先',target),nameField,overwriteField,list);
    const candidate=names.map(key=>({key,value:ctx.vars[key]??'',checked:true}));
    // Target changes do not replace candidate controls or discard edits/selection.
    for(const row of candidate){
      const line=el('div','extraction-candidate'),check=el('input'),label=el('label');
      check.id=uid();check.type='checkbox';check.checked=row.checked;check.onchange=()=>row.checked=check.checked;
      check.setAttribute('aria-label',`${row.key}を抽出`);label.htmlFor=check.id;label.append(el('code','',row.key));
      line.append(check,label,input(row.value,`${row.key}の値`,value=>row.value=value));list.append(line);
    }
    updateTarget();
    showModal('リクエストから環境変数を抽出',box,()=>{
      if(envId==='__new__'&&!newName.trim())throw new Error('環境名を入力してください。');
      const selected=candidate.filter(r=>r.checked);if(!selected.length)throw new Error('抽出する変数を選択してください。');
      let env=w().environments.find(e=>e.id===envId);if(!env&&envId!=='__new__')throw new Error('抽出先の環境が削除されています。');
      if(!env){env={id:uid(),name:newName.trim(),values:[]};w().environments.push(env);}
      let count=0;for(const row of selected)if(overwrite||!env.values.some(v=>v.key===row.key)){upsertVariable(env.values,row.key,row.value);count++;}
      persist();closeModal();editEnvironment(env);toast(`${count} 件を環境に抽出しました。`);
    },'抽出');
  }
  function referenceTab(collection,item){return api.findDraft(collection._mpId,item._mpId)||{id:item._mpId,collectionId:collection._mpId,itemId:item._mpId,name:item.name,request:item.request,settings:item.settings,...(item.ribbonState?{ribbonState:item.ribbonState}:{})};}
  function requestActions(collection,item){
    const tab=()=>referenceTab(collection,item),parent=findItem(collection,item._mpId)?.parents.at(-1);
    const context={collectionId:collection._mpId,parentId:parent?._mpId,siblingId:item._mpId};
    return [
      {label:'リクエストを追加',run:()=>createItem('request',context)},
      {label:'フォルダーを追加',run:()=>createItem('folder',context)},
      {label:'環境変数を抽出',run:()=>extractEnvironment(tab())},
      {label:'スクリプトを編集',run:()=>{api.openRequest(collection,item);api.selectEditorPage('scripts');}},
      {label:'リボンを編集',run:()=>{api.openRequest(collection,item);ribbonWorkspace.open();}},
      {label:'レスポンスから一次変数を抽出',disabled:!responseFor(tab()),run:()=>responseExtraction(tab())},
      {label:'リレーションに追加',run:()=>addRequestToRelation({collectionId:collection._mpId,itemId:item._mpId})},null];
  }
  function draftActions(tab){return [{label:'環境変数を抽出',run:()=>extractEnvironment(tab)},{label:'スクリプトを編集',run:()=>{api.selectRequest(tab.id);api.selectEditorPage('scripts');}},{label:'リボンを編集',run:()=>{api.selectRequest(tab.id);ribbonWorkspace.open();}},{label:'レスポンスから一次変数を抽出',disabled:!responseFor(tab),run:()=>responseExtraction(tab)},{label:'リレーションに追加',run:()=>addRequestToRelation({draftId:tab.id})}];}
  function responseExtraction(tab,choosePath=null){
    const result=responseFor(tab),metadata=responseMetadata(result);if(!metadata){toast('レスポンスを受信してから抽出してください。');return;}
    const {elements,truncated}=metadataElements(metadata);let path='/status',name='status',saveRule=false,nameEdited=false;
    const box=el('div','response-extraction'),list=el('div','metadata-tree');
    list.setAttribute('role','group');list.setAttribute('aria-label','レスポンス要素');
    const empty=el('p','metadata-empty','一致する要素がありません');empty.setAttribute('role','status');empty.hidden=true;
    const entries=[];
    const search=input('','レスポンス要素を検索',filterRows);search.type='search';
    const pathInput=input(path,'抽出パス',value=>{path=value;updateSelection();}),nameInput=input(name,'一次変数名',value=>{name=value;nameEdited=true;});
    const actions=btn('⋯',()=>{},'icon-button');actions.setAttribute('aria-label','選択要素の操作');actions.setAttribute('aria-haspopup','menu');
    actions.onclick=()=>{const entry=entries.find(item=>item.row.path===path);if(entry)openElementMenu(entry,actions);};
    function updateSelection(){
      const current=entries.find(item=>!item.button.hidden&&item.row.path===path)||entries.find(item=>!item.button.hidden);
      for(const entry of entries){const selected=entry.row.path===path;entry.button.classList.toggle('selected',selected);entry.button.setAttribute('aria-pressed',String(selected));entry.button.tabIndex=entry===current?0:-1;}
      actions.disabled=!entries.some(item=>item.row.path===path);
    }
    function pick(row){
      path=row.path;pathInput.value=path;
      if(!nameEdited){name=row.path.split('/').at(-1).replace(/~1/g,'/').replace(/~0/g,'~');nameInput.value=name;}
      updateSelection();
    }
    function openElementMenu(entry,anchor,event){openItemMenu(anchor,[
      {label:'選択',run:()=>pick(entry.row)},
      {label:'値をコピー',run:()=>api.copyText(entry.value)},
      {label:'パスをコピー',run:()=>api.copyText(entry.row.path)}
    ],event);}
    function filterRows(value){
      const query=value.toLowerCase();let count=0;
      for(const entry of entries){entry.button.hidden=Boolean(query&&!entry.searchText.includes(query));if(!entry.button.hidden)count++;}
      empty.hidden=count!==0;updateSelection();
    }
    // Keep the actual buttons alive: selection must preserve focus and scroll.
    for(const row of elements){
      const value=variableText(row.value),button=btn('',()=>pick(row),'metadata-row');
      const entry={row,value,button,searchText:`${row.path} ${value}`.toLowerCase()};entries.push(entry);
      button.dataset.path=row.path;button.append(el('code','metadata-path',row.path),el('span','metadata-type',row.type),el('span','metadata-value',value));button.title=value;
      button.oncontextmenu=event=>{event.preventDefault();event.stopPropagation();openElementMenu(entry,button,event);};
      button.onkeydown=event=>{
        if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();event.stopPropagation();openElementMenu(entry,button);return;}
        if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
        event.preventDefault();const visible=entries.filter(item=>!item.button.hidden),index=visible.indexOf(entry);
        const next=event.key==='Home'?0:event.key==='End'?visible.length-1:Math.max(0,Math.min(visible.length-1,index+(event.key==='ArrowUp'?-1:1)));
        if(visible[next]){pick(visible[next].row);visible[next].button.focus();}
      };
      list.append(button);
    }
    list.append(empty);
    box.append(el('p','response-source',`${tab.name} · ${result.status} · ${result.received_at ? new Date(result.received_at).toLocaleString() : '受信済み'}`),search,list);
    if(truncated)box.append(el('p','extraction-limit','先頭5,000要素を表示中。表示外の要素は抽出パスで指定できます。'));
    const pathRow=el('div','extraction-path');pathRow.append(field('抽出元（JSON Pointer）',pathInput),actions);box.append(pathRow);
    if(!choosePath){box.append(field('一次変数名',nameInput));const label=el('label','settings-line'),check=el('input');check.type='checkbox';check.onchange=()=>saveRule=check.checked;label.append(check,'受信時に抽出');box.append(label);}
    updateSelection();
    showModal(choosePath?'レスポンス要素を選択':'レスポンスから一次変数を抽出',box,()=>{
      if(choosePath){choosePath(path);closeModal();return;}
      const rule={id:uid(),name:name.trim(),path,enabled:true,missing:'keep'};primary.apply(extractionWrites([{...rule,missing:'error'}],metadata));
      if(saveRule){tab.request._minipost ||= {};tab.request._minipost.extractions ||= [];tab.request._minipost.extractions.push(rule);api.saveTab(tab);}
      closeModal();toast(`{{${rule.name}}} に取り込みました。`);
    },choosePath?'選択':'取り込む');
  }
  function renderScripts(root,tab){
    const config=requestAutomation(tab.request),save=()=>{tab.request._minipost={...config};api.touch();};
    const tools=el('div','script-tools'),enabledCheck=el('input');enabledCheck.type='checkbox';enabledCheck.checked=config.enabled;enabledCheck.onchange=()=>{config.enabled=enabledCheck.checked;save();};
    const enableLabel=el('label','settings-line');enableLabel.append(enabledCheck,'送信前・受信後に実行');tools.append(enableLabel);
    tools.append(field('制限時間 ms（0=無制限）',input(config.timeoutMs,'スクリプト制限時間',v=>{config.timeoutMs=Math.max(0,Number(v)||0);save();},'number')));root.append(tools);
    const phases=el('div','content-tabs script-phase-tabs');phases.setAttribute('role','tablist');phases.setAttribute('aria-label','スクリプトの実行タイミング');tools.prepend(phases);
    const help=btn('API',()=>scriptWorkspace.reference(),'text-button');help.setAttribute('aria-label','スクリプトAPIリファレンス');tools.append(help);
    const phaseNodes=[];
    function selectPhase(name){scriptPhases.set(requestKey(w(),tab),name);for(const item of phaseNodes){item.panel.hidden=item.phase!==name;item.tab.setAttribute('aria-selected',String(item.phase===name));item.tab.tabIndex=item.phase===name?0:-1;}}
    for(const [phase,title] of [['before','送信前'],['after','受信後']]){
      const panel=el('div','script-phase-panel');panel.id='script-panel-'+phase;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','script-tab-'+phase);
      const tabButton=btn(title,()=>selectPhase(phase));tabButton.id='script-tab-'+phase;tabButton.setAttribute('role','tab');tabButton.setAttribute('aria-controls',panel.id);phases.append(tabButton);phaseNodes.push({phase,panel,tab:tabButton});root.append(panel);
      const run=btn('実行',async()=>{
        run.disabled=true;
        try {
          const scriptId=config[`${phase}ScriptId`],saved=scriptId?w().scripts.find(item=>item.id===scriptId):null;
          if(scriptId&&!saved)throw new Error('選択したスクリプトが見つかりません。');
          await runContextScript(tab,{source:saved?saved.source:config[phase],scriptId,timeoutMs:saved?saved.timeoutMs:config.timeoutMs,phase});
        }catch(error){toast(error.message);}finally{run.disabled=false;}
      },'button');run.setAttribute('aria-label','スクリプトを実行');run.title='スクリプトを実行';
      const scriptId=config[`${phase}ScriptId`],saved=scriptId?w().scripts.find(item=>item.id===scriptId):null;
      const picker=el('div','script-hook-picker');
      const options=[['','直接入力'],...w().scripts.map(script=>[script.id,script.name])];
      if(scriptId&&!saved)options.push([scriptId,'削除されたスクリプト']);
      const choose=select(options,scriptId||'',value=>{config[`${phase}ScriptId`]=value;save();api.renderEditor();});choose.setAttribute('aria-label',`${title}に実行するスクリプト`);picker.append(choose);
      let code;
      if(scriptId){
        let embedded;const edit=btn('編集',()=>embedded.edit(),'button');edit.setAttribute('aria-label',`${title}スクリプトを編集`);
        embedded=createEmbeddedScriptEditor({workspace:w,primary,scriptId:()=>config[`${phase}ScriptId`],persist,preview:true,label:`${title}スクリプト`,
          intelligenceContext:()=>scriptEditorContext(w(),primary,{tab,result:responseFor(tab),phase}),
          onState:state=>{edit.disabled=!state.available;edit.setAttribute('aria-pressed',String(state.editing));},onError:error=>toast(error.message)});
        picker.append(edit);code=embedded.element;
      }else{
        picker.append(btn('独立して保存',()=>scriptWorkspace.create(null,config[phase],`${tab.name} ${title}`,script=>{if(config.scriptBindingId)script.bindingId=config.scriptBindingId;config[`${phase}ScriptId`]=script.id;save();}),'button'));
        code=createCodeEditor({value:config[phase],language:'javascript',intellisense:true,intelligenceContext:()=>scriptEditorContext(w(),primary,{tab,result:responseFor(tab),phase}),label:`${title}スクリプト`,onChange:value=>{config[phase]=value;save();}}).element;
      }
      picker.append(run);panel.append(picker,code);
    }
    selectPhase(scriptPhases.get(requestKey(w(),tab))||'before');
    phases.onkeydown=event=>{const current=phaseNodes.findIndex(item=>item.tab===event.target);if(current<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?1:(current+1)%2;phaseNodes[next].tab.click();phaseNodes[next].tab.focus();};
    const log=el('pre','script-log');log.id='scriptLog';log.setAttribute('role','status');const prior=scriptLogs.get(requestKey(w(),tab));log.textContent=scriptLogText(prior);root.append(log);
    if(config.extractions.length){const rules=el('div','extraction-rules');rules.append(el('h3','','受信時の自動抽出'));for(const rule of config.extractions){const line=el('div','extraction-rule'),checkbox=el('input');checkbox.type='checkbox';checkbox.checked=rule.enabled!==false;checkbox.onchange=()=>{rule.enabled=checkbox.checked;save();};line.append(checkbox,input(rule.name,'抽出する変数名',v=>{rule.name=v;save();}),input(rule.path,'抽出元のパス',v=>{rule.path=v;save();}),select([['keep','欠損時: 前値維持'],['empty','欠損時: 空文字'],['error','欠損時: エラー']],rule.missing||'keep',v=>{rule.missing=v;save();}),btn('削除',()=>{config.extractions=config.extractions.filter(r=>r!==rule);save();api.renderEditor();},'text-button'));rules.append(line);}root.append(rules);}
    const imported=contextFor(w(),tab).events;
    if(imported.length){const details=el('details','imported-scripts');details.append(el('summary','','インポートしたスクリプト'));for(const event of imported){const source=Array.isArray(event.script?.exec)?event.script.exec.join('\n'):event.script?.exec||'';const section=el('section','scripts-block');section.append(el('h4','',event.listen||'Script'),el('pre','',source),btn('編集欄へコピー',()=>{const key=event.listen==='prerequest'?'before':'after';config[key]+=(config[key]?'\n':'')+source;save();api.renderEditor();},'button'));details.append(section);}root.append(details);}
  }
  function requestOptions(){
    const options=[];for(const c of w().collections)walkItems(c.item,(item,parents)=>{if(item.request)options.push([JSON.stringify({collectionId:c._mpId,itemId:item._mpId}),`${c.info.name} / ${[...parents.map(p=>p.name),item.name].join(' / ')}`]);});
    for(const tab of w().tabs)if(!w().collections.some(c=>c._mpId===tab.collectionId&&findItem(c,tab.itemId)?.item.request))options.push([JSON.stringify({draftId:tab.id}),`下書き / ${tab.name}`]);return options;
  }
  function openRelation(id){relationId=id;surfaceKey='';setSurface('relations');$('workspacePage').querySelector('input[aria-label="リレーション名"]')?.focus({preventScroll:true});}
  function createRelation(afterId=null,reference=null){let name='新しいリレーション';const box=field('リレーション名',input(name,'リレーション名',v=>name=v));showModal('リレーションを作成',box,()=>{if(!name.trim())throw new Error('名前を入力してください。');const relation=newRelation(name.trim());if(reference)relation.steps.push(newStep(reference));const at=w().relations.findIndex(r=>r.id===afterId);w().relations.splice(afterId&&at>=0?at+1:w().relations.length,0,relation);persist();closeModal();openRelation(relation.id);},'作成');}
  function duplicateRelation(relation){const copy=clone(relation);copy.id=uid();copy.name+=' copy';copy.steps=cloneRelationSteps(copy.steps);w().relations.splice(w().relations.indexOf(relation)+1,0,copy);persist();openRelation(copy.id);}
  function addRequestToRelation(reference){
    if(!w().relations.length){createRelation(null,reference);return;}
    let id=w().relations[0].id;const box=field('追加先',select([...w().relations.map(r=>[r.id,r.name]),['__new__','新しいリレーション']],id,v=>id=v));showModal('リレーションに追加',box,()=>{closeModal();if(id==='__new__')createRelation(null,reference);else{const relation=w().relations.find(r=>r.id===id);if(!relation)return;relation.steps.push(newStep(reference));persist();openRelation(id);}},'追加');
  }
  const collapsedSteps=new Set();
  function relationDestination(relation,siblings,index=siblings.length){
    if(siblings===relation.steps)return {index};
    const owner=relationStepLocations(relation).find(entry=>entry.step.steps===siblings||entry.step.elseSteps===siblings);
    if(!owner)throw new Error('追加先のブロックがありません。');
    return {parentId:owner.step.id,branch:owner.step.steps===siblings?'steps':'elseSteps',index};
  }
  function chooseStep(anchor,relation,siblings=relation.steps,index=siblings.length,onChoose=()=>{}){
    const loopDepth=(list,depth=0)=>{
      if(list===siblings)return depth;
      for(const step of list){
        if(step.steps){const found=loopDepth(step.steps,depth+Number(['repeat','forEach','while'].includes(relationStepType(step))));if(found!==undefined)return found;}
        if(step.elseSteps){const found=loopDepth(step.elseSteps,depth);if(found!==undefined)return found;}
      }
    };
    const insideLoop=loopDepth(relation.steps)>0;
    openItemMenu(anchor,RELATION_STEP_TYPES.map(([type,label])=>({label,disabled:['break','continue'].includes(type)&&!insideLoop,run:()=>{onChoose();addStep(relation,index,siblings,type);}})));
  }
  function addStep(relation,index=relation.steps.length,siblings=relation.steps,type='request'){
    const step=newRelationStep(type);try{insertRelationStep(relation,step,relationDestination(relation,siblings,index));}catch(error){toast(error.message);return;}
    persist();surfaceKey='';syncView('relations');api.closeNavigation();
    const row=[...$('workspacePage').querySelectorAll('.relation-step')].find(e=>e.dataset.stepId===step.id);
    (row?.querySelector('select,input')||row?.querySelector('button'))?.focus({preventScroll:true});row?.scrollIntoView({block:'nearest'});
  }
  function numberField(title,value,change,min=0){
    const control=input(value,title,v=>change(Number(v)),'number');control.min=String(min);control.step='1';return field(title,control);
  }
  function relationSettings(relation){
    const value={repeat:relation.repeat,intervalMs:relation.intervalMs,maxExecutions:relation.maxExecutions||0,environmentId:relation.environmentId||'',stopOnError:relation.stopOnError};
    const box=el('div','relation-settings-form');
    box.append(numberField('全体の回数',value.repeat,v=>value.repeat=v,1),numberField('全体の間隔 ms',value.intervalMs,v=>value.intervalMs=v),numberField('最大実行数（0=無制限）',value.maxExecutions,v=>value.maxExecutions=v));
    const env=select([['','選択中の環境'],...w().environments.map(e=>[e.id,e.name])],value.environmentId,v=>value.environmentId=v);
    env.setAttribute('aria-label','使用する環境');box.append(field('使用する環境',env));
    const stop=el('label','settings-line'),check=el('input');check.type='checkbox';check.checked=value.stopOnError;check.onchange=()=>value.stopOnError=check.checked;stop.append(check,'エラーで停止');box.append(stop);
    showModal('実行設定',box,()=>{
      for(const [key,min] of [['repeat',1],['intervalMs',0],['maxExecutions',0]])if(!Number.isSafeInteger(value[key])||value[key]<min)throw new Error('回数と時間を有効な整数にしてください。');
      Object.assign(relation,value);persist();closeModal();
    },'保存');
  }
  function relationPage(){
    const page=$('workspacePage'),relation=w().relations.find(r=>r.id===relationId);page.replaceChildren();
    if(!relation){const empty=el('div','workspace-empty');empty.append(el('h1','','リレーション'),btn('リレーションを作成',()=>createRelation(),'button primary'));page.append(empty);return;}
    const header=el('div','workspace-page-heading relation-page-heading'),name=input(relation.name,'リレーション名',v=>{relation.name=v;persist();api.renderSidebar();});header.append(el('h1','','リレーション'),name);
    const start=btn('実行',()=>startRelation(relation),'button primary');start.id='runRelation';start.disabled=Boolean(controller);
    const stopButton=btn('停止',()=>controller?.abort(),'button');stopButton.id='stopRelationLocal';stopButton.disabled=!(controller&&running?.relationId===relation.id);
    const add=btn('追加 ▾',event=>chooseStep(event.currentTarget,relation),'button');add.id='addRelationStep';add.setAttribute('aria-label','ステップを追加');
    const more=btn('⋯',event=>openItemMenu(event.currentTarget,[{label:'実行設定',run:()=>relationSettings(relation)},{label:'変更履歴',run:()=>api.showRevisions('relation:'+relation.id)},{label:'エクスポート',run:()=>api.exportFile(relation.name+'.relation.json',relation)}]),'icon-button');more.setAttribute('aria-label','リレーションの操作');
    header.append(start,stopButton,add,more);page.append(header);
    const editor=el('div','relation-editor');editor.id='relationSteps';editor.setAttribute('aria-label','実行手順');const options=requestOptions(),save=()=>persist();
    let draggedStepId=null;
    const repaint=(focusId=null,action=null)=>{
      const scroll=page.scrollTop;persist();surfaceKey='';syncView('relations');page.scrollTop=scroll;
      const node=[...page.querySelectorAll('.relation-step')].find(e=>e.dataset.stepId===focusId);
      const control=action?node?.querySelector('[data-step-action="'+action+'"]'):node?.querySelector('select,input');
      const alternate=action?node?.querySelector('[data-step-action="'+(action==='up'?'down':'up')+'"]'):null;
      (control&&!control.disabled&&control.getClientRects().length?control:alternate&&!alternate.disabled&&alternate.getClientRects().length?alternate:node?.querySelector('[data-step-action="move"]')||node?.querySelector('select,input')||page.querySelector('#addRelationStep'))?.focus({preventScroll:true});
    };
    const blockTypes=new Set(['repeat','forEach','while','if']);
    const location=id=>relationStepLocations(relation).find(entry=>entry.step.id===id);
    const outerDestination=step=>{
      const entry=location(step.id);if(!entry?.parent)return null;
      const parent=location(entry.parent.id);return relationDestination(relation,parent.siblings,parent.index+1);
    };
    const innerDestination=step=>{
      const entry=location(step.id),previous=entry?.siblings.slice(0,entry.index).reverse().find(value=>blockTypes.has(relationStepType(value)));
      return previous?{parentId:previous.id,branch:'steps'}:null;
    };
    const moveStep=(step,target,action='move')=>{
      if(!target||!canMoveRelationStep(relation,step.id,target))return;
      try{
        moveRelationStep(relation,step.id,target);for(const id of location(step.id).ancestors)collapsedSteps.delete(id);repaint(step.id,action);
      }catch(error){toast(error.message);}
    };
    const destinations=step=>{
      const targets=[{label:'最上位',target:{}}];
      for(const entry of relationStepLocations(relation))if(blockTypes.has(relationStepType(entry.step))){
        const kind=relationStepType(entry.step),title=RELATION_STEP_TYPES.find(([type])=>type===kind)?.[1]||kind;
        for(const branch of kind==='if'?['steps','elseSteps']:['steps'])targets.push({label:'ステップ '+entry.label+' '+title+(kind==='if'?' · '+(branch==='steps'?'成立':'不成立'):''),target:{parentId:entry.step.id,branch}});
      }
      return targets.filter(({target})=>canMoveRelationStep(relation,step.id,target));
    };
    const moveMenu=(anchor,step)=>{
      const choices=destinations(step);if(!choices.length)return toast('移動先のブロックがありません。');
      openItemMenu(anchor,choices.map(({label,target})=>({label,run:()=>moveStep(step,target)})));
    };
    const wrapMenu=(anchor,step)=>openItemMenu(anchor,RELATION_STEP_TYPES.filter(([type])=>blockTypes.has(type)).map(([type,label])=>({label,run:()=>{
      try{const wrapper=wrapRelationStep(relation,step.id,type);collapsedSteps.delete(wrapper.id);repaint(step.id,'move');}catch(error){toast(error.message);}
    }})));
    const clearDropTargets=()=>{for(const node of editor.querySelectorAll('.drop-target,.drop-before,.drop-after'))node.classList.remove('drop-target','drop-before','drop-after');editor.classList.remove('drop-target');};
    const draggedId=event=>draggedStepId||event.dataTransfer?.getData('application/x-minipost-relation-step')||event.dataTransfer?.getData('text/plain');
    function dropArea(node,target){
      node.ondragover=event=>{
        const id=draggedId(event);if(!id)return;event.preventDefault();event.stopPropagation();clearDropTargets();
        const allowed=canMoveRelationStep(relation,id,target());event.dataTransfer.dropEffect=allowed?'move':'none';if(allowed)node.classList.add('drop-target');
      };
      node.ondragleave=event=>{if(!node.contains(event.relatedTarget))node.classList.remove('drop-target');};
      node.ondrop=event=>{
        const id=draggedId(event);if(!id)return;event.preventDefault();event.stopPropagation();clearDropTargets();
        const step=location(id)?.step;if(step)moveStep(step,target());draggedStepId=null;
      };
    }
    function conditionEditor(step,label,siblings,request){
      const condition=step.condition,branch=el('div','step-branch');
      const source=select([['response','レスポンス'],['primary','一次変数'],['variables','変数'],['result','スクリプト結果']],condition.source,v=>{condition.source=v;save();});source.setAttribute('aria-label','ステップ '+label+' の分岐元');
      const path=input(condition.path,'ステップ '+label+' の比較元',v=>{condition.path=v;save();});
      const op=select(OPERATORS,condition.operator,v=>{condition.operator=v;save();});op.setAttribute('aria-label','ステップ '+label+' の比較');
      const pathRow=el('div','step-branch-path');pathRow.append(path);
      if(request){
        const meta=btn('⋯',()=>{
          const c=w().collections.find(c=>c._mpId===step.collectionId),item=findItem(c,step.itemId)?.item,tab=item?referenceTab(c,item):w().tabs.find(t=>t.id===step.draftId);
          if(!tab)return toast('リクエストを選択してください。');
          responseExtraction(tab,value=>{condition.path=value;path.value=value;save();});
        },'icon-button');meta.setAttribute('aria-label','受信済みの要素から選択');pathRow.append(meta);
      }
      branch.append(field('参照元',source),field('値 / パス',pathRow),field('比較',op),field('比較値',input(condition.value,'比較する値 / {{変数}}',v=>{condition.value=v;save();})));
      if(request){
        const targets=[[NEXT,'次へ'],[END,'全体の次の回へ'],...siblings.map((s,n)=>[s.id,'ステップ '+label.split('.').slice(0,-1).concat(n+1).join('.')])];
        for(const [key,title] of [['onTrue','条件成立時'],['onFalse','不成立時']]){
          const control=select(targets,step[key],v=>{step[key]=v;save();});control.setAttribute('aria-label','ステップ '+label+' の'+title);
          const wrap=field(title,control);wrap.classList.add('step-branch-target');branch.append(wrap);
        }
      }
      return branch;
    }
    function renderSteps(siblings,parent,prefix=''){
      for(const [index,step] of siblings.entries()){
        const type=relationStepType(step),label=prefix+(index+1),group=['repeat','forEach','while','if'].includes(type);
        const row=el('section','relation-step'+(group?' relation-group':''));row.dataset.stepId=step.id;row.dataset.stepType=type;
        const top=el('div','relation-step-heading'),drag=btn('⠿',event=>moveMenu(event.currentTarget,step),'step-drag icon-button');drag.draggable=true;drag.title='移動 · Alt+矢印';drag.dataset.stepAction='move';drag.setAttribute('aria-label','ステップ '+label+' を移動');
        drag.ondragstart=event=>{event.stopPropagation();draggedStepId=step.id;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-minipost-relation-step',step.id);event.dataTransfer.setData('text/plain',step.id);};
        drag.ondragend=()=>{draggedStepId=null;clearDropTargets();};top.append(drag,el('strong','step-number',label));
        const body=el('div','relation-step-body');body.id='relation-body-'+step.id;
        if(type==='request'){
          const value=JSON.stringify(step.draftId?{draftId:step.draftId}:{collectionId:step.collectionId,itemId:step.itemId});
          const picker=select([['','リクエストを選択'],...options],options.some(([v])=>v===value)?value:'',v=>{delete step.draftId;step.collectionId='';step.itemId='';if(v)Object.assign(step,JSON.parse(v));save();});picker.setAttribute('aria-label','ステップ '+label+' のリクエスト');top.append(picker);
        }else{
          const title=RELATION_STEP_TYPES.find(([kind])=>kind===type)?.[1]||type;
          if(group){
            const toggle=btn(title,()=>{body.hidden=!body.hidden;body.hidden?collapsedSteps.add(step.id):collapsedSteps.delete(step.id);toggle.setAttribute('aria-expanded',String(!body.hidden));},'relation-kind');toggle.setAttribute('aria-label','ステップ '+label+' '+title);toggle.setAttribute('aria-controls',body.id);body.hidden=collapsedSteps.has(step.id);toggle.setAttribute('aria-expanded',String(!body.hidden));top.append(toggle);
          }else top.append(el('strong','relation-kind',title));
        }
        const move=delta=>{const at=siblings.indexOf(step),to=at+delta;if(to<0||to>=siblings.length)return;moveStep(step,relationDestination(relation,siblings,to+Number(delta>0)),delta<0?'up':'down');};
        const up=btn('↑',()=>move(-1),'icon-button'),down=btn('↓',()=>move(1),'icon-button');
        up.setAttribute('aria-label','ステップ '+label+' を上へ');down.setAttribute('aria-label','ステップ '+label+' を下へ');up.dataset.stepAction='up';down.dataset.stepAction='down';up.disabled=index===0;down.disabled=index===siblings.length-1;
        const more=btn('⋯',()=>{},'icon-button');more.setAttribute('aria-label','ステップ '+label+' の操作');top.append(up,down,more);
        const remove=()=>{
          const removed=new Set();walkRelationSteps([step],child=>removed.add(child.id));
          const at=siblings.indexOf(step);siblings.splice(at,1);
          walkRelationSteps(relation.steps,child=>{for(const key of ['onTrue','onFalse'])if(removed.has(child[key]))child[key]=NEXT;});
          repaint(siblings[Math.min(at,siblings.length-1)]?.id);
        };
        bindContext(row,more,(a,e)=>{
          const outside=outerDestination(step);
          openItemMenu(a,[
            {label:'ステップを追加',run:()=>chooseStep(a,relation,siblings,siblings.indexOf(step)+1)},
            {label:'ブロックで囲む',run:()=>wrapMenu(a,step)},
            {label:'ブロックへ移動',disabled:!destinations(step).length,run:()=>moveMenu(a,step)},
            {label:'外へ移動',disabled:!outside||!canMoveRelationStep(relation,step.id,outside),run:()=>moveStep(step,outside)},
            {label:'上へ',disabled:siblings.indexOf(step)===0,run:()=>move(-1)},
            {label:'下へ',disabled:siblings.indexOf(step)===siblings.length-1,run:()=>move(1)},
            {label:'複製',run:()=>{try{const copied=cloneRelationSteps([step])[0];insertRelationStep(relation,copied,relationDestination(relation,siblings,siblings.indexOf(step)+1));repaint(copied.id);}catch(error){toast(error.message);}}},
            {label:'削除',danger:true,run:remove}
          ],e);
        });row.append(top,body);
        row.addEventListener('keydown',event=>{
          if(!event.altKey||event.ctrlKey||event.metaKey||event.target.closest('input,textarea,select,[contenteditable=true]')||event.target.closest('.relation-step')!==row||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key))return;
          event.preventDefault();event.stopPropagation();
          if(event.key==='ArrowUp')move(-1);else if(event.key==='ArrowDown')move(1);else moveStep(step,event.key==='ArrowLeft'?outerDestination(step):innerDestination(step));
        });
        const rowDestination=event=>relationDestination(relation,siblings,siblings.indexOf(step)+Number(event.clientY>=row.getBoundingClientRect().top+row.getBoundingClientRect().height/2));
        row.ondragover=event=>{
          const id=draggedId(event);if(!id)return;event.preventDefault();event.stopPropagation();clearDropTargets();const target=rowDestination(event),allowed=canMoveRelationStep(relation,id,target);
          event.dataTransfer.dropEffect=allowed?'move':'none';if(allowed)row.classList.add(target.index===siblings.indexOf(step)?'drop-before':'drop-after');
        };
        row.ondragleave=event=>{if(!row.contains(event.relatedTarget))row.classList.remove('drop-before','drop-after');};
        row.ondrop=event=>{const id=draggedId(event);if(!id)return;event.preventDefault();event.stopPropagation();clearDropTargets();const moving=location(id)?.step;if(moving)moveStep(moving,rowDestination(event));draggedStepId=null;};
        if(type==='request'){
          const timing=el('div','step-timing');timing.append(numberField('開始前 ms',step.delayMs,v=>{step.delayMs=v;save();}),numberField('回数',step.repeat,v=>{step.repeat=v;save();},1),numberField('間隔 ms',step.intervalMs,v=>{step.intervalMs=v;save();}));
          const check=el('input');check.type='checkbox';check.checked=step.condition.enabled;check.setAttribute('aria-label','ステップ '+label+' の条件分岐');const checkLabel=el('label','settings-line');checkLabel.append(check,'条件分岐');timing.append(checkLabel);
          const branch=conditionEditor(step,label,siblings,true);branch.hidden=!step.condition.enabled;check.onchange=()=>{step.condition.enabled=check.checked;branch.hidden=!check.checked;save();};body.append(timing,branch);
        }else if(type==='script'){
          let embedded;
          const fields=el('div','step-fields'),picker=select([['','スクリプトを選択'],...w().scripts.map(script=>[script.id,script.name])],step.scriptId,v=>{step.scriptId=v;save();embedded?.refresh();});picker.setAttribute('aria-label','ステップ '+label+' のスクリプト');
          const pickerLine=el('div','relation-script-picker'),edit=btn('編集',()=>embedded?.edit(),'text-button');edit.setAttribute('aria-label','ステップ '+label+' のスクリプトを編集');pickerLine.append(picker,edit);
          const format=select([['saved','保存した入力'],['json','JSON'],['text','テキスト'],['response','レスポンス']],step.inputFormat,v=>{step.inputFormat=v;payload.hidden=!['json','text'].includes(v);save();});format.setAttribute('aria-label','ステップ '+label+' の入力形式');
          const payload=field('入力',input(step.input,'ステップ '+label+' の入力',v=>{step.input=v;save();}));payload.classList.add('step-wide');payload.hidden=!['json','text'].includes(step.inputFormat);
          embedded=createEmbeddedScriptEditor({workspace:w,primary,scriptId:()=>step.scriptId,persist,label:'ステップ '+label+' のコード',onState:state=>edit.disabled=!state.available,onError:error=>toast(error.message)});
          fields.append(field('スクリプト',pickerLine),field('入力形式',format),field('結果の変数',input(step.resultVariable,'ステップ '+label+' の結果の変数',v=>{step.resultVariable=v;save();})),payload);body.append(fields,embedded.element);
        }else if(type==='wait')top.insertBefore(numberField('待機 ms',step.delayMs,v=>{step.delayMs=v;save();}),up);
        else if(group){
          const fields=el('div','step-fields'+(type==='forEach'?' step-array-fields':type!=='if'?' step-loop-fields':''));
          if(type==='repeat')fields.append(numberField('回数',step.repeat,v=>{step.repeat=v;save();},1));
          if(type==='while')fields.append(numberField('上限回数',step.maxIterations,v=>{step.maxIterations=v;save();},1));
          if(type==='forEach'){
            const source=select([['literal','JSON'],['primary','一次変数'],['response','レスポンス'],['variables','変数'],['result','スクリプト結果']],step.source,v=>{step.source=v;literal.hidden=v!=='literal';path.hidden=v==='literal';save();});source.setAttribute('aria-label','ステップ '+label+' の配列元');
            const literal=field('配列',input(step.value,'ステップ '+label+' の配列',v=>{step.value=v;save();})),path=field('値 / パス',input(step.path,'ステップ '+label+' の配列パス',v=>{step.path=v;save();}));
            literal.classList.add('step-wide');path.classList.add('step-wide');literal.hidden=step.source!=='literal';path.hidden=step.source==='literal';
            fields.append(field('参照元',source),field('要素の変数',input(step.itemVariable,'ステップ '+label+' の要素の変数',v=>{step.itemVariable=v;save();})),field('番号の変数',input(step.indexVariable,'ステップ '+label+' の番号の変数',v=>{step.indexVariable=v;save();})),numberField('間隔 ms',step.intervalMs,v=>{step.intervalMs=v;save();}),literal,path);
          }
          if(type==='repeat'||type==='while')fields.append(numberField('間隔 ms',step.intervalMs,v=>{step.intervalMs=v;save();}));
          if(fields.children.length)body.append(fields);
          if(type==='while'||type==='if')body.append(conditionEditor(step,label,siblings,false));
          for(const [key,title,suffix] of type==='if'?[['steps','成立','T.'],['elseSteps','不成立','F.']]:[['steps','処理','']]){
            const block=el('div','relation-block');block.dataset.branch=key;block.dataset.parentStepId=step.id;block.dataset.empty=String(!step[key].length);block.setAttribute('role','group');block.setAttribute('aria-label','ステップ '+label+' の'+title);
            const addChild=btn('追加 ▾',event=>chooseStep(event.currentTarget,relation,step[key],step[key].length,()=>collapsedSteps.delete(step.id)),'text-button');addChild.setAttribute('aria-label','ステップ '+label+' の'+title+'に追加');
            const heading=el('div','relation-block-heading');heading.append(el('strong','',type==='if'?title:'繰り返す処理'),addChild);block.append(heading);
            dropArea(block,()=>({parentId:step.id,branch:key}));renderSteps(step[key],block,label+'.'+suffix);body.append(block);
          }
        }
        parent.append(row);
      }
    }
    renderSteps(relation.steps,editor);
    dropArea(editor,()=>({}));
    editor.oncontextmenu=event=>{if(event.defaultPrevented||event.target.closest('.relation-step,input,select'))return;event.preventDefault();openItemMenu(editor,[{label:'ステップを追加',run:()=>chooseStep(editor,relation)}],event);};
    page.append(editor);const log=el('section','relation-log');log.id='relationRunLog';log.setAttribute('aria-live','polite');page.append(log);renderRunLog();
  }
  function stopRelation(){controller?.abort();for(const manual of manualControllers)manual.abort();scriptWorkspace.stop();ribbonWorkspace.stop();}
  function renderRunLog(){
    const root=$('relationRunLog');if(!root)return;
    const run=running?.relationId===relationId?running:[...(w().relationRuns||[])].reverse().find(r=>r.relationId===relationId);
    const start=$('runRelation');if(start)start.disabled=Boolean(controller);
    const stop=$('stopRelationLocal');if(stop)stop.disabled=!(controller&&running?.relationId===relationId);
    root.replaceChildren();root.hidden=!run;if(!run)return;
    const labels={running:'実行中',succeeded:'完了',failed:'失敗',cancelled:'停止',completed_with_errors:'エラーあり'};
    const heading=el('div','section-tools');heading.append(el('h2','','実行結果 · '+(labels[run.status]||run.status)),btn('ログを保存',()=>api.exportFile('relation-run.json',run),'text-button'));root.append(heading);
    if(run.error)root.append(el('p','error',run.error));
    const table=el('table','run-table'),head=el('tr');for(const title of ['回','ステップ','処理','結果','時間','詳細'])head.append(el('th','',title));table.append(head);
    for(const entry of run.entries){
      const row=el('tr',entry.status),branch=entry.branch;
      const detail=entry.error||(branch?(branch.matched?'成立':'不成立')+' → '+(branch.target===NEXT?'次へ':branch.target===END?'全体の次の回へ':'ステップ '+(branch.targetIndex+1)):entry.loops?.map(loop=>loop.iteration+' 周目').join(' / ')||'');
      for(const value of [entry.round,entry.stepPath||entry.index+1,entry.requestName,entry.httpStatus?entry.httpStatus+' · '+(labels[entry.status]||entry.status):labels[entry.status]||entry.status,entry.elapsed_ms!=null?entry.elapsed_ms+' ms':'',detail])row.append(el('td','',String(value??'')));
      table.append(row);
    }
    root.append(table);for(const node of $('relationSteps')?.querySelectorAll('.relation-step')||[])node.classList.toggle('running',run.status==='running'&&node.dataset.stepId===run.current?.stepId);
  }
  async function startRelation(relation){
    if(controller)return toast('実行中のリレーションを停止してから開始してください。');
    const target=w(),chosenEnv=relation.environmentId||target.environmentId;
    if(chosenEnv&&!target.environments.some(e=>e.id===chosenEnv))return toast('選択した環境が削除されています。');
    controller=new AbortController();running={relationId:relation.id,name:relation.name,status:'running',entries:[]};refreshStop();renderRunLog();
    const ensureWorkspace=()=>{if(w()!==target)throw new Error('ワークスペースが変更されたため、実行を停止しました。');};
    const scriptCatalog=clone(target.scripts||[]),bindings=clone(target.scriptBindings||{});
    try{
      const result=await runRelation(relation,{workspace:target,primary:()=>primary.snapshot(),variables:tab=>contextFor({...target,environmentId:chosenEnv},tab||{request:newRequest()},primary.rows).vars,signal:controller.signal,
        capturePrimary:keys=>{const restore=primary.capture(keys);return ()=>{restore();ribbonWorkspace.refresh();};},
        writePrimary:writes=>{primary.apply(writes);ribbonWorkspace.refresh();},
        execute:async(tab,{signal})=>{ensureWorkspace();const response=await execute(tab,{signal,environmentId:chosenEnv,files:api.filesFor(tab,signal),relationAncestors:[relation.id]});ensureWorkspace();api.recordBackground(tab,response,chosenEnv);return response;},
        executeScript:async(script,{signal,input:payload,raw})=>{
          ensureWorkspace();const context=makeScriptContext(target,primary,{input:payload,scriptId:script.id,result:raw,environmentId:chosenEnv});
          context.scripts=clone(scriptCatalog);context.bindings=clone(bindings);
          context.workspace.scripts=clone(scriptCatalog);context.workspace.scriptBindings=clone(bindings);
          const host=createScriptHost({workspace:target,primary,environmentId:chosenEnv,filesFor:api.filesFor,getResponses,runRelation:(next,context)=>runScriptRelation(next,{...context,ancestorRelationIds:[relation.id]}),onResponse:(tab,response,env)=>{rememberResponse(tab,response);api.recordBackground(tab,response,env);}});
          const output=await runScript(script.source,context,{signal,timeoutMs:script.timeoutMs,onCall:host});
          if(signal.aborted)throw new DOMException('スクリプトを停止しました。','AbortError');ensureWorkspace();
          if(output.request||output.response)throw new Error('リレーションのスクリプトではリクエスト・レスポンスを書き換えられません。');
          const environment=target.environments.find(env=>env.id===chosenEnv);
          if(applyScriptWrites(target,primary,environment,output))persist();api.workspaceChanged?.(output);ribbonWorkspace.refresh();return output;
        },onProgress:run=>{running=run;renderRunLog();}});
      ensureWorkspace();target.relationRuns.push(clone(result));persist();
    }catch(error){running={relationId:relation.id,name:relation.name,status:'failed',entries:running?.entries||[],error:error.message};toast(error.message);}
    finally{controller=null;refreshStop();renderRunLog();api.renderSidebar();}
  }
  function refreshForChanges(output){
    const flatten=value=>value?.stages?value.stages.flatMap(flatten):value?[value]:[],stages=flatten(output);
    const patches=stages.flatMap(stage=>stage.workspaceWrites||[]),roots=new Set(patches.map(change=>change.path[0]));
    const affects=(root,id)=>patches.some(change=>change.path[0]===root&&(change.kind!=='order'||change.path.length>1)&&(!change.path[1]||change.path[1].id===id));
    if(roots.has('scripts'))refreshEmbeddedScriptEditors(w());
    if(api.side()==='scripts')scriptWorkspace.refreshForChanges(output);
    if(api.side()==='relations'&&affects('relations',relationId)){surfaceKey='';syncView('relations');}
    if(api.side()==='environments'){
      let changed=envSelection==='globals'?roots.has('globals'):envSelection==='primary'?stages.some(stage=>stage.writes?.primary?.length||stage.primaryRowsWrites?.length):affects('environments',envSelection);
      if(roots.has('environmentId')&&!['primary','globals'].includes(envSelection)){envSelection=w().environmentId||'';changed=true;}
      if(changed){surfaceKey='';syncView('environments');}
    }
    ribbonWorkspace.refresh();
  }
  $('stopRelationGlobal').onclick=stopRelation;
  $('requestRibbonEdit').onclick=()=>ribbonWorkspace.open();
  $('extractResponse').onclick=()=>responseExtraction(api.active());
  if($('responseActions'))bindContext($('responseContent'),$('responseActions'),responseMenu);
  $('sidebarContent').addEventListener('contextmenu',event=>{if(event.defaultPrevented||event.target.closest('.tree-row,.history-entry,input'))return;event.preventDefault();creationMenu($('sidebarContent'),event,true);});
  return {primary,execute,rememberResponse,responseFor,transferResponse,forgetResponse,syncView,renderSidebarSection,editEnvironment,environmentChosen,refreshForChanges,
    createEnvironment,creationMenu,createItem,captureContext,requestActions,draftActions,renderScripts,responseExtraction,runResponseScript,addRequestToRelation,
    scriptKeydown:scriptWorkspace.keydown,
    refreshRibbon:()=>ribbonWorkspace.refresh(),
    isRunning:()=>Boolean(controller||manualControllers.size||scriptWorkspace.isRunning()||ribbonWorkspace.isRunning()),
    reset(){surfaceKey='';envSelection=w().environmentId||'';w().relations||=[];w().relationRuns||=[];scriptPhases.clear();scriptWorkspace.reset();ribbonWorkspace.reset();},refresh(){surfaceKey='';scriptWorkspace.invalidate();syncView(api.side());ribbonWorkspace.refresh();}};
}
