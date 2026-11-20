/** Ribbon authoring and live controls share the saved, typed workspace state. */
import {clone,uid,walkItems,findItem} from './core.mjs';
import {ensureRibbons,newRibbon,newRibbonGroup,newRibbonControl,listRibbonControls,resolveRibbon,resolveRibbonControl,
  normalizeRibbonValue,evaluateRibbonCondition,ribbonControlState,prepareRibbonWrites,validRibbonKey,
  getRequestRibbonOwner,getRequestRibbonState,ensureRequestRibbonState,findRequestRibbonState,requestRibbonWorkspace,cloneRibbonState} from './ribbons.mjs';
import {requestKey} from './revisions.mjs';
import {PrimaryVariables} from './runtime.mjs';
import {applyScriptWrites} from './scripts.mjs';
import {runScript} from './script-runner.mjs';
import {makeScriptContext,createScriptHost,formatScriptValue} from './script-host.mjs';
import {confirmAction} from './confirm-dialog.mjs';
import {createEmbeddedScriptEditor} from './embedded-script-editor.mjs';
import {scriptEditorContext} from './script-editor-context.mjs';

const TYPES=[['button','ボタン'],['text','文字入力'],['number','数値入力'],['select','選択欄'],['toggle','チェック'],['display','値表示']];
const SOURCES=[['ribbon','リボンの値'],['store','共有データ'],['environment','環境変数'],['globals','Globals'],['variables','一次変数']];
const OPERATORS=[['eq','等しい'],['ne','等しくない'],['truthy','真である'],['falsy','偽である'],['gt','より大きい'],['gte','以上'],['lt','より小さい'],['lte','以下'],['contains','含む'],['empty','空である'],['notEmpty','空でない']];
const UNARY=new Set(['truthy','falsy','empty','notEmpty']);
const keyValid=validRibbonKey;
const freshKey=(base,keys)=>{let index=1;while(keys.includes(base+index))index++;return base+index;};
const showValue=value=>typeof value==='string'?value:JSON.stringify(value)??'';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export function initRibbonWorkspace(api){
  const {$,element:el,button:btn,input,select,field,openItemMenu,bindContext,showModal,closeModal,persist,toast,primary}=api;
  const w=api.workspace,controllers=new Map(),results=new Map(),lastResults=new Map(),expandedReferences=new Set(),resultViews=new WeakMap();
  const empty={ribbons:[],activeRibbonId:'',ribbonBindings:{}};
  const state=()=>getRequestRibbonState(w(),api.active())||empty;
  const scoped=(workspace=w(),scopeId=state().id)=>requestRibbonWorkspace(workspace,findRequestRibbonState(workspace,scopeId));
  const operationKey=(id,scopeId=state().id)=>`${scopeId}:${id}`;
  let ownerKey='',selectedId='',groupId='',controlId='',paintedId='',frame=0,barSignature='',canvasSignature='',propertySignature='',dragged=null;
  const current=()=>state().ribbons.find(item=>item.id===selectedId);
  const selectedGroup=()=>current()?.groups.find(item=>item.id===groupId);
  const selectedControl=()=>selectedGroup()?.controls.find(item=>item.id===controlId);
  const propertyState=()=>{const ribbon=current(),group=selectedGroup(),control=selectedControl();return JSON.stringify(control?[group?.id,group?.name,control]:group?[group.id,group.name,group.controls.map(item=>[item.id,item.label,item.type])]:[ribbon?.id,ribbon?.name,ribbon?.groups.map(item=>[item.id,item.name,item.controls.length])]);};
  const context=(workspace=w(),variables=primary,ribbonId=state().activeRibbonId,scopeId=state().id)=>({workspace:scoped(workspace,scopeId),primary:variables,environment:workspace.environments.find(item=>item.id===workspace.environmentId),ribbonId});
  const changed=()=>{persist();refresh();};
  function selected(){
    const key=requestKey(w(),api.active())+':'+(state().id||'');
    if(ownerKey!==key){ownerKey=key;selectedId='';groupId='';controlId='';paintedId='';barSignature='';}
    if(!current())selectedId=state().ribbons[0]?.id||'';return current();
  }
  function open(id){selected();selectedId=id||selectedId;groupId='';controlId='';paintedId='';api.openRibbons();}
  function activate(id){state().activeRibbonId=id;changed();if(api.side()==='ribbons')paintHeading();}
  function requestEntries(){
    const entries=[];
    for(const collection of w().collections)walkItems(collection.item,(item,parents)=>{
      if(!item.request)return;const tab={id:item._mpId,collectionId:collection._mpId,itemId:item._mpId,request:item.request,name:item.name};
      entries.push({key:requestKey(w(),tab),label:`${item.request.method||'GET'}  ${item.name} · ${[collection.info.name,...parents.map(item=>item.name)].join(' / ')}`,collection,item,tab});
    });
    for(const tab of w().tabs){const collection=w().collections.find(item=>item._mpId===tab.collectionId);if(findItem(collection,tab.itemId)?.item.request)continue;
      entries.push({key:requestKey(w(),tab),label:`${tab.request.method||'GET'}  ${tab.name} · 下書き`,tab});}
    const active=api.active(),key=requestKey(w(),active);
    if(!entries.some(item=>item.key===key))entries.push({key,label:`${active.request.method||'GET'}  ${active.name} · 未保存`,tab:active});
    return entries;
  }
  function selectOwner(key){const entry=requestEntries().find(item=>item.key===key);if(!entry)return;
    if(entry.item)api.openRequest(entry.collection,entry.item);else api.selectRequest(entry.tab.id);
    selected();paintedId='';api.openRibbons();
  }
  function importLegacy(){
    if(state().ribbons.length||!w().ribbons?.length)return;
    const tab=api.ensureRibbonOwner(),owner=getRequestRibbonOwner(w(),tab);if(!owner)return;
    owner.ribbonState=cloneRibbonState(w());tab.ribbonState=owner.ribbonState;
    changed();selected();paintedId='';api.renderSidebar();render(true);
  }
  function create(afterId=null){
    let name='新しいリボン';
    showModal('リボンを作成',field('リボン名',input(name,'リボン名',value=>name=value)),()=>{
      if(!name.trim())throw new Error('リボン名を入力してください。');
      ensureRequestRibbonState(w(),api.ensureRibbonOwner());selected();
      const ribbon=newRibbon(name.trim());ribbon.key=freshKey('ribbon',state().ribbons.map(item=>item.key));
      const at=state().ribbons.findIndex(item=>item.id===afterId);state().ribbons.splice(at<0?state().ribbons.length:at+1,0,ribbon);
      state().activeRibbonId=ribbon.id;changed();closeModal();open(ribbon.id);
    },'作成');
  }
  function renameReferences(ribbon,previousKey){
    for(const item of state().ribbons)for(const group of item.groups)for(const control of group.controls){
      for(const condition of [control.visibleWhen,control.enabledWhen,...control.actions.map(action=>action.when)])
        for(const rule of condition?.rules||[])if(rule.source==='ribbon'&&rule.key.startsWith(previousKey+'.'))rule.key=ribbon.key+rule.key.slice(previousKey.length);
      for(const action of control.actions){
        if(action.type==='activate'&&action.target===previousKey)action.target=ribbon.id;
        else if(action.target?.startsWith(previousKey+'.'))action.target=ribbon.key+action.target.slice(previousKey.length);
      }
    }
  }
  function duplicate(ribbon){
    const copy=clone(ribbon),ids=new Map();copy.id=uid();copy.name+=' のコピー';copy.key=freshKey(ribbon.key+'_',state().ribbons.map(item=>item.key));ids.set(ribbon.id,copy.id);
    for(const group of copy.groups){const old=group.id;group.id=uid();ids.set(old,group.id);for(const control of group.controls){const old=control.id;control.id=uid();ids.set(old,control.id);}}
    const remap=ref=>ids.get(ref)||(typeof ref==='string'&&ref.startsWith(ribbon.key+'.')?copy.key+ref.slice(ribbon.key.length):ref);
    for(const group of copy.groups)for(const control of group.controls){
      for(const condition of [control.visibleWhen,control.enabledWhen,...control.actions.map(action=>action.when)])for(const rule of condition?.rules||[])if(rule.source==='ribbon')rule.key=remap(rule.key);
      for(const action of control.actions){action.id=uid();if(action.target)action.target=remap(action.target);}
    }
    state().ribbons.splice(state().ribbons.indexOf(ribbon)+1,0,copy);changed();open(copy.id);
  }
  async function removeRibbon(ribbon){
    if(!await confirmAction(`「${ribbon.name}」を削除しますか？`))return;
    const scope=state();
    for(const group of ribbon.groups)for(const control of group.controls)controllers.get(operationKey(control.id))?.abort();
    scope.ribbons=scope.ribbons.filter(item=>item!==ribbon);
    if(scope.activeRibbonId===ribbon.id)scope.activeRibbonId=scope.ribbons[0]?.id||'';
    changed();paintedId='';api.renderSidebar();render(true);
  }
  function editRibbon(ribbon){
    let name=ribbon.name,key=ribbon.key;
    const box=el('div');box.append(field('名前',input(name,'リボン名',value=>name=value)),field('参照キー',input(key,'リボンの参照キー',value=>key=value)));
    showModal('リボンの設定',box,()=>{
      name=name.trim();key=key.trim();
      if(!name)throw new Error('リボン名を入力してください。');
      if(!keyValid(key)||state().ribbons.some(item=>item!==ribbon&&item.key===key))throw new Error('キーは文字または _ で始め、文字・数字・_・-を使って重複しない名前にしてください。');
      const previous=ribbon.key;ribbon.name=name;ribbon.key=key;renameReferences(ribbon,previous);
      changed();closeModal();api.renderSidebar();render(true);
    },'保存');
  }
  function ribbonMenu(ribbon){return [
    {label:'リボンの設定',run:()=>editRibbon(ribbon)},
    {label:state().activeRibbonId===ribbon.id?'リボンを非表示':'このリボンを表示',run:()=>activate(state().activeRibbonId===ribbon.id?'':ribbon.id)},
    {label:'参照キーをコピー',run:()=>api.copyText(ribbon.key)},
    {label:'複製',run:()=>duplicate(ribbon)},
    {label:'リボンを追加',run:()=>create(ribbon.id)},
    {label:'削除',danger:true,run:()=>removeRibbon(ribbon)}
  ];}
  function sidebar(){
    selected();const root=$('sidebarContent'),query=$('search').value.toLowerCase();root.replaceChildren();
    $('sidebarAdd').hidden=false;$('clearHistory').hidden=true;$('search').placeholder='リボンを検索';$('sidebarAdd').setAttribute('aria-label','リボンを追加');
    let count=0;
    for(const ribbon of state().ribbons.filter(item=>(item.name+' '+item.key).toLowerCase().includes(query))){
      const row=el('div',`tree-row${ribbon.id===selectedId?' selected':''}`);row.dataset.ribbonId=ribbon.id;
      const name=btn(ribbon.name,()=>open(ribbon.id),'tree-open'),more=btn('⋯',()=>{},'icon-button');name.title=ribbon.name;more.setAttribute('aria-label',`${ribbon.name}の操作`);
      row.append(name,more);bindContext(row,more,(anchor,event)=>openItemMenu(anchor,ribbonMenu(ribbon),event));root.append(row);count++;
    }
    if(!count)root.append(el('p','sidebar-empty',query?'一致する項目なし':'このリクエストにリボンはありません'));
  }
  function addGroup(){
    const ribbon=current();if(!ribbon)return;
    let name='グループ';showModal('グループを追加',field('グループ名',input(name,'グループ名',value=>name=value)),()=>{
      if(!name.trim())throw new Error('グループ名を入力してください。');
      const group=newRibbonGroup(name.trim());ribbon.groups.push(group);groupId=group.id;controlId='';changed();closeModal();paintCanvas(true);paintProperties();
    },'追加');
  }
  function addControl(type,group=selectedGroup()||current()?.groups.at(-1),afterId=null){
    const ribbon=current();if(!ribbon)return;
    if(!group){group=newRibbonGroup('グループ');ribbon.groups.push(group);}
    const control=newRibbonControl(type,TYPES.find(([key])=>key===type)?.[1]||'項目');
    control.key=freshKey(type,ribbon.groups.flatMap(item=>item.controls.map(control=>control.key)));
    const at=group.controls.findIndex(item=>item.id===afterId);group.controls.splice(at<0?group.controls.length:at+1,0,control);
    groupId=group.id;controlId=control.id;changed();chooseControl(group,control);
  }
  function addMenu(anchor,event,group,afterId){
    const items=TYPES.map(([type,name])=>({label:name,run:()=>addControl(type,group,afterId)}));
    if(!group)items.push(null,{label:'グループを追加',run:addGroup});openItemMenu(anchor,items,event);
  }
  function move(array,item,offset){const at=array.indexOf(item),next=at+offset;if(at<0||next<0||next>=array.length)return;array.splice(at,1);array.splice(next,0,item);changed();paintCanvas(true);}
  async function removeGroup(group){
    if(!await confirmAction(`「${group.name}」とその項目を削除しますか？`))return;
    for(const control of group.controls)controllers.get(operationKey(control.id))?.abort();
    current().groups=current().groups.filter(item=>item!==group);groupId='';controlId='';changed();paintCanvas(true);paintProperties();
  }
  async function removeControl(group,control){
    if(!await confirmAction(`「${control.label}」を削除しますか？`))return;
    controllers.get(operationKey(control.id))?.abort();group.controls=group.controls.filter(item=>item!==control);controlId='';changed();paintCanvas(true);paintProperties();
  }
  function controlMenu(group,control){return [
    {label:'編集',run:()=>chooseControl(group,control)},
    {label:'前へ移動',disabled:group.controls[0]===control,run:()=>move(group.controls,control,-1)},
    {label:'後へ移動',disabled:group.controls.at(-1)===control,run:()=>move(group.controls,control,1)},
    {label:'複製',run:()=>{const copy=clone(control);copy.id=uid();copy.key=freshKey(control.key+'_',current().groups.flatMap(item=>item.controls.map(control=>control.key)));copy.actions.forEach(action=>action.id=uid());group.controls.splice(group.controls.indexOf(control)+1,0,copy);changed();chooseControl(group,copy);}},
    {label:'参照キーをコピー',run:()=>api.copyText(current().key+'.'+control.key)},
    {label:'削除',danger:true,run:()=>removeControl(group,control)}
  ];}
  function chooseControl(group,control){
    groupId=group.id;controlId=control?.id||'';paintCanvas(true);paintProperties();
    const body=$('workspacePage').querySelector('.ribbons-page');if(body)body.dataset.ribbonPane='settings';
    if(matchMedia('(max-width:900px)').matches||body?.clientWidth<=760)$('workspacePage').scrollTop=0;
    else $('ribbonCanvas')?.querySelector(`[data-control-id="${controlId}"]`)?.focus({preventScroll:true});
  }
  function backToList(){
    const page=$('workspacePage'),body=page.querySelector('.ribbons-page');if(body)body.dataset.ribbonPane='list';page.scrollTop=0;$('ribbonCanvas')?.focus({preventScroll:true});
  }
  function paintMobileContext(){
    const owner=$('ribbonMobileOwner'),selection=$('ribbonMobileSelection');if(!owner||!selection)return;
    owner.textContent=api.active().name;owner.title=`対象リクエスト: ${api.active().name}`;
    selection.textContent=selectedControl()?.label||selectedGroup()?.name||'項目を選択';selection.title=selection.textContent;
  }
  function paintHeading(){const action=$('activateRibbon');if(action&&current())action.hidden=state().activeRibbonId===current().id;}
  function render(force=false){
    const ribbon=selected(),page=$('workspacePage');
    const identity=ownerKey+':'+(ribbon?.id||'empty');
    if(!force&&paintedId===identity&&page.querySelector('.ribbons-page')){refresh();return;}
    paintedId=identity;canvasSignature='';page.replaceChildren();
    const body=el('div','ribbons-page');body.dataset.ribbonPane='list';page.append(body);
    const contextHeading=el('header','ribbon-context-heading'),title=el('div','ribbon-page-title');
    title.append(el('h1','','リボン'));
    const back=btn('戻る',()=>api.showRibbonRequest(),'button');back.id='ribbonBackToRequest';back.title='リクエストへ戻る';back.setAttribute('aria-label','リクエストへ戻る');contextHeading.append(title);body.append(contextHeading);
    const ownerSelect=select(requestEntries().map(item=>[item.key,item.label]),requestKey(w(),api.active()),selectOwner);ownerSelect.id='ribbonOwnerSelect';ownerSelect.setAttribute('aria-label','リボンの対象リクエスト');
    contextHeading.append(field('対象リクエスト',ownerSelect),back);
    if(!ribbon){
      const blank=el('section','ribbon-empty');
      const tools=el('div','ribbon-empty-actions');tools.append(btn('リボンを作成',()=>create(),'button primary'));
      if(w().ribbons?.length)tools.append(btn('以前のリボンを取り込む',importLegacy,'button'));
      blank.append(tools);body.append(blank);return;
    }
    const heading=el('div','ribbon-editor-heading');
    const activateButton=btn('このリボンを表示',()=>activate(ribbon.id));activateButton.id='activateRibbon';
    const menu=btn('⋯',event=>openItemMenu(event.currentTarget,ribbonMenu(ribbon),event),'icon-button');menu.setAttribute('aria-label','リボンの操作');
    const ribbonPicker=select(state().ribbons.map(item=>[item.id,item.name]),ribbon.id,id=>open(id));ribbonPicker.setAttribute('aria-label','編集するリボン');
    heading.append(field('リボン',ribbonPicker),activateButton,menu);body.append(heading);
    const tools=el('div','ribbon-editor-tools');
    const mobileContext=el('div','ribbon-mobile-context'),mobileCopy=el('div','ribbon-mobile-copy'),mobileOwner=el('span'),mobileSelection=el('strong');
    mobileContext.id='ribbonMobileContext';mobileContext.setAttribute('role','region');mobileContext.setAttribute('aria-label','リボンの編集対象');
    mobileOwner.id='ribbonMobileOwner';mobileSelection.id='ribbonMobileSelection';mobileCopy.append(mobileOwner,el('span','ribbon-mobile-separator','›'),mobileSelection);
    const mobileBack=btn('一覧',backToList,'button');mobileBack.setAttribute('aria-label','項目一覧へ戻る');mobileBack.dataset.ribbonBackToList='';mobileContext.append(mobileCopy,mobileBack);body.append(mobileContext);
    const outline=el('section','ribbon-outline'),outlineHeading=el('div','ribbon-outline-heading');
    tools.append(btn('項目を追加 ▾',event=>addMenu(event.currentTarget,event),'button'));
    outlineHeading.append(el('h2','','構成'),tools);
    const grid=el('div','ribbon-editor-grid'),canvas=el('section','ribbon-canvas'),properties=el('section','ribbon-properties');
    canvas.id='ribbonCanvas';canvas.tabIndex=-1;canvas.setAttribute('aria-label','リボンの項目一覧');properties.id='ribbonProperties';properties.setAttribute('aria-label','選択項目の設定');
    outline.append(outlineHeading,canvas);grid.append(outline,properties);body.append(grid);paintHeading();paintCanvas(true);paintProperties();
  }
  function paintCanvas(force=false){
    const root=$('ribbonCanvas'),ribbon=current();if(!root||api.side()!=='ribbons'||!ribbon)return;
    const signature=JSON.stringify([ribbon,groupId,controlId]);if(!force&&signature===canvasSignature)return;canvasSignature=signature;root.replaceChildren();
    if(!ribbon.groups.length)return;
    for(const group of ribbon.groups){
      const section=el('section','ribbon-canvas-group');section.dataset.groupId=group.id;section.dataset.selected=String(groupId===group.id);
      const heading=el('div','ribbon-group-heading'),title=btn(group.name,()=>chooseControl(group,null),'text-button'),add=btn('＋',event=>addMenu(event.currentTarget,event,group),'icon-button'),more=btn('⋯',event=>openItemMenu(event.currentTarget,[
        {label:'名前を編集',run:()=>chooseControl(group,null)},
        {label:'前へ移動',disabled:ribbon.groups[0]===group,run:()=>move(ribbon.groups,group,-1)},
        {label:'後へ移動',disabled:ribbon.groups.at(-1)===group,run:()=>move(ribbon.groups,group,1)},
        {label:'削除',danger:true,run:()=>removeGroup(group)}
      ],event),'icon-button');title.setAttribute('aria-pressed',String(groupId===group.id&&!controlId));add.setAttribute('aria-label',`${group.name}に項目を追加`);more.setAttribute('aria-label',`${group.name}の操作`);heading.append(title,add,more);
      const items=el('div','ribbon-canvas-items');
      for(const control of group.controls){
        const item=el('div',`ribbon-design-control${controlId===control.id?' selected':''}`);item.dataset.controlId=control.id;item.draggable=true;item.tabIndex=0;item.setAttribute('role','button');item.setAttribute('aria-label',`${control.label}を編集`);item.setAttribute('aria-pressed',String(controlId===control.id));
        const label=el('strong','ribbon-item-label',control.label),type=el('span','ribbon-item-type',TYPES.find(([key])=>key===control.type)?.[1]||'項目');
        const conditions=(control.visibleWhen?.rules.length||0)+(control.enabledWhen?.rules.length||0);
        item.title=[control.key,conditions&&`条件 ${conditions}`,control.actions.length&&`処理 ${control.actions.length}`,control.visible===false&&'非表示',control.enabled===false&&'操作不可'].filter(Boolean).join(' · ');
        item.append(label,type);
        item.onclick=()=>chooseControl(group,control);
        item.oncontextmenu=event=>{event.preventDefault();openItemMenu(item,controlMenu(group,control),event);};
        item.onkeydown=event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();chooseControl(group,control);}else if(event.altKey&&['ArrowLeft','ArrowUp','ArrowRight','ArrowDown'].includes(event.key)){event.preventDefault();move(group.controls,control,['ArrowLeft','ArrowUp'].includes(event.key)?-1:1);root.querySelector(`[data-control-id="${control.id}"]`)?.focus();}else if(event.key==='Delete'){event.preventDefault();void removeControl(group,control);}};
        item.ondragstart=event=>{dragged={ribbonId:ribbon.id,groupId:group.id,controlId:control.id};event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',control.id);};
        item.ondragend=()=>{dragged=null;root.querySelectorAll('.ribbon-drop').forEach(node=>node.classList.remove('ribbon-drop'));};
        item.ondragover=event=>{if(dragged?.ribbonId!==ribbon.id||dragged.controlId===control.id)return;event.preventDefault();item.classList.add('ribbon-drop');};
        item.ondragleave=()=>item.classList.remove('ribbon-drop');
        item.ondrop=event=>{if(!dragged||dragged.ribbonId!==ribbon.id)return;event.preventDefault();event.stopPropagation();const bounds=item.getBoundingClientRect();dropControl(group,control.id,event.clientY>bounds.y+bounds.height/2);};items.append(item);
      }
      items.ondragover=event=>{if(dragged?.ribbonId===ribbon.id)event.preventDefault();};items.ondrop=event=>{if(!dragged||dragged.ribbonId!==ribbon.id)return;event.preventDefault();dropControl(group);};
      section.append(heading,items);root.append(section);
    }
  }
  function dropControl(group,targetId=null,after=false){
    const source=current()?.groups.find(item=>item.id===dragged?.groupId),control=source?.controls.find(item=>item.id===dragged?.controlId);dragged=null;
    if(!control||control.id===targetId)return;source.controls.splice(source.controls.indexOf(control),1);
    const index=group.controls.findIndex(item=>item.id===targetId);group.controls.splice(index<0?group.controls.length:index+(after?1:0),0,control);
    groupId=group.id;controlId=control.id;changed();paintCanvas(true);paintProperties();
  }
  function checkField(label,value,change){const node=el('input');node.type='checkbox';node.checked=value;node.onchange=()=>change(node.checked);const box=el('label','ribbon-check');box.append(node,label);return box;}
  function typedValue(value,onChange,label='値'){
    const box=el('div','ribbon-typed-value');let type=typeof value==='string'?'text':typeof value==='number'?'number':typeof value==='boolean'?'boolean':'json';
    const picker=select([['text','文字列'],['number','数値'],['boolean','真偽値'],['json','JSON']],type,next=>{type=next;draw(true);});picker.setAttribute('aria-label',label+'の型');box.append(picker);
    const editor=el('div','ribbon-value-editor');box.append(editor);
    function draw(convert=false){
      editor.replaceChildren();
      if(type==='boolean'){
        if(convert)value=value===true||value==='true';const node=select([['true','true'],['false','false']],String(value),next=>{value=next==='true';onChange(value);});node.setAttribute('aria-label',label);editor.append(node);if(convert)onChange(value);return;
      }
      if(convert)value=type==='number'?(Number.isFinite(Number(value))?Number(value):0):type==='text'?showValue(value):value;
      const node=type==='json'?el('textarea'):input(value,label,()=>{},type==='number'?'number':'text');
      if(type==='json'){node.value=JSON.stringify(value,null,2);node.rows=3;node.setAttribute('aria-label',label);node.spellcheck=false;}if(type==='number')node.step='any';
      node.oninput=()=>{
        try{const next=type==='json'?JSON.parse(node.value):type==='number'?node.value.trim()===''?null:Number(node.value):node.value;
          if(type==='number'&&!Number.isFinite(next))throw new Error('数値を入力してください。');
          if(type==='json')normalizeRibbonValue({type:'display'},next);
          value=next;node.setCustomValidity('');onChange(value);
        }catch{node.setCustomValidity(type==='json'?'JSONの形式を確認してください。':'数値を入力してください。');}
      };node.onchange=()=>node.reportValidity();editor.append(node);if(convert)onChange(value);
    }
    draw();return box;
  }
  function referenceOptions(selectedRef='',includeButtons=true){
    const choices=listRibbonControls(scoped()).filter(({control})=>includeButtons||control.type!=='button').map(({ribbon,control})=>[control.id,`${ribbon.name} / ${control.label}`]);
    if(selectedRef&&!choices.some(([id])=>id===selectedRef))choices.push([selectedRef,selectedRef]);return [['','選択してください'],...choices];
  }
  function conditionEditor(owner,property,title,redraw=null){
    const section=el('section','ribbon-condition'),heading=el('div','ribbon-setting-heading');
    if(property==='visibleWhen')heading.append(checkField('表示',owner.visible!==false,value=>{owner.visible=value;changed();}));
    if(property==='enabledWhen')heading.append(checkField('操作を許可',owner.enabled!==false,value=>{owner.enabled=value;changed();}));
    section.setAttribute('aria-label',title);heading.append(el('h3','','条件'));const add=btn('＋',()=>{owner[property]||={mode:'all',rules:[]};owner[property].rules.push({source:'ribbon',key:selectedControl()?.id||'',operator:'eq',value:true});changed();(redraw||draw)();},'button');add.setAttribute('aria-label',title+'を追加');add.title=title+'を追加';heading.append(add);section.append(heading);const body=el('div');section.append(body);
    function draw(){
      body.replaceChildren();const condition=owner[property];section.dataset.empty=String(!condition?.rules.length);if(!condition?.rules.length)return;
      if(condition.rules.length>1){const mode=select([['all','すべての条件を満たす'],['any','いずれかの条件を満たす']],condition.mode,value=>{condition.mode=value;changed();});mode.setAttribute('aria-label',title+'の組み合わせ');body.append(field('組み合わせ',mode));}
      condition.rules.forEach((rule,index)=>{
        const row=el('div','ribbon-condition-row');row.dataset.ruleIndex=index;row.setAttribute('aria-label',`${title} ${index+1}`);
        const source=select(SOURCES,rule.source,value=>{rule.source=value;rule.key='';changed();draw();});source.setAttribute('aria-label',title+'の参照元');
        const target=rule.source==='ribbon'?select(referenceOptions(rule.key,false),rule.key,value=>{rule.key=value;changed();}):input(rule.key,title+'のキー',value=>{rule.key=value;changed();});target.setAttribute('aria-label',title+'の参照項目');
        const op=select(OPERATORS,rule.operator,value=>{rule.operator=value;if(!UNARY.has(value)&&!Object.hasOwn(rule,'value'))rule.value='';changed();draw();});op.setAttribute('aria-label',title+'の比較');
        const remove=btn('×',()=>{condition.rules.splice(index,1);changed();(redraw||draw)();},'icon-button ribbon-rule-remove');remove.setAttribute('aria-label',title+'を削除');remove.title='条件を削除';
        row.append(field('参照元',source),field(rule.source==='ribbon'?'項目':'変数・データのキー',target),field('比較',op));
        if(!UNARY.has(rule.operator))row.append(field('値',typedValue(rule.value,value=>{rule.value=value;changed();},title+'の比較値')));row.append(remove);body.append(row);
      });
    }
    draw();return section;
  }
  function actionsEditor(control){
    const section=el('section','ribbon-actions-editor'),heading=el('div','ribbon-setting-heading');heading.append(el('h3','',control.type==='button'?'クリック時の処理':'変更時の処理'));
    const add=btn('処理を追加',()=>{control.actions.push({id:uid(),type:'script',scriptId:w().scripts[0]?.id||''});changed();draw();},'button');heading.append(add);section.append(heading);
    const body=el('div','ribbon-action-list');section.append(body);
    const scopeId=state().id,embeddedEditors=new Map();
    const liveControl=()=>listRibbonControls(scoped(w(),scopeId)).find(item=>item.control.id===control.id)?.control;
    const liveAction=id=>liveControl()?.actions.find(item=>item.id===id&&item.type==='script');
    function draw(){
      body.replaceChildren();
      const scriptActions=new Set(control.actions.filter(action=>action.type==='script').map(action=>action.id));
      for(const [id,entry]of embeddedEditors)if(!scriptActions.has(id)){entry.editor.dispose();embeddedEditors.delete(id);}
      control.actions.forEach((action,index)=>{
        const row=el('section','ribbon-action');row.dataset.actionId=action.id;
        const top=el('div','ribbon-action-heading');top.append(el('span','ribbon-action-order',String(index+1)));
        const type=select([['script','スクリプト'],['set','値の設定'],['toggle','チェック切替'],['activate','リボン切替']],action.type,value=>{action.type=value;action.target='';delete action.scriptId;action.value='';if(value==='script')action.scriptId=w().scripts[0]?.id||'';changed();draw();});type.setAttribute('aria-label','処理の種類');
        const more=btn('⋯',event=>openItemMenu(event.currentTarget,[
          {label:'上へ移動',disabled:index===0,run:()=>{move(control.actions,action,-1);draw();}},
          {label:'下へ移動',disabled:index===control.actions.length-1,run:()=>{move(control.actions,action,1);draw();}},
          {label:'削除',danger:true,run:()=>{control.actions.splice(index,1);changed();draw();}}
        ],event),'icon-button');more.setAttribute('aria-label',`処理${index+1}の操作`);
        const conditions=conditionEditor(action,'when','実行条件',draw);top.append(type);if(!action.when?.rules.length)top.append(conditions);top.append(more);row.append(top);
        if(action.type==='script'){
          const options=[['','スクリプトを選択'],...w().scripts.map(script=>[script.id,script.name])];if(action.scriptId&&!options.some(([id])=>id===action.scriptId))options.push([action.scriptId,'削除されたスクリプト']);
          const picker=select(options,action.scriptId||'',value=>{const selected=liveAction(action.id);if(!selected)return;selected.scriptId=value;changed();embeddedEditors.get(action.id)?.editor.refresh();});picker.setAttribute('aria-label','実行するスクリプト');
          const line=el('div','ribbon-action-target');let embedded=embeddedEditors.get(action.id);
          const edit=btn('編集',()=>embedded.editor.edit(),'button');
          if(!embedded){
            embedded={editButton:edit};
            embedded.editor=createEmbeddedScriptEditor({workspace:w,primary,scriptId:()=>liveAction(action.id)?.scriptId||'',persist,label:'リボンのスクリプト',
              onState:({available})=>{embedded.editButton.disabled=!available;},onError:error=>toast(error.message),
              intelligenceContext:script=>{
                const context=scriptEditorContext(w(),primary,{script,ribbonOwner:api.active()}),currentControl=liveControl()||control;
                delete context.inputSource;delete context.inputFormat;
                context.input={type:currentControl.type==='button'?'click':'change',ribbonId:current()?.id||'',controlId:currentControl.id,key:currentControl.key,
                  value:clone(currentControl.value),previousValue:clone(currentControl.value),values:Object.fromEntries(listRibbonControls(scoped(w(),scopeId)).filter(item=>item.ribbon.id===current()?.id).map(({control})=>[control.key,clone(control.value)]))};
                return context;
              }});
            embeddedEditors.set(action.id,embedded);
          }
          embedded.editButton=edit;edit.disabled=!embedded.editor.refresh();
          line.append(picker,edit);row.append(field('スクリプト',line),embedded.editor.element);
        }else{
          let options=action.type==='activate'?[['','リボンを選択'],...state().ribbons.map(ribbon=>[ribbon.id,ribbon.name])]:referenceOptions(action.target,false);
          if(action.type==='toggle')options=options.filter(([id])=>!id||listRibbonControls(scoped()).some(({control})=>control.id===id&&control.type==='toggle'));
          if(action.target&&!options.some(([id])=>id===action.target))options.push([action.target,action.target]);
          const picker=select(options,action.target||'',value=>{action.target=value;if(action.type==='set'&&value){try{action.value=clone(resolveRibbonControl(scoped(),value).control.value);}catch{}}changed();draw();});picker.setAttribute('aria-label','処理の対象');row.append(field(action.type==='activate'?'切り替え先のリボン':'対象の項目',picker));
          if(action.type==='set')row.append(field('設定する値',typedValue(action.value??'',value=>{action.value=value;changed();},'設定する値')));
        }
        if(action.when?.rules.length)row.append(conditions);body.append(row);
      });
    }
    draw();return section;
  }
  function paintProperties(){
    const root=$('ribbonProperties'),ribbon=current();if(!root||!ribbon)return;root.replaceChildren();
    const group=selectedGroup(),control=selectedControl();propertySignature=propertyState();root.onfocusout=refresh;
    root.dataset.objectType=control?.type||(group?'group':'ribbon');paintMobileContext();
    const identity=(kind,name,label,onChange,action)=>{
      const header=el('header','ribbon-property-heading'),badge=el('span','ribbon-object-kind',kind);
      header.append(badge,field(label,input(name,control?'項目のラベル':label,onChange)));if(action)header.append(action);return header;
    };
    const section=(title,kind)=>{
      const box=el('section','ribbon-property-section');box.dataset.propertySection=kind;
      if(title)box.append(el('h3','ribbon-section-title',title));root.append(box);return box;
    };
    if(!group){
      const more=btn('⋯',event=>openItemMenu(event.currentTarget,ribbonMenu(ribbon),event),'icon-button');more.setAttribute('aria-label','リボン設定の操作');
      root.append(identity('リボン',ribbon.name,'リボン名',value=>{ribbon.name=value;changed();api.renderSidebar();},more));
      const groups=section('グループ','groups'),list=el('div','ribbon-arrangement');
      for(const item of ribbon.groups){
        const row=el('div','ribbon-arrangement-row'),name=btn(item.name,()=>chooseControl(item,null),'text-button');
        name.append(el('span','ribbon-item-count',String(item.controls.length)));row.append(name);list.append(row);
      }
      const add=btn('グループを追加',addGroup,'button');groups.querySelector('h3').append(add);groups.append(list);return;
    }
    if(!control){
      const add=btn('項目を追加 ▾',event=>addMenu(event.currentTarget,event,group),'button');
      root.append(identity('グループ',group.name,'グループ名',value=>{group.name=value;changed();},add));
      const arrangement=section('並び順','arrangement');
      for(const [index,item] of group.controls.entries()){
        const row=el('div','ribbon-arrangement-row'),name=btn(item.label,()=>chooseControl(group,item),'text-button');
        name.prepend(el('span','ribbon-arrangement-type',TYPES.find(([key])=>key===item.type)?.[1]||'項目'));
        const up=btn('↑',()=>{move(group.controls,item,-1);paintProperties();},'icon-button'),down=btn('↓',()=>{move(group.controls,item,1);paintProperties();},'icon-button');
        up.disabled=index===0;down.disabled=index===group.controls.length-1;up.setAttribute('aria-label',item.label+'を上へ');down.setAttribute('aria-label',item.label+'を下へ');row.append(name,up,down);arrangement.append(row);
      }
      return;
    }
    const more=btn('⋯',event=>openItemMenu(event.currentTarget,controlMenu(group,control),event),'icon-button');more.setAttribute('aria-label','項目の操作');
    const labels={button:'ボタン名',text:'入力欄のラベル',number:'数値欄のラベル',select:'選択欄のラベル',toggle:'チェック項目名',display:'見出し'};
    root.append(identity(TYPES.find(([key])=>key===control.type)?.[1]||'項目',control.label,labels[control.type],value=>{control.label=value;changed();},more));

    if(control.type==='text'){
      const content=section('入力内容','input');
      content.append(input(control.value,'項目の値',value=>{control.value=normalizeRibbonValue(control,value);changed();}));
    }else if(control.type==='number'){
      const content=section('数値','input'),value=input(control.value,'項目の値',()=>{},'number');value.step='any';
      value.oninput=()=>{try{if(!value.value.trim())throw new Error('数値を入力してください。');control.value=normalizeRibbonValue(control,Number(value.value));value.setCustomValidity('');changed();}catch(error){value.setCustomValidity(error.message);}};
      value.onchange=()=>value.reportValidity();content.append(value);
    }else if(control.type==='toggle'){
      const content=section('チェック状態','state'),stateLabel=el('span','ribbon-toggle-state',control.value?'オン':'オフ');
      content.append(checkField('チェック',Boolean(control.value),value=>{control.value=value;stateLabel.textContent=value?'オン':'オフ';changed();}),stateLabel);
    }else if(control.type==='display'){
      const content=section('表示内容','display');
      content.append(typedValue(control.value,value=>{control.value=value;changed();},'表示する値'));
    }else if(control.type==='select'){
      const options=section(null,'options');options.classList.add('ribbon-options');
      const heading=el('div','ribbon-setting-heading');heading.append(el('h3','','選択肢'));
      const list=el('div','ribbon-options-table'),columns=el('div','ribbon-option-columns');
      columns.setAttribute('aria-hidden','true');columns.append(el('span','','選択'),el('span','','表示名'),el('span','','値'),el('span',''));
      function drawOptions(){
        list.replaceChildren(columns);
        control.options.forEach((option,index)=>{
          const row=el('div','ribbon-option-row'),radio=el('input');radio.type='radio';radio.name='ribbon-option-'+control.id;radio.checked=control.value===option.value;radio.setAttribute('aria-label','選択肢'+(index+1)+'を選択');radio.onchange=()=>{if(radio.checked){control.value=option.value;changed();}};
          const value=input(option.value,'選択肢'+(index+1)+'の値',()=>{}),label=input(option.label,'選択肢'+(index+1)+'のラベル',next=>{option.label=next;changed();});
          value.oninput=()=>value.setCustomValidity('');
          value.onchange=()=>{if(control.options.some(item=>item!==option&&item.value===value.value)){value.setCustomValidity('値が重複しています。');value.reportValidity();return;}value.setCustomValidity('');if(control.value===option.value)control.value=value.value;option.value=value.value;changed();};
          const remove=btn('×',()=>{control.options.splice(index,1);if(control.value===option.value)control.value=control.options[0]?.value||'';changed();drawOptions();},'icon-button');remove.setAttribute('aria-label','選択肢'+(index+1)+'を削除');
          row.append(radio,label,value,remove);list.append(row);
        });
      }
      const add=btn('選択肢を追加',()=>{const value=freshKey('option',control.options.map(item=>item.value));control.options.push({value,label:value});if(control.options.length===1)control.value=value;changed();drawOptions();},'button');
      heading.append(add);options.append(heading,list);drawOptions();
    }

    if(control.type!=='display')root.append(actionsEditor(control));
    const conditions=el('section','ribbon-condition-list');conditions.dataset.propertySection='conditions';
    conditions.append(conditionEditor(control,'visibleWhen','表示条件'));
    if(control.type!=='display')conditions.append(conditionEditor(control,'enabledWhen','有効条件'));
    root.append(conditions);
    const reference=el('details','ribbon-reference-settings'),referenceId=operationKey(control.id);
    reference.dataset.propertySection='reference';reference.open=expandedReferences.has(referenceId);
    reference.ontoggle=()=>{reference.open?expandedReferences.add(referenceId):expandedReferences.delete(referenceId);};
    reference.append(el('summary','','参照と配置'));
    const fields=el('div','ribbon-reference-fields'),key=input(control.key,'項目の参照キー',()=>{});key.oninput=()=>key.setCustomValidity('');
    key.onchange=()=>{const value=key.value.trim();if(!keyValid(value)||ribbon.groups.some(group=>group.controls.some(item=>item!==control&&item.key===value))){key.setCustomValidity('キーは文字または _ で始め、文字・数字・_・-を使って重複しない名前にしてください。');key.reportValidity();return;}key.setCustomValidity('');control.key=value;changed();};
    const groupPicker=select(ribbon.groups.map(item=>[item.id,item.name]),group.id,value=>{const target=ribbon.groups.find(item=>item.id===value);if(!target||target===group)return;group.controls.splice(group.controls.indexOf(control),1);target.controls.push(control);groupId=target.id;changed();paintProperties();});groupPicker.setAttribute('aria-label','項目のグループ');
    fields.append(field('参照キー',key),field('グループ',groupPicker));reference.append(fields);root.append(reference);
    const status=el('div','ribbon-operation-result');status.id='ribbonOperationResult';status.setAttribute('role','status');root.append(status);paintResult();
  }
  function makeControl(control,preview=false){
    const scopeId=state().id;
    const box=el('div',`ribbon-control ribbon-control-${control.type}`);box.dataset.ribbonControl=control.id;
    let node;
    if(control.type==='button'){node=btn(control.label,()=>{if(!preview)void interact(control.id,'click',undefined,scopeId);},control.actions.some(action=>action.type==='script')?'button primary':'button');}
    else if(control.type==='display'){node=el('output','ribbon-output',showValue(control.value));node.setAttribute('aria-label',control.label);}
    else if(control.type==='select')node=select(control.options.map(option=>[option.value,option.label]),control.value,()=>{});
    else if(control.type==='toggle'){node=el('input');node.type='checkbox';node.checked=control.value===true;}
    else{node=input(control.value,control.label,()=>{},control.type==='number'?'number':'text');if(control.type==='number')node.step='any';}
    node.dataset.ribbonInput=control.id;node.setAttribute('aria-label',control.label);node.title=control.label;
    if(!preview&&!['button','display'].includes(control.type)){
      const commit=async()=>{
        try{if(control.type==='number'&&(!node.value.trim()||!Number.isFinite(Number(node.value))))throw new Error('数値を入力してください。');
          const value=control.type==='toggle'?node.checked:control.type==='number'?Number(node.value):node.value;
          node.setCustomValidity('');await interact(control.id,'change',value,scopeId,node);
        }catch(error){node.setCustomValidity(error.message);node.reportValidity();}
      };
      node.onchange=commit;
      if(['text','number'].includes(control.type)){
        node.oninput=()=>{node.setCustomValidity('');try{if(control.type==='number'&&(!node.value.trim()||!Number.isFinite(Number(node.value))))return;
          const entry=resolveRibbonControl(scoped(w(),scopeId),control.id),current=entry.control;const next=normalizeRibbonValue(current,control.type==='number'?Number(node.value):node.value);
          if(!Object.hasOwn(node.dataset,'previousValue')){
            const state=ribbonControlState(current,context(w(),primary,entry.ribbon.id,scopeId));if(!state.visible||!state.enabled)return;
            node.dataset.previousValue=JSON.stringify(current.value);
          }
          if(!equal(current.value,next)){current.value=next;changed();}
        }catch(error){node.setCustomValidity(error.message);}};
        node.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();void commit();}};
        node.onblur=()=>refresh();
      }
    }
    if(control.type==='button')box.append(node);
    else{const label=el('label','ribbon-control-label',control.label);node.id=uid();label.htmlFor=node.id;
      if(control.type==='toggle'){const line=el('label','ribbon-toggle');line.append(node,document.createTextNode(control.label));box.append(line);}
      else box.append(label,node);
    }
    return box;
  }
  function paintBar(){
    const root=$('customRibbon'),scope=state();if(!root)return;root.hidden=api.side()!=='collections'||!scope.ribbons.length;
    if(root.hidden){root.replaceChildren();barSignature='';return;}
    const active=scope.ribbons.find(item=>item.id===scope.activeRibbonId);
    const shape=JSON.stringify([scope.id,api.active().name,scope.activeRibbonId,scope.ribbons.map(({id,name})=>({id,name})),active?.groups.map(group=>({id:group.id,name:group.name,controls:group.controls.map(({id,label,type,options,actions})=>({id,label,type,options,script:actions.some(action=>action.type==='script')}))}))]);
    if(shape!==barSignature){
      barSignature=shape;root.replaceChildren();
      root.dataset.singleGroup=String((active?.groups.length||0)<=1);
      if(scope.ribbons.length>1||!active){const selection=select([['','リボンを非表示'],...scope.ribbons.map(item=>[item.id,item.name])],scope.activeRibbonId,id=>activate(id));selection.id='activeRibbon';selection.setAttribute('aria-label','表示するリボン');const selector=el('div','ribbon-selector');selector.append(selection);root.append(selector);}
      const strip=el('div','ribbon-live-groups');strip.setAttribute('aria-label','リボンの操作');
      if(active)for(const group of active.groups){
        const section=el('section','ribbon-live-group');section.dataset.liveGroup=group.id;section.setAttribute('aria-label',group.name);
        const controls=el('div','ribbon-live-controls');for(const control of group.controls)controls.append(makeControl(control));section.append(el('h3','ribbon-live-group-name',group.name),controls);strip.append(section);
      }
      const result=el('div','ribbon-operation-result ribbon-live-result');result.id='ribbonLiveResult';result.setAttribute('role','status');root.append(strip,result);
    }
    if(!active)return;
    let visibleControls=0;
    for(const group of active.groups){let visible=0;for(const control of group.controls){
      const box=[...root.querySelectorAll('[data-ribbon-control]')].find(item=>item.dataset.ribbonControl===control.id);if(!box)continue;
      let state;try{state=ribbonControlState(control,context(w(),primary,active.id));box.removeAttribute('title');}catch(error){state={visible:true,enabled:false};box.title=error.message;}
      const node=box.querySelector('[data-ribbon-input]'),editing=document.activeElement===node&&Object.hasOwn(node.dataset,'previousValue');
      box.hidden=!state.visible&&!editing;if(state.visible||editing)visible++;
      const busy=controllers.has(operationKey(control.id));node.disabled=(!state.enabled&&!editing)||busy;box.setAttribute('aria-busy',String(busy));
      if(control.type==='display')node.textContent=showValue(control.value);
      else if(control.type==='toggle')node.checked=control.value===true;
      else if(control.type!=='button'&&!editing&&node.value!==String(control.value??''))node.value=String(control.value??'');
      const error=results.get(operationKey(control.id))?.error;box.classList.toggle('ribbon-control-error',Boolean(error));if(error)box.title=error;
    }visibleControls+=visible;const section=[...root.querySelectorAll('[data-live-group]')].find(item=>item.dataset.liveGroup===group.id);if(section)section.hidden=!visible;}
    if(!visibleControls&&!root.querySelector('.ribbon-selector')&&!lastResults.has(scope.id))root.hidden=true;
  }
  function paintResult(){
    const live=$('ribbonLiveResult'),last=results.get(lastResults.get(state().id));
    if(live){live.replaceChildren();live.hidden=!last;if(last){live.dataset.state=last.state;live.append(el('strong','',last.label),el('span','',last.state==='running'?'実行中…':last.error||'完了'));
      if(last.state==='running')live.append(btn('停止',()=>controllers.get(last.key)?.abort(),'button'));
    }}
    const box=$('ribbonOperationResult');if(!box)return;const entry=results.get(operationKey(controlId));
    if(!entry){if(box.children.length)box.replaceChildren();resultViews.delete(box);delete box.dataset.state;return;}
    let view=resultViews.get(box);
    if(!view||view.entry!==entry){
      const status=el('span'),stop=btn('停止',()=>controllers.get(entry.key)?.abort(),'text-button');
      const log=el('pre','ribbon-action-log'),result=el('pre','ribbon-action-log');
      log.dataset.ribbonResult='logs';result.dataset.ribbonResult='value';log.tabIndex=0;result.tabIndex=0;
      log.setAttribute('aria-label','実行ログ');result.setAttribute('aria-label','戻り値');
      log.hidden=true;result.hidden=true;box.replaceChildren(status,stop,log,result);view={entry,status,stop,log,result};resultViews.set(box,view);
    }
    const updateText=(node,value,visible,followTail=false)=>{
      node.hidden=!visible;if(!visible||node.textContent===value)return;
      const top=node.scrollTop,left=node.scrollLeft,atBottom=node.scrollHeight-node.clientHeight-top<=4;
      node.textContent=value;node.scrollTop=followTail&&atBottom?node.scrollHeight:top;node.scrollLeft=left;
    };
    const status=entry.state==='running'?'実行中':entry.error||'完了';if(view.status.textContent!==status)view.status.textContent=status;
    view.stop.hidden=entry.state!=='running';box.dataset.state=entry.state;
    updateText(view.log,(entry.logs||[]).map(line=>line.message).join('\n'),Boolean(entry.logs?.length),true);
    const hasResult=Object.hasOwn(entry,'result')&&entry.result!==undefined;
    updateText(view.result,hasResult?formatScriptValue(entry.result):'',hasResult);
  }
  function refresh(){if(frame)return;frame=requestAnimationFrame(()=>{
    frame=0;selected();if(api.side()==='ribbons'&&!paintedId)render(true);paintBar();paintCanvas();paintHeading();paintMobileContext();paintResult();
    const properties=$('ribbonProperties'),signature=propertyState();
    if(properties&&api.side()==='ribbons'&&signature!==propertySignature&&!properties.contains(document.activeElement)&&$('itemMenu').hidden&&!$('modal').open)paintProperties();
  });}
  async function interact(id,type,newValue,scopeId=state().id,inputNode=null){
    const key=operationKey(id,scopeId);if(controllers.has(key))return;
    let entry;try{entry=resolveRibbonControl(scoped(w(),scopeId),id);}catch(error){toast(error.message);return;}
    const {ribbon,control}=entry;
    const node=inputNode||(state().id===scopeId?[...$('customRibbon').querySelectorAll('[data-ribbon-input]')].find(node=>node.dataset.ribbonInput===id):null);
    const acceptedEdit=type==='change'&&node&&Object.hasOwn(node.dataset,'previousValue');
    let availability;try{availability=ribbonControlState(control,context(w(),primary,ribbon.id,scopeId));}catch(error){toast(error.message);return;}
    if(!acceptedEdit&&(!availability.visible||!availability.enabled))return;
    let previous=clone(control.value);
    if(node&&Object.hasOwn(node.dataset,'previousValue')){previous=JSON.parse(node.dataset.previousValue);delete node.dataset.previousValue;}
    if(type==='change'){const next=normalizeRibbonValue(control,newValue);control.value=next;changed();if(equal(previous,next))return;}
    if(!control.actions.length)return;
    const abort=new AbortController(),record={state:'running',logs:[],key,label:control.label};controllers.set(key,abort);results.set(key,record);lastResults.set(scopeId,key);api.runningChanged();refresh();
    const workspace=w(),staged=clone(workspace),temporary=new PrimaryVariables();temporary.rows=clone(primary.rows);
    const environmentId=workspace.environmentId,environment=workspace.environments.find(item=>item.id===environmentId),targetEnvironment=staged.environments.find(item=>item.id===environmentId);
    const combined={stages:[]};
    const collect=output=>combined.stages.push(output);
    try{
      for(const action of clone(control.actions)){
        if(abort.signal.aborted)throw new DOMException('処理を停止しました。','AbortError');
        if(!evaluateRibbonCondition(action.when,context(staged,temporary,ribbon.id,scopeId)))continue;
        if(action.type==='script'){
          const script=staged.scripts.find(item=>item.id===action.scriptId);if(!script)throw new Error('実行するスクリプトがありません。');
          const current=resolveRibbonControl(scoped(staged,scopeId),id).control;
          const payload={type,ribbonId:ribbon.id,controlId:id,key:current.key,value:clone(current.value),previousValue:clone(previous),values:Object.fromEntries(listRibbonControls(scoped(staged,scopeId)).filter(row=>row.ribbon.id===ribbon.id).map(({control})=>[control.key,clone(control.value)]))};
          const scriptContext=makeScriptContext(staged,temporary,{input:payload,scriptId:script.id,environmentId,ribbonScopeId:scopeId});
          const host=createScriptHost({workspace:staged,primary:temporary,environmentId,filesFor:api.filesFor,getResponses:api.getResponses,runRelation:api.runScriptRelation,onResponse:api.recordResponse});
          const output=await runScript(script.source,scriptContext,{signal:abort.signal,timeoutMs:script.timeoutMs,onCall:host,onLog:line=>{record.logs.push(line);refresh();}});
          applyScriptWrites(staged,temporary,targetEnvironment,output);collect(output);record.result=output.result;
        }else{
          let write;if(action.type==='activate'){const next=resolveRibbon(scoped(staged,scopeId),action.target);write={type:'activate',id:next.id,value:next.id,expected:scoped(staged,scopeId).activeRibbonId};}
          else{const target=resolveRibbonControl(scoped(staged,scopeId),action.target,{ribbonId:ribbon.id}).control;if(action.type==='toggle'&&target.type!=='toggle')throw new Error('チェック項目を指定してください。');write={type:'value',id:target.id,value:action.type==='toggle'?!target.value:clone(action.value),expected:clone(target.value),expectedShape:{type:target.type,options:clone(target.options||[])}};}
          prepareRibbonWrites(staged,[write],{scopeId})();collect({writes:{primary:[],environment:[],globals:[]},dataWrites:[],ribbonWrites:[write],ribbonScopeId:scopeId});
        }
      }
      if(abort.signal.aborted)throw new DOMException('処理を停止しました。','AbortError');
      if(w()!==workspace||!listRibbonControls(scoped(workspace,scopeId)).some(row=>row.control.id===id))throw new Error('リボンが変更されたため、処理結果を反映できません。');
      if(applyScriptWrites(workspace,primary,environment,combined))persist();record.state='success';api.workspaceChanged?.(combined);
    }catch(error){record.state=error.name==='AbortError'?'stopped':'error';record.error=error.message;toast(error.message);}
    finally{controllers.delete(key);api.runningChanged();refresh();}
  }
  ensureRibbons(w());refresh();
  return {open,create,sidebar,render,refresh,addGroup,isRunning:()=>controllers.size>0,
    stop(){for(const abort of controllers.values())abort.abort();},reset(){ownerKey='';selectedId='';groupId='';controlId='';paintedId='';barSignature='';canvasSignature='';results.clear();lastResults.clear();ensureRibbons(w());refresh();}};
}
