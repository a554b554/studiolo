import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createStudio} from '../src/server.mjs';
import {forkTranscript} from '../src/context.mjs';

// Plan P5: a fork is a new conversation whose first run starts from an agent summary of the
// source, written by the fork's own computer and account from replicated messages.
const wait=async(fn,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+fn.toString().slice(0,120));};
async function servers(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-fork-'));const calls=[],apps=[];
 const make=async label=>{
  const app=await createStudio({stateDir:path.join(root,label,'state'),projectRoot:path.join(root,label,'projects'),port:0,previewPort:0,runner:{profiles:async()=>[{id:'codex',models:[{id:'test'}],available:true},{id:'claude',models:[{id:'sonnet'}],available:true}],execute:async o=>{
   const summary=/handoff summary of the conversation/.test(o.prompt);calls.push({label,profileId:o.profileId,prompt:o.prompt,summary,permissionMode:o.permissionMode});
   return summary?{text:`SUMMARY by ${label}/${o.profileId}: goal is the parser`}:{text:`reply from ${label}`,nativeSessionId:`native-${label}-${randomUUID()}`};}}});
  apps.push(app);const base=`http://127.0.0.1:${app.port}`;
  const api=async(url,method='GET',data)=>{const res=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const result=await res.json();if(!res.ok)throw Object.assign(Error(result.error),{status:res.status});return result;};
  return {app,base,api};
 };
 const a=await make('A'),b=await make('B');
 t.after(async()=>{for(const app of apps)await app.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
 await a.api('/api/hosts','POST',{url:b.base});
 return {a,b,calls};
}
const send=(x,url,sessionId,hostId,profileId='codex',model='test',text='continue')=>x.api(url+'/messages','POST',{sessionId,requestId:randomUUID(),text,profileId,model,hostId});
const settled=async(x,url,sid)=>wait(async()=>{const s=await x.api(url);const runs=s.runs.filter(r=>r.sessionId===sid);return runs.length&&runs.every(r=>['succeeded','failed','cancelled'].includes(r.status));});

test('fork transcripts drop the oldest turns first and keep the end of an oversized turn',()=>{
 const messages=[['user','first question'],['assistant','first answer'],['system','正在处理。'],['user','second'],['assistant','x'.repeat(50)]].map(([role,text],i)=>({role,text,createdAt:`t${i}`}));
 const all=forkTranscript(messages);assert.equal(all.turns,4);assert.equal(all.omitted,0);assert.doesNotMatch(all.text,/正在处理/);
 const cut=forkTranscript(messages,90);assert.equal(cut.omitted,3);assert.match(cut.text,/x{50}/);
 const tiny=forkTranscript(messages,20);assert.equal(tiny.text.length,20);assert.ok(tiny.text.endsWith('x\n'));
});

test('a fork on the owner switches account, starts from a summary and links both conversations',async t=>{
 const {a,b,calls}=await servers(t);
 const p=await a.api('/api/projects','POST',{name:'Fork here'}),url=`/api/projects/${p.id}`;
 const s=await a.api(url+'/sessions','POST',{title:'Parser work'});
 await send(a,url,s.id,a.app.hostId,'codex','test','build the parser');await settled(a,url,s.id);
 const fork=await a.api(`${url}/sessions/${s.id}/fork`,'POST',{});
 assert.equal(fork.title,'Parser work · 分叉');assert.equal(fork.forkOf.sessionId,s.id);
 assert.deepEqual((await a.api(url)).sessions.find(x=>x.id===s.id).forks,[fork.id]);
 // Unsynced: the fork may change account but not computer.
 await wait(async()=>(await b.api('/api/projects')).some(x=>x.id===p.id&&!x.unavailable));
 await assert.rejects(send(a,url,fork.id,b.app.hostId),e=>e.status===409);
 await send(a,url,fork.id,a.app.hostId,'claude','sonnet','what next?');await settled(a,url,fork.id);
 const summary=calls.find(c=>c.summary);
 assert.equal(summary.profileId,'claude');assert.equal(summary.permissionMode,'read-only');assert.match(summary.prompt,/build the parser/);assert.match(summary.prompt,/reply from A/);
 const state=await a.api(url),shown=state.messages.find(m=>m.sessionId===fork.id&&m.kind==='fork_summary');
 assert.equal(shown.text,'SUMMARY by A/claude: goal is the parser');
 const run=calls.at(-1);assert.ok(!run.summary);assert.match(run.prompt,/forked from "Parser work"/);assert.match(run.prompt,/SUMMARY by A\/claude/);
 // Later turns of the fork do not summarize again.
 await send(a,url,fork.id,a.app.hostId,'claude','sonnet','and then?');await settled(a,url,fork.id);
 assert.equal(calls.filter(c=>c.summary).length,1);
});

test('a fork of a project allowed on another computer runs there, in a fresh folder, while the source computer is offline',async t=>{
 const {a,b,calls}=await servers(t);
 const p=await a.api('/api/projects','POST',{name:'Fork across'}),url=`/api/projects/${p.id}`;
 await fs.writeFile(path.join(p.path,'notes.txt'),'v1');
 await wait(async()=>(await b.api('/api/projects')).some(x=>x.id===p.id&&!x.unavailable));
 // Allowing B is metadata only: B holds no copy until it runs the project.
 await a.api(url+'/sync','PATCH',{allowedHostIds:[b.app.hostId]});
 await wait(async()=>(await b.api(url+'/sync')).allowedHostIds.includes(b.app.hostId));
 assert.deepEqual((await b.api(url+'/sync')).copies,[a.app.hostId]);
 const s=await a.api(url+'/sessions','POST',{title:'On A'});
 await send(a,url,s.id,a.app.hostId,'codex','test','plan the release');await settled(a,url,s.id);
 await wait(async()=>(await b.api(url)).messages.some(m=>m.sessionId===s.id&&m.role==='assistant'));
 const fork=await b.api(`${url}/sessions/${s.id}/fork`,'POST',{});
 await a.app.close();b.app.hosts.cache=null;
 await send(b,url,fork.id,b.app.hostId,'codex','test','go on');await settled(b,url,fork.id);
 const state=await b.api(url);
 assert.equal(state.runs.find(r=>r.sessionId===fork.id).status,'succeeded');
 // B's first run gave it an (empty) working folder of its own; A's file was not copied.
 assert.equal(state.project.replicas[b.app.hostId]?.state,'ready');assert.equal(state.filesHostId,b.app.hostId);
 assert.equal(await fs.stat(path.join(b.app.store.projectRoot,p.id,'notes.txt')).catch(e=>e.code),'ENOENT');
 assert.match(state.messages.find(m=>m.sessionId===fork.id&&m.kind==='fork_summary').text,/SUMMARY by B/);
 assert.match(calls.find(c=>c.summary&&c.label==='B').prompt,/plan the release/);
});
