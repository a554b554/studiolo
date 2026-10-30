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
 const events=(await a.journal(p.id)).events.filter(e=>e.name.startsWith('v2-'));await b.importJournal(p.id,[events[1]]);
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
 // Registration is mutual: B learns A through A's /api/peer/hello.
 const added=await a.api('/api/hosts','POST',{url:b.base,name:'B'});assert.equal(added.mutual,true);
 // Both hosts hold the files, so conversations may run on either (a synced project).
 await a.app.store.mutate(p.id,'project.synced',s=>{s.project.sync.enabled=true;s.project.replicas[b.app.hostId]={state:'ready',version:null,at:new Date().toISOString()};});
 await b.app.store.discoverProjects();await merge(a.app.store,b.app.store,p.id);
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
test('first-message races bind once, and an artifact runs on its artifact host whichever server the page uses',async t=>{
 const {a,b,p,calls}=await servers(t),url=`/api/projects/${p.id}`;
 const s=await a.api(url+'/sessions','POST',{title:'Race'});
 await b.app.store.discoverProjects();const j=await a.app.store.journal(p.id);await b.app.store.importJournal(p.id,j.events);
 const input={sessionId:s.id,requestId:randomUUID(),text:'race',profileId:'codex',model:'test'};
 const outcomes=await Promise.allSettled([a.api(url+'/messages','POST',{...input,hostId:a.app.hostId}),b.api(url+'/messages','POST',{...input,hostId:b.app.hostId})]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);await wait(()=>calls.length===1);
 const art=await a.api(url+'/artifacts','POST',{name:'Local preview',root:'web'});await merge(a.app.store,b.app.store,p.id);
 // The artifact host defaults to the owner (A): starting it through B runs it on A, with A's preview origin.
 const y=await b.api(`${url}/artifacts/${art.id}/start`,'POST',{});
 assert.equal(y.hostId,a.app.hostId);assert.ok(a.app.artifacts.active.size);assert.equal(b.app.artifacts.active.size,0);
 assert.match(await (await (await previewClient(y)).request()).text(),/Shared artifact/);
 assert.equal((await a.api(`${url}/artifacts/${art.id}/status`)).running,true);
 await b.api(`${url}/artifacts/${art.id}/stop`,'POST',{});assert.equal((await a.api(`${url}/artifacts/${art.id}/status`)).running,false);
});

test('an unsynced project runs and hosts artifacts only on its owner, from either server',async t=>{
 const {a,b,calls}=await servers(t);
 const p=await a.api('/api/projects','POST',{name:'Owner only'}),url=`/api/projects/${p.id}`;
 await fs.mkdir(path.join(p.path,'web'));await fs.writeFile(path.join(p.path,'web/index.html'),'<h1>Owner files</h1>');
 await wait(async()=>(await b.api('/api/projects')).some(x=>x.id===p.id&&!x.unavailable));
 const s=await b.api(url+'/sessions','POST',{title:'Elsewhere'});
 const input={sessionId:s.id,requestId:randomUUID(),text:'hi',profileId:'codex',model:'test'};
 await assert.rejects(b.api(url+'/messages','POST',{...input,hostId:b.app.hostId}),e=>e.status===409&&/not synced; it runs on/.test(e.message));
 await b.api(url+'/messages','POST',{...input,requestId:randomUUID(),hostId:a.app.hostId});await wait(()=>calls.length===1);assert.equal(calls[0].label,'A');
 const art=await b.api(url+'/artifacts','POST',{name:'Owner preview',root:'web'});
 const live=await b.api(`${url}/artifacts/${art.id}/start`,'POST',{});assert.equal(live.hostId,a.app.hostId);
 await assert.rejects(b.api(`${url}/artifacts/${art.id}/annotations`,'POST',{profileId:'codex',model:'test',text:'c',requestId:randomUUID(),hostId:b.app.hostId,anchor:{kind:'page'}}),e=>e.status===409&&/run on/.test(e.message));
 await b.api(`${url}/artifacts/${art.id}/stop`,'POST',{});
 // A conversation bound to B before the project became owner-only stays readable but cannot continue.
 const old=await b.api(url+'/sessions','POST',{title:'Bound to B'});
 await wait(async()=>(await a.api(url)).sessions.some(x=>x.id===old.id));
 await a.app.store.mutate(p.id,'legacy',x=>{x.sessions.find(y=>y.id===old.id).hostId=b.app.hostId;x.sessions.find(y=>y.id===old.id).profileId='codex';});
 await wait(async()=>(await b.api(url)).sessions.find(x=>x.id===old.id)?.hostId===b.app.hostId);
 await assert.rejects(b.api(url+'/messages','POST',{...input,sessionId:old.id,requestId:randomUUID(),hostId:b.app.hostId}),e=>e.status===409&&/Fork to continue there/.test(e.message));
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

test('registering a server once lists both ways from machine.json alone; rename, remove and offline status follow',async t=>{
 const {a,b}=await servers(t);
 for(const dir of [a.app.store.projectRoot,b.app.store.projectRoot])await assert.rejects(fs.stat(path.join(dir,'.servers')),{code:'ENOENT'});
 const machine=async app=>JSON.parse(await fs.readFile(path.join(app.stateDir,'machine.json'),'utf8'));
 assert.deepEqual((await machine(a.app)).hosts.map(h=>h.id),[b.app.hostId]);assert.deepEqual((await machine(b.app)).hosts.map(h=>h.id),[a.app.hostId]);
 let listed=await b.api('/api/hosts');assert.equal(listed[0].url,a.base);assert.equal(listed[0].online,true);assert.equal('token' in listed[0],false);
 assert.deepEqual((await a.api('/api/bootstrap')).hosts.map(h=>h.id),[a.app.hostId,b.app.hostId]);
 await a.api(`/api/hosts/${b.app.hostId}`,'PATCH',{name:'Renamed B'});assert.equal((await a.api('/api/hosts'))[0].name,'Renamed B');
 await assert.rejects(a.api(`/api/hosts/${b.app.hostId}`,'PATCH',{url:a.base}),e=>e.status===400);
 await assert.rejects(a.api('/api/peer/hello','POST',{hostId:b.app.hostId,url:b.base}),e=>e.status===403);
 await a.api(`/api/hosts/${b.app.hostId}`,'DELETE');
 assert.deepEqual((await machine(a.app)).hosts,[]);assert.deepEqual((await machine(b.app)).hosts,[],'the peer forgets this server too');
 assert.deepEqual((await b.api('/api/bootstrap')).hosts.map(h=>h.id),[b.app.hostId]);
 await b.api('/api/hosts','POST',{url:a.base});listed=await a.api('/api/hosts');assert.equal(listed[0].id,b.app.hostId);
 await new Promise(resolve=>b.app.server.close(resolve));a.app.hosts.cache=null;
 listed=await a.api('/api/hosts');assert.equal(listed[0].online,false,'an offline server stays listed in Settings');
});
