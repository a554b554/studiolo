import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createStudio} from '../src/server.mjs';
import {FakeTransport} from '../src/transport.mjs';

// Chat categories (one level, per project, in the replicated journal) and detaching a fork.
async function server(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-categories-'));
 const app=await createStudio({stateDir:path.join(root,'state'),projectRoot:path.join(root,'projects'),port:0,previewPort:0,transport:new FakeTransport(),runner:{profiles:async()=>[{id:'codex',models:[{id:'test'}],available:true}],execute:async()=>({text:'ok'})}});
 t.after(async()=>{await app.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.port}`;
 const api=async(url,method='GET',data)=>{const res=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const result=await res.json();if(!res.ok)throw Object.assign(Error(result.error),{status:res.status});return result;};
 return {app,api};
}

test('categories group conversations, can be renamed and dissolved, and show in the project list',async t=>{
 const {api}=await server(t);const p=await api('/api/projects','POST',{name:'Grouped'}),url=`/api/projects/${p.id}`;
 const one=await api(url+'/sessions','POST',{title:'One'}),two=await api(url+'/sessions','POST',{title:'Two'}),three=await api(url+'/sessions','POST',{title:'Three'});
 const cat=await api(url+'/categories','POST',{name:' Multi host ',sessionIds:[one.id,two.id]});
 assert.equal(cat.name,'Multi host');assert.ok(cat.id);
 let state=await api(url);assert.deepEqual(state.project.categories.map(c=>c.name),['Multi host']);
 assert.deepEqual(state.sessions.filter(s=>s.categoryId===cat.id).map(s=>s.title),['One','Two']);
 const listed=(await api('/api/projects')).find(x=>x.id===p.id);
 assert.deepEqual(listed.categories.map(c=>c.id),[cat.id]);assert.deepEqual(listed.sessions.map(s=>[s.title,s.categoryId??null]),[['One',cat.id],['Two',cat.id],['Three',null]]);
 // Move in and out, rename together with a title.
 const moved=await api(`${url}/sessions/${three.id}`,'PATCH',{categoryId:cat.id,title:'Third'});assert.equal(moved.categoryId,cat.id);assert.equal(moved.title,'Third');
 assert.equal((await api(`${url}/sessions/${one.id}`,'PATCH',{categoryId:null})).categoryId,undefined);
 await assert.rejects(api(`${url}/sessions/${one.id}`,'PATCH',{categoryId:'nope'}),e=>e.status===404);
 await assert.rejects(api(`${url}/sessions/${one.id}`,'PATCH',{}),e=>e.status===400);
 assert.equal((await api(`${url}/categories/${cat.id}`,'PATCH',{name:'Hosts'})).name,'Hosts');
 await assert.rejects(api(`${url}/categories/${cat.id}`,'PATCH',{name:'a\nb'}),e=>e.status===400);
 await assert.rejects(api(`${url}/categories/${cat.id}`,'PATCH',{name:'x'.repeat(61)}),e=>e.status===400);
 await assert.rejects(api(`${url}/categories/missing`,'DELETE'),e=>e.status===404);
 const empty=await api(url+'/categories','POST',{name:'Empty'});
 state=await api(url);assert.deepEqual(state.project.categories.map(c=>c.name),['Hosts','Empty']);
 // Dissolving keeps the conversations.
 await api(`${url}/categories/${cat.id}`,'DELETE');state=await api(url);
 assert.deepEqual(state.project.categories.map(c=>c.id),[empty.id]);assert.equal(state.sessions.length,3);assert.ok(state.sessions.every(s=>!s.categoryId));
 // Archived conversations leave the list; an archived project refuses changes.
 await api(`${url}/sessions/${two.id}/lifecycle`,'POST',{action:'archive'});
 assert.ok(!(await api('/api/projects')).find(x=>x.id===p.id).sessions.some(s=>s.id===two.id));
 await api(`${url}/lifecycle`,'POST',{action:'archive'});
 await assert.rejects(api(url+'/categories','POST',{name:'Late'}),e=>e.status===409);
});

test('forks follow their conversation; a detached fork becomes its own conversation in the same category',async t=>{
 const {api}=await server(t);const p=await api('/api/projects','POST',{name:'Forks'}),url=`/api/projects/${p.id}`;
 const root=await api(url+'/sessions','POST',{title:'Root'});const cat=await api(url+'/categories','POST',{name:'Work',sessionIds:[root.id]});
 const fork=await api(`${url}/sessions/${root.id}/fork`,'POST',{}),inner=await api(`${url}/sessions/${fork.id}/fork`,'POST',{});
 await assert.rejects(api(`${url}/sessions/${fork.id}`,'PATCH',{categoryId:cat.id}),e=>e.status===409);
 await assert.rejects(api(url+'/categories','POST',{name:'No',sessionIds:[inner.id]}),e=>e.status===409);
 await assert.rejects(api(`${url}/sessions/${root.id}/detach`,'POST',{}),e=>e.status===409);
 const listed=(await api('/api/projects')).find(x=>x.id===p.id).sessions;
 assert.equal(listed.find(s=>s.id===inner.id).forkOf.sessionId,fork.id);assert.deepEqual(listed.find(s=>s.id===root.id).forks,[fork.id]);
 // Detaching the fork of a fork: it leaves its source and takes the root's category.
 const detached=await api(`${url}/sessions/${inner.id}/detach`,'POST',{});
 assert.equal(detached.forkOf,undefined);assert.equal(detached.detachedFrom.sessionId,fork.id);assert.equal(detached.categoryId,cat.id);
 const state=await api(url);assert.deepEqual(state.sessions.find(s=>s.id===fork.id).forks,[]);
 // Now it is an ordinary conversation and can move on its own.
 assert.equal((await api(`${url}/sessions/${inner.id}`,'PATCH',{categoryId:null})).categoryId,undefined);
});
