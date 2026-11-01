#!/usr/bin/env node
// Device allowlist on this machine (README「设备白名单」): list, approve, revoke, rename or remove
// devices, or make a token for a native client. It talks to the server on 127.0.0.1, so it runs on
// the server machine itself (over SSH for the mini) and needs no credentials.
import {DEFAULT_PORT} from '../src/defaults.mjs';

const base=`http://127.0.0.1:${process.env.STUDIO_PORT||DEFAULT_PORT}`;
const [command,id,...rest]=process.argv.slice(2);
async function call(path,method='GET',data){const res=await fetch(base+path,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined}).catch(e=>{throw new Error(`Studiolo is not answering on ${base}: ${e.message}`);});const json=await res.json().catch(()=>({}));if(!res.ok)throw new Error(json.error||`HTTP ${res.status}`);return json;}
const usage=()=>{console.error('Usage: node scripts/devices.mjs list | approve <id> | revoke <id> | remove <id> | rename <id> <name> | token <name>');process.exit(2);};
const show=d=>`${d.status.padEnd(8)} ${d.id}  ${d.fingerprint}  ${d.kind==='token'?'[token] ':''}${d.name}${d.lastSeenAt?'  last seen '+d.lastSeenAt:''}`;
try{
  if(!command||command==='list'){const {hostName,enabled,devices}=await call('/api/devices');if(!enabled)console.log(`${hostName}: the device allowlist is off (tailnet.json "deviceAllowlist")`);for(const d of devices)console.log(show(d));if(enabled&&!devices.length)console.log('No devices registered yet.');}
  else if(command==='approve'&&id)console.log(show((await call(`/api/devices/${encodeURIComponent(id)}/approve`,'POST')).device));
  else if(command==='revoke'&&id)console.log(show((await call(`/api/devices/${encodeURIComponent(id)}/revoke`,'POST')).device));
  else if(command==='remove'&&id){await call(`/api/devices/${encodeURIComponent(id)}`,'DELETE');console.log('Removed '+id);}
  else if(command==='rename'&&id&&rest.length)console.log(show((await call(`/api/devices/${encodeURIComponent(id)}`,'PATCH',{name:rest.join(' ')})).device));
  else if(command==='token'&&id){const {device,secret}=await call('/api/devices/tokens','POST',{name:[id,...rest].join(' ')});console.log(`Token device "${device.name}" (${device.id}) created. Its secret is shown once; enter it as the access token in the client:\n${secret}`);}
  else usage();
}catch(e){console.error(e.message);process.exit(1);}
