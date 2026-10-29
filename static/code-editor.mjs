/** Highlighted native textarea; completion edits use the browser undo history. */
import {completionContext, signatureHelp} from './script-intelligence.mjs';
export {scriptCompletions} from './script-intelligence.mjs';
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
export function createCodeEditor({value='',language='text',label='コード',onChange=()=>{},readOnly=false,intellisense=false}={}) {
  const root=document.createElement('div');root.className='source-editor';root.dataset.language=language;
  const pre=document.createElement('pre');pre.className='source-highlight';pre.setAttribute('aria-hidden','true');
  const area=document.createElement('textarea');area.className='code-editor source-input';area.value=value;area.spellcheck=false;area.wrap='off';area.readOnly=readOnly;area.setAttribute('aria-label',label);area.setAttribute('autocapitalize','off');area.setAttribute('autocomplete','off');
  const status=document.createElement('div');status.className='source-status';status.setAttribute('aria-hidden','true');
  const suggestions=document.createElement('div');suggestions.className='source-suggestions';suggestions.id=`script-suggestions-${++editorSequence}`;suggestions.setAttribute('role','listbox');suggestions.setAttribute('aria-label','コード補完');suggestions.hidden=true;
  const hint=document.createElement('div');hint.className='source-signature';hint.id=`script-signature-${editorSequence}`;hint.setAttribute('role','status');hint.hidden=true;
  let completion=null, selected=0, composing=false, applying=false;
  const enabled=()=>intellisense&&!readOnly&&language==='javascript';
  if(intellisense){area.setAttribute('aria-autocomplete','list');area.setAttribute('aria-controls',suggestions.id);area.setAttribute('aria-describedby',hint.id);}
  function close(){suggestions.hidden=true;completion=null;area.removeAttribute('aria-activedescendant');}
  function sync(){pre.scrollTop=area.scrollTop;pre.scrollLeft=area.scrollLeft;}
  function paint(){pre.innerHTML=highlight(area.value,language)+'\n';status.textContent=`${language.toUpperCase()} · ${area.value.split('\n').length} 行`;sync();}
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
    const pos=caret();const width=suggestions.offsetWidth, height=suggestions.offsetHeight;
    const available=area.clientHeight;
    let top=pos.y+pos.line;
    if(top+height>available-4)top=pos.y-height;
    suggestions.style.left=`${Math.max(4,Math.min(pos.x,root.clientWidth-width-4))}px`;
    suggestions.style.top=`${Math.max(4,Math.min(top,available-height-4))}px`;
    suggestions.style.bottom='auto';
  }
  function highlightSelected(){
    for(const [i,node] of [...suggestions.children].entries())node.setAttribute('aria-selected',String(i===selected));
    const item=suggestions.children[selected];
    if(item){area.setAttribute('aria-activedescendant',item.id);const top=item.offsetTop,bottom=top+item.offsetHeight;if(top<suggestions.scrollTop)suggestions.scrollTop=top;else if(bottom>suggestions.scrollTop+suggestions.clientHeight)suggestions.scrollTop=bottom-suggestions.clientHeight;}
  }
  function refreshHint(){
    const info=enabled()&&!composing?signatureHelp(area.value,area.selectionStart):null;
    hint.hidden=!info;
    hint.textContent=info?`${info.signature} · 引数 ${info.argument+1} — ${info.description}`:'';
  }
  function update(explicit=false){
    refreshHint();
    if(!enabled()||composing||applying||area.selectionStart!==area.selectionEnd){close();return;}
    completion=completionContext(area.value,area.selectionStart,{explicit});selected=0;suggestions.replaceChildren();
    if(!completion){close();return;}
    for(const [index,item] of completion.items.entries()){
      const option=document.createElement('button');option.type='button';option.className='source-suggestion';option.id=`${suggestions.id}-${index}`;option.tabIndex=-1;option.setAttribute('role','option');option.setAttribute('aria-label',item.label);option.title=item.description;
      const name=document.createElement('span');name.textContent=item.label;
      const detail=document.createElement('span');detail.className='source-suggestion-detail';detail.textContent=item.signature!==item.label?item.signature:item.description;
      option.append(name,detail);option.addEventListener('pointerdown',event=>event.preventDefault());option.onclick=()=>apply(index);suggestions.append(option);
    }
    suggestions.hidden=false;highlightSelected();place();
  }
  function insert(text,from=area.selectionStart,to=area.selectionEnd){
    area.focus({preventScroll:true});area.setSelectionRange(from,to);
    // execCommand is used only for native textarea undo; setRangeText is fallback.
    const before=area.value;let inserted=false;
    try{inserted=document.execCommand('insertText',false,text);}catch{}
    if(!inserted&&area.value===before){area.setRangeText(text,from,to,'end');area.dispatchEvent(new Event('input',{bubbles:true}));}
  }
  function apply(index){
    const item=completion?.items[index];if(!item)return;
    const {from,to}=completion;applying=true;
    try{insert(item.label,from,to);}finally{applying=false;close();refreshHint();}
  }
  area.addEventListener('input',event=>{paint();onChange(area.value);if(event.isComposing||composing){close();return;}update();});
  area.addEventListener('scroll',()=>{sync();close();});
  area.addEventListener('click',()=>update());
  area.addEventListener('compositionstart',()=>{composing=true;close();hint.hidden=true;});
  area.addEventListener('compositionend',()=>{composing=false;paint();refreshHint();});
  area.addEventListener('blur',()=>{close();hint.hidden=true;});
  area.addEventListener('keyup',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)&&!composing)update();});
  area.addEventListener('keydown',event=>{
    if(composing||event.isComposing||event.keyCode===229)return;
    if(enabled()&&(event.ctrlKey||event.metaKey)&&event.code==='Space'){event.preventDefault();event.stopPropagation();update(true);return;}
    const plain=!event.ctrlKey&&!event.metaKey&&!event.altKey;
    if(!suggestions.hidden&&plain&&!event.shiftKey){
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();event.stopPropagation();selected=(selected+(event.key==='ArrowDown'?1:-1)+completion.items.length)%completion.items.length;highlightSelected();return;}
      if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();event.stopPropagation();apply(selected);return;}
    }
    if(event.key==='Tab'&&event.shiftKey){close();return;}
    if(event.key==='Tab'&&plain&&!readOnly){event.preventDefault();insert('  ');return;}
    if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||event.ctrlKey||event.metaKey)close();
  });
  root.append(pre,area,status,suggestions,hint);paint();
  return {element:root,textarea:area,
    setLanguage(next){language=next;root.dataset.language=next;close();hint.hidden=true;paint();},
    setValue(next){area.value=next;close();hint.hidden=true;paint();onChange(next);}
  };
}
