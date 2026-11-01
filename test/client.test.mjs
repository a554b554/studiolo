import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createStudio} from '../src/server.mjs';

// The desktop launcher and the failover banner probe servers from another origin.
test('other origins may probe identity (name, id and release only) but nothing else',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-client-'));
 const app=await createStudio({stateDir:path.join(root,'state'),projectRoot:path.join(root,'projects'),port:0,previewPort:0,runner:{profiles:async()=>[{id:'codex',models:[{id:'test'}],available:true}],execute:async()=>({text:''})}});
 t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.port}`;
 for(const origin of ['http://tauri.localhost','tauri://localhost','http://mini:4410']){
  const res=await fetch(base+'/api/identity',{headers:{Origin:origin}});
  assert.equal(res.status,200);assert.equal(res.headers.get('access-control-allow-origin'),origin);
  assert.deepEqual(Object.keys(await res.json()).sort(),['hostId','name','protocol','version']);
 }
 assert.equal((await fetch(base+'/api/projects',{headers:{Origin:'http://tauri.localhost'}})).status,403);
 assert.ok((await (await fetch(base+'/api/identity')).json()).profiles,'same-origin identity is unchanged');
});
