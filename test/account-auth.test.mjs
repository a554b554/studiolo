import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {AccountAuth,loginUrl} from '../src/account-auth.mjs';
import {createStudio} from '../src/server.mjs';

const URL_LINE='If the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s\n';
const profiles={
 claude1:{id:'claude1',family:'claude',command:'claude',args:[],env:{CLAUDE_CONFIG_DIR:'/home/u/.claude1',CLAUDE_CODE_OAUTH_REFRESH_TOKEN:'private-refresh'}},
 codex:{id:'codex',family:'codex',command:'codex',args:[],env:{}},
 missing:{id:'missing',family:'claude',command:null,args:[],env:{}},
};
// Behaves like `claude auth login`: prints the URL, then answers one pasted line.
function fakeCli({print=true}={}){
 const spawned=[];
 const spawnProcess=(command,args,options)=>{
  const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),written:'',killed:false});
  child.kill=()=>{child.killed=true;queueMicrotask(()=>child.emit('close',null));};
  child.stdin.on('data',chunk=>{child.written+=chunk;const line=String(chunk).trim();
   if(!line.includes('#')){child.stderr.write('Invalid code. Please make sure the full code was copied.\n');return;}
   if(line==='good#state'){child.stdout.write('Login successful.\n');setImmediate(()=>child.emit('close',0));}
   else{child.stderr.write(`Login failed: Request failed with status code 400 (${line})\n`);setImmediate(()=>child.emit('close',1));}});
  if(print)setImmediate(()=>child.stdout.write('Opening browser to sign in…\n\x1b[2m'+URL_LINE+'\x1b[0mPaste code here if prompted > '));
  else setImmediate(()=>{child.stderr.write('Error: managed settings\n');child.emit('close',1);});
  spawned.push({command,args,options,child});return child;
 };
 return {spawned,spawnProcess};
}
const service=(cli,extra={})=>new AccountAuth({runner:{configuration:async()=>structuredClone(profiles)},spawnProcess:cli.spawnProcess,...extra});

test('login URL is taken only from Anthropic authorize links in CLI output',()=>{
 assert.match(loginUrl('\x1b]8;;x\x07'+URL_LINE),/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
 assert.equal(loginUrl('visit: https://claude.com.evil.test/oauth/authorize?x=1'),null);
 assert.equal(loginUrl('visit: https://claude.com/download'),null);
});

test('sign-in runs the profile CLI login, returns its URL, and passes the pasted code only to stdin',async()=>{
 const cli=fakeCli();const signedIn=[];const auth=service(cli,{onSuccess:id=>signedIn.push(id)});
 const flow=await auth.start('claude1');
 assert.equal(flow.status,'waiting_code');assert.match(flow.url,/redirect_uri=https%3A%2F%2Fplatform\.claude\.com/);
 const {args,options}=cli.spawned[0];
 assert.deepEqual(args,['auth','login','--claudeai']);assert.equal(options.shell,false);
 assert.equal(options.env.CLAUDE_CONFIG_DIR,'/home/u/.claude1');assert.equal(options.env.BROWSER,'true');assert.equal(options.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN,undefined);
 assert.doesNotMatch(JSON.stringify(flow),/private|Paste code/);
 assert.deepEqual(await auth.submit(flow.id,'  good#state\n'),{status:'ok'});
 assert.equal(cli.spawned[0].child.written,'good#state\n');assert.deepEqual(signedIn,['claude1']);
 await assert.rejects(auth.submit(flow.id,'good#state'),e=>e.status===404&&e.message==='login_expired');
});

test('malformed and rejected codes fail without echoing the code; a new start replaces the old flow',async()=>{
 const cli=fakeCli();const auth=service(cli);
 const flow=await auth.start('claude1');
 await assert.rejects(auth.submit(flow.id,'no-state'),e=>e.status===400&&e.message==='login_code_invalid');
 await assert.rejects(auth.submit(flow.id,'a#b c'),/login_code_invalid/);
 assert.equal(cli.spawned[0].child.written,'');
 const result=await auth.submit(flow.id,'secret-code#state');
 assert.equal(result.status,'failed');assert.equal(result.error,'login_failed');assert.match(result.detail,/^Login failed:/);assert.doesNotMatch(result.detail,/secret-code/);
 const first=await auth.start('claude1'),second=await auth.start('claude1');
 assert.equal(cli.spawned[1].child.killed,true);assert.equal(cli.spawned[2].child.killed,false);
 await assert.rejects(auth.submit(first.id,'good#state'),/login_expired/);
 assert.deepEqual(auth.cancel(second.id),{ok:true});assert.equal(cli.spawned[2].child.killed,true);
});

test('only installed Claude profiles can sign in and a CLI that exits early reports a start failure',async()=>{
 const auth=service(fakeCli());
 await assert.rejects(auth.start('codex'),e=>e.status===400&&e.message==='login_unsupported');
 await assert.rejects(auth.start('__proto__'),/login_unsupported/);
 await assert.rejects(auth.start('missing'),e=>e.status===409&&e.message==='cli_missing');
 const early=fakeCli({print:false});await assert.rejects(service(early).start('claude1'),e=>e.status===502&&e.message==='login_start_failed');
 const silent=fakeCli();const slow=service({spawnProcess:(...a)=>{const c=silent.spawnProcess(...a);c.stdout.write=()=>true;return c;}},{startTimeoutMs:20});
 await assert.rejects(slow.start('claude1'),/login_start_failed/);assert.equal(silent.spawned[0].child.killed,true);
});

test('sign-in API requires access and forwards start, code and cancel',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-auth-'));const calls=[];
 const accountAuth={start:async id=>{calls.push(['start',id]);return {id:'f1',profileId:id,status:'waiting_code',url:'https://claude.com/cai/oauth/authorize?x'};},submit:async(id,code)=>{calls.push(['submit',id,code]);return {status:'ok'};},cancel:id=>{calls.push(['cancel',id]);return {ok:true};}};
 const app=await createStudio({stateDir:dir,projectRoot:path.join(dir,'projects'),port:0,previewPort:0,token:'test-auth-only',runner:{profiles:async()=>[],close:async()=>{}},accountUsage:{get:async()=>({accounts:[]})},accountAuth});
 t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.port}`,headers={Authorization:'Bearer test-auth-only','Content-Type':'application/json'};
 assert.equal((await fetch(base+'/api/account-auth',{method:'POST',body:'{"profileId":"claude"}'})).status,401);
 assert.equal((await fetch(base+'/api/account-auth',{method:'POST',headers:{...headers,Origin:'https://outside.test'},body:'{"profileId":"claude"}'})).status,403);
 assert.equal(calls.length,0);
 const started=await fetch(base+'/api/account-auth',{method:'POST',headers,body:'{"profileId":"claude"}'});
 assert.equal(started.status,201);assert.equal((await started.json()).id,'f1');
 assert.deepEqual(await (await fetch(base+'/api/account-auth/f1/code',{method:'POST',headers,body:'{"code":"a#b"}'})).json(),{status:'ok'});
 assert.deepEqual(await (await fetch(base+'/api/account-auth/f1',{method:'DELETE',headers})).json(),{ok:true});
 assert.deepEqual(calls,[['start','claude'],['submit','f1','a#b'],['cancel','f1']]);
});
