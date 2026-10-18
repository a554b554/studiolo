import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {safePath,httpError} from './paths.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limit=5*1024*1024;
const validOps=ops=>Array.isArray(ops)&&ops.length>0&&ops.length<=1000&&ops.every(op=>
  op&&(['clear'].includes(op.type)||['set','remove','import'].includes(op.type)&&typeof op.key==='string'&&
  (op.type==='remove'||typeof op.value==='string')));
function apply(data,touched,ops){
  for(const op of ops){
    if(op.type==='clear'){touched.add(null);for(const key of data.keys())touched.add(key);data.clear();continue;}
    if(op.type==='import'&&(touched.has(null)||touched.has(op.key)))continue;
    touched.add(op.key);
    if(op.type==='remove')data.delete(op.key);else data.set(op.key,op.value);
  }
}

// Each save is an immutable file: Syncthing can merge independent keys from both hosts
// without two writers replacing the same JSON file. Causal sequence + UUID is deterministic.
export class ArtifactStorage {
  constructor(){this.tails=new Map();this.cache=new Map();}
  async directory(projectPath,aid){
    if(!uuid.test(aid))throw httpError('Invalid Artifact ID');
    return safePath(projectPath,`.studio/artifact-storage/${aid}`,{missing:true});
  }
  async read(projectPath,aid){
    const directory=await this.directory(projectPath,aid);
    let names;try{names=await fs.readdir(directory);}catch(error){if(error.code==='ENOENT')names=[];else throw error;}
    const previous=this.cache.get(directory)||new Map(),cache=new Map(),events=[];
    for(const name of names.filter(n=>uuid.test(n.replace(/\.json$/,''))&&n.endsWith('.json'))){
      const filename=await safePath(projectPath,`.studio/artifact-storage/${aid}/${name}`);
      const info=await fs.stat(filename),identity=`${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if(info.size>limit*2)throw httpError('Artifact 存档过大',413);
      let item=previous.get(name);
      if(item?.identity!==identity){
        const event=JSON.parse(await fs.readFile(filename,'utf8'));
        if(event.schema!==1||event.id+'.json'!==name||!Number.isSafeInteger(event.seq)||event.seq<1||!validOps(event.ops))throw httpError('Artifact 存档损坏，未覆盖原数据',409);
        item={identity,event};
      }
      cache.set(name,item);events.push(item.event);
    }
    this.cache.set(directory,cache);
    events.sort((a,b)=>a.seq-b.seq||a.id.localeCompare(b.id));
    const data=new Map(),touched=new Set();for(const event of events)apply(data,touched,event.ops);
    return {data:Object.fromEntries(data),events,touched,sequence:events.at(-1)?.seq||0};
  }
  async save(projectPath,aid,input){
    if(!input||!uuid.test(input.id)||!validOps(input.ops)||Buffer.byteLength(JSON.stringify(input))>limit)throw httpError('无效或过大的 Artifact 存档',400);
    const directory=await this.directory(projectPath,aid);
    const next=(this.tails.get(directory)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const current=await this.read(projectPath,aid),existing=current.events.find(e=>e.id===input.id);
      if(existing){if(JSON.stringify(existing.ops)!==JSON.stringify(input.ops))throw httpError('存档请求 ID 已被使用',409);return {saved:true};}
      const data=new Map(Object.entries(current.data));apply(data,current.touched,input.ops);
      if(Buffer.byteLength(JSON.stringify(Object.fromEntries(data)))>limit)throw httpError('Artifact 存储超过 5 MiB',413);
      await fs.mkdir(directory,{recursive:true});
      const filename=await safePath(projectPath,`.studio/artifact-storage/${aid}/${input.id}.json`,{missing:true});
      const temp=filename+'.'+randomUUID()+'.tmp';
      const handle=await fs.open(temp,'wx',0o600);
      try{await handle.writeFile(JSON.stringify({schema:1,id:input.id,seq:current.sequence+1,ops:input.ops}));await handle.sync();}finally{await handle.close();}
      await fs.rename(temp,filename);
      return {saved:true};
    });
    this.tails.set(directory,next);
    try{return await next;}finally{if(this.tails.get(directory)===next)this.tails.delete(directory);}
  }
  async handle(req,res,projectPath,aid){
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
    if(req.method==='GET'){const {data}=await this.read(projectPath,aid);res.end(JSON.stringify({data}));return;}
    if(req.method!=='POST'){res.writeHead(405);res.end('{}');return;}
    if(req.headers['x-studio-storage']!=='1'||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw httpError('Invalid storage request',403);
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw httpError('Artifact 存档过大',413);chunks.push(chunk);}
    const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const batches=input.batches||[input];
    if(!Array.isArray(batches)||!batches.length||batches.length>1000)throw httpError('Invalid storage batch');
    for(const batch of batches)await this.save(projectPath,aid,batch);
    res.end(JSON.stringify({saved:true}));
  }
}
