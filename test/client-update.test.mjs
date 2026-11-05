import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {clientUpdate,compareVersions,newerClient} from '../src/client-update.mjs';
import {createStudio} from '../src/server.mjs';

async function dist(t,files){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-dist-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const [name,content] of Object.entries(files))await fs.writeFile(path.join(dir,name),content);
 return dir;
}

test('versions compare by number, not as text',()=>{
 assert.ok(compareVersions('0.2.10','0.2.9')>0);assert.equal(compareVersions('0.2','0.2.0'),0);assert.ok(compareVersions('0.2.1','0.2.2')<0);
});

test('a later build of the open version counts as newer',()=>{
 assert.ok(newerClient({clientVersion:'0.2.1',clientBuild:2,current:'0.2.1',build:1}));
 assert.ok(newerClient({clientVersion:'0.2.1',clientBuild:1,current:'0.2.0'}),'the 0.2.0 client sends no build');
 assert.ok(!newerClient({clientVersion:'0.2.1',clientBuild:2,current:'0.2.1',build:2}));
 assert.ok(!newerClient({clientVersion:'0.2.1',clientBuild:9,current:'0.3.0',build:1}),'never a downgrade');
});

test('an older client is offered the signed bundle of its platform, a current one nothing',async t=>{
 const dir=await dist(t,{'Studiolo_0.2.2_x64-setup.exe':'exe','Studiolo_0.2.2_x64-setup.exe.sig':'sig-win\n','Studiolo_0.2.2_aarch64.app.tar.gz':'tar'});
 const ask=(target,arch,current)=>clientUpdate({dist:dir,clientVersion:'0.2.2',target,arch,current,origin:'http://host:4310'});
 const update=await ask('windows','x86_64','0.2.0');
 assert.deepEqual({...update,pub_date:undefined},{version:'0.2.2',pub_date:undefined,url:'http://host:4310/api/client/download/Studiolo_0.2.2_x64-setup.exe',signature:'sig-win',notes:''});
 assert.equal(await ask('windows','x86_64','0.2.2'),null,'already current');
 assert.equal(await ask('windows','x86_64','0.3.0'),null,'never a downgrade');
 assert.equal(await ask('darwin','aarch64','0.2.0'),null,'a bundle without its signature is not offered');
 assert.equal(await ask('linux','x86_64','0.2.0'),null,'no bundle built for this platform');
});

test('the update routes answer without sign-in and serve only bundles',async t=>{
 const {version}=JSON.parse(await fs.readFile(new URL('../desktop/src-tauri/tauri.conf.json',import.meta.url),'utf8'));
 const {build}=JSON.parse(await fs.readFile(new URL('../desktop/package.json',import.meta.url),'utf8'));
 const exe=`Studiolo_${version}_x64-setup.exe`;
 const clientDist=await dist(t,{[exe]:'installer bytes',[exe+'.sig']:'signature','notes.txt':'private'});
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-update-'));
 const app=await createStudio({stateDir:path.join(root,'state'),projectRoot:path.join(root,'projects'),port:0,previewPort:0,homedir:path.join(root,'home'),env:{},clientDist});
 t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.port}`;
 const update=await (await fetch(`${base}/api/client/update/windows/x86_64/0.0.1`)).json();
 assert.equal(update.url,`${base}/api/client/download/${exe}`);assert.equal(update.signature,'signature');
 assert.equal((await fetch(`${base}/api/client/update/windows/x86_64/${version}?build=${build}`)).status,204);
 assert.equal((await fetch(`${base}/api/client/update/windows/x86_64/${version}?build=${build-1}`)).status,200,'an earlier build of this version');
 assert.equal(await (await fetch(update.url)).text(),'installer bytes');
 assert.equal((await fetch(`${base}/api/client/download/notes.txt`)).status,404);
 assert.equal((await fetch(`${base}/api/client/download/..%2Fnotes.txt`)).status,404);
});
