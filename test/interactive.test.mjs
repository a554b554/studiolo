// Interactive parity with the terminal CLIs: interrupt keeps the process and native session,
// a message sent mid-turn is delivered into the running turn, slash commands reach the CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {CliRunner} from '../src/runner.mjs';
import {Store} from '../src/store.mjs';
import {QueueManager} from '../src/queue.mjs';
import {parseCommand,reviewTarget,claudeCapabilities} from '../src/commands.mjs';
import {conversationItems} from '../public/conversation.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn){const deadline=Date.now()+8000;while(Date.now()<deadline){if(await fn())return;await sleep(15);}throw new Error('Condition timed out');}

// A fake CLI speaking the public protocol of each family. `body` runs per stdin line as `e`.
async function fixture(t,family,body){
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'studio-interactive-')),script=path.join(cwd,'fake.mjs');
  await fs.writeFile(script,`import {createInterface} from 'node:readline';const send=e=>process.stdout.write(JSON.stringify(e)+'\\n');let pendingUser=null,turn=0,steerCount=0;const r=createInterface({input:process.stdin});r.on('line',l=>{const e=JSON.parse(l);${body}});r.on('close',()=>process.exit(0));`);
  const runner=new CliRunner({executables:{[family]:{command:process.execPath,args:[script],models:[{id:'one',efforts:['low']}]}}});
  t.after(async()=>{await runner.close();await fs.rm(cwd,{recursive:true,force:true});});
  const key='project:session:a:host';
  const execute=options=>runner.execute({cwd,profileId:family,model:'one',reasoningEffort:'low',permissionMode:'auto',sessionKey:key,prompt:'hello',onApproval:async()=>({decision:'deny'}),signal:AbortSignal.timeout(8000),...options});
  return {runner,execute,key,cwd};
}

const claude=`
 if(e.type==='control_request'){
  const q=e.request;
  if(q.subtype==='interrupt'){send({type:'control_response',response:{request_id:e.request_id,subtype:'success',response:{still_queued:[]}}});
   send({type:'user',message:{role:'user',content:[{type:'text',text:'[Request interrupted by user]'}]}});
   send({type:'result',subtype:'error_during_execution',is_error:true,user_message_uuids:[pendingUser],result:'',errors:['interrupted']});
   send({type:'command_lifecycle',command_uuid:pendingUser,state:'cancelled'});
   send({type:'system',subtype:'session_state_changed',state:'idle'});pendingUser=null;return;}
  send({type:'control_response',response:{request_id:e.request_id,subtype:'success',response:q.subtype==='initialize'?{commands:[{name:'compact',description:'Compact'},{name:'context',argumentHint:''}],models:[{value:'opus',displayName:'Opus'}],account:{email:'a@b.c',subscriptionType:'Max',token:'never'}}:q.subtype==='get_settings'?{applied:{model:'one',effort:'low'}}:{}}});
  return;
 }
 if(e.type==='user'){
  send({type:'system',subtype:'init',session_id:'native-claude',model:'one'});
  if(pendingUser){ // a steer while a turn runs: queued, then answered inside the same turn
   steerCount++;send({type:'command_lifecycle',command_uuid:e.uuid,state:'queued'});
   send({type:'stream_event',user_message_uuids:[pendingUser,e.uuid],event:{type:'content_block_delta',delta:{type:'text_delta',text:'after-steer'}}});
   send({type:'result',subtype:'success',user_message_uuids:[pendingUser,e.uuid],result:'after-steer'});
   send({type:'system',subtype:'session_state_changed',state:'idle'});pendingUser=null;return;}
  pendingUser=e.uuid;send({type:'system',subtype:'session_state_changed',state:'running'});
  send({type:'command_lifecycle',command_uuid:e.uuid,state:'started'});
  if(e.message.content==='long'){send({type:'stream_event',user_message_uuids:[e.uuid],event:{type:'content_block_delta',delta:{type:'text_delta',text:'partial'}}});return;}
  if(e.message.content==='/compact'){send({type:'system',subtype:'compact_boundary',compact_metadata:{pre_tokens:40,post_tokens:4}});send({type:'result',subtype:'success',user_message_uuids:[e.uuid],result:'',local_command:true});send({type:'system',subtype:'session_state_changed',state:'idle'});pendingUser=null;return;}
  send({type:'result',subtype:'success',session_id:'native-claude',user_message_uuids:[e.uuid],result:'turn:'+(++turn)});
  send({type:'system',subtype:'session_state_changed',state:'idle'});pendingUser=null;
 }
`;

test('Claude interrupt ends the turn as interrupted and keeps the process for the next message',async t=>{
  const f=await fixture(t,'claude',claude),events=[];
  const first=f.execute({prompt:'long',onEvent:e=>events.push(e)});
  await waitFor(()=>events.some(e=>e.type==='text'&&e.text==='partial'));
  await assert.rejects(f.runner.steer('missing:key','x'),e=>e.message==='no_active_turn');
  await f.runner.interrupt(f.key);
  const a=await first;
  assert.equal(a.status,'interrupted');assert.equal(a.text,'partial');assert.equal(a.error,undefined);
  assert.ok(events.some(e=>e.type==='status'&&e.text==='Interrupt requested'));
  const b=await f.execute({prompt:'again'});
  assert.equal(b.text,'turn:1');assert.equal(a.runtime.pid,b.runtime.pid);assert.equal(a.runtime.instanceId,b.runtime.instanceId);
  await assert.rejects(f.runner.interrupt(f.key),e=>e.message==='no_active_turn');
  const snapshot=f.runner.runtime('project:')[f.key];
  assert.deepEqual(snapshot.commands.map(c=>c.name),['compact','context']);
  assert.ok(!JSON.stringify(snapshot).includes('never'));
});

test('Claude steer is delivered into the running turn and recorded as a steer event before later text',async t=>{
  const f=await fixture(t,'claude',claude),events=[];
  const first=f.execute({prompt:'long',onEvent:e=>events.push(e)});
  await waitFor(()=>events.some(e=>e.type==='text'&&e.text==='partial'));
  assert.equal(f.runner.runtime('project:')[f.key].steerable,true);
  await f.runner.steer(f.key,'follow up');
  const a=await first;
  assert.equal(a.text,'after-steer');assert.equal(a.status,undefined);
  const sequence=events.filter(e=>['text','steer'].includes(e.type)).map(e=>e.type+':'+e.text);
  assert.deepEqual(sequence,['text:partial','steer:follow up','text:after-steer']);
  assert.equal(f.runner.runtime('project:')[f.key].steerable,false);
});

test('Claude slash command runs verbatim and compaction is reported as status',async t=>{
  const f=await fixture(t,'claude',claude),events=[];
  const a=await f.execute({prompt:'/compact',command:{name:'compact',args:''},onEvent:e=>events.push(e)});
  assert.equal(a.text,'');assert.equal(a.error,undefined);
  assert.ok(events.some(e=>e.type==='status'&&e.text==='Context compacted · 40 → 4 tokens'));
});

const codex=`
 const reply=(id,result)=>send({id,result});
 if(e.method==='initialize')return reply(e.id,{});
 if(e.method==='thread/start')return reply(e.id,{thread:{id:'thread-1'},reasoningEffort:'low'});
 if(e.method==='turn/start'){turn++;const id='turn-'+turn;reply(e.id,{turn:{id}});send({method:'turn/started',params:{threadId:'thread-1',turn:{id}}});
  send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:id,itemId:'m'+turn,delta:'count'}});return;}
 if(e.method==='turn/steer'){if(e.params.expectedTurnId!=='turn-1')return send({id:e.id,error:{message:'wrong turn'}});reply(e.id,{turnId:'turn-1'});
  send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'m2',delta:'steered'}});
  send({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{id:'m2',type:'agentMessage',text:'steered',phase:'final_answer'}}});
  send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});return;}
 if(e.method==='turn/interrupt'){reply(e.id,{});send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:e.params.turnId,status:'interrupted'}}});return;}
 if(e.method==='thread/compact/start'){reply(e.id,{});send({method:'turn/started',params:{threadId:'thread-1',turn:{id:'compact-1'}}});
  send({method:'item/completed',params:{threadId:'thread-1',turnId:'compact-1',item:{id:'c1',type:'contextCompaction'}}});
  send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'compact-1',status:'completed'}}});return;}
 if(e.method==='skills/list')return reply(e.id,{data:[{cwd:'x',skills:[{name:'docs',shortDescription:'Write docs',enabled:true}]}]});
 if(e.id!==undefined&&e.method)return send({id:e.id,error:{message:'unknown '+e.method}});
`;

test('Codex steer and interrupt use turn/steer and turn/interrupt on the same thread',async t=>{
  const f=await fixture(t,'codex',codex),events=[];
  const first=f.execute({onEvent:e=>events.push(e)});
  await waitFor(()=>events.some(e=>e.type==='text'&&e.text==='count'));
  await f.runner.steer(f.key,'change course');
  const a=await first;
  assert.equal(a.text,'steered');assert.equal(a.status,undefined);
  assert.deepEqual(events.filter(e=>['text','steer'].includes(e.type)).map(e=>e.type+':'+e.text),['text:count','steer:change course','text:steered']);
  const events2=[];const second=f.execute({onEvent:e=>events2.push(e)});
  await waitFor(()=>events2.some(e=>e.type==='text'));
  await f.runner.interrupt(f.key);
  const b=await second;
  assert.equal(b.status,'interrupted');assert.equal(b.text,'count');assert.equal(b.runtime.pid,a.runtime.pid);
});

test('Codex commands map to app-server requests; unknown commands fail without a turn',async t=>{
  const f=await fixture(t,'codex',codex),events=[];
  const a=await f.execute({prompt:'/compact',command:{name:'compact',args:''},onEvent:e=>events.push(e)});
  assert.equal(a.error,undefined);assert.ok(events.some(e=>e.type==='status'&&e.text==='Context compacted'));
  const b=await f.execute({prompt:'/skills',command:{name:'skills',args:''}});
  assert.equal(b.text,'- docs: Write docs');
  await assert.rejects(f.execute({prompt:'/nope',command:{name:'nope',args:''}}),/does not support \/nope/);
});

test('command parsing and review targets',()=>{
  assert.deepEqual(parseCommand('/compact'),{name:'compact',args:''});
  assert.deepEqual(parseCommand('  /review base main '),{name:'review',args:'base main'});
  assert.equal(parseCommand('/usr/bin/node is broken'),null);
  assert.equal(parseCommand('hello /compact'),null);
  assert.deepEqual(reviewTarget(''),{type:'uncommittedChanges'});
  assert.deepEqual(reviewTarget('base main'),{type:'baseBranch',branch:'main'});
  assert.deepEqual(reviewTarget('commit abc1234'),{type:'commit',sha:'abc1234',title:null});
  assert.deepEqual(reviewTarget('focus on security'),{type:'custom',instructions:'focus on security'});
  const caps=claudeCapabilities({commands:[{name:'x',argumentHint:'[a]',description:'d'},{bad:true}],models:[{value:'opus',displayName:'Opus 5.5'}],account:{email:'e',subscriptionType:'Max',accessToken:'secret'}});
  assert.deepEqual(caps.commands,[{name:'x',hint:'[a]',description:'d'}]);
  assert.deepEqual(caps.models,[{id:'opus',label:'Opus 5.5',description:null}]);
  assert.equal(caps.account.email,'e');assert.ok(!JSON.stringify(caps).includes('secret'));
});

// Queue-level behaviour with a scripted runner.
async function queueFixture(t,runner){
  const dir=await fs.mkdtemp(path.join(process.cwd(),'.test-studio-interactive-'));
  const store=await new Store({stateDir:path.join(dir,'local'),hostId:'a'}).init();
  const project=await store.createProject({name:'Test',path:path.join(dir,'project')});
  const sessionId=randomUUID();
  await store.mutate(project.id,'sessions',s=>{s.sessions=[{id:sessionId,title:'t',createdAt:new Date().toISOString()}];});
  const queue=await new QueueManager({store,runner,hostId:'a',outputCommitMs:20}).init();
  t.after(async()=>{await queue.close();await fs.rm(dir,{recursive:true,force:true});});
  const submit=(text,extra={})=>queue.submit(project.id,{requestId:randomUUID(),sessionId,text,profileId:'codex',model:'test',...extra});
  return {store,project,sessionId,queue,submit,read:()=>store.read(project.id)};
}
// Runner whose execute hands control to the test: `turn.onEvent` streams, `turn.finish` resolves.
function scriptedRunner(){
  const turns=[];const runner={
    calls:[],
    execute(options){runner.calls.push(options);return new Promise(resolve=>turns.push({options,resolve,steers:[]}));},
    async steer(key,text){const turn=turns.at(-1);if(!turn||turn.done)throw Object.assign(new Error('no_active_turn'),{status:409});turn.steers.push(text);await turn.options.onEvent({type:'steer',text});},
    async interrupt(key){const turn=turns.at(-1);if(!turn||turn.done)throw Object.assign(new Error('no_active_turn'),{status:409});turn.done=true;turn.resolve({text:turn.text||'',status:'interrupted'});},
    release(){runner.released=(runner.released||0)+1;},
    turns,
  };return runner;
}

test('steered message is recorded in order and later text starts a new assistant segment',async t=>{
  const runner=scriptedRunner(),f=await queueFixture(t,runner);
  const run=await f.submit('first question');
  await waitFor(()=>runner.turns.length===1);
  const turn=runner.turns[0];
  await turn.options.onEvent({type:'text',text:'segment one'});
  const steered=await f.submit('follow up',{steer:true});
  assert.equal(steered.steered,true);assert.equal(steered.id,run.id);
  assert.deepEqual(turn.steers,['follow up']);
  await turn.options.onEvent({type:'text',text:'segment two'});
  turn.done=true;turn.resolve({text:'segment two (final)'});
  await waitFor(async()=>(await f.read()).runs[0].status==='succeeded');
  const state=await f.read();
  assert.equal(state.runs.length,1,'a steer is not a new run');
  const visible=state.messages.filter(m=>m.role!=='system').map(m=>[m.role,m.kind||'',m.text]);
  assert.deepEqual(visible,[['user','','first question'],['assistant','','segment one'],['user','steer','follow up'],['assistant','','segment two (final)']]);
  const items=conversationItems(state.messages,state.runs).filter(i=>i.kind==='message').map(i=>i.message.text);
  assert.deepEqual(items,['first question','segment one','follow up','segment two (final)']);
  // Nothing executing: a steer falls back to a normal queued message.
  const queued=await f.submit('later',{steer:true});
  assert.equal(queued.steered,undefined);assert.equal(queued.status,'queued');
});

test('interrupt marks the run cancelled, keeps queued work paused as stopped, and sending resumes',async t=>{
  const runner=scriptedRunner(),f=await queueFixture(t,runner);
  const run=await f.submit('one');
  await waitFor(()=>runner.turns.length===1);
  runner.turns[0].text='partial';
  const queued=await f.submit('two');
  await f.queue.interrupt(f.project.id,run.id);
  await waitFor(async()=>(await f.read()).runs[0].status==='cancelled');
  let state=await f.read();
  assert.equal(state.runs[0].error,undefined);
  assert.deepEqual(state.queues[`session:${f.sessionId}`],{paused:true,reason:'stopped'});
  assert.equal(state.runs[1].status,'queued');
  assert.ok(state.messages.some(m=>m.runId===run.id&&m.text==='Stopped.'));
  // Withdraw the queued message without touching the pause state.
  await f.queue.interrupt(f.project.id,queued.id);
  state=await f.read();assert.equal(state.runs[1].status,'cancelled');assert.equal(state.queues[`session:${f.sessionId}`].paused,true);
  // A new message after a stop runs without an explicit resume.
  await f.submit('three');
  await waitFor(()=>runner.turns.length===2);
  assert.equal((await f.read()).queues[`session:${f.sessionId}`].paused,false);
  runner.turns.at(-1).done=true;runner.turns.at(-1).resolve({text:'done'});
  await waitFor(async()=>(await f.read()).runs[2].status==='succeeded');
  assert.equal((await f.read()).queues[`session:${f.sessionId}`].paused,false,'a stop with nothing queued leaves the queue open');
});

test('/clear forgets the native session; other slash commands run verbatim as command runs',async t=>{
  const runner=scriptedRunner(),f=await queueFixture(t,runner);
  const first=await f.submit('hello');
  await waitFor(()=>runner.turns.length===1);
  runner.turns[0].done=true;runner.turns[0].resolve({text:'hi',nativeSessionId:'native-1'});
  await waitFor(async()=>(await f.read()).runs[0].status==='succeeded');
  assert.equal(Object.values((await f.read()).nativeSessions)[0],'native-1');
  const cleared=await f.submit('/clear');
  assert.equal(cleared.status,'succeeded');assert.deepEqual(cleared.command,{name:'clear',args:''});
  let state=await f.read();
  assert.deepEqual(state.nativeSessions,{});assert.equal(runner.released,1);
  assert.equal(state.messages.at(-1).role,'system');assert.equal(state.messages.at(-2).text,'/clear');
  const compact=await f.submit('/compact');
  await waitFor(()=>runner.turns.length===2);
  const call=runner.calls.at(-1);
  assert.equal(call.prompt,'/compact');assert.deepEqual(call.command,{name:'compact',args:''});assert.equal(call.nativeSessionId,undefined);
  runner.turns.at(-1).done=true;runner.turns.at(-1).resolve({text:'',nativeSessionId:'native-2'});
  await waitFor(async()=>(await f.read()).runs.at(-1).status==='succeeded');
  // The bootstrap prompt is still sent on the next ordinary message, since commands do not count.
  await f.submit('real question');
  await waitFor(()=>runner.turns.length===3);
  assert.ok(runner.calls.at(-1).prompt.includes('Project scope:'));
  assert.equal(runner.calls.at(-1).command,undefined);
  state=await f.read();
  assert.equal(state.runs.at(-1).context.mode,'bootstrap');
  assert.equal(parseCommand(first.text),null);
});
