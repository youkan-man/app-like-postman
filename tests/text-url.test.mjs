import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {newRequest,setUrlText,setQuery,displayUrl,urlParts,normalizeRequest,compileRequest} from '../static/core.mjs';
const workspace = {collections:[],globals:[],environments:[],tabs:[]};
const compile = request => compileRequest(workspace,{request}).payload;

test('editor text is never URI encoded during edit, normalization or save reload',()=>{
  const input='http://localhost/日本 語?q=日本 語+plus&data={"a":1}';
  let request=newRequest();setUrlText(request,input);
  for(let i=0;i<5;i++){
    assert.equal(displayUrl(request.url),input);
    assert.equal(compile(request).url,'http://localhost/日本 語');
    assert.deepEqual(compile(request).query,[{key:'q',value:'日本 語+plus'},{key:'data',value:'{"a":1}'}]);
    request=normalizeRequest(JSON.parse(JSON.stringify(request)));
  }
});
test('plain params retain reserved characters, percent text, repeats, empty values and fragments',()=>{
  const request=newRequest();setUrlText(request,'http://localhost/日本#fragment');
  const values=[{key:'q',value:'a&b=+?#%2F 日本'},{key:'q',value:''}];
  setQuery(request,values);
  for(let i=0;i<4;i++){
    assert.equal(displayUrl(request.url),'http://localhost/日本?q=a&b=+?#%2F 日本&q=#fragment');
    assert.deepEqual(compile(request).query,values);
    request.url=normalizeRequest(request).url;
    setQuery(request,urlParts(request.url).query);
  }
});
test('legacy escaped URL becomes readable without treating decoded delimiters as structure',()=>{
  const request=normalizeRequest({url:'http://localhost/%E6%97%A5%E6%9C%AC?q=a%26b%2Bc&literal=%252F'});
  assert.equal(displayUrl(request.url),'http://localhost/日本?q=a&b+c&literal=%2F');
  assert.deepEqual(compile(request).query,[{key:'q',value:'a&b+c'},{key:'literal',value:'%2F'}]);
  assert.deepEqual(compile(normalizeRequest(JSON.parse(JSON.stringify(request)))) ,compile(request));
});
test('explicit percent-encoded entry stays as typed and decodes only once into query fields',()=>{
  const request=newRequest();setUrlText(request,'http://localhost/日本?q=a%20b%2Bc&x=%252F');
  assert.equal(displayUrl(request.url),'http://localhost/日本?q=a%20b%2Bc&x=%252F');
  assert.deepEqual(compile(request).query,[{key:'q',value:'a b+c'},{key:'x',value:'%2F'}]);
});
test('front compiler has no automatic URL or form encoders',()=>{
  const source=fs.readFileSync(new URL('../static/core.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/encodeURIComponent|encodeURI\(|new URL\(|new URLSearchParams/);
});
