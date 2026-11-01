import {openMetadata} from './native-metadata.mjs';
import {claudeCapabilities} from './commands.mjs';

// What an account can do, read from its own CLI without spending model tokens: whether it is
// signed in, who it is, which models it offers and (Claude) which slash commands exist.
export const claudeEfforts=id=>/haiku-4-5/.test(id)?[]:['low','medium','high','xhigh','max'];
const stamp=()=>new Date().toISOString().slice(0,10);
// "claude-fable-5-1[1m]" (a context-window variant the CLI may list or apply) is the same model.
const withoutContext=id=>id.trim().replace(/\[[^\]]*\]$/,'');
// claude-opus-5-5 → "Opus 5.5", claude-haiku-4-5-20251001 → "Haiku 4.5".
export const claudeLabel=id=>{const match=/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);return match?`${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}${match[3]?'.'+match[3]:''}`:id;};
// With an API key the CLI lists only the four aliases, labelled without versions ("Opus"). The Models API
// lists everything the key can use, with display names; it is optional, so a failure keeps the CLI list.
async function apiModels(env,fetcher){
  const key=env?.ANTHROPIC_API_KEY;if(!key||!fetcher)return [];
  const base=(env.ANTHROPIC_BASE_URL||'https://api.anthropic.com').replace(/\/+$/,''),models=[];let after=null;
  for(let page=0;page<10;page++){
    const url=new URL(base+'/v1/models');url.searchParams.set('limit','1000');if(after)url.searchParams.set('after_id',after);
    const response=await fetcher(url,{headers:{'x-api-key':key,'anthropic-version':'2023-06-01'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Models API '+response.status);
    const body=await response.json();for(const m of body.data||[])if(typeof m.id==='string'&&m.id.startsWith('claude-'))models.push({id:m.id,label:typeof m.display_name==='string'&&m.display_name?m.display_name.replace(/^Claude\s+/,''):claudeLabel(m.id)});
    if(!body.has_more||!body.last_id)break;after=body.last_id;
  }
  return models;
}

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
      let id=withoutContext(m.id);
      if(!id.startsWith('claude-')){
        try{await connection.rpc('set_model',{model:id});const settings=await connection.rpc('get_settings',{});const applied=withoutContext(String(settings?.applied?.model||''));if(!/^claude-/.test(applied))continue;id=applied;}
        catch{continue;}
      }
      if(seen.has(id))continue;seen.add(id);
      models.push({id,label:/\d/.test(m.label)?m.label:claudeLabel(id),efforts:claudeEfforts(id),evidence:`CLI model list ${stamp()}`,...(!m.id.startsWith('claude-')?{alias:m.id}:{})});
    }
    if(account?.apiKeySource){try{for(const m of await apiModels(config.env,options.fetch??globalThis.fetch)){const known=models.find(x=>x.id===m.id);if(known)known.label=m.label;else{models.push({id:m.id,label:m.label,efforts:claudeEfforts(m.id),evidence:`Models API ${stamp()}`});seen.add(m.id);}}}catch{}}
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
