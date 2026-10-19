import {openMetadata} from './native-metadata.mjs';
import {claudeCapabilities} from './commands.mjs';

// What an account can do, read from its own CLI without spending model tokens: whether it is
// signed in, who it is, which models it offers and (Claude) which slash commands exist.
export const claudeEfforts=id=>/haiku-4-5/.test(id)?[]:['low','medium','high','xhigh','max'];
const stamp=()=>new Date().toISOString().slice(0,10);

// The initialize handshake lists aliases (opus, sonnet, …) next to concrete ids. Aliases are
// resolved through set_model/get_settings, which only changes this metadata connection.
export async function discoverClaude(config,options={}){
  const connection=openMetadata(config,{timeoutMs:60000,...options});
  try{
    const init=await connection.initialize();
    const capabilities=claudeCapabilities(init);
    const account=init?.account&&typeof init.account==='object'?init.account:null;
    const signedIn=Boolean(account&&(account.email||account.apiKeySource||account.subscriptionType)&&account.tokenSource!=='none'||account?.apiKeySource);
    const models=[],seen=new Set();
    for(const m of capabilities.models){
      if(m.id==='default')continue;
      let id=m.id;
      if(!id.startsWith('claude-')){
        try{await connection.rpc('set_model',{model:id});const settings=await connection.rpc('get_settings',{});const applied=String(settings?.applied?.model||'').replace(/\[1m\]$/,'');if(!/^claude-/.test(applied))continue;id=applied;}
        catch{continue;}
      }
      if(seen.has(id))continue;seen.add(id);
      models.push({id,label:m.label,efforts:claudeEfforts(id),evidence:`CLI model list ${stamp()}`,...(m.id!==id?{alias:m.id}:{})});
    }
    return {signedIn,identity:account?{email:account.email||null,plan:account.subscriptionType||null,organization:account.organization||null,provider:account.apiProvider||null}:null,models,commands:capabilities.commands};
  }finally{connection.close();}
}

export async function discoverCodex(config,options={}){
  const connection=openMetadata(config,{timeoutMs:60000,...options});
  try{
    await connection.initialize();
    let identity=null,signedIn=false;
    try{const read=await connection.rpc('account/read',{});const a=read?.account;if(a&&typeof a==='object'){signedIn=true;identity={email:typeof a.email==='string'?a.email:null,plan:typeof a.planType==='string'?a.planType:null,type:typeof a.type==='string'?a.type:null};}}
    catch(e){if(!/not.*logged|unauthori|auth/i.test(e.message))throw e;}
    const models=[];let cursor=null,pages=0;
    try{
      do{
        const page=await connection.rpc('model/list',{cursor,limit:100});
        for(const m of page?.data||[]){
          if(m.hidden||typeof (m.id||m.model)!=='string')continue;
          models.push({id:m.id||m.model,label:typeof m.displayName==='string'?m.displayName:m.id||m.model,efforts:(m.supportedReasoningEfforts||[]).map(x=>typeof x==='string'?x:x?.reasoningEffort||x?.effort).filter(x=>typeof x==='string'),...(typeof m.defaultReasoningEffort==='string'?{defaultEffort:m.defaultReasoningEffort}:{}),...(m.isDefault===true?{isDefault:true}:{}),evidence:`CLI model list ${stamp()}`});
        }
        cursor=typeof page?.nextCursor==='string'?page.nextCursor:null;
      }while(cursor&&++pages<20);
    }catch{}
    return {signedIn,identity,models,commands:null};
  }finally{connection.close();}
}

export const discover={claude:discoverClaude,codex:discoverCodex};
