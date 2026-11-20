/** Pure script helpers. The factory is serialized into the isolated Worker. */
export function createScriptTools({signal, checkActive = () => {}} = {}) {
  const active = () => {checkActive();if(signal?.aborted)throw new DOMException('処理を停止しました。','AbortError');};
  const own = (value,key) => value != null && Object.hasOwn(value,key);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const define = (object,key,value) => Object.defineProperty(object,key,{value,writable:true,configurable:true,enumerable:true});
  const jsonClone = (value,seen=new Set()) => {
    if(value===null || typeof value==='string' || typeof value==='boolean')return value;
    if(typeof value==='number'&&Number.isFinite(value))return value;
    if(!value||typeof value!=='object'||(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value))))throw new TypeError('JSONで表せる値を指定してください。');
    if(seen.has(value))throw new TypeError('循環参照は扱えません。');
    if(Object.getOwnPropertySymbols(value).length)throw new TypeError('SymbolはJSONで表せません。');
    seen.add(value);
    try {
      if(Array.isArray(value)){if(Object.keys(value).length!==value.length)throw new TypeError('配列の追加プロパティや欠損要素はJSONで表せません。');return Array.from(value,item=>jsonClone(item,seen));}
      return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,jsonClone(item,seen)]));
    }finally{seen.delete(value);}
  };
  const equal = (a,b) => Object.is(a,b) || Boolean(a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>own(b,key)&&equal(a[key],b[key])));
  const text = value => value==null?'':typeof value==='object'?JSON.stringify(value):String(value);
  const bytes = value => {
    if(typeof value==='string')return new TextEncoder().encode(value);
    if(Object.prototype.toString.call(value)==='[object ArrayBuffer]')return new Uint8Array(value).slice();
    if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength).slice();
    if(Array.isArray(value)&&value.every(item=>Number.isInteger(item)&&item>=0&&item<=255))return Uint8Array.from(value);
    throw new TypeError('文字列またはバイト列を指定してください。');
  };
  const decode = (value,fatal=true) => new TextDecoder('utf-8',{fatal}).decode(value);
  const base64Encode = (value,{urlSafe=false,padding=!urlSafe}={}) => {
    active();const data=bytes(value);let binary='';
    for(let index=0;index<data.length;index+=8192)binary+=String.fromCharCode(...data.subarray(index,index+8192));
    let result=btoa(binary);if(urlSafe)result=result.replaceAll('+','-').replaceAll('/','_');
    return padding?result:result.replace(/=+$/,'');
  };
  const base64Decode = (value,{urlSafe=false,asBytes=false,fatal=true}={}) => {
    active();let encoded=String(value).replace(/[\t\r\n ]/g,'');
    if(urlSafe)encoded=encoded.replaceAll('-','+').replaceAll('_','/');
    if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(encoded))throw new TypeError('Base64の形式が不正です。');
    const binary=atob(encoded),data=Uint8Array.from(binary,char=>char.charCodeAt(0));
    if(base64Encode(data,{padding:false})!==encoded.replace(/=+$/,''))throw new TypeError('Base64の末尾ビットが不正です。');
    return asBytes?data:decode(data,fatal);
  };
  const hexEncode = value => {active();return Array.from(bytes(value),byte=>byte.toString(16).padStart(2,'0')).join('');};
  const hexDecode = (value,{asBytes=false,fatal=true}={}) => {
    active();const hex=String(value);if(!/^(?:[0-9a-fA-F]{2})*$/.test(hex))throw new TypeError('16進数は2桁ずつ指定してください。');
    const data=Uint8Array.from(hex.match(/../g)||[],part=>parseInt(part,16));return asBytes?data:decode(data,fatal);
  };
  const pairs = value => {
    if(value==null)return [];
    if(typeof value==='string')return [...new URLSearchParams(value.replace(/^\?/,''))].map(([key,value])=>({key,value}));
    if(Array.isArray(value))return value.filter(row=>Array.isArray(row)||row?.disabled!==true&&row?.enabled!==false).map(row=>{
      if(Array.isArray(row)&&row.length===2)return {key:String(row[0]),value:text(row[1])};
      if(record(row)&&typeof row.key==='string')return {key:row.key,value:text(row.value)};
      throw new TypeError('キー・値の行または2要素の配列を指定してください。');
    });
    if(record(value))return Object.entries(value).flatMap(([key,value])=>(Array.isArray(value)?value:[value]).map(item=>({key,value:text(item)})));
    throw new TypeError('文字列・行配列・オブジェクトを指定してください。');
  };
  const query = {
    parse(value){active();return pairs(value);},
    stringify(value){active();return new URLSearchParams(pairs(value).map(({key,value})=>[key,value])).toString();},
    get(value,key){active();return pairs(value).find(row=>row.key===String(key))?.value;},
    getAll(value,key){active();return pairs(value).filter(row=>row.key===String(key)).map(row=>row.value);},
    set(value,key,next){active();const rows=pairs(value),name=String(key),at=rows.findIndex(row=>row.key===name),rest=rows.filter(row=>row.key!==name);rest.splice(at<0?rest.length:at,0,{key:name,value:text(next)});return rest;},
    append(value,key,next){active();return [...pairs(value),{key:String(key),value:text(next)}];},
    remove(value,key){active();return pairs(value).filter(row=>row.key!==String(key));},
    toObject(value){active();const map=new Map();for(const {key,value:item}of pairs(value)){if(!map.has(key))map.set(key,item);else map.set(key,[].concat(map.get(key),item));}return Object.fromEntries(map);}
  };
  const headerRows = value => {
    const rows=typeof value==='string'?value.split(/\r?\n/).filter(line=>line.trim()).map(line=>{
      const at=line.indexOf(':');if(at<1)throw new TypeError('ヘッダーは 名前: 値 の形式で指定してください。');return {key:line.slice(0,at).trim(),value:line.slice(at+1).trim()};
    }):pairs(value);
    for(const row of rows)if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(row.key)||/[\u0000-\u0008\u000a-\u001f\u007f]/.test(row.value))throw new TypeError('ヘッダー名または値が不正です。');
    return rows;
  };
  const headers = {
    parse(value){active();return headerRows(value);},
    stringify(value){active();return headerRows(value).map(row=>`${row.key}: ${row.value}`).join('\r\n');},
    get(value,key){active();return headerRows(value).find(row=>row.key.toLowerCase()===String(key).toLowerCase())?.value;},
    getAll(value,key){active();return headerRows(value).filter(row=>row.key.toLowerCase()===String(key).toLowerCase()).map(row=>row.value);},
    set(value,key,next){active();return [...headers.remove(value,key),...headerRows([{key:String(key),value:text(next)}])];},
    append(value,key,next){active();return [...headerRows(value),...headerRows([{key:String(key),value:text(next)}])];},
    remove(value,key){active();return headerRows(value).filter(row=>row.key.toLowerCase()!==String(key).toLowerCase());},
    toObject(value){active();return query.toObject(headerRows(value).map(row=>({key:row.key.toLowerCase(),value:row.value})));}
  };
  const url = {
    parse(value,base){active();const parsed=new URL(value,base);return {href:parsed.href,origin:parsed.origin,protocol:parsed.protocol,hostname:parsed.hostname,port:parsed.port,username:parsed.username,password:parsed.password,path:parsed.pathname,hash:parsed.hash.slice(1),query:pairs(parsed.search)};},
    build(value,{base,path,query:values,hash,username,password}={}){active();const parsed=new URL(value,base);if(path!==undefined)parsed.pathname=String(path);if(values!==undefined)parsed.search=query.stringify(values).replaceAll('+','%20');if(hash!==undefined)parsed.hash=String(hash);if(username!==undefined)parsed.username=String(username);if(password!==undefined)parsed.password=String(password);return parsed.href;},
    join(base,...segments){active();const parsed=new URL(base);if(segments.length)parsed.pathname=parsed.pathname.replace(/\/$/,'')+'/'+segments.map(value=>encodeURIComponent(String(value))).join('/');return parsed.href;}
  };
  const cookieToken = value => {if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(String(value)))throw new TypeError('Cookie名が不正です。');return String(value);};
  const cookies = {
    parse(value){active();return Object.fromEntries(String(value).split(';').filter(part=>part.trim()).map(part=>{const at=part.indexOf('=');if(at<1)throw new TypeError('Cookieは 名前=値 の形式で指定してください。');return [cookieToken(part.slice(0,at).trim()),decodeURIComponent(part.slice(at+1).trim())];}));},
    stringify(value){active();return pairs(value).map(row=>cookieToken(row.key)+'='+encodeURIComponent(row.value)).join('; ');},
    parseSetCookie(value){active();const parts=String(value).split(';'),first=parts.shift(),at=first.indexOf('=');if(at<1)throw new TypeError('Set-Cookieの形式が不正です。');const attributes=Object.fromEntries(parts.filter(part=>part.trim()).map(part=>{const at=part.indexOf('=');return at<0?[part.trim().toLowerCase(),true]:[part.slice(0,at).trim().toLowerCase(),part.slice(at+1).trim()];}));return {name:cookieToken(first.slice(0,at).trim()),value:decodeURIComponent(first.slice(at+1).trim()),attributes};},
    serialize(name,value,attributes={}){active();const parts=[cookieToken(name)+'='+encodeURIComponent(text(value))];for(const [key,item]of Object.entries(attributes)){if(!/^[A-Za-z][A-Za-z0-9-]*$/.test(key)||/[\r\n;]/.test(String(item)))throw new TypeError('Cookie属性が不正です。');if(item!==false&&item!=null)parts.push(item===true?key:`${key}=${item instanceof Date?item.toUTCString():String(item)}`);}return parts.join('; ');}
  };
  const request = {build(options={}){
    active();if(!record(options)||typeof options.url!=='string')throw new TypeError('リクエストURLを文字列で指定してください。');
    if(['json','form','body'].filter(key=>own(options,key)).length>1)throw new TypeError('json・form・bodyはいずれか1つを指定してください。');
    if(own(options,'basic')&&own(options,'bearer'))throw new TypeError('認証はbasicまたはbearerの1つを指定してください。');
    const method=String(options.method||'GET').toUpperCase();if(!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(method))throw new TypeError('HTTPメソッドが不正です。');
    let address=options.url,header=headerRows(options.headers||[]);
    if(own(options,'query')){
      const hash=address.indexOf('#'),fragment=hash<0?'':address.slice(hash);address=hash<0?address:address.slice(0,hash);
      // MiniPost preserves literal plus signs in typed URLs. Encode new spaces
      // as %20 and retain the original query instead of decoding/re-encoding it.
      const encoded=query.stringify(options.query).replaceAll('+','%20');
      if(encoded)address+=(address.includes('?')?/[?&]$/.test(address)?'':'&':'?')+encoded;
      address+=fragment;
    }
    const result={method,url:address,header};
    if(own(options,'json')){result.body={mode:'raw',raw:JSON.stringify(jsonClone(options.json)),options:{raw:{language:'json'}}};if(headers.get(header,'content-type')===undefined)result.header=headers.set(header,'Content-Type','application/json');}
    else if(own(options,'form'))result.body={mode:'urlencoded',urlencoded:pairs(options.form)};
    else if(own(options,'body'))result.body=typeof options.body==='string'?{mode:'raw',raw:options.body,options:{raw:{language:'text'}}}:jsonClone(options.body);
    if(own(options,'basic')){if(!record(options.basic)||typeof options.basic.username!=='string'||typeof options.basic.password!=='string')throw new TypeError('basicにはusernameとpasswordを指定してください。');result.auth={type:'basic',basic:[{key:'username',value:options.basic.username,type:'string'},{key:'password',value:options.basic.password,type:'string'}]};}
    else if(own(options,'bearer'))result.auth={type:'bearer',bearer:[{key:'token',value:String(options.bearer),type:'string'}]};
    return result;
  }};
  function pathParts(path){
    if(Array.isArray(path))return path.map(part=>{if(typeof part!=='string'&&(!Number.isInteger(part)||part<0))throw new TypeError('パスの要素が不正です。');return String(part);});
    if(typeof path!=='string')throw new TypeError('パスは文字列または配列で指定してください。');
    if(path==='')return [];
    if(path.startsWith('/'))return path.slice(1).split('/').map(part=>{if(/~(?:[^01]|$)/.test(part))throw new TypeError('JSON Pointerのエスケープが不正です。');return part.replace(/~1/g,'/').replace(/~0/g,'~');});
    if(path==='$')return [];if(path.startsWith('$.'))path=path.slice(2);else if(path.startsWith('$['))path=path.slice(1);
    const result=[];let index=0,expectSegment=true;
    while(index<path.length){
      if(path[index]==='['){const start=index++;let part;if(path[index]==='"'){const begin=index++;let escaped=false;while(index<path.length){const char=path[index++];if(char==='"'&&!escaped)break;escaped=char==='\\'&&!escaped;}try{part=JSON.parse(path.slice(begin,index));}catch{throw new TypeError('パスの引用符が不正です。');}if(path[index++]!==']')throw new TypeError('パスの括弧が不正です。');}
        else{const end=path.indexOf(']',index);if(end<0)throw new TypeError('パスの括弧が不正です。');part=path.slice(index,end);if(!/^(?:0|[1-9]\d*|\*)$/.test(part))throw new TypeError('配列の添字が不正です。');index=end+1;}if(index<=start)throw new TypeError('パスが不正です。');result.push(part);expectSegment=false;}
      else if(path[index]==='.') {if(expectSegment)throw new TypeError('パスに空の要素があります。');index++;expectSegment=true;}
      else{if(!expectSegment)throw new TypeError('パスの区切りが不正です。');const begin=index;while(index<path.length&&!'.['.includes(path[index]))index++;const part=path.slice(begin,index);if(!part||part.includes(']'))throw new TypeError('パスが不正です。');result.push(part);expectSegment=false;}
    }
    if(expectSegment)throw new TypeError('パスの末尾が不正です。');return result;
  }
  const pointer = parts => parts.length?'/'+parts.map(part=>String(part).replaceAll('~','~0').replaceAll('/','~1')).join('/'):'';
  const lookup = (value,parts) => {for(const part of parts){if(value===null||typeof value!=='object'||!own(value,part))return {found:false};value=value[part];}return {found:true,value};};
  function replacePath(value,path,next,remove=false){
    active();const parts=pathParts(path),output=jsonClone(value);if(!parts.length)return remove?null:jsonClone(next);
    let cursor=output;
    for(let index=0;index<parts.length;index++){
      const key=parts[index],last=index===parts.length-1;
      if(cursor===null||typeof cursor!=='object')throw new TypeError(`パスがコンテナーではありません: ${pointer(parts.slice(0,index))}`);
      if(Array.isArray(cursor)&&!(/^(?:0|[1-9]\d*)$/.test(key)||last&&key==='-'&&!remove))throw new TypeError('配列には非負の添字を指定してください。');
      const at=Array.isArray(cursor)?key==='-'?cursor.length:Number(key):key;
      if(Array.isArray(cursor)&&at>cursor.length)throw new RangeError('配列に空の要素は作成できません。');
      if(last){if(remove){if(!own(cursor,at))return output;if(Array.isArray(cursor))cursor.splice(at,1);else delete cursor[at];}else define(cursor,at,jsonClone(next));}
      else{if(!own(cursor,at)){if(remove)return output;define(cursor,at,/^(?:0|[1-9]\d*|-)$/.test(parts[index+1])?[]:{});}cursor=cursor[at];}
    }return output;
  }
  function validate(value,schema){
    active();const errors=[],supported=new Set(['$schema','title','description','default','examples','type','enum','const','properties','required','additionalProperties','items','minItems','maxItems','uniqueItems','minLength','maxLength','pattern','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','anyOf','allOf','oneOf','not']);
    function check(rule,depth=0){
      if(depth>100)throw new RangeError('スキーマの入れ子が深すぎます。');if(typeof rule==='boolean')return;
      if(!record(rule))throw new TypeError('スキーマはオブジェクトまたは真偽値で指定してください。');
      for(const key of Object.keys(rule))if(!supported.has(key))throw new TypeError(`未対応のスキーマキーワードです: ${key}`);
      if(rule.type!==undefined){const types=Array.isArray(rule.type)?rule.type:[rule.type];if(!types.length||new Set(types).size!==types.length||!types.every(type=>['null','array','object','integer','number','string','boolean'].includes(type)))throw new TypeError('スキーマの型が不正です。');}
      for(const key of ['$schema','title','description'])if(rule[key]!==undefined&&typeof rule[key]!=='string')throw new TypeError(`${key}は文字列で指定してください。`);
      if(rule.examples!==undefined&&!Array.isArray(rule.examples))throw new TypeError('examplesは配列で指定してください。');
      for(const key of ['minItems','maxItems','minLength','maxLength'])if(rule[key]!==undefined&&(!Number.isSafeInteger(rule[key])||rule[key]<0))throw new TypeError(`${key}は非負の整数で指定してください。`);
      for(const key of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf'])if(rule[key]!==undefined&&(!Number.isFinite(rule[key])||key==='multipleOf'&&rule[key]<=0))throw new TypeError(`${key}の数値が不正です。`);
      if(rule.uniqueItems!==undefined&&typeof rule.uniqueItems!=='boolean')throw new TypeError('uniqueItemsは真偽値で指定してください。');
      if(rule.pattern!==undefined){if(typeof rule.pattern!=='string')throw new TypeError('patternは文字列で指定してください。');new RegExp(rule.pattern,'u');}
      if(rule.enum!==undefined&&(!Array.isArray(rule.enum)||!rule.enum.length||rule.enum.some((item,index)=>rule.enum.slice(0,index).some(other=>equal(item,other)))))throw new TypeError('enumは重複のない空でない配列で指定してください。');
      if(rule.required!==undefined&&(!Array.isArray(rule.required)||!rule.required.every(key=>typeof key==='string')||new Set(rule.required).size!==rule.required.length))throw new TypeError('requiredは重複のない文字列配列で指定してください。');
      if(rule.properties!==undefined){if(!record(rule.properties))throw new TypeError('propertiesはオブジェクトで指定してください。');Object.values(rule.properties).forEach(child=>check(child,depth+1));}
      for(const key of ['items','additionalProperties','not'])if(rule[key]!==undefined)check(rule[key],depth+1);
      for(const key of ['allOf','anyOf','oneOf'])if(rule[key]!==undefined){if(!Array.isArray(rule[key])||!rule[key].length)throw new TypeError(`${key}は空でない配列で指定してください。`);rule[key].forEach(child=>check(child,depth+1));}
    }
    function visit(current,rule,path,depth=0){
      if(depth>100)throw new RangeError('スキーマの入れ子が深すぎます。');
      const fail=(keyword,message)=>errors.push({path:pointer(path),keyword,message});
      if(rule===true)return;if(rule===false){fail('false','値は許可されていません。');return;}
      if(!record(rule))throw new TypeError('スキーマはオブジェクトまたは真偽値で指定してください。');
      for(const key of Object.keys(rule))if(!supported.has(key))throw new TypeError(`未対応のスキーマキーワードです: ${key}`);
      const matches=type=>type==='null'?current===null:type==='array'?Array.isArray(current):type==='object'?record(current):type==='integer'?Number.isInteger(current):type==='number'?typeof current==='number'&&Number.isFinite(current):['string','boolean'].includes(type)?typeof current===type:(()=>{throw new TypeError(`スキーマの型が不正です: ${type}`);})();
      if(rule.type!==undefined&&!(Array.isArray(rule.type)?rule.type:[rule.type]).some(matches))fail('type','型が一致しません。');
      if(own(rule,'const')&&!equal(current,rule.const))fail('const','指定値と一致しません。');
      if(rule.enum!==undefined){if(!Array.isArray(rule.enum))throw new TypeError('enumは配列で指定してください。');if(!rule.enum.some(item=>equal(item,current)))fail('enum','候補に含まれていません。');}
      for(const kind of ['allOf','anyOf','oneOf'])if(rule[kind]!==undefined){if(!Array.isArray(rule[kind])||!rule[kind].length)throw new TypeError(`${kind}は空でない配列で指定してください。`);const results=rule[kind].map(child=>{const at=errors.length;visit(current,child,path,depth+1);const valid=errors.length===at;errors.splice(at);return valid;});if(kind==='allOf'?!results.every(Boolean):kind==='anyOf'?!results.some(Boolean):results.filter(Boolean).length!==1)fail(kind,`${kind}の条件を満たしません。`);}
      if(rule.not!==undefined){const at=errors.length;visit(current,rule.not,path,depth+1);const valid=errors.length===at;errors.splice(at);if(valid)fail('not','除外条件に一致しました。');}
      if(record(current)){
        if(rule.required!==undefined){if(!Array.isArray(rule.required)||!rule.required.every(key=>typeof key==='string'))throw new TypeError('requiredは文字列配列で指定してください。');for(const key of rule.required)if(!own(current,key))fail('required',`必須項目がありません: ${key}`);}
        if(rule.properties!==undefined&&!record(rule.properties))throw new TypeError('propertiesはオブジェクトで指定してください。');
        for(const [key,item]of Object.entries(current)){if(own(rule.properties,key))visit(item,rule.properties[key],[...path,key],depth+1);else if(rule.additionalProperties===false)fail('additionalProperties',`未定義の項目です: ${key}`);else if(record(rule.additionalProperties))visit(item,rule.additionalProperties,[...path,key],depth+1);}
      }
      if(Array.isArray(current)){
        if(rule.items!==undefined)current.forEach((item,index)=>visit(item,rule.items,[...path,String(index)],depth+1));
        if(rule.minItems!==undefined&&current.length<rule.minItems)fail('minItems','要素が不足しています。');if(rule.maxItems!==undefined&&current.length>rule.maxItems)fail('maxItems','要素が多すぎます。');
        if(rule.uniqueItems&&current.some((item,index)=>current.slice(0,index).some(other=>equal(item,other))))fail('uniqueItems','要素が重複しています。');
      }
      if(typeof current==='string'){const length=[...current].length;if(rule.minLength!==undefined&&length<rule.minLength)fail('minLength','文字数が不足しています。');if(rule.maxLength!==undefined&&length>rule.maxLength)fail('maxLength','文字数が多すぎます。');if(rule.pattern!==undefined&&!new RegExp(rule.pattern,'u').test(current))fail('pattern','パターンに一致しません。');}
      if(typeof current==='number')for(const [key,invalid]of [['minimum',current<rule.minimum],['maximum',current>rule.maximum],['exclusiveMinimum',current<=rule.exclusiveMinimum],['exclusiveMaximum',current>=rule.exclusiveMaximum],['multipleOf',rule.multipleOf!==undefined&&(!(rule.multipleOf>0)||Math.abs(current/rule.multipleOf-Math.round(current/rule.multipleOf))>1e-10)]])if(rule[key]!==undefined&&invalid)fail(key,`${key}の条件を満たしません。`);
    }
    jsonClone(value);schema=jsonClone(schema);check(schema);visit(value,schema,[]);return {valid:!errors.length,errors};
  }
  const json = {
    pointer(path){active();return pointer(pathParts(path));},
    get(value,path,fallback){active();const result=lookup(value,pathParts(path));return result.found?structuredClone(result.value):fallback;},
    has(value,path){active();return lookup(value,pathParts(path)).found;},
    set:replacePath,
    update(value,path,fn){if(typeof fn!=='function')throw new TypeError('更新関数を指定してください。');return replacePath(value,path,fn(json.get(value,path)));},
    remove(value,path){return replacePath(value,path,null,true);},
    select(value,path){active();const parts=pathParts(path),matches=[];function visit(current,index,location){if(index===parts.length){matches.push({path:pointer(location),value:structuredClone(current)});return;}if(current===null||typeof current!=='object')return;const key=parts[index];for(const next of key==='*'?Object.keys(current):own(current,key)?[key]:[])visit(current[next],index+1,[...location,next]);}visit(value,0,[]);return matches;},
    flatten(value){active();const result={};function visit(item,path){if(item!==null&&typeof item==='object'&&Object.keys(item).length)for(const [key,value]of Object.entries(item))visit(value,[...path,key]);else define(result,pointer(path),jsonClone(item));}visit(jsonClone(value),[]);return result;},
    diff(before,after){active();before=jsonClone(before);after=jsonClone(after);const changes=[];function visit(a,b,path){if(equal(a,b))return;if(a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){if(Array.isArray(a)){const shared=Math.min(a.length,b.length);for(let i=0;i<shared;i++)visit(a[i],b[i],[...path,i]);for(let i=a.length-1;i>=b.length;i--)changes.push({op:'remove',path:pointer([...path,i])});for(let i=shared;i<b.length;i++)changes.push({op:'add',path:pointer([...path,i]),value:jsonClone(b[i])});}else{for(const key of Object.keys(a))if(!own(b,key))changes.push({op:'remove',path:pointer([...path,key])});for(const key of Object.keys(b))if(!own(a,key))changes.push({op:'add',path:pointer([...path,key]),value:jsonClone(b[key])});else visit(a[key],b[key],[...path,key]);}}else changes.push({op:'replace',path:pointer(path),value:jsonClone(b)});}visit(before,after,[]);return changes;},
    pick(value,keys){active();return Object.fromEntries(keys.filter(key=>own(value,key)).map(key=>[key,jsonClone(value[key])]));},
    omit(value,keys){active();const omitted=new Set(keys);return Object.fromEntries(Object.entries(value).filter(([key])=>!omitted.has(key)).map(([key,item])=>[key,jsonClone(item)]));},
    merge(...values){active();const merge=(a,b)=>{if(!record(a)||!record(b))return jsonClone(b);const output=jsonClone(a);for(const [key,item]of Object.entries(b))define(output,key,own(output,key)?merge(output[key],item):jsonClone(item));return output;};return values.reduce(merge,{});},
    schema(value){active();function infer(item){if(item===null)return {type:'null'};if(Array.isArray(item)){const samples=item.map(infer),unique=[...new Map(samples.map(schema=>[JSON.stringify(schema),schema])).values()];return {type:'array',...(unique.length?{items:unique.length===1?unique[0]:{anyOf:unique}}:{})};}if(record(item))return {type:'object',properties:Object.fromEntries(Object.entries(item).map(([key,value])=>[key,infer(value)])),required:Object.keys(item)};return {type:typeof item==='number'&&Number.isInteger(item)?'integer':typeof item};}return infer(jsonClone(value));},
    validate
  };
  const delimiter = value => {if(typeof value!=='string'||value.length!==1||/["\r\n]/.test(value))throw new TypeError('区切り文字は改行・引用符以外の1文字を指定してください。');return value;};
  const csv = {
    parse(source,{delimiter:separator=',',header=false,skipEmptyLines=false}={}){
      active();separator=delimiter(separator);const value=String(source).replace(/^\uFEFF/,''),rows=[];if(!value)return [];
      let row=[],cell='',quoted=false,closed=false,start=true;
      const finish=()=>{row.push(cell);if(!skipEmptyLines||row.some(item=>item!==''))rows.push(row);row=[];cell='';closed=false;start=true;};
      for(let index=0;index<value.length;index++){
        const char=value[index];if(quoted){if(char==='"'){if(value[index+1]==='"'){cell+='"';index++;}else{quoted=false;closed=true;}}else cell+=char;continue;}
        if(char==='"'){if(!start||closed)throw new TypeError(`CSVの引用符が不正です (${index})`);quoted=true;start=false;}
        else if(char===separator){row.push(cell);cell='';closed=false;start=true;}
        else if(char==='\r'||char==='\n'){if(char==='\r'&&value[index+1]==='\n')index++;finish();}
        else{if(closed)throw new TypeError(`CSVの引用符の後に文字があります (${index})`);cell+=char;start=false;}
      }
      if(quoted)throw new TypeError('CSVの引用符が閉じられていません。');
      if(!/[\r\n]$/.test(value)||cell||row.length||closed)finish();
      if(!header)return rows;const columns=rows.shift()||[];if(new Set(columns).size!==columns.length)throw new TypeError('CSVの見出しが重複しています。');return rows.map((row,index)=>{if(row.length!==columns.length)throw new TypeError(`CSV ${index+2}行目の列数が一致しません。`);return Object.fromEntries(columns.map((key,index)=>[key,row[index]]));});
    },
    stringify(values,{delimiter:separator=',',header,columns,lineEnding='\r\n',trailingNewline=false}={}){
      active();separator=delimiter(separator);if(!Array.isArray(values)||!['\r\n','\n','\r'].includes(lineEnding))throw new TypeError('CSVの行または改行形式が不正です。');
      const objects=values.length?record(values[0]):Boolean(columns);if(values.some(row=>objects?!record(row):!Array.isArray(row)))throw new TypeError('CSVの行形式を統一してください。');
      const keys=columns||[...new Set(values.flatMap(row=>Object.keys(row)))];if(new Set(keys).size!==keys.length)throw new TypeError('CSVの列名が重複しています。');
      const rows=objects?values.map(row=>keys.map(key=>own(row,key)?row[key]:'')):values.map(row=>row.slice());if(header??objects)rows.unshift(keys);
      const encode=value=>{const string=text(value);return string.includes(separator)||/["\r\n]/.test(string)?'"'+string.replaceAll('"','""')+'"':string;};
      return rows.map(row=>row.map(encode).join(separator)).join(lineEnding)+(trailingNewline&&rows.length?lineEnding:'');
    }
  };
  // SHA-256/HMAC remain available in an opaque Worker on plain HTTP, where
  // SubtleCrypto may be absent. This implements SHA-256, never a weaker substitute.
  function sha256(input){
    const data=bytes(input),length=data.length,total=Math.ceil((length+9)/64)*64,buffer=new Uint8Array(total);buffer.set(data);buffer[length]=128;
    const view=new DataView(buffer.buffer);view.setUint32(total-8,Math.floor(length/0x20000000));view.setUint32(total-4,(length*8)>>>0);
    const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],w=new Uint32Array(64),rotr=(x,n)=>(x>>>n)|(x<<(32-n));
    for(let offset=0;offset<total;offset+=64){active();for(let i=0;i<16;i++)w[i]=view.getUint32(offset+i*4);for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=(w[i-16]+(rotr(a,7)^rotr(a,18)^(a>>>3))+w[i-7]+(rotr(b,17)^rotr(b,19)^(b>>>10)))>>>0;}
      let [a,b,c,d,e,f,g,z]=h;for(let i=0;i<64;i++){const t1=(z+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+k[i]+w[i])>>>0,t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;z=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}[a,b,c,d,e,f,g,z].forEach((value,i)=>h[i]=(h[i]+value)>>>0);
    }const output=new Uint8Array(32),outputView=new DataView(output.buffer);h.forEach((value,i)=>outputView.setUint32(i*4,value));return output;
  }
  const hashAlgorithm = name => {const result=String(name).toUpperCase().replace(/^SHA(\d)/,'SHA-$1');if(!['SHA-256','SHA-384','SHA-512'].includes(result))throw new TypeError('SHA-256・SHA-384・SHA-512を指定してください。');return result;};
  const digest = (value,format) => {if(format==='bytes')return bytes(value);if(format==='hex')return hexEncode(value);if(format==='base64')return base64Encode(value);if(format==='base64url')return base64Encode(value,{urlSafe:true});throw new TypeError('出力形式はhex・base64・base64url・bytesです。');};
  const cryptoAPI = {
    async hash(value,algorithm='SHA-256',format='hex'){active();const name=hashAlgorithm(algorithm),data=bytes(value),native=globalThis.crypto?.subtle;if(!native&&name!=='SHA-256')throw new Error(`${name}にはWebCryptoを利用できる実行環境が必要です。`);const output=native?await native.digest(name,data):sha256(data);active();return digest(output,format);},
    async hmac(key,value,algorithm='SHA-256',format='hex'){active();const name=hashAlgorithm(algorithm),data=bytes(value),native=globalThis.crypto?.subtle;let output;if(native){const secret=bytes(key),imported=await native.importKey('raw',secret.length?secret:new Uint8Array([0]),{name:'HMAC',hash:name},false,['sign']);output=await native.sign('HMAC',imported,data);}else{if(name!=='SHA-256')throw new Error(`${name}にはWebCryptoを利用できる実行環境が必要です。`);let secret=bytes(key);if(secret.length>64)secret=sha256(secret);const inner=new Uint8Array(64+data.length),outer=new Uint8Array(96);for(let i=0;i<64;i++){inner[i]=(secret[i]||0)^0x36;outer[i]=(secret[i]||0)^0x5c;}inner.set(data,64);outer.set(sha256(inner),64);output=sha256(outer);}active();return digest(output,format);},
    randomBytes(length){active();if(!Number.isSafeInteger(length)||length<0)throw new RangeError('バイト数は非負の整数で指定してください。');if(typeof globalThis.crypto?.getRandomValues!=='function')throw new Error('暗号学的乱数を利用できません。');const output=new Uint8Array(length);for(let offset=0;offset<length;offset+=65536)globalThis.crypto.getRandomValues(output.subarray(offset,offset+65536));return output;},
    uuid(){const value=cryptoAPI.randomBytes(16);value[6]=(value[6]&15)|64;value[8]=(value[8]&63)|128;const hex=hexEncode(value);return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;}
  };
  const assertionError = message => {const error=new Error(message||'検証に失敗しました。');error.name='AssertionError';return error;};
  const matchError = (error,match) => {if(match!==undefined&&!(match instanceof RegExp?new RegExp(match.source,match.flags).test(String(error?.message||error)):String(error?.message||error).includes(String(match))))throw assertionError('例外メッセージが一致しません。');return error;};
  const assert = {
    ok(value,message){active();if(!value)throw assertionError(message);return value;},
    equal(actual,expected,message){active();if(!Object.is(actual,expected))throw assertionError(message||'値が一致しません。');return actual;},
    deepEqual(actual,expected,message){active();if(!equal(jsonClone(actual),jsonClone(expected)))throw assertionError(message||'JSON値が一致しません。');return actual;},
    match(value,pattern,message){active();if(!(pattern instanceof RegExp?new RegExp(pattern.source,pattern.flags):new RegExp(pattern,'u')).test(String(value)))throw assertionError(message||'パターンに一致しません。');return value;},
    schema(value,schema){const result=validate(value,schema);if(!result.valid){const error=assertionError(result.errors.map(item=>`${item.path||'/'}: ${item.message}`).join('\n'));error.errors=result.errors;throw error;}return value;},
    throws(fn,match){active();if(typeof fn!=='function')throw new TypeError('検証する関数を指定してください。');let result;try{result=fn();}catch(error){return matchError(error,match);}if(result?.then){Promise.resolve(result).catch(()=>{});throw new TypeError('非同期処理にはassert.rejectsを使用してください。');}throw assertionError('例外が発生しませんでした。');},
    async rejects(fn,match){active();if(typeof fn!=='function')throw new TypeError('検証する関数を指定してください。');try{await fn();}catch(error){active();return matchError(error,match);}throw assertionError('例外が発生しませんでした。');}
  };
  const keyFunction = key => typeof key==='function'?key:item=>json.get(item,key);
  const data = {
    range(start,end,step=1){active();if(end===undefined){end=start;start=0;}if(![start,end,step].every(Number.isFinite)||!step)throw new TypeError('範囲には有限の数値と0以外の増分を指定してください。');const length=Math.max(0,Math.ceil((end-start)/step));if(!Number.isSafeInteger(length))throw new RangeError('範囲が大きすぎます。');return Array.from({length},(_,i)=>start+i*step);},
    chunk(items,size){active();if(!Array.isArray(items)||!Number.isSafeInteger(size)||size<1)throw new TypeError('配列と正の整数を指定してください。');return Array.from({length:Math.ceil(items.length/size)},(_,index)=>items.slice(index*size,(index+1)*size));},
    uniqueBy(items,key=item=>item){active();const get=keyFunction(key),seen=new Set();return items.filter((item,index)=>{const value=get(item,index);if(seen.has(value))return false;seen.add(value);return true;});},
    groupBy(items,key){active();const get=keyFunction(key),groups=new Map();items.forEach((item,index)=>{const name=String(get(item,index));if(!groups.has(name))groups.set(name,[]);groups.get(name).push(item);});return Object.fromEntries(groups);},
    countBy(items,key){return Object.fromEntries(Object.entries(data.groupBy(items,key)).map(([key,items])=>[key,items.length]));},
    sortBy(items,key,{descending=false}={}){active();const get=keyFunction(key);return items.map((item,index)=>({item,key:get(item,index),index})).sort((a,b)=>((a.key<b.key?-1:a.key>b.key?1:0)*(descending?-1:1))||a.index-b.index).map(row=>row.item);}
  };
  const duration = (value,name) => {if(!Number.isFinite(value)||value<0)throw new RangeError(`${name}は非負の有限数で指定してください。`);return value;};
  const delay = milliseconds => {
    active();duration(milliseconds,'待機時間');return new Promise((resolve,reject)=>{let timer;const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(new DOMException('処理を停止しました。','AbortError'));};signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);try{active();resolve();}catch(error){reject(error);}},milliseconds);});
  };
  const pending = (value,timeoutMs=0) => {
    active();return new Promise((resolve,reject)=>{let done=false,timer;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(error)reject(error);else{try{active();resolve(value);}catch(error){reject(error);}}};const cancel=()=>finish(new DOMException('処理を停止しました。','AbortError'));signal?.addEventListener('abort',cancel,{once:true});if(timeoutMs>0)timer=setTimeout(()=>{const error=new Error('待機条件を満たす前に制限に達しました。');error.name='TimeoutError';finish(error);},timeoutMs);Promise.resolve(value).then(value=>finish(null,value),error=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(error);});});
  };
  const flow = {
    delay,
    async retry(fn,{attempts=3,delayMs=200,factor=2,maxDelayMs=30000,shouldRetry=()=>true}={}){active();if(typeof fn!=='function'||typeof shouldRetry!=='function')throw new TypeError('実行関数と再試行条件を指定してください。');if(!Number.isSafeInteger(attempts)||attempts<1||!Number.isFinite(factor)||factor<0)throw new RangeError('試行回数・待機倍率が不正です。');duration(delayMs,'待機時間');duration(maxDelayMs,'最大待機時間');for(let attempt=1;attempt<=attempts;attempt++){active();try{const result=await pending(fn(attempt));active();return result;}catch(error){active();if(error?.name==='AbortError'||attempt===attempts||!await pending(shouldRetry(error,attempt)))throw error;await delay(Math.min(maxDelayMs,delayMs===0?0:delayMs*Math.pow(factor,attempt-1)));}}},
    async poll(fn,{until=value=>Boolean(value),intervalMs=200,timeoutMs=10000,maxAttempts=0}={}){
      active();if(typeof fn!=='function'||typeof until!=='function')throw new TypeError('実行関数と終了条件を指定してください。');duration(intervalMs,'間隔');duration(timeoutMs,'制限時間');
      if(!Number.isSafeInteger(maxAttempts)||maxAttempts<0)throw new RangeError('最大試行回数が不正です。');const started=Date.now();let lastValue;
      const timedOut=()=>{const error=new Error('待機条件を満たす前に制限に達しました。');error.name='TimeoutError';error.lastValue=lastValue;throw error;};
      const remaining=()=>{const value=timeoutMs-(Date.now()-started);if(timeoutMs&&value<=0)timedOut();return timeoutMs?value:0;};
      for(let attempt=1;;attempt++){
        active();const budget=remaining();lastValue=await pending(fn(attempt),budget);active();const predicateBudget=remaining();
        if(await pending(until(lastValue,attempt),predicateBudget))return lastValue;
        if(maxAttempts&&attempt>=maxAttempts)timedOut();
        const waitBudget=remaining();await delay(timeoutMs?Math.min(intervalMs,waitBudget):intervalMs);
      }
    },
    async batch(items,fn,{concurrency=4,settle=false}={}){active();if(!Array.isArray(items)||!Number.isSafeInteger(concurrency)||concurrency<1)throw new RangeError('配列と正の並列数を指定してください。');if(typeof fn!=='function')throw new TypeError('処理関数を指定してください。');const results=new Array(items.length);let cursor=0,failure,failed=false;const workers=Array.from({length:Math.min(concurrency,items.length)},async()=>{while(!failed&&cursor<items.length){active();const index=cursor++;try{const value=await pending(fn(items[index],index));active();results[index]=settle?{status:'fulfilled',value}:value;}catch(error){if(signal?.aborted||error?.name==='AbortError')throw error;if(settle)results[index]={status:'rejected',reason:error};else{failed=true;failure=error;}}}});await Promise.all(workers);active();if(failed)throw failure;return results;}
  };
  return {url,query,headers,cookies,request,json,csv,encoding:{utf8:{encode:value=>{active();return bytes(value);},decode:(value,{fatal=true}={})=>{active();return decode(bytes(value),fatal);}},base64:{encode:base64Encode,decode:base64Decode},hex:{encode:hexEncode,decode:hexDecode},url:{encode:value=>{active();return encodeURIComponent(String(value));},decode:value=>{active();return decodeURIComponent(String(value));}}},crypto:cryptoAPI,assert,data,flow};
}
