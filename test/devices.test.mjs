import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {Devices} from '../src/devices.mjs';
import {loadTailnet} from '../src/tailnet.mjs';
import {createStudio} from '../src/server.mjs';

const runner={profiles:async()=>[{id:'fake',models:[{id:'test'}],available:true}],execute:async()=>({text:'ok'})};
const PEER='peer-token-for-tests-0123456789abcdef';
const secret=()=>'s'.repeat(32)+Math.random().toString(16).slice(2);
async function setup(t,options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-devices-'));
  const app=await createStudio({stateDir:path.join(dir,'state'),projectRoot:path.join(dir,'projects'),port:0,previewPort:0,runner,homedir:path.join(dir,'home'),env:{},deviceAllowlist:true,token:PEER,...options});
  t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});
  // Requests name a non-loopback Host, as a tailnet browser's would; `local` ones say 127.0.0.1.
  const call=(p,{method='GET',data,headers={},host='studiolo.test'}={})=>new Promise((resolve,reject)=>{const body=data?JSON.stringify(data):null;const req=http.request({host:'127.0.0.1',port:app.port,path:p,method,headers:{Host:host,...(body?{'Content-Type':'application/json'}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{let json={};try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,json,cookie:res.headers['set-cookie']?.[0]?.split(';')[0]||null});});});req.on('error',reject);if(body)req.write(body);req.end();});
  return {app,call,dir,local:`127.0.0.1:${app.port}`};
}

test('unknown devices are refused with a device code until approved, then hold a session',async t=>{
  const {call}=await setup(t);
  let r=await call('/api/bootstrap');assert.equal(r.status,401);assert.equal(r.json.code,'device');
  const me={id:'a'.repeat(32),secret:secret(),name:'MacBook · Safari'};
  r=await call('/api/device/login',{method:'POST',data:me});assert.equal(r.status,200);assert.equal(r.json.status,'pending');assert.equal(r.cookie,null);
  const id=r.json.device.id;assert.equal(id,me.id);assert.match(r.json.device.fingerprint,/^[0-9a-f]{4}-[0-9a-f]{4}$/);
  r=await call('/api/bootstrap');assert.equal(r.status,401);
  // A peer (another host) or an admin with the peer token lists and approves; hashes never leave.
  r=await call('/api/devices',{headers:{Authorization:'Bearer '+PEER}});assert.equal(r.status,200);assert.equal(r.json.enabled,true);assert.equal(r.json.devices.length,1);assert.equal(r.json.devices[0].status,'pending');assert.equal(r.json.devices[0].hash,undefined);
  r=await call(`/api/devices/${id}/approve`,{method:'POST',headers:{Authorization:'Bearer '+PEER}});assert.equal(r.status,200);assert.equal(r.json.device.status,'approved');
  r=await call('/api/device/login',{method:'POST',data:me});assert.equal(r.json.status,'approved');assert.ok(r.cookie);const cookie=r.cookie;
  r=await call('/api/bootstrap',{headers:{Cookie:cookie}});assert.equal(r.status,200);assert.equal(r.json.device.id,id);assert.equal(r.json.features.deviceAllowlist,true);
  r=await call('/api/devices',{headers:{Cookie:cookie}});assert.equal(r.json.current,id);
  // Its secret also works as a bearer token; a different secret under the same id is refused.
  r=await call('/api/bootstrap',{headers:{Authorization:'Bearer '+me.secret}});assert.equal(r.status,200);
  r=await call('/api/device/login',{method:'POST',data:{...me,secret:secret()}});assert.equal(r.status,403);
  // It cannot revoke itself, a peer can, and the session dies with it.
  r=await call(`/api/devices/${id}/revoke`,{method:'POST',headers:{Cookie:cookie}});assert.equal(r.status,409);
  r=await call(`/api/devices/${id}/revoke`,{method:'POST',headers:{Authorization:'Bearer '+PEER}});assert.equal(r.status,200);
  r=await call('/api/bootstrap',{headers:{Cookie:cookie}});assert.equal(r.status,401);
  r=await call('/api/device/login',{method:'POST',data:me});assert.equal(r.json.status,'revoked');assert.equal(r.cookie,null);
  r=await call(`/api/devices/${id}/approve`,{method:'POST',headers:{Authorization:'Bearer '+PEER}});assert.equal(r.json.device.status,'approved');
  // The page opened on the server machine itself needs no device.
  r=await call('/api/bootstrap',{host:'127.0.0.1'});assert.equal(r.status,200);assert.equal(r.json.device,null);
});

test('token devices serve native clients; the peer token itself cannot sign a browser in',async t=>{
  const {call,app}=await setup(t);
  let r=await call('/api/auth',{method:'POST',data:{token:PEER}});assert.equal(r.status,401);
  r=await call('/api/devices/tokens',{method:'POST',data:{name:'iPhone'},headers:{Authorization:'Bearer '+PEER}});assert.equal(r.status,201);
  const {device,secret:tok}=r.json;assert.match(tok,/^sdt_[0-9a-f]{48}$/);assert.equal(device.kind,'token');assert.equal(device.status,'approved');assert.equal(device.hash,undefined);
  r=await call('/api/bootstrap',{headers:{Authorization:'Bearer '+tok}});assert.equal(r.status,200);assert.equal(r.json.device.id,device.id);
  r=await call('/api/auth',{method:'POST',data:{token:tok}});assert.equal(r.status,200);assert.ok(r.cookie);
  r=await call('/api/bootstrap',{headers:{Cookie:r.cookie}});assert.equal(r.status,200);
  const saved=JSON.parse(await fs.readFile(path.join(app.stateDir,'devices.json'),'utf8'));assert.equal(saved.devices.length,1);assert.ok(!JSON.stringify(saved).includes(tok),'only the hash is stored');
  r=await call(`/api/devices/${device.id}`,{method:'PATCH',data:{name:'iPhone 17'},headers:{Authorization:'Bearer '+PEER}});assert.equal(r.json.device.name,'iPhone 17');
  r=await call(`/api/devices/${device.id}`,{method:'DELETE',headers:{Authorization:'Bearer '+PEER}});assert.equal(r.status,200);
  r=await call('/api/bootstrap',{headers:{Authorization:'Bearer '+tok}});assert.equal(r.status,401);
});

test('a device waiting on one host is approved from another through the peer hop',async t=>{
  const a=await setup(t),b=await setup(t);
  let r=await a.call('/api/hosts',{method:'POST',data:{name:'B',url:`http://127.0.0.1:${b.app.port}`,token:PEER},host:a.local});assert.equal(r.status,200);
  const me={id:'b'.repeat(32),secret:secret(),name:'iPad'};
  r=await b.call('/api/device/login',{method:'POST',data:me});assert.equal(r.json.status,'pending');
  r=await a.call(`/api/hosts/${b.app.hostId}/devices`,{host:a.local});assert.equal(r.status,200);assert.equal(r.json.hostId,b.app.hostId);assert.equal(r.json.devices[0].name,'iPad');
  r=await a.call(`/api/hosts/${b.app.hostId}/devices/${me.id}/approve`,{method:'POST',host:a.local});assert.equal(r.status,200);assert.equal(r.json.device.status,'approved');
  r=await b.call('/api/device/login',{method:'POST',data:me});assert.equal(r.json.status,'approved');assert.ok(r.cookie);
  r=await a.call(`/api/hosts/${b.app.hostId}/devices/tokens`,{method:'POST',data:{name:'Phone'},host:a.local});assert.equal(r.status,201);assert.match(r.json.secret,/^sdt_/);
});

test('the device table validates names, lets pending devices rename themselves and caps registrations',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-devices-unit-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const d=await new Devices({stateDir:dir}).load();
  await assert.rejects(d.identify({id:'x',secret:'s'.repeat(40)}),/无效设备标识/);
  await assert.rejects(d.identify({id:'c'.repeat(32),secret:'short'}),/无效设备密钥/);
  const v=await d.identify({id:'c'.repeat(32),secret:'s'.repeat(40),name:'  Mac  '});assert.equal(v.name,'Mac');assert.equal(v.status,'pending');
  await assert.rejects(d.rename(v.id,''),/1–60/);await assert.rejects(d.rename(v.id,'x'.repeat(61)),/1–60/);
  await d.identify({id:v.id,secret:'s'.repeat(40),name:'Mac mini'});assert.equal(d.get(v.id).name,'Mac mini');
  await d.approve(v.id);await d.identify({id:v.id,secret:'s'.repeat(40),name:'Other'});assert.equal(d.get(v.id).name,'Mac mini','an approved device keeps the name the user gave it');
  for(let i=0;i<50;i++)await d.identify({id:i.toString(16).padStart(32,'0'),secret:'t'.repeat(40)});
  await assert.rejects(d.identify({id:'f'.repeat(32),secret:'u'.repeat(40)}),/过多/);
  assert.equal(d.byBearer('t'.repeat(40)),null,'pending devices are not bearers');
  await d.close();const again=await new Devices({stateDir:dir}).load();assert.equal(again.list().length,51);assert.equal(again.byBearer('s'.repeat(40))?.id,v.id);
});

test('tailnet.json with deviceAllowlist needs the peer token file',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-devices-tailnet-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'tailnet.json'),JSON.stringify({enabled:true,deviceAllowlist:true}));
  await assert.rejects(loadTailnet(dir),/access-token\.txt/);
  await fs.writeFile(path.join(dir,'access-token.txt'),'x'.repeat(40)+'\n');
  const net=await loadTailnet(dir);assert.equal(net.deviceAllowlist,true);assert.equal(net.token,'x'.repeat(40));
});
