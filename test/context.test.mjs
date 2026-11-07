import test from 'node:test';
import assert from 'node:assert/strict';
import {buildContext,sharedMachines} from '../src/context.mjs';
import {claudeUsage,codexUsage,codexExecUsage} from '../src/usage.mjs';

const run={id:'new',hostId:'host',profileId:'claude',queueId:'session:s',sessionId:'s',text:'New request',model:'one'};
const base=()=>({project:{path:process.cwd()},runs:[],artifacts:[],annotations:[]});
const prior=(overrides={})=>({...run,id:'old',status:'succeeded',nativeSessionId:'native',...overrides});
test('native resume sends only new message, across restart, model change and profile return',()=>{
  const state=base();state.runs.push(prior(),prior({profileId:'codex',nativeSessionId:'other'}));
  // JSON roundtrip reproduces persisted state loaded by a restarted service.
  const context=buildContext(JSON.parse(JSON.stringify(state)),{...run,model:'two'},'native','host');
  assert.equal(context.prompt,run.text);assert.equal(context.metadata.mode,'delta');
  for(const id of [undefined,'new-native'])assert.match(buildContext(state,run,id,'host').prompt,/history-index/);
  assert.match(buildContext(state,run,'native','other-host').prompt,/history-index/);
});
test('initialization without a completed turn cannot incorrectly suppress bootstrap',()=>{
  const state=base();state.runs.push(prior({status:'interrupted'}));
  assert.equal(buildContext(state,run,'native','host').metadata.mode,'bootstrap');
});
test('artifact evidence is incremental and never replays discussion or inline screenshot',()=>{
  const state=base(),request={...run,sessionId:undefined,artifactId:'a',annotationId:'c',queueId:'artifact:a'};
  state.artifacts.push({id:'a',name:'App',root:'app',entry:'index.html'});
  state.annotations.push({id:'c',artifactId:'a',text:'old comment',anchor:{selector:'#a',screenshot:'data:huge',screenshotPath:'image.png'}});
  state.messages=[{annotationId:'c',role:'user',text:'old history'}];
  const first=buildContext(state,request,undefined,'host');
  assert.match(first.prompt,/Artifact comment evidence/);assert.doesNotMatch(first.prompt,/data:huge|old history|old comment/);
  state.runs.push(prior({...request,id:'old',context:first.metadata}));
  const second=buildContext(state,request,'native','host');assert.equal(second.prompt,'New request\nComment: c');
  state.annotations[0].anchor.selector='#b';assert.match(buildContext(state,request,'native','host').prompt,/#b/);
});
test('usage keeps unknown counters absent and distinguishes session totals from turn counts',()=>{
  assert.equal(claudeUsage(),undefined);
  assert.deepEqual(claudeUsage({input_tokens:2,cache_read_input_tokens:80,cache_creation_input_tokens:18,output_tokens:7}).turn,{uncachedInputTokens:2,cachedInputTokens:80,cacheWriteInputTokens:18,outputTokens:7,inputTokens:100,totalTokens:107});
  const raw={total:{inputTokens:300,cachedInputTokens:180,outputTokens:20},last:{inputTokens:160,cachedInputTokens:100,outputTokens:10}};
  assert.equal(codexUsage(raw).turn,undefined);
  assert.deepEqual(codexUsage(raw,{inputTokens:140,cachedInputTokens:80,outputTokens:10}).turn,raw.last);
  assert.equal(codexUsage(raw,{inputTokens:999,cachedInputTokens:999,outputTokens:999}).turn,undefined);
  assert.deepEqual(codexExecUsage({input_tokens:300,cached_input_tokens:180,output_tokens:20},{inputTokens:140,cachedInputTokens:80,outputTokens:10}).turn,raw.last);
});

test('a project several machines may run lists each copy and its SSH address once, in the bootstrap turn',()=>{
  const machines=[{id:'host',name:'Desktop',local:true,online:true,projectRoot:'D:\\studiolo-projects',ssh:null},{id:'mini',name:'Mac mini',local:false,online:true,projectRoot:'/Users/me/studiolo-projects',ssh:{user:'me',host:'mini.ts.net'},sshKey:'C:/keys/mini'},{id:'mac',name:'MacBook',local:false,online:false,projectRoot:null,ssh:null}];
  const state=base();state.project={id:'p1',path:'D:\\studiolo-projects\\p1',ownerHostId:'host',allowedHostIds:['mini'],replicas:{host:{state:'ready'},mac:{state:'ready'}}};
  const text=sharedMachines(state.project,machines,'host');
  assert.match(text,/Desktop \(this machine\): D:\\studiolo-projects\\p1/);
  assert.match(text,/Mac mini \(online, may run this project\): \/Users\/me\/studiolo-projects\/p1 — reachable with ssh me@mini.ts.net -i C:\/keys\/mini/);
  assert.match(text,/MacBook \(offline now, holds a copy only\): project folder path unknown — not reachable over SSH/);
  const first=buildContext(state,{...run,attachments:['uploads/a.txt']},undefined,'host',null,machines);
  assert.match(first.prompt,/shared between machines: Desktop, Mac mini, MacBook/);assert.match(first.prompt,/uploaded to another machine's copy/);
  state.runs.push(prior({context:first.metadata}));
  assert.doesNotMatch(buildContext(state,run,'native','host',null,machines).prompt,/shared between machines/);
  // One machine, or no machine list: nothing is said.
  assert.equal(sharedMachines({id:'p1',ownerHostId:'host',allowedHostIds:[],replicas:{}},machines,'host'),null);
  assert.doesNotMatch(buildContext(state,run,undefined,'host').prompt,/shared between machines|another machine's copy/);
});
