/** Ribbon authoring and live controls share the saved, typed workspace state. */
import {clone,uid} from './core.mjs';
import {ensureRibbons,newRibbon,newRibbonGroup,newRibbonControl,listRibbonControls,resolveRibbon,resolveRibbonControl,
  normalizeRibbonValue,evaluateRibbonCondition,ribbonControlState,prepareRibbonWrites,validRibbonKey} from './ribbons.mjs';
import {PrimaryVariables} from './runtime.mjs';
import {applyScriptWrites} from './scripts.mjs';
import {runScript} from './script-runner.mjs';
import {makeScriptContext,createScriptHost,formatScriptValue} from './script-host.mjs';
import {confirmAction} from './confirm-dialog.mjs';

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
  const w=api.workspace,controllers=new Map(),results=new Map();
  let selectedId='',groupId='',controlId='',paintedId='',frame=0,barSignature='',canvasSignature='',propertySignature='',dragged=null;
  const current=()=>w().ribbons.find(item=>item.id===selectedId);
  const selectedGroup=()=>current()?.groups.find(item=>item.id===groupId);
  const selectedControl=()=>selectedGroup()?.controls.find(item=>item.id===controlId);
  const context=(workspace=w(),variables=primary,ribbonId=workspace.activeRibbonId)=>({workspace,primary:variables,environment:workspace.environments.find(item=>item.id===workspace.environmentId),ribbonId});
  const changed=()=>{persist();refresh();};
  function selected(){ensureRibbons(w());if(!current())selectedId=w().ribbons[0]?.id||'';return current();}
  function open(id){selectedId=id;groupId='';controlId='';paintedId='';api.openRibbons();}
  function activate(id){w().activeRibbonId=id;changed();if(api.side()==='ribbons')paintHeading();}
  function create(afterId=null){
    let name='新しいリボン';
    showModal('リボンを作成',field('リボン名',input(name,'リボン名',value=>name=value)),()=>{
      if(!name.trim())throw new Error('リボン名を入力してください。');
      const ribbon=newRibbon(name.trim());ribbon.key=freshKey('ribbon',w().ribbons.map(item=>item.key));
      const at=w().ribbons.findIndex(item=>item.id===afterId);w().ribbons.splice(at<0?w().ribbons.length:at+1,0,ribbon);
      w().activeRibbonId=ribbon.id;changed();closeModal();open(ribbon.id);
    },'作成');
  }
  function renameReferences(ribbon,previousKey){
    for(const item of w().ribbons)for(const group of item.groups)for(const control of group.controls){
      for(const condition of [control.visibleWhen,control.enabledWhen,...control.actions.map(action=>action.when)])
        for(const rule of condition?.rules||[])if(rule.source==='ribbon'&&rule.key.startsWith(previousKey+'.'))rule.key=ribbon.key+rule.key.slice(previousKey.length);
      for(const action of control.actions){
        if(action.type==='activate'&&action.target===previousKey)action.target=ribbon.id;
        else if(action.target?.startsWith(previousKey+'.'))action.target=ribbon.key+action.target.slice(previousKey.length);
      }
    }
  }
  function duplicate(ribbon){
    const copy=clone(ribbon),ids=new Map();copy.id=uid();copy.name+=' のコピー';copy.key=freshKey(ribbon.key+'_',w().ribbons.map(item=>item.key));ids.set(ribbon.id,copy.id);
    for(const group of copy.groups){const old=group.id;group.id=uid();ids.set(old,group.id);for(const control of group.controls){const old=control.id;control.id=uid();ids.set(old,control.id);}}
    const remap=ref=>ids.get(ref)||(typeof ref==='string'&&ref.startsWith(ribbon.key+'.')?copy.key+ref.slice(ribbon.key.length):ref);
    for(const group of copy.groups)for(const control of group.controls){
      for(const condition of [control.visibleWhen,control.enabledWhen,...control.actions.map(action=>action.when)])for(const rule of condition?.rules||[])if(rule.source==='ribbon')rule.key=remap(rule.key);
      for(const action of control.actions){action.id=uid();if(action.target)action.target=remap(action.target);}
    }
    w().ribbons.splice(w().ribbons.indexOf(ribbon)+1,0,copy);changed();open(copy.id);
  }
  async function removeRibbon(ribbon){
    if(!await confirmAction(`「${ribbon.name}」を削除しますか？`))return;
    for(const group of ribbon.groups)for(const control of group.controls)controllers.get(control.id)?.abort();
    w().ribbons=w().ribbons.filter(item=>item!==ribbon);
    if(w().activeRibbonId===ribbon.id)w().activeRibbonId=w().ribbons[0]?.id||'';
    changed();paintedId='';api.renderSidebar();render(true);
  }
  function ribbonMenu(ribbon){return [
    {label:'このリボンを表示',disabled:w().activeRibbonId===ribbon.id,run:()=>activate(ribbon.id)},
    {label:'参照キーをコピー',run:()=>api.copyText(ribbon.key)},
    {label:'複製',run:()=>duplicate(ribbon)},
    {label:'この後にリボンを追加',run:()=>create(ribbon.id)},
    {label:'削除',danger:true,run:()=>removeRibbon(ribbon)}
  ];}
  function sidebar(){
    selected();const root=$('sidebarContent'),query=$('search').value.toLowerCase();root.replaceChildren();
    $('sidebarAdd').hidden=false;$('clearHistory').hidden=true;$('search').placeholder='リボンを検索';$('sidebarAdd').setAttribute('aria-label','リボンを追加');
    for(const ribbon of w().ribbons.filter(item=>(item.name+' '+item.key).toLowerCase().includes(query))){
      const row=el('div',`tree-row${ribbon.id===selectedId?' selected':''}`);row.dataset.ribbonId=ribbon.id;
      const name=btn(ribbon.name,()=>open(ribbon.id),'tree-open'),more=btn('⋯',()=>{},'icon-button');name.title=ribbon.name;more.setAttribute('aria-label',`${ribbon.name}の操作`);
      row.append(name,more);bindContext(row,more,(anchor,event)=>openItemMenu(anchor,ribbonMenu(ribbon),event));root.append(row);
    }
    if(!root.children.length)root.append(el('p','sidebar-empty',query?'一致する項目なし':'リボンはありません'));
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
    groupId=group.id;controlId=control.id;changed();paintCanvas(true);paintProperties();
  }
  function addMenu(anchor,event,group,afterId){openItemMenu(anchor,TYPES.map(([type,name])=>({label:name,run:()=>addControl(type,group,afterId)})),event);}
  function move(array,item,offset){const at=array.indexOf(item),next=at+offset;if(at<0||next<0||next>=array.length)return;array.splice(at,1);array.splice(next,0,item);changed();paintCanvas(true);}
  async function removeGroup(group){
    if(!await confirmAction(`「${group.name}」とその項目を削除しますか？`))return;
    for(const control of group.controls)controllers.get(control.id)?.abort();
    current().groups=current().groups.filter(item=>item!==group);groupId='';controlId='';changed();paintCanvas(true);paintProperties();
  }
  async function removeControl(group,control){
    if(!await confirmAction(`「${control.label}」を削除しますか？`))return;
    controllers.get(control.id)?.abort();group.controls=group.controls.filter(item=>item!==control);controlId='';changed();paintCanvas(true);paintProperties();
  }
  function controlMenu(group,control){return [
    {label:'編集',run:()=>chooseControl(group,control)},
    {label:'前へ移動',disabled:group.controls[0]===control,run:()=>move(group.controls,control,-1)},
    {label:'後へ移動',disabled:group.controls.at(-1)===control,run:()=>move(group.controls,control,1)},
    {label:'複製',run:()=>{const copy=clone(control);copy.id=uid();copy.key=freshKey(control.key+'_',current().groups.flatMap(item=>item.controls.map(control=>control.key)));copy.actions.forEach(action=>action.id=uid());group.controls.splice(group.controls.indexOf(control)+1,0,copy);changed();chooseControl(group,copy);}},
    {label:'参照キーをコピー',run:()=>api.copyText(current().key+'.'+control.key)},
    {label:'削除',danger:true,run:()=>removeControl(group,control)}
  ];}
  function chooseControl(group,control){groupId=group.id;controlId=control?.id||'';paintCanvas(true);paintProperties();}
  function paintHeading(){const action=$('activateRibbon');if(action&&current()){action.disabled=w().activeRibbonId===current().id;action.textContent=action.disabled?'表示中':'このリボンを表示';}}
  function render(force=false){
    const ribbon=selected(),page=$('workspacePage');
    if(!force&&paintedId===(ribbon?.id||'empty')&&page.querySelector('.ribbons-page')){refresh();return;}
    paintedId=ribbon?.id||'empty';canvasSignature='';page.replaceChildren();
    const body=el('div','ribbons-page');page.append(body);
    if(!ribbon){const empty=el('div','workspace-empty');empty.append(el('h1','','リボン'),btn('リボンを作成',()=>create(),'button primary'));body.append(empty);return;}
    const heading=el('div','ribbon-editor-heading');
    const name=input(ribbon.name,'リボン名',value=>{ribbon.name=value;changed();api.renderSidebar();});name.className='ribbon-name';
    const activateButton=btn('このリボンを表示',()=>activate(ribbon.id));activateButton.id='activateRibbon';
    const menu=btn('⋯',event=>openItemMenu(event.currentTarget,ribbonMenu(ribbon),event),'icon-button');menu.setAttribute('aria-label','リボンの操作');
    heading.append(name,activateButton,menu);body.append(heading);
    const tools=el('div','ribbon-editor-tools'),key=input(ribbon.key,'リボンの参照キー',()=>{});
    key.onchange=()=>{
      const value=key.value.trim();
      if(!keyValid(value)||w().ribbons.some(item=>item!==ribbon&&item.key===value)){key.setCustomValidity('重複しない英数字・_・-のキーを入力してください。先頭は英字か_です。');key.reportValidity();return;}
      key.setCustomValidity('');const old=ribbon.key;ribbon.key=value;renameReferences(ribbon,old);changed();paintProperties();
    };key.oninput=()=>key.setCustomValidity('');
    tools.append(field('参照キー',key),btn('グループを追加',addGroup),btn('項目を追加 ▾',event=>addMenu(event.currentTarget,event)));
    const grid=el('div','ribbon-editor-grid'),canvas=el('section','ribbon-canvas'),properties=el('section','ribbon-properties');
    canvas.id='ribbonCanvas';canvas.setAttribute('aria-label','リボンの配置');properties.id='ribbonProperties';properties.setAttribute('aria-label','選択項目の設定');
    grid.append(canvas,properties);body.append(tools,grid);paintHeading();paintCanvas(true);paintProperties();
  }
  function paintCanvas(force=false){
    const root=$('ribbonCanvas'),ribbon=current();if(!root||api.side()!=='ribbons'||!ribbon)return;
    const signature=JSON.stringify([ribbon,groupId,controlId]);if(!force&&signature===canvasSignature)return;canvasSignature=signature;root.replaceChildren();
    if(!ribbon.groups.length){root.append(btn('グループを追加',addGroup,'button'));return;}
    for(const group of ribbon.groups){
      const section=el('section','ribbon-canvas-group');section.dataset.groupId=group.id;
      const heading=el('div','ribbon-group-heading'),title=btn(group.name,()=>chooseControl(group,null),'text-button'),add=btn('＋',event=>addMenu(event.currentTarget,event,group),'icon-button'),more=btn('⋯',event=>openItemMenu(event.currentTarget,[
        {label:'名前を編集',run:()=>chooseControl(group,null)},
        {label:'前へ移動',disabled:ribbon.groups[0]===group,run:()=>move(ribbon.groups,group,-1)},
        {label:'後へ移動',disabled:ribbon.groups.at(-1)===group,run:()=>move(ribbon.groups,group,1)},
        {label:'削除',danger:true,run:()=>removeGroup(group)}
      ],event),'icon-button');add.setAttribute('aria-label',`${group.name}に項目を追加`);more.setAttribute('aria-label',`${group.name}の操作`);heading.append(title,add,more);
      const items=el('div','ribbon-canvas-items');
      for(const control of group.controls){
        const item=el('div',`ribbon-design-control${controlId===control.id?' selected':''}`);item.dataset.controlId=control.id;item.draggable=true;item.tabIndex=0;item.setAttribute('role','button');item.setAttribute('aria-label',`${control.label}を編集`);item.setAttribute('aria-pressed',String(controlId===control.id));
        const preview=makeControl(control,true);preview.inert=true;item.append(preview);
        item.onclick=()=>chooseControl(group,control);
        item.oncontextmenu=event=>{event.preventDefault();openItemMenu(item,controlMenu(group,control),event);};
        item.onkeydown=event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();chooseControl(group,control);}else if(event.altKey&&['ArrowLeft','ArrowUp','ArrowRight','ArrowDown'].includes(event.key)){event.preventDefault();move(group.controls,control,['ArrowLeft','ArrowUp'].includes(event.key)?-1:1);root.querySelector(`[data-control-id="${control.id}"]`)?.focus();}else if(event.key==='Delete'){event.preventDefault();void removeControl(group,control);}};
        item.ondragstart=event=>{dragged={ribbonId:ribbon.id,groupId:group.id,controlId:control.id};event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',control.id);};
        item.ondragend=()=>{dragged=null;root.querySelectorAll('.ribbon-drop').forEach(node=>node.classList.remove('ribbon-drop'));};
        item.ondragover=event=>{if(dragged?.ribbonId!==ribbon.id||dragged.controlId===control.id)return;event.preventDefault();item.classList.add('ribbon-drop');};
        item.ondragleave=()=>item.classList.remove('ribbon-drop');
        item.ondrop=event=>{if(!dragged||dragged.ribbonId!==ribbon.id)return;event.preventDefault();event.stopPropagation();const bounds=item.getBoundingClientRect();dropControl(group,control.id,event.clientX>bounds.x+bounds.width/2);};items.append(item);
      }
      if(!group.controls.length)items.append(btn('項目を追加',event=>addMenu(event.currentTarget,event,group),'text-button'));
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
      const node=input(type==='json'?JSON.stringify(value):value,label,()=>{},type==='number'?'number':'text');if(type==='number')node.step='any';
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
    const choices=listRibbonControls(w()).filter(({control})=>includeButtons||control.type!=='button').map(({ribbon,control})=>[control.id,`${ribbon.name} / ${control.label}`]);
    if(selectedRef&&!choices.some(([id])=>id===selectedRef))choices.push([selectedRef,selectedRef]);return [['','選択してください'],...choices];
  }
  function conditionEditor(owner,property,title){
    const section=el('section','ribbon-condition'),heading=el('div','ribbon-setting-heading');
    heading.append(el('h3','',title));const add=btn('＋',()=>{owner[property]||={mode:'all',rules:[]};owner[property].rules.push({source:'ribbon',key:selectedControl()?.id||'',operator:'eq',value:true});changed();draw();},'icon-button');add.setAttribute('aria-label',title+'を追加');heading.append(add);section.append(heading);const body=el('div');section.append(body);
    function draw(){
      body.replaceChildren();const condition=owner[property];if(!condition?.rules.length)return;
      const mode=select([['all','すべて満たす'],['any','いずれかを満たす']],condition.mode,value=>{condition.mode=value;changed();});mode.setAttribute('aria-label',title+'の組み合わせ');body.append(mode);
      condition.rules.forEach((rule,index)=>{
        const row=el('div','ribbon-condition-row');row.dataset.ruleIndex=index;
        const source=select(SOURCES,rule.source,value=>{rule.source=value;rule.key='';changed();draw();});source.setAttribute('aria-label',title+'の参照元');
        const target=rule.source==='ribbon'?select(referenceOptions(rule.key,false),rule.key,value=>{rule.key=value;changed();}):input(rule.key,title+'のキー',value=>{rule.key=value;changed();});target.setAttribute('aria-label',title+'の参照項目');
        const op=select(OPERATORS,rule.operator,value=>{rule.operator=value;if(!UNARY.has(value)&&!Object.hasOwn(rule,'value'))rule.value='';changed();draw();});op.setAttribute('aria-label',title+'の比較');
        const remove=btn('×',()=>{condition.rules.splice(index,1);changed();draw();},'icon-button');remove.setAttribute('aria-label',title+'を削除');
        row.append(source,target,op,remove);if(!UNARY.has(rule.operator))row.append(typedValue(rule.value,value=>{rule.value=value;changed();},title+'の比較値'));body.append(row);
      });
    }
    draw();return section;
  }
  function actionsEditor(control){
    const section=el('section','ribbon-actions-editor'),heading=el('div','ribbon-setting-heading');heading.append(el('h3','',control.type==='button'?'クリック時':'変更時'));
    const add=btn('処理を追加',()=>{control.actions.push({id:uid(),type:'script',scriptId:w().scripts[0]?.id||''});changed();draw();},'text-button');heading.append(add);section.append(heading);
    const body=el('div','ribbon-action-list');section.append(body);
    function draw(){
      body.replaceChildren();control.actions.forEach((action,index)=>{
        const row=el('section','ribbon-action');row.dataset.actionId=action.id;
        const top=el('div','ribbon-action-heading');top.append(el('span','ribbon-action-order',String(index+1)));
        const type=select([['script','スクリプトを実行'],['set','値を設定'],['toggle','チェックを切り替え'],['activate','リボンを切り替え']],action.type,value=>{action.type=value;action.target='';delete action.scriptId;action.value='';if(value==='script')action.scriptId=w().scripts[0]?.id||'';changed();draw();});type.setAttribute('aria-label','処理の種類');
        const more=btn('⋯',event=>openItemMenu(event.currentTarget,[
          {label:'上へ移動',disabled:index===0,run:()=>{move(control.actions,action,-1);draw();}},
          {label:'下へ移動',disabled:index===control.actions.length-1,run:()=>{move(control.actions,action,1);draw();}},
          {label:'削除',danger:true,run:()=>{control.actions.splice(index,1);changed();draw();}}
        ],event),'icon-button');more.setAttribute('aria-label',`処理${index+1}の操作`);top.append(type,more);row.append(top);
        if(action.type==='script'){
          const options=[['','スクリプトを選択'],...w().scripts.map(script=>[script.id,script.name])];if(action.scriptId&&!options.some(([id])=>id===action.scriptId))options.push([action.scriptId,'削除されたスクリプト']);
          const picker=select(options,action.scriptId||'',value=>{action.scriptId=value;changed();});picker.setAttribute('aria-label','実行するスクリプト');
          const line=el('div','ribbon-action-target');const edit=btn('編集',()=>api.openScript(action.scriptId),'button');edit.disabled=!w().scripts.some(script=>script.id===action.scriptId);picker.addEventListener('change',()=>{edit.disabled=!w().scripts.some(script=>script.id===action.scriptId);});line.append(picker,edit);row.append(line);
        }else{
          let options=action.type==='activate'?[['','リボンを選択'],...w().ribbons.map(ribbon=>[ribbon.id,ribbon.name])]:referenceOptions(action.target,false);
          if(action.type==='toggle')options=options.filter(([id])=>!id||listRibbonControls(w()).some(({control})=>control.id===id&&control.type==='toggle'));
          if(action.target&&!options.some(([id])=>id===action.target))options.push([action.target,action.target]);
          const picker=select(options,action.target||'',value=>{action.target=value;if(action.type==='set'&&value){try{action.value=clone(resolveRibbonControl(w(),value).control.value);}catch{}}changed();draw();});picker.setAttribute('aria-label','処理の対象');row.append(picker);
          if(action.type==='set')row.append(typedValue(action.value??'',value=>{action.value=value;changed();},'設定する値'));
        }
        row.append(conditionEditor(action,'when','実行条件'));body.append(row);
      });
    }
    draw();return section;
  }
  function paintProperties(){
    const root=$('ribbonProperties'),ribbon=current();if(!root||!ribbon)return;root.replaceChildren();
    const group=selectedGroup(),control=selectedControl();propertySignature=JSON.stringify(control?[control.id,control.value,control.visible,control.enabled]:null);
    if(!group){root.append(el('h2','','項目の設定'));return;}
    if(!control){root.append(el('h2','','グループ'),field('グループ名',input(group.name,'グループ名',value=>{group.name=value;changed();})));return;}
    const heading=el('div','ribbon-setting-heading'),more=btn('⋯',event=>openItemMenu(event.currentTarget,controlMenu(group,control),event),'icon-button');more.setAttribute('aria-label','項目の操作');heading.append(el('h2','',TYPES.find(([key])=>key===control.type)?.[1]||'項目'),more);root.append(heading);
    root.append(field('ラベル',input(control.label,'項目のラベル',value=>{control.label=value;changed();})));
    const key=input(control.key,'項目の参照キー',()=>{});key.oninput=()=>key.setCustomValidity('');
    key.onchange=()=>{const value=key.value.trim();if(!keyValid(value)||ribbon.groups.some(group=>group.controls.some(item=>item!==control&&item.key===value))){key.setCustomValidity('重複しない英数字・_・-のキーを入力してください。先頭は英字か_です。');key.reportValidity();return;}key.setCustomValidity('');control.key=value;changed();};root.append(field('参照キー',key));
    const groupPicker=select(ribbon.groups.map(item=>[item.id,item.name]),group.id,value=>{const target=ribbon.groups.find(item=>item.id===value);if(!target||target===group)return;group.controls.splice(group.controls.indexOf(control),1);target.controls.push(control);groupId=target.id;changed();paintProperties();});root.append(field('グループ',groupPicker));
    if(control.type==='toggle')root.append(checkField('チェック',Boolean(control.value),value=>{control.value=value;changed();}));
    else if(control.type!=='button'&&control.type!=='select'){
      if(control.type==='display')root.append(field('表示値',typedValue(control.value,value=>{control.value=value;changed();},'表示する値')));
      else{const value=input(control.value,'項目の値',()=>{},control.type==='number'?'number':'text');if(control.type==='number')value.step='any';value.oninput=()=>{try{if(control.type==='number'&&!value.value.trim())throw new Error('数値を入力してください。');control.value=normalizeRibbonValue(control,control.type==='number'?Number(value.value):value.value);value.setCustomValidity('');changed();}catch(error){value.setCustomValidity(error.message);}};value.onchange=()=>value.reportValidity();root.append(field('値',value));}
    }
    if(control.type==='select'){
      const options=el('section','ribbon-options'),heading=el('div','ribbon-setting-heading');heading.append(el('h3','','選択肢'));
      const list=el('div');function drawOptions(){
        list.replaceChildren();control.options.forEach((option,index)=>{
          const row=el('div','ribbon-option-row'),value=input(option.value,`選択肢${index+1}の値`,()=>{}),label=input(option.label,`選択肢${index+1}のラベル`,next=>{option.label=next;changed();});
          value.onchange=()=>{if(control.options.some(item=>item!==option&&item.value===value.value)){value.setCustomValidity('値が重複しています。');value.reportValidity();return;}value.setCustomValidity('');if(control.value===option.value)control.value=value.value;option.value=value.value;changed();drawSelected();};
          const remove=btn('×',()=>{control.options.splice(index,1);if(control.value===option.value)control.value=control.options[0]?.value||'';changed();drawOptions();drawSelected();},'icon-button');remove.setAttribute('aria-label',`選択肢${index+1}を削除`);row.append(value,label,remove);list.append(row);
        });
      }
      heading.append(btn('＋',()=>{const value=freshKey('option',control.options.map(item=>item.value));control.options.push({value,label:value});if(control.options.length===1)control.value=value;changed();drawOptions();drawSelected();},'icon-button'));heading.lastChild.setAttribute('aria-label','選択肢を追加');
      const selected=el('div');function drawSelected(){selected.replaceChildren();selected.append(field('選択値',select(control.options.map(item=>[item.value,item.label]),control.value,value=>{control.value=value;changed();})));}
      options.append(heading,list,selected);root.append(options);drawOptions();drawSelected();
    }
    const flags=el('div','ribbon-flags');flags.append(checkField('表示',control.visible!==false,value=>{control.visible=value;changed();}),checkField('操作を許可',control.enabled!==false,value=>{control.enabled=value;changed();}));root.append(flags);
    root.append(conditionEditor(control,'visibleWhen','表示条件'),conditionEditor(control,'enabledWhen','有効条件'));
    if(control.type!=='display')root.append(actionsEditor(control));
    const status=el('div','ribbon-operation-result');status.id='ribbonOperationResult';status.setAttribute('role','status');root.append(status);paintResult();
  }
  function makeControl(control,preview=false){
    const box=el('div',`ribbon-control ribbon-control-${control.type}`);box.dataset.ribbonControl=control.id;
    let node;
    if(control.type==='button'){node=btn(control.label,()=>{if(!preview)void interact(control.id,'click');},'button');}
    else if(control.type==='display'){node=el('output','ribbon-output',showValue(control.value));node.setAttribute('aria-label',control.label);}
    else if(control.type==='select')node=select(control.options.map(option=>[option.value,option.label]),control.value,()=>{});
    else if(control.type==='toggle'){node=el('input');node.type='checkbox';node.checked=control.value===true;}
    else{node=input(control.value,control.label,()=>{},control.type==='number'?'number':'text');if(control.type==='number')node.step='any';}
    node.dataset.ribbonInput=control.id;node.setAttribute('aria-label',control.label);node.title=control.label;
    if(!preview&&!['button','display'].includes(control.type)){
      const commit=async()=>{
        try{if(control.type==='number'&&(!node.value.trim()||!Number.isFinite(Number(node.value))))throw new Error('数値を入力してください。');
          const value=control.type==='toggle'?node.checked:control.type==='number'?Number(node.value):node.value;
          node.setCustomValidity('');await interact(control.id,'change',value);
        }catch(error){node.setCustomValidity(error.message);node.reportValidity();}
      };
      node.onchange=commit;
      if(['text','number'].includes(control.type)){
        node.oninput=()=>{node.setCustomValidity('');try{if(control.type==='number'&&(!node.value.trim()||!Number.isFinite(Number(node.value))))return;
          const entry=resolveRibbonControl(w(),control.id),current=entry.control;const next=normalizeRibbonValue(current,control.type==='number'?Number(node.value):node.value);
          if(!Object.hasOwn(node.dataset,'previousValue')){
            const state=ribbonControlState(current,context(w(),primary,entry.ribbon.id));if(!state.visible||!state.enabled)return;
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
    const root=$('customRibbon');if(!root)return;root.hidden=!w().ribbons.length;if(root.hidden){root.replaceChildren();barSignature='';return;}
    const active=w().ribbons.find(item=>item.id===w().activeRibbonId);
    const shape=JSON.stringify([w().activeRibbonId,w().ribbons.map(({id,name})=>({id,name})),active?.groups.map(group=>({id:group.id,name:group.name,controls:group.controls.map(({id,label,type,options})=>({id,label,type,options}))}))]);
    if(shape!==barSignature){
      barSignature=shape;root.replaceChildren();
      const selection=select([['','リボンを非表示'],...w().ribbons.map(item=>[item.id,item.name])],w().activeRibbonId,id=>activate(id));selection.id='activeRibbon';selection.setAttribute('aria-label','表示するリボン');
      const head=el('div','ribbon-selector');head.append(selection);root.append(head);
      const strip=el('div','ribbon-live-groups');strip.setAttribute('aria-label','リボンの操作');
      if(active)for(const group of active.groups){
        const section=el('section','ribbon-live-group');section.dataset.liveGroup=group.id;section.setAttribute('aria-label',group.name);
        const controls=el('div','ribbon-live-controls');for(const control of group.controls)controls.append(makeControl(control));section.append(controls,el('span','ribbon-live-group-name',group.name));strip.append(section);
      }
      root.append(strip);
    }
    if(!active)return;
    for(const group of active.groups){let visible=0;for(const control of group.controls){
      const box=[...root.querySelectorAll('[data-ribbon-control]')].find(item=>item.dataset.ribbonControl===control.id);if(!box)continue;
      let state;try{state=ribbonControlState(control,context(w(),primary,active.id));box.removeAttribute('title');}catch(error){state={visible:true,enabled:false};box.title=error.message;}
      const node=box.querySelector('[data-ribbon-input]'),editing=document.activeElement===node&&Object.hasOwn(node.dataset,'previousValue');
      box.hidden=!state.visible&&!editing;if(state.visible||editing)visible++;
      const busy=controllers.has(control.id);node.disabled=(!state.enabled&&!editing)||busy;box.setAttribute('aria-busy',String(busy));
      if(control.type==='display')node.textContent=showValue(control.value);
      else if(control.type==='toggle')node.checked=control.value===true;
      else if(control.type!=='button'&&!editing&&node.value!==String(control.value??''))node.value=String(control.value??'');
      const error=results.get(control.id)?.error;box.classList.toggle('ribbon-control-error',Boolean(error));if(error)box.title=error;
    }const section=[...root.querySelectorAll('[data-live-group]')].find(item=>item.dataset.liveGroup===group.id);if(section)section.hidden=!visible;}
  }
  function paintResult(){
    const box=$('ribbonOperationResult');if(!box)return;const entry=results.get(controlId);box.replaceChildren();if(!entry)return;
    const status=el('span','',entry.state==='running'?'実行中':entry.error||'完了');box.append(status);box.dataset.state=entry.state;
    if(entry.state==='running')box.append(btn('停止',()=>controllers.get(controlId)?.abort(),'text-button'));
    if(entry.logs?.length)box.append(el('pre','ribbon-action-log',entry.logs.map(line=>line.message).join('\n')));
    if(Object.hasOwn(entry,'result')&&entry.result!==undefined)box.append(el('pre','ribbon-action-log',formatScriptValue(entry.result)));
  }
  function refresh(){if(frame)return;frame=requestAnimationFrame(()=>{
    frame=0;paintBar();paintCanvas();paintHeading();paintResult();
    const properties=$('ribbonProperties'),control=selectedControl(),signature=JSON.stringify(control?[control.id,control.value,control.visible,control.enabled]:null);
    if(properties&&api.side()==='ribbons'&&signature!==propertySignature&&!properties.contains(document.activeElement)&&$('itemMenu').hidden&&!$('modal').open)paintProperties();
  });}
  async function interact(id,type,newValue){
    if(controllers.has(id))return;
    let entry;try{entry=resolveRibbonControl(w(),id);}catch(error){toast(error.message);return;}
    const {ribbon,control}=entry;
    const node=[...$('customRibbon').querySelectorAll('[data-ribbon-input]')].find(node=>node.dataset.ribbonInput===id);
    const acceptedEdit=type==='change'&&node&&Object.hasOwn(node.dataset,'previousValue');
    let state;try{state=ribbonControlState(control,context(w(),primary,ribbon.id));}catch(error){toast(error.message);return;}
    if(!acceptedEdit&&(!state.visible||!state.enabled))return;
    let previous=clone(control.value);
    if(node&&Object.hasOwn(node.dataset,'previousValue')){previous=JSON.parse(node.dataset.previousValue);delete node.dataset.previousValue;}
    if(type==='change'){const next=normalizeRibbonValue(control,newValue);control.value=next;changed();if(equal(previous,next))return;}
    if(!control.actions.length)return;
    const abort=new AbortController(),record={state:'running',logs:[]};controllers.set(id,abort);results.set(id,record);api.runningChanged();refresh();
    const workspace=w(),staged=clone(workspace),temporary=new PrimaryVariables();temporary.rows=clone(primary.rows);
    const environmentId=workspace.environmentId,environment=workspace.environments.find(item=>item.id===environmentId),targetEnvironment=staged.environments.find(item=>item.id===environmentId);
    const combined={writes:{primary:[],environment:[],globals:[]},dataWrites:[],ribbonWrites:[]};
    const collect=output=>{
      for(const kind of ['primary','environment','globals'])combined.writes[kind].push(...(output.writes?.[kind]||[]));combined.dataWrites.push(...(output.dataWrites||[]));
      for(const write of output.ribbonWrites||[]){const prior=combined.ribbonWrites.find(item=>item.type===write.type&&(write.type==='activate'||item.id===write.id));if(prior){prior.value=clone(write.value);if(write.type==='activate')prior.id=write.id;}else combined.ribbonWrites.push(clone(write));}
    };
    try{
      for(const action of clone(control.actions)){
        if(abort.signal.aborted)throw new DOMException('処理を停止しました。','AbortError');
        if(!evaluateRibbonCondition(action.when,context(staged,temporary,ribbon.id)))continue;
        if(action.type==='script'){
          const script=staged.scripts.find(item=>item.id===action.scriptId);if(!script)throw new Error('実行するスクリプトがありません。');
          const current=resolveRibbonControl(staged,id).control;
          const payload={type,ribbonId:ribbon.id,controlId:id,key:current.key,value:clone(current.value),previousValue:clone(previous),values:Object.fromEntries(listRibbonControls(staged).filter(row=>row.ribbon.id===ribbon.id).map(({control})=>[control.key,clone(control.value)]))};
          const scriptContext=makeScriptContext(staged,temporary,{input:payload,scriptId:script.id,environmentId});
          const host=createScriptHost({workspace:staged,primary:temporary,environmentId,filesFor:api.filesFor,onResponse:api.recordResponse});
          const output=await runScript(script.source,scriptContext,{signal:abort.signal,timeoutMs:script.timeoutMs,onCall:host,onLog:line=>{record.logs.push(line);refresh();}});
          applyScriptWrites(staged,temporary,targetEnvironment,output);collect(output);record.result=output.result;
        }else{
          let write;if(action.type==='activate'){const next=resolveRibbon(staged,action.target);write={type:'activate',id:next.id,value:next.id,expected:staged.activeRibbonId};}
          else{const target=resolveRibbonControl(staged,action.target,{ribbonId:ribbon.id}).control;if(action.type==='toggle'&&target.type!=='toggle')throw new Error('チェック項目を指定してください。');write={type:'value',id:target.id,value:action.type==='toggle'?!target.value:clone(action.value),expected:clone(target.value),expectedShape:{type:target.type,options:clone(target.options||[])}};}
          prepareRibbonWrites(staged,[write])();collect({ribbonWrites:[write]});
        }
      }
      if(abort.signal.aborted)throw new DOMException('処理を停止しました。','AbortError');
      if(w()!==workspace||!listRibbonControls(workspace).some(row=>row.control.id===id))throw new Error('リボンが変更されたため、処理結果を反映できません。');
      if(applyScriptWrites(workspace,primary,environment,combined))persist();record.state='success';
    }catch(error){record.state=error.name==='AbortError'?'stopped':'error';record.error=error.message;toast(error.message);}
    finally{controllers.delete(id);api.runningChanged();refresh();}
  }
  ensureRibbons(w());refresh();
  return {open,create,sidebar,render,refresh,addGroup,isRunning:()=>controllers.size>0,
    stop(){for(const abort of controllers.values())abort.abort();},reset(){selectedId='';groupId='';controlId='';paintedId='';barSignature='';canvasSignature='';results.clear();ensureRibbons(w());refresh();}};
}
