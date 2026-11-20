import test from 'node:test';
import assert from 'node:assert/strict';
import {createScriptIntelligence} from '../static/script-intelligence.mjs';
import {buildLanguageProject} from '../static/script-language-model.mjs';
import {scriptEditorContext} from '../static/script-editor-context.mjs';
import {SCRIPT_API_SECTIONS,searchScriptAPI} from '../static/script-api-reference.mjs';
import ts from '../static/vendor-typescript.mjs';
import libraries from '../static/vendor-typescript-libs.mjs';

const service=createScriptIntelligence();
test.after(()=>service.dispose());
function analyze(marked,context={}) {
  const cursor=marked.indexOf('¦'),source=marked.replace('¦','');
  return service.analyze(source,cursor<0?source.length:cursor,{context,explicit:true});
}
const labels=(source,context)=>analyze(source,context).completion?.items.map(item=>item.label)||[];
function includes(source,expected,context){const found=labels(source,context);for(const label of expected)assert.ok(found.includes(label),`${label} missing from ${source}: ${found.join(', ')}`);}

test('tools namespaces, aliases and construction results use semantic member types',()=>{
  includes('tools.¦',['url','query','headers','cookies','request','json','jwt','csv','encoding','crypto','assert','data','flow']);
  includes('const {url}=minipost.tools; url.parse("https://example.test").¦',['href','path','query','hostname']);
  includes('tools.query.parse("a=1")[0].value.¦',['trim','toUpperCase']);
  includes('tools.headers.getAll("Set-Cookie: a=1","set-cookie").map(value=>value.¦)',['trim']);
  includes('tools.request.build({url:"https://example.test",json:{ready:true}}).header[0].¦',['key','value']);
  includes('tools.cookies.parseSetCookie("session=1; Secure").¦',['name','value','attributes']);
  includes('tools.cookies.parse("encoded=%20",{¦})',['decode']);
});

test('JSON Patch operations and JWT inspection have typed argument and result completion',()=>{
  includes('tools.json.¦',['patch']);
  includes('tools.json.patch({},[{op:"¦"}])',['add','remove','replace','move','copy','test']);
  includes('tools.jwt.decode("token").¦',['header','payload','signature','signingInput']);
  includes('const {jwt}=minipost.tools; jwt.decode("token").signature.¦',['trim','split']);
  includes('const decoded=tools.jwt.decode("token");if(typeof decoded.payload.exp==="number")decoded.payload.exp.¦',['toFixed']);
});

test('JSON path extraction and immutable changes retain precise nested value types',()=>{
  const input={rows:[{profile:{name:'A',score:2}}],'a/b':{'~key':['x']}};
  includes('tools.json.get(input,"rows[0].profile.name").¦',['trim'],{input});
  includes('tools.json.get(input,["rows",0,"profile","name"]).¦',['trim'],{input});
  includes('tools.json.get(input,"/a~1b/~0key/0").¦',['trim'],{input});
  includes('tools.json.select(input,"/rows/*/profile")[0].value.¦',['name','score'],{input});
  includes('tools.json.update(input,"rows[0].profile.score",score=>score.¦)',['toFixed'],{input});
  includes('tools.json.set({count:1},"/count","updated").count.¦',['trim']);
  includes('tools.json.set({count:1},"/profile",{name:"A"}).profile.¦',['name']);
  assert.ok(!labels('tools.json.remove({keep:1,remove:2},"/remove").¦').includes('remove'));
  includes('tools.json.merge({person:{count:1}},{person:{name:"A"}},{ready:true}).person.¦',['name','count']);
  includes('tools.json.merge({count:1},{count:"A"}).count.¦',['trim']);
  assert.ok(!labels('tools.json.pick({name:"A",hidden:1},["name"]).¦').includes('hidden'));
});

test('CSV, encoding, crypto and validation return the documented result types',()=>{
  includes('tools.csv.parse("id,name\\n1,A",{header:true})[0].name.¦',['trim']);
  includes('tools.csv.parse("1,A")[0].¦',['map','join']);
  includes('tools.encoding.base64.decode("YQ==").¦',['trim']);
  includes('tools.encoding.base64.decode("YQ==",{asBytes:true}).¦',['subarray','byteLength']);
  includes('tools.encoding.hex.decode("61",{asBytes:true})[0].¦',['toFixed']);
  includes('(await tools.crypto.hash("x")).¦',['trim']);
  includes('(await tools.crypto.hmac("k","v","SHA-256","bytes")).¦',['subarray']);
  includes('tools.json.validate({id:1},{type:"object"}).errors[0].¦',['path','keyword','message']);
});

test('generic asynchronous helpers infer callback inputs, await and settled results',()=>{
  includes('tools.flow.batch([{name:"A"}],item=>item.¦)',['name']);
  includes('(await tools.flow.batch([1,2],async n=>({score:n}))).map(row=>row.¦)',['score']);
  includes('const result=await tools.flow.batch([1],n=>({score:n}),{settle:true}); if(result[0].status==="fulfilled")result[0].value.¦',['score']);
  includes('(await tools.flow.retry(async attempt=>({count:attempt}))).count.¦',['toFixed']);
  includes('tools.flow.poll(()=>({ready:true}),{until:result=>result.¦})',['ready']);
  includes('tools.data.groupBy([{tag:"A",score:1}],row=>row.¦)',['tag','score']);
  includes('tools.data.sortBy([{score:1}],"score")[0].score.¦',['toFixed']);
});

test('workspace CRUD keys refresh and synchronous getters keep request shapes',()=>{
  const context={collections:[{id:'c1',name:'API'}],folders:[{id:'c1:f1',name:'Tests',path:'API / Tests',itemId:'f1'}],
    requests:[{id:'c1:r1',name:'Lookup',path:'API / Lookup',request:{method:'GET',url:'https://example.test',body:{mode:'raw',raw:'{}'}},settings:{}}],
    drafts:[{id:'draft:d1',draftId:'d1',name:'Scratch'}],relations:[{id:'rel1',name:'Smoke'}],scripts:[{id:'s1',name:'Helper',source:'return 1;',input:'null',inputFormat:'json'}]};
  includes('minipost.¦',['collections','folders','requests','drafts','environments','scripts','relations','ribbons','settings','history','responses','attachments','tools']);
  includes('minipost.collections.get("¦")',['c1','API'],context);
  includes('minipost.folders.move("¦")',['c1:f1','Tests','API / Tests','f1'],context);
  includes('minipost.requests.create({parent:"¦"})',['API','Tests'],context);
  includes('minipost.drafts.get("¦")',['draft:d1','Scratch','d1'],context);
  includes('minipost.relations.run("¦")',['rel1','Smoke'],context);
  includes('scripts.update("¦",{})',['s1','Helper'],context);
  includes('minipost.requests.get("Lookup").request.body.raw.¦',['trim'],context);
  includes('minipost.collections.variables("API").list()[0].¦',['key','value'],context);
  includes('minipost.requests.clone("Lookup").request.¦',['method','url','body'],context);
  includes('minipost.workspace.read().relations[0].steps[0].¦',['type','steps','elseSteps','condition']);
  includes('(await minipost.responses.get("Lookup")).response.¦',['status','headers','body'],context);
  includes('(await minipost.attachments.read("Lookup","body",0,{format:"bytes"}))[0].¦',['toFixed'],context);
  context.collections=[{id:'c2',name:'New'}];context.folders=[];context.drafts=[];context.relations=[];
  assert.deepEqual(labels('minipost.collections.get("¦")',context).sort(),['New','c2']);
  assert.deepEqual(labels('minipost.folders.get("¦")',context),[]);
  assert.deepEqual(labels('minipost.relations.get("¦")',context),[]);
  context.scripts.push({...context.scripts[0],id:'s2'});
  assert.ok(!labels('scripts.get("¦")',context).includes('Helper'));
  includes('scripts.get("¦")',['s1','s2'],context);
});

test('workspace editor snapshots collect only structural catalog metadata',()=>{
  const workspace={collections:[{_mpId:'c',info:{name:'API',description:'private-collection'},item:[{_mpId:'f',name:'Folder',item:[{_mpId:'r',name:'Saved',request:{method:'GET',url:'private-url'}}]}]}],
    tabs:[{id:'d',name:'Draft',request:{method:'POST',url:'private-draft'}}],environments:[],globals:[],scripts:[],relations:[{id:'flow',name:'Flow',steps:[],privateValue:'private-relation'}]};
  let context=scriptEditorContext(workspace,{rows:[]});
  assert.deepEqual(context.collections,[{id:'c',name:'API'}]);
  assert.equal(context.folders[0].path,'API / Folder');assert.equal(context.requests[0].parentId,'c:f');
  assert.equal(context.drafts[0].draftId,'d');assert.deepEqual(context.relations,[{id:'flow',name:'Flow'}]);
  assert.doesNotMatch(JSON.stringify(context),/private-/);
  workspace.collections=[];workspace.tabs=[];workspace.relations=[];context=scriptEditorContext(workspace,{rows:[]});
  for(const name of ['collections','folders','requests','drafts','relations'])assert.deepEqual(context[name],[]);
});

test('ribbon definition CRUD completes scoped references without leaking to another request',()=>{
  const context={ribbonScopeId:'scope',ribbons:[{id:'rib',key:'editor',name:'Editor',groups:[{id:'group',name:'Inputs',controls:[{id:'ctl',key:'count',label:'Count',type:'number',value:1}]}]}]};
  includes('minipost.ribbons.get("¦")',['rib','editor','Editor'],context);
  includes('minipost.ribbons.groups("editor").get("¦")',['group','Inputs'],context);
  includes('minipost.ribbons.controls("editor","group").get("¦")',['ctl','count'],context);
  context.ribbons.push({id:'second',key:'other',name:'Other',groups:[{id:'other-group',name:'Other group',controls:[{id:'other-ctl',key:'other-key',label:'Other',type:'text',value:''}]}]});
  assert.ok(!labels('minipost.ribbons.groups("editor").get("¦")',context).includes('other-group'));
  assert.ok(!labels('minipost.ribbons.controls("editor","group").get("¦")',context).includes('other-key'));
  includes('minipost.ribbons.controls("other","¦")',['other-group','Other group'],context);
  includes('minipost.ribbons.controls("other","other-group").get("¦")',['other-ctl','other-key'],context);
  assert.deepEqual(labels('minipost.ribbons.forRequest("other").get("¦")',context),[]);
  context.ribbonScopeId=null;assert.deepEqual(labels('minipost.ribbons.get("¦")',context),[]);
});

test('complete helper and CRUD usage typechecks against the isolated Worker libraries',()=>{
  const source=`const c=minipost.collections.create({name:'API'});
const f=minipost.folders.create({name:'Generated',parent:c.id});
const req=tools.request.build({url:'https://example.test',method:'POST',json:{name:'日本語'}});
const saved=minipost.requests.create({name:'Create',parent:f.id,request:req});
minipost.requests.update(saved.id,{request:{header:tools.headers.set(req.header,'X-Test','1')}});
const env=minipost.environments.create({name:'Testing',values:[{key:'base',value:'https://example.test'}]});
minipost.environments.variables(env.id).set('token','value',{enabled:true});
const rows=await tools.flow.batch([1,2],async n=>({id:n,name:String(n)}));
const csv=tools.csv.stringify(rows,{lineEnding:'\\n'});
const parsed=tools.csv.parse(csv,{header:true});
const name=tools.json.get(rows,'[0].name').toUpperCase();
const changes=tools.json.diff({value:1},{value:2});
const applied=tools.json.patch({value:1},changes);
tools.json.patch(applied,[{op:'copy',from:'/value',path:'/copied'},{op:'test',path:'/copied',value:2}]);
const decoded=tools.jwt.decode('eyJhbGciOiJub25lIn0.e30.');
if(typeof decoded.payload.exp==='number')decoded.payload.exp.toFixed(0);
tools.cookies.parseSetCookie('token=50%',{decode:false}).value.trim();
const merged=tools.json.merge({user:{id:1}},{user:{name:'A'}});
const modified=tools.json.set(merged,'/user/name','B');
modified.user.name.toUpperCase();
const selected=tools.json.select(rows,'/*/name');selected[0].value.trim();
const bytes=tools.encoding.base64.decode('YQ==',{asBytes:true});
const signature=await tools.crypto.hmac('key',bytes,'SHA-256','bytes');signature.subarray(0);
tools.assert.schema({name},{type:'object',required:['name'],properties:{name:{type:'string'}}});
return {csv,parsed,changes,modified};`;
  const project=buildLanguageProject(source),files={...Object.fromEntries(Object.entries(libraries).map(([name,text])=>['/'+name,text])),...project.files};
  const host={getSourceFile:(name,version)=>files[name]===undefined?undefined:ts.createSourceFile(name,files[name],version,true),getDefaultLibFileName:()=>'/lib.es2023.d.ts',
    writeFile(){},getCurrentDirectory:()=> '/',getDirectories:()=>[],getCanonicalFileName:name=>name,useCaseSensitiveFileNames:()=>true,getNewLine:()=> '\n',
    fileExists:name=>files[name]!==undefined,readFile:name=>files[name],directoryExists:name=>Object.keys(files).some(file=>file.startsWith(name.replace(/\/$/,'')+'/'))};
  const program=ts.createProgram(Object.keys(project.files),{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,
    allowJs:true,checkJs:true,noEmit:true,skipLibCheck:false,strictNullChecks:false,types:[],lib:['lib.es2023.d.ts','lib.webworker.d.ts']},host);
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(item=>ts.flattenDiagnosticMessageText(item.messageText,'\n')),[]);
});

test('reference search covers helper families and CRUD with combined terms and category filtering',()=>{
  assert.equal(new Set(SCRIPT_API_SECTIONS.map(section=>section.id)).size,SCRIPT_API_SECTIONS.length);
  assert.ok(searchScriptAPI('  HMAC SHA-256  ').flatMap(section=>section.entries).some(([name])=>name.includes('crypto.hmac')));
  assert.deepEqual(searchScriptAPI('hmac','json'),[]);
  assert.ok(searchScriptAPI('minipost.tools.crypto.hmac').length);
  assert.ok(searchScriptAPI('同期','workspace').length);
  assert.ok(searchScriptAPI('パス','json').flatMap(section=>section.entries).length>=1);
  assert.equal(searchScriptAPI('','crypto').length,1);
  assert.deepEqual(searchScriptAPI('no-such-api-xyz'),[]);
  for(const family of ['url','query','headers','cookies','request','json','jwt','csv','encoding','crypto','assert','data','flow'])assert.ok(searchScriptAPI(`tools.${family}`).length,family);
  assert.ok(searchScriptAPI('JSON Patch').flatMap(section=>section.entries).some(([name])=>name.includes('json.patch')));
  assert.ok(searchScriptAPI('tools.jwt.decode').flatMap(section=>section.entries).some(([,description])=>description.includes('署名')));
});
