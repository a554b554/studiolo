import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createStudio} from '../src/server.mjs';
import {revealCommand} from '../src/reveal.mjs';

const runner={profiles:async()=>[{id:'fake',label:'test',available:true,models:[{id:'test',label:'Test'}]}],execute:async()=>({text:'ok'})};

test('the file manager selects a file and opens a folder on each platform',()=>{
 assert.deepEqual(revealCommand('C:\\p q\\a.txt',{platform:'win32'}),{command:'explorer.exe',args:['/select,"C:\\p q\\a.txt"'],options:{windowsVerbatimArguments:true}});
 assert.deepEqual(revealCommand('C:\\p q',{platform:'win32',directory:true}).args,['"C:\\p q"']);
 assert.deepEqual(revealCommand('/p/a.txt',{platform:'darwin'}).args,['-R','/p/a.txt']);
 assert.deepEqual(revealCommand('/p',{platform:'darwin',directory:true}).args,['/p']);
 assert.deepEqual(revealCommand('/p/a.txt',{platform:'linux'}),{command:'xdg-open',args:['/p'],options:{}});
});

test('Show in File Explorer works only for a page on this machine and a project whose files are here',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-reveal-'));const calls=[];
 const app=await createStudio({stateDir:path.join(dir,'state'),projectRoot:path.join(dir,'projects'),port:0,previewPort:0,runner,homedir:path.join(dir,'home'),env:{},reveal:async(target,options)=>{calls.push({target,...options});}});
 t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});
 const call=(p,{method='GET',data,host=`127.0.0.1:${app.port}`}={})=>new Promise((resolve,reject)=>{const body=data?JSON.stringify(data):undefined;const req=http.request({host:'127.0.0.1',port:app.port,path:p,method,headers:{Host:host,...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(text)}));});req.on('error',reject);req.end(body);});
 const p=(await call('/api/projects',{method:'POST',data:{name:'reveal'}})).json,url=`/api/projects/${p.id}`;
 await fs.mkdir(path.join(p.path,'docs'));await fs.writeFile(path.join(p.path,'docs/a.md'),'a');
 const real=await fs.realpath(p.path);

 assert.equal((await call('/api/bootstrap')).json.features.reveal,{win32:'explorer',darwin:'finder'}[process.platform]||'files');
 assert.equal((await call(url)).json.filesHostId,app.hostId);
 assert.equal((await call(url+'/reveal',{method:'POST',data:{path:'docs/a.md'}})).status,200);
 assert.equal((await call(url+'/reveal',{method:'POST',data:{path:'docs'}})).status,200);
 assert.deepEqual(calls,[{target:path.join(real,'docs','a.md'),directory:false},{target:path.join(real,'docs'),directory:true}]);
 assert.equal((await call(url+'/reveal',{method:'POST',data:{path:'../outside'}})).status,400);

 // A page that reached this server by another name (the tailnet, another computer) cannot.
 assert.equal((await call('/api/bootstrap',{host:'desktop.example.ts.net'})).json.features?.reveal??null,null);

 // Files that live on another host: the menu item is greyed there, and the server refuses.
 await app.store.mutate(p.id,'test.owner',s=>{s.project.ownerHostId='elsewhere';});
 assert.equal((await call(url)).json.filesHostId,'elsewhere');
 const refused=await call(url+'/reveal',{method:'POST',data:{path:'docs/a.md'}});
 assert.equal(refused.status,409);assert.match(refused.json.error,/不在这台电脑/);
 assert.equal(calls.length,2);
});
