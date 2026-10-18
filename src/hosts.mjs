import fs from 'node:fs/promises';
import path from 'node:path';
import {writeJson,httpError} from './paths.mjs';
import {journalDigest} from './journal.mjs';

export class Hosts {
  constructor({machine,projectRoot,publicUrl,profiles}) {Object.assign(this,{machine,projectRoot,publicUrl,profiles});this.cache=null;this.inflight=null;this.syncing=new Map();this.digests=new Map();}
  async init(){
    this.directory=path.join(this.projectRoot,'.servers');await fs.mkdir(this.directory,{recursive:true});
    if(this.publicUrl)await writeJson(path.join(this.directory,this.machine.hostId+'.json'),{id:this.machine.hostId,name:this.machine.name,url:this.publicUrl});
  }
  async request(host,url,{method='GET',data,timeout=5000}={}){
    try{
      const response=await fetch(new URL(url,host.url),{method,headers:{...(host.token?{Authorization:'Bearer '+host.token}:{}),'X-Studio-Hop':'1',...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(timeout),redirect:'error'});
      const result=await response.json();if(!response.ok)throw httpError(result.error||'Remote request failed',response.status);return result;
    }catch(e){if(e.status)throw e;throw httpError(`${host.name||host.id}: server unavailable`,503);}
  }
  async online(origin){
    if(this.cache&&Date.now()-this.cache.at<4000)return this.cache.hosts;
    if(this.inflight)return this.inflight;
    this.inflight=(async()=>{
      const candidates=new Map((this.machine.hosts||[]).map(h=>[h.id,h]));
      for(const name of await fs.readdir(this.directory)){
        if(!/^[\da-f-]+\.json$/.test(name))continue;
        try{const h=JSON.parse(await fs.readFile(path.join(this.directory,name),'utf8'));const u=new URL(h.url);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!candidates.has(h.id))candidates.set(h.id,h);}catch{}
      }
      candidates.delete(this.machine.hostId);
      const remote=await Promise.all([...candidates.values()].map(async h=>{try{const info=await this.request(h,'/api/identity');return info.protocol===2&&info.hostId===h.id?{...h,profiles:info.profiles}:null;}catch{return null;}}));
      const hosts=[{id:this.machine.hostId,name:this.machine.name,local:true,url:this.publicUrl||origin,profiles:await this.profiles()},...remote.filter(Boolean)];
      this.cache={at:Date.now(),hosts};return hosts;
    })();try{return await this.inflight;}finally{this.inflight=null;}
  }
  async get(id,origin){const h=(await this.online(origin)).find(h=>h.id===id);if(!h)throw httpError('Conversation machine is offline or not yet upgraded. It cannot be changed; create another conversation to use an online machine.',503);return h;}
  visible(hosts){return hosts.map(({token,...h})=>h);}
  // Journals are exchanged every few seconds for every project and peer. While both sides
  // are already equal, a single digest probe replaces two name-list round trips, and no
  // event body is read from disk. Peers without digest support see the original protocol.
  async sync(store,host,id){
    const key=host.id+':'+id;if(this.syncing.has(key))return this.syncing.get(key);
    const pending=(async()=>{
      const url=`/api/projects/${id}/journal`,names=await store.journalNames(id),digest=journalDigest(names);
      if(this.digests.get(key)===digest){
        const probe=await this.request(host,url,{method:'POST',data:{digest}});
        if(probe.same===true&&probe.digest===digest)return;
      }
      this.digests.delete(key);
      let remote=await this.request(host,url,{method:'POST',data:{known:names,events:[]}});
      for(let page=0;page<100;page++){
        if(remote.events.length)await store.importJournal(id,remote.events);
        const outgoing=await store.journal(id,remote.names);
        // Nothing arrived and nothing is missing on the peer: the sets are equal, so the
        // confirming round trip (an empty import on the peer) is unnecessary.
        if(!remote.events.length&&!outgoing.events.length){this._remember(key,outgoing.names,remote.digest);break;}
        const next=await this.request(host,url,{method:'POST',data:{known:outgoing.names,events:outgoing.events}});
        if(!outgoing.events.length&&!next.events.length){this._remember(key,outgoing.names,next.digest);break;}
        remote=next;
      }
    })();this.syncing.set(key,pending);try{return await pending;}finally{this.syncing.delete(key);}
  }
  // Only a peer that reports a digest equal to our own set is probed next time.
  _remember(key,names,remoteDigest){if(typeof remoteDigest==='string'&&remoteDigest===journalDigest(names))this.digests.set(key,remoteDigest);}
}
