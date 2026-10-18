// Runs before Artifact scripts. App localStorage is backed by project files; sessionStorage
// remains browser-local. Native localStorage only retains an outbox for interrupted saves.
(() => {
  const config=window.__STUDIO_STORAGE__;if(!config)return;
  const endpoint='/__studio/storage',outboxKey='__studio_outbox_'+config.id+'_',importKey='__studio_imported_'+config.id;
  let native;try{native=window.localStorage;}catch{}
  const pending=[];if(native)for(let i=0;i<native.length;i++){const key=native.key(i);if(key.startsWith(outboxKey)){try{const batch=JSON.parse(native.getItem(key));if(batch.id&&Array.isArray(batch.ops))pending.push(batch);}catch{}}}
  pending.sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)||a.id.localeCompare(b.id));
  const data=new Map(Object.entries(config.data)),touched=new Set(config.touched);let flight,retryTimer;
  const id=()=>globalThis.crypto.randomUUID?.()||'10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
  const apply=op=>{if(op.type==='clear'){touched.add(null);for(const key of data.keys())touched.add(key);data.clear();}else if(op.type!=='import'||!touched.has(null)&&!touched.has(op.key)){touched.add(op.key);if(op.type==='remove')data.delete(op.key);else data.set(op.key,op.value);}};
  for(const batch of pending)for(const op of batch.ops||[])apply(op);
  const notify=(status,error)=>{const bridge=window.__STUDIO_BRIDGE__;if(bridge&&parent!==window)parent.postMessage({type:'studio:persistence',nonce:bridge.nonce,status,error},bridge.parentOrigin);};
  function flush(){
    if(flight)return flight;clearTimeout(retryTimer);
    flight=Promise.resolve().then(async()=>{try{
      while(pending.length){
        notify('saving');const batch=pending[0];
        const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Storage':'1'},body:JSON.stringify(batch)});
        if(!response.ok)throw Error((await response.json().catch(()=>({}))).error||`Save failed (${response.status})`);
        pending.shift();native?.removeItem(outboxKey+batch.id);
      }
      notify('saved');
    }catch(error){notify('error',error.message);retryTimer=setTimeout(flush,3000);}
    finally{flight=null;}
    return pending.length===0;});return flight;
  }
  function enqueue(ops){
    const projected=new Map(data);for(const op of ops){if(op.type==='clear')projected.clear();else if(op.type==='remove')projected.delete(op.key);else projected.set(op.key,op.value);}
    if(new Blob([JSON.stringify(Object.fromEntries(projected))]).size>5*1024*1024)throw new DOMException('Artifact storage exceeds 5 MiB','QuotaExceededError');
    const batch={id:id(),ops,createdAt:Date.now()};native?.setItem(outboxKey+batch.id,JSON.stringify(batch));pending.push(batch);
    for(const op of ops)apply(op);queueMicrotask(flush);
  }
  // Import previous browser saves once, preserving server values and deleted-key tombstones.
  if(native&&!native.getItem(importKey)){
    const ops=[];for(let i=0;i<native.length;i++){const key=native.key(i);if(!key.startsWith('__studio_'))ops.push({type:'import',key,value:native.getItem(key)});}
    if(ops.length)enqueue(ops);native.setItem(importKey,'1');
  }
  const methods={getItem:key=>data.get(String(key))??null,setItem:(key,value)=>enqueue([{type:'set',key:String(key),value:String(value)}]),removeItem:key=>enqueue([{type:'remove',key:String(key)}]),clear:()=>enqueue([{type:'clear'}]),key:index=>[...data.keys()][Number(index)>>>0]??null};
  const storage=new Proxy({}, {
    get:(_,key)=>key==='length'?data.size:key===Symbol.toStringTag?'Storage':Object.hasOwn(methods,key)?methods[key]:data.get(key),
    set:(_,key,value)=>{methods.setItem(key,value);return true;},
    deleteProperty:(_,key)=>{methods.removeItem(key);return true;},
    ownKeys:()=>[...data.keys()],
    has:(_,key)=>data.has(key)||Object.hasOwn(methods,key)||key==='length',
    getOwnPropertyDescriptor:(_,key)=>data.has(key)?{configurable:true,enumerable:true,writable:true,value:data.get(key)}:undefined
  });
  Object.defineProperty(window,'localStorage',{configurable:true,get:()=>storage});
  window.addEventListener('message',async event=>{const bridge=window.__STUDIO_BRIDGE__;if(!bridge||event.source!==parent||event.origin!==bridge.parentOrigin||event.data?.nonce!==bridge.nonce||event.data.type!=='studio:storage-flush')return;const saved=await flush();parent.postMessage({type:'studio:storage-flushed',nonce:bridge.nonce,id:event.data.id,saved},bridge.parentOrigin);});
  window.addEventListener('online',flush);
  window.addEventListener('pagehide',()=>{if(!pending.length)return;const body=JSON.stringify({batches:pending});if(new Blob([body]).size<60000)fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Storage':'1'},body,keepalive:true}).catch(()=>{});});
  window.addEventListener('storage',event=>{if(!event.key?.startsWith(outboxKey)||!event.newValue)return;try{const batch=JSON.parse(event.newValue);if(!pending.some(item=>item.id===batch.id)){pending.push(batch);for(const op of batch.ops)apply(op);queueMicrotask(flush);}}catch{}});
  queueMicrotask(flush);
})();
