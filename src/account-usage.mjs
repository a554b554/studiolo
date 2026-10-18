import {spawn} from 'node:child_process';
import os from 'node:os';

const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const date=value=>{const n=typeof value==='number'?value*1000:Date.parse(value);return Number.isFinite(n)?new Date(n).toISOString():null;};
const text=value=>typeof value==='string'?value.slice(0,160):null;
function window(id,label,used,reset,minutes,extra={}){
  used=number(used);
  return {id,label,usedPercent:used,remainingPercent:used===null?null:Math.max(0,Math.min(100,100-used)),resetsAt:date(reset),windowDurationMins:minutes,...extra};
}

// Return only quota/account metadata. Never forward the CLI's full initialize or usage response.
export function normalizeUsage(config,raw){
  const result={id:config.id,label:config.label||config.id,family:config.family,summaryWindow:config.id==='claude1'||config.id==='claude2'?'five_hour':'seven_day',windows:[],plan:null,credits:null,resetCredits:null};
  if(config.family==='claude'){
    result.plan=text(raw.subscription_type);
    const limits=raw.rate_limits;
    if(!limits)throw new Error(raw.rate_limits_available===false?'quota_unavailable':'quota_read_failed');
    const normalized=Array.isArray(limits.limits)?limits.limits:[];
    for(const [key,label,minutes,kind] of [['five_hour','五小时额度',300,'session'],['seven_day','周额度',10080,'weekly_all']]){
      const row=limits[key],fallback=normalized.find(x=>x.kind===kind);
      if(row||fallback)result.windows.push(window(key,label,row?.utilization??fallback?.percent,row?.resets_at??fallback?.resets_at,minutes));
    }
    const scoped=normalized.filter(x=>x.kind==='weekly_scoped');
    if(scoped.length)scoped.forEach((row,i)=>result.windows.push(window(`scoped_${i}`,text(row.scope?.model?.display_name)||text(row.scope?.surface?.display_name)||'模型周额度',row.percent,row.resets_at,10080)));
    else if(Array.isArray(limits.model_scoped))limits.model_scoped.forEach((row,i)=>result.windows.push(window(`scoped_${i}`,text(row.display_name)||'模型周额度',row.utilization,row.resets_at,10080)));
    for(const [key,row] of Object.entries(limits)){
      if(!row||typeof row!=='object'||Array.isArray(row)||['five_hour','seven_day','extra_usage'].includes(key)||!Object.hasOwn(row,'utilization'))continue;
      if(scoped.length&&['seven_day_opus','seven_day_sonnet'].includes(key))continue;
      const names={seven_day_opus:'Opus',seven_day_sonnet:'Sonnet',seven_day_oauth_apps:'OAuth apps',seven_day_cowork:'Cowork'};
      result.windows.push(window(key,text(row.display_name)||names[key]||'其他额度',row.utilization,row.resets_at,key.startsWith('seven_day')?10080:null,{limitDollars:number(row.limit_dollars),remainingDollars:number(row.remaining_dollars)}));
    }
    const extra=limits.extra_usage;
    if(extra){
      const exponent=Number.isInteger(extra.decimal_places)&&extra.decimal_places>=0&&extra.decimal_places<=6?extra.decimal_places:null;
      const scale=exponent===null?null:10**exponent;
      result.credits={enabled:extra.is_enabled===true,currency:text(extra.currency),used:scale&&number(extra.used_credits)!==null?extra.used_credits/scale:null,limit:scale&&number(extra.monthly_limit)!==null?extra.monthly_limit/scale:null,usedPercent:number(extra.utilization)};
    }
  }else{
    const buckets=raw.rateLimitsByLimitId&&Object.keys(raw.rateLimitsByLimitId).length?raw.rateLimitsByLimitId:{default:raw.rateLimits};
    for(const [key,bucket] of Object.entries(buckets)){
      if(!bucket)continue;
      result.plan ||= text(bucket.planType);
      for(const slot of ['primary','secondary']){
        const row=bucket[slot];if(!row)continue;
        const minutes=number(row.windowDurationMins),kind=minutes===10080?'seven_day':minutes===300?'five_hour':`${key}_${slot}`;
        result.windows.push(window(`${key}_${slot}`,text(bucket.limitName)||text(bucket.limitId)||key,row.usedPercent,row.resetsAt,minutes,{kind,bucket:key}));
      }
      if(bucket.credits&&!result.credits)result.credits={enabled:bucket.credits.hasCredits===true,unlimited:bucket.credits.unlimited===true,balance:text(bucket.credits.balance),currency:null};
    }
    const reset=raw.rateLimitResetCredits;
    if(reset)result.resetCredits={availableCount:number(reset.availableCount),items:(reset.credits||[]).map(x=>({title:text(x.title),status:text(x.status),expiresAt:date(x.expiresAt)}))};
    if(!result.windows.length)throw new Error('quota_unavailable');
  }
  result.summary=result.windows.find(w=>(w.kind||w.id)===result.summaryWindow&&(config.family!=='codex'||w.bucket==='codex'))||result.windows.find(w=>(w.kind||w.id)===result.summaryWindow)||null;
  return result;
}

// Dedicated metadata connection: never starts a conversation or submits an inference turn.
export async function readNativeUsage(config,{spawnProcess=spawn,timeoutMs=20000}={}){
  if(!config.command)throw new Error('cli_missing');
  const codex=config.family==='codex';
  const args=codex?['app-server','--listen','stdio://']:['-p','--safe-mode','--input-format','stream-json','--output-format','stream-json','--verbose','--permission-prompt-tool','stdio'];
  const child=spawnProcess(config.command,[...config.args,...args],{cwd:os.tmpdir(),env:config.env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  const pending=new Map();let buffer='',seq=0,closed=false;
  const rejectAll=()=>{for(const p of pending.values())p.reject(new Error('quota_read_failed'));pending.clear();};
  const write=message=>child.stdin.write(JSON.stringify(message)+'\n');
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=String(++seq);pending.set(id,{resolve,reject});write(codex?{id,method,params}:{type:'control_request',request_id:id,request:{subtype:method,...params}});});
  child.on('error',rejectAll);child.on('close',()=>{closed=true;rejectAll();});child.stdin.on('error',rejectAll);child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    buffer+=chunk;if(buffer.length>4*1024*1024){rejectAll();child.kill();return;}
    let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{
      const event=JSON.parse(line),response=codex?event:event.response;
      const id=String(codex?event.id:response?.request_id),call=pending.get(id);
      if(call&&(!codex||!event.method)){pending.delete(id);if(event.error||response?.subtype==='error')call.reject(new Error('quota_read_failed'));else call.resolve(codex?event.result:response.response);}
      else if(codex&&event.id!==undefined&&event.method)write({id:event.id,error:{code:-32601,message:'Metadata-only connection'}});
      else if(event.type==='control_request')write({type:'control_response',response:{subtype:'error',request_id:event.request_id,error:'Metadata-only connection'}});
    }catch{rejectAll();}}});
  const timer=setTimeout(()=>{rejectAll();child.kill();},timeoutMs);
  try{
    await rpc('initialize',codex?{clientInfo:{name:'studio_usage',version:'0.1.0'},capabilities:{experimentalApi:true}}:{});
    if(codex)write({method:'initialized'});
    return await rpc(codex?'account/rateLimits/read':'get_usage');
  }finally{
    clearTimeout(timer);child.stdin.end();if(!closed)child.kill();rejectAll();
  }
}

export class AccountUsage {
  constructor({runner,read=readNativeUsage,now=Date.now,ttlMs=60000}){Object.assign(this,{runner,read,now,ttlMs});this.cache=null;this.pending=null;}
  async get({refresh=false}={}){
    if(this.pending)return this.pending;
    if(this.cache&&(!refresh||this.now()-this.lastAttempt<5000)&&this.now()-this.lastAttempt<this.ttlMs)return this.cache;
    this.pending=this.load();try{return await this.pending;}finally{this.pending=null;}
  }
  async load(){
    const configs=Object.values(await this.runner.configuration());
    const accounts=await Promise.all(configs.map(async config=>{
      const base={id:config.id,label:config.label||config.id,family:config.family,summaryWindow:['claude1','claude2'].includes(config.id)?'five_hour':'seven_day'};
      try{return {...normalizeUsage(config,await this.read(config)),status:'ok',updatedAt:new Date(this.now()).toISOString()};}
      catch(error){const previous=this.cache?.accounts.find(a=>a.id===config.id&&a.updatedAt);const code=['cli_missing','quota_unavailable'].includes(error.message)?error.message:'quota_read_failed';return {...base,...previous,status:previous?'stale':'unavailable',error:code,windows:previous?.windows||[],summary:previous?.summary||null};}
    }));
    this.lastAttempt=this.now();return this.cache={checkedAt:new Date(this.now()).toISOString(),accounts};
  }
}
