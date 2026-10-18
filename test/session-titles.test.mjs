import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {QueueManager} from '../src/queue.mjs';
import {CliRunner} from '../src/runner.mjs';
import {renameSession} from '../src/session-titles.mjs';

async function fixture(t, summarizeTitle) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-titles-'));
  const store=await new Store({stateDir:path.join(dir,'local'),hostId:'a'}).init();
  const project=await store.createProject({name:'Titles',path:path.join(dir,'project')});
  await store.mutate(project.id,'session.created',s=>s.sessions.push({id:'12345678-1234-4234-8234-123456789abc',title:'New conversation',titleSource:'pending'}));
  const runner={execute:async()=>({text:'用容斥原理求解组合计数。',nativeSessionId:'native-chat'}),summarizeTitle};
  const queue=await new QueueManager({store,runner,hostId:'a'}).init();
  t.after(async()=>{await queue.close();await fs.rm(dir,{recursive:true,force:true});});
  const read=()=>store.read(project.id);
  const submit=id=>queue.submit(project.id,{requestId:id,sessionId:'12345678-1234-4234-8234-123456789abc',profileId:'claude',model:'test',text:'请解释容斥原理的应用'});
  return {store,project,queue,read,submit};
}
async function until(fn) { for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Timed out'); }

test('first completed exchange gets one summary without adding messages or replacing native identity',async t=>{
  const calls=[];const f=await fixture(t,async args=>{calls.push(args);return {text:'“容斥原理应用”',usage:{turn:{totalTokens:20}}};});
  await f.submit('first');await until(async()=>(await f.read()).sessions[0].titleSource==='auto');
  let s=await f.read();assert.equal(s.sessions[0].title,'容斥原理应用');assert.equal(calls.length,1);
  assert.equal(calls[0].profileId,'claude');assert.match(calls[0].assistant,/组合计数/);
  assert.equal(s.messages.filter(m=>m.role==='assistant').length,1);assert.equal(s.nativeSessions['a:claude:12345678-1234-4234-8234-123456789abc'],'native-chat');
  await f.submit('second');await until(async()=>(await f.read()).runs[1].status==='succeeded');
  await f.queue.close();assert.equal(calls.length,1);
});
test('manual rename wins against delayed automatic title; summary does not block next turn',async t=>{
  let finish,started=false;const f=await fixture(t,()=>{started=true;return new Promise(r=>finish=r);});
  await f.submit('first');await until(()=>started);
  await f.submit('second');await until(async()=>(await f.read()).runs[1].status==='succeeded');
  await renameSession(f.store,f.project.id,'12345678-1234-4234-8234-123456789abc','我的数学笔记');finish({text:'自动标题'});
  await until(()=>f.queue.titles.jobs.size===0);
  assert.equal((await f.read()).sessions[0].title,'我的数学笔记');
  assert.equal((await f.read()).sessions[0].titleSource,'manual');
});
test('title failure falls back without failing the completed reply',async t=>{
  const f=await fixture(t,async()=>{throw new Error('quota exhausted');});
  await f.submit('first');await until(async()=>(await f.read()).sessions[0].titleSource==='fallback');
  const s=await f.read();assert.equal(s.runs[0].status,'succeeded');assert.equal(s.sessions[0].title,'请解释容斥原理的应用');
});
test('late title cannot recreate a deleted session',async t=>{
  let finish;const f=await fixture(t,()=>new Promise(r=>finish=r));await f.submit('first');await until(()=>finish);
  await f.store.mutate(f.project.id,'session.deleted',s=>{s.sessions=[];});finish({text:'Late'});
  await until(()=>f.queue.titles.jobs.size===0);assert.deepEqual((await f.read()).sessions,[]);
});
test('summary invocation is independent and denies permission requests',async()=>{
  const runner=new CliRunner();let call;runner.execute=async args=>{call=args;return {text:'Title'};};
  await runner.summarizeTitle({cwd:process.cwd(),profileId:'codex',model:'selected',user:'Question',assistant:'Answer'});
  assert.equal(call.nativeSessionId,undefined);assert.equal(call.sessionKey,undefined);
  assert.equal(call.permissionMode,'read-only');assert.equal(call.model,'selected');
  assert.deepEqual(await call.onApproval({}),{decision:'deny'});assert.match(call.prompt,/Question/);assert.match(call.prompt,/Answer/);
});
