// Since 0.2.5 every machine keeps its own copy of a project's files and Artifacts. An Artifact
// belongs to the machine whose copy declares it and runs there, from any server; the page picks whose
// copy it shows (?host=).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createStudio} from '../src/server.mjs';

async function servers(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-artifact-owner-'));const apps=[];
  const make=async label=>{
    const app=await createStudio({stateDir:path.join(root,label,'local'),projectRoot:path.join(root,label,'projects'),port:0,previewPort:0,runner:{profiles:async()=>[{id:'codex',models:[{id:'test'}],available:true}],execute:async()=>({text:label,nativeSessionId:'n-'+label})}});
    apps.push(app);const base=`http://127.0.0.1:${app.port}`;
    const api=async(url,method='GET',data)=>{const res=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const result=await res.json();if(!res.ok)throw Object.assign(Error(result.error),{status:res.status});return result;};
    return {app,base,api};
  };
  const a=await make('A'),b=await make('B');
  t.after(async()=>{for(const app of apps)await app.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});});
  const p=await a.api('/api/projects','POST',{name:'shared'});
  await fs.cp(p.path,path.join(b.app.store.projectRoot,p.id),{recursive:true});
  assert.equal((await a.api('/api/hosts','POST',{url:b.base,name:'B'})).mutual,true);
  await a.app.store.mutate(p.id,'project.allowed',s=>{s.project.allowedHostIds=[b.app.hostId];s.project.replicas[b.app.hostId]={state:'ready',at:new Date().toISOString()};});
  await b.app.store.discoverProjects();
  const url=`/api/projects/${p.id}`;await b.api(url);await a.api(url);
  return {a,b,p,url,copyA:p.path,copyB:path.join(b.app.store.projectRoot,p.id)};
}
const write=async(file,text)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);};

test('an Artifact declared in one machine\'s copy belongs to it and runs there from either server; the same key in another copy is that copy\'s own Artifact',async t=>{
  const {a,b,url,copyA,copyB}=await servers(t);
  await write(path.join(copyB,'lab/index.html'),'<h1>Lab on B</h1>');
  await write(path.join(copyB,'studio.artifacts.json'),JSON.stringify({artifacts:[{key:'lab',name:'Lab',root:'lab'}]}));
  // A's page asks every machine holding a copy, so B's Artifact shows up there at once.
  const seen=(await a.api(url)).artifacts;assert.deepEqual(seen.map(x=>[x.name,x.hostId]),[['Lab',b.app.hostId]]);
  const onB=seen[0],route=`${url}/artifacts/${onB.id}`;
  const live=await a.api(route+'/start','POST',{});assert.equal(live.hostId,b.app.hostId);
  assert.equal(a.app.artifacts.active.size,0);assert.equal(b.app.artifacts.active.size,1);
  await a.api(route+'/stop','POST',{});
  // A's own copy declaring the same key is A's Artifact, beside B's: neither replaces the other.
  await write(path.join(copyA,'lab/index.html'),'<h1>Lab on A</h1>');
  await write(path.join(copyA,'studio.artifacts.json'),JSON.stringify({artifacts:[{key:'lab',name:'Lab on A',root:'lab'}]}));
  const both=(await a.api(url)).artifacts;
  assert.deepEqual(both.map(x=>[x.name,x.hostId]).sort(),[['Lab',b.app.hostId],['Lab on A',a.app.hostId]].sort());
  const onA=both.find(x=>x.hostId===a.app.hostId);assert.notEqual(onA.id,onB.id);
  assert.equal((await a.api(`${url}/artifacts/${onA.id}/start`,'POST',{})).hostId,a.app.hostId);
  assert.equal((await b.api(`${url}/artifacts/${onB.id}/start`,'POST',{})).hostId,b.app.hostId);
  await a.api(`${url}/artifacts/${onA.id}/stop`,'POST',{});await b.api(`${url}/artifacts/${onB.id}/stop`,'POST',{});
  // A later read on A keeps both: B's manifest still speaks only for B's.
  assert.equal((await a.api(url)).artifacts.length,2);
  // An Artifact created through the API belongs to the machine that created it.
  await write(path.join(copyA,'mine/index.html'),'<h1>Mine</h1>');
  assert.equal((await a.api(url+'/artifacts','POST',{name:'Mine',root:'mine'})).hostId,a.app.hostId);
  // The transfer endpoint is gone (an agent copies files between machines itself).
  await assert.rejects(a.api(`${url}/artifacts/${onB.id}/transfer`,'POST',{hostId:a.app.hostId}),e=>e.status===404);
});

test('the project view lists each machine\'s copy with its folder, and file requests read the copy asked for',async t=>{
  const {a,b,url,copyA,copyB}=await servers(t);
  await write(path.join(copyA,'notes.md'),'A notes');await write(path.join(copyB,'notes.md'),'B notes');await write(path.join(copyB,'only-b.txt'),'b');
  const view=await a.api(url);
  assert.deepEqual(view.copies.map(c=>c.hostId),[a.app.hostId,b.app.hostId]);
  assert.equal(view.copies[0].path,copyA);assert.equal(path.resolve(view.copies[1].path),path.resolve(copyB));assert.ok(view.copies.every(c=>c.online));
  const names=list=>list.map(e=>e.name).sort();
  assert.ok(!names(await a.api(url+'/files')).includes('only-b.txt'));
  assert.ok(names(await a.api(`${url}/files?host=${b.app.hostId}`)).includes('only-b.txt'));
  assert.equal((await a.api(`${url}/file?path=notes.md&host=${b.app.hostId}`)).content,'B notes');
  assert.equal((await b.api(`${url}/file?path=notes.md&host=${a.app.hostId}`)).content,'A notes');
  // Edits are saved into the copy asked for.
  const saved=await fetch(`${a.base}${url}/file?host=${b.app.hostId}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'notes.md',content:'B notes, edited',version:(await a.api(`${url}/file?path=notes.md&host=${b.app.hostId}`)).version})});assert.equal(saved.status,200);
  assert.equal(await fs.readFile(path.join(copyB,'notes.md'),'utf8'),'B notes, edited');assert.equal(await fs.readFile(path.join(copyA,'notes.md'),'utf8'),'A notes');
  // Uploads go into the copy asked for.
  const res=await fetch(`${a.base}${url}/uploads?name=up.txt&host=${b.app.hostId}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:'hi'});assert.equal(res.status,201);
  assert.equal(await fs.readFile(path.join(copyB,'uploads/up.txt'),'utf8'),'hi');
  await assert.rejects(fs.stat(path.join(copyA,'uploads/up.txt')));
  // A machine without a copy is refused.
  await assert.rejects(a.api(`${url}/files?host=cccccccc-0000-4000-8000-00000000000c`),e=>e.status===404&&/没有这个项目的副本/.test(e.message));
});
