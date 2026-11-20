/** Standalone script editing, input and results. No selected request is required. */
import {clone} from './core.mjs';
import {newScript,ensureScripts,parseScriptInput,applyScriptWrites,validScriptData} from './scripts.mjs';
import {createCodeEditor} from './code-editor.mjs';
import {runScript} from './script-runner.mjs';
import {makeScriptContext,createScriptHost,formatScriptValue} from './script-host.mjs';
import {scriptEditorContext} from './script-editor-context.mjs';
import {confirmAction} from './confirm-dialog.mjs';
import {SCRIPT_API_SECTIONS,searchScriptAPI} from './script-api-reference.mjs';

export function initScriptWorkspace(api) {
  const {$,element:el,button:btn,input,select,field,openItemMenu,bindContext,showModal,closeModal,persist,toast,primary}=api;
  const w=api.workspace,results=new Map(),controllers=new Map();
  let selectedId='',paintedId='',logFrame=0;
  const current=()=>w().scripts.find(script=>script.id===selectedId);
  const changed=()=>persist();
  function selected(){ensureScripts(w());if(!current())selectedId=w().scripts[0]?.id||'';return current();}
  function open(id){selectedId=id;paintedId='';api.openScripts();}
  function create(afterId=null,source='',suggestedName='新しいスクリプト',onCreate=null){
    let name=suggestedName;
    const box=field('スクリプト名',input(name,'スクリプト名',value=>name=value));
    showModal('スクリプトを作成',box,()=>{
      if(!name.trim())throw new Error('スクリプト名を入力してください。');
      const script=newScript(name.trim());script.source=source;
      const at=w().scripts.findIndex(item=>item.id===afterId);
      w().scripts.splice(at>=0?at+1:w().scripts.length,0,script);
      changed();closeModal();onCreate?.(script);open(script.id);
    },'作成');
  }
  function duplicate(script){const copy={...clone(script),id:newScript().id,name:`${script.name} copy`};w().scripts.splice(w().scripts.indexOf(script)+1,0,copy);changed();open(copy.id);}
  async function remove(script){
    if(!await confirmAction(`「${script.name}」を削除しますか？`))return;
    controllers.get(script.id)?.abort();w().scripts=w().scripts.filter(item=>item.id!==script.id);
    delete w().revisions?.[`script:${script.id}`];results.delete(script.id);changed();paintedId='';api.renderSidebar();render(true);
  }
  function settings(script){
    let timeout=script.timeoutMs;
    const control=input(timeout,'スクリプト制限時間',value=>timeout=Number(value),'number');control.min='0';control.step='1';
    const box=field('制限時間 ms（0=無制限）',control);
    showModal('実行設定',box,()=>{
      if(!Number.isFinite(timeout)||timeout<0)throw new Error('0以上の数値を入力してください。');
      script.timeoutMs=timeout;changed();closeModal();
    },'保存');
  }
  function downloadText(name,text,type='text/plain;charset=utf-8'){
    const url=URL.createObjectURL(new Blob([text],{type})),link=el('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function menu(script){return [
    {label:'実行',disabled:controllers.has(script.id),run:()=>{open(script.id);run(script);}},
    ...(controllers.has(script.id)?[{label:'停止',run:()=>controllers.get(script.id)?.abort()}]:[]),
    {label:'実行設定',run:()=>settings(script)},
    {label:'変更履歴',run:()=>api.showRevisions(`script:${script.id}`)},
    {label:'IDをコピー',run:()=>api.copyText(script.id)},
    {label:'コードを書き出す',run:()=>downloadText(`${script.name}.js`,script.source,'text/javascript;charset=utf-8')},
    {label:'複製',run:()=>duplicate(script)},
    {label:'スクリプトを追加',run:()=>create(script.id)},
    {label:'削除',danger:true,run:()=>remove(script)}
  ];}
  function sidebar(){
    selected();const root=$('sidebarContent'),query=$('search').value.toLowerCase();root.replaceChildren();
    $('sidebarAdd').hidden=false;$('clearHistory').hidden=true;$('search').placeholder='スクリプトを検索';$('sidebarAdd').setAttribute('aria-label','スクリプトを追加');
    for(const script of w().scripts.filter(item=>item.name.toLowerCase().includes(query))){
      const row=el('div',`tree-row${script.id===selectedId?' selected':''}`);row.dataset.scriptId=script.id;
      const name=btn(script.name,()=>open(script.id),'tree-open'),more=btn('⋯',()=>{},'icon-button');name.title=script.name;more.setAttribute('aria-label',`${script.name}の操作`);
      row.append(name,more);bindContext(row,more,(anchor,event)=>openItemMenu(anchor,menu(script),event));root.append(row);
    }
    if(!root.children.length)root.append(el('p','sidebar-empty',query?'一致する項目なし':'スクリプトはありません'));
  }
  function reference(){
    const box=el('div','script-reference'),toolbar=el('div','script-reference-toolbar'),results=el('div','script-reference-results');
    let query='',category='';
    const search=input('','APIを検索',value=>{query=value;paint();},'search');search.id='scriptApiSearch';search.placeholder='API名や目的で検索';
    const categories=select([['','すべてのカテゴリ'],...SCRIPT_API_SECTIONS.map(section=>[section.id,section.title])],'',value=>{category=value;paint();});
    categories.id='scriptApiCategory';categories.setAttribute('aria-label','APIカテゴリ');
    const count=el('p','script-reference-count');count.id='scriptApiCount';count.setAttribute('role','status');count.setAttribute('aria-live','polite');
    results.id='scriptApiResults';toolbar.append(field('検索',search),field('カテゴリ',categories));box.append(toolbar,count,results);
    function paint(){
      const sections=searchScriptAPI(query,category);results.replaceChildren();
      count.textContent=`${sections.reduce((total,section)=>total+section.entries.length,0)}件`;
      for(const section of sections){
        const group=el('section','script-api-section');group.dataset.category=section.id;group.append(el('h3','',section.title));
        const list=el('dl');for(const [name,description]of section.entries){const entry=el('div','script-api-entry');entry.append(el('dt','',name),el('dd','',description));list.append(entry);}group.append(list);results.append(group);
      }
      if(!sections.length)results.append(el('p','script-reference-empty','一致するAPIはありません'));
    }
    paint();showModal('スクリプトAPI',box,null);search.focus();
  }
  function sharedData(){
    let text=JSON.stringify(w().scriptData,null,2);
    const editor=createCodeEditor({value:text,language:'json',label:'スクリプト共有データ',onChange:value=>text=value});
    showModal('共有データ',editor.element,()=>{
      if(controllers.size)throw new Error('実行中のスクリプトを停止してから変更してください。');
      let data;try{data=JSON.parse(text);}catch{throw new Error('JSONの形式を確認してください。');}
      if(!validScriptData(data))throw new Error('共有データはJSONオブジェクトで指定してください。');
      w().scriptData=data;changed();closeModal();
    },'保存');
  }
  function render(force=false){
    const script=selected(),page=$('workspacePage');
    if(!force&&paintedId===(script?.id||'empty')&&page.querySelector('.scripts-page')){paintResult();return;}
    paintedId=script?.id||'empty';page.replaceChildren();
    const body=el('div','scripts-page');page.append(body);
    if(!script){const empty=el('div','workspace-empty');empty.append(el('h1','','スクリプト'),btn('スクリプトを作成',()=>create(),'button primary'));body.append(empty);return;}
    const heading=el('div','standalone-script-heading');
    const name=input(script.name,'スクリプト名',value=>{script.name=value;changed();api.renderSidebar();});name.className='standalone-script-name';
    const runButton=btn('実行',()=>run(script),'button primary');runButton.id='runStandaloneScript';runButton.title='実行（Ctrl / ⌘ + Enter）';
    const stop=btn('停止',()=>controllers.get(script.id)?.abort(),'button');stop.id='stopStandaloneScript';
    const state=el('span','standalone-script-status');state.id='standaloneScriptStatus';state.setAttribute('role','status');
    const actions=btn('⋯',event=>openItemMenu(event.currentTarget,[...menu(script),null,{label:'共有データ',run:sharedData},{label:'APIリファレンス',run:reference}]),'icon-button');actions.setAttribute('aria-label','スクリプトの操作');
    heading.append(name,state,runButton,stop,actions);body.append(heading);
    const grid=el('div','standalone-script-grid'),code=el('section','standalone-script-code');
    code.append(createCodeEditor({value:script.source,language:'javascript',intellisense:true,intelligenceContext:()=>scriptEditorContext(w(),primary,{script,ribbonOwner:api.active?.()}),label:'スクリプトのコード',onChange:value=>{script.source=value;changed();}}).element);
    const io=el('div','standalone-script-io'),inputSection=el('section','script-input-section'),inputHeading=el('div','script-section-heading');
    let editor;
    const fitInput=()=>editor?.element.style.setProperty('--script-input-lines',String(Math.max(3,String(script.input).split('\n').length)));
    editor=createCodeEditor({value:script.input,language:script.inputFormat==='json'?'json':'text',label:'スクリプトの入力',onChange:value=>{script.input=value;fitInput();changed();}});fitInput();
    const format=select([['json','JSON'],['text','テキスト']],script.inputFormat,value=>{script.inputFormat=value;editor.setLanguage(value);changed();});format.setAttribute('aria-label','入力形式');
    const file=el('input');file.type='file';file.hidden=true;file.setAttribute('aria-label','入力ファイル');
    file.onchange=async()=>{const selectedFile=file.files?.[0];if(!selectedFile)return;try{const text=await selectedFile.text();script.input=text;editor.setValue(text);fitInput();changed();}catch(error){toast(error.message);}finally{file.value='';}};
    const inputMore=btn('⋯',event=>openItemMenu(event.currentTarget,[{label:'ファイルから入力',run:()=>file.click()},{label:'入力をコピー',run:()=>api.copyText(script.input)}]),'icon-button');inputMore.setAttribute('aria-label','入力の操作');
    inputHeading.append(el('h2','','入力'),format,inputMore);inputSection.append(inputHeading,editor.element,file);
    const output=el('section','script-output'),outputHeading=el('div','script-section-heading');
    const outputMore=btn('⋯',event=>openItemMenu(event.currentTarget,[
      {label:'結果をコピー',disabled:!results.has(script.id),run:()=>api.copyText($('standaloneScriptResult').textContent)},
      {label:'結果を保存',disabled:results.get(script.id)?.state!=='success',run:()=>{const result=results.get(script.id)?.result;downloadText(`${script.name}.${typeof result==='string'?'txt':'json'}`,formatScriptValue(result));}},
      {label:'結果を入力に使う',disabled:results.get(script.id)?.state!=='success'||!validScriptData({value:results.get(script.id)?.result}),run:()=>{const result=results.get(script.id).result;script.inputFormat=typeof result==='string'?'text':'json';script.input=formatScriptValue(result);format.value=script.inputFormat;editor.setLanguage(script.inputFormat);editor.setValue(script.input);fitInput();changed();}}
    ]),'icon-button');outputMore.setAttribute('aria-label','結果の操作');
    outputHeading.append(el('h2','','結果'),outputMore);
    const result=el('pre','standalone-script-result');result.id='standaloneScriptResult';result.tabIndex=0;output.append(outputHeading,result);
    const logSection=el('section','script-log-section'),logHeading=el('div','script-section-heading'),log=el('pre','standalone-script-log');log.id='standaloneScriptLog';log.tabIndex=0;
    logHeading.append(el('h2','','ログ'),btn('コピー',()=>api.copyText(log.textContent),'text-button'));logSection.append(logHeading,log);
    io.append(inputSection,output,logSection);grid.append(code,io);body.append(grid);paintResult();
  }
  function paintResult(){
    if(api.side()!=='scripts')return;
    const script=current(),status=$('standaloneScriptStatus');if(!script||!status)return;
    const entry=results.get(script.id)||{state:'idle',logs:[]};
    status.dataset.state=entry.state;status.textContent={idle:'未実行',running:'実行中',success:'完了',error:'エラー',stopped:'停止'}[entry.state];
    $('runStandaloneScript').hidden=entry.state==='running';$('stopStandaloneScript').hidden=entry.state!=='running';
    const result=$('standaloneScriptResult');result.textContent=entry.error|| (entry.state==='success'?formatScriptValue(entry.result):'');
    result.closest('.script-output').hidden=entry.state!=='success'&&!entry.error;
    const log=$('standaloneScriptLog'),atBottom=log.scrollTop+log.clientHeight>=log.scrollHeight-12;
    log.closest('.script-log-section').hidden=!entry.logs.length;
    log.textContent=entry.logs.map(line=>`${line.level==='warn'?'WARN ':line.level==='error'?'ERROR ':''}${line.message}`).join('\n');if(atBottom)log.scrollTop=log.scrollHeight;
  }
  function scheduleLog(){if(logFrame)return;logFrame=requestAnimationFrame(()=>{logFrame=0;paintResult();});}
  async function run(script=current()){
    if(!script||controllers.has(script.id))return;
    const record={state:'running',logs:[],result:undefined,error:''};results.set(script.id,record);
    const control=new AbortController();controllers.set(script.id,control);api.runningChanged();paintResult();
    const target=w(),environmentId=target.environmentId,environment=target.environments.find(env=>env.id===environmentId);
    try{
      const payload=parseScriptInput(script),snapshot=clone(script);
      const ribbonOwner=api.active?.();
      const context=makeScriptContext(target,primary,{input:payload,scriptId:script.id,environmentId,ribbonOwner});
      const host=createScriptHost({workspace:target,primary,environmentId,filesFor:api.filesFor,getResponses:api.getResponses,runRelation:api.runScriptRelation,onResponse:api.recordResponse});
      const output=await runScript(snapshot.source,context,{signal:control.signal,timeoutMs:snapshot.timeoutMs,onCall:host,onLog:line=>{record.logs.push(line);scheduleLog();}});
      if(control.signal.aborted)throw new DOMException('スクリプトを停止しました。','AbortError');
      if(w()!==target)throw new Error('ワークスペースが変更されたため、処理結果を反映できません。');
      const saved=applyScriptWrites(target,primary,environment,output);if(saved)persist();
      record.state='success';record.result=output.result;record.logs=output.logs || record.logs;
      api.workspaceChanged?.(output);
    }catch(error){record.state=error.name==='AbortError'?'stopped':'error';record.error=error.message;if(error.logs?.length)record.logs=error.logs;}
    finally{controllers.delete(script.id);api.runningChanged();paintResult();}
  }
  function keydown(event){
    if(api.side()!=='scripts'||$('modal').open)return false;
    if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();run();return true;}
    if(event.key==='Escape'&&controllers.has(selectedId)){event.preventDefault();controllers.get(selectedId).abort();return true;}
    return false;
  }
  function refreshForChanges(output){
    const flatten=value=>value?.stages?value.stages.flatMap(flatten):value?[value]:[];
    const changed=flatten(output).some(stage=>(stage.workspaceWrites||[]).some(change=>change.path[0]==='scripts'&&(change.kind!=='order'||change.path.length>1)&&(!change.path[1]||change.path[1].id===selectedId)));
    if(changed){paintedId='';render(true);}else paintResult();
  }
  ensureScripts(w());
  return {open,create,sidebar,render,run,keydown,reference,sharedData,refreshForChanges,isRunning:()=>controllers.size>0,
    stop(){for(const control of controllers.values())control.abort();},
    reset(){selectedId='';paintedId='';results.clear();ensureScripts(w());},invalidate(){paintedId='';}};
}
