import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {writeJson,httpError} from './paths.mjs';

// Device allowlist (README「设备白名单」). A browser or app that reaches this server over the
// tailnet proves which device it is with a secret it generated and keeps; devices.json holds the
// secret's hash, the device's name and whether the user approved it, so nothing is handed out or
// copied between machines. The one exception is a token device, made here for native clients
// that cannot keep a generated secret (the iOS app): its secret is returned once at creation.
const digestOf=secret=>createHash('sha256').update(secret).digest('hex');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const ID=/^[0-9a-f-]{32,36}$/;
const PENDING_LIMIT=50;
export function cleanName(name){const value=String(name??'').replace(/[\r\n\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim();if(!value||[...value].length>60)throw httpError('设备名称需要 1–60 个字符');return value;}
const fingerprint=hash=>hash.slice(0,4)+'-'+hash.slice(4,8);

export class Devices {
  constructor({stateDir,now=()=>new Date().toISOString()}){Object.assign(this,{file:path.join(stateDir,'devices.json'),now,devices:[],sessions:new Map(),pendingSave:null});}
  async load(){try{const data=JSON.parse(await fs.readFile(this.file,'utf8'));this.devices=Array.isArray(data.devices)?data.devices:[];}catch(e){if(e.code!=='ENOENT')throw new Error('Cannot read devices.json: '+e.message);}return this;}
  async save(){clearTimeout(this.pendingSave);this.pendingSave=null;await writeJson(this.file,{devices:this.devices});}
  // Last-seen stamps change with every request; they reach the file a few seconds later, not each time.
  touch(d){d.lastSeenAt=this.now();if(!this.pendingSave){this.pendingSave=setTimeout(()=>{this.save().catch(()=>{});},5000);this.pendingSave.unref?.();}}
  view(d){const {hash,...rest}=d;return rest;}
  list(){return this.devices.map(d=>this.view(d));}
  get(id){const d=this.devices.find(d=>d.id===id);if(!d)throw httpError('设备不存在',404);return d;}
  // A device presenting its secret. Unknown: registered as pending under the name it chose. Known:
  // the secret must be the one it registered with; a pending device may still change its name.
  async identify({id,name,secret,agent}){
    if(typeof id!=='string'||!ID.test(id))throw httpError('无效设备标识');
    if(typeof secret!=='string'||secret.length<32||secret.length>256)throw httpError('无效设备密钥');
    const hash=digestOf(secret),at=this.now(),ua=String(agent||'').slice(0,200);let d=this.devices.find(d=>d.id===id);
    if(!d){
      if(this.devices.filter(d=>d.status==='pending').length>=PENDING_LIMIT)throw httpError('待批准的设备过多，请先在设置中清理',429);
      d={id,name:cleanName(name||'新设备'),kind:'device',fingerprint:fingerprint(hash),status:'pending',createdAt:at,lastSeenAt:at,agent:ua,hash};this.devices.push(d);await this.save();return this.view(d);
    }
    if(!same(d.hash,hash))throw httpError('设备密钥与登记的不一致；删除该设备后可重新登记',403);
    let changed=false;if(name!==undefined&&d.status==='pending'&&cleanName(name)!==d.name){d.name=cleanName(name);changed=true;}
    if(ua&&ua!==d.agent){d.agent=ua;changed=true;}
    d.lastSeenAt=at;if(changed)await this.save();else this.touch(d);
    return this.view(d);
  }
  // Any approved device's secret also works as a bearer token (native clients, scripts).
  byBearer(secret){if(typeof secret!=='string'||secret.length<32||secret.length>256)return null;const hash=digestOf(secret);const d=this.devices.find(d=>same(d.hash,hash));if(!d||d.status!=='approved')return null;this.touch(d);return this.view(d);}
  createSession(id){const sid=randomBytes(32).toString('hex');this.sessions.set(sid,id);return sid;}
  endSession(sid){if(sid)this.sessions.delete(sid);}
  session(sid){if(!sid||!this.sessions.has(sid))return null;const d=this.devices.find(d=>d.id===this.sessions.get(sid));if(!d||d.status!=='approved'){this.sessions.delete(sid);return null;}this.touch(d);return this.view(d);}
  dropSessions(id){for(const [sid,owner] of this.sessions)if(owner===id)this.sessions.delete(sid);}
  async approve(id){const d=this.get(id);if(d.status!=='approved'){d.status='approved';d.approvedAt=this.now();await this.save();}return this.view(d);}
  async revoke(id){const d=this.get(id);d.status='revoked';d.revokedAt=this.now();this.dropSessions(id);await this.save();return this.view(d);}
  async rename(id,name){const d=this.get(id);d.name=cleanName(name);await this.save();return this.view(d);}
  async remove(id){this.get(id);this.devices=this.devices.filter(d=>d.id!==id);this.dropSessions(id);await this.save();}
  // A token device for clients that cannot keep a generated secret; the secret is returned once.
  async createToken({name}){const secret='sdt_'+randomBytes(24).toString('hex'),hash=digestOf(secret),at=this.now();const d={id:randomUUID(),name:cleanName(name),kind:'token',fingerprint:fingerprint(hash),status:'approved',createdAt:at,approvedAt:at,lastSeenAt:null,agent:'',hash};this.devices.push(d);await this.save();return {device:this.view(d),secret};}
  async close(){if(this.pendingSave)await this.save();}
}
