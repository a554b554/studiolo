import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createStudio} from '../src/server.mjs';

// Plan P2.7: two servers whose project roots share nothing. Everything one server knows about a
// project reaches the other over HTTP (host index + journal), and file work goes to the owner.
const wait=async(fn,ms=12000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+fn.toString().slice(0,90));};
async function servers(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-disjoint-'));const calls=[],apps=[];
 const make=async label=>{
  const app=await createStudio({stateDir:path.join(root,label,'state'),projectRoot:path.join(root,label,'projects'),port:0,previewPort:0,runner:{profiles:async()=>[{id:'codex',models:[{id:'test'}],available:true}],execute:async o=>{calls.push({label,cwd:o.cwd,prompt:o.prompt});await o.onEvent({type:'text',text:'done on '+label});return {text:'done on '+label,nativeSessionId:'native-'+label};}}});
  apps.push(app);const base=`http://127.0.0.1:${app.port}`;
  const raw=(url,init={})=>fetch(base+url,init);
  const api=async(url,method='GET',data)=>{const res=await raw(url,{method,headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const result=await res.json();if(!res.ok)throw Object.assign(Error(result.error),{status:res.status});return result;};
  return {app,base,api,raw};
 };
 const a=await make('A'),b=await make('B');
 t.after(async()=>{for(const app of apps)await app.close();await fs.rm(root,{recursive:true,force:true});});
 await a.api('/api/hosts','POST',{url:b.base});
 return {a,b,calls};
}

test('servers with disjoint project roots share projects, conversations, artifacts, deletions and settings',async t=>{
 const {a,b,calls}=await servers(t);
 const p=await a.api('/api/projects','POST',{name:'Only on A'});
 await fs.mkdir(path.join(p.path,'web'));await fs.writeFile(path.join(p.path,'web/index.html'),'<h1>A files</h1>');
 // Created on A, visible on B as a metadata stub without any of A's files.
 await wait(async()=>(await b.api('/api/projects')).some(x=>x.id===p.id&&!x.unavailable));
 const onB=(await b.api('/api/projects')).find(x=>x.id===p.id);
 assert.equal(onB.name,'Only on A');assert.equal(onB.ownerHostId,a.app.hostId);assert.equal(onB.replica,false);
 assert.deepEqual((await fs.readdir(onB.path)).sort(),['.studio']);
 assert.deepEqual((await fs.readdir(path.join(onB.path,'.studio'))).sort(),['events','stub'],'a stub derives no history views');
 // File browsing, uploads and artifact creation from B go to the owner.
 const url=`/api/projects/${p.id}`;
 assert.deepEqual((await b.api(url+'/files')).map(f=>f.name),['.studio','web']);
 assert.equal((await b.api(url+'/file?path=web/index.html')).content,'<h1>A files</h1>');
 const uploaded=await (await b.raw(url+'/uploads?name=note.txt',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:'from B'})).json();
 assert.equal(await fs.readFile(path.join(p.path,uploaded.path),'utf8'),'from B');
 await assert.rejects(fs.stat(path.join(onB.path,uploaded.path)),{code:'ENOENT'});
 const art=await b.api(url+'/artifacts','POST',{name:'Preview',root:'web'});
 await wait(async()=>(await b.api(url)).artifacts.some(x=>x.id===art.id));
 assert.ok((await a.api(url)).artifacts.some(x=>x.id===art.id));
 // A conversation created on B and bound to A runs on A, in A's folder, with B's upload attached.
 const s=await b.api(url+'/sessions','POST',{title:'From B'});
 await b.api(url+'/messages','POST',{sessionId:s.id,requestId:randomUUID(),text:'hello',attachments:[uploaded.path],profileId:'codex',model:'test',hostId:a.app.hostId});
 await wait(()=>calls.length===1);assert.equal(calls[0].label,'A');assert.equal(calls[0].cwd,p.path);
 await wait(async()=>(await b.api(url)).messages.some(m=>m.role==='assistant'&&m.text==='done on A'));
 // Shared settings changed on B reach A (last writer wins).
 await b.api('/api/settings/subagents','PUT',{enabled:true,rules:'Use the cheapest account first.'});
 await wait(async()=>(await a.api('/api/settings/subagents')).rules==='Use the cheapest account first.');
 // Deleted on A, gone on B: the tombstone travels in the index and B's purger drops the stub.
 await wait(async()=>(await a.api(url)).runs.every(r=>!['queued','running','waiting'].includes(r.status)));
 await a.api(url+'/lifecycle','POST',{action:'delete'});
 await wait(async()=>!(await b.api('/api/projects')).some(x=>x.id===p.id));
 await wait(()=>fs.stat(onB.path).then(()=>false,e=>e.code==='ENOENT'));
 assert.ok(JSON.parse(await fs.readFile(path.join(b.app.store.projectRoot,'.deleted',p.id+'.json'),'utf8')).deletedAt);
});

test('file requests for a project whose owner is offline fail with its name while its metadata stays readable',async t=>{
 const {a,b}=await servers(t);
 const p=await a.api('/api/projects','POST',{name:'Owner goes away'});
 await wait(async()=>(await b.api('/api/projects')).some(x=>x.id===p.id&&!x.unavailable));
 await new Promise(r=>a.app.server.close(r));b.app.hosts.cache=null;
 await assert.rejects(b.api(`/api/projects/${p.id}/files`),e=>e.status===503&&/offline/.test(e.message));
 assert.equal((await b.api(`/api/projects/${p.id}`)).project.name,'Owner goes away','metadata stays readable');
});
