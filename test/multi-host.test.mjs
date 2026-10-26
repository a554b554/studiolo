import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {createStudio} from '../src/server.mjs';
import {previewClient} from './preview-client.mjs';

const wait=async fn=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out');};
async function replicas(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-replicas-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const a=await new Store({stateDir:path.join(root,'a'),hostId:'a'}).init();const p=await a.createProject({name:'Shared'});
 const copy=path.join(root,'copy');await fs.cp(p.path,copy,{recursive:true});
 const b=await new Store({stateDir:path.join(root,'b'),hostId:'b'}).init();await b.createProject({path:copy,name:'Shared'});
 return {a,b,p,copy};
}
async function merge(a,b,id){const x=await a.journal(id),y=await b.journal(id);await a.importJournal(id,y.events);await b.importJournal(id,x.events);}
test('offline machines append different conversations and merge without losing updates, deletes or local paths',async t=>{
 const {a,b,p}=await replicas(t);const sa=randomUUID(),sb=randomUUID();
 await Promise.all([a.mutate(p.id,'session',s=>s.sessions.push({id:sa,title:'A'})),b.mutate(p.id,'session',s=>s.sessions.push({id:sb,title:'B'}))]);
 await a.mutate(p.id,'message',s=>s.messages.push({id:'ma',sessionId:sa,text:'from A'}));
 await b.mutate(p.id,'message',s=>s.messages.push({id:'mb',sessionId:sb,text:'from B'}));
 await merge(a,b,p.id);let x=await a.read(p.id),y=await b.read(p.id);
 assert.deepEqual(x.sessions,y.sessions);assert.deepEqual(x.messages,y.messages);assert.equal(x.messages.length,2);assert.notEqual(x.project.path,y.project.path);
 await Promise.all([a.mutate(p.id,'rename',s=>s.sessions.find(s=>s.id===sa).title='Renamed'),b.mutate(p.id,'delete',s=>s.sessions=s.sessions.filter(s=>s.id!==sb))]);
 await merge(a,b,p.id);x=await a.read(p.id);y=await b.read(p.id);assert.deepEqual(x.sessions,y.sessions);assert.equal(x.sessions.length,1);assert.equal(x.sessions[0].title,'Renamed');
 await merge(a,b,p.id);assert.equal((await a.read(p.id)).messages.length,2,'replayed journals are idempotent');
});
test('partial out-of-order journal delivery refuses writes until missing parents arrive',async t=>{
 const {a,b,p}=await replicas(t);await a.mutate(p.id,'one',s=>s.project.name='one');await a.mutate(p.id,'two',s=>s.project.name='two');
 const {events}=await a.journal(p.id);await b.importJournal(p.id,[events[1]]);
 await assert.rejects(b.mutate(p.id,'unsafe',s=>s.project.name='lost'),/incomplete/);
 await b.importJournal(p.id,[events[0]]);assert.equal((await b.read(p.id)).project.name,'two');
});
async function servers(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-two-servers-'));const calls=[];const apps=[];
 const make=async label=>{const app=await createStudio({stateDir:path.join(root,label,'local'),projectRoot:path.join(root,label,'projects'),port:0,previewPort:0,runner:{profiles:async()=>[{id:'codex',models:[{id:'test'},{id:'other'}],available:true}],execute:async o=>{calls.push({label,...o});await o.onEvent({type:'text',text:label});return {text:label,nativeSessionId:'native-'+label};}}});apps.push(app);const base=`http://127.0.0.1:${app.port}`;const api=async(url,method='GET',data)=>{const res=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const result=await res.json();if(!res.ok)throw Object.assign(Error(result.error),{status:res.status});return result;};return {app,base,api};};
 const a=await make('A'),b=await make('B');
 t.after(async()=>{for(const app of apps)await app.close();await fs.rm(root,{recursive:true,force:true});});
 const p=await a.api('/api/projects','POST',{name:'shared'});await fs.mkdir(path.join(p.path,'web'));await fs.writeFile(path.join(p.path,'web/index.html'),'<h1>Shared artifact</h1>');
 await fs.cp(p.path,path.join(b.app.store.projectRoot,p.id),{recursive:true});
 await a.api('/api/hosts','POST',{url:b.base,name:'B'});await b.api('/api/hosts','POST',{url:a.base,name:'A'});
 return {a,b,p,calls};
}
test('both entrypoints route a conversation to its fixed machine and account, keeping the native session across model changes',async t=>{
 const {a,b,p,calls}=await servers(t),url=`/api/projects/${p.id}`;
 const s=await a.api(url+'/sessions','POST',{title:'Remote'});
 const input={sessionId:s.id,requestId:randomUUID(),text:'first',profileId:'codex',model:'test',hostId:b.app.hostId};
 const run=await a.api(url+'/messages','POST',input);assert.equal(run.hostId,b.app.hostId);
 await wait(async()=>(await b.app.store.read(p.id)).runs[0]?.status==='succeeded');
 assert.equal(calls[0].label,'B');
 await a.api(url+'/messages','POST',{...input,requestId:randomUUID(),text:'second'});
 await wait(()=>calls.length===2);assert.equal(calls[1].nativeSessionId,'native-B');assert.equal(calls[1].label,'B');
 // Another model continues the same native session on the conversation's machine; another account does not.
 await a.api(url+'/messages','POST',{...input,requestId:randomUUID(),text:'third',model:'other'});
 await wait(()=>calls.length===3);assert.deepEqual([calls[2].label,calls[2].model,calls[2].nativeSessionId],['B','other','native-B']);
 await assert.rejects(a.api(url+'/messages','POST',{...input,requestId:randomUUID(),profileId:'claude'}),e=>e.status===409);
 await assert.rejects(b.api(url+'/messages','POST',{...input,requestId:randomUUID(),hostId:a.app.hostId}),e=>e.status===409);
 const local=await b.api(url+'/sessions','POST',{title:'On A'});
 await b.api(url+'/messages','POST',{...input,sessionId:local.id,requestId:randomUUID(),hostId:a.app.hostId});await wait(()=>calls.length===4);assert.equal(calls[3].label,'A');
});
test('first-message races bind once, and artifacts run on the web entrypoint independently',async t=>{
 const {a,b,p,calls}=await servers(t),url=`/api/projects/${p.id}`;
 const s=await a.api(url+'/sessions','POST',{title:'Race'});
 await b.app.store.discoverProjects();const j=await a.app.store.journal(p.id);await b.app.store.importJournal(p.id,j.events);
 const input={sessionId:s.id,requestId:randomUUID(),text:'race',profileId:'codex',model:'test'};
 const outcomes=await Promise.allSettled([a.api(url+'/messages','POST',{...input,hostId:a.app.hostId}),b.api(url+'/messages','POST',{...input,hostId:b.app.hostId})]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);await wait(()=>calls.length===1);
 const art=await a.api(url+'/artifacts','POST',{name:'Local preview',root:'web'});await merge(a.app.store,b.app.store,p.id);
 const x=await a.api(`${url}/artifacts/${art.id}/start`,'POST',{}),y=await b.api(`${url}/artifacts/${art.id}/start`,'POST',{});
 assert.ok(a.app.artifacts.active.size);assert.ok(b.app.artifacts.active.size);assert.notEqual(x.previewPort,y.previewPort);
 assert.match(await (await (await previewClient(x)).request()).text(),/Shared artifact/);assert.match(await (await (await previewClient(y)).request()).text(),/Shared artifact/);
 await a.api(`${url}/artifacts/${art.id}/stop`,'POST',{});assert.equal((await b.api(`${url}/artifacts/${art.id}/status`)).running,true);
});

test('offline machines disappear from selection while their histories remain readable',async t=>{
 const {a,b,p}=await servers(t),url=`/api/projects/${p.id}`;
 const s=await a.api(url+'/sessions','POST',{title:'On B'});
 await a.api(url+'/messages','POST',{sessionId:s.id,requestId:randomUUID(),text:'remember',profileId:'codex',model:'test',hostId:b.app.hostId});
 await wait(async()=>(await b.app.store.read(p.id)).runs[0]?.status==='succeeded');
 await merge(a.app.store,b.app.store,p.id);
 await new Promise(resolve=>b.app.server.close(resolve));
 await new Promise(resolve=>setTimeout(resolve,4100));
 const boot=await a.api('/api/bootstrap');assert.deepEqual(boot.hosts.map(h=>h.id),[a.app.hostId]);
 const state=await a.api(url);assert.equal(state.sessions.find(x=>x.id===s.id).hostId,b.app.hostId);assert.ok(state.messages.some(m=>m.role==='assistant'));
 await assert.rejects(a.api(url+'/messages','POST',{sessionId:s.id,requestId:randomUUID(),text:'again',profileId:'codex',model:'test',hostId:b.app.hostId}),e=>e.status===503);
 const local=await a.api(url+'/sessions','POST',{title:'Local while B offline'});await a.api(url+'/messages','POST',{sessionId:local.id,requestId:randomUUID(),text:'local',profileId:'codex',model:'test',hostId:a.app.hostId});
});
