import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createStudio} from '../src/server.mjs';
import {safeUploadName,normalizeAttachments} from '../src/uploads.mjs';
import {buildContext} from '../src/context.mjs';

const runner={profiles:async()=>[{id:'fake',label:'test',available:true,models:[{id:'test',label:'Test'}]}],execute:async({onEvent})=>{onEvent({type:'text',text:'test output'});return {text:'test output',nativeSessionId:'test-native'}}};
async function setup(t,options={}){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-uploads-'));const app=await createStudio({stateDir:path.join(dir,'state'),projectRoot:path.join(dir,'projects'),port:0,previewPort:0,runner,...options});t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});const base=`http://127.0.0.1:${app.port}`;async function api(p,method='GET',data,headers={}){const res=await fetch(base+p,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):undefined});const payload=await res.json();if(!res.ok)throw Object.assign(new Error(payload.error),{status:res.status});return payload;}async function send(p,name,body,headers={}){const res=await fetch(`${base}${p}/uploads?name=${encodeURIComponent(name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream',...headers},body});const payload=await res.json();if(!res.ok)throw Object.assign(new Error(payload.error),{status:res.status});return payload;}return {app,api,send,base,dir};}

test('upload names keep only a safe final segment',()=>{
 assert.equal(safeUploadName('report.pdf'),'report.pdf');
 assert.equal(safeUploadName('../../.studio/state.json'),'state.json');
 assert.equal(safeUploadName('C:\\Users\\me\\Desktop\\notes.txt'),'notes.txt');
 assert.equal(safeUploadName('bad<name>:"|?*.txt'),'badname.txt');
 assert.equal(safeUploadName('trailing. . '),'trailing');
 assert.equal(safeUploadName(''),'file');assert.equal(safeUploadName('..'),'file');assert.equal(safeUploadName('/'),'file');
 assert.equal(safeUploadName('CON.txt'),'_CON.txt');
 const long=safeUploadName('a'.repeat(300)+'.md');assert.ok(long.length<=150);assert.ok(long.endsWith('.md'));
 assert.equal(safeUploadName('图表 数据.csv'),'图表 数据.csv');
});

test('attachment lists accept only files directly inside uploads/',()=>{
 assert.equal(normalizeAttachments(undefined),undefined);assert.equal(normalizeAttachments([]),undefined);
 assert.deepEqual(normalizeAttachments(['uploads/a.txt','uploads\\b.txt','./uploads/a.txt']),['uploads/a.txt','uploads/b.txt']);
 for(const bad of ['a.txt','uploads/../.studio/state.json','uploads/sub/a.txt','.studio/a.txt','uploads/','uploads/..','uploads/a/'])assert.throws(()=>normalizeAttachments([bad]),/uploads/,bad);
 assert.throws(()=>normalizeAttachments('uploads/a.txt'));assert.throws(()=>normalizeAttachments([1]));assert.throws(()=>normalizeAttachments(Array(51).fill('uploads/a.txt')));
});

test('uploads land in uploads/ with unique names, bounded size and project checks',async t=>{
 const {api,send,base}=await setup(t,{uploadLimit:64});
 const p=await api('/api/projects','POST',{name:'uploads'}),root=`/api/projects/${p.id}`;
 const first=await send(root,'notes.txt','hello');
 assert.deepEqual(first,{name:'notes.txt',path:'uploads/notes.txt',size:5});
 assert.equal(await fs.readFile(path.join(p.path,'uploads','notes.txt'),'utf8'),'hello');
 const second=await send(root,'notes.txt','again');
 assert.equal(second.path,'uploads/notes (2).txt');assert.equal((await send(root,'notes.txt','third')).name,'notes (3).txt');
 assert.equal(await fs.readFile(path.join(p.path,'uploads','notes.txt'),'utf8'),'hello','existing uploads are never overwritten');
 const escaped=await send(root,'../../.studio/state.json','{}');assert.equal(escaped.path,'uploads/state.json');
 assert.equal((await send(root,'empty.bin','')).size,0);
 await assert.rejects(send(root,'   ','x'),e=>e.status===400);
 await assert.rejects(send(root,'big.bin','x'.repeat(65)),e=>e.status===413);
 // fetch refuses a mismatched Content-Length, so the early header check uses a raw request.
 const declared=await new Promise((resolve,reject)=>{const req=http.request(`${base}${root}/uploads?name=declared.bin`,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':'9999'}},res=>{resolve(res.statusCode);req.destroy();});req.on('error',reject);req.write('x');});
 assert.equal(declared,413);
 const listing=await api(root+'/files?path=uploads');
 assert.deepEqual(listing.map(e=>e.name).sort(),['empty.bin','notes (2).txt','notes (3).txt','notes.txt','state.json']);
 assert.ok(!listing.some(e=>e.name.endsWith('.tmp')),'no temp files remain after failures');
 const dir=await fs.readdir(path.join(p.path,'uploads'));assert.ok(!dir.some(n=>n.endsWith('.tmp')),dir.join(','));
 assert.equal((await fetch(`${base}${root}/uploads?name=x.txt`,{method:'POST',body:'x',headers:{'Content-Type':'application/octet-stream',Origin:'https://evil.example'}})).status,403);
 await api(root+'/lifecycle','POST',{action:'archive'});
 await assert.rejects(send(root,'late.txt','x'),e=>e.status===409);
});

test('messages carry validated attachments into runs, history and the agent prompt',async t=>{
 const {api,send,app}=await setup(t);
 const p=await api('/api/projects','POST',{name:'attach'}),root=`/api/projects/${p.id}`;
 const s=await api(root+'/sessions','POST',{title:'files'});
 const saved=await send(root,'data.csv','a,b');
 const base={sessionId:s.id,profileId:'fake',model:'test',text:'look at this'};
 for(const attachments of [['../machine.json'],['uploads/missing.csv'],['uploads/sub/data.csv'],'uploads/data.csv'])await assert.rejects(api(root+'/messages','POST',{...base,requestId:'bad-'+JSON.stringify(attachments),attachments}),e=>e.status===400||e.status===404,JSON.stringify(attachments));
 const run=await api(root+'/messages','POST',{...base,requestId:'with-files',attachments:[saved.path,'uploads\\data.csv']});
 assert.deepEqual(run.attachments,['uploads/data.csv']);
 const state=await app.store.read(p.id);
 const message=state.messages.find(m=>m.role==='user'&&m.runId===run.id);assert.deepEqual(message.attachments,['uploads/data.csv']);
 const prompt=buildContext(state,state.runs.find(r=>r.id===run.id),undefined,app.hostId).prompt;
 assert.match(prompt,/^look at this\nAttached files for this request[^\n]*\n- uploads\/data\.csv\n/);
 const delta=buildContext({...state,runs:[...state.runs,{...run,id:'old',status:'succeeded',nativeSessionId:'n'}]},{...run,id:'new'},'n',app.hostId);
 assert.equal(delta.metadata.mode,'delta');assert.match(delta.prompt,/- uploads\/data\.csv/);assert.doesNotMatch(delta.prompt,/history-index/);
 const plain=await api(root+'/messages','POST',{...base,requestId:'no-files'});assert.equal(plain.attachments,undefined);
 assert.equal(buildContext(state,{...plain,attachments:undefined},undefined,app.hostId).prompt.split('\n')[1].startsWith('Project scope'),true);
 await new Promise(r=>setTimeout(r,300));
 assert.match(await fs.readFile(path.join(p.path,'.studio','sessions',s.id+'.md'),'utf8'),/Attachments: uploads\/data\.csv/);
});
