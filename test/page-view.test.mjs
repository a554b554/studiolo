import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStudio} from '../src/server.mjs';
import {pageView, compactRecord, RECORD_PREVIEW} from '../src/page-view.mjs';

// The web page loads one conversation (or one Artifact's comment threads) with tool records of ended
// runs as previews, and fetches a run's full records when its raw log opens.
const long = JSON.stringify({type:'commandExecution',command:'cat big.log',aggregatedOutput:'line\n'.repeat(2000)});
const runner={profiles:async()=>[{id:'fake',label:'test',available:true,models:[{id:'test',label:'Test'}]}],execute:async({onEvent})=>{onEvent({type:'tool',text:long});onEvent({type:'tool',text:'Read: {"file_path":"a.md"}'});onEvent({type:'text',text:'done'});return {text:'done',nativeSessionId:'native'};}};
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-page-'));const app=await createStudio({stateDir:path.join(dir,'state'),projectRoot:path.join(dir,'projects'),port:0,previewPort:0,runner,homedir:path.join(dir,'home'),env:{}});t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});const base=`http://127.0.0.1:${app.port}`;async function api(p,method='GET',data){const res=await fetch(base+p,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});const payload=await res.json();if(!res.ok)throw Object.assign(new Error(payload.error),{status:res.status});return payload;}return {app,api};}
const settled=async(api,root,runId)=>{for(let i=0;i<100;i++){const s=await api(root);const run=s.runs.find(r=>r.id===runId);if(run&&!['queued','running','waiting'].includes(run.status))return s;await new Promise(r=>setTimeout(r,50));}throw new Error('run did not settle');};

test('the page view carries one conversation, tool records of ended runs as previews, full records on request',async t=>{
  const {api}=await setup(t);
  const project=await api('/api/projects','POST',{name:'page'});const root=`/api/projects/${project.id}`;
  const a=await api(`${root}/sessions`,'POST',{title:'A'}),b=await api(`${root}/sessions`,'POST',{title:'B'});
  const ra=await api(`${root}/messages`,'POST',{requestId:'a1',sessionId:a.id,text:'hello A',profileId:'fake',model:'test'});
  const rb=await api(`${root}/messages`,'POST',{requestId:'b1',sessionId:b.id,text:'hello B',profileId:'fake',model:'test'});
  await settled(api,root,ra.id);const full=await settled(api,root,rb.id);
  await fs.mkdir(path.join(project.path,'web'));await fs.writeFile(path.join(project.path,'web/index.html'),'<h1 id="t">x</h1>');
  const artifact=await api(`${root}/artifacts`,'POST',{name:'web',root:'web'});
  const comment=await api(`${root}/artifacts/${artifact.id}/annotations`,'POST',{requestId:'c1',text:'change it',anchor:{selector:'#t'},profileId:'fake',model:'test'});
  await settled(api,root,comment.run.id);

  const page=await api(`${root}?session=${a.id}`);
  assert.deepEqual(page.page,{sessionId:a.id,artifactId:null});
  assert.ok(page.messages.length>=4&&page.messages.every(m=>m.sessionId===a.id),'only conversation A');
  assert.equal(page.runs.length,(await api(root)).runs.length,'every run, for spinners and the outbox');
  assert.deepEqual(page.sessions.map(s=>s.id).sort(),[a.id,b.id].sort());
  const preview=page.messages.find(m=>m.truncated);
  assert.equal(preview.truncated,long.length);assert.equal(preview.text,long.slice(0,RECORD_PREVIEW));
  assert.ok(page.messages.some(m=>m.kind==='tool'&&m.text.startsWith('Read: ')&&!m.truncated),'short records stay whole');
  const fullA=full.messages.filter(m=>m.sessionId===a.id);
  assert.deepEqual(page.messages.map(m=>m.id),fullA.map(m=>m.id),'same records, same order as the full view');

  const records=await api(`${root}/runs/${ra.id}/records`);
  assert.ok(records.every(m=>m.runId===ra.id&&m.kind==='tool'));
  assert.equal(records.find(m=>m.id===preview.id).text,long,'the raw log gets the full text');

  assert.equal((await api(`${root}?session=latest`)).page.sessionId,b.id,'latest is the last open conversation');
  const threads=await api(`${root}?artifact=${artifact.id}`);
  assert.ok(threads.messages.length&&threads.messages.every(m=>!m.sessionId&&m.artifactId===artifact.id));
  assert.ok(threads.messages.some(m=>m.truncated),'comment runs are compacted too');
  assert.ok(JSON.stringify(page).length<JSON.stringify(full).length/2);
});

test('records of executing runs and background replies stay whole; latest skips archived and deleted conversations',()=>{
  const big='x'.repeat(RECORD_PREVIEW+1);
  for(const status of ['queued','running','waiting'])assert.equal(compactRecord({role:'system',kind:'tool',text:big,runId:'r'},{id:'r',status}).text,big);
  assert.equal(compactRecord({role:'system',kind:'tool',text:'Background native event: '+big},{status:'succeeded'}).text.length,big.length+25);
  assert.equal(compactRecord({role:'assistant',text:big},{status:'succeeded'}).text,big,'replies are never cut');
  assert.equal(compactRecord({role:'system',kind:'tool',text:big},{status:'failed'}).truncated,big.length);
  const view={sessions:[{id:'a'},{id:'b'},{id:'c',archivedAt:'x'},{id:'d',deletedAt:'x'}],runs:[],messages:[{id:'1',sessionId:'b'},{id:'2',sessionId:'c'}]};
  const latest=pageView(view,{sessionId:'latest'});
  assert.equal(latest.page.sessionId,'b');assert.deepEqual(latest.messages.map(m=>m.id),['1']);
  assert.equal(pageView({...view,sessions:[]},{sessionId:'latest'}).page.sessionId,null);
});
