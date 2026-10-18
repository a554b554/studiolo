import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStudio} from '../src/server.mjs';
import {previewClient} from './preview-client.mjs';

const runner={profiles:async()=>[{id:'fake',label:'test',available:true,models:[{id:'test',label:'Test'}]}],execute:async({onEvent})=>{onEvent({type:'text',text:'test output'});return {text:'test output',nativeSessionId:'test-native'}}};
test('unsupported Haiku auto requests do not bind drafts, enqueue work or create annotations',async t=>{
 let calls=0;
 const haiku={profiles:async()=>[{id:'claude1',available:true,models:[{id:'claude-haiku-4-5-20251001'}]}],execute:async()=>{calls++;return {text:'ok'};}};
 const {api,app}=await setup(t,{runner:haiku});const p=await api('/api/projects','POST',{name:'Haiku'}),root=`/api/projects/${p.id}`;
 const s=await api(root+'/sessions','POST',{title:'Explicit permissions'});
 const input={sessionId:s.id,requestId:'haiku-auto',text:'hello',profileId:'claude1',model:'claude-haiku-4-5-20251001'};
 for(const permissionMode of [undefined,'auto'])await assert.rejects(api(root+'/messages','POST',{...input,permissionMode}),e=>e.status===400&&/Haiku/.test(e.message));
 await assert.rejects(api(root+`/sessions/${s.id}/bind`,'POST',input),e=>e.status===400);
 await assert.rejects(api(root+'/artifacts/test/annotations','POST',input),e=>e.status===400);
 const state=await app.store.read(p.id);assert.equal(state.sessions[0].hostId,undefined);assert.equal(state.runs.length,0);assert.equal(state.annotations.length,0);assert.equal(calls,0);
 await api(root+'/messages','POST',{...input,permissionMode:'read-only'});
 assert.equal((await app.store.read(p.id)).sessions[0].hostId,app.hostId);
});

test('conversation rename validates input and persists a manual title',async t=>{
 const {api,app}=await setup(t);const p=await api('/api/projects','POST',{name:'rename'});
 const s=await api(`/api/projects/${p.id}/sessions`,'POST',{}),route=`/api/projects/${p.id}/sessions/${s.id}`;
 assert.equal(s.titleSource,'pending');
 for(const title of ['', '   ', 123, 'a\nb', 'x'.repeat(121)])await assert.rejects(api(route,'PATCH',{title}),e=>e.status===400);
 await api(route,'PATCH',{title:'  我的标题  '});
 const state=await app.store.read(p.id);assert.equal(state.sessions[0].title,'我的标题');assert.equal(state.sessions[0].titleSource,'manual');
 assert.match(await fs.readFile(path.join(p.path,'.studio','sessions',s.id+'.md'),'utf8'),/^# 我的标题/);
 await assert.rejects(api(`/api/projects/${p.id}/sessions/missing`,'PATCH',{title:'test'}),e=>e.status===404);
});
test('managed project creation rejects arbitrary paths and no longer exposes host folder browsing',async t=>{
 const {api,dir}=await setup(t);
 const project=await api('/api/projects','POST',{name:'../同名 project'});
 assert.equal(path.dirname(project.path),await fs.realpath(path.join(dir,'projects')));
 assert.equal(path.basename(project.path),project.id);
 const second=await api('/api/projects','POST',{name:project.name});assert.notEqual(second.path,project.path);
 for(const target of [path.join(dir,'outside'),'../escape','',null])
  await assert.rejects(api('/api/projects','POST',{name:'bad',path:target}),e=>e.status===400);
 await assert.rejects(api('/api/directories'),e=>e.status===404);
 await assert.rejects(fs.stat(path.join(dir,'outside')),e=>e.code==='ENOENT');
 assert.ok((await fs.stat(path.join(project.path,'.studio','history-index.md'))).isFile());
});
test('Markdown previews read project images through a sandboxed raw route',async t=>{
 const {api,base}=await setup(t);const p=await api('/api/projects','POST',{name:'images'}),root=`${base}/api/projects/${p.id}`;
 await fs.mkdir(path.join(p.path,'docs'),{recursive:true});
 await fs.writeFile(path.join(p.path,'docs','pic.svg'),'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
 await fs.writeFile(path.join(p.path,'notes.txt'),'text');
 const res=await fetch(`${root}/raw?path=docs/pic.svg`);
 assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'image/svg+xml');
 assert.match(res.headers.get('content-security-policy'),/sandbox/);assert.equal(res.headers.get('x-content-type-options'),'nosniff');
 assert.match(await res.text(),/<svg/);
 assert.equal((await fetch(`${root}/raw?path=docs/pic.svg`,{headers:{'If-None-Match':res.headers.get('etag')}})).status,304);
 assert.equal((await fetch(`${root}/raw?path=notes.txt`)).status,415);
 for(const target of ['../state/machine.png','docs/missing.png'])assert.ok(!(await fetch(`${root}/raw?path=${target}`)).ok,target);
});
async function setup(t,options={}){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-http-'));const app=await createStudio({stateDir:path.join(dir,'state'),projectRoot:path.join(dir,'projects'),port:0,previewPort:0,runner,...options});t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});const base=`http://127.0.0.1:${app.port}`;async function api(p,method='GET',data,headers={}){const res=await fetch(base+p,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):undefined});const payload=await res.json();if(!res.ok)throw Object.assign(new Error(payload.error),{status:res.status});return payload;}return {app,api,base,dir};}
test('HTTP project, session, run idempotency and path bounds',async t=>{const {api}=await setup(t);const project=await api('/api/projects','POST',{name:'test'});const session=await api(`/api/projects/${project.id}/sessions`,'POST',{title:'one'});const input={requestId:'one',sessionId:session.id,text:'hi',profileId:'fake',model:'test'};const run=await api(`/api/projects/${project.id}/messages`,'POST',input);assert.equal((await api(`/api/projects/${project.id}/messages`,'POST',input)).id,run.id);await assert.rejects(()=>api(`/api/projects/${project.id}/file?path=../machine.json`),/范围/);await assert.rejects(()=>api('/api/projects','POST',{name:'attack'},{Origin:'https://evil.example'}),e=>e.status===403);});
test('token required and session cookie auth',async t=>{const {api,base}=await setup(t,{token:'secret-test-only'});await assert.rejects(()=>api('/api/bootstrap'),e=>e.status===401);assert.ok((await api('/api/bootstrap','GET',undefined,{Authorization:'Bearer secret-test-only'})).hostId);const res=await fetch(base+'/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'secret-test-only'})});assert.equal(res.status,200);const cookie=res.headers.get('set-cookie').split(';')[0];assert.ok((await api('/api/bootstrap','GET',undefined,{Cookie:cookie})).hostId);});
test('artifact isolated preview, annotation persists, snapshot restore',async t=>{const {api}=await setup(t);const project=await api('/api/projects','POST',{name:'artifact'});await fs.mkdir(path.join(project.path,'web'));await fs.mkdir(path.join(project.path,'data'));await fs.writeFile(path.join(project.path,'web/index.html'),'<!doctype html><html><meta charset="utf-8"><body><button id="test">Test</button></body></html>');await fs.writeFile(path.join(project.path,'data/save.json'),'1');const a=await api(`/api/projects/${project.id}/artifacts`,'POST',{name:'test',root:'web',dataPaths:['data']});const live=await api(`/api/projects/${project.id}/artifacts/${a.id}/start`,'POST',{});assert.ok(live.url.includes('/p/'));const html=await (await (await previewClient(live)).request()).text();assert.ok(html.includes('__STUDIO_BRIDGE__'));assert.ok(html.startsWith('<!doctype html>'));assert.ok(!html.includes('<base'));assert.ok(html.includes('<head><script'));const item=await api(`/api/projects/${project.id}/artifacts/${a.id}/annotations`,'POST',{requestId:'annotation-1',text:'Change',anchor:{selector:'#test'},profileId:'fake',model:'test'});await api(`/api/projects/${project.id}/annotations/${item.annotation.id}`,'PATCH',{anchorStatus:'orphaned'});assert.equal((await api(`/api/projects/${project.id}`)).annotations[0].status,'open');const snap=await api(`/api/projects/${project.id}/artifacts/${a.id}/snapshot`,'POST',{});await fs.writeFile(path.join(project.path,'data/save.json'),'2');await api(`/api/projects/${project.id}/artifacts/${a.id}/restore`,'POST',snap);assert.equal(await fs.readFile(path.join(project.path,'data/save.json'),'utf8'),'1');assert.equal((await fetch(live.url)).status,404);});
test('project histories are local and project takeover is no longer available',async t=>{
 const a=await setup(t),b=await setup(t);const p=await b.api('/api/projects','POST',{name:'shared'});
 await fs.cp(p.path,path.join(a.dir,'projects',p.id),{recursive:true});
 assert.equal((await a.api(`/api/projects/${p.id}`)).project.id,p.id);
 await assert.rejects(a.api(`/api/projects/${p.id}/takeover`,'POST',{confirm:true}),e=>e.status===409);
 const s=await a.api(`/api/projects/${p.id}/sessions`,'POST',{});assert.equal(s.createdHostId,a.app.hostId);
});

test('artifact manifest discovery preserves stable IDs and validates data paths',async t=>{const {api}=await setup(t);const p=await api('/api/projects','POST',{name:'manifest'});await fs.mkdir(path.join(p.path,'web'));await fs.writeFile(path.join(p.path,'web/index.html'),'<h1>Manifest</h1>');const manifest={artifacts:[{key:'demo',name:'自动作品',root:'web'}]};const file=path.join(p.path,'studio.artifacts.json');await fs.writeFile(file,JSON.stringify(manifest));let state=await api(`/api/projects/${p.id}`);assert.equal(state.artifacts.length,1);const id=state.artifacts[0].id;manifest.artifacts[0].name='作品更新';await fs.writeFile(file,JSON.stringify(manifest));state=await api(`/api/projects/${p.id}`);assert.equal(state.artifacts[0].id,id);assert.equal(state.artifacts[0].name,'作品更新');assert.equal((await api(`/api/projects/${p.id}`)).artifacts.length,1);await fs.writeFile(file,'{');state=await api(`/api/projects/${p.id}`);assert.ok(state.artifactDiscoveryError);assert.equal(state.artifacts.length,1);for(const dataPaths of [['.'],['.studio'],['web/../.studio/events']])await assert.rejects(()=>api(`/api/projects/${p.id}/artifacts`,'POST',{name:'invalid',root:'web',dataPaths}),/路径/);await assert.rejects(()=>api(`/api/projects/${p.id}/artifacts/${id}/annotations`,'POST',{requestId:'wrong-host',text:'修改',profileId:'fake',model:'test',hostId:'other'}),e=>e.status===409);});

test('failed duplicate service start does not execute pending project work',async t=>{let executions=0;const fake={...runner,execute:async()=>{executions++;return {text:'unexpected'};}};const {app,api}=await setup(t,{runner:fake});const p=await api('/api/projects','POST',{name:'pending'});const session=await api(`/api/projects/${p.id}/sessions`,'POST',{});await app.store.mutate(p.id,'test.pending',s=>{s.runs.push({id:'queued-test',requestId:'queued-test',queueId:'session:'+session.id,sessionId:session.id,status:'queued',text:'do not run',profileId:'fake',model:'test',hostId:app.hostId});});await assert.rejects(()=>createStudio({stateDir:app.stateDir,projectRoot:app.store.projectRoot,port:app.port,previewPort:0,runner:fake}),e=>e.code==='EADDRINUSE');assert.equal(executions,0);assert.equal((await app.store.read(p.id)).runs[0].status,'queued');});

test('settings archives restore; deleted conversations are removed and cannot be recovered',async t=>{
 const {api,app}=await setup(t);const p=await api('/api/projects','POST',{name:'lifecycle'}),base=`/api/projects/${p.id}`;
 const s=await api(`${base}/sessions`,'POST',{title:'keep history'}),route=`${base}/sessions/${s.id}/lifecycle`;
 await fs.writeFile(path.join(p.path,'keep.txt'),'user source');
 await app.store.mutate(p.id,'test.history',state=>{state.messages.push({id:'m',sessionId:s.id,role:'user',text:'keep conversation',createdAt:new Date().toISOString()});state.runs.push({id:'finished',sessionId:s.id,status:'succeeded'});state.nativeSessions[`host:claude:${s.id}`]='native';state.queues[`session:${s.id}`]={paused:false};});
 await api(route,'POST',{action:'archive'});assert.ok((await api(base)).sessions[0].archivedAt);
 assert.equal((await api('/api/archives')).sessions[0].id,s.id);
 await assert.rejects(()=>api(`${base}/messages`,'POST',{requestId:'no-run',sessionId:s.id,text:'hi',profileId:'fake',model:'test'}),e=>e.status===409);
 await api(route,'POST',{action:'restore'});assert.equal((await api(base)).messages[0].text,'keep conversation');
 assert.equal((await api('/api/archives')).sessions.length,0);
 await api(route,'POST',{action:'delete'});
 const state=await api(base);assert.equal(state.sessions.length,0);assert.equal(state.messages.length,0);assert.equal(state.runs.length,0);assert.deepEqual(state.nativeSessions,{});assert.deepEqual(state.queues,{});
 await assert.rejects(()=>api(route,'POST',{action:'restore'}),e=>e.status===404);
 for(const suffix of ['.md','.operations.md'])await assert.rejects(()=>fs.access(path.join(p.path,'.studio/sessions',s.id+suffix)),e=>e.code==='ENOENT');
 assert.ok(!(await fs.readFile(path.join(p.path,'.studio/history-index.md'),'utf8')).includes('keep history'));
 await api(`${base}/lifecycle`,'POST',{action:'archive'});assert.equal((await api('/api/archives')).projects[0].id,p.id);
 await assert.rejects(()=>api(`${base}/sessions`,'POST',{title:'denied'}),e=>e.status===409);
 await api(`${base}/lifecycle`,'POST',{action:'restore'});assert.equal((await api('/api/archives')).projects.length,0);
 await api(`${base}/lifecycle`,'POST',{action:'delete'});assert.equal((await api('/api/archives')).projects.length,0);
 await assert.rejects(()=>api(`${base}/lifecycle`,'POST',{action:'restore'}),e=>e.status===410);
 assert.equal(await fs.readFile(path.join(p.path,'keep.txt'),'utf8'),'user source');
 const {Store}=await import('../src/store.mjs');const reloaded=await new Store({stateDir:app.stateDir,hostId:app.hostId}).init();assert.equal((await reloaded.read(p.id)).sessions.length,0);
 await assert.rejects(()=>api(route,'POST',{action:'purge'}),/无效/);
});

test('lifecycle rejects pending work atomically and project deletion stops preview',async t=>{
 const {app,api}=await setup(t);const p=await api('/api/projects','POST',{name:'busy'}),base=`/api/projects/${p.id}`;
 const s=await api(`${base}/sessions`,'POST',{});
 await app.store.mutate(p.id,'test.waiting',state=>state.runs.push({id:'waiting-test',sessionId:s.id,queueId:`session:${s.id}`,status:'waiting',hostId:app.hostId}));
 for(const status of ['queued','running','waiting']){
  await app.store.mutate(p.id,'test.status',state=>state.runs[0].status=status);
  await assert.rejects(()=>api(`${base}/lifecycle`,'POST',{action:'delete'}),e=>e.status===409);
  await assert.rejects(()=>api(`${base}/sessions/${s.id}/lifecycle`,'POST',{action:'archive'}),e=>e.status===409);
 }
 await app.store.mutate(p.id,'test.done',state=>state.runs[0].status='cancelled');
 await fs.mkdir(path.join(p.path,'web'));await fs.writeFile(path.join(p.path,'web/index.html'),'<html>saved</html>');
 const a=await api(`${base}/artifacts`,'POST',{name:'preview',root:'web'});
 await api(`${base}/artifacts/${a.id}/start`,'POST',{});
 await api(`${base}/lifecycle`,'POST',{action:'delete'});
 assert.equal((await api(`${base}/artifacts/${a.id}/status`)).running,false);
 assert.equal(await fs.readFile(path.join(p.path,'web/index.html'),'utf8'),'<html>saved</html>');
});

test('HTTP approval response is authenticated, origin-checked, scoped and single-use',async t=>{
 const fake={...runner,execute:async({onApproval,signal})=>{const answer=await onApproval({kind:'permission',title:'Write',detail:'fixture.txt'},signal);return {text:answer.decision};}};
 const {api}=await setup(t,{runner:fake,token:'approval-test-token'});
 const headers={Authorization:'Bearer approval-test-token'};
 const p=await api('/api/projects','POST',{name:'approval'},headers),s=await api(`/api/projects/${p.id}/sessions`,'POST',{},headers);
 const run=await api(`/api/projects/${p.id}/messages`,'POST',{requestId:'approve',text:'test',sessionId:s.id,profileId:'fake',model:'test'},headers);
 let state,approval;for(let i=0;i<100;i++){state=await api(`/api/projects/${p.id}`,'GET',undefined,headers);approval=state.runs[0].approvals?.[0];if(approval)break;await new Promise(r=>setTimeout(r,15));}assert.ok(approval);
 const endpoint=`/api/projects/${p.id}/runs/${run.id}/approvals/${approval.id}`;
 await assert.rejects(api(endpoint,'POST',{decision:'allow'}),e=>e.status===401);
 await assert.rejects(api(endpoint,'POST',{decision:'allow'},{...headers,Origin:'https://evil.example'}),e=>e.status===403);
 await assert.rejects(api(endpoint.replace(run.id,'wrong'),'POST',{decision:'allow'},headers),e=>e.status===409);
 await api(endpoint,'POST',{decision:'deny'},headers);
 await assert.rejects(api(endpoint,'POST',{decision:'allow'},headers),e=>e.status===409);
});

test('paired host forwards approval to the owning live CLI channel',async t=>{
 const fake={...runner,execute:async({onApproval,signal})=>({text:(await onApproval({kind:'permission',title:'Write',detail:'remote fixture'},signal)).decision})};
 const a=await setup(t,{token:'a-token'}),b=await setup(t,{token:'b-token',runner:fake});
 const callA=(p,m,d)=>a.api(p,m,d,{Authorization:'Bearer a-token'}),callB=(p,m,d)=>b.api(p,m,d,{Authorization:'Bearer b-token'});
 const p=await callB('/api/projects','POST',{name:'remote approval'});await fs.cp(p.path,path.join(a.dir,'projects',p.id),{recursive:true});await callA('/api/hosts','POST',{name:'B',url:b.base,token:'b-token'});
 const s=await callA(`/api/projects/${p.id}/sessions`,'POST',{});const r=await callA(`/api/projects/${p.id}/messages`,'POST',{requestId:'remote-approve',hostId:b.app.hostId,sessionId:s.id,text:'test',profileId:'fake',model:'test'});
 let approval;for(let i=0;i<100;i++){approval=(await callA(`/api/projects/${p.id}`)).runs[0].approvals?.[0];if(approval)break;await new Promise(r=>setTimeout(r,15));}assert.ok(approval);
 await callA(`/api/projects/${p.id}/runs/${r.id}/approvals/${approval.id}`,'POST',{decision:'allow'});
 assert.equal((await callB(`/api/projects/${p.id}`)).runs[0].approvals[0].status,'approved');assert.equal(a.app.queue.approvals.pending.size,0);
});
