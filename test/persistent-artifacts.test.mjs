import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {createStudio} from '../src/server.mjs';
import {previewClient} from './preview-client.mjs';

const runner={profiles:async()=>[{id:'fake',label:'Test',available:true,models:[{id:'test',label:'Test'}]}],execute:async()=>({text:'test'})};
const freePort=()=>new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address();probe.close(()=>resolve(port));});});
const listening=port=>new Promise(resolve=>{const socket=net.connect(port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false));});
async function setup(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'studio-persistent-test-')),stateDir=path.join(directory,'state'),apps=[];
  const open=async()=>{const app=await createStudio({stateDir,projectRoot:path.join(directory,'projects'),port:0,previewPort:0,runner,token:''});apps.push(app);const base=`http://127.0.0.1:${app.port}`;const api=async(route,body)=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Origin:base,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error),{status:response.status});return data;};return {app,api};};
  // A failed assertion must not leave a persistent server behind: kill whatever the record names.
  t.after(async()=>{for(const app of apps)await app.close().catch(()=>{});try{const {running}=JSON.parse(await fs.readFile(path.join(stateDir,'persistent-artifacts.json'),'utf8'));for(const {pid} of Object.values(running)){try{if(process.platform==='win32')execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore'});else process.kill(-pid,'SIGKILL');}catch{}}}catch{}await fs.rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});});
  return {open};
}

test('a persistent backend outlives Studiolo, and the next Studiolo shares it instead of starting another',{timeout:60000},async t=>{
  const {open}=await setup(t);let {app,api}=await open();
  const project=await api('/api/projects',{name:'Persistent backend'});await fs.mkdir(path.join(project.path,'web'));
  await fs.writeFile(path.join(project.path,'web','server.mjs'),`import http from 'node:http';http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({pid:process.pid,persistent:process.env.STUDIO_PERSISTENT,host:process.env.HOST}));}).listen(Number(process.env.PORT),process.env.HOST);`);
  const port=await freePort();const artifact=await api(`/api/projects/${project.id}/artifacts`,{name:'Service',root:'web',command:['node','server.mjs'],port});const route=`/api/projects/${project.id}/artifacts/${artifact.id}`;
  const started=await api(route+'/persist',{});
  assert.equal(started.persistent.running,true);assert.equal(started.persistent.port,port);assert.deepEqual(started.persistent.urls.map(u=>u.kind),['local']);
  const first=await (await fetch(`http://127.0.0.1:${port}/`)).json();assert.equal(first.persistent,'1');assert.equal(first.host,'127.0.0.1');
  await app.close();await new Promise(r=>setTimeout(r,300));
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/`)).json()).pid,first.pid,'still running with Studiolo closed');
  ({app,api}=await open());
  assert.equal((await api(route+'/status')).persistent.running,true);
  const view=await api(route+'/start',{});assert.equal(view.running,true);
  assert.equal((await (await (await previewClient(view)).request()).json()).pid,first.pid,'the workbench view proxies to the same process');
  await api(route+'/stop',{});assert.equal((await api(route+'/status')).persistent,null);
  for(let i=0;i<30&&await listening(port);i++)await new Promise(r=>setTimeout(r,100));assert.equal(await listening(port),false);
});

test('a static Artifact runs persistently on a remembered port without the Studiolo bridge',{timeout:60000},async t=>{
  const {open}=await setup(t);const {api}=await open();
  const project=await api('/api/projects',{name:'Persistent static'});await fs.mkdir(path.join(project.path,'site'));
  await fs.writeFile(path.join(project.path,'site','index.html'),'<h1>Static</h1>');await fs.writeFile(path.join(project.path,'site','.secret'),'no');
  const artifact=await api(`/api/projects/${project.id}/artifacts`,{name:'Site',root:'site'});const route=`/api/projects/${project.id}/artifacts/${artifact.id}`;
  const {persistent}=await api(route+'/persist',{});const page=await fetch(persistent.urls[0].url);
  assert.equal(await page.text(),'<h1>Static</h1>');assert.equal((await fetch(`http://127.0.0.1:${persistent.port}/.secret`)).status,404);
  assert.equal((await fetch(`http://127.0.0.1:${persistent.port}/some/route`,{headers:{Accept:'text/html'}})).status,200);
  await api(route+'/stop',{});for(let i=0;i<30&&await listening(persistent.port);i++)await new Promise(r=>setTimeout(r,100));
  assert.equal((await api(route+'/persist',{})).persistent.port,persistent.port,'the same port next time');await api(route+'/stop',{});
});

test('the manifest decides how a persistent Artifact is reached',{timeout:30000},async t=>{
  const {open}=await setup(t);const {api}=await open();
  const project=await api('/api/projects',{name:'Persistent manifest'});await fs.mkdir(path.join(project.path,'site'));await fs.writeFile(path.join(project.path,'site','index.html'),'ok');
  const create=persistent=>api(`/api/projects/${project.id}/artifacts`,{name:'Site',root:'site',persistent});
  assert.deepEqual((await create({tailnet:true,urls:['https://example.test/app']})).persistent,{host:'127.0.0.1',tailnet:true,urls:['https://example.test/app']});
  assert.equal((await create()).persistent,null);
  for(const bad of [{port:80},{host:'example.com'},{tailnet:'yes'},{urls:['ftp://x']},[]])await assert.rejects(create(bad),/persistent/);
  const port=await freePort();const artifact=await create({port,tailnet:true,urls:['https://example.test/app']});const route=`/api/projects/${project.id}/artifacts/${artifact.id}`;
  const {persistent}=await api(route+'/persist',{});
  assert.equal(persistent.port,port);assert.match(persistent.tailnetError,/Tailscale/);assert.deepEqual(persistent.urls.map(u=>u.kind),['local','artifact']);
  await api(route+'/stop',{});
});
