/** Highlighted native textarea; completion edits use the browser undo history. */
import {createScriptIntelligenceClient} from './script-intelligence-client.mjs';
const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function highlight(source,language='text') {
  source=String(source);
  const wrap=(kind,value)=>`<span class="syntax-${kind}">${escape(value)}</span>`;
  let regex;
  if(['xml','html'].includes(language)) regex=/<!--[\s\S]*?-->|<\/?[\w:!][^>]*>|\{\{[^{}]*\}\}/g;
  else if(['json','javascript','graphql'].includes(language)) regex=/\{\{[^{}]*\}\}|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|\b(?:true|false|null|undefined|const|let|var|return|if|else|async|await|function|throw|new|for|while|try|catch|finally|class|switch|case|break|continue|typeof|instanceof|delete|in|of|void|yield|query|mutation|fragment|on)\b|\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|[{}\[\]:,()]/g;
  else regex=/\{\{[^{}]*\}\}/g;
  let html='',position=0;
  for(const match of source.matchAll(regex)){
    const token=match[0];html+=escape(source.slice(position,match.index));
    const kind=token.startsWith('{{')?'variable':/^<!--|^\/\/|^\/\*|^#/.test(token)?'comment':token.startsWith('<')?'tag':/^['"`]/.test(token)?(language==='json'&&/^\s*:/.test(source.slice(match.index+token.length))?'key':'string'):/^-?\d/.test(token)?'number':/^[{}\[\]:,()]$/.test(token)?'punctuation':'keyword';
    html+=wrap(kind,token);position=match.index+token.length;
  }
  return html+escape(source.slice(position));
}
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
        clearTimeout(loadingTimer);setState('ready');showHint(result?.signature);renderCompletion(showCompletion?result?.completion:null,snapshot);
      }catch(error){
        if(error.name==='AbortError'||!current(snapshot))return;
        clearTimeout(loadingTimer);close();showHint(null);setState('error',error);
      }
    },delay);
  }
  function insert(text,from=area.selectionStart,to=area.selectionEnd){
    area.focus({preventScroll:true});area.setSelectionRange(from,to);
    // execCommand is used only for native textarea undo; setRangeText is fallback.
    const before=area.value;let inserted=false;
    try{inserted=document.execCommand('insertText',false,text);}catch{}
    if(!inserted&&area.value===before){area.setRangeText(text,from,to,'end');area.dispatchEvent(new Event('input',{bubbles:true}));}
  }
  function apply(index){
    const item=completion?.items[index];if(!item||!query||!current(query)){invalidate();return;}
    const from=item.from??completion.from,to=item.to??completion.to,text=item.insertText??item.label;
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||to>area.value.length){invalidate();return;}
    applying=true;invalidate();
    try{insert(text,from,to);}finally{applying=false;close();update(false,75,false);}
  }
  retry.onclick=()=>{area.focus({preventScroll:true});update(true,0);};
  area.addEventListener('input',event=>{invalidate();paint();onChange(area.value);if(event.isComposing||composing||applying)return;update();});
  area.addEventListener('scroll',()=>{sync();place();});
  area.addEventListener('focus',()=>update(false,100));
  area.addEventListener('click',()=>update());
  area.addEventListener('select',()=>{if(!applying&&(area.selectionStart!==area.selectionEnd||(query&&query.position!==area.selectionStart)))invalidate();});
  area.addEventListener('compositionstart',()=>{composing=true;invalidate();});
  area.addEventListener('compositionend',()=>{composing=false;paint();update();});
  area.addEventListener('blur',()=>invalidate());
  area.addEventListener('keyup',event=>{if(!composing&&(['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key)||(['ArrowUp','ArrowDown'].includes(event.key)&&suggestions.hidden)))update();});
  area.addEventListener('keydown',event=>{
    if(composing||event.isComposing||event.keyCode===229)return;
    if(enabled()&&(event.ctrlKey||event.metaKey)&&(event.code==='Space'||event.key===' ')){event.preventDefault();event.stopPropagation();update(true,0);return;}
    const plain=!event.ctrlKey&&!event.metaKey&&!event.altKey;
    if(!suggestions.hidden&&plain&&!event.shiftKey){
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();invalidate();return;}
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();event.stopPropagation();selected=(selected+(event.key==='ArrowDown'?1:-1)+completion.items.length)%completion.items.length;highlightSelected();return;}
      if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();event.stopPropagation();apply(selected);return;}
    }
    if(event.key==='Escape'){invalidate();return;}
    if(event.key==='Tab'&&event.shiftKey){invalidate();return;}
    if(event.key==='Tab'&&plain&&!readOnly){event.preventDefault();insert('  ');return;}
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)||event.ctrlKey||event.metaKey)invalidate();
  });
  root.append(pre,area,status,suggestions,hint);paint();
  return {element:root,textarea:area,
    setLanguage(next){invalidate();language=next;root.dataset.language=next;setState('idle');paint();},
    setValue(next){invalidate();area.value=next;paint();onChange(next);},
    dispose(){disposed=true;invalidate();resizeObserver?.disconnect();client?.dispose();}
  };
}
