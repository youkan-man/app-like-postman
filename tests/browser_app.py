"""Default: real HTTP browser. Inline mode: local DOM test with injected HTTP bridge.

MINIPOST_INLINE_TEST=1 never changes browser policy. It renders supplied HTML in
about:blank and replaces storage/transport for unit-style UI testing only.
"""
import asyncio
import base64
import json
import os
from pathlib import Path
import re
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]

class BrowserApp:
    def __init__(self, url, *, mock_bootstrap=None):
        self.url = url
        self.inline = mock_bootstrap is not None or os.environ.get('MINIPOST_INLINE_TEST') == '1'
        self.mock_bootstrap = mock_bootstrap
        self.local = {}
        self.session = {}
        self.bound = set()
        self.generation = 0

    def open(self, page):
        if not self.inline:
            page.goto(self.url, wait_until='domcontentloaded')
            return
        if id(page) not in self.bound:
            def http_call(path, method='GET', body=None):
                if self.url is None:
                    raise ValueError('Offline DOM fixture forbids HTTP')
                if path not in ['/api/health', '/api/request', '/api/workspace']:
                    raise ValueError('Unknown test API path: ' + path)
                data = body.encode() if isinstance(body, str) else None
                request = urllib.request.Request(self.url + path, data=data, method=method, headers={'Content-Type':'application/json'})
                try:
                    response = urllib.request.urlopen(request, timeout=30)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    return {'status':response.status, 'body':response.read().decode(), 'headers':dict(response.headers)}
            async def transport(path, method='GET', body=None):
                return await asyncio.to_thread(http_call,path,method,body)
            page.expose_function('__testHttp', transport)
            self.bound.add(id(page))
        page.goto('about:blank')
        self.generation += 1
        prefix=f'mp-{id(self)}-{self.generation}/'
        modules = {}
        for path in (ROOT/'static').glob('*'):
            if path.suffix not in ['.js','.mjs']:
                continue
            code = re.sub(r"(from\s+['\"])\./([^'\"]+)", lambda m:m[1]+prefix+m[2], path.read_text())
            code=f'// DOM fixture generation {self.generation}\n'+code
            code=code.replace('window.location.reload()', 'window.__testReloadRequested = true')
            modules[prefix+path.name] = 'data:text/javascript;base64,' + base64.b64encode(code.encode()).decode()
        html = (ROOT/'static/index.html').read_text()
        html = re.sub(r'<link rel="stylesheet" href="/([^"]+)">', lambda m:'<style>'+ (ROOT/'static'/m[1]).read_text()+'</style>', html)
        html = html.replace('<script type="module" src="/app.js"></script>', '')
        boot = r'''
const storage = initial => {
 const data = {...initial};
 return {getItem:k=>Object.hasOwn(data,k)?data[k]:null,setItem:(k,v)=>{data[k]=String(v)},removeItem:k=>delete data[k],clear:()=>{for(const k of Object.keys(data))delete data[k]},key:n=>Object.keys(data)[n]??null,get length(){return Object.keys(data).length},__data:data};
};
Object.defineProperty(window,'localStorage',{value:storage(LOCAL),configurable:true});
Object.defineProperty(window,'sessionStorage',{value:storage(SESSION),configurable:true});
window.fetch=async(path,options={})=>{
 if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
 const response=await new Promise((resolve,reject)=>{
   const abort=()=>reject(new DOMException('Aborted','AbortError'));
   options.signal?.addEventListener('abort',abort,{once:true});
   window.__testHttp(path,options.method||'GET',options.body||null).then(resolve,reject).finally(()=>options.signal?.removeEventListener('abort',abort));
 });
 if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
 return new Response(response.body,{status:response.status,headers:response.headers});
};
'''.replace('LOCAL', json.dumps(self.local)).replace('SESSION', json.dumps(self.session))
        if self.mock_bootstrap is not None:
            boot += '\n' + self.mock_bootstrap
        scripts = '<script>'+boot.replace('</script','<\\/script')+'</script><script type="importmap">'+json.dumps({'imports':modules})+'</script><script type="module">import "mp/app.js";</script>'
        scripts=scripts.replace('import \"mp/app.js\"', 'import '+json.dumps(prefix+'app.js'))
        html = html.replace('</body>',scripts+'</body>')
        page.set_content(html, wait_until='load')

    def reload(self, page):
        if not self.inline:
            page.reload(wait_until='domcontentloaded')
            return
        self.local = page.evaluate('({...localStorage.__data})')
        self.session = page.evaluate('({...sessionStorage.__data})')
        self.open(page)
