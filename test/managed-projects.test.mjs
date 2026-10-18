import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';

async function setup(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-managed-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const a=await new Store({stateDir:path.join(dir,'local-a'),projectRoot:path.join(dir,'win-platform','projects'),hostId:'a'}).init();
 const b=await new Store({stateDir:path.join(dir,'local-b'),projectRoot:path.join(dir,'mac-platform','projects'),hostId:'b'}).init();
 return {dir,a,b};
}
test('synced folders are discovered live without registration and histories rebase on the new host',async t=>{
 const {a,b,dir}=await setup(t);const p=await a.createProject({name:'Same name'});const sid=randomUUID();
 await a.mutate(p.id,'fixture',s=>{s.sessions.push({id:sid,title:'中文'});s.messages.push({id:randomUUID(),sessionId:sid,role:'user',text:'persistent conversation'});});
 await fs.writeFile(path.join(p.path,'index.html'),'<h1>作品</h1>');
 const target=path.join(b.projectRoot,p.id);await fs.cp(p.path,target,{recursive:true});
 const [discovered]=await b.listProjects();assert.equal(discovered.id,p.id);assert.equal(discovered.path,target);assert.equal(discovered.ownerHostId,'a');
 assert.equal((await b.read(p.id)).messages[0].text,'persistent conversation');
 assert.equal(await fs.readFile(path.join(target,'index.html'),'utf8'),'<h1>作品</h1>');
 const before=await fs.readFile(path.join(target,'.studio','state.json'),'utf8');
 const restarted=await new Store({stateDir:path.join(dir,'fresh-machine'),projectRoot:b.projectRoot,hostId:'c'}).init();
 assert.equal((await restarted.listProjects())[0].id,p.id);
 assert.equal(await fs.readFile(path.join(target,'.studio','state.json'),'utf8'),before,'non-owner startup must not rewrite synced history');
 assert.equal(JSON.parse(before).project.path,undefined);
});
test('partial sync and conflicting identities remain unavailable until complete, never replaced',async t=>{
 const {a,b}=await setup(t);const p=await a.createProject({name:'Partial'});const target=path.join(b.projectRoot,p.id);
 await fs.mkdir(path.join(target,'.studio'),{recursive:true});await fs.writeFile(path.join(target,'.studio','state.json'),'partial');
 assert.equal((await b.listProjects())[0].unavailable,true);
 await fs.cp(p.path,target,{recursive:true});assert.equal((await b.listProjects())[0].unavailable,undefined);
 const wrong=randomUUID();await fs.cp(p.path,path.join(b.projectRoot,wrong),{recursive:true});
 assert.match((await b.listProjects()).find(x=>x.id===wrong).error,/does not match/);
 await assert.rejects(b.read(wrong),/does not match/);
 const before=await fs.readdir(b.projectRoot);await assert.rejects(b.createProject({name:'unsafe',path:p.path}),/custom paths/);assert.deepEqual(await fs.readdir(b.projectRoot),before);
});
test('local absolute registry paths are rebuilt from the managed root and project junctions are rejected',async t=>{
 const {a,dir}=await setup(t);const p=await a.createProject({name:'Safe'});const outside=path.join(dir,'outside');await fs.mkdir(outside);
 const local=path.join(dir,'old-cache');await fs.mkdir(local);
 await fs.writeFile(path.join(local,'registry.json'),JSON.stringify({schemaVersion:1,projects:[{...p,path:outside}]}));
 const restarted=await new Store({stateDir:local,projectRoot:a.projectRoot,hostId:'a'}).init();assert.equal((await restarted.read(p.id)).project.path,p.path);
 const link=path.join(a.projectRoot,randomUUID());
 await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir');
 const entry=(await restarted.listProjects()).find(x=>x.path===link);assert.equal(entry.unavailable,true);
 await assert.rejects(restarted.read(entry.id),/inside managed/);assert.deepEqual(await fs.readdir(outside),[]);
});
