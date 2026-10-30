import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createStudio} from '../src/server.mjs';

// Plan P8: drafts and per-user UI state follow the user. Two servers whose project roots share
// nothing exchange them over HTTP (journal and host index), like every other metadata.
const wait=async(fn,ms=12000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+fn.toString().slice(0,90));};
async function servers(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-ui-state-'));const apps=[];
 const make=async label=>{
  const app=await createStudio({stateDir:path.join(root,label,'state'),projectRoot:path.join(root,label,'projects'),port:0,previewPort:0,runner:{profiles:async()=>[{id:'codex',models:[{id:'test'}],available:true}],execute:async o=>{await o.onEvent({type:'text',text:'ok'});return {text:'ok',nativeSessionId:'native-'+label};}}});
  apps.push(app);const base=`http://127.0.0.1:${app.port}`;
  const api=async(url,method='GET',data)=>{const res=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const result=await res.json();if(!res.ok)throw Object.assign(Error(result.error),{status:res.status});return result;};
  return {app,api};
 };
 const a=await make('A'),b=await make('B');
 t.after(async()=>{for(const app of apps)await app.close();await fs.rm(root,{recursive:true,force:true});});
 await a.api('/api/hosts','POST',{url:`http://127.0.0.1:${b.app.port}`});
 return {a,b};
}

test('a conversation draft saved on one server is found on the other, and sending clears it',async t=>{
 const {a,b}=await servers(t);
 const p=await a.api('/api/projects','POST',{name:'Drafts'}),url=`/api/projects/${p.id}`;
 const s=await a.api(url+'/sessions','POST',{title:'Draft here'}),draft=`${url}/sessions/${s.id}/draft`;
 assert.deepEqual(await a.api(draft),{text:'',at:null});
 const saved=await a.api(draft,'PUT',{text:'half a thought'});
 assert.equal(saved.text,'half a thought');assert.ok(saved.at);
 // Saving the same text again writes nothing new.
 assert.equal((await a.api(draft,'PUT',{text:'half a thought'})).at,saved.at);
 await wait(async()=>(await b.api(draft).catch(()=>null))?.text==='half a thought');
 // Edited on B: A sees the newer text.
 await b.api(draft,'PUT',{text:'half a thought, finished on B'});
 await wait(async()=>(await a.api(draft)).text==='half a thought, finished on B');
 await assert.rejects(a.api(draft,'PUT',{text:42}),{status:400});
 await assert.rejects(a.api(draft,'PUT',{text:'x'.repeat(200001)}),{status:400});
 await assert.rejects(a.api(`${url}/sessions/missing/draft`,'PUT',{text:'x'}),{status:404});
 // Sending a message leaves an empty draft with a time, so the old text loses everywhere.
 await a.api(url+'/messages','POST',{sessionId:s.id,requestId:randomUUID(),text:'half a thought, finished on B',profileId:'codex',model:'test',hostId:a.app.hostId});
 const cleared=await a.api(draft);
 assert.equal(cleared.text,'');assert.ok(cleared.at>saved.at);
 await wait(async()=>(await b.api(draft)).text==='');
});

test('the last selection, theme and language are one shared document, newest wins',async t=>{
 const {a,b}=await servers(t);
 const p=await a.api('/api/projects','POST',{name:'Selected'});
 assert.deepEqual((await a.api('/api/bootstrap')).ui,{});
 await b.api('/api/settings/ui','PUT',{selection:{projectId:p.id,sessionId:null},theme:'oled'});
 await wait(async()=>(await a.api('/api/bootstrap')).ui?.selection?.projectId===p.id);
 assert.equal((await a.api('/api/settings/ui')).theme,'oled');
 // A later change on A replaces the whole document on B; fields A did not touch are kept.
 await new Promise(r=>setTimeout(r,5));
 await a.api('/api/settings/ui','PUT',{language:'en'});
 await wait(async()=>(await b.api('/api/settings/ui')).language==='en');
 const onB=await b.api('/api/settings/ui');
 assert.equal(onB.theme,'oled');assert.equal(onB.updatedHostId,a.app.hostId);
 for(const bad of [{language:'fr'},{theme:'<script>'},{selection:{projectId:'not-a-uuid'}},{other:1},[]])
  await assert.rejects(a.api('/api/settings/ui','PUT',bad),{status:400});
});
