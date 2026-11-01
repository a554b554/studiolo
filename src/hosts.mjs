import {httpError} from './paths.mjs';
import {journalDigest} from './journal.mjs';

export class Hosts {
  constructor({machine,version=null,publicUrl,profiles,files=null}) {Object.assign(this,{machine,version,publicUrl,profiles,files});this.cache=null;this.inflight=null;this.syncing=new Map();this.digests=new Map();}
  // `raw` sends bytes as they are (a recording forwarded for transcription) with headers['Content-Type'].
  async request(host,url,{method='GET',data,raw,timeout=5000,headers={}}={}){
    try{
      const response=await fetch(new URL(url,host.url),{method,headers:{...headers,...(host.token?{Authorization:'Bearer '+host.token}:{}),'X-Studio-Hop':'1',...(data?{'Content-Type':'application/json'}:{})},body:raw??(data?JSON.stringify(data):undefined),signal:AbortSignal.timeout(timeout),redirect:'error'});
      const result=await response.json();if(!response.ok)throw httpError(result.error||'Remote request failed',response.status);return result;
    }catch(e){if(e.status)throw e;throw httpError(`${host.name||host.id}: server unavailable`,503);}
  }
  async online(origin){
    if(this.cache&&Date.now()-this.cache.at<4000)return this.cache.hosts;
    if(this.inflight)return this.inflight;
    this.inflight=(async()=>{
      // Peers come from machine.json alone (registered in Settings, mutually through /api/peer/hello).
      const candidates=new Map((this.machine.hosts||[]).map(h=>[h.id,h]));
      candidates.delete(this.machine.hostId);
      const remote=await Promise.all([...candidates.values()].map(async h=>{try{const info=await this.request(h,'/api/identity');return info.protocol===2&&info.hostId===h.id?{...h,version:info.version||null,profiles:info.profiles,files:info.files||null,transcribe:info.transcribe===true}:null;}catch{return null;}}));
      const hosts=[{id:this.machine.hostId,name:this.machine.name,local:true,version:this.version,url:this.publicUrl||origin,profiles:await this.profiles(),files:this.files},...remote.filter(Boolean)];
      this.cache={at:Date.now(),hosts};return hosts;
    })();try{return await this.inflight;}finally{this.inflight=null;}
  }
  // Every registered peer with its last probe result and release, for the Settings list (offline ones included).
  async configured(origin){const online=new Map((await this.online(origin)).map(h=>[h.id,h]));return (this.machine.hosts||[]).map(({token,...h})=>({...h,online:online.has(h.id),version:online.get(h.id)?.version||null}));}
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
  // Host index exchange. After a full exchange both sides hold the union, so while
  // neither changes, a probe with the peer's last digest replaces sending the whole index.
  async syncIndex(index,host){
    const key='index:'+host.id;if(this.syncing.has(key))return this.syncing.get(key);
    const pending=(async()=>{
      const local=await index.build(),last=this.digests.get(key);
      if(last?.local===local.digest){const probe=await this.request(host,'/api/peer/index',{method:'POST',data:{digest:last.remote}});if(probe.same===true)return false;}
      const remote=await this.request(host,'/api/peer/index',{method:'POST',data:local,timeout:30000});
      const changed=await index.merge(remote);
      this.digests.set(key,{local:changed?(await index.build()).digest:local.digest,remote:remote.digest});
      return changed;
    })();this.syncing.set(key,pending);try{return await pending;}finally{this.syncing.delete(key);}
  }
  // Streams a request whose body or answer is not JSON (uploads, images) to the host that holds
  // the files, and its answer back to the browser.
  async proxy(host,req,res,url,{timeout=300000}={}){
    const forwarded=Object.fromEntries(['content-type','content-length','if-none-match'].filter(k=>req.headers[k]).map(k=>[k,req.headers[k]]));
    let response;
    try{response=await fetch(new URL(url,host.url),{method:req.method,headers:{...forwarded,...(host.token?{Authorization:'Bearer '+host.token}:{}),'X-Studio-Hop':'1'},body:['GET','HEAD'].includes(req.method)?undefined:req,duplex:'half',signal:AbortSignal.timeout(timeout),redirect:'error'});}
    catch{throw httpError(`${host.name||host.id}: server unavailable`,503);}
    // fetch already decoded any compression, so length and encoding are not passed on.
    const headers=Object.fromEntries(['content-type','cache-control','etag','x-content-type-options','content-security-policy'].filter(k=>response.headers.has(k)).map(k=>[k,response.headers.get(k)]));
    res.writeHead(response.status,headers);
    if(response.body&&req.method!=='HEAD')for await(const chunk of response.body)res.write(chunk);
    res.end();
  }
  // Only a peer that reports a digest equal to our own set is probed next time.
  _remember(key,names,remoteDigest){if(typeof remoteDigest==='string'&&remoteDigest===journalDigest(names))this.digests.set(key,remoteDigest);}
}
