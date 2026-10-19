import {spawn} from 'node:child_process';
import os from 'node:os';

// Metadata-only connection to a CLI: Claude's bidirectional stream-json in safe mode without
// ever sending a user turn, or Codex app-server. Used for sign-in state, quota, model lists,
// account identity and sign-in flows. Any request the CLI makes back is refused.
export function openMetadata(config,{spawnProcess=spawn,timeoutMs=20000,cwd=os.tmpdir(),env}={}){
  if(!config.command)throw new Error('cli_missing');
  const codex=config.family==='codex';
  const args=codex?['app-server','--listen','stdio://']:['-p','--safe-mode','--input-format','stream-json','--output-format','stream-json','--verbose','--permission-prompt-tool','stdio'];
  const child=spawnProcess(config.command,[...(config.args||[]),...args],{cwd,env:env||config.env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  const pending=new Map(),listeners=new Set();
  let buffer='',seq=0,closed=false,failure=null,stderr='';
  const rejectAll=error=>{failure??=error;for(const p of pending.values())p.reject(error);pending.clear();};
  const write=message=>{if(!closed&&!child.stdin.destroyed)child.stdin.write(JSON.stringify(message)+'\n');};
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    if(closed)return reject(failure||new Error('cli_closed'));
    const id=String(++seq);pending.set(id,{resolve,reject});
    write(codex?{id,method,params}:{type:'control_request',request_id:id,request:{subtype:method,...params}});
  });
  child.on('error',e=>rejectAll(e));
  child.on('close',()=>{closed=true;clearTimeout(timer);rejectAll(new Error('cli_exited'));for(const l of listeners)l({type:'close',stderr});});
  child.stdin.on('error',e=>rejectAll(e));
  child.stderr.setEncoding('utf8');child.stderr.on('data',s=>{stderr=(stderr+s).slice(-4000);});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    buffer+=chunk;if(buffer.length>8*1024*1024){rejectAll(new Error('cli_output_overflow'));child.kill();return;}
    let index;while((index=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;
      let event;try{event=JSON.parse(line);}catch{continue;}
      const response=codex?event:event.response;
      const isResponse=codex?event.id!==undefined&&!event.method:event.type==='control_response';
      const call=isResponse?pending.get(String(codex?event.id:response?.request_id)):undefined;
      if(call){pending.delete(String(codex?event.id:response.request_id));if(codex?event.error:response?.subtype==='error')call.reject(new Error(String(codex?event.error?.message||'rpc_error':response.error||'rpc_error').slice(0,300)));else call.resolve(codex?event.result:response.response||{});continue;}
      if(codex&&event.id!==undefined&&event.method){write({id:event.id,error:{code:-32601,message:'Metadata-only connection'}});continue;}
      if(!codex&&event.type==='control_request'){write({type:'control_response',response:{subtype:'error',request_id:event.request_id,error:'Metadata-only connection'}});continue;}
      for(const l of listeners)l(event);
    }
  });
  let timer=setTimeout(()=>{rejectAll(new Error('cli_timeout'));child.kill();},timeoutMs);timer.unref?.();
  const close=()=>{if(closed)return;closed=true;clearTimeout(timer);try{child.stdin.end();}catch{}child.kill();rejectAll(new Error('cli_closed'));};
  const initialize=async()=>{const init=await rpc('initialize',codex?{clientInfo:{name:'studiolo',version:'0.2.0'},capabilities:{experimentalApi:true}}:{});if(codex)write({method:'initialized'});return init;};
  return {codex,rpc,write,initialize,close,on:l=>{listeners.add(l);return ()=>listeners.delete(l);},stderr:()=>stderr,get closed(){return closed;}};
}
