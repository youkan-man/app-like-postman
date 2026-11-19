import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLanguageProject} from '../static/script-language-model.mjs';
import {createScriptIntelligence} from '../static/script-intelligence.mjs';
import ts from '../static/vendor-typescript.mjs';
import libraries from '../static/vendor-typescript-libs.mjs';

const script = (id,name,source,input='null',extra={}) => ({id,name,source,input,inputFormat:'json',...extra});
const model = project => project.files['/minipost/model.d.ts'];
function callerDictionary(text,suffix) {
  const group=text.match(new RegExp(`export type Results_${suffix} = (ResultsGroup_\\d+);`))?.[1];
  const start=text.indexOf(`export type ${group} =`);
  return text.slice(start,text.indexOf('\n\n',start));
}

test('virtual wrapper keeps user source and UTF-16 offsets intact without executing it', () => {
  const source = 'globalThis.__mustNeverExecute = true;\nconst request = {emoji:"🛰️"};\nreturn await Promise.resolve(request); // unfinished';
  const project = buildLanguageProject(source);
  assert.equal(project.files[project.fileName].slice(project.offset,project.offset+project.sourceLength),source);
  assert.equal(project.sourceLength,source.length);
  assert.match(project.files[project.fileName].slice(0,project.offset),/export async function __run\(pm, vars, response, request, console, input, scripts, store, minipost, ribbon\) \{\n\{\n$/);
  assert.equal(globalThis.__mustNeverExecute,undefined);
});

test('input and store types describe nested data but do not embed values in declarations', () => {
  const project = buildLanguageProject('return input;', {
    input:{people:[{name:'private person',score:71},{name:'other private person',score:2}],enabled:true},
    data:{token:'secret-credential-value',profile:{email:'private-address',roles:['admin']}}
  });
  const text = model(project);
  assert.match(text, /"people": Array<\{ "name": string; "score": number \}>/);
  assert.match(text, /"roles": Array<string>/);
  assert.match(text, /"enabled": boolean/);
  assert.doesNotMatch(text,/private person|secret-credential-value|private-address/);
  assert.equal(text,model(buildLanguageProject('return input;', {
    input:{people:[{name:'changed',score:100}],enabled:false},
    data:{token:'new secret',profile:{email:'changed',roles:['reader']}}
  })));
});

test('raw input is parsed inside the model and invalid JSON stays unknown', () => {
  assert.match(model(buildLanguageProject('',{inputSource:'{"jobs":[{"done":true}]}',inputFormat:'json'})),/Input_active = \{ "jobs": Array<\{ "done": boolean \}> \}/);
  assert.match(model(buildLanguageProject('',{inputSource:'not JSON',inputFormat:'text'})),/Input_active = string/);
  assert.match(model(buildLanguageProject('',{inputSource:'{unfinished',inputFormat:'json'})),/Input_active = unknown/);
});

test('before and after hooks derive input from request and raw response metadata in the worker model', () => {
  const request = {method:'POST',url:'https://private.example',body:{mode:'raw',raw:'private payload'}};
  const rawResponse = {status:201,status_text:'Created',headers:[{key:'X-Trace',value:'private trace'}],body:'{"account":{"id":17,"name":"private name"}}',elapsed_ms:5,size:12};
  const before = model(buildLanguageProject('',{phase:'before',request,rawResponse}));
  const after = model(buildLanguageProject('',{phase:'after',request,rawResponse}));
  assert.match(before,/Input_active = \{ "body": \{ "mode": string; "raw": string \}; "method": string; "url": string \}/);
  assert.match(after,/Input_active = \{ "body": \{ "account": \{ "id": number; "name": string \} \}/);
  assert.match(after,/"x-trace": string/);
  assert.doesNotMatch(before+after,/private payload|private trace|private name|https:\/\/private.example/);
});

test('live variable and data dictionaries are regenerated after add, delete or rename', () => {
  const first = buildLanguageProject('', {variables:{base:'secret'},primary:{session:'secret'},environment:{endpoint:'secret'},globals:{shared:'secret'},data:{cached:{count:3}}});
  assert.match(model(first), /PrimaryVariables = Variables<"base" \| "session">/);
  assert.match(model(first), /EnvironmentVariables = Variables<"endpoint">/);
  assert.match(model(first), /GlobalVariables = Variables<"shared">/);
  assert.match(model(first), /StoreData = \{ "cached": \{ "count": number \} \}/);
  const next = model(buildLanguageProject('', {primary:{renamed:'secret'},data:{updated:[1,2]}}));
  assert.match(next,/PrimaryVariables = Variables<"renamed">/);
  assert.match(next,/StoreData = \{ "updated": Array<number> \}/);
  assert.doesNotMatch(next,/"session"|"cached"|"endpoint"/);
});

test('saved script references include IDs and unique names with inferred return links', () => {
  const scripts = [script('alpha','Convert','return {value:input.value};','{"value":1}'),script('beta','Other','return "result";')];
  const project = buildLanguageProject('const result = await scripts.run("Convert", input); return result;', {scriptId:'alpha',input:{value:2},scripts});
  assert.equal(project.fileName,'/minipost/scripts/0.js');
  assert.equal(Object.keys(project.files).length,3);
  assert.match(model(project), /"Convert": Awaited<ReturnType<typeof import\("\.\/scripts\/0\.js"\).__run>>/);
  assert.match(model(project), /"beta": Awaited<ReturnType<typeof import\("\.\/scripts\/1\.js"\).__run>>/);
  assert.match(model(project), /Input_0 = \{ "value": number \}/);
  assert.ok(project.files['/minipost/scripts/1.js'].includes('return "result";'));
});

test('ambiguous script names are excluded and imported callers retain their own aliases', () => {
  const scripts = [script('old','Helper','return "old";'),script('copy','Helper','return {copied:true};'),script('parent','Caller','return scripts.run("Helper");','null',{bindingId:'copy-group'})];
  const project = buildLanguageProject('return scripts.run("Helper");',{scriptId:'parent',scripts,bindings:{'copy-group':{old:'copy',Helper:'copy',Deleted:'missing'}}});
  const text = model(project), active = callerDictionary(text,'2');
  assert.match(active, /"old": Awaited<ReturnType<typeof import\("\.\/scripts\/1\.js"\).__run>>/);
  assert.match(active, /"Helper": Awaited<ReturnType<typeof import\("\.\/scripts\/1\.js"\).__run>>/);
  assert.doesNotMatch(active, /"Deleted"/);
  const plain = callerDictionary(text,'0');
  assert.doesNotMatch(plain,/"Helper"/);
});

test('inline binding is not inherited by a saved child and removed scripts leave no stale files', () => {
  const scripts = [script('one','One','return 1;'),script('two','Two','return 2;')];
  const project = buildLanguageProject('',{scripts,bindingId:'inline',bindings:{inline:{one:'two'}}});
  const text = model(project), active = callerDictionary(text,'active');
  assert.match(active,/"one": Awaited<ReturnType<typeof import\("\.\/scripts\/1\.js"\).__run>>/);
  const child = callerDictionary(text,'0');
  assert.match(child,/"one": Awaited<ReturnType<typeof import\("\.\/scripts\/0\.js"\).__run>>/);
  const next = buildLanguageProject('',{scripts:[scripts[0]]});
  assert.equal(next.files['/minipost/scripts/1.js'],undefined);
  assert.doesNotMatch(model(next),/"two"|"Two"/);
});

test('request and environment dictionaries follow runtime alias ambiguity and exact IDs', () => {
  const requests = [
    {id:'collection:a',name:'Duplicate',path:'First / Duplicate',itemId:'a',request:{method:'GET',url:'https://private.test'},settings:{}},
    {id:'collection:b',name:'Duplicate',path:'Second / Duplicate',itemId:'b',request:{method:'POST',url:'https://private.test'},settings:{}}
  ];
  const project = buildLanguageProject('',{requests,environments:[{id:'env-a',name:'Development',values:[]}]});
  const text = model(project), lookup = text.slice(text.indexOf('export type RequestLookup ='),text.indexOf('export type EnvironmentId ='));
  assert.match(lookup, /"collection:a": Request_0/);
  assert.match(lookup, /"First \/ Duplicate": Request_0/);
  assert.match(lookup, /"a": Request_0/);
  assert.doesNotMatch(lookup, /"Duplicate":/);
  assert.match(text,/"Development": Environment_0/);
  assert.doesNotMatch(text,/https:\/\/private.test/);
});

test('response body and headers provide current shapes without credential values', () => {
  const text = model(buildLanguageProject('',{response:{body:{users:[{id:1,label:'private name'}]},headers:{'content-type':'application/json','set-cookie':['credential=value']}}}));
  assert.match(text,/ResponseBody = \{ "users": Array<\{ "id": number; "label": string \}> \}/);
  assert.match(text,/"set-cookie": Array<string>/);
  assert.doesNotMatch(text,/private name|credential=value/);
});

test('cyclic data, accessors and very large inputs cannot execute code or grow declarations without bound', () => {
  let called = false;
  const input = {next:null}; input.next=input;
  Object.defineProperty(input,'getter',{enumerable:true,get(){called=true;throw new Error('must not run');}});
  const project = buildLanguageProject('',{input,data:{many:Array.from({length:20000},()=>({x:1}))}});
  assert.equal(called,false);
  assert.equal(project.shapeTruncated,true);
  assert.ok(model(project).length<50000);
  assert.match(model(buildLanguageProject('',{input})),/"getter": unknown; "next": unknown/);
});

test('unusual dictionary keys are quoted as data and cannot inject declarations', () => {
  const key='x"; declare const injected: any; //';
  const data=JSON.parse('{"__proto__":{"safe":true}}');data[key]=1;
  const project = buildLanguageProject('',{data,variables:{[key]:'value'}});
  assert.ok(model(project).includes(JSON.stringify(key)));
  assert.ok(model(project).includes('"__proto__": { "safe": boolean }'));
});

test('script callers share catalog type dictionaries instead of multiplying the complete catalog', () => {
  const scripts=Array.from({length:250},(_,at)=>script(`id-${at}`,`Name ${at}`,'return {value:1};'));
  const project=buildLanguageProject('return input;', {scriptId:'id-200',input:{active:true},scripts});
  const text=model(project);
  assert.equal((text.match(/export type ResultsGroup_/g)||[]).length,1);
  assert.ok(text.length<150000,text.length);
  assert.match(text,/Input_200 = \{ "active": boolean \}/);
});

const intelligence = createScriptIntelligence();
const completions = (source,context) => intelligence.analyze(source,source.length,{context,explicit:true}).completion?.items || [];
const labels = (source,context) => completions(source,context).map(item=>item.label);
test.after(()=>intelligence.dispose());

test('language service updates nested input and store member types without stale dictionary entries', () => {
  const source = 'const {account} = input; account.';
  assert.deepEqual(labels(source,{inputSource:'{"account":{"name":"A","age":2}}',inputFormat:'json'}),['age','name']);
  assert.deepEqual(labels(source,{inputSource:'{"account":{"active":true}}',inputFormat:'json'}),['active']);
  assert.deepEqual(labels('store.get("cache").',{data:{cache:{count:1,rows:[]}}}),['count','rows']);
  assert.deepEqual(labels('store.get("cache").',{data:{other:1}}),[]);
});

test('language service offers current keys through aliased and destructured variable APIs', () => {
  const context = {variables:{collectionToken:'secret'},primary:{sessionToken:'secret'},environment:{baseUrl:'secret'},globals:{shared:'secret'}};
  assert.deepEqual(labels('const scope=vars; scope.get("',context),['collectionToken','sessionToken']);
  assert.deepEqual(labels('const {get}=minipost.environment; get("',context),['baseUrl']);
  assert.deepEqual(labels('pm.globals.get("',context),['shared']);
  assert.deepEqual(labels('pm.globals.get("',{globals:{renamed:'secret'}}),['renamed']);
});

test('saved script return inference tracks source changes and caller-specific import bindings', () => {
  const scripts = [script('helper','Transform','return {original:input.value};','{"value":1}'),
    script('copy','Transform','return {copied:input.value};','{"value":1}'),
    script('caller','Caller','','null',{bindingId:'import'})];
  const source = 'const result=await scripts.run("Transform", {value:2}); result.';
  const context = {scriptId:'caller',scripts,bindings:{import:{Transform:'copy'}}};
  assert.deepEqual(labels(source,context),['copied']);
  scripts[1].source='return {updated:input.value, nested:{name:"changed"}};';
  assert.deepEqual(labels(source,context),['nested','updated']);
  assert.ok(labels('const result=await scripts.run("Transform", {value:2}); result.nested.name.',context).includes('toUpperCase'));
  context.bindings.import.Transform='missing';
  assert.deepEqual(labels(source,context),[]);
});

test('known script return types survive explicit inputs that differ from the saved input sample', () => {
  const scripts = [script('helper','Helper','return {ready:true, details:{message:"done"}};')];
  for (const api of ['scripts','minipost.scripts']) {
    for (const input of ['{value:1}','"runtime input"']) {
      const source = `const result = await ${api}.run("Helper", ${input}); result.`;
      assert.deepEqual(labels(source,{scripts}),['details','ready']);
    }
    scripts[0].input='{"configured":1}';
    assert.ok(labels(`const result = await ${api}.run("helper", [1,2]); result.details.message.`,{scripts}).includes('toUpperCase'));
    assert.deepEqual(labels(`const result = await ${api}.run("missing", {value:1}); result.`,{scripts}),[]);
    scripts[0].input='null';
  }
});

test('request, environment and saved-script string arguments are supplied by the live workspace', () => {
  const context = {requests:[{id:'collection:request',name:'Lookup',path:'API / Lookup',itemId:'request',request:{method:'GET',url:'https://private.example',body:{mode:'raw',raw:'body'}}}],
    environments:[{id:'development',name:'Development',values:[]}],scripts:[script('helper','Calculate','return 1;')]};
  assert.ok(labels('minipost.requests.get("',context).includes('API / Lookup'));
  assert.ok(labels('minipost.environments.get("',context).includes('Development'));
  assert.ok(labels('scripts.run("',context).includes('Calculate'));
  assert.ok(labels('const entry=await minipost.requests.get("Lookup"); entry.request.body.raw.',context).includes('trim'));
  context.requests=[];context.environments=[];context.scripts=[];
  assert.deepEqual(labels('minipost.requests.get("',context),[]);
  assert.deepEqual(labels('minipost.environments.get("',context),[]);
  assert.deepEqual(labels('scripts.run("',context),[]);
});

test('response parsing provides chained property and method inference in after hooks', () => {
  const context = {phase:'after',rawResponse:{status:200,headers:[{key:'Content-Type',value:'application/json'}],body:'{"people":[{"name":"private","score":4}]}'}};
  assert.deepEqual(labels('input.body.people.map(person=>person.',context),['name','score']);
  assert.ok(labels('const people=pm.response.json().people; people[0].name.',context).includes('toLowerCase'));
  assert.deepEqual(labels('pm.response.headers.get("',context),['content-type']);
});

test('response editing methods, aliases and header names retain received-body inference', () => {
  const context={phase:'after',rawResponse:{status:200,headers:[{key:'Content-Type',value:'application/json'},{key:'X-Trace',value:'private'}],
    body:'{"users":[{"name":"Ada","active":true}]}'}};
  for (const prefix of ['response.','minipost.response.']) {
    const names=labels(prefix,context);
    for (const method of ['setBody','getHeader','setHeader','removeHeader','text','json','show']) assert.ok(names.includes(method),prefix+method);
  }
  assert.deepEqual(labels('response.body.users[0].',context),['active','name']);
  assert.deepEqual(labels('minipost.response.json().users[0].',context),['active','name']);
  for (const method of ['getHeader','setHeader','removeHeader']) assert.deepEqual(labels(`response.${method}("`,context),['content-type','x-trace']);
  assert.deepEqual(labels('response.show("',context),['cookies','headers','pretty','preview','raw']);
  assert.deepEqual(labels('const changed=response.setBody({converted:[{ready:true}]}); changed.converted[0].',context),['ready']);
  assert.ok(labels('response.text().',context).includes('trim'));
});

test('before hooks expose response methods without suggesting stale received content', () => {
  const context={phase:'before',request:{method:'GET',url:'https://example.invalid'},
    rawResponse:{status:200,body:'{"previousResult":true}',headers:[{key:'X-Previous',value:'old'}]}};
  assert.ok(labels('response.',context).includes('setBody'));
  assert.ok(labels('minipost.response.',context).includes('show'));
  assert.deepEqual(labels('response.body.',context),[]);
  assert.deepEqual(labels('response.json().',context),[]);
  assert.deepEqual(labels('response.getHeader("',context),[]);
  const project=buildLanguageProject('',context);
  assert.match(project.files[project.fileName],/CurrentResponse \| null/);
  assert.doesNotMatch(model(project),/previousResult|X-Previous/);
});

test('response and request replacements accept valid new shapes without freezing the sampled data type', () => {
  const source=`
response.body = {converted:true};
response.body = 'plain text';
response.headers = {'x-replaced':['a','b']};
const updated = minipost.response.setBody({items:[{count:1}]}, 'application/json');
updated.items[0].count.toFixed(2);
request.url = {raw:'https://new.invalid', query:[{key:'q',value:'next'}]};
request.body = {mode:'formdata',formdata:[{key:'field',value:'new'}]};
request.header = [{key:'X-New',value:'true',enabled:true}];
request.auth = {type:'bearer',bearer:[{key:'token',value:'new'}]};
minipost.request.url = 'https://other.invalid';
`;
  const context={request:{method:'POST',url:'https://old.invalid',body:{mode:'raw',raw:'{}'},header:[],auth:{type:'noauth'}},
    rawResponse:{status:200,body:'{"original":1}',headers:[{key:'Content-Type',value:'application/json'}]}};
  const project=buildLanguageProject(source,context);
  const files={...Object.fromEntries(Object.entries(libraries).map(([name,text])=>['/'+name,text])),...project.files};
  const host={
    getSourceFile:(name,version)=>files[name]===undefined?undefined:ts.createSourceFile(name,files[name],version,true),
    getDefaultLibFileName:()=>'/lib.es2023.d.ts',writeFile(){},getCurrentDirectory:()=> '/',getDirectories:()=>[],
    getCanonicalFileName:name=>name,useCaseSensitiveFileNames:()=>true,getNewLine:()=> '\n',
    fileExists:name=>files[name]!==undefined,readFile:name=>files[name],
    directoryExists:name=>Object.keys(files).some(file=>file.startsWith(name.replace(/\/$/,'')+'/'))
  };
  const program=ts.createProgram(Object.keys(project.files),{
    target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,
    allowJs:true,checkJs:true,noEmit:true,skipLibCheck:false,strictNullChecks:false,types:[],lib:['lib.es2023.d.ts','lib.webworker.d.ts']
  },host);
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(item=>ts.flattenDiagnosticMessageText(item.messageText,'\n')),[]);
  assert.ok(labels('request.url.',context).includes('startsWith'));
  assert.ok(labels('minipost.request.body.raw.',context).includes('trim'));
});

test('pm.response.json only provides return members when the received body can be decoded as JSON', () => {
  const plain={rawResponse:{status:200,headers:[],body:'plain response text'}};
  assert.deepEqual(labels('pm.response.json().',plain),[]);
  assert.ok(labels('response.body.',plain).includes('trim'));
  assert.match(model(buildLanguageProject('',plain)),/ResponseJSON = never;/);

  const binary={rawResponse:{status:200,headers:[],body:'eyJmb28iOjF9',body_encoding:'base64'}};
  assert.deepEqual(labels('pm.response.json().',binary),[]);
  assert.ok(labels('response.body.',binary).includes('trim'));
  assert.match(model(buildLanguageProject('',binary)),/ResponseJSON = never;/);

  const jsonString={rawResponse:{status:200,headers:[],body:'"a valid JSON string"'}};
  assert.ok(labels('pm.response.json().',jsonString).includes('trim'));
  assert.match(model(buildLanguageProject('',jsonString)),/ResponseJSON = string;/);
  assert.match(model(buildLanguageProject('',{})),/ResponseJSON = unknown;/);
  assert.match(model(buildLanguageProject('',{response:{body:'metadata without raw text'}})),/ResponseJSON = unknown;/);
});
