import {spawn} from 'node:child_process';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {httpError} from './paths.mjs';

// Browser-driven sign-in for a Claude profile on this machine. `claude auth login` prints a URL
// whose redirect page (platform.claude.com) shows an authorization code, then reads `code#state`
// from stdin and stores the new credentials itself; the PKCE verifier never leaves the CLI.
// Only the URL and a coarse status reach the browser. The pasted code goes to the CLI's stdin
// and is never logged, kept or echoed back.
const ESCAPES=/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OUTPUT_LIMIT=64*1024;

export function loginUrl(output){
  for(const [candidate] of output.replace(ESCAPES,'').matchAll(/https:\/\/\S+/g)){
    try{
      const url=new URL(candidate);
      if(/(^|\.)(claude\.com|claude\.ai|anthropic\.com)$/.test(url.hostname)&&url.pathname.endsWith('/oauth/authorize'))return url.href;
    }catch{}
  }
  return null;
}

// The CLI's own failure line, without the submitted code. It can follow the unterminated
// "Paste code here" prompt on the same line, since stdout and stderr share one buffer here.
function failure(output,code){
  const line=output.replace(ESCAPES,'').match(/Login failed:[^\r\n]*/g)?.pop();
  return line?line.replaceAll(code||'\0','').trim().slice(0,200):null;
}

export class AccountAuth {
  constructor({runner,spawnProcess=spawn,startTimeoutMs=30000,verifyTimeoutMs=60000,idleMs=15*60000,onSuccess=()=>{}}){
    Object.assign(this,{runner,spawnProcess,startTimeoutMs,verifyTimeoutMs,idleMs,onSuccess});this.flows=new Map();
  }

  async start(profileId){
    const config=(await this.runner.configuration())[profileId];
    if(!config||config.family!=='claude')throw httpError('login_unsupported',400);
    if(!config.command)throw httpError('cli_missing',409);
    for(const flow of this.flows.values())if(flow.profileId===profileId)this.end(flow);
    // BROWSER=true: the browser that asked for this opens the URL, not the server's desktop.
    const env={...config.env,BROWSER:'true'};delete env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN;
    const child=this.spawnProcess(config.command,[...config.args,'auth','login','--claudeai'],{cwd:os.tmpdir(),env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    const flow={id:randomUUID(),profileId,child,output:'',status:'starting',url:null,exit:null,listeners:new Set()};
    this.flows.set(flow.id,flow);
    const changed=()=>{for(const listener of flow.listeners)listener();};
    const collect=chunk=>{
      flow.output=(flow.output+chunk).slice(-OUTPUT_LIMIT);
      if(!flow.url&&(flow.url=loginUrl(flow.output)))flow.status='waiting_code';
      changed();
    };
    for(const stream of [child.stdout,child.stderr]){stream.setEncoding('utf8');stream.on('data',collect);}
    child.stdin.on('error',()=>{});
    child.on('error',()=>{flow.exit??=-1;changed();});
    child.on('close',code=>{flow.exit??=code??-1;changed();});
    flow.idle=setTimeout(()=>this.end(flow),this.idleMs);flow.idle.unref?.();
    try{
      await this.until(flow,()=>flow.url||flow.exit!==null,this.startTimeoutMs);
      if(!flow.url)throw httpError('login_start_failed',502);
    }catch(error){this.end(flow);throw error.status?error:httpError('login_start_failed',502);}
    return {id:flow.id,profileId,status:flow.status,url:flow.url};
  }

  async submit(id,code){
    const flow=this.flows.get(id);
    if(!flow)throw httpError('login_expired',404);
    if(flow.status!=='waiting_code')throw httpError('login_busy',409);
    code=typeof code==='string'?code.trim():'';
    if(code.length>4096||!/^[^\s#]+#[^\s#]+$/.test(code))throw httpError('login_code_invalid',400);
    flow.status='verifying';
    const mark=flow.output.length;
    flow.child.stdin.write(code+'\n');
    try{await this.until(flow,()=>flow.exit!==null||/Invalid code/.test(flow.output.slice(mark)),this.verifyTimeoutMs);}
    catch{this.end(flow);return {status:'failed',error:'login_timeout'};}
    if(flow.exit===null){flow.status='waiting_code';return {status:'waiting_code',error:'login_code_invalid'};}
    this.end(flow);
    if(flow.exit===0&&/Login successful/.test(flow.output)){await this.onSuccess(flow.profileId);return {status:'ok'};}
    return {status:'failed',error:'login_failed',detail:failure(flow.output,code)};
  }

  cancel(id){const flow=this.flows.get(id);if(flow)this.end(flow);return {ok:true};}
  // Coarse state for a polling page; never the output or the code.
  view(id){const flow=this.flows.get(id);return flow?{id:flow.id,profileId:flow.profileId,accountId:flow.profileId,status:flow.status,url:flow.url,error:null}:null;}

  end(flow){clearTimeout(flow.idle);this.flows.delete(flow.id);if(flow.exit===null)flow.child.kill();}

  until(flow,ready,timeoutMs){
    if(ready())return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const check=()=>{if(ready()){done();resolve();}};
      const timer=setTimeout(()=>{done();reject(new Error('timeout'));},timeoutMs);
      const done=()=>{clearTimeout(timer);flow.listeners.delete(check);};
      flow.listeners.add(check);
    });
  }

  close(){for(const flow of [...this.flows.values()])this.end(flow);}
}
