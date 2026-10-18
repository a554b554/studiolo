import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {AccountUsage,normalizeUsage,readNativeUsage} from '../src/account-usage.mjs';

const config=(id='claude')=>({id,label:id,family:id==='codex'?'codex':'claude',command:'fake',args:[],env:{}});
const claude={subscription_type:'team',rate_limits:{five_hour:{utilization:0,resets_at:null},seven_day:null,extra_usage:{is_enabled:false,monthly_limit:null,used_credits:null}}};
test('five-hour only accounts preserve zero usage without inventing a weekly quota',()=>{
 const row=normalizeUsage(config('claude1'),claude);
 assert.equal(row.summary.remainingPercent,100);assert.equal(row.summary.resetsAt,null);assert.equal(row.windows.length,1);assert.equal(row.credits.limit,null);
 assert.equal(normalizeUsage(config('claude'),claude).summary,null);
});
test('Claude extracts weekly, model-specific, and extra spend without behavior/session data',()=>{
 const row=normalizeUsage(config(),{...claude,behaviors:{secret:'private'},rate_limits:{...claude.rate_limits,seven_day:{utilization:36,resets_at:'2026-10-16T23:00:00Z'},limits:[{kind:'weekly_scoped',percent:61,scope:{model:{display_name:'Fable'}},resets_at:null}],extra_usage:{is_enabled:true,decimal_places:2,currency:'USD',monthly_limit:21500,used_credits:4710,utilization:21.9}}});
 assert.equal(row.summary.remainingPercent,64);assert.equal(row.windows[2].label,'Fable');assert.equal(row.windows[2].remainingPercent,39);assert.equal(row.credits.limit,215);assert.equal(row.credits.used,47.1);assert.doesNotMatch(JSON.stringify(row),/private|behaviors|session/);
});
test('Codex uses bucket map and identifies weekly window by duration, not primary/secondary position',()=>{
 const row=normalizeUsage(config('codex'),{rateLimits:{primary:{usedPercent:99}},rateLimitsByLimitId:{codex:{planType:'pro',primary:{usedPercent:21,windowDurationMins:10080,resetsAt:1792296035},secondary:{usedPercent:null,windowDurationMins:300,resetsAt:null},credits:{hasCredits:true,balance:'42'}},reviews:{primary:{usedPercent:120,windowDurationMins:10080}}},accountId:'private-account-id',rateLimitResetCredits:{availableCount:2,credits:[{id:'private-reset-id',title:'Full reset',status:'available',expiresAt:1793301068}]}});
 assert.equal(row.summary.remainingPercent,79);assert.equal(row.windows[1].remainingPercent,null);assert.equal(row.windows[2].remainingPercent,0);assert.match(row.summary.resetsAt,/2026/);assert.equal(row.resetCredits.availableCount,2);assert.doesNotMatch(JSON.stringify(row),/private/);
});
test('failed refresh retains timestamped previous data; missing data never becomes zero',async()=>{
 let now=0,fail=false,calls=0;
 const service=new AccountUsage({runner:{configuration:async()=>({claude:config()})},now:()=>now,read:async()=>{calls++;if(fail)throw Error('token=private');return claude;}});
 const first=await service.get();await service.get({refresh:true});assert.equal(calls,1);
 now=10000;fail=true;const second=await service.get({refresh:true});assert.equal(second.accounts[0].status,'stale');assert.equal(second.accounts[0].updatedAt,first.accounts[0].updatedAt);assert.doesNotMatch(JSON.stringify(second),/token|private/);
 const empty=new AccountUsage({runner:service.runner,read:async()=>{throw Error('bad');}});assert.equal((await empty.get()).accounts[0].summary,null);
});
test('parallel callers share one refresh and a failing account does not hide other accounts',async()=>{
 let calls=0;const service=new AccountUsage({runner:{configuration:async()=>({claude1:config('claude1'),claude2:config('claude2')})},read:async c=>{calls++;if(c.id==='claude2')throw Error('bad');return claude;}});
 const [a,b]=await Promise.all([service.get(),service.get({refresh:true})]);assert.equal(a,b);assert.equal(calls,2);assert.deepEqual(a.accounts.map(x=>x.status),['ok','unavailable']);
});
function native(codex,never=false){
 const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;child.emit('close');};const calls=[];
 child.stdin.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n')){const message=JSON.parse(line);calls.push(message);if(never||message.method==='initialized')continue;queueMicrotask(()=>{const result=(message.method||message.request.subtype)==='initialize'?{}:claude;child.stdout.write(JSON.stringify(codex?{id:message.id,result}:{type:'control_response',response:{request_id:message.request_id,subtype:'success',response:result}})+'\n');});}});
 return {child,calls,spawnProcess:()=>child};
}
test('quota readers use metadata RPC only, close processes, and bound hanging calls',async()=>{
 for(const id of ['claude','codex']){const f=native(id==='codex');await readNativeUsage(config(id),f);assert.equal(f.child.killed,true);const methods=f.calls.map(x=>x.method||x.request?.subtype);assert.ok(methods.includes(id==='codex'?'account/rateLimits/read':'get_usage'));assert.ok(!methods.includes('turn/start'));assert.ok(!methods.includes('thread/start'));assert.ok(!f.calls.some(x=>x.type==='user'));}
 const f=native(true,true);await assert.rejects(readNativeUsage(config('codex'),{...f,timeoutMs:10}),/quota_read_failed/);assert.equal(f.child.killed,true);
});
