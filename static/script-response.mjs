/** Validate script effects before committing them to a request or response. */
import {responseMetadata} from './runtime.mjs';
import {validScriptData} from './scripts.mjs';
import {urlParts,splitUrl} from './core.mjs';

const own=(value,key)=>Object.hasOwn(value,key);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const headerName=/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const invalidHeaderValue=/[\u0000-\u0008\u000a-\u001f\u007f]/;
const views=new Set(['pretty','raw','headers','cookies','preview']);

function equal(left,right){
  if(Object.is(left,right))return true;
  if(!left||!right||typeof left!=='object'||typeof right!=='object'||Array.isArray(left)!==Array.isArray(right))return false;
  const keys=Object.keys(left);
  return keys.length===Object.keys(right).length&&keys.every(key=>own(right,key)&&equal(left[key],right[key]));
}

function headers(value){
  if(!record(value))throw new TypeError('レスポンスヘッダーは名前と値のオブジェクトで指定してください。');
  const result=Object.create(null);
  for(const [name,input] of Object.entries(value)){
    if(!headerName.test(name))throw new TypeError(`レスポンスヘッダー名が不正です: ${name}`);
    const values=Array.isArray(input)?input:[input];
    if(!values.length||values.some(item=>typeof item!=='string'||invalidHeaderValue.test(item)))throw new TypeError(`レスポンスヘッダー値が不正です: ${name}`);
    const key=name.toLowerCase();
    result[key]=[...(result[key]||[]),...values];
  }
  return result;
}

function byteLength(body,encoding){
  if(encoding!=='base64')return new TextEncoder().encode(body).byteLength;
  if(typeof body!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body))
    throw new TypeError('バイナリ本文は正しいBase64文字列で指定してください。');
  return body.length/4*3-(body.endsWith('==')?2:body.endsWith('=')?1:0);
}

/** Preserve wire evidence and exact untouched bytes; only editable fields change. */
export function applyResponseMutation(original,metadata){
  if(!record(original)||original.error)throw new Error('変更するレスポンスがありません。');
  if(!record(metadata))throw new TypeError('レスポンスの変更にはオブジェクトを指定してください。');
  const base=responseMetadata(original);
  if(!Number.isInteger(metadata.status)||metadata.status<100||metadata.status>599)throw new TypeError('レスポンスのステータスは100～599の整数で指定してください。');
  if(typeof metadata.statusText!=='string'||invalidHeaderValue.test(metadata.statusText))throw new TypeError('レスポンスのステータス文字列が不正です。');
  if(typeof metadata.content_type!=='string'||invalidHeaderValue.test(metadata.content_type))throw new TypeError('レスポンスのContent-Typeが不正です。');
  if(!['text','base64'].includes(metadata.body_encoding))throw new TypeError('レスポンスのbody_encodingはtextまたはbase64で指定してください。');
  if(!own(metadata,'body')||!validScriptData({body:metadata.body}))throw new TypeError('レスポンス本文には文字列またはJSONの値を指定してください。');
  if(own(metadata,'view')&&!views.has(metadata.view))throw new TypeError('レスポンスの表示形式が不正です。');
  const nextHeaders=headers(metadata.headers),baseHeaders=headers(base.headers);
  let bodyChanged=metadata.body_replaced===true||!equal(metadata.body,base.body)||metadata.body_encoding!==base.body_encoding;
  let body=original.body,encoding=metadata.body_encoding,size=original.size,contentType=metadata.content_type;
  const explicitType=contentType!==base.content_type;
  const headerTypeChanged=!equal(nextHeaders['content-type'],baseHeaders['content-type']);
  if(!explicitType&&headerTypeChanged)contentType=nextHeaders['content-type']?.[0]||'';
  if(bodyChanged){
    if(encoding==='base64'){
      if(typeof metadata.body!=='string')throw new TypeError('バイナリ本文はBase64文字列で指定してください。');
      body=metadata.body;
    }else body=typeof metadata.body==='string'?metadata.body:JSON.stringify(metadata.body);
    const bytes=byteLength(body,encoding);
    bodyChanged=body!==(original.body??'')||encoding!==base.body_encoding;
    if(bodyChanged)size=bytes;
    if(!explicitType&&!headerTypeChanged){
      if(encoding==='base64')contentType=contentType||'application/octet-stream';
      else if(typeof metadata.body!=='string'&&!/(?:^|[+/])json(?:\s*;|$)/i.test(contentType))contentType='application/json';
      else contentType=contentType||'text/plain; charset=utf-8';
    }
    if(bodyChanged&&own(nextHeaders,'content-length'))nextHeaders['content-length']=[String(size)];
    if(bodyChanged&&equal(nextHeaders['content-encoding'],baseHeaders['content-encoding']))delete nextHeaders['content-encoding'];
  }
  if(contentType!==base.content_type||explicitType){
    if(contentType)nextHeaders['content-type']=[contentType];else delete nextHeaders['content-type'];
  }
  const headersChanged=!equal(nextHeaders,baseHeaders);
  const changed=bodyChanged||headersChanged||metadata.status!==base.status||metadata.statusText!==base.statusText||contentType!==base.content_type;
  // An explicit show() is a new presentation request even when it repeats the
  // last requested view: the user may have selected another view in between.
  // Give it a fresh result identity so rendering applies this request once.
  const presentsView=own(metadata,'view');
  if(!changed&&!presentsView)return original;
  const result={...original};
  if(changed){
    result.status=metadata.status;result.status_text=metadata.statusText;
    result.body=body;result.body_encoding=encoding;result.size=size;result.content_type=contentType;
    if(headersChanged)result.headers=Object.entries(nextHeaders).flatMap(([key,values])=>values.map(value=>({key,value})));
    if(bodyChanged)delete result.body_base64;
    if(!result.original_response){
      result.original_response=structuredClone(original);
      delete result.original_response.response_view;
    }
  }
  if(own(metadata,'view'))result.response_view=metadata.view;
  return result;
}

export function restoreOriginalResponse(response){
  if(!record(response))return response;
  if(!response.original_response&&!own(response,'response_view'))return response;
  const result={...(response.original_response||response)};
  delete result.original_response;delete result.response_view;
  return result;
}

function reconcileURL(previous,incoming){
  const old=record(previous)?previous:{},url=structuredClone(incoming);
  for(const key of ['raw','base','protocol','port','hash'])if(own(url,key)&&typeof url[key]!=='string')throw new TypeError(`リクエストURLの${key}は文字列で指定してください。`);
  for(const key of ['host','path'])if(own(url,key)&&typeof url[key]!=='string'&&(!Array.isArray(url[key])||url[key].some(value=>typeof value!=='string')))throw new TypeError(`リクエストURLの${key}が不正です。`);
  for(const key of ['query','variable'])if(own(url,key)&&(!Array.isArray(url[key])||url[key].some(row=>!record(row)||typeof row.key!=='string'||typeof row.value!=='string')))throw new TypeError(`リクエストURLの${key}は名前と値の配列で指定してください。`);
  const rawChanged=own(url,'raw')&&url.raw!==(record(previous)?old.raw:previous);
  const components=['protocol','host','port','path'].filter(key=>!equal(url[key],old[key]));
  let parts=rawChanged?splitUrl(url.raw):!own(url,'raw')?urlParts(url):urlParts(previous);
  let base=!rawChanged&&url.base!==old.base&&typeof url.base==='string'?url.base:parts.base;
  if(components.length&&own(url,'raw')){
    // Work on the effective raw address, not stale Postman host/path caches.
    // Unchanged components retain their current spelling, including templates.
    const match=String(base||'').match(/^(?:([A-Za-z][A-Za-z\d+.-]*):\/\/)?([^/?#]*)([\s\S]*)$/);
    let protocol=match?.[1]||'',authority=match?.[2]||'',path=match?.[3]||'';
    const at=authority.lastIndexOf('@'),user=at>=0?authority.slice(0,at+1):'';
    let host=authority.slice(at+1),port='';
    const address=host.match(/^(\[[^\]]*\]|[^:]*)(?::(.*))?$/);
    if(address){host=address[1];port=address[2]||'';}
    if(components.includes('protocol'))protocol=url.protocol||'';
    if(components.includes('host'))host=Array.isArray(url.host)?url.host.join('.'):url.host||'';
    if(components.includes('port'))port=url.port||'';
    if(components.includes('path')){const value=Array.isArray(url.path)?url.path.join('/'):url.path||'';path=value?'/'+value.replace(/^\//,''):'';}
    base=(protocol?protocol+'://':'')+user+host+(port?':'+port:'')+path;
  }
  const query=own(url,'query')&&!equal(url.query,old.query)?url.query:parts.query;
  let hash=parts.hash||'';
  if(url.hash!==old.hash&&typeof url.hash==='string')hash=url.hash?url.hash.startsWith('#')?url.hash:'#'+url.hash:'';
  // raw and base/query must agree: compileRequest deliberately trusts the
  // cached parts used by the request editor, so changing raw alone is not enough.
  const queryText=query.filter(row=>row.disabled!==true&&row.enabled!==false&&row.key).map(row=>`${row.key}=${row.value}`).join('&');
  return {...url,base,hash,query,variable:url.variable??old.variable??[],
    raw:own(url,'raw')&&!components.length&&base===parts.base&&equal(query,parts.query)&&hash===(parts.hash||'')?url.raw:base+(queryText?'?'+queryText:'')+hash,
    _mpTextParts:true,_mpTypedUrl:true};
}

/** Request edits operate on the send snapshot, never on a saved request by alias. */
export function applyRequestMutation(original,changed){
  if(!record(original)||!record(changed)||!validScriptData({request:changed}))throw new TypeError('リクエストの変更にはJSONオブジェクトを指定してください。');
  if(typeof changed.method!=='string'||!headerName.test(changed.method))throw new TypeError('リクエストのメソッドが不正です。');
  if(typeof changed.url!=='string'&&!record(changed.url))throw new TypeError('リクエストのURLが不正です。');
  if(changed.header!==undefined&&(!Array.isArray(changed.header)||changed.header.some(row=>!record(row)||typeof row.key!=='string'||typeof row.value!=='string')))
    throw new TypeError('リクエストのヘッダーは名前と値の配列で指定してください。');
  if(changed.body!==undefined&&(!record(changed.body)||(changed.body.mode!==undefined&&!['none','raw','urlencoded','formdata','file','graphql'].includes(changed.body.mode))))
    throw new TypeError('リクエスト本文の形式が不正です。');
  if(changed.body?.mode==='raw'&&changed.body.raw!==undefined&&typeof changed.body.raw!=='string')throw new TypeError('リクエストのraw本文は文字列で指定してください。');
  if(equal(original,changed))return original;
  const result=structuredClone(changed);
  if(record(result.url)&&!equal(original.url,result.url))result.url=reconcileURL(original.url,result.url);
  return result;
}
