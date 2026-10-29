import {confirmAction} from './confirm-dialog.mjs';
/** Workspace pages own editing state; runtime, scripts and relation execution are separate. */
import {SCHEMA,clone,uid,rows,enabled,findItem,walkItems,contextFor,newRequest} from './core.mjs';
import {PrimaryVariables,RESPONSE_KEY,extractVariableNames,upsertVariable,responseMetadata,metadataElements,extractionWrites,requestAutomation,variableText,checkName} from './runtime.mjs';
import {createCodeEditor} from './code-editor.mjs';
import {executeRequest} from './execution.mjs';
import {runScript} from './script-runner.mjs';
import {newRelation,newStep,runRelation,OPERATORS,NEXT,END} from './relations.mjs';
import {requestKey} from './revisions.mjs';
export function initStudio(api) {
  const {$,element:el,button:btn,input,select,field,kvEditor,openItemMenu,bindContext,showModal,closeModal,persist,toast}=api;
  const w=api.workspace;
  let storeWarning=false;
  const storageError=()=>{if(!storeWarning){storeWarning=true;toast('セッションの保存容量を超えました。値と受信結果は画面上に保持しています。');}};
  let session=null;try {session=sessionStorage;}catch {}
  const primary=new PrimaryVariables(session,storageError),snapshots=new Map(),scriptLogs=new Map();
  try {for(const [key,value] of JSON.parse(session?.getItem(RESPONSE_KEY)||'[]')) snapshots.set(key,value);}catch {}
  let envSelection=w().environmentId||'',relationId='',surfaceKey='',creationContext=null,controller=null,running=null;
  const manualControllers=new Set();
    w().relations ||= [];w().relationRuns ||= [];
  function setSurface(side){api.setSide(side);api.renderSidebar();syncView(side);api.closeNavigation();}
  function changedEnvironment(){persist();api.renderEnvironments();}
  function rememberResponse(tab,result){
    if(result.error)return;
    snapshots.set(requestKey(w(),tab),clone(result));
    try{session?.setItem(RESPONSE_KEY,JSON.stringify([...snapshots]));}catch{storageError();}
  }
  function responseFor(tab){return snapshots.get(requestKey(w(),tab));}
  function transferResponse(before,after){if(snapshots.has(before)){snapshots.set(after,snapshots.get(before));snapshots.delete(before);}}
  function noteScript(tab,entry){scriptLogs.set(requestKey(w(),tab),entry);const log=$('scriptLog');if(log&&requestKey(w(),api.active())===requestKey(w(),tab))log.textContent=entry.error||entry.logs?.map(r=>r.message).join('\n')||'完了';}
  async function execute(tab,{signal,environmentId=w().environmentId,files={}}={}) {
    const result=await executeRequest({workspace:w(),tab,files,primary,environmentId,signal,onVariables:saved=>{if(saved)persist();if(api.side()==='environments'&&!document.activeElement?.closest('.variables-page')){surfaceKey='';syncView('environments');}},onScript:entry=>noteScript(tab,entry)});
    rememberResponse(tab,result);return result;
  }
  function scopeRows(){if(envSelection==='primary')return primary.rows;if(envSelection==='globals')return w().globals;return w().environments.find(e=>e.id===envSelection)?.values;}
  function scopeChanged(){if(envSelection==='primary')primary.save();else changedEnvironment();}
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
    const heading=el('div','workspace-page-heading');heading.append(el('h1','',isPrimary?'一次変数':isGlobals?'Globals':'環境変数'));
    if(env){
      const name=input(env.name,'Environment name',v=>{env.name=v;persist();api.renderEnvironments();api.renderSidebar();});name.id='environmentName';heading.append(name);
      heading.append(btn('変更履歴',()=>api.showRevisions(`environment:${env.id}`),'button'));
      heading.append(btn('エクスポート',()=>api.exportEnvironment(env),'button'));
    } else if(isGlobals)heading.append(btn('変更履歴',()=>api.showRevisions('globals'),'button'));
    else if(isPrimary)heading.append(btn('すべて消去',async()=>{if(await confirmAction('一次変数をすべて消去しますか？')){primary.clear();surfaceKey='';syncView('environments');}},'button'));
    page.append(heading);
    if(!env&&!isPrimary&&!isGlobals){const empty=el('div','workspace-empty');empty.append(el('h2','','環境を選択してください'),btn('環境を作成',()=>createEnvironment(),'button primary'));page.append(empty);return;}
    const body=el('div','workspace-page-body variables-page');body.append(kvEditor(scopeRows(),scopeChanged,{secret:!isPrimary}));page.append(body);
    const more=btn('⋯',event=>openItemMenu(event.currentTarget,[{label:'変数を追加',run:()=>addVariable(envSelection)}]),'icon-button');more.setAttribute('aria-label','変数ページの操作');heading.append(more);
    body.oncontextmenu=event=>{if(event.defaultPrevented||event.target.closest('input,textarea,select,tr'))return;event.preventDefault();openItemMenu(body,[{label:'変数を追加',run:()=>addVariable(envSelection)}],event);};
  }
  function renderSidebarSection(side){
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
      for(const env of w().environments.filter(e=>e.name.toLowerCase().includes(query)))row(env.name,envSelection===env.id,()=>{api.chooseEnvironment(env.id);editEnvironment(env);},(a,e)=>openItemMenu(a,[{label:'変数を追加',run:()=>addVariable(env.id)},{label:'この後に環境を追加',run:()=>createEnvironment(env.id)},...api.environmentActions(env,false)],e),{environmentId:env.id});
    } else {
      for(const relation of (w().relations||[]).filter(r=>r.name.toLowerCase().includes(query)))row(relation.name,relation.id===relationId,()=>openRelation(relation.id),(a,e)=>openItemMenu(a,[{label:'この後にリレーションを追加',run:()=>createRelation(relation.id)},{label:'ステップを追加',run:()=>{openRelation(relation.id);addStep(relation);}},{label:'複製',run:()=>duplicateRelation(relation)},{label:'削除',danger:true,run:async()=>{if(controller&&running?.relationId===relation.id)return toast('実行中です。停止してから削除してください。');if(await confirmAction(`「${relation.name}」を削除しますか？`)){if(controller&&running?.relationId===relation.id)return toast('実行中です。停止してから削除してください。');w().relations=w().relations.filter(r=>r!==relation);persist();surfaceKey='';api.renderSidebar();syncView('relations');}}}],e),{relationId:relation.id});
      if(!root.children.length)root.append(el('p','sidebar-empty','リレーションはありません'));
    }
    return true;
  }
  function syncView(side,force=false){
    $('addTab').disabled=side==='history';$('addTab').title=side==='history'?'送信履歴はリクエスト送信時に追加されます':'選択中のカテゴリに追加';
    const kind=['environments','relations'].includes(side)?side:'request';document.documentElement.dataset.workspaceView=kind;
    $('exchange').hidden=kind!=='request';$('workspacePage').hidden=kind==='request';
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
    if(context.siblingId)box.append(field('挿入位置',select([['before','右クリックした項目の前'],['after','右クリックした項目の後']],placement,v=>placement=v)));
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
    else if(side==='relations')actions=[{label:'リレーションを作成',run:()=>createRelation()},{label:'表示中のリレーションにステップを追加',disabled:!w().relations?.some(r=>r.id===relationId),run:()=>addStep(w().relations.find(r=>r.id===relationId))}];
    else {
      const context=root?null:creationContext;
      actions=[{label:context?'この階層にリクエストを追加':'リクエストを作成',run:()=>context?createItem('request',context):api.addDraft()},
        {label:'この階層にフォルダーを追加',disabled:!context,run:()=>createItem('folder',context)},
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
  function referenceTab(collection,item){return api.findDraft(collection._mpId,item._mpId)||{id:item._mpId,collectionId:collection._mpId,itemId:item._mpId,name:item.name,request:item.request,settings:item.settings};}
  function requestActions(collection,item){
    const tab=()=>referenceTab(collection,item),parent=findItem(collection,item._mpId)?.parents.at(-1);
    const context={collectionId:collection._mpId,parentId:parent?._mpId,siblingId:item._mpId};
    return [
      {label:'この位置にリクエストを追加',run:()=>createItem('request',context)},
      {label:'この位置にフォルダーを追加',run:()=>createItem('folder',context)},
      {label:'環境変数を抽出',run:()=>extractEnvironment(tab())},
      {label:'スクリプトを編集',run:()=>{api.openRequest(collection,item);api.selectEditorPage('scripts');}},
      {label:'レスポンスから一次変数を抽出',disabled:!responseFor(tab()),run:()=>responseExtraction(tab())},
      {label:'リレーションに追加',run:()=>addRequestToRelation({collectionId:collection._mpId,itemId:item._mpId})},null];
  }
  function draftActions(tab){return [{label:'環境変数を抽出',run:()=>extractEnvironment(tab)},{label:'スクリプトを編集',run:()=>{api.selectRequest(tab.id);api.selectEditorPage('scripts');}},{label:'レスポンスから一次変数を抽出',disabled:!responseFor(tab),run:()=>responseExtraction(tab)},{label:'リレーションに追加',run:()=>addRequestToRelation({draftId:tab.id})}];}
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
      {label:'この要素を選択',run:()=>pick(entry.row)},
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
    if(!choosePath){box.append(field('一次変数名',nameInput));const label=el('label','settings-line'),check=el('input');check.type='checkbox';check.onchange=()=>saveRule=check.checked;label.append(check,'次回以降の受信時にも自動で抽出');box.append(label);}
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
    const phases=el('div','content-tabs script-phase-tabs');phases.setAttribute('role','tablist');phases.setAttribute('aria-label','スクリプトの実行タイミング');root.append(phases);
    const phaseNodes=[];
    function selectPhase(name){for(const item of phaseNodes){item.panel.hidden=item.phase!==name;item.tab.setAttribute('aria-selected',String(item.phase===name));item.tab.tabIndex=item.phase===name?0:-1;}}
    for(const [phase,title] of [['before','送信前'],['after','受信後']]){
      const panel=el('div','script-phase-panel');panel.id='script-panel-'+phase;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','script-tab-'+phase);
      const tabButton=btn(title,()=>selectPhase(phase));tabButton.id='script-tab-'+phase;tabButton.setAttribute('role','tab');tabButton.setAttribute('aria-controls',panel.id);phases.append(tabButton);phaseNodes.push({phase,panel,tab:tabButton});root.append(panel);
      const header=el('div','section-tools');header.append(el('h3','',title));
      const run=btn('このスクリプトを実行',async()=>{
        const result=responseFor(tab);if(phase==='after'&&!result)return toast('レスポンスを受信してから実行してください。');
        const manual=new AbortController();manualControllers.add(manual);$('stopRelationGlobal').hidden=false;run.disabled=true;
        try {
          const ctx=contextFor(w(),tab,primary.rows),env=ctx.environment;
          const out=await runScript(config[phase],{variables:ctx.vars,primary:primary.snapshot(),environment:Object.fromEntries(rows(env?.values).filter(enabled).map(r=>[r.key,r.value])),globals:Object.fromEntries(rows(w().globals).filter(enabled).map(r=>[r.key,r.value])),request:tab.request,response:responseMetadata(result),raw:result},{timeoutMs:config.timeoutMs,signal:manual.signal});
          if(out.writes.environment.length&&!env)throw new Error('環境を選択してください。');
          for(const changes of Object.values(out.writes))for(const row of changes)checkName(row.key);
          primary.apply(out.writes.primary);
          for(const [target,changes] of [[env?.values,out.writes.environment],[w().globals,out.writes.globals]])for(const row of changes){if(row.remove){for(let at=target.length-1;at>=0;at--)if(target[at].key===row.key)target.splice(at,1);}else upsertVariable(target,row.key,row.value);}
          if(out.writes.environment.length||out.writes.globals.length)persist();noteScript(tab,{phase,logs:out.logs});toast('スクリプトを実行しました。リクエストは送信していません。');
        }catch(error){noteScript(tab,{phase,error:error.message,logs:[]});toast(error.message);}finally{manualControllers.delete(manual);$('stopRelationGlobal').hidden=!controller&&!manualControllers.size;run.disabled=false;}
      },'button');header.append(run);panel.append(header,createCodeEditor({value:config[phase],language:'javascript',intellisense:true,label:`${title}スクリプト`,onChange:value=>{config[phase]=value;save();}}).element);
    }
    selectPhase('before');
    phases.onkeydown=event=>{const current=phaseNodes.findIndex(item=>item.tab===event.target);if(current<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?1:(current+1)%2;phaseNodes[next].tab.click();phaseNodes[next].tab.focus();};
    const help=el('details','script-api'),summary=el('summary','','利用できるAPI');help.append(summary,el('code','','vars.get(name) / vars.set(name, value) / vars.unset(name) / response.body / response.headers / pm.variables / pm.environment / pm.globals / pm.response.json() / pm.test(name, fn)'));
    root.append(help);const log=el('pre','script-log');log.id='scriptLog';log.setAttribute('role','status');const prior=scriptLogs.get(requestKey(w(),tab));log.textContent=prior?.error||prior?.logs?.map(r=>r.message).join('\n')||'';root.append(log);
    if(config.extractions.length){const rules=el('div','extraction-rules');rules.append(el('h3','','受信時の自動抽出'));for(const rule of config.extractions){const line=el('div','extraction-rule'),checkbox=el('input');checkbox.type='checkbox';checkbox.checked=rule.enabled!==false;checkbox.onchange=()=>{rule.enabled=checkbox.checked;save();};line.append(checkbox,input(rule.name,'抽出する変数名',v=>{rule.name=v;save();}),input(rule.path,'抽出元のパス',v=>{rule.path=v;save();}),select([['keep','欠損時: 前値維持'],['empty','欠損時: 空文字'],['error','欠損時: エラー']],rule.missing||'keep',v=>{rule.missing=v;save();}),btn('削除',()=>{config.extractions=config.extractions.filter(r=>r!==rule);save();api.renderEditor();},'text-button'));rules.append(line);}root.append(rules);}
    const imported=contextFor(w(),tab).events;
    if(imported.length){const details=el('details','imported-scripts');details.append(el('summary','','インポート済みスクリプト（自動実行しません）'));for(const event of imported){const source=Array.isArray(event.script?.exec)?event.script.exec.join('\n'):event.script?.exec||'';const section=el('section','scripts-block');section.append(el('h4','',event.listen||'Script'),el('pre','',source),btn('編集欄へコピー',()=>{const key=event.listen==='prerequest'?'before':'after';config[key]+=(config[key]?'\n':'')+source;save();api.renderEditor();},'button'));details.append(section);}root.append(details);}
  }
  function requestOptions(){
    const options=[];for(const c of w().collections)walkItems(c.item,(item,parents)=>{if(item.request)options.push([JSON.stringify({collectionId:c._mpId,itemId:item._mpId}),`${c.info.name} / ${[...parents.map(p=>p.name),item.name].join(' / ')}`]);});
    for(const tab of w().tabs)if(!w().collections.some(c=>c._mpId===tab.collectionId&&findItem(c,tab.itemId)?.item.request))options.push([JSON.stringify({draftId:tab.id}),`下書き / ${tab.name}`]);return options;
  }
  function openRelation(id){relationId=id;surfaceKey='';setSurface('relations');$('workspacePage').querySelector('input[aria-label="リレーション名"]')?.focus({preventScroll:true});}
  function createRelation(afterId=null,reference=null){let name='新しいリレーション';const box=field('リレーション名',input(name,'リレーション名',v=>name=v));showModal('リレーションを作成',box,()=>{if(!name.trim())throw new Error('名前を入力してください。');const relation=newRelation(name.trim());if(reference)relation.steps.push(newStep(reference));const at=w().relations.findIndex(r=>r.id===afterId);w().relations.splice(afterId&&at>=0?at+1:w().relations.length,0,relation);persist();closeModal();openRelation(relation.id);},'作成');}
  function duplicateRelation(relation){const copy=clone(relation),ids=new Map(copy.steps.map(s=>[s.id,uid()]));copy.id=uid();copy.name+=' copy';for(const step of copy.steps){step.id=ids.get(step.id);step.onTrue=ids.get(step.onTrue)||step.onTrue;step.onFalse=ids.get(step.onFalse)||step.onFalse;}w().relations.splice(w().relations.indexOf(relation)+1,0,copy);persist();openRelation(copy.id);}
  function addRequestToRelation(reference){
    if(!w().relations.length){createRelation(null,reference);return;}
    let id=w().relations[0].id;const box=field('追加先',select([...w().relations.map(r=>[r.id,r.name]),['__new__','新しいリレーション']],id,v=>id=v));showModal('リレーションに追加',box,()=>{closeModal();if(id==='__new__')createRelation(null,reference);else{const relation=w().relations.find(r=>r.id===id);if(!relation)return;relation.steps.push(newStep(reference));persist();openRelation(id);}},'追加');
  }
  function addStep(relation,index=relation.steps.length){
    const step=newStep();relation.steps.splice(index,0,step);persist();surfaceKey='';syncView('relations');api.closeNavigation();
    const row=[...$('workspacePage').querySelectorAll('.relation-step')].find(e=>e.dataset.stepId===step.id);
    row?.querySelector('select')?.focus({preventScroll:true});row?.scrollIntoView({block:'nearest'});
  }
  function relationPage(){
    const page=$('workspacePage'),relation=w().relations.find(r=>r.id===relationId);page.replaceChildren();
    if(!relation){const empty=el('div','workspace-empty');empty.append(el('h1','','リレーション'),el('p','','既存のリクエストを並べ、順序・待機・繰り返し・分岐を設定します。'),btn('リレーションを作成',()=>createRelation(),'button primary'));page.append(empty);return;}
    const header=el('div','workspace-page-heading'),name=input(relation.name,'リレーション名',v=>{relation.name=v;persist();api.renderSidebar();});header.append(el('h1','','リレーション'),name);
    const start=btn('実行',()=>startRelation(relation),'button primary');start.id='runRelation';start.disabled=Boolean(controller);
    const stopButton=btn('停止',stopRelation,'button');stopButton.id='stopRelationLocal';stopButton.disabled=!controller;
    header.append(start,stopButton,btn('変更履歴',()=>api.showRevisions(`relation:${relation.id}`),'button'),btn('エクスポート',()=>api.exportFile(`${relation.name}.relation.json`,relation),'button'));page.append(header);
    const settings=el('div','relation-settings');
    function numberField(title,value,change,min=0){const control=input(value,title,v=>change(Number(v)),'number');control.min=String(min);control.step='1';return field(title,control);}
    settings.append(numberField('全体の回数',relation.repeat,v=>{relation.repeat=v;persist();},1),numberField('全体の間隔 ms',relation.intervalMs,v=>{relation.intervalMs=v;persist();}),numberField('最大実行数（0=無制限）',relation.maxExecutions||0,v=>{relation.maxExecutions=v;persist();}));
    settings.append(field('使用する環境',select([['','実行開始時の選択環境'],...w().environments.map(e=>[e.id,e.name])],relation.environmentId||'',v=>{relation.environmentId=v;persist();})));
    const stop=el('label','settings-line'),stopCheck=el('input');stopCheck.type='checkbox';stopCheck.checked=relation.stopOnError;stopCheck.onchange=()=>{relation.stopOnError=stopCheck.checked;persist();};stop.append(stopCheck,'エラーで停止');settings.append(stop);page.append(settings);
    const editor=el('div','relation-editor');editor.id='relationSteps';const options=requestOptions();
    const save=()=>persist(),repaint=(focusId=null,action=null)=>{
      const scroll=page.scrollTop;persist();surfaceKey='';syncView('relations');page.scrollTop=scroll;
      const node=[...page.querySelectorAll('.relation-step')].find(e=>e.dataset.stepId===focusId);
      const control=action?node?.querySelector(`[data-step-action="${action}"]`):node?.querySelector('select');
      const alternate=action?node?.querySelector(`[data-step-action="${action==='up'?'down':'up'}"]`):null;
      (control&&!control.disabled?control:alternate&&!alternate.disabled?alternate:node?.querySelector('select')||page.querySelector('#addRelationStep'))?.focus({preventScroll:true});
    };
    for(const [index,step] of relation.steps.entries()){
      const row=el('section','relation-step');row.dataset.stepId=step.id;
      const top=el('div','relation-step-heading'),drag=el('span','step-drag','⠿');drag.draggable=true;drag.title='ドラッグして並べ替え';drag.ondragstart=event=>event.dataTransfer.setData('text/plain',step.id);top.append(drag,el('strong','step-number',String(index+1)));
      const value=JSON.stringify(step.draftId?{draftId:step.draftId}:{collectionId:step.collectionId,itemId:step.itemId});
      const picker=select([['','リクエストを選択'],...options],options.some(([v])=>v===value)?value:'',v=>{delete step.draftId;step.collectionId='';step.itemId='';if(v)Object.assign(step,JSON.parse(v));save();});picker.setAttribute('aria-label',`ステップ ${index+1} のリクエスト`);top.append(picker);
      const move=delta=>{const at=relation.steps.indexOf(step),to=at+delta;if(to<0||to>=relation.steps.length)return;relation.steps.splice(at,1);relation.steps.splice(to,0,step);repaint(step.id,delta<0?'up':'down');};
      const up=btn('↑',()=>move(-1),'icon-button'),down=btn('↓',()=>move(1),'icon-button');up.setAttribute('aria-label',`ステップ ${index+1} を上へ`);down.setAttribute('aria-label',`ステップ ${index+1} を下へ`);up.dataset.stepAction='up';down.dataset.stepAction='down';up.disabled=index===0;down.disabled=index===relation.steps.length-1;
      const more=btn('⋯',()=>{},'icon-button');more.setAttribute('aria-label',`ステップ ${index+1} の操作`);top.append(up,down,more);
      const remove=()=>{const at=relation.steps.indexOf(step);relation.steps=relation.steps.filter(s=>s!==step);for(const s of relation.steps){if(s.onTrue===step.id)s.onTrue=NEXT;if(s.onFalse===step.id)s.onFalse=NEXT;}repaint(relation.steps[Math.min(at,relation.steps.length-1)]?.id);};
      bindContext(row,more,(a,e)=>openItemMenu(a,[{label:'この前にステップを追加',run:()=>addStep(relation,relation.steps.indexOf(step))},{label:'この後にステップを追加',run:()=>addStep(relation,relation.steps.indexOf(step)+1)},{label:'複製',run:()=>{const copied={...clone(step),id:uid()};relation.steps.splice(index+1,0,copied);repaint(copied.id);}},{label:'削除',danger:true,run:remove}],e));row.append(top);
      row.ondragover=event=>{event.preventDefault();row.classList.add('drop-target');};row.ondragleave=()=>row.classList.remove('drop-target');row.ondrop=event=>{event.preventDefault();const id=event.dataTransfer.getData('text/plain'),from=relation.steps.findIndex(s=>s.id===id);if(from<0||id===step.id)return;const [moving]=relation.steps.splice(from,1);relation.steps.splice(relation.steps.indexOf(step),0,moving);repaint(moving.id);};
      const timing=el('div','step-timing');timing.append(numberField('開始前 ms',step.delayMs,v=>{step.delayMs=v;save();}),numberField('回数',step.repeat,v=>{step.repeat=v;save();},1),numberField('間隔 ms',step.intervalMs,v=>{step.intervalMs=v;save();}));
      const check=el('input');check.type='checkbox';check.checked=step.condition.enabled;check.setAttribute('aria-label',`ステップ ${index+1} の条件分岐`);const checkLabel=el('label','settings-line');checkLabel.append(check,'条件分岐');timing.append(checkLabel);row.append(timing);
      const branch=el('div','step-branch');branch.hidden=!step.condition.enabled;check.onchange=()=>{step.condition.enabled=check.checked;branch.hidden=!check.checked;save();};
      const condition=step.condition;
      const source=select([['response','このステップのレスポンス'],['primary','一次変数']],condition.source,v=>{condition.source=v;save();});source.setAttribute('aria-label',`ステップ ${index+1} の分岐元`);
      const path=input(condition.path,'変数名 / レスポンスのパス',v=>{condition.path=v;save();});path.setAttribute('aria-label',`ステップ ${index+1} の比較元`);
      const op=select(OPERATORS,condition.operator,v=>{condition.operator=v;save();});op.setAttribute('aria-label',`ステップ ${index+1} の比較`);
      branch.append(source,path,op,input(condition.value,'比較する値 / {{変数}}',v=>{condition.value=v;save();}));
      const targets=[[NEXT,'次のステップ'],[END,'この回を終了'],...relation.steps.map((s,n)=>[s.id,`ステップ ${n+1}`])];
      for(const [key,label] of [['onTrue','条件成立時'],['onFalse','不成立時']]){const control=select(targets,step[key],v=>{step[key]=v;save();});control.setAttribute('aria-label',`ステップ ${index+1} の${label}`);branch.append(field(label,control));}
      const meta=btn('受信済みの要素から選択',()=>{const c=w().collections.find(c=>c._mpId===step.collectionId),item=findItem(c,step.itemId)?.item,tab=item?referenceTab(c,item):w().tabs.find(t=>t.id===step.draftId);if(!tab)return toast('リクエストを選択してください。');responseExtraction(tab,value=>{condition.path=value;path.value=value;save();});},'text-button');branch.append(meta);row.append(branch);editor.append(row);
    }
    const add=btn('＋ ステップを追加',()=>addStep(relation),'button');add.id='addRelationStep';editor.append(add);
    editor.oncontextmenu=event=>{if(event.defaultPrevented||event.target.closest('.relation-step,input,select'))return;event.preventDefault();openItemMenu(editor,[{label:'ステップを追加',run:()=>addStep(relation)}],event);};
    page.append(editor);const log=el('section','relation-log');log.id='relationRunLog';log.setAttribute('aria-live','polite');page.append(log);renderRunLog();
  }
  function stopRelation(){controller?.abort();for(const manual of manualControllers)manual.abort();}
  function renderRunLog(){
    const root=$('relationRunLog');if(!root)return;
    const run=running?.relationId===relationId?running:[...(w().relationRuns||[])].reverse().find(r=>r.relationId===relationId);
    const start=$('runRelation');if(start)start.disabled=Boolean(controller);
    const stop=$('stopRelationLocal');if(stop)stop.disabled=!controller;
    root.replaceChildren();if(!run){root.append(el('p','workspace-note','実行結果はここに表示されます。'));return;}
    const labels={running:'実行中',succeeded:'完了',failed:'失敗',cancelled:'停止',completed_with_errors:'エラーあり'};
    const heading=el('div','section-tools');heading.append(el('h2','',`実行結果 · ${labels[run.status]||run.status}`),btn('ログを保存',()=>api.exportFile('relation-run.json',run),'text-button'));root.append(heading);
    if(run.error)root.append(el('p','error',run.error));
    const table=el('table','run-table');const head=el('tr');for(const title of ['回','ステップ','リクエスト','結果','時間','分岐 / 詳細'])head.append(el('th','',title));table.append(head);
    for(const entry of run.entries){const row=el('tr',entry.status);for(const value of [entry.round,entry.index+1,entry.requestName,entry.httpStatus?`${entry.httpStatus} · ${labels[entry.status]||entry.status}`:labels[entry.status]||entry.status,entry.elapsed_ms!=null?`${entry.elapsed_ms} ms`:'',entry.error||(entry.branch?`${entry.branch.matched?'成立':'不成立'} → ${entry.branch.target===NEXT?'次へ':entry.branch.target===END?'終了':`ステップ ${entry.branch.targetIndex+1}`}`:'')])row.append(el('td','',String(value??'')));table.append(row);}root.append(table);
    for(const node of $('relationSteps')?.querySelectorAll('.relation-step')||[])node.classList.toggle('running',run.status==='running'&&node.dataset.stepId===run.current?.stepId);
  }
  async function startRelation(relation){
    if(controller)return toast('実行中のリレーションを停止してから開始してください。');
    const chosenEnv=relation.environmentId||w().environmentId;if(chosenEnv&&!w().environments.some(e=>e.id===chosenEnv))return toast('選択した環境が削除されています。');
    controller=new AbortController();$('stopRelationGlobal').hidden=false;const start=$('runRelation');if(start)start.disabled=true;
    const stop=$('stopRelationLocal');if(stop)stop.disabled=false;
    try {
      const result=await runRelation(relation,{workspace:w(),primary:()=>primary.snapshot(),variables:tab=>contextFor({...w(),environmentId:chosenEnv},tab,primary.rows).vars,signal:controller.signal,
        execute:async(tab,{signal})=>{const response=await execute(tab,{signal,environmentId:chosenEnv,files:api.filesFor(tab,signal)});api.recordBackground(tab,response,chosenEnv);return response;},onProgress:run=>{running=run;renderRunLog();}});
      w().relationRuns.push(clone(result));persist();
    }catch(error){running={relationId:relation.id,name:relation.name,status:'failed',entries:[],error:error.message};toast(error.message);}finally{controller=null;$('stopRelationGlobal').hidden=!manualControllers.size;renderRunLog();}
  }
  $('stopRelationGlobal').onclick=stopRelation;
  $('extractResponse').onclick=()=>responseExtraction(api.active());
  $('sidebarContent').addEventListener('contextmenu',event=>{if(event.defaultPrevented||event.target.closest('.tree-row,.history-entry,input'))return;event.preventDefault();creationMenu($('sidebarContent'),event,true);});
  return {primary,execute,rememberResponse,responseFor,transferResponse,syncView,renderSidebarSection,editEnvironment,environmentChosen,
    createEnvironment,creationMenu,createItem,captureContext,requestActions,draftActions,renderScripts,responseExtraction,addRequestToRelation,
    isRunning:()=>Boolean(controller||manualControllers.size),
    reset(){surfaceKey='';envSelection=w().environmentId||'';w().relations||=[];w().relationRuns||=[];},refresh(){surfaceKey='';syncView(api.side());}};
}
