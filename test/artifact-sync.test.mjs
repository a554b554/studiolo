import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import vm from 'node:vm';
import {randomUUID,webcrypto} from 'node:crypto';
import {createStudio} from '../src/server.mjs';
import {ArtifactStorage} from '../src/artifact-storage.mjs';
import {previewClient} from './preview-client.mjs';

async function copyPublished(source,dest){
  await fs.mkdir(dest,{recursive:true});
  for(const entry of await fs.readdir(source,{withFileTypes:true})){
    if(entry.name.endsWith('.tmp'))continue;
    const from=path.join(source,entry.name),to=path.join(dest,entry.name);
    if(entry.isDirectory())await copyPublished(from,to);else await fs.copyFile(from,to);
  }
}

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-artifact-sync-')),calls=[],apps=[];
  t.after(async()=>{for(const app of apps)await app.close();await fs.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});});
  async function make(label){
    const app=await createStudio({stateDir:path.join(root,label,'state'),projectRoot:path.join(root,label,'projects'),port:0,previewPort:0,runner:{profiles:async()=>[{id:'fake',available:true,models:[{id:'test'}]}],execute:async options=>{calls.push({label,...options});return {text:label,nativeSessionId:'native-'+label};}}});apps.push(app);
    const api=async(route,input)=>{const response=await fetch(`http://127.0.0.1:${app.port}${route}`,{method:input===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error),{status:response.status});return data;};return {app,api};
  }
  const a=await make('A'),b=await make('B'),p=await a.api('/api/projects',{name:'Synced Artifact'}),base=`/api/projects/${p.id}`,copy=path.join(b.app.store.projectRoot,p.id);
  async function sync(from=a,to=b){const source=from===a?p.path:copy,dest=to===a?p.path:copy;await copyPublished(source,dest);await to.app.store.discoverProjects();}
  await sync();return {a,b,p,base,copy,sync,calls,root};
}
const save=(client,ops,id=randomUUID())=>client.request('/__studio/storage',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Storage':'1'},body:JSON.stringify({id,ops})});
const read=async client=>(await(await client.request('/__studio/storage')).json()).data;

test('manifest metadata is visible on both hosts before assets arrive and becomes runnable without re-registration',async t=>{
  const {a,b,p,base,copy,sync}=await fixture(t);
  await fs.mkdir(path.join(p.path,'ready'));await fs.writeFile(path.join(p.path,'ready/index.html'),'<h1>Ready</h1>');
  await fs.writeFile(path.join(p.path,'studio.artifacts.json'),JSON.stringify({artifacts:[{key:'ready',name:'Ready',root:'ready'},{key:'later',name:'Later',root:'not-yet-synced/deep'}]}));
  const state=await a.api(base);assert.equal(state.artifacts.length,2);assert.equal(state.artifactDiscoveryError,undefined);
  const later=state.artifacts.find(a=>a.manifestKey==='later'),route=`${base}/artifacts/${later.id}`;
  await sync();assert.deepEqual((await b.api(base)).artifacts,state.artifacts);
  assert.equal((await b.api(route+'/status')).filesReady,false);
  await assert.rejects(b.api(route+'/start',{}),e=>e.status===409&&/Syncthing/.test(e.message));
  await fs.mkdir(path.join(p.path,'not-yet-synced/deep'),{recursive:true});await fs.writeFile(path.join(p.path,'not-yet-synced/deep/index.html'),'<h1>Arrived</h1>');await sync();
  assert.equal((await b.api(route+'/status')).filesReady,true);
  const live=await b.api(route+'/start',{});assert.equal(live.hostId,b.app.hostId);assert.match(await(await(await previewClient(live)).request()).text(),/Arrived/);
  assert.equal((await a.api(route+'/status')).running,false);
  for(const input of [{root:'../escape'},{root:'C:\\escape'},{root:'.',entry:'../escape'},{root:'.',dataPaths:['.studio/events']}])await assert.rejects(a.api(base+'/artifacts',{name:'bad',...input}));
});

test('manual Artifact, code edits, browser saves, deletes and snapshots survive file synchronization in both directions',async t=>{
  const {a,b,p,base,copy,sync}=await fixture(t);
  await fs.mkdir(path.join(p.path,'web'));await fs.writeFile(path.join(p.path,'web/index.html'),'<h1>Version A</h1>');
  const artifact=await a.api(base+'/artifacts',{name:'Manual',root:'web'}),route=`${base}/artifacts/${artifact.id}`;
  await sync();assert.equal((await b.api(base)).artifacts[0].id,artifact.id);
  const liveA=await a.api(route+'/start',{}),liveB=await b.api(route+'/start',{});let ca=await previewClient(liveA),cb=await previewClient(liveB);
  assert.notEqual(liveA.previewPort,liveB.previewPort);
  const requestId=randomUUID();assert.equal((await save(ca,[{type:'set',key:'progress',value:'A'}],requestId)).status,200);
  assert.equal((await save(ca,[{type:'set',key:'progress',value:'A'}],requestId)).status,200);
  assert.equal((await save(ca,[{type:'set',key:'progress',value:'wrong'}],requestId)).status,409);
  await sync();assert.deepEqual(await read(cb),{progress:'A'});
  await save(cb,[{type:'set',key:'progress',value:'B'}]);await fs.writeFile(path.join(copy,'web/index.html'),'<h1>Version B</h1>');await sync(b,a);
  assert.deepEqual(await read(ca),{progress:'B'});assert.match(await(await ca.request()).text(),/Version B/);
  await save(ca,[{type:'set',key:'fromA',value:'one'}]);await save(cb,[{type:'set',key:'fromB',value:'two'}]);await sync();await sync(b,a);
  assert.deepEqual(await read(ca),await read(cb));assert.deepEqual(await read(ca),{progress:'B',fromA:'one',fromB:'two'});
  await save(cb,[{type:'remove',key:'progress'}]);await sync(b,a);await save(ca,[{type:'import',key:'progress',value:'old browser'}]);assert.equal((await read(ca)).progress,undefined);
  const snap=await a.api(route+'/snapshot',{});ca=await previewClient(await a.api(route+'/start',{}));await save(ca,[{type:'clear'}]);
  await a.api(route+'/restore',snap);ca=await previewClient(await a.api(route+'/start',{}));assert.deepEqual(await read(ca),{fromA:'one',fromB:'two'});
  await sync();assert.deepEqual(await read(cb),{fromA:'one',fromB:'two'});
  assert.equal((await cb.request('/__studio/storage',{method:'POST',body:'{}'})).status,403);
  assert.equal((await fetch(new URL('/__studio/storage',liveB.url))).status,401);
});

test('Artifact comments and replies execute on the current web server, including replies to the other machine comments',async t=>{
  const {a,b,p,base,sync,calls,copy}=await fixture(t);
  await fs.mkdir(path.join(p.path,'web'));await fs.writeFile(path.join(p.path,'web/index.html'),'<h1>Comments</h1>');
  const artifact=await a.api(base+'/artifacts',{name:'Comments',root:'web'}),route=`${base}/artifacts/${artifact.id}`;await sync();
  await a.api(route+'/start',{});await b.api(route+'/start',{});
  const input={profileId:'fake',model:'test',text:'Comment',anchor:{kind:'page'}};
  const comment=await a.api(route+'/annotations',{...input,requestId:randomUUID(),hostId:a.app.hostId});
  while(!(await a.app.store.read(p.id)).runs.every(r=>r.status==='succeeded'))await new Promise(r=>setTimeout(r,20));
  await sync();const reply=await b.api(base+'/messages',{...input,text:'Reply on B',artifactId:artifact.id,annotationId:comment.annotation.id,requestId:randomUUID(),hostId:b.app.hostId});
  while(!(await b.app.store.read(p.id)).runs.every(r=>r.status==='succeeded'))await new Promise(r=>setTimeout(r,20));
  assert.equal(comment.run.hostId,a.app.hostId);assert.equal(reply.hostId,b.app.hostId);assert.equal(calls[0].cwd,p.path);assert.equal(calls[1].cwd,copy);
  await assert.rejects(b.api(route+'/annotations',{...input,requestId:randomUUID(),hostId:a.app.hostId}),e=>e.status===409);
  await assert.rejects(b.api(base+'/messages',{...input,artifactId:artifact.id,annotationId:comment.annotation.id,requestId:randomUUID(),hostId:a.app.hostId}),e=>e.status===409);
  await a.api(route+'/stop',{});assert.equal((await b.api(route+'/status')).running,true);
});

test('SQLite backend data uses the same project-relative path after stopping, syncing and starting on the other host',async t=>{
  const {a,b,p,base,sync}=await fixture(t);
  await fs.cp(new URL('../examples/persistent-game/',import.meta.url),path.join(p.path,'game'),{recursive:true});
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const artifact=await a.api(base+'/artifacts',{name:'SQLite',root:'game',command:['node','server.mjs'],port,dataPaths:['game/data']}),route=`${base}/artifacts/${artifact.id}`;
  const ca=await previewClient(await a.api(route+'/start',{}));await ca.request('/api/scores',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({score:42})});await a.api(route+'/stop',{});await sync();
  const cb=await previewClient(await b.api(route+'/start',{}));assert.equal((await(await cb.request('/api/scores')).json())[0].score,42);
  await cb.request('/api/scores',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({score:73})});await b.api(route+'/stop',{});await sync(b,a);
  const again=await previewClient(await a.api(route+'/start',{}));assert.deepEqual((await(await again.request('/api/scores')).json()).map(x=>x.score),[73,42]);
});

test('browser storage bridge imports old saves, persists after an idle flush, and retries its durable outbox',async t=>{
  const {root}=await fixture(t),aid=randomUUID(),backend=new ArtifactStorage(),source=await fs.readFile(new URL('../public/artifact-storage.js',import.meta.url),'utf8');
  const nativeData=new Map([['legacy','old']]),native={get length(){return nativeData.size;},key:i=>[...nativeData.keys()][i]??null,getItem:key=>nativeData.get(key)??null,setItem:(key,value)=>nativeData.set(key,value),removeItem:key=>nativeData.delete(key)};
  let fail=false;const notices=[],listeners={};
  const parent={postMessage:message=>notices.push(message)};
  const seed=await backend.read(root,aid);
  const context={console,crypto:webcrypto,Blob,DOMException,setTimeout,clearTimeout,queueMicrotask,parent,localStorage:native,__STUDIO_STORAGE__:{id:aid,data:seed.data,touched:[...seed.touched]},__STUDIO_BRIDGE__:{nonce:'test',parentOrigin:'http://studio'},addEventListener:(type,fn)=>listeners[type]=fn,fetch:async(url,options)=>{if(fail)throw Error('offline');const input=JSON.parse(options.body);for(const batch of input.batches||[input])await backend.save(root,aid,batch);return {ok:true};}};
  context.window=context;vm.runInNewContext(source,context);
  const flush=async()=>{await listeners.message({source:parent,origin:'http://studio',data:{type:'studio:storage-flush',nonce:'test',id:'flush'}});};
  await flush();assert.equal((await backend.read(root,aid)).data.legacy,'old');
  context.localStorage.setItem('progress','first');context.localStorage.extra='property';await flush();assert.equal((await backend.read(root,aid)).data.progress,'first');assert.equal((await backend.read(root,aid)).data.extra,'property');
  fail=true;context.localStorage.setItem('progress','retry');await flush();assert.ok([...nativeData.keys()].some(key=>key.startsWith('__studio_outbox_')));assert.equal(notices.at(-1).saved,false);
  fail=false;await flush();assert.equal((await backend.read(root,aid)).data.progress,'retry');assert.ok(![...nativeData.keys()].some(key=>key.startsWith('__studio_outbox_')));
  context.localStorage.removeItem('legacy');await flush();await backend.save(root,aid,{id:randomUUID(),ops:[{type:'import',key:'legacy',value:'stale'}]});assert.equal((await backend.read(root,aid)).data.legacy,undefined);
  context.localStorage.clear();await flush();assert.deepEqual((await backend.read(root,aid)).data,{});
});
