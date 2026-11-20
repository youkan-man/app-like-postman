/** Highlighted native textarea with semantic intelligence and transactional edits. */
import {createScriptIntelligenceClient} from './script-intelligence-client.mjs';
import {highlight} from './code-highlighter.mjs';
import {indentEdit,newlineEdit,smartBackspaceEdit,smartHomeSelection,toggleLineCommentEdit,moveLinesEdit} from './editor-editing.mjs';
import {createTextHistory} from './editor-history.mjs';
import {createEditorSearch} from './editor-search.mjs';
import {createEditorDiagnostics} from './editor-diagnostics.mjs';
import {bindWheelScroll} from './wheel-scroll.mjs';
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
  let knownValue=area.value,fallbackMode=false,pendingInputSelection=null,lastSelection=selection(),compositionEdit=null;
  const history=createTextHistory();history.reset(area.value);
  let search,diagnostics,hintInfo=null,renderedSource=null,renderedLanguage=null,highlightHTML='',lineStarts=[0];
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
    if(hideHint){hint.hidden=true;hintInfo=null;}
    if(state!=='error')setState('idle');
  }
  function sync(){
    // Only the textarea owns native scrollbars. Match its usable viewport so
    // the highlight layer does not clamp sooner at the bottom/right edges.
    const width=area.clientWidth+'px',height=area.clientHeight+'px',padding=getComputedStyle(area).padding;
    if(pre.style.width!==width)pre.style.width=width;
    if(pre.style.height!==height)pre.style.height=height;
    if(pre.style.padding!==padding)pre.style.padding=padding;
    pre.scrollTop=area.scrollTop;pre.scrollLeft=area.scrollLeft;
  }
  function paint(){
    if(renderedSource!==area.value||renderedLanguage!==language){
      renderedSource=area.value;renderedLanguage=language;highlightHTML=highlight(area.value,language)+'\n';
      lineStarts=[0];for(let i=0;i<area.value.length;i++)if(area.value.charCodeAt(i)===10)lineStarts.push(i+1);
    }
    pre.innerHTML=highlightHTML;diagnostics?.decorate(pre);
    sourceStatus.textContent=`${language.toUpperCase()} · ${lineStarts.length} 行`;sync();
  }
  function activePosition(){return area.selectionDirection==='backward'?area.selectionStart:area.selectionEnd;}
  function lineIndex(position){
    let low=0,high=lineStarts.length;
    while(low+1<high){const middle=(low+high)>>>1;if(lineStarts[middle]<=position)low=middle;else high=middle;}
    return low;
  }
  // Mirror only to measure the caret. It never participates in input or layout.
  function caret(position=activePosition()){
    const mirror=document.createElement('div'), style=getComputedStyle(area);
    const index=lineIndex(position),line=parseFloat(style.lineHeight)||22;
    mirror.style.cssText='position:absolute;visibility:hidden;pointer-events:none;white-space:pre;width:max-content;left:0;top:0;';
    for(const key of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','tabSize','paddingLeft'])mirror.style[key]=style[key];
    mirror.textContent=area.value.slice(lineStarts[index],position);
    const mark=document.createElement('span');mark.textContent='\u200b';mirror.append(mark);root.append(mirror);
    const result={x:mark.offsetLeft-area.scrollLeft,y:(parseFloat(style.paddingTop)||0)+index*line-area.scrollTop,line};mirror.remove();return result;
  }
  function ensureCaretVisible({force=false}={}){
    if(!root.isConnected||!area.clientWidth||!area.clientHeight||(!force&&document.activeElement!==area))return;
    const pos=caret(),style=getComputedStyle(area);
    const left=parseFloat(style.paddingLeft)||0,right=area.clientWidth-(parseFloat(style.paddingRight)||0)-2;
    const top=parseFloat(style.paddingTop)||0,bottom=area.clientHeight-(parseFloat(style.paddingBottom)||0);
    if(pos.x<left)area.scrollLeft+=pos.x-left;else if(pos.x>right)area.scrollLeft+=pos.x-right;
    if(pos.y<top)area.scrollTop+=pos.y-top;else if(pos.y+pos.line>bottom)area.scrollTop+=pos.y+pos.line-bottom;
    sync();
  }
  function place(){
    if(suggestions.hidden&&!hintInfo)return;
    const pos=caret();
    const edge=area.clientHeight-4,above=Math.max(0,pos.y-4),below=Math.max(0,edge-pos.y-pos.line);
    hint.hidden=!hintInfo||(!suggestions.hidden&&area.clientHeight<160);
    let available=edge;
    if(!hint.hidden){
      hint.style.maxHeight=`${Math.max(0,Math.min(72,Math.max(above,below)))}px`;
      hint.style.bottom='auto';
      const height=hint.offsetHeight;
      if(height>Math.max(above,below)||Math.max(above,below)<24)hint.hidden=true;
      else if(suggestions.hidden)hint.style.top=`${below>=height?pos.y+pos.line:pos.y-height}px`;
      else if(pos.y+pos.line<edge-height-4){hint.style.top=`${edge-height}px`;available=edge-height-4;}
      else hint.hidden=true;
    }
    if(!suggestions.hidden){
      const belowList=Math.max(0,available-pos.y-pos.line),room=Math.max(above,belowList);
      suggestions.style.maxHeight=`${Math.max(0,Math.min(180,room))}px`;
      const width=suggestions.offsetWidth,height=suggestions.offsetHeight;
      const top=belowList>=height?pos.y+pos.line:Math.max(4,pos.y-height);
      suggestions.style.left=`${Math.max(4,Math.min(pos.x,root.clientWidth-width-4))}px`;
      suggestions.style.top=`${top}px`;suggestions.style.bottom='auto';
    }
  }
  // A pane or viewport can shrink while the list is open. Its absolute caret
  // coordinates must be clamped again, otherwise overflow:hidden clips it.
  const resizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(()=>{
    // Workspace navigation removes editor nodes without an explicit dispose.
    // Cancel their queued parses so an abandoned editor cannot delay the new one.
    if(!root.isConnected){dispose();return;}
    // An open completion stays with its caret as the viewport narrows. Ordinary
    // reading keeps its scroll position; input, navigation and search reveal
    // the caret through their own explicit paths.
    if(!suggestions.hidden)ensureCaretVisible();
    sync();place();search?.position();diagnostics?.position();
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
    hintInfo=info;
    hint.hidden=!info;
    hint.textContent=info?`${info.signature} · 引数 ${info.argument+1}${info.description?' — '+info.description:''}`:'';
    hint.title=hint.textContent;
  }
  function current(snapshot){
    return !disposed&&root.isConnected&&enabled()&&!composing&&!applying&&document.activeElement===area&&
      snapshot.generation===generation&&area.value===snapshot.source&&area.selectionStart===snapshot.selectionStart&&area.selectionEnd===snapshot.selectionEnd;
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
    if(!completion?.items?.length){close();place();return;}
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
    if(!enabled()||composing||applying||disposed||document.activeElement!==area)return;
    const ticket=generation;setState('pending');
    loadingTimer=setTimeout(()=>{if(ticket===generation&&state==='pending')setState('loading');},250);
    timer=setTimeout(async()=>{
      if(ticket!==generation)return;
      if(!root.isConnected||document.activeElement!==area){invalidate();return;}
      const snapshot={generation:ticket,source:area.value,position:activePosition(),selectionStart:area.selectionStart,selectionEnd:area.selectionEnd,context:null};
      query=snapshot;
      try{
        snapshot.context=typeof intelligenceContext==='function'?intelligenceContext():intelligenceContext||{};
        const result=await client.analyze(snapshot.source,snapshot.position,{explicit,context:snapshot.context});
        if(!current(snapshot)){
          if(ticket===generation){clearTimeout(loadingTimer);setState('idle');}
          return;
        }
        const collapsed=snapshot.selectionStart===snapshot.selectionEnd;
        let offered=showCompletion&&collapsed?result?.completion:null;
        // A fully typed name must not make the next Enter/Tab a no-op. Explicit
        // Ctrl+Space still lets the user inspect every semantic candidate.
        if(!explicit&&offered?.items?.some(item=>{
          const from=item.from??offered.from,to=item.to??offered.to;
          return Number.isInteger(from)&&Number.isInteger(to)&&to>from&&
            snapshot.source.slice(from,to)===(item.insertText??item.label);
        }))offered=null;
        clearTimeout(loadingTimer);setState('ready');diagnostics.set(result?.diagnostics||[],snapshot.source);showHint(collapsed?result?.signature:null);renderCompletion(offered,snapshot);
      }catch(error){
        if(error.name==='AbortError'||!current(snapshot))return;
        clearTimeout(loadingTimer);close();showHint(null);setState('error',error);
      }
    },delay);
  }
  function selection(){return {start:area.selectionStart,end:area.selectionEnd,direction:area.selectionDirection};}
  function restoreSelection(saved){area.setSelectionRange(saved.start,saved.end,saved.direction);}
  function select(start,end,{focus=false}={}){
    history.breakGroup();invalidate();if(focus)area.focus({preventScroll:true});
    area.setSelectionRange(start,end);lastSelection=selection();ensureCaretVisible({force:true});
  }
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
    try{
      area.focus({preventScroll:true});
      if(after!==before){
        area.setSelectionRange(from,to);
        // Keep the browser's normal grouping until its editing API is unavailable.
        // Once a fallback is needed, every edit uses the same ordered journal.
        let native=false;
        if(!fallbackMode)try{native=document.execCommand('insertText',false,text);}catch{}
        if(!native||area.value===before)fallbackMode=true;
        if(area.value===before)area.setRangeText(text,from,to,'end');
        if(knownValue!==area.value)notifyInput();
      }
      restoreSelection(afterSelection);history.record(before,area.value,beforeSelection,selection());
      lastSelection=selection();pendingInputSelection=null;ensureCaretVisible();search?.refresh();
    }finally{applying=false;}
    update(false,75,false);
    return true;
  }
  function performHistory(redo){
    const plan=redo?history.redo(area.value):history.undo(area.value);
    if(!plan)return false;
    applying=true;invalidate();
    try{
      area.setRangeText(plan.text,plan.from,plan.to,'end');
      restoreSelection({start:plan.selectionStart,end:plan.selectionEnd,direction:plan.selectionDirection});
      notifyInput(redo?'historyRedo':'historyUndo');lastSelection=selection();pendingInputSelection=null;
      ensureCaretVisible();search?.refresh();
    }
    finally{applying=false;}
    update(false,75,false);return true;
  }
  function apply(index){
    const item=completion?.items[index];if(!item||!query||!current(query)){invalidate();return;}
    const from=item.from??completion.from,to=item.to??completion.to,text=item.insertText??item.label;
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||to>area.value.length){invalidate();return;}
    edit({from,to,text,selectionDirection:'none'});
  }
  search=createEditorSearch({root,area,readOnly,edit,select});
  diagnostics=createEditorDiagnostics({root,area,select,onUpdate:paint});
  status.insertBefore(search.button,sourceStatus);status.insertBefore(diagnostics.button,sourceStatus);
  // Browsers can discard this textarea's Redo when another field is edited.
  // Our source journal remains authoritative across searches and other panes.
  function foreignInput(event){
    const target=event.target;
    const editable=target?.tagName==='TEXTAREA'||target?.isContentEditable||
      (target?.tagName==='INPUT'&&['text','search','email','url','tel','password','number'].includes(target.type));
    if(editable&&target!==area&&!readOnly){fallbackMode=true;history.breakGroup();}
  }
  document.addEventListener('input',foreignInput,true);
  retry.onclick=()=>{area.focus({preventScroll:true});update(true,0);};
  area.addEventListener('beforeinput',event=>{
    if(applying)return;
    if(fallbackMode&&!readOnly&&event.cancelable&&(event.inputType==='historyUndo'||event.inputType==='historyRedo')){
      event.preventDefault();event.stopPropagation();performHistory(event.inputType==='historyRedo');return;
    }
    pendingInputSelection=selection();
  });
  area.addEventListener('input',event=>{
    const previous=knownValue;knownValue=area.value;
    if(!applying&&!composing&&!event.isComposing){
      if(event.inputType==='historyUndo'||event.inputType==='historyRedo'){
        const saved=history.reconcile(previous,area.value,event.inputType);if(saved)restoreSelection(saved);
      }else history.record(previous,area.value,pendingInputSelection||lastSelection,selection(),{inputType:event.inputType,timestamp:event.timeStamp});
      pendingInputSelection=null;lastSelection=selection();
    }
    invalidate();diagnostics.clear();search.refresh();onChange(area.value);
    if(event.isComposing||composing||applying)return;
    ensureCaretVisible();
    const typed=!event.inputType||event.inputType.startsWith('insert')||event.inputType.startsWith('delete');
    update(false,75,typed);
  });
  area.addEventListener('scroll',()=>{sync();place();search.position();diagnostics.position();});
  area.addEventListener('minipost-wheel-scroll',()=>invalidate());
  // Reading with the wheel must not move completion under the pointer or let a
  // pending analysis reopen it after the caret has scrolled out of view.
  root.addEventListener('wheel',event=>{
    if(!event.ctrlKey&&!event.metaKey&&(event.deltaX||event.deltaY)&&!suggestions.contains(event.target))invalidate();
  },{passive:true});
  const unbindWheel=bindWheelScroll(root,[area]);
  area.addEventListener('focus',()=>{history.breakGroup();update(false,100,false);});
  area.addEventListener('click',()=>{history.breakGroup();update(false,75,false);});
  area.addEventListener('select',()=>{
    if(lastSelection.start!==area.selectionStart||lastSelection.end!==area.selectionEnd)history.breakGroup();
    lastSelection=selection();
    if(!applying&&query&&(query.selectionStart!==area.selectionStart||query.selectionEnd!==area.selectionEnd))invalidate();
  });
  area.addEventListener('compositionstart',()=>{compositionEdit={source:area.value,selection:selection()};composing=true;history.breakGroup();invalidate();diagnostics.clear();});
  area.addEventListener('compositionend',()=>{
    if(compositionEdit)history.record(compositionEdit.source,area.value,compositionEdit.selection,selection());
    compositionEdit=null;pendingInputSelection=null;lastSelection=selection();composing=false;paint();update();
  });
  area.addEventListener('blur',()=>{history.breakGroup();invalidate();});
  area.addEventListener('keyup',event=>{if(!composing&&(['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key)||(['ArrowUp','ArrowDown'].includes(event.key)&&suggestions.hidden))){ensureCaretVisible();update(false,75,false);}});
  area.addEventListener('keydown',event=>{
    if(composing||event.isComposing||event.keyCode===229)return;
    if(search.handleKeydown(event)){diagnostics.close();return;}
    if(!readOnly&&fallbackMode&&(event.ctrlKey||event.metaKey)&&!event.altKey&&['z','y'].includes(event.key.toLowerCase())){
      const redo=event.key.toLowerCase()==='y'||event.shiftKey;
      event.preventDefault();event.stopPropagation();performHistory(redo);return;
    }
    if(enabled()&&(event.ctrlKey||event.metaKey)&&(event.code==='Space'||event.key===' ')){event.preventDefault();event.stopPropagation();update(true,0);return;}
    const plain=!event.ctrlKey&&!event.metaKey&&!event.altKey;
    if(!suggestions.hidden&&(!query||!current(query)))invalidate();
    if(!suggestions.hidden&&plain&&!event.shiftKey){
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();invalidate();return;}
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();event.stopPropagation();selected=(selected+(event.key==='ArrowDown'?1:-1)+completion.items.length)%completion.items.length;highlightSelected();return;}
      if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();event.stopPropagation();apply(selected);return;}
    }
    if(event.key==='Escape'){
      const consumed=search.isOpen()||diagnostics.isOpen()||!hint.hidden;
      if(search.isOpen())search.close();else if(diagnostics.isOpen())diagnostics.close({focus:true});
      invalidate();if(consumed){event.preventDefault();event.stopPropagation();}return;
    }
    if(event.key==='F8'&&plain&&diagnostics.next(event.shiftKey?-1:1)){event.preventDefault();event.stopPropagation();return;}
    if(!readOnly&&(event.ctrlKey||event.metaKey)&&!event.altKey&&(event.key==='/'||event.code==='Slash')){
      const plan=toggleLineCommentEdit(area.value,area.selectionStart,area.selectionEnd,{language});
      if(plan){event.preventDefault();event.stopPropagation();edit(plan);}return;
    }
    if(!readOnly&&event.altKey&&!event.ctrlKey&&!event.metaKey&&['ArrowUp','ArrowDown'].includes(event.key)){
      event.preventDefault();event.stopPropagation();
      edit(moveLinesEdit(area.value,area.selectionStart,area.selectionEnd,{direction:event.key==='ArrowUp'?'up':'down',duplicate:event.shiftKey}));return;
    }
    if(event.key==='Home'&&plain){
      const plan=smartHomeSelection(area.value,area.selectionStart,area.selectionEnd,{extend:event.shiftKey,direction:area.selectionDirection});
      if(plan){event.preventDefault();event.stopPropagation();history.breakGroup();invalidate();area.setSelectionRange(plan.selectionStart,plan.selectionEnd,plan.selectionDirection);lastSelection=selection();ensureCaretVisible();}return;
    }
    if(event.key==='Backspace'&&plain&&!event.shiftKey&&!readOnly){
      const plan=smartBackspaceEdit(area.value,area.selectionStart,area.selectionEnd);
      if(plan){event.preventDefault();event.stopPropagation();edit(plan);return;}
    }
    if(event.key==='Tab'&&plain&&!readOnly){
      const plan=indentEdit(area.value,area.selectionStart,area.selectionEnd,{direction:event.shiftKey?'backward':'forward'});
      invalidate();
      if(plan){event.preventDefault();event.stopPropagation();edit(plan);}
      return;
    }
    if(event.key==='Enter'&&plain&&!readOnly){event.preventDefault();event.stopPropagation();edit(newlineEdit(area.value,area.selectionStart,area.selectionEnd,{language}));return;}
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)||event.ctrlKey||event.metaKey){history.breakGroup();invalidate();}
  });
  function dispose(){if(disposed)return;disposed=true;invalidate();unbindWheel();document.removeEventListener('input',foreignInput,true);resizeObserver?.disconnect();search?.dispose();diagnostics?.dispose();client?.dispose();}
  root.append(pre,area,status,suggestions,hint);paint();
  return {element:root,textarea:area,
    get isComposing(){return composing;},
    setReadOnly(next){
      next=Boolean(next);if(readOnly===next)return;
      invalidate();history.breakGroup();readOnly=next;area.readOnly=next;
      // Search owns its replace controls, while the textarea and its undo
      // journal stay mounted when a saved-script preview becomes editable.
      search.dispose();search.button.remove();
      search=createEditorSearch({root,area,readOnly,edit,select});status.insertBefore(search.button,diagnostics.button);
      if(!next)update(false,75,false);
    },
    syncValue(next,{resetHistory=false}={}){
      if(disposed||composing)return false;
      next=String(next??'');const before=area.value,saved=selection(),scroll={top:area.scrollTop,left:area.scrollLeft};
      if(before===next){if(resetHistory){history.reset(next);fallbackMode=true;}return true;}
      applying=true;invalidate();
      try{
        area.value=next;knownValue=next;restoreSelection({start:Math.min(saved.start,next.length),end:Math.min(saved.end,next.length),direction:saved.direction});
        if(resetHistory)history.reset(next);else history.record(before,next,saved,selection());
        fallbackMode=true;pendingInputSelection=null;lastSelection=selection();diagnostics.clear();search.refresh();paint();
        area.scrollTop=scroll.top;area.scrollLeft=scroll.left;sync();
      }finally{applying=false;}
      update(false,75,false);return true;
    },
    setLanguage(next){invalidate();diagnostics.clear();language=next;root.dataset.language=next;setState('idle');paint();},
    setValue(next){
      next=String(next??'');
      const saved=selection(),scroll={top:area.scrollTop,left:area.scrollLeft};
      edit({from:0,to:area.value.length,text:next,selectionStart:Math.min(saved.start,next.length),selectionEnd:Math.min(saved.end,next.length),selectionDirection:saved.direction});
      area.scrollTop=scroll.top;area.scrollLeft=scroll.left;ensureCaretVisible();sync();
    },
    dispose
  };
}
