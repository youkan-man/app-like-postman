/** Small, offline JavaScript editing service. Never evaluates the edited source.
 * API members are explicit; local identifiers are lexical suggestions, not type inference.
 */
const scope = {
  get: ['get(name)', '変数の値を取得'], has: ['has(name)', '変数の存在を確認'],
  set: ['set(name, value)', '変数を設定'], unset: ['unset(name)', '変数を削除'],
  toObject: ['toObject()', '変数をオブジェクトで取得']
};
const property = name => [name, 'プロパティ'];
export const scriptAPI = {
  pm: Object.fromEntries(['variables','environment','globals','request','response'].map(name=>[name,property(name)]).concat([
    ['test',['test(name, fn)', '名前付きの検証を実行']], ['expect',['expect(actual)', '値のアサーション']]
  ])),
  vars: scope, 'pm.variables': scope, 'pm.environment': scope, 'pm.globals': scope,
  console: Object.fromEntries(['log','warn','error'].map(name=>[name,[`${name}(...values)`, '実行ログへ出力']])),
  response: Object.fromEntries(['status','statusText','headers','body','elapsed_ms','size','url','content_type','cookies','redirects'].map(name=>[name,property(name)])),
  request: Object.fromEntries(['method','url','header','body','auth'].map(name=>[name,property(name)])),
  'pm.request': Object.fromEntries(['method','url','header','body','auth'].map(name=>[name,property(name)])),
  'pm.response': Object.fromEntries(['code','status','responseTime','responseSize','headers'].map(name=>[name,property(name)]).concat([
    ['json',['json()', 'JSONレスポンスを取得']], ['text',['text()', 'レスポンステキストを取得']]
  ])),
  'pm.response.headers': {get:['get(name)', 'ヘッダーを取得'], all:['all()', '全ヘッダーを取得']},
  JSON: {parse:['parse(text)', 'JSONを解析'], stringify:['stringify(value, replacer, space)', 'JSONへ変換']}
};
const roots = ['pm','vars','console','response','request','JSON'];
const identifiers = /[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/gu;
const tail = /[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;
const wordChar = /[$\u200c\u200d\p{ID_Continue}]/u;

/** Mask literals/comments while preserving offsets. Template text is intentionally
 * conservative, including interpolations. Regex literals are not parsed as code.
 */
export function scriptCode(source) {
  source=String(source); const mask=source.split(''); let mode='code', quote='', escaped=false, regexClass=false;
  let last='';
  const blank=i=>{if(source[i]!=='\n'&&source[i]!=='\r')mask[i]=' ';};
  for(let i=0;i<source.length;i++){
    const c=source[i], next=source[i+1];
    if(mode==='line'){blank(i);if(c==='\n')mode='code';continue;}
    if(mode==='block'){blank(i);if(c==='*'&&next==='/'){blank(++i);mode='code';}continue;}
    if(mode==='string'||mode==='template'||mode==='regex'){
      blank(i);
      if(escaped){escaped=false;continue;}
      if(c==='\\'){escaped=true;continue;}
      if(mode==='regex'){
        if(c==='[')regexClass=true;else if(c===']')regexClass=false;
        if(c==='/'&&!regexClass){mode='code';last='literal';while(/[a-z]/i.test(source[i+1]||'')&&i+1<source.length)blank(++i);}
        else if(c==='\n')mode='code';
      } else if(c===quote){mode='code';last='literal';}
      continue;
    }
    if(c==='/'&&next==='/'){blank(i);blank(++i);mode='line';continue;}
    if(c==='/'&&next==='*'){blank(i);blank(++i);mode='block';continue;}
    if(c==='"'||c==="'"||c==='`'){quote=c;mode=c==='`'?'template':'string';blank(i);continue;}
    // Regex begins where an expression is expected, not after an operand.
    if(c==='/'&&(!last||/[=(:,!&|?;{\[+*%~<>]/.test(last)||/\b(?:return|throw|case|yield|await)$/.test(mask.slice(0,i).join('').trimEnd()))){mode='regex';regexClass=false;blank(i);continue;}
    if(!/\s/.test(c))last=c;
  }
  return {code:mask.join(''),mode};
}
function receiverBefore(code, end){
  const before=code.slice(0,end);
  const match=before.match(/([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*\??\.\s*$/);
  if(!match)return null;
  // Do not complete a recognized suffix of an unknown chain (other.pm.response).
  return match[1].replace(/\s/g,'').replace(/\?\./g,'.');
}
function localNames(code){
  const names=new Set();
  for(const match of code.matchAll(/\b(?:const|let|var|function|class)\s+([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)/gu))names.add(match[1]);
  for(const match of code.matchAll(/(?:\bfunction(?:\s+[\w$]+)?\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|([\w$]+)\s*=>)/g)){
    const params=match[1]??match[2]??match[3];
    for(const part of params.split(',')){const id=part.trim().match(/^([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)/u);if(id)names.add(id[1]);}
  }
  return [...names];
}
export function completionContext(source, position=source.length, {explicit=false}={}){
  source=String(source);position=Math.max(0,Math.min(source.length,position));
  const scanned=scriptCode(source.slice(0,position));
  if(scanned.mode!=='code')return null;
  const prefix=scanned.code.match(tail)?.[0]||'', from=position-prefix.length;
  let to=position;while(to<source.length&&wordChar.test(source[to]))to++;
  const receiver=receiverBefore(scanned.code,from);
  let candidates;
  if(receiver!==null)candidates=Object.entries(scriptAPI[receiver]||{}).map(([label,[signature,description]])=>({label,signature,description}));
  else {
    if(!prefix&&!explicit)return null;
    // A trailing dot that isn't a known receiver must never suggest globals.
    if(/\.\s*$/.test(scanned.code.slice(0,from)))return null;
    candidates=[...new Set([...roots,...localNames(scanned.code.slice(0,from))])].map(label=>({label,signature:label,description:roots.includes(label)?'スクリプトAPI':'ローカル識別子'}));
  }
  const items=candidates.filter(item=>item.label.startsWith(prefix)).sort((a,b)=>a.label.localeCompare(b.label));
  return items.length?{from,to,prefix,receiver,items}:null;
}
/** Compatibility API used by existing tests and callers. */
export function scriptCompletions(prefix){
  const result=completionContext(String(prefix));
  return result?.items.map(item=>({label:item.label,insert:item.label.slice(result.prefix.length)}))||[];
}
export function signatureHelp(source, position=source.length){
  const {code,mode}=scriptCode(String(source).slice(0,position));
  if(mode==='line'||mode==='block'||mode==='regex')return null;
  const stack=[];
  for(let i=0;i<code.length;i++){
    const c=code[i];
    if('([{'.includes(c)){
      const name=c==='('?code.slice(0,i).match(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/)?.[1]?.replace(/\s/g,''):null;
      stack.push({opening:c,name,argument:0});
    }else if(')]}'.includes(c))stack.pop();
    else if(c===','&&stack.at(-1)?.opening==='(')stack.at(-1).argument++;
  }
  for(const call of stack.slice().reverse()){
    if(!call.name)continue;
    const at=call.name.lastIndexOf('.');const spec=scriptAPI[call.name.slice(0,at)]?.[call.name.slice(at+1)];
    if(spec?.[0].includes('('))return {name:call.name,signature:call.name.slice(0,at+1)+spec[0],description:spec[1],argument:call.argument};
  }
  return null;
}
