import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createStudio,fileVersion} from '../src/server.mjs';

// The side-pane editor: every read names the file's version, a save names the version it started
// from, and a save over a file that changed meanwhile (an agent edited it) is refused with the new version.
const wait=async(fn,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out');};
async function servers(t,count=1){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-edit-'));const apps=[];
 const make=async label=>{
  const app=await createStudio({stateDir:path.join(root,label,'state'),projectRoot:path.join(root,label,'projects'),port:0,previewPort:0,runner:{profiles:async()=>[{id:'codex',models:[{id:'test'}],available:true}],execute:async()=>({text:'ok'})}});
  apps.push(app);const base=`http://127.0.0.1:${app.port}`;
  const raw=(url,method='GET',data)=>fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
  const api=async(url,method,data)=>{const res=await raw(url,method,data);const result=await res.json();if(!res.ok)throw Object.assign(Error(result.error),{status:res.status,body:result});return result;};
  return {app,base,api,raw};
 };
 const list=[];for(let i=0;i<count;i++)list.push(await make('ABC'[i]));
 t.after(async()=>{for(const app of apps)await app.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
 return list;
}

test('reads carry a version; saves check it, refuse stale versions and protected paths',async t=>{
 const [a]=await servers(t);const p=await a.api('/api/projects','POST',{name:'Edit'}),url=`/api/projects/${p.id}`;
 await fs.writeFile(path.join(p.path,'notes.md'),'# Notes\n');
 const read=await a.api(`${url}/file?path=notes.md`);
 assert.equal(read.content,'# Notes\n');assert.equal(read.version,fileVersion(Buffer.from('# Notes\n')));assert.equal(read.size,8);assert.ok(Date.parse(read.mtime));
 const stat=await a.api(`${url}/file?path=notes.md&stat=1`);assert.deepEqual(Object.keys(stat).sort(),['mtime','path','size','version']);assert.equal(stat.version,read.version);
 const missing=await a.raw(`${url}/file?path=gone.md&stat=1`);assert.equal(missing.status,404);assert.equal((await missing.json()).code,'missing');
 const saved=await a.api(`${url}/file`,'PUT',{path:'notes.md',content:'# Notes\n\nmore\n',version:read.version});
 assert.equal(await fs.readFile(path.join(p.path,'notes.md'),'utf8'),'# Notes\n\nmore\n');assert.equal(saved.version,fileVersion(Buffer.from('# Notes\n\nmore\n')));
 // An agent changes the file: a save from the old version is refused and names the current one.
 await fs.writeFile(path.join(p.path,'notes.md'),'agent wrote this\n');
 const stale=await a.raw(`${url}/file`,'PUT',{path:'notes.md',content:'mine',version:saved.version});
 assert.equal(stale.status,409);const conflict=await stale.json();assert.equal(conflict.code,'conflict');assert.equal(conflict.version,fileVersion(Buffer.from('agent wrote this\n')));
 assert.equal(await fs.readFile(path.join(p.path,'notes.md'),'utf8'),'agent wrote this\n');
 // Keeping one's own text means saving again against the version the conflict reported.
 await a.api(`${url}/file`,'PUT',{path:'notes.md',content:'mine',version:conflict.version});assert.equal(await fs.readFile(path.join(p.path,'notes.md'),'utf8'),'mine');
 // version null creates a file and only when it does not exist.
 const created=await a.api(`${url}/file`,'PUT',{path:'docs/new.txt',content:'hello',version:null});assert.equal(created.version,fileVersion(Buffer.from('hello')));
 await assert.rejects(a.api(`${url}/file`,'PUT',{path:'docs/new.txt',content:'again',version:null}),e=>e.status===409&&e.body.version===created.version);
 await assert.rejects(a.api(`${url}/file`,'PUT',{path:'.studio/state.json',content:'{}',version:null}),e=>e.status===403);
 await assert.rejects(a.api(`${url}/file`,'PUT',{path:'sub/.git/config',content:'',version:null}),e=>e.status===403);
 await assert.rejects(a.api(`${url}/file`,'PUT',{path:'../escape.txt',content:'',version:null}),e=>e.status===400);
 await assert.rejects(a.api(`${url}/file`,'PUT',{path:'big.txt',content:'x'.repeat(1024*1024+1),version:null}),e=>e.status===413);
 await assert.rejects(a.api(`${url}/file`,'PUT',{path:'notes.md',content:7,version:null}),e=>e.status===413);
});

test('concurrent saves from the same version: exactly one wins',async t=>{
 const [a]=await servers(t);const p=await a.api('/api/projects','POST',{name:'Race'}),url=`/api/projects/${p.id}`;
 await fs.writeFile(path.join(p.path,'a.txt'),'base');const {version}=await a.api(`${url}/file?path=a.txt&stat=1`);
 const results=await Promise.all(['one','two','three'].map(content=>a.raw(`${url}/file`,'PUT',{path:'a.txt',content,version})));
 assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>r.status===409).length,2);
});

test('an archived project refuses edits',async t=>{
 const [a]=await servers(t);const p=await a.api('/api/projects','POST',{name:'Old'}),url=`/api/projects/${p.id}`;
 await fs.writeFile(path.join(p.path,'a.txt'),'x');const {version}=await a.api(`${url}/file?path=a.txt&stat=1`);
 await a.api(`${url}/lifecycle`,'POST',{action:'archive'});
 await assert.rejects(a.api(`${url}/file`,'PUT',{path:'a.txt',content:'y',version}),e=>e.status===409);
});

test('another server forwards reads and saves to the computer that holds the files, conflicts included',async t=>{
 const [a,b]=await servers(t,2);await a.api('/api/hosts','POST',{url:b.base});
 const p=await a.api('/api/projects','POST',{name:'Remote'}),url=`/api/projects/${p.id}`;
 await fs.writeFile(path.join(p.path,'readme.md'),'on A\n');
 await wait(async()=>(await b.api('/api/projects')).some(x=>x.id===p.id&&!x.unavailable));
 const read=await b.api(`${url}/file?path=readme.md`);assert.equal(read.content,'on A\n');assert.equal(read.version,fileVersion(Buffer.from('on A\n')));
 const saved=await b.api(`${url}/file`,'PUT',{path:'readme.md',content:'edited from B\n',version:read.version});
 assert.equal(await fs.readFile(path.join(p.path,'readme.md'),'utf8'),'edited from B\n');
 const stale=await b.raw(`${url}/file`,'PUT',{path:'readme.md',content:'late',version:read.version});
 assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:'文件已被修改',code:'conflict',version:saved.version});
 const missing=await b.raw(`${url}/file?path=nope.md&stat=1`);assert.equal(missing.status,404);assert.equal((await missing.json()).code,'missing');
});

test('bootstrap and identity name the server version and build',async t=>{
 const [a]=await servers(t);const boot=await a.api('/api/bootstrap'),id=await a.api('/api/identity');
 assert.match(boot.build,/^[0-9a-f]{16}$/);assert.equal(boot.version,JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version);
 assert.equal(id.build,boot.build);assert.equal(id.version,boot.version);
 const page=await fetch(a.base+'/artifact.html');assert.equal(page.headers.get('content-security-policy'),"frame-ancestors 'self'");
});

test('servers report their release, the desktop client release and each peer release',async t=>{
 const [a,b]=await servers(t,2);await a.api('/api/hosts','POST',{url:b.base});
 const pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')),client=JSON.parse(await fs.readFile(new URL('../desktop/src-tauri/tauri.conf.json',import.meta.url),'utf8'));
 const identity=await a.api('/api/identity');assert.equal(identity.version,pkg.version);assert.equal(identity.clientVersion,client.version);assert.match(identity.build,/^[0-9a-f]{16}$/);
 const boot=await a.api('/api/bootstrap');assert.equal(boot.version,pkg.version);
 assert.deepEqual(boot.hosts.map(h=>h.version),[pkg.version,pkg.version]);
 assert.deepEqual((await a.api('/api/hosts')).map(h=>[h.online,h.version]),[[true,pkg.version]]);
});
