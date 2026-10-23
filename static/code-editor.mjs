/** Highlighted native textarea: selection, IME, clipboard and undo remain native. */
const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function highlight(source,language='text') {
  source=String(source);
  const wrap=(kind,value)=>`<span class="syntax-${kind}">${escape(value)}</span>`;
  let regex;
  if(['xml','html'].includes(language)) regex=/<!--[\s\S]*?-->|<\/?[\w:!][^>]*>|\{\{[^{}]*\}\}/g;
  else if(['json','javascript','graphql'].includes(language)) regex=/\{\{[^{}]*\}\}|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|\b(?:true|false|null|undefined|const|let|var|return|if|else|async|await|function|throw|new|for|while|try|catch|class|query|mutation|fragment|on)\b|\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|[{}\[\]:,()]/g;
  else regex=/\{\{[^{}]*\}\}/g;
  let html='',position=0;
  for(const match of source.matchAll(regex)){
    const token=match[0];html+=escape(source.slice(position,match.index));
    const kind=token.startsWith('{{')?'variable':/^<!--|^\/\/|^\/\*|^#/.test(token)?'comment':token.startsWith('<')?'tag':/^['"`]/.test(token)?(language==='json'&&/^\s*:/.test(source.slice(match.index+token.length))?'key':'string'):/^-?\d/.test(token)?'number':/^[{}\[\]:,()]$/.test(token)?'punctuation':'keyword';
    html+=wrap(kind,token);position=match.index+token.length;
  }
  return html+escape(source.slice(position));
}
const scriptMembers = {
  pm: ['variables','environment','globals','request','response','test','expect'],
  vars: ['get','has','set','unset','toObject'],
  console: ['log','warn','error'],
  response: ['status','statusText','headers','body','elapsed_ms','size'],
};
const memberPattern = /(?:^|[^\w$])([A-Za-z_$][\w$]*)\.([\w$]*)$/;
export function scriptCompletions(prefix) {
  const match = String(prefix).match(memberPattern);
  if (match) return (scriptMembers[match[1]] || []).filter(item => item.startsWith(match[2])).map(item => ({label:item,insert:item.slice(match[2].length)}));
  const word = String(prefix).match(/[A-Za-z_$][\\w$]*$/)?.[0] || '';
  if (!word) return [];
  return Object.keys(scriptMembers).filter(item => item.startsWith(word)).map(item=>({label:item,insert:item.slice(word.length)}));
}
export function createCodeEditor({value='',language='text',label='コード',onChange=()=>{},readOnly=false,intellisense=false}={}) {
  const root=document.createElement('div');root.className='source-editor';root.dataset.language=language;
  const pre=document.createElement('pre');pre.className='source-highlight';pre.setAttribute('aria-hidden','true');
  const area=document.createElement('textarea');area.className='code-editor source-input';area.value=value;area.spellcheck=false;area.wrap='off';area.readOnly=readOnly;area.setAttribute('aria-label',label);area.setAttribute('autocapitalize','off');area.setAttribute('autocomplete','off');
  const status=document.createElement('div');status.className='source-status';status.setAttribute('aria-hidden','true');
  function paint(){pre.innerHTML=highlight(area.value,language)+'\n';status.textContent=`${language.toUpperCase()} · ${area.value.split('\n').length} 行`;sync();}
  function sync(){pre.scrollTop=area.scrollTop;pre.scrollLeft=area.scrollLeft;}
  area.addEventListener('input',()=>{paint();onChange(area.value);});area.addEventListener('scroll',sync);
  area.addEventListener('keydown',event=>{
    if(event.key==='Tab'&&!event.shiftKey&&!readOnly&&(!intellisense||root.querySelector('.source-suggestions')?.hidden!==false)){event.preventDefault();if(!document.execCommand('insertText',false,'  ')){area.setRangeText('  ',area.selectionStart,area.selectionEnd,'end');area.dispatchEvent(new Event('input',{bubbles:true}));}}
  });
  if (intellisense && !readOnly) {
    const suggestions=document.createElement('div');suggestions.className='source-suggestions';suggestions.setAttribute('role','listbox');suggestions.hidden=true;
    let matches=[],selected=0;
    const close=()=>{suggestions.hidden=true;matches=[];};
    const update=()=>{
      if(area.selectionStart!==area.selectionEnd){close();return;}
      matches=scriptCompletions(area.value.slice(0,area.selectionStart));selected=0;
      suggestions.replaceChildren();
      for(const [index,item] of matches.entries()){
        const option=document.createElement('button');option.type='button';option.className='source-suggestion';option.setAttribute('role','option');option.textContent=item.label;
        option.onmousedown=event=>event.preventDefault();option.onclick=()=>apply(index);suggestions.append(option);
      }
      suggestions.hidden=!matches.length;highlightSelected();
    };
    const highlightSelected=()=>{for(const [i,node] of [...suggestions.children].entries())node.setAttribute('aria-selected',String(i===selected));};
    const apply=index=>{
      const item=matches[index];if(!item)return;
      area.setRangeText(item.insert,area.selectionStart,area.selectionEnd,'end');area.dispatchEvent(new Event('input',{bubbles:true}));close();area.focus();
    };
    area.addEventListener('input',update);area.addEventListener('click',update);area.addEventListener('compositionstart',close);area.addEventListener('blur',()=>setTimeout(close,100));
    area.addEventListener('keydown',event=>{
      if(suggestions.hidden)return;
      if(event.key==='Escape'){event.preventDefault();close();}
      else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();selected=(selected+(event.key==='ArrowDown'?1:-1)+matches.length)%matches.length;highlightSelected();}
      else if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();apply(selected);}
    });
    root.append(suggestions);
  }
  root.append(pre,area,status);paint();
  return {element:root,textarea:area,setLanguage(next){language=next;root.dataset.language=next;paint();},setValue(next){area.value=next;paint();onChange(next);}};
}
