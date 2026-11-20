import test from 'node:test';
import assert from 'node:assert/strict';
import {createScriptIntelligence} from '../static/script-intelligence.mjs';
import {buildLanguageProject} from '../static/script-language-model.mjs';
import {scriptEditorContext} from '../static/script-editor-context.mjs';
import {searchScriptAPI} from '../static/script-api-reference.mjs';
import {createRequestEditor} from '../static/script-request.mjs';
import {createWorkspaceModel} from '../static/workspace-api.mjs';
import ts from '../static/vendor-typescript.mjs';
import libraries from '../static/vendor-typescript-libs.mjs';

const service=createScriptIntelligence();
test.after(()=>service.dispose());
function analyze(marked,context={}){
  const position=marked.indexOf('¦'),source=marked.replace('¦','');
  return service.analyze(source,position<0?source.length:position,{context,explicit:true});
}
const labels=(source,context)=>analyze(source,context).completion?.items.map(item=>item.label)||[];
function includes(source,expected,context){
  const actual=labels(source,context);
  for(const item of expected)assert.ok(actual.includes(item),`${item} missing from ${source}: ${actual.join(', ')}`);
}
function diagnostics(source,context){
  const project=buildLanguageProject(source,context),files={...Object.fromEntries(Object.entries(libraries).map(([name,text])=>['/'+name,text])),...project.files};
  const host={getSourceFile:(name,version)=>files[name]===undefined?undefined:ts.createSourceFile(name,files[name],version,true),
    getDefaultLibFileName:()=>'/lib.es2023.d.ts',writeFile(){},getCurrentDirectory:()=> '/',getDirectories:()=>[],
    getCanonicalFileName:name=>name,useCaseSensitiveFileNames:()=>true,getNewLine:()=> '\n',fileExists:name=>files[name]!==undefined,
    readFile:name=>files[name],directoryExists:name=>Object.keys(files).some(file=>file.startsWith(name.replace(/\/$/,'')+'/'))};
  const program=ts.createProgram(Object.keys(project.files),{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,
    allowJs:true,checkJs:true,noEmit:true,skipLibCheck:false,strictNullChecks:false,types:[],lib:['lib.es2023.d.ts','lib.webworker.d.ts']},host);
  return ts.getPreEmitDiagnostics(program).map(item=>ts.flattenDiagnosticMessageText(item.messageText,'\n'));
}
function fixture(){
  const request={method:'POST',url:{raw:'https://private.example/users?token=private-query',query:[{key:'token',value:'private-query'}]},
    header:[{key:'Authorization',value:'private-credential'}],body:{mode:'raw',raw:'{"user":{"name":"private-person","score":12},"rows":[{"active":true}],"literal.key":{"value":"private-text"}}'}};
  const tab={id:'draft1',name:'Scratch',request:structuredClone(request),settings:{},ribbonState:{id:'scope',activeRibbonId:'main',ribbonBindings:{},ribbons:[
    {id:'main',key:'search',name:'Search',groups:[{id:'inputs',name:'Inputs',controls:[
      {id:'count',key:'count',label:'Count',type:'number',value:1,actions:[]},
      {id:'result',key:'result',label:'Result',type:'display',value:{count:1},actions:[]}
    ]}]}
  ]}};
  const workspace={collections:[{_mpId:'c',info:{name:'API'},item:[{_mpId:'f',name:'Folder',item:[{_mpId:'r',name:'Create',request,settings:{timeout_ms:1000}}]}]}],
    tabs:[tab],environments:[{id:'env',name:'Testing',values:[]}],globals:[],relations:[{id:'rel',name:'Flow'}],
    scripts:[{id:'helper',name:'Helper',source:'return 1;',input:'null',inputFormat:'json'}]};
  return {workspace,tab,context:scriptEditorContext(workspace,{rows:[]},{tab})};
}

test('editable entities complete symmetric get/set, references and typed paths',()=>{
  const {context}=fixture();
  for(const family of ['collections','folders','requests','drafts','environments','scripts','relations','ribbons'])
    includes(`minipost.${family}.¦`,['get','set'],context);
  includes('minipost.requests.set("¦",{})',['Create','c:r'],context);
  includes('minipost.drafts.edit("¦")',['Scratch','draft:draft1'],context);
  includes('minipost.requests.get("Create","¦")',['request','settings','name'],context);
  for(const path of ['"request.body.raw"','"/request/body/raw"','["request","body","raw"]'])
    includes(`minipost.requests.get("Create",${path}).¦`,['trim'],context);
  includes('minipost.requests.set("Create","name","Renamed").¦',['trim'],context);
  includes('scripts.get("Helper","source").¦',['trim'],context);
  includes('minipost.settings.get("¦")',['theme','editorSettings','settings'],context);
  includes('minipost.settings.get("settings.timeout_ms").¦',['toFixed'],context);
  includes('minipost.settings.set("settings.timeout_ms",1500).¦',['toFixed'],context);
  includes('minipost.ribbons.groups("search").¦',['get','set'],context);
  includes('minipost.ribbons.controls("search","inputs").¦',['get','set'],context);
  assert.ok(!labels('minipost.requests.get("Create").¦',context).includes('requestJSON'));
});

test('current aliases and saved editors expose usable URL, pair and parsed JSON types',()=>{
  const {context}=fixture();
  for(const target of ['request','pm.request','minipost.request','minipost.requests.edit("Create")','minipost.drafts.edit("Scratch")']){
    includes(`${target}.¦`,['get','set','headers','query','form','json'],context);
    includes(`${target}.get("url").¦`,['trim','startsWith'],context);
    includes(`${target}.headers.get("Authorization").¦`,['trim'],context);
    includes(`${target}.query.getAll("tag")[0].¦`,['trim'],context);
    includes(`${target}.json.get("user").¦`,['name','score'],context);
    includes(`${target}.json.get(["literal.key","value"]).¦`,['trim'],context);
  }
  includes('request.¦',['method','url','body','header'],context);
  const saved=labels('minipost.requests.edit("Create").¦',context);
  assert.ok(!saved.includes('method')&&!saved.includes('url'),'saved editor exposes methods, not disconnected raw properties');
  includes('request.set("url",{raw:"https://updated.example"}).¦',['trim'],context);
  includes('request.json.set("user.name",{converted:true}).¦',['converted'],context);
  includes('request.json.set({changed:[{count:1}]}).changed[0].¦',['count'],context);
  assert.match(analyze('const url=request.get("url"); url¦',context).quickInfo.text,/url: string/);
  assert.match(analyze('const target=minipost.requests.edit("Create"); target.headers.se¦t("x",1)',context).quickInfo.text,/PairScalar/);
});

test('ribbon fields complete and preserve normalized or newly written value types',()=>{
  const {context}=fixture();
  includes('ribbon.get("count","¦")',['value','visible','enabled'],context);
  includes('ribbon.set("count","¦",true)',['value','visible','enabled'],context);
  includes('ribbon.get("count","value").¦',['toFixed'],context);
  includes('ribbon.set("count","value","2").¦',['toFixed'],context);
  includes('ribbon.set("result","value",{changed:true}).¦',['changed'],context);
  assert.match(analyze('const shown=ribbon.get("count","visible"); shown¦',context).quickInfo.text,/shown: boolean/);
  assert.match(analyze('const active=ribbon.set("count","enabled",false); active¦',context).quickInfo.text,/active: boolean/);
});

test('typical snapshots and live/saved request edits typecheck without freezing previous shapes',()=>{
  const {context}=fixture();
  const source=`const saved=minipost.requests.get('Create');
saved.request.method='PATCH';
saved.request.url='https://next.example/users';
saved.request.body={mode:'urlencoded',urlencoded:[{key:'name',value:'Ada'}]};
minipost.requests.set('Create',saved);
minipost.requests.set('Create','request.url',{raw:'https://next.example',query:[]});
minipost.requests.set('Create',['request','body'],{mode:'raw',raw:'{}'});
const target=minipost.requests.edit('Create');
const token='Bearer sample';
target.headers.set('Authorization',token);
target.query.set('page',2);
target.query.set('tag',['a',2,true,null]);
target.form.set('enabled',true);
target.json.set('user.name','Ada');
target.json.set('user.score',{changed:true}).changed.valueOf();
target.json.get('/rows/0/active').valueOf();
target.set(target.get());
minipost.drafts.edit('Scratch').json.set({ready:true});
request.set('method','PUT');
request.set('url',{raw:'https://next.example'}).trim();
request.set(request.get());
pm.request.query.delete('token');
minipost.request.json.delete('user.score');
const settings=minipost.settings.get();settings.theme='light';minipost.settings.set(settings);
minipost.settings.set('settings.timeout_ms',1500).toFixed();
scripts.set('Helper','source','return true;');
minipost.collections.set('API',minipost.collections.get('API'));
minipost.folders.set('Folder',minipost.folders.get('Folder'));
minipost.environments.set('Testing',minipost.environments.get('Testing'));
minipost.relations.set('Flow',minipost.relations.get('Flow'));
minipost.ribbons.set('search',minipost.ribbons.get('search'));
minipost.ribbons.groups('search').set('Inputs',minipost.ribbons.groups('search').get('Inputs'));
minipost.ribbons.controls('search','Inputs').set('count','value',3);
ribbon.set('count','visible',ribbon.get('count','visible'));
ribbon.set('count','enabled',false);
ribbon.set('count','value','3').toFixed();
response.body={converted:true};`;
  assert.deepEqual(diagnostics(source,context),[]);
  const errors=diagnostics(`request.headers.set('X', {invalid:true});
ribbon.set('count','visible','yes');
minipost.requests.edit('Create').method='PUT';`,context);
  assert.equal(errors.length,3,errors.join('\n'));
});

test('request setter return types reflect normalized URL snapshots and entity path readback',()=>{
  const {workspace,context}=fixture(),current={method:'GET',url:'https://old.test',header:[]};
  const editor=createRequestEditor({read:()=>current,change:callback=>callback(current)});
  const model=createWorkspaceModel({...workspace,relations:[],scripts:[]}),saved=model.api.requests.edit('Create');
  for(const [index,target] of [editor,saved].entries()){
    for(const [at,path] of [undefined,'','$',[]].entries()){
      const url=`https://new.test/${index}/${at}`,snapshot={method:'POST',url,header:[],body:{mode:'raw',raw:'{}'}};
      const returned=path===undefined?target.set(snapshot):target.set(path,snapshot);
      assert.equal(typeof returned.url,'object');
      assert.deepEqual(returned.url,target.get().url);
      assert.equal(target.get('url'),url);
      assert.equal(returned.body.raw,'{}');
    }
    assert.equal(target.set('url',`https://new.test/field/${index}`),`https://new.test/field/${index}`);
  }
  for(const [at,path] of ['request.url','/request/url',['request','url']].entries()){
    const returned=model.api.requests.set('Create',path,`https://new.test/entity/${at}`);
    assert.equal(typeof returned,'object');
    assert.deepEqual(returned,model.api.requests.get('Create',path));
  }
  const snapshot="{method:'POST',url:'https://new.test',header:[],body:{mode:'raw',raw:'{}'}}";
  const calls=[`request.set(${snapshot})`,...['""','"$"','[]'].map(path=>`request.set(${path},${snapshot})`),
    `minipost.requests.edit('Create').set(${snapshot})`];
  const bad=calls.map((call,index)=>`const root${index}=${call};root${index}.url.toUpperCase();`);
  for(const [index,path] of ['"request.url"','"/request/url"','["request","url"]'].entries())
    bad.push(`const field${index}=minipost.requests.set('Create',${path},'https://new.test');field${index}.toUpperCase();`);
  const errors=diagnostics(bad.join('\n'),context);
  assert.equal(errors.length,bad.length,errors.join('\n'));
  assert.ok(errors.every(message=>message.includes("Property 'toUpperCase' does not exist")),errors.join('\n'));
  assert.deepEqual(diagnostics(`
const returned=request.set(${snapshot});returned.body.raw.trim();
if(typeof returned.url==='string')returned.url.trim();else returned.url.raw.trim();
request.set('url','https://new.test').toUpperCase();
minipost.requests.edit('Create').set('url','https://new.test').toUpperCase();
const field=minipost.requests.set('Create','request.url','https://new.test');
if(typeof field==='string')field.trim();else field.raw.trim();`,context),[]);
});

test('request JSON snapshots stay sanitized, bounded and refresh for current and saved edits',()=>{
  const {workspace,tab,context}=fixture();
  assert.deepEqual(context.requestJSON.user,{name:'',score:0});
  assert.doesNotMatch(JSON.stringify(context),/private-person|private-credential|private-query|private-text/);
  const declarations=buildLanguageProject('',context).files['/minipost/model.d.ts'];
  assert.doesNotMatch(declarations,/private-person|private-credential|private-query|private-text/);
  const saved=workspace.collections[0].item[0].item[0];
  saved.request.body.raw='{"renamed":{"id":17}}';
  tab.request.body.raw='{"current":{"ready":true}}';
  let next=scriptEditorContext(workspace,{rows:[]},{tab});
  assert.deepEqual(labels('request.json.get().¦',next),['current']);
  assert.deepEqual(labels('minipost.requests.edit("Create").json.get().¦',next),['renamed']);
  tab.request.body.raw='{"incomplete":';
  next=scriptEditorContext(workspace,{rows:[]},{tab});
  assert.ok(!Object.hasOwn(next,'requestJSON'));
  assert.deepEqual(labels('request.json.get().¦',next),[]);
  for(const raw of [JSON.stringify({large:'x'.repeat(1024*1024)}),JSON.stringify(Array.from({length:16001},()=>1))]){
    tab.request.body.raw=raw;
    next=scriptEditorContext(workspace,{rows:[]},{tab});
    assert.ok(!Object.hasOwn(next,'requestJSON'));
  }
  tab.request.body={mode:'urlencoded',urlencoded:[]};
  assert.equal(scriptEditorContext(workspace,{rows:[]},{tab}).requestJSON,undefined);
});

test('reference search leads to matching get/set and practical saved request editing',()=>{
  const entries=search=>searchScriptAPI(search).flatMap(section=>section.entries);
  for(const search of ['request.get','request.headers.set','request.query.set','request.json.set','minipost.requests.edit','minipost.settings.set','ribbon.set'])
    assert.ok(entries(search).length,search);
  assert.ok(entries('minipost.requests.edit').some(([,description])=>description.includes('target.query.set("page", 2)')));
  assert.ok(entries('response.body').some(([name])=>name==='response.body / response.body = value'));
  assert.ok(!entries('response.body').some(([name])=>name==='response.body / setBody(value, contentType?)'));
});
