import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStudio} from '../src/server.mjs';
import {decodeScreenshot} from '../src/evidence.mjs';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=';
async function app(t,token=''){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'studio-evidence-'));
  let prompt='';
  const runner={profiles:async()=>[{id:"test",available:true,models:[{id:"test"}]}],execute:async input=>{prompt=input.prompt;return {text:'captured'};}};
  const service=await createStudio({stateDir:path.join(directory,'private'),projectRoot:path.join(directory,'projects'),port:0,previewPort:0,token,runner});
  t.after(async()=>{await service.close();await fs.rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${service.port}`;
  const request=(url,method='GET',data)=>fetch(base+url,{method,headers:{Authorization:'Bearer '+token,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
  const api=async(...args)=>{const response=await request(...args);const json=await response.json();assert.ok(response.ok,JSON.stringify(json));return json;};
  return {service,base,api,request,getPrompt:()=>prompt};
}

test('Canvas evidence persists as a project image and agent receives a readable file reference',async t=>{
  const a=await app(t);
  const p=await a.api('/api/projects','POST',{name:'Canvas'});
  await fs.writeFile(path.join(p.path,'index.html'),'<canvas></canvas>');
  const artifact=await a.api(`/api/projects/${p.id}/artifacts`,'POST',{name:'Canvas'});
  const input={requestId:'canvas-one',text:'修改选中区域',profileId:'test',model:'test',anchor:{kind:'canvas',selector:'canvas',screenshot:png}};
  const result=await a.api(`/api/projects/${p.id}/artifacts/${artifact.id}/annotations`,'POST',input);
  assert.equal(result.annotation.anchor.screenshot,undefined);
  assert.equal(result.annotation.anchor.screenshotPath,`.studio/attachments/${result.annotation.id}.png`);
  assert.deepEqual(await fs.readFile(path.join(p.path,result.annotation.anchor.screenshotPath)),decodeScreenshot(png).bytes);
  const endpoint=`/api/projects/${p.id}/annotations/${result.annotation.id}/evidence`;
  const response=await a.request(endpoint);
  assert.equal(response.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),decodeScreenshot(png).bytes);
  for(let i=0;i<80&&!a.getPrompt();i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(a.getPrompt().includes('Screenshot evidence file:'));
  assert.ok(a.getPrompt().includes(result.annotation.id+'.png'));
  assert.ok(!a.getPrompt().includes('base64,'));
  const retry=await a.api(`/api/projects/${p.id}/artifacts/${artifact.id}/annotations`,'POST',input);
  assert.equal(retry.annotation.id,result.annotation.id);
  assert.equal((await fs.readdir(path.join(p.path,'.studio/attachments'))).length,1);
});

test('malformed images and untrusted screenshot paths cannot become file evidence',async t=>{
  assert.throws(()=>decodeScreenshot('data:image/png;base64,PHNjcmlwdD4='),/类型/);
  const a=await app(t),p=await a.api('/api/projects','POST',{name:'Bounds'});
  const artifact=await a.api(`/api/projects/${p.id}/artifacts`,'POST',{name:'Bounds'});
  const input={requestId:'path-one',text:'检查',profileId:'test',model:'test',anchor:{screenshotPath:'../../secret.png'}};
  const item=await a.api(`/api/projects/${p.id}/artifacts/${artifact.id}/annotations`,'POST',input);
  assert.equal(item.annotation.anchor.screenshotPath,undefined);
  assert.equal((await a.request(`/api/projects/${p.id}/annotations/${item.annotation.id}/evidence`)).status,404);
});

test('shared project evidence is served locally with authentication',async t=>{
  const a=await app(t,'a-only'),b=await app(t,'b-only');
  const p=await b.api('/api/projects','POST',{name:'Remote'});
  await fs.cp(p.path,path.join(a.service.store.projectRoot,p.id),{recursive:true});
  await a.api('/api/hosts','POST',{url:b.base,token:'b-only',name:'B'});
  const artifact=await a.api(`/api/projects/${p.id}/artifacts`,'POST',{name:'Remote'});
  const item=await a.api(`/api/projects/${p.id}/artifacts/${artifact.id}/annotations`,'POST',{requestId:'remote-one',text:'查看图片',profileId:'test',model:'test',anchor:{screenshot:png}});
  const url=`/api/projects/${p.id}/annotations/${item.annotation.id}/evidence`;
  const response=await a.request(url);
  assert.equal(response.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),decodeScreenshot(png).bytes);
  assert.equal((await fetch(a.base+url)).status,401);
});
