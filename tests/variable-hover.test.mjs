import test from 'node:test';
import assert from 'node:assert/strict';
import {contextFor, resolver} from '../static/core.mjs';
import {variableTokens, variableAtCaret, variablePreview} from '../static/variable-hover.mjs';

function fixture() {
  const request = {method:'GET',url:{raw:'https://{{host}}/v1',variable:[{key:'same',value:'path'}]}};
  const item = {_mpId:'item',name:'Request',request};
  const folder = {_mpId:'folder',name:'Folder',variable:[{key:'same',value:'folder'}],item:[item]};
  const collection = {_mpId:'collection',info:{name:'API'},variable:[{key:'same',value:'collection'}],item:[folder]};
  return {workspace:{collections:[collection],globals:[{key:'same',value:'global'},{key:'host',value:'api.example.test'}],environments:[{id:'env',name:'Dev',values:[{key:'same',value:'environment'},{key:'nested',value:'https://{{host}}/{{same}}'}]}],environmentId:'env'},tab:{collectionId:'collection',itemId:'item',request},folder};
}

test('token offsets identify each occurrence including whitespace and unicode', () => {
  const source = '/{{ first }}/{{日本語}}/{{ first }}';
  assert.deepEqual(variableTokens(source), [
    {key:'first',start:1,end:12,text:'{{ first }}'},
    {key:'日本語',start:13,end:20,text:'{{日本語}}'},
    {key:'first',start:21,end:32,text:'{{ first }}'}
  ]);
  assert.equal(variableAtCaret(source,15).key,'日本語');
  assert.equal(variableAtCaret(source,0),null);
  assert.equal(variableAtCaret(source,2,30),null);
});

test('preview follows effective precedence including disabled duplicate fallbacks', () => {
  const {workspace,tab} = fixture();
  let primary = [{key:'same',value:'primary'},{key:'same',value:'disabled',enabled:false}];
  assert.equal(variablePreview(workspace,tab,'same',primary).value,'primary');
  assert.equal(variablePreview(workspace,tab,'same',primary).scope,'一次変数');
  assert.equal(variablePreview(workspace,tab,'same').value,'path');
  tab.request.url.variable[0].disabled=true;
  assert.equal(variablePreview(workspace,tab,'same').value,'environment');
  assert.equal(variablePreview(workspace,tab,'same').scope,'環境: Dev');
  workspace.environmentId='';
  assert.equal(variablePreview(workspace,tab,'same').value,'folder');
  assert.equal(variablePreview(workspace,tab,'same').scope,'フォルダー: Folder');
});

test('nested templates use exactly the compiler resolver and refresh with state', () => {
  const {workspace,tab} = fixture();
  const expected = resolver(contextFor(workspace,tab).vars)('{{nested}}');
  assert.equal(variablePreview(workspace,tab,'nested').value,expected);
  assert.equal(expected,'https://api.example.test/path');
  workspace.globals[1].value='new.example.test';
  assert.equal(variablePreview(workspace,tab,'nested').value,'https://new.example.test/path');
});

test('empty values differ from missing or disabled-only variables', () => {
  const {workspace,tab} = fixture();
  workspace.globals.push({key:'empty',value:''},{key:'disabled',value:'hidden',disabled:true});
  assert.deepEqual(variablePreview(workspace,tab,'empty'),{key:'empty',scope:'Globals',state:'empty',value:'',message:'空文字',dynamic:false});
  assert.equal(variablePreview(workspace,tab,'disabled').state,'missing');
  assert.equal(variablePreview(workspace,tab,'missing').message,'未設定');
});

test('cycles and missing nested variables display compiler errors without throwing', () => {
  const {workspace,tab} = fixture();
  workspace.globals.push({key:'cycle',value:'{{cycle}}'},{key:'nestedMissing',value:'{{absent}}'});
  assert.match(variablePreview(workspace,tab,'cycle').message,/変数が循環/);
  assert.equal(variablePreview(workspace,tab,'cycle').state,'error');
  assert.match(variablePreview(workspace,tab,'nestedMissing').message,/absent/);
});

test('dynamic previews are marked even through nesting, but explicit overrides are fixed', () => {
  const {workspace,tab} = fixture();
  workspace.globals.push({key:'generated',value:'id-{{$guid}}'});
  assert.equal(variablePreview(workspace,tab,'generated',[],{$guid:'sample-id'}).value,'id-sample-id');
  assert.equal(variablePreview(workspace,tab,'generated').dynamic,true);
  assert.equal(variablePreview(workspace,tab,'$guid').scope,'動的変数');
  workspace.globals.push({key:'$guid',value:'chosen-id'});
  assert.equal(variablePreview(workspace,tab,'generated').dynamic,false);
  assert.equal(variablePreview(workspace,tab,'$guid').value,'chosen-id');
});

test('secret and HTML-like values remain exact strings', () => {
  const {workspace,tab} = fixture();
  const value = '<img src=x onerror="bad()">\nsecret: abc';
  workspace.globals.push({key:'token',value,type:'secret'});
  assert.equal(variablePreview(workspace,tab,'token').value,value);
});

test('long multiline values remain complete for inspection and copying', () => {
  const {workspace,tab} = fixture();
  const value = '  leading spaces\n'+('https://example.test/'+('very-long-value/'.repeat(40))+'\n').repeat(30)+'\t最後の行  ';
  workspace.globals.push({key:'longValue',value});
  assert.equal(variablePreview(workspace,tab,'longValue').value,value);
  assert.equal(variablePreview(workspace,tab,'longValue').state,'resolved');
});

test('prototype-like names use only actual configured values', () => {
  const {workspace,tab} = fixture();
  assert.equal(variablePreview(workspace,tab,'constructor').state,'missing');
  workspace.globals.push({key:'__proto__',value:'configured'});
  assert.equal(variablePreview(workspace,tab,'__proto__').value,'configured');
});
