import {spawn} from 'node:child_process';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {httpError} from './paths.mjs';
import {openMetadata} from './native-metadata.mjs';
import {discover as defaultDiscover} from './account-discovery.mjs';

// Sign-in, sign-out and capability refresh for registered accounts, on this machine.
// Claude subscription: `claude auth login` with a pasted authorization code (AccountAuth).
// Claude API key: stored in the account directory, verified through the CLI handshake.
// Codex ChatGPT: app-server device code (works from any browser, no localhost callback).
// Codex API key: app-server login, Codex stores it in the account's CODEX_HOME.
// Secrets pass through once and are never logged, kept in flow state or echoed back.
const now=()=>new Date().toISOString();
const run=(spawnProcess,command,args,env,timeoutMs=30000)=>new Promise(resolve=>{
  let done=false;const finish=code=>{if(done)return;done=true;clearTimeout(timer);resolve(code);};
  let child;try{child=spawnProcess(command,args,{cwd:os.tmpdir(),env,windowsHide:true,shell:false,stdio:['ignore','ignore','ignore']});}catch{return finish(-1);}
  const timer=setTimeout(()=>{try{child.kill();}catch{}finish(-1);},timeoutMs);
  child.on('error',()=>finish(-1));child.on('close',code=>finish(code??-1));
});

export class AccountLogin {
  constructor({accounts,runner,oauth,spawnProcess=spawn,discover=defaultDiscover,onChange=()=>{},deviceTimeoutMs=15*60000}){
    Object.assign(this,{accounts,runner,oauth,spawnProcess,discover,onChange,deviceTimeoutMs});
    this.flows=new Map();this.finished=new Map();
  }
  async config(id){
    const account=await this.accounts.get(id);
    const config=(await this.runner.configuration())[id];
    if(!config?.command)throw httpError('cli_missing',409);
    return {account,config};
  }
  async start(id,input={}){
    const {account,config}=await this.config(id);
    if(account.family==='claude'&&account.auth==='oauth'){
      const flow=await this.oauth.start(id);
      return {...flow,accountId:id,kind:'oauth'};
    }
    if(account.auth==='api_key'){
      const key=typeof input.apiKey==='string'?input.apiKey.trim():'';
      if(!key||key.length>4096||/\s/.test(key))throw httpError('api_key_invalid',400);
      if(account.family==='claude'){
        await this.accounts.writeKey(id,key);this.runner.invalidate?.();
        try{await this.refresh(id,{requireSignedIn:true});}
        catch(error){await this.accounts.removeKey(id);await this.accounts.update(id,{status:'signed_out',identity:null,lastError:'api_key_rejected'});throw httpError('api_key_rejected',400);}
        return {accountId:id,kind:'api_key',status:'ok'};
      }
      const connection=openMetadata(config,{spawnProcess:this.spawnProcess,timeoutMs:60000});
      try{await connection.initialize();await connection.rpc('account/login/start',{type:'apiKey',apiKey:key});}
      catch(error){throw httpError('api_key_rejected',400);}
      finally{connection.close();}
      await this.refresh(id,{requireSignedIn:true});
      return {accountId:id,kind:'api_key',status:'ok'};
    }
    return this.startDeviceCode(id,config);
  }
  // Codex device code: the CLI prints a URL and a one-time code; the user signs in anywhere,
  // the app-server notifies account/login/completed. The connection lives until then.
  async startDeviceCode(id,config){
    for(const flow of this.flows.values())if(flow.accountId===id)this.end(flow);
    const connection=openMetadata(config,{spawnProcess:this.spawnProcess,timeoutMs:this.deviceTimeoutMs+60000});
    const flow={id:randomUUID(),accountId:id,kind:'device_code',status:'starting',connection,url:null,userCode:null,error:null,loginId:null,startedAt:now()};
    this.flows.set(flow.id,flow);
    try{
      await connection.initialize();
      const started=await connection.rpc('account/login/start',{type:'chatgptDeviceCode'});
      if(typeof started?.verificationUrl!=='string'||typeof started?.userCode!=='string')throw new Error('unexpected response');
      flow.loginId=started.loginId??null;flow.url=started.verificationUrl;flow.userCode=started.userCode;flow.status='waiting_device';
    }catch(error){this.end(flow);throw httpError(/not supported|unknown variant|invalid/i.test(error.message)?'device_code_unsupported':'login_start_failed',502);}
    connection.on(event=>{
      if(this.flows.get(flow.id)!==flow)return;
      if(event.type==='close'){flow.status='failed';flow.error='login_failed';this.end(flow);return;}
      if(event.method!=='account/login/completed')return;
      const p=event.params||{};
      if(p.loginId&&flow.loginId&&p.loginId!==flow.loginId)return;
      if(p.success!==true){flow.status='failed';flow.error=typeof p.error==='string'?p.error.slice(0,200):'login_failed';this.end(flow);return;}
      flow.status='verifying';this.end(flow);
      this.refresh(id,{requireSignedIn:true}).then(()=>{flow.status='ok';},error=>{flow.status='failed';flow.error=error.message;});
    });
    flow.timer=setTimeout(()=>{if(this.flows.get(flow.id)===flow){flow.status='failed';flow.error='login_timeout';this.end(flow);}},this.deviceTimeoutMs);flow.timer.unref?.();
    return this.view(flow);
  }
  view(flow){return {id:flow.id,accountId:flow.accountId,kind:flow.kind,status:flow.status,url:flow.url,userCode:flow.userCode,error:flow.error};}
  status(flowId){
    const flow=this.flows.get(flowId)||this.finished.get(flowId);
    if(flow)return this.view(flow);
    const oauth=this.oauth?.view?.(flowId);
    if(oauth)return {...oauth,kind:'oauth'};
    throw httpError('login_expired',404);
  }
  async submit(flowId,code){
    if(!this.oauth?.view?.(flowId))throw httpError('login_expired',404);
    return this.oauth.submit(flowId,code);
  }
  cancel(flowId){
    const flow=this.flows.get(flowId);
    if(flow){flow.status='cancelled';this.end(flow);return {ok:true};}
    return this.oauth?.cancel?.(flowId)||{ok:true};
  }
  end(flow){
    clearTimeout(flow.timer);this.flows.delete(flow.id);flow.connection?.close();
    // Keep the outcome around briefly so a polling page sees it.
    this.finished.set(flow.id,flow);const timer=setTimeout(()=>this.finished.delete(flow.id),5*60000);timer.unref?.();
  }
  // Re-read sign-in state, identity and models from the account's own CLI.
  async refresh(id,{requireSignedIn=false}={}){
    const {account,config}=await this.config(id);
    let found;
    try{found=await this.discover[account.family](config,{spawnProcess:this.spawnProcess});}
    catch(error){await this.accounts.update(id,{lastError:'refresh_failed'});this.runner.invalidate?.();this.onChange(id);throw httpError('refresh_failed',502);}
    if(requireSignedIn&&!found.signedIn){await this.accounts.update(id,{status:'signed_out',identity:null,lastError:'not_logged_in'});this.runner.invalidate?.();this.onChange(id);throw httpError('not_logged_in',409);}
    const email=typeof found.identity?.email==='string'&&found.identity.email.includes('@')?found.identity.email:null;
    const updated=await this.accounts.update(id,{
      ...(account.labelAuto!==false&&email&&account.label!==email?{label:email,labelAuto:true}:{}),
      status:found.signedIn?'signed_in':'signed_out',identity:found.identity,
      models:found.models.length?found.models:account.models,modelsCheckedAt:found.models.length?now():account.modelsCheckedAt,
      commands:found.commands??account.commands??null,lastError:null,
    });
    this.runner.invalidate?.();this.onChange(id);
    return updated;
  }
  async logout(id){
    const account=await this.accounts.get(id);
    for(const flow of [...this.flows.values()])if(flow.accountId===id)this.end(flow);
    await this.runner.releaseAccount?.(id);
    const config=(await this.runner.configuration())[id];
    if(config?.command)await run(this.spawnProcess,config.command,[...config.args,...(account.family==='claude'?['auth','logout']:['logout'])],config.env);
    // The CLI should have removed its credentials; make sure nothing is left in the account directory.
    await this.accounts.removeCredentials(id);
    const updated=await this.accounts.update(id,{status:'signed_out',identity:null,lastError:null});
    this.runner.invalidate?.();this.onChange(id);
    return updated;
  }
  async remove(id){
    const account=await this.accounts.get(id);
    if(account.status==='signed_in'){try{await this.logout(id);}catch{}}
    for(const flow of [...this.flows.values()])if(flow.accountId===id)this.end(flow);
    await this.runner.releaseAccount?.(id);
    await this.accounts.remove(id);
    this.runner.invalidate?.();this.onChange(id);
  }
  close(){for(const flow of [...this.flows.values()])this.end(flow);for(const flow of this.finished.values())clearTimeout(flow.timer);this.finished.clear();}
}
