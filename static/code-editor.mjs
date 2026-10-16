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
export function createCodeEditor({value='',language='text',label='コード',onChange=()=>{},readOnly=false}={}) {
  const root=document.createElement('div');root.className='source-editor';root.dataset.language=language;
  const pre=document.createElement('pre');pre.className='source-highlight';pre.setAttribute('aria-hidden','true');
  const area=document.createElement('textarea');area.className='code-editor source-input';area.value=value;area.spellcheck=false;area.wrap='off';area.readOnly=readOnly;area.setAttribute('aria-label',label);area.setAttribute('autocapitalize','off');area.setAttribute('autocomplete','off');
  const status=document.createElement('div');status.className='source-status';status.setAttribute('aria-hidden','true');
  function paint(){pre.innerHTML=highlight(area.value,language)+'\n';status.textContent=`${language.toUpperCase()} · ${area.value.split('\n').length} 行`;sync();}
  function sync(){pre.scrollTop=area.scrollTop;pre.scrollLeft=area.scrollLeft;}
  area.addEventListener('input',()=>{paint();onChange(area.value);});area.addEventListener('scroll',sync);
  area.addEventListener('keydown',event=>{
    if(event.key==='Tab'&&!event.shiftKey&&!readOnly){event.preventDefault();if(!document.execCommand('insertText',false,'  ')){area.setRangeText('  ',area.selectionStart,area.selectionEnd,'end');area.dispatchEvent(new Event('input',{bubbles:true}));}}
  });
  root.append(pre,area,status);paint();
  return {element:root,textarea:area,setLanguage(next){language=next;root.dataset.language=next;paint();},setValue(next){area.value=next;paint();onChange(next);}};
}
