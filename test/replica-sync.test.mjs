import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createStudio} from '../src/server.mjs';
import {FakeTransport} from '../src/transport.mjs';

// Plan P4: synced projects on two servers with disjoint roots. Files move only through commit and
// pull (FakeTransport stands in for rsync); runs pull before they start and commit when they end.
const wait=async(fn,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+fn.toString().slice(0,120));};
async function servers(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-replicas-'));const calls=[],apps=[];
 const make=async label=>{
  const transport=new FakeTransport();
  // The agent writes a file named after its host, so each run changes the project.
  const app=await createStudio({stateDir:path.join(root,label,'state'),projectRoot:path.join(root,label,'projects'),port:0,previewPort:0,transport,runner:{profiles:async()=>[{id:'codex',models:[{id:'test'}],available:true}],execute:async o=>{calls.push({label,cwd:o.cwd,files:(await fs.readdir(o.cwd)).sort()});await fs.writeFile(path.join(o.cwd,`by-${label}.txt`),o.prompt.slice(-20));return {text:'done on '+label,nativeSessionId:'native-'+label};}}});
  apps.push(app);const base=`http://127.0.0.1:${app.port}`;
  const api=async(url,method='GET',data)=>{const res=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const result=await res.json();if(!res.ok)throw Object.assign(Error(result.error),{status:res.status});return result;};
  return {app,base,api,transport};
 };
 const a=await make('A'),b=await make('B');
 t.after(async()=>{for(const app of apps)await app.close();await fs.rm(root,{recursive:true,force:true});});
 await a.api('/api/hosts','POST',{url:b.base});
 return {a,b,calls};
}
const ended=async(x,url)=>(await x.api(url)).runs.every(r=>!['queued','running','waiting'].includes(r.status));
async function converse(x,url,hostId,text){
 const s=await x.api(url+'/sessions','POST',{title:text});
 await x.api(url+'/messages','POST',{sessionId:s.id,requestId:randomUUID(),text,profileId:'codex',model:'test',hostId});
 await wait(async()=>(await x.api(url)).messages.some(m=>m.sessionId===s.id&&m.role==='assistant'));
 await wait(()=>ended(x,url));
 return s;
}

test('a synced project is copied to a new replica, runs there and its commits reach every copy',async t=>{
 const {a,b,calls}=await servers(t);
 const p=await a.api('/api/projects','POST',{name:'Synced'}),url=`/api/projects/${p.id}`;
 await fs.mkdir(path.join(p.path,'web'));await fs.writeFile(path.join(p.path,'web/index.html'),'<h1>v1</h1>');
 await fs.mkdir(path.join(p.path,'node_modules/pkg'),{recursive:true});await fs.writeFile(path.join(p.path,'node_modules/pkg/index.js'),'windows build');
 await wait(async()=>(await b.api('/api/projects')).some(x=>x.id===p.id&&!x.unavailable));
 // Turning sync on writes the ignore template and records the first version on the owner.
 const synced=await b.api(url+'/sync','PATCH',{enabled:true});
 assert.equal(synced.sync.enabled,true);assert.equal(synced.head.hostId,a.app.hostId);assert.equal(synced.head.files,2,'web/index.html and .studioignore');
 assert.match(await fs.readFile(path.join(p.path,'.studioignore'),'utf8'),/^node_modules\/$/m);
 // B becomes a replica: its stub fills with A's files except the ignored ones.
 await wait(async()=>(await b.api(url)).project.head);
 assert.equal((await b.api(url+'/replicas','POST',{hostId:b.app.hostId})).started,true);
 await wait(async()=>(await b.api(url)).project.replicas[b.app.hostId]?.state==='ready');
 const onB=path.join(b.app.store.projectRoot,p.id);
 assert.equal(await fs.readFile(path.join(onB,'web/index.html'),'utf8'),'<h1>v1</h1>');
 await assert.rejects(fs.stat(path.join(onB,'node_modules')),{code:'ENOENT'});
 await assert.rejects(fs.stat(path.join(onB,'.studio/stub')),{code:'ENOENT'});
 assert.equal((await b.api('/api/projects')).find(x=>x.id===p.id).replica,true);
 await wait(async()=>(await a.api(url)).project.replicas[b.app.hostId]?.state==='ready');
 // A conversation on B runs in B's folder; its auto-commit moves the head and A prefetches it.
 await converse(a,url,b.app.hostId,'work on B');
 assert.equal(calls.at(-1).label,'B');assert.equal(calls.at(-1).cwd,onB);
 await wait(async()=>(await a.api(url)).project.head?.hostId===b.app.hostId);
 await wait(()=>fs.readFile(path.join(p.path,'by-B.txt'),'utf8').then(()=>true,()=>false));
 assert.equal(await fs.readFile(path.join(p.path,'node_modules/pkg/index.js'),'utf8'),'windows build','ignored paths stay per host');
 // A file changed on A after the last commit (an upload, say) reaches B before B's next run.
 await wait(async()=>{const r=(await a.api(url)).project.replicas[a.app.hostId];return r.version===(await a.api(url)).project.head.id;});
 await converse(a,url,a.app.hostId,'work on A');
 await wait(async()=>(await b.api(url)).project.head?.hostId===a.app.hostId);
 await fs.writeFile(path.join(p.path,'web/index.html'),'<h1>edited on A</h1>');
 await converse(b,url,b.app.hostId,'again on B');
 assert.ok(calls.at(-1).files.includes('by-A.txt'));
 assert.equal(await fs.readFile(path.join(onB,'web/index.html'),'utf8'),'<h1>edited on A</h1>','the barrier asked A to commit, then pulled');
 // The sync view reports every copy; deleting B's copy needs confirmation and leaves a stub.
 const view=await a.api(url+'/sync');assert.deepEqual(Object.keys(view.replicas).sort(),[a.app.hostId,b.app.hostId].sort());
 await wait(async()=>{const s=await a.api(url+'/sync');return s.replicas[a.app.hostId].version===s.head.id;});
 assert.ok((await a.api(`${url}/replicas/${b.app.hostId}/footprint`)).files>=3);
 // Ownership moves only to an up-to-date copy; the old owner keeps an explicit entry.
 const moved=await b.api(url+'/sync','PATCH',{ownerHostId:b.app.hostId});
 assert.equal(moved.ownerHostId,b.app.hostId);assert.equal(moved.replicas[a.app.hostId].state,'ready');
 await wait(async()=>(await a.api(url)).project.ownerHostId===b.app.hostId);
 await a.api(url+'/sync','PATCH',{ownerHostId:a.app.hostId});
 await wait(async()=>(await a.api(url)).project.ownerHostId===a.app.hostId);
 await assert.rejects(a.api(`${url}/replicas/${b.app.hostId}`,'DELETE'),/confirmation/);
 await assert.rejects(a.api(`${url}/replicas/${a.app.hostId}?confirm=1`,'DELETE'),/owns this project/);
 await a.api(`${url}/replicas/${b.app.hostId}?confirm=1`,'DELETE');
 assert.deepEqual((await fs.readdir(onB)).sort(),['.studio']);
 assert.equal((await b.api('/api/projects')).find(x=>x.id===p.id).replica,false);
 await wait(async()=>!(await a.api(url)).project.replicas[b.app.hostId]);
});

test('changes made on a host that was behind are kept apart until the user picks a copy',async t=>{
 const {a,b}=await servers(t);
 const p=await a.api('/api/projects','POST',{name:'Diverge'}),url=`/api/projects/${p.id}`;
 await fs.writeFile(path.join(p.path,'notes.txt'),'v1');
 await wait(async()=>(await b.api('/api/projects')).some(x=>x.id===p.id&&!x.unavailable));
 await a.api(url+'/sync','PATCH',{enabled:true,prefetch:false});
 await wait(async()=>(await b.api(url)).project.head);
 await b.api(url+'/replicas','POST',{});
 await wait(async()=>(await b.api(url)).project.replicas[b.app.hostId]?.state==='ready');
 const onB=path.join(b.app.store.projectRoot,p.id);
 // Both change notes.txt; B commits first, so A is behind with its own edit.
 await fs.writeFile(path.join(onB,'notes.txt'),'B edit');await fs.writeFile(path.join(p.path,'notes.txt'),'A edit');
 await b.api(url+'/commit','POST',{});
 await wait(async()=>(await a.api(url)).project.head?.hostId===b.app.hostId);
 await assert.rejects(a.api(url+'/commit','POST',{}),/changed files while it was behind/);
 await wait(async()=>(await b.api(url)).project.diverged);
 assert.equal(await fs.readFile(path.join(p.path,'notes.txt'),'utf8'),'A edit','nothing is overwritten');
 // Runs are refused until the user keeps one copy; the other is overwritten with it.
 const s=await b.api(url+'/sessions','POST',{title:'blocked'});
 await b.api(url+'/messages','POST',{sessionId:s.id,requestId:randomUUID(),text:'x',profileId:'codex',model:'test',hostId:b.app.hostId});
 await wait(async()=>(await b.api(url)).runs.some(r=>r.status==='failed'&&/diverged/.test(r.error)));
 await b.api(url+'/resolve','POST',{hostId:a.app.hostId});
 await wait(async()=>(await fs.readFile(path.join(onB,'notes.txt'),'utf8'))==='A edit');
 await wait(async()=>{const x=(await b.api(url)).project;return !x.diverged&&x.replicas[b.app.hostId].version===x.head.id;});
});

test('a copy that is behind can be brought up to date on demand',async t=>{
 const {a,b}=await servers(t);
 const p=await a.api('/api/projects','POST',{name:'Pull'}),url=`/api/projects/${p.id}`;
 await fs.writeFile(path.join(p.path,'notes.txt'),'v1');
 await wait(async()=>(await b.api('/api/projects')).some(x=>x.id===p.id&&!x.unavailable));
 await assert.rejects(a.api(url+'/pull','POST',{hostId:b.app.hostId}),/not synced/);
 await a.api(url+'/sync','PATCH',{enabled:true,prefetch:false});
 await wait(async()=>(await b.api(url)).project.head);
 await assert.rejects(a.api(url+'/pull','POST',{hostId:b.app.hostId}),/has no copy yet/);
 await b.api(url+'/replicas','POST',{});
 await wait(async()=>(await a.api(url)).project.replicas[b.app.hostId]?.state==='ready');
 // A commits a change; without prefetch B stays behind until someone asks it to pull.
 await fs.writeFile(path.join(p.path,'notes.txt'),'v2');
 const head=await a.api(url+'/commit','POST',{});
 await wait(async()=>(await b.api(url)).project.head?.id===head.id);
 const onB=path.join(b.app.store.projectRoot,p.id);
 assert.equal(await fs.readFile(path.join(onB,'notes.txt'),'utf8'),'v1');
 assert.equal((await a.api(url+'/pull','POST',{hostId:b.app.hostId})).started,true,'asked from A, it runs on B');
 await wait(async()=>(await fs.readFile(path.join(onB,'notes.txt'),'utf8'))==='v2');
 await wait(async()=>(await a.api(url)).project.replicas[b.app.hostId].version===head.id);
});
