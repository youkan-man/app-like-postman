/** Explicit JavaScript execution in an opaque-origin, network-denied worker. */
const workerSource = `
self.onmessage = async ({data}) => {
  const logs=[], writes={primary:[],environment:[],globals:[]};
  const text=v=>v===undefined?'':typeof v==='object'?JSON.stringify(v):String(v);
  const maps={primary:new Map(Object.entries(data.primary||{})),environment:new Map(Object.entries(data.environment||{})),globals:new Map(Object.entries(data.globals||{}))};
  const merged=new Map(Object.entries(data.variables||{}));
  const api=kind=>({
    get:key=>maps[kind].has(String(key))?maps[kind].get(String(key)):kind==='primary'?merged.get(String(key)):undefined,
    has:key=>maps[kind].has(String(key))||(kind==='primary'&&merged.has(String(key))),
    set:(key,value)=>{key=String(key);value=text(value);maps[kind].set(key,value);if(kind==='primary')merged.set(key,value);writes[kind].push({key,value});},
    unset:key=>{key=String(key);maps[kind].delete(key);if(kind==='primary')merged.delete(key);writes[kind].push({key,remove:true});},
    toObject:()=>Object.fromEntries(kind==='primary'?new Map([...merged,...maps[kind]]):maps[kind])
  });
  const log=(level,...args)=>{if(logs.length<200)logs.push({level,message:args.map(v=>{try{return text(v)}catch{return String(v)}}).join(' ')});};
  const response=data.response;
  const pm={variables:api('primary'),environment:api('environment'),globals:api('globals'),request:data.request,
    response:response?{code:response.status,status:response.statusText,responseTime:response.elapsed_ms,responseSize:response.size,
      headers:{get:name=>{const v=response.headers[String(name).toLowerCase()];return Array.isArray(v)?v[0]:v;},all:()=>response.headers},
      json:()=>{if(data.raw?.body_encoding==='base64')throw Error('バイナリ応答はJSONとして読めません');return JSON.parse(data.raw?.body||'');},text:()=>data.raw?.body||''}:null,
    test:(name,fn)=>{try{fn();log('test','PASS '+name);}catch(error){log('test','FAIL '+name+': '+String(error?.message||error));throw error;}},\n    expect:(actual)=>({to:{equal:expected=>{if(!Object.is(actual,expected))throw Error('Expected '+text(actual)+' to equal '+text(expected));},eql:expected=>{if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Expected deep equality');},include:expected=>{if(!String(actual).includes(String(expected)))throw Error('Expected value to include '+text(expected));}}})};
  try {
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
    await new AsyncFunction('pm','vars','response','request','console','"use strict";\\n'+data.source)(pm,pm.variables,response,data.request,{log:(...a)=>log('log',...a),warn:(...a)=>log('warn',...a),error:(...a)=>log('error',...a)});
    self.postMessage({ok:true,writes,logs});
  } catch(error) {self.postMessage({ok:false,error:String(error.message||error),logs});}
};`;
const bridgeSource = `
let active=null,channel=null;
addEventListener('message',event=>{
 if(event.source!==parent)return;
 if(event.data?.abort){active?.terminate();active=null;return;}
 if(active)return;
 channel=event.data.channel;
 const url=URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}],{type:'text/javascript'}));
 try {
  active=new Worker(url);URL.revokeObjectURL(url);
  active.onmessage=event=>{parent.postMessage({channel,result:event.data},'*');active.terminate();active=null;};
  active.onerror=event=>{parent.postMessage({channel,result:{ok:false,error:event.message}},'*');active?.terminate();active=null;};
  active.postMessage(event.data.payload);
 } catch(error){parent.postMessage({channel,result:{ok:false,error:String(error.message)}},'*');}
});
parent.postMessage({ready:true},'*');`;
export function runScript(source, context = {}, {signal,timeoutMs=5000} = {}) {
  if(!source.trim()) return Promise.resolve({writes:{primary:[],environment:[],globals:[]},logs:[]});
  if(signal?.aborted) return Promise.reject(new DOMException('スクリプトを停止しました。','AbortError'));
  return new Promise((resolve,reject)=>{
    const frame=document.createElement('iframe'),channel=Array.from(crypto.getRandomValues(new Uint8Array(16)),value=>value.toString(16).padStart(2,'0')).join('');
    frame.className='script-sandbox';frame.hidden=true;frame.title='スクリプト実行';frame.setAttribute('sandbox','allow-scripts');
    let settled=false,timer;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);window.removeEventListener('message',receive);signal?.removeEventListener('abort',abort);frame.contentWindow?.postMessage({channel,abort:true},'*');frame.remove();error?reject(error):resolve(value);};
    const abort=()=>finish(new DOMException('スクリプトを停止しました。','AbortError'));
    const receive=event=>{
      if(event.source!==frame.contentWindow)return;
      if(event.data?.ready){frame.contentWindow.postMessage({channel,payload:{...context,source}},'*');return;}
      if(event.data?.channel!==channel)return;
      const result=event.data.result;
      if(!result?.ok){const error=new Error(result?.error||'スクリプトを実行できません。');error.logs=result?.logs||[];finish(error);}
      else if(!result.writes || !['primary','environment','globals'].every(k=>Array.isArray(result.writes[k]))) finish(new Error('スクリプトの結果形式が不正です。'));
      else finish(null,result);
    };
    window.addEventListener('message',receive);signal?.addEventListener('abort',abort,{once:true});
    if(timeoutMs>0) timer=setTimeout(()=>finish(new Error(`スクリプトが${timeoutMs} msの制限時間を超えました。`)),timeoutMs);
    frame.srcdoc=`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; connect-src 'none';"><script>${bridgeSource.replace(/<\/script/gi,'<\\/script')}<\/script>`;
    document.body.append(frame);
  });
}
