// Shared subagent knowledge: routing rules saved beside the projects, the prompt section built
// per machine, its injection into bootstrap and changed turns, the settings API and the launcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SubagentPolicy,SubagentKnowledge,DEFAULT_RULES,quotaText,knowledgeText} from '../src/subagents.mjs';
import {buildContext} from '../src/context.mjs';
import {createStudio} from '../src/server.mjs';

const run=promisify(execFile);
const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const launcher=path.resolve(here,'../scripts/subagent.mjs');
async function tempDir(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-subagents-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

const accounts=[
  {id:'acc_main',label:'Main Claude',family:'claude',auth:'oauth',status:'signed_in',available:true,identity:{email:'a@example.com',plan:'Claude Max'},models:[{id:'claude-opus-5-5'},{id:'claude-fable-5-1'},{id:'claude-haiku-4-5-20251001'}]},
  {id:'acc_team',label:'Team Claude',family:'claude',auth:'oauth',status:'signed_in',available:true,identity:{email:'a@example.com',plan:'Claude Team'},models:[{id:'claude-opus-5-5'},{id:'claude-sonnet-5-5'}]},
  {id:'acc_codex',label:'Work Codex',family:'codex',auth:'chatgpt',status:'signed_in',available:true,identity:{email:'a@example.com',plan:'pro'},models:[{id:'gpt-6.1-sol'}]},
  {id:'acc_out',label:'Old',family:'claude',auth:'oauth',status:'signed_out',available:false,identity:null,models:[]},
];
const usage=(teamLeft=61)=>({checkedAt:'2026-10-23T09:21:00.000Z',accounts:[
  {id:'acc_main',status:'ok',auth:'oauth',family:'claude',updatedAt:'2026-10-23T09:21:00.000Z',windows:[{id:'five_hour',remainingPercent:88,resetsAt:'2026-10-23T14:00:00.000Z'},{id:'seven_day',remainingPercent:40,resetsAt:'2026-10-27T09:00:00.000Z'}],summary:null},
  {id:'acc_team',status:'stale',auth:'oauth',family:'claude',updatedAt:'2026-10-23T08:00:00.000Z',windows:[{id:'five_hour',remainingPercent:teamLeft,resetsAt:null}],summary:null},
  {id:'acc_codex',status:'ok',auth:'chatgpt',family:'codex',updatedAt:'2026-10-23T09:21:00.000Z',windows:[{id:'codex_primary',kind:'five_hour',bucket:'codex',remainingPercent:95},{id:'codex_secondary',kind:'seven_day',bucket:'codex',remainingPercent:70},{id:'other_primary',kind:'five_hour',bucket:'other',remainingPercent:1}],summary:{bucket:'codex',remainingPercent:70,label:'codex'}},
]});

test('policy: defaults without a file, validated edits, default text stored as absent',async t=>{
  const file=path.join(await tempDir(t),'settings','.studio-settings.json');
  const policy=new SubagentPolicy({file});
  const initial=await policy.get();
  assert.equal(initial.enabled,true);assert.equal(initial.rules,DEFAULT_RULES);assert.equal(initial.custom,false);
  await assert.rejects(policy.set({enabled:'yes'}),e=>e.status===400);
  await assert.rejects(policy.set({rules:'x'.repeat(4001)}),e=>e.status===400);
  await assert.rejects(policy.set({rules:'bad\u0007char'}),e=>e.status===400);
  const custom=await policy.set({rules:'- Always use the team account.\r\n- Never Main Claude.',enabled:false},'Workstation');
  assert.equal(custom.rules,'- Always use the team account.\n- Never Main Claude.');assert.equal(custom.enabled,false);assert.equal(custom.custom,true);assert.equal(custom.updatedBy,'Workstation');
  // Another server (or a restart) reads the synchronized file and sees the same thing.
  const again=await new SubagentPolicy({file}).get();assert.equal(again.rules,custom.rules);assert.equal(again.enabled,false);
  const reset=await policy.set({rules:DEFAULT_RULES+'\n',enabled:true});
  assert.equal(reset.custom,false);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).subagents.rules,undefined);
  // A corrupt file falls back to defaults and reports the problem instead of blocking runs.
  await fs.writeFile(file,'{');const broken=await new SubagentPolicy({file}).get();assert.equal(broken.rules,DEFAULT_RULES);assert.ok(broken.error);
});

test('knowledge: accounts, quota wording, rules; hash ignores quota; disabled or empty gives nothing',async t=>{
  const file=path.join(await tempDir(t),'.studio-settings.json');
  const policy=new SubagentPolicy({file});
  let cache=usage(),refreshes=0;const now=Date.parse('2026-10-23T09:21:30.000Z');
  const accountUsage={ttlMs:60000,peek:()=>cache,get:async()=>{refreshes++;return cache;}};
  const knowledge=new SubagentKnowledge({runner:{profiles:async()=>accounts},accountUsage,policy,helperPath:'D:\\Studio\\scripts\\subagent.mjs',now:()=>now});
  const first=await knowledge.describe();
  assert.match(first.text,/node "D:\\Studio\\scripts\\subagent\.mjs" --account/);
  assert.match(first.text,/- Main Claude · acc_main · Claude Code · Claude Max · 5h 88% left, resets 10-23 \d\d:\d\d · 7d 40% left, resets 10-27 \d\d:\d\d \(as of 10-23 \d\d:\d\d\) · models: claude-opus-5-5, claude-fable-5-1, claude-haiku-4-5-20251001/);
  assert.match(first.text,/- Team Claude · acc_team · Claude Code · Claude Team · 5h 61% left \(as of 10-23 \d\d:\d\d, stale\)/);
  assert.match(first.text,/- Work Codex · acc_codex · Codex · pro · 5h 95% left · 7d 70% left/);
  assert.doesNotMatch(first.text,/\b1% left|acc_out|Old/);
  assert.ok(first.text.includes(DEFAULT_RULES));
  assert.ok(!first.text.includes('a@example.com'));
  assert.equal(refreshes,0,'fresh cache is not refreshed');
  // Quota changes do not change the hash; rules and accounts do.
  cache=usage(12);const second=await knowledge.describe();
  assert.match(second.text,/5h 12% left/);assert.equal(second.hash,first.hash);
  await policy.set({rules:'- Always use the team account.'});
  const third=await knowledge.describe();assert.ok(third.text.includes('- Always use the team account.'));assert.notEqual(third.hash,first.hash);
  // An old or missing cache triggers one background refresh without waiting for it.
  cache={...usage(),checkedAt:'2026-10-23T09:00:00.000Z'};await knowledge.describe();await new Promise(r=>setImmediate(r));assert.equal(refreshes,1);
  cache=null;const noUsage=await knowledge.describe();assert.match(noUsage.text,/Main Claude · acc_main · Claude Code · Claude Max · quota unknown \(run --list\)/);
  await policy.set({enabled:false});assert.equal(await knowledge.describe(),null);
  await policy.set({enabled:true});
  assert.equal(await new SubagentKnowledge({runner:{profiles:async()=>[accounts[3]]},policy,helperPath:'x'}).describe(),null);
  assert.equal(quotaText({status:'ok',auth:'api_key',windows:[]}),'pay-as-you-go API key, no quota window');
  assert.equal(quotaText({status:'unavailable',error:'not_logged_in'}),'signed out');
  assert.match(knowledgeText({helperPath:'/h.mjs',accounts:[accounts[0]],usage:null,rules:'R'}),/\nR\n/);
});

test('context: knowledge rides with bootstrap, stays out of unchanged turns, returns when its hash changes',()=>{
  const run={id:'new',hostId:'host',profileId:'acc_main',queueId:'session:s',sessionId:'s',text:'New request',model:'m'};
  const state={project:{path:process.cwd()},runs:[],artifacts:[],annotations:[]};
  const k1={text:'SUBAGENT KNOWLEDGE ONE',hash:'h1'},k2={text:'SUBAGENT KNOWLEDGE TWO',hash:'h2'};
  const first=buildContext(state,run,undefined,'host',k1);
  assert.ok(first.prompt.includes('history-index'));assert.ok(first.prompt.includes(k1.text));assert.equal(first.metadata.knowledgeHash,'h1');
  state.runs.push({...run,id:'old',status:'succeeded',nativeSessionId:'native',context:first.metadata});
  const delta=buildContext(state,run,'native','host',k1);
  assert.equal(delta.prompt,run.text);assert.equal(delta.metadata.mode,'delta');assert.equal(delta.metadata.knowledgeHash,'h1');
  const changed=buildContext(state,run,'native','host',k2);
  assert.equal(changed.prompt,`${run.text}\n${k2.text}`);assert.equal(changed.metadata.knowledgeHash,'h2');
  // Conversations that started before the feature existed are told once.
  state.runs[0].context={version:1,mode:'bootstrap'};assert.ok(buildContext(state,run,'native','host',k1).prompt.includes(k1.text));
  assert.equal(buildContext(state,run,'native','host',null).prompt,run.text);
  assert.equal(buildContext(state,run,undefined,'host',null).metadata.knowledgeHash,undefined);
});

test('HTTP: settings round trip, prompt section reaches the agent once per rule change',async t=>{
  const dir=await tempDir(t);const prompts=[];
  const runner={profiles:async()=>[{id:'acc_team',label:'Team Claude',family:'claude',auth:'oauth',status:'signed_in',available:true,identity:{plan:'Claude Team'},models:[{id:'claude-sonnet-5-5',label:'Sonnet'}]}],execute:async({prompt,onEvent})=>{prompts.push(prompt);onEvent({type:'text',text:'ok'});return {text:'ok',nativeSessionId:'native-1'};},close:async()=>{}};
  const accountUsage={ttlMs:60000,invalidate(){},peek:()=>usage(55),get:async()=>usage(55)};
  const app=await createStudio({stateDir:path.join(dir,'state'),projectRoot:path.join(dir,'projects'),port:0,previewPort:0,runner,accountUsage,homedir:path.join(dir,'home'),env:{}});
  t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.port}`;
  const api=async(p,method='GET',data)=>{const res=await fetch(base+p,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});const payload=await res.json();if(!res.ok)throw Object.assign(new Error(payload.error),{status:res.status});return payload;};
  const initial=await api('/api/settings/subagents');
  assert.equal(initial.enabled,true);assert.equal(initial.rules,DEFAULT_RULES);assert.equal(initial.custom,false);
  assert.match(initial.preview,/Team Claude · acc_team · Claude Code · Claude Team · 5h 55% left/);assert.ok(initial.preview.includes(initial.helperPath));
  assert.equal(path.basename(initial.file),'.studio-settings.json');assert.equal(path.dirname(initial.file),await fs.realpath(path.join(dir,'projects')));
  await assert.rejects(api('/api/settings/subagents','PUT',{rules:42}),e=>e.status===400);
  await assert.rejects(api('/api/settings/subagents','POST',{}),e=>e.status===405);
  const saved=await api('/api/settings/subagents','PUT',{rules:'- Team Claude for everything.'});
  assert.equal(saved.custom,true);assert.equal(saved.updatedBy,saved.hostName);
  // The projects folder still lists only projects; the settings file is not mistaken for one.
  const project=await api('/api/projects','POST',{name:'knowledge'});assert.equal((await api('/api/projects')).length,1);
  const session=await api(`/api/projects/${project.id}/sessions`,'POST',{title:'k'});
  const send=async(id,text)=>{await api(`/api/projects/${project.id}/messages`,'POST',{requestId:id,sessionId:session.id,text,profileId:'acc_team',model:'claude-sonnet-5-5'});const deadline=Date.now()+8000;while(Date.now()<deadline){const state=await app.store.read(project.id);const r=state.runs.find(r=>r.requestId===id);if(r?.status==='succeeded')return r;if(r&&['failed','interrupted'].includes(r.status))throw new Error(r.error);await new Promise(r=>setTimeout(r,25));}throw new Error('run did not finish');};
  const first=await send('one','first');
  assert.match(prompts[0],/Subagents \(Studiolo\)/);assert.ok(prompts[0].includes('- Team Claude for everything.'));assert.ok(prompts[0].includes('5h 55% left'));assert.ok(first.context.knowledgeHash);
  await send('two','second');assert.equal(prompts[1],'second');
  await api('/api/settings/subagents','PUT',{rules:'- Main Claude for everything.'});
  const third=await send('three','third');assert.ok(prompts[2].startsWith('third\nSubagents (Studiolo)'));assert.ok(prompts[2].includes('- Main Claude for everything.'));assert.notEqual(third.context.knowledgeHash,first.context.knowledgeHash);
  await api('/api/settings/subagents','PUT',{enabled:false});
  await send('four','fourth');assert.equal(prompts[3],'fourth');
  const off=await api('/api/settings/subagents');assert.equal(off.enabled,false);assert.equal(off.preview,null);
});

test('launcher: lists accounts, resolves label and model alias, runs one shot with the account environment',async t=>{
  const dir=await tempDir(t);const stateDir=path.join(dir,'state');await fs.mkdir(stateDir,{recursive:true});
  const fake=path.join(dir,'fake-claude.mjs'),marks=path.join(dir,'marks.json');
  await fs.writeFile(fake,`
import fs from 'node:fs';
const send=e=>process.stdout.write(JSON.stringify(e)+'\\n');
const args=process.argv.slice(2);
if(args.includes('--safe-mode')){
  // Metadata connection used by --list: answer initialize and get_usage.
  let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;const e=JSON.parse(line);
    if(e.request?.subtype==='initialize')send({type:'control_response',response:{subtype:'success',request_id:e.request_id,response:{account:{email:'fake@example.com',subscriptionType:'team'}}}});
    if(e.request?.subtype==='get_usage')send({type:'control_response',response:{subtype:'success',request_id:e.request_id,response:{subscription_type:'team',rate_limits:{five_hour:{utilization:35,resets_at:'2026-10-23T14:00:00Z'},seven_day:{utilization:10,resets_at:'2026-10-27T09:00:00Z'}}}}});}});
  process.stdin.on('end',()=>process.exit(0));
}else{
  let input='';for await(const chunk of process.stdin)input+=chunk;
  fs.writeFileSync(${JSON.stringify(marks)},JSON.stringify({args,configDir:process.env.CLAUDE_CONFIG_DIR,cwd:process.cwd(),prompt:input.trim()}));
  send({type:'system',subtype:'init',session_id:'native-x',model:args[args.indexOf('--model')+1]});
  send({type:'assistant',message:{content:[{type:'text',text:'Answer: '+input.trim()}]}});
  send({type:'result',subtype:'success',result:'Answer: '+input.trim(),session_id:'native-x',usage:{input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:7}});
}`);
  const configDir=path.join(dir,'account-dir');await fs.mkdir(configDir);
  await fs.writeFile(path.join(stateDir,'agent-profiles.json'),JSON.stringify({'fake-claude':{command:process.execPath,args:[fake],label:'Team Fake',configDir,models:[{id:'claude-opus-5-5',label:'Opus 5.5'},{id:'claude-haiku-4-5-20251001',label:'Haiku 4.5'}]}}));
  const settings=path.join(dir,'.studio-settings.json');await fs.writeFile(settings,JSON.stringify({version:1,subagents:{rules:'- Fake rule.'}}));
  const exec=(args,input)=>new Promise(resolve=>{const child=execFile(process.execPath,[launcher,'--state-dir',stateDir,'--settings',settings,...args],{cwd:dir,env:{...process.env,CLAUDE_CONFIG_DIR:'/should/be/replaced'}},(error,stdout,stderr)=>resolve({code:error?error.code:0,stdout,stderr}));if(input!==undefined)child.stdin.end(input);else child.stdin.end();});
  const listed=await exec(['--list']);
  assert.equal(listed.code,0,listed.stderr);
  assert.match(listed.stdout,/- Team Fake · fake-claude · Claude Code · plan unknown · 5h 65% left, resets 10-23 \d\d:\d\d · 7d 90% left, resets 10-27 \d\d:\d\d \(as of .*\) · models: claude-opus-5-5, claude-haiku-4-5-20251001/);
  assert.match(listed.stdout,/Routing rules:\n- Fake rule\./);
  const quick=await exec(['--list','--no-quota']);assert.match(quick.stdout,/quota unknown/);
  const missing=await exec(['--account','Nobody','hi']);assert.equal(missing.code,2);assert.match(missing.stderr,/No account "Nobody"/);
  const noModel=await exec(['--account','team fake','hi']);assert.equal(noModel.code,2);assert.match(noModel.stderr,/--model is required/);
  const result=await exec(['--account','team fake','--model','haiku','--cwd',configDir,'Say hello to','the world']);
  assert.equal(result.code,0,result.stderr);
  assert.equal(result.stdout,'Answer: Say hello to the world\n');
  assert.match(result.stderr,/^\[subagent\] account=Team Fake \(fake-claude\) model=claude-haiku-4-5-20251001 permissions=project-write status=succeeded seconds=\d+ tokens_in=5 tokens_out=7\n$/);
  const marks1=JSON.parse(await fs.readFile(marks,'utf8'));
  assert.equal(marks1.configDir,configDir);assert.equal(marks1.cwd,await fs.realpath(configDir));assert.equal(marks1.prompt,'Say hello to the world');
  assert.ok(marks1.args.includes('--permission-prompts')&&marks1.args.includes('none'));
  assert.deepEqual(marks1.args.slice(marks1.args.indexOf('--permission-mode'),marks1.args.indexOf('--permission-mode')+2),['--permission-mode','acceptEdits']);
  // Opus defaults to auto mode; the task may come from stdin; --json wraps the answer.
  const piped=await exec(['--account','fake-claude','--model','claude-opus-5-5','--json'],'from stdin\n');
  assert.equal(piped.code,0,piped.stderr);
  const json=JSON.parse(piped.stdout);assert.equal(json.text,'Answer: from stdin');assert.equal(json.permissions,'auto');assert.equal(json.model,'claude-opus-5-5');assert.equal(json.status,'succeeded');
  const marks2=JSON.parse(await fs.readFile(marks,'utf8'));assert.ok(marks2.args.includes('auto'));
  const haikuAuto=await exec(['--account','fake-claude','--model','haiku','--permissions','auto','x']);assert.equal(haikuAuto.code,2);assert.match(haikuAuto.stderr,/does not support/);
});
