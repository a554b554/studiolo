import fs from 'node:fs/promises';
import {writeJson,httpError} from './paths.mjs';

// Per-user UI state that follows the user to every device and server: the last
// selected project and conversation, the theme and the interface language. One document
// (projects/.studio-ui.json), exchanged with every peer in the host index as a single
// last-writer-wins value, like the subagent settings. Browsers keep their own copy as a fallback.
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id=value=>value===null||typeof value==='string'&&value.length<=100&&/^[\w-]+$/.test(value);
const checks={
  selection:v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>['projectId','sessionId'].includes(k))&&(v.projectId==null||uuid.test(v.projectId))&&(v.sessionId==null||id(v.sessionId)),
  theme:v=>typeof v==='string'&&v.length<=40&&/^[\w-]+$/.test(v),
  language:v=>['zh-CN','en'].includes(v),
};
export class UiState{
  constructor({file,hostId=null}){this.file=file;this.hostId=hostId;this.cache=null;}
  async read(){
    let info=null;
    try{info=await fs.stat(this.file);}catch(e){if(e.code!=='ENOENT')throw e;}
    const key=info?`${info.size}:${info.mtimeMs}`:'missing';
    if(this.cache?.key===key)return this.cache.data;
    let data={};
    if(info)try{data=JSON.parse(await fs.readFile(this.file,'utf8'));}catch{data={};}
    if(!data||typeof data!=='object'||Array.isArray(data))data={};
    this.cache={key,data};return data;
  }
  async set(patch){
    if(!patch||typeof patch!=='object'||Array.isArray(patch))throw httpError('UI state must be an object');
    for(const [key,value] of Object.entries(patch))if(!checks[key]?.(value))throw httpError(`Invalid UI state: ${key}`);
    const data=await this.read();
    const next={...data,...patch,version:1,updatedAt:new Date().toISOString(),updatedHostId:this.hostId};
    await writeJson(this.file,next);this.cache=null;return next;
  }
  // A newer document from a peer replaces this server's copy as a whole.
  async replace(value){await writeJson(this.file,value);this.cache=null;}
}
