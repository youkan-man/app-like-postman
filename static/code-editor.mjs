/** Highlighted native textarea; completion edits use the browser undo history. */
import {createScriptIntelligenceClient} from './script-intelligence-client.mjs';
import {highlight} from './code-highlighter.mjs';
import {indentEdit,newlineEdit} from './editor-editing.mjs';
export {highlight};
let editorSequence=0;
export function createCodeEditor({value='',language='text',label='コード',onChange=()=>{},readOnly=false,intellisense=false,intelligenceContext=()=>({})}={}) {
  const root=document.createElement('div');root.className='source-editor';root.dataset.language=language;
  const pre=document.createElement('pre');pre.className='source-highlight';pre.setAttribute('aria-hidden','true');
  const area=document.createElement('textarea');area.className='code-editor source-input';area.value=value;area.spellcheck=false;area.wrap='off';area.readOnly=readOnly;area.setAttribute('aria-label',label);area.setAttribute('autocapitalize','off');area.setAttribute('autocomplete','off');
  const status=document.createElement('div');status.className='source-status';
  const analysisStatus=document.createElement('span');analysisStatus.className='source-intelligence-status';analysisStatus.setAttribute('role','status');analysisStatus.setAttribute('aria-live','polite');
  const retry=document.createElement('button');retry.type='button';retry.className='source-intelligence-retry';retry.textContent='補完を再試行';retry.setAttribute('aria-label','コード補完を再試行');retry.hidden=true;
  const sourceStatus=document.createElement('span');sourceStatus.className='source-line-status';sourceStatus.setAttribute('aria-hidden','true');status.append(analysisStatus,retry,sourceStatus);
  const suggestions=document.createElement('div');suggestions.className='source-suggestions';suggestions.id=`script-suggestions-${++editorSequence}`;suggestions.setAttribute('role','listbox');suggestions.setAttribute('aria-label','コード補完');suggestions.hidden=true;
  const hint=document.createElement('div');hint.className='source-signature';hint.id=`script-signature-${editorSequence}`;hint.setAttribute('role','status');hint.hidden=true;
  const client=intellisense?createScriptIntelligenceClient():null;
  let completion=null, selected=0, composing=false, applying=false, generation=0, detailGeneration=0;
  let timer, loadingTimer, detailTimer, query=null, state='idle', disposed=false;
  let knownValue=area.value;
  // Native undo retains the text. Remember only our compound edits to restore
  // the user's original selection instead of the temporary replacement range.
  const editHistory=[];
  const enabled=()=>intellisense&&!readOnly&&language==='javascript';
  if(intellisense){area.setAttribute('aria-autocomplete','list');area.setAttribute('aria-controls',suggestions.id);area.setAttribute('aria-describedby',hint.id);}
  function close(){suggestions.hidden=true;completion=null;area.removeAttribute('aria-activedescendant');clearTimeout(detailTimer);detailGeneration++;}
  function setState(next,error){
    state=next;root.dataset.intelligence=next;retry.hidden=next!=='error';
    analysisStatus.textContent=next==='loading'?'解析中…':'';
    retry.title=error?.message||'';
  }
  function invalidate({hideHint=true}={}){
    generation++;clearTimeout(timer);clearTimeout(loadingTimer);client?.cancel();close();query=null;
    if(hideHint)hint.hidden=true;
    if(state!=='error')setState('idle');
  }
  function sync(){pre.scrollTop=area.scrollTop;pre.scrollLeft=area.scrollLeft;}
  function paint(){pre.innerHTML=highlight(area.value,language)+'\n';sourceStatus.textContent=`${language.toUpperCase()} · ${area.value.split('\n').length} 行`;sync();}
  // Mirror only to measure the caret. It never participates in input or layout.
  function caret(){
    const mirror=document.createElement('div'), style=getComputedStyle(area);
    mirror.style.cssText='position:absolute;visibility:hidden;pointer-events:none;white-space:pre;left:0;top:0;';
    for(const key of ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','tabSize','paddingLeft','paddingTop'])mirror.style[key]=style[key];
    mirror.textContent=area.value.slice(0,area.selectionStart);
    const mark=document.createElement('span');mark.textContent='\u200b';mirror.append(mark);root.append(mirror);
    const result={x:mark.offsetLeft-area.scrollLeft,y:mark.offsetTop-area.scrollTop,line:parseFloat(style.lineHeight)||22};mirror.remove();return result;
  }
  function place(){
    if(suggestions.hidden)return;
    const pos=caret();
    const available=Math.max(30,area.clientHeight-(hint.hidden?0:hint.offsetHeight+4));
    suggestions.style.maxHeight=`${Math.max(28,Math.min(180,Math.floor(area.clientHeight/2),available-8))}px`;
    const width=suggestions.offsetWidth, height=suggestions.offsetHeight;
    let top=pos.y+pos.line;
    if(top+height>available-4)top=pos.y-height;
    suggestions.style.left=`${Math.max(4,Math.min(pos.x,root.clientWidth-width-4))}px`;
    suggestions.style.top=`${Math.max(4,Math.min(top,available-height-4))}px`;
    suggestions.style.bottom='auto';
  }
  // A pane or viewport can shrink while the list is open. Its absolute caret
  // coordinates must be clamped again, otherwise overflow:hidden clips it.
  const resizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(()=>{
    // Workspace navigation removes editor nodes without an explicit dispose.
    // Cancel their queued parses so an abandoned editor cannot delay the new one.
    if(!root.isConnected){invalidate();resizeObserver.disconnect();return;}
    place();
  }):null;
  resizeObserver?.observe(root);
  resizeObserver?.observe(area);
  function highlightSelected(loadDetails=true){
    for(const [i,node] of [...suggestions.children].entries())node.setAttribute('aria-selected',String(i===selected));
    const item=suggestions.children[selected];
    if(item){area.setAttribute('aria-activedescendant',item.id);const top=item.offsetTop,bottom=top+item.offsetHeight;if(top<suggestions.scrollTop)suggestions.scrollTop=top;else if(bottom>suggestions.scrollTop+suggestions.clientHeight)suggestions.scrollTop=bottom-suggestions.clientHeight;}
    if(loadDetails)loadSelectedDetails();
  }
  function showHint(info){
    hint.hidden=!info;
    hint.textContent=info?`${info.signature} · 引数 ${info.argument+1}${info.description?' — '+info.description:''}`:'';
    hint.title=hint.textContent;
  }
  function current(snapshot){
    return !disposed&&root.isConnected&&enabled()&&!composing&&!applying&&document.activeElement===area&&
      snapshot.generation===generation&&area.value===snapshot.source&&area.selectionStart===snapshot.position&&area.selectionEnd===snapshot.position;
  }
  function detailText(item){return item.signature&&item.signature!==item.label?item.signature:item.description||item.kind||'';}
  function loadSelectedDetails(){
    clearTimeout(detailTimer);
    const snapshot=query,entry=completion?.items[selected],index=selected,version=++detailGeneration;
    if(!snapshot||!entry||entry.detailed||(entry.signature&&entry.signature!==entry.label))return;
    detailTimer=setTimeout(async()=>{
      if(!current(snapshot)||version!==detailGeneration||suggestions.hidden)return;
      try{
        const details=await client.details(snapshot.source,snapshot.position,entry.label,{context:snapshot.context});
        if(!details||!current(snapshot)||version!==detailGeneration||completion?.items[index]!==entry)return;
        Object.assign(entry,details,{detailed:true});
        const option=suggestions.children[index];
        if(option){option.querySelector('.source-suggestion-detail').textContent=detailText(entry);option.title=[entry.signature,entry.description].filter(Boolean).join('\n');}
      }catch(error){if(error.name!=='AbortError'&&current(snapshot))setState('error',error);}
    },90);
  }
  function renderCompletion(result,snapshot){
    completion=result;query=snapshot;selected=0;suggestions.replaceChildren();
    if(!completion){close();return;}
    if(!completion.items?.length){close();return;}
    const fragment=document.createDocumentFragment();
    for(const [index,item] of completion.items.entries()){
      const option=document.createElement('button');option.type='button';option.className='source-suggestion';option.id=`${suggestions.id}-${index}`;option.tabIndex=-1;option.setAttribute('role','option');option.setAttribute('aria-label',item.label);option.title=[item.signature,item.description].filter(Boolean).join('\n');
      const name=document.createElement('span');name.textContent=item.label;
      const detail=document.createElement('span');detail.className='source-suggestion-detail';detail.textContent=detailText(item);
      option.append(name,detail);option.addEventListener('pointerdown',event=>event.preventDefault());option.onclick=()=>apply(index);fragment.append(option);
    }
    suggestions.append(fragment);
    suggestions.hidden=false;highlightSelected();place();
  }
  function update(explicit=false,delay=75,showCompletion=true){
    invalidate();
    if(!enabled()||composing||applying||disposed||document.activeElement!==area||area.selectionStart!==area.selectionEnd)return;
    const ticket=generation;setState('pending');
    loadingTimer=setTimeout(()=>{if(ticket===generation&&state==='pending')setState('loading');},250);
    timer=setTimeout(async()=>{
      if(ticket!==generation)return;
      if(!root.isConnected||document.activeElement!==area){invalidate();return;}
      if(area.selectionStart!==area.selectionEnd){invalidate();return;}
      const snapshot={generation:ticket,source:area.value,position:area.selectionStart,context:null};
      query=snapshot;
      try{
        snapshot.context=typeof intelligenceContext==='function'?intelligenceContext():intelligenceContext||{};
        const result=await client.analyze(snapshot.source,snapshot.position,{explicit,context:snapshot.context});
        if(!current(snapshot)){
          if(ticket===generation){clearTimeout(loadingTimer);setState('idle');}
          return;
        }
        let offered=showCompletion?result?.completion:null;
        // A fully typed name must not make the next Enter/Tab a no-op. Explicit
        // Ctrl+Space still lets the user inspect every semantic candidate.
        if(!explicit&&offered?.items?.some(item=>{
          const from=item.from??offered.from,to=item.to??offered.to;
          return Number.isInteger(from)&&Number.isInteger(to)&&to>from&&
            snapshot.source.slice(from,to)===(item.insertText??item.label);
        }))offered=null;
        clearTimeout(loadingTimer);setState('ready');showHint(result?.signature);renderCompletion(offered,snapshot);
      }catch(error){
        if(error.name==='AbortError'||!current(snapshot))return;
        clearTimeout(loadingTimer);close();showHint(null);setState('error',error);
      }
    },delay);
  }
  function selection(){return {start:area.selectionStart,end:area.selectionEnd,direction:area.selectionDirection};}
  function restoreSelection(saved){area.setSelectionRange(saved.start,saved.end,saved.direction);}
  function notifyInput(inputType='insertReplacementText'){
    area.dispatchEvent(typeof InputEvent==='function'?new InputEvent('input',{bubbles:true,inputType}):new Event('input',{bubbles:true}));
  }
  function edit(plan){
    if(!plan||readOnly)return false;
    const {from,to,text}=plan,before=area.value,beforeSelection=selection();
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||to>before.length)return false;
    const after=before.slice(0,from)+text+before.slice(to);
    const afterSelection={start:plan.selectionStart??from+text.length,end:plan.selectionEnd??from+text.length,direction:plan.selectionDirection??beforeSelection.direction};
    applying=true;invalidate();
    let native=false;
    try{
      area.focus({preventScroll:true});
      if(after!==before){
        area.setSelectionRange(from,to);
        // This participates in the browser's existing textarea undo stack.
        try{native=document.execCommand('insertText',false,text);}catch{}
        if(area.value===before){area.setRangeText(text,from,to,'end');native=false;}
        if(knownValue!==area.value)notifyInput();
        editHistory.push({before,after:area.value,beforeSelection,afterSelection,native});
        let retained=editHistory.reduce((size,item)=>size+item.before.length+item.after.length,0);
        while(editHistory.length>1&&(editHistory.length>32||retained>4_000_000)){
          const removed=editHistory.shift();retained-=removed.before.length+removed.after.length;
        }
      }
      restoreSelection(afterSelection);sync();
    }finally{applying=false;}
    update(false,75,false);
    return true;
  }
  function fallbackHistory(redo){
    const record=[...editHistory].reverse().find(item=>!item.native&&(redo?item.before:item.after)===area.value);
    if(!record)return false;
    applying=true;invalidate();
    try{area.value=redo?record.after:record.before;restoreSelection(redo?record.afterSelection:record.beforeSelection);notifyInput(redo?'historyRedo':'historyUndo');}
    finally{applying=false;}
    update(false,75,false);return true;
  }
  function apply(index){
    const item=completion?.items[index];if(!item||!query||!current(query)){invalidate();return;}
    const from=item.from??completion.from,to=item.to??completion.to,text=item.insertText??item.label;
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||to>area.value.length){invalidate();return;}
    edit({from,to,text,selectionDirection:'none'});
  }
  retry.onclick=()=>{area.focus({preventScroll:true});update(true,0);};
  area.addEventListener('input',event=>{
    const previous=knownValue;knownValue=area.value;
    if(event.inputType==='historyUndo'||event.inputType==='historyRedo'){
      const redo=event.inputType==='historyRedo';
      const record=[...editHistory].reverse().find(item=>(redo?item.before:item.after)===previous&&(redo?item.after:item.before)===area.value);
      if(record)restoreSelection(redo?record.afterSelection:record.beforeSelection);
    }
    invalidate();paint();onChange(area.value);
    if(event.isComposing||composing||applying)return;
    const typed=!event.inputType||event.inputType.startsWith('insert')||event.inputType.startsWith('delete');
    update(false,75,typed);
  });
  area.addEventListener('scroll',()=>{sync();place();});
  area.addEventListener('focus',()=>update(false,100,false));
  area.addEventListener('click',()=>update(false,75,false));
  area.addEventListener('select',()=>{if(!applying&&(area.selectionStart!==area.selectionEnd||(query&&query.position!==area.selectionStart)))invalidate();});
  area.addEventListener('compositionstart',()=>{composing=true;invalidate();});
  area.addEventListener('compositionend',()=>{composing=false;paint();update();});
  area.addEventListener('blur',()=>invalidate());
  area.addEventListener('keyup',event=>{if(!composing&&(['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key)||(['ArrowUp','ArrowDown'].includes(event.key)&&suggestions.hidden)))update(false,75,false);});
  area.addEventListener('keydown',event=>{
    if(composing||event.isComposing||event.keyCode===229)return;
    if(!readOnly&&(event.ctrlKey||event.metaKey)&&!event.altKey&&['z','y'].includes(event.key.toLowerCase())){
      const redo=event.key.toLowerCase()==='y'||event.shiftKey;
      if(fallbackHistory(redo)){event.preventDefault();event.stopPropagation();return;}
    }
    if(enabled()&&(event.ctrlKey||event.metaKey)&&(event.code==='Space'||event.key===' ')){event.preventDefault();event.stopPropagation();update(true,0);return;}
    const plain=!event.ctrlKey&&!event.metaKey&&!event.altKey;
    if(!suggestions.hidden&&(!query||!current(query)))invalidate();
    if(!suggestions.hidden&&plain&&!event.shiftKey){
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();invalidate();return;}
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();event.stopPropagation();selected=(selected+(event.key==='ArrowDown'?1:-1)+completion.items.length)%completion.items.length;highlightSelected();return;}
      if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();event.stopPropagation();apply(selected);return;}
    }
    if(event.key==='Escape'){invalidate();return;}
    if(event.key==='Tab'&&plain&&!readOnly){
      const plan=indentEdit(area.value,area.selectionStart,area.selectionEnd,{direction:event.shiftKey?'backward':'forward'});
      invalidate();
      if(plan){event.preventDefault();event.stopPropagation();edit(plan);}
      return;
    }
    if(event.key==='Enter'&&plain&&!readOnly){event.preventDefault();event.stopPropagation();edit(newlineEdit(area.value,area.selectionStart,area.selectionEnd,{language}));return;}
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)||event.ctrlKey||event.metaKey)invalidate();
  });
  root.append(pre,area,status,suggestions,hint);paint();
  return {element:root,textarea:area,
    setLanguage(next){invalidate();language=next;root.dataset.language=next;setState('idle');paint();},
    setValue(next){
      next=String(next??'');
      const saved=selection(),scroll={top:area.scrollTop,left:area.scrollLeft};
      edit({from:0,to:area.value.length,text:next,selectionStart:Math.min(saved.start,next.length),selectionEnd:Math.min(saved.end,next.length),selectionDirection:saved.direction});
      area.scrollTop=scroll.top;area.scrollLeft=scroll.left;sync();
    },
    dispose(){disposed=true;invalidate();resizeObserver?.disconnect();client?.dispose();}
  };
}
