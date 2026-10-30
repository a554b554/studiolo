import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeJson} from './paths.mjs';

// Host-level index exchanged with every peer: which projects exist, which were
// deleted, the shared settings document and the per-user UI document. Project contents travel separately through the
// per-project journal exchange; this only tells a server which journals to ask for.
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash=value=>createHash('sha1').update(JSON.stringify(value??null)).digest('hex');
// Last writer wins on updatedAt; equal timestamps are ordered by host id so both sides agree.
const newer=(a,b)=>!b||(a.updatedAt||'')>(b.updatedAt||'')||(a.updatedAt===b.updatedAt&&(a.hostId||'')>(b.hostId||''));

const shared=value=>Object.keys(value).length?{value,updatedAt:value.updatedAt||value.subagents?.updatedAt||null,hostId:value.updatedHostId||null}:null;
// Replaces a local document with a peer's newer, different one.
async function adopt(incoming,local,doc){
  if(!incoming?.value||typeof incoming.value!=='object'||Array.isArray(incoming.value)||!newer(incoming,local)||hash(incoming.value)===hash(local?.value))return false;
  await doc.replace(incoming.value);return true;
}

export class PeerIndex {
  constructor({store,policy,ui=null,hostId}){Object.assign(this,{store,policy,ui,hostId});}
  async tombstones(){
    const dir=path.join(this.store.projectRoot,'.deleted');const list=[];
    for(const name of await fs.readdir(dir).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
      const id=/^([0-9a-f-]{36})\.json$/.exec(name)?.[1];if(!id||!uuid.test(id))continue;
      try{const t=JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));list.push({id,name:t.name,deletedAt:t.deletedAt,hostId:t.hostId});}catch{list.push({id});}
    }
    return list.sort((a,b)=>a.id.localeCompare(b.id));
  }
  async settings(){return shared(await this.policy.read());}
  async uiState(){return this.ui?shared(await this.ui.read()):null;}
  async build(){
    await this.store.discoverProjects();
    const projects=this.store.registry.projects.map(p=>({id:p.id,name:p.name,ownerHostId:p.ownerHostId||null,createdAt:p.createdAt||null})).sort((a,b)=>a.id.localeCompare(b.id));
    const index={hostId:this.hostId,projects,deleted:await this.tombstones(),settings:await this.settings(),ui:await this.uiState()};
    return {...index,digest:hash({projects:index.projects,deleted:index.deleted,settings:index.settings,...(index.ui?{ui:index.ui}:{})})};
  }
  // Applies a peer's index; returns whether anything changed here.
  async merge(remote){
    let changed=false;
    const known=new Set((await this.tombstones()).map(t=>t.id));
    for(const t of remote.deleted||[]){
      if(!uuid.test(t.id||'')||known.has(t.id))continue;
      await writeJson(path.join(this.store.projectRoot,'.deleted',t.id+'.json'),{id:t.id,name:t.name,deletedAt:t.deletedAt,hostId:t.hostId});known.add(t.id);changed=true;
    }
    for(const p of remote.projects||[])if(uuid.test(p.id||'')&&!known.has(p.id)&&await this.store.adoptProject(p.id,p.name||p.id))changed=true;
    if(await adopt(remote.settings,await this.settings(),this.policy))changed=true;
    if(this.ui&&await adopt(remote.ui,await this.uiState(),this.ui))changed=true;
    return changed;
  }
}
