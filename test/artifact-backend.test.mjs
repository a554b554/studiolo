import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/server.mjs';
import {previewClient} from './preview-client.mjs';

const example = fileURLToPath(new URL('../examples/persistent-game/', import.meta.url));
const runner = {
  profiles: async () => [{ id:'fake', label:'Test', available:true, models:[{id:'test',label:'Test'}] }],
  execute: async () => ({text:'test'}),
};

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.ok(port >= 1024, 'backend requires an unprivileged port');
  return port;
}

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'studio-backend-test-'));
  let app;
  t.after(async () => {
    try { if (app) await app.close(); }
    finally { await fs.rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:50}); }
  });
  app = await createStudio({stateDir:path.join(directory,'state'),projectRoot:path.join(directory,'projects'),port:0,previewPort:0,runner,token:''});
  const base = `http://127.0.0.1:${app.port}`;
  const api = async (route, body) => {
    const response = await fetch(base+route,{method:body === undefined ? 'GET' : 'POST',headers:{Origin:base,...(body === undefined ? {} : {'Content-Type':'application/json'})},body:body === undefined ? undefined : JSON.stringify(body)});
    const data = await response.json();
    assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  };
  return {app,api,base,directory};
}

test('real Artifact backend persists SQLite scores across restart and restores a stopped snapshot', {timeout:60000}, async t => {
  const {api,base} = await setup(t);
  const project = await api('/api/projects',{name:'SQLite backend integration'});
  await fs.cp(example,path.join(project.path,'game'),{recursive:true});
  const artifact = await api(`/api/projects/${project.id}/artifacts`,{name:'Persistent game',root:'game',entry:'index.html',command:['node','server.mjs'],port:await freePort(),dataPaths:['game/data']});
  const route = `/api/projects/${project.id}/artifacts/${artifact.id}`;
  let live = await api(route+'/start',{});
  const initialURL = live.url;
  assert.equal(live.running,true);
  assert.notEqual(new URL(live.url).origin,base,'preview uses a separate origin');
  let client = await previewClient(live);
  const html = await (await client.request()).text();
  assert.match(html,/__STUDIO_BRIDGE__/,'backend HTML receives the annotation bridge');
  const scores = async score => {
    const response = await client.request('/api/scores',{method:score === undefined ? 'GET' : 'POST',headers:{Origin:base,...(score === undefined ? {} : {'Content-Type':'application/json'})},body:score === undefined ? undefined : JSON.stringify({score})});
    assert.equal(response.status,200);
    return response.json();
  };
  assert.deepEqual(await scores(),[]);
  assert.deepEqual(await scores(17),{saved:true});
  assert.deepEqual(await scores(42),{saved:true});
  assert.deepEqual((await scores()).map(row=>row.score),[42,17]);
  const dbFile = path.join(project.path,'game','data','game.sqlite');
  assert.equal((await fs.readFile(dbFile)).subarray(0,15).toString(),'SQLite format 3');
  await api(route+'/stop',{});
  assert.equal((await api(route+'/status')).running,false);
  assert.equal((await fetch(initialURL)).status,404,'stopped preview token expires');
  live = await api(route+'/start',{});
  client = await previewClient(live);
  assert.notEqual(live.url,initialURL);
  assert.deepEqual((await scores()).map(row=>row.score),[42,17],'database survives process restart');
  const snapshot = await api(route+'/snapshot',{});
  assert.equal(snapshot.stopped,true);
  assert.equal((await api(route+'/status')).running,false);
  assert.ok((await api(route+'/status')).snapshots.some(item=>item.id===snapshot.snapshotId));
  live = await api(route+'/start',{});
  client = await previewClient(live);
  await scores(99);
  assert.deepEqual((await scores()).map(row=>row.score),[99,42,17]);
  const restore = await api(route+'/restore',{snapshotId:snapshot.snapshotId});
  assert.equal(restore.restored,true);
  assert.equal((await api(route+'/status')).running,false,'restore never silently starts a writer');
  live = await api(route+'/start',{});
  client = await previewClient(live);
  assert.deepEqual((await scores()).map(row=>row.score),[42,17],'restore restores the actual SQLite data');
  assert.ok((await fs.readdir(path.join(project.path,'game'))).some(name=>name.startsWith('data.before-restore-')),'previous data retained in backup');
});

test('runtime child process does not inherit the Studio access token', {timeout:30000}, async t => {
  const original = process.env.STUDIO_TOKEN;
  process.env.STUDIO_TOKEN = 'test-only-platform-secret';
  t.after(() => { if (original === undefined) delete process.env.STUDIO_TOKEN; else process.env.STUDIO_TOKEN = original; });
  const {api} = await setup(t);
  const project = await api('/api/projects',{name:'Runtime environment boundary'});
  await fs.mkdir(path.join(project.path,'web'));
  await fs.writeFile(path.join(project.path,'web','server.mjs'), `import http from 'node:http'; http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({hasStudioToken:process.env.STUDIO_TOKEN !== undefined,port:process.env.PORT,host:process.env.HOST}));}).listen(Number(process.env.PORT),process.env.HOST);`);
  const port = await freePort();
  const artifact = await api(`/api/projects/${project.id}/artifacts`,{name:'Environment check',root:'web',command:['node','server.mjs'],port});
  const live = await api(`/api/projects/${project.id}/artifacts/${artifact.id}/start`,{});
  const response = await (await previewClient(live)).request();
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{hasStudioToken:false,port:String(port),host:'127.0.0.1'});
});
