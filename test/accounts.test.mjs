// Machine-local account registry, runner configuration from it, and the sign-in flows
// (Codex device code / API key, Claude API key, sign-out) against fake CLIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Accounts} from '../src/accounts.mjs';
import {CliRunner} from '../src/runner.mjs';
import {AccountLogin} from '../src/account-login.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn){const deadline=Date.now()+8000;while(Date.now()<deadline){if(await fn())return;await sleep(20);}throw new Error('Condition timed out');}

async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-accounts-'));
  const homedir=path.join(dir,'home'),stateDir=path.join(dir,'state'),marks=path.join(dir,'marks');
  await fs.mkdir(path.join(homedir,'.claude','skills'),{recursive:true});await fs.mkdir(marks,{recursive:true});
  await fs.writeFile(path.join(homedir,'.claude','settings.json'),'{"theme":"dark"}');
  await fs.writeFile(path.join(homedir,'.claude','.claude.json'),JSON.stringify({oauthAccount:{email:'secret@example.com'},mcpServers:{playwright:{command:'npx'}}}));
  await fs.writeFile(path.join(homedir,'.claude','.credentials.json'),'{"never":"copied"}');
  await fs.mkdir(path.join(homedir,'.codex'),{recursive:true});await fs.writeFile(path.join(homedir,'.codex','config.toml'),'model = "gpt-6"\n');
  // One fake executable for every role: Codex app-server, Claude stream-json metadata, sign-out.
  const script=path.join(dir,'fake.mjs');
  await fs.writeFile(script,`
import {createInterface} from 'node:readline';import fs from 'node:fs';import path from 'node:path';
const marks=${JSON.stringify(marks)};const send=e=>process.stdout.write(JSON.stringify(e)+'\\n');
const args=process.argv.slice(2);const env=process.env;
if(args.includes('logout')||args.includes('auth')){fs.writeFileSync(path.join(marks,'logout-'+(env.CODEX_HOME||env.CLAUDE_CONFIG_DIR).split(/[\\\\/]/).pop()),args.join(' '));process.exit(0);}
const r=createInterface({input:process.stdin});
if(args[0]==='app-server'){
  const signedIn=fs.existsSync(path.join(env.CODEX_HOME,'auth.json'));
  r.on('line',l=>{const e=JSON.parse(l);if(!e.method)return;
    if(e.method==='initialize')return send({id:e.id,result:{}});
    if(e.method==='account/read')return send({id:e.id,result:{account:fs.existsSync(path.join(env.CODEX_HOME,'auth.json'))?{type:'chatgpt',email:'codex@example.com',planType:'pro'}:null,requiresOpenaiAuth:true}});
    if(e.method==='model/list')return send({id:e.id,result:{data:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',displayName:'GPT-6.1-Sol',hidden:false,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'low',isDefault:true},{id:'hidden-one',displayName:'Hidden',hidden:true}],nextCursor:null}});
    if(e.method==='account/login/start'){
      if(e.params.type==='apiKey'){if(e.params.apiKey!=='sk-test-codex')return send({id:e.id,error:{message:'invalid key'}});fs.writeFileSync(path.join(env.CODEX_HOME,'auth.json'),'{"OPENAI_API_KEY":"stored-by-codex"}');return send({id:e.id,result:{type:'apiKey'}});}
      send({id:e.id,result:{type:'chatgptDeviceCode',loginId:'login-1',verificationUrl:'https://auth.example/device',userCode:'ABCD-EFGH'}});
      setTimeout(()=>{fs.writeFileSync(path.join(env.CODEX_HOME,'auth.json'),'{"tokens":"x"}');send({method:'account/login/completed',params:{loginId:'login-1',success:true,error:null}});},200);return;
    }
    send({id:e.id,error:{message:'unknown '+e.method}});
  });
}else{
  let model='claude-opus-5-5';const key=env.ANTHROPIC_API_KEY;
  r.on('line',l=>{const e=JSON.parse(l);if(e.type!=='control_request')return;const q=e.request;const reply=response=>send({type:'control_response',response:{request_id:e.request_id,subtype:'success',response}});
    if(q.subtype==='initialize')return reply({commands:[{name:'compact',description:'Compact'}],models:[{value:'default',displayName:'Default'},{value:'opus',displayName:'Opus 5.5'},{value:'haiku',displayName:'Haiku 5.5'},{value:'claude-haiku-4-5-20251001',displayName:'Haiku 4.5'}],account:key==='sk-ant-good'?{email:'claude@example.com',subscriptionType:null,apiKeySource:'ANTHROPIC_API_KEY',apiProvider:'firstParty'}:{tokenSource:'none'}});
    if(q.subtype==='set_model'){model=q.model==='opus'?'claude-opus-5-5[1m]':q.model==='haiku'?'claude-haiku-5-5':q.model;return reply({});}
    if(q.subtype==='get_settings')return reply({applied:{model,effort:'medium'}});
    reply({});
  });
}
r.on('close',()=>process.exit(0));
`);
  await fs.mkdir(stateDir,{recursive:true});
  await fs.writeFile(path.join(stateDir,'agent-profiles.json'),JSON.stringify({claude:{command:process.execPath,args:[script]},codex:{command:process.execPath,args:[script]}}));
  const accounts=new Accounts({stateDir,homedir});
  // Default configuration cache: a key written after the first lookup must still reach the CLI.
  const runner=new CliRunner({stateDir,hostId:'h',accounts});
  const released=[];runner.releaseAccount=async id=>{released.push(id);};
  const changes=[];
  const login=new AccountLogin({accounts,runner,oauth:null,onChange:id=>changes.push(id),deviceTimeoutMs:5000});
  t.after(async()=>{login.close();await runner.close();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,homedir,stateDir,marks,accounts,runner,login,released,changes};
}

test('registry creates isolated account directories seeded from the default CLI directory',async t=>{
  const f=await fixture(t);
  const a=await f.accounts.create({family:'claude',auth:'oauth'});
  assert.match(a.id,/^acc_[0-9a-f]{8}$/);assert.equal(a.label,'Claude 1');assert.equal(a.status,'signed_out');
  const dir=f.accounts.dir(a.id);
  assert.equal(await fs.readFile(path.join(dir,'settings.json'),'utf8'),'{"theme":"dark"}');
  assert.ok((await fs.lstat(path.join(dir,'skills'))).isSymbolicLink(),'skills are linked, not copied');
  const claudeJson=JSON.parse(await fs.readFile(path.join(dir,'.claude.json'),'utf8'));
  assert.deepEqual(claudeJson,{hasCompletedOnboarding:true,mcpServers:{playwright:{command:'npx'}}});
  await assert.rejects(fs.access(path.join(dir,'.credentials.json')),'credentials are never copied');
  assert.ok(a.seed.copied.includes('settings.json'));assert.ok(a.seed.linked.includes('skills'));
  const b=await f.accounts.create({family:'claude',auth:'api_key',label:'Work key'});
  assert.equal(b.label,'Work key');
  const c=await f.accounts.create({family:'codex',auth:'chatgpt'});
  assert.equal(c.label,'Codex 1');assert.equal(await fs.readFile(path.join(f.accounts.dir(c.id),'config.toml'),'utf8'),'model = "gpt-6"\n');
  await assert.rejects(f.accounts.create({family:'gemini',auth:'oauth'}),e=>e.status===400);
  await assert.rejects(f.accounts.create({family:'codex',auth:'oauth'}),e=>e.status===400);
  await assert.rejects(f.accounts.update(a.id,{label:'bad\nlabel'}),e=>e.status===400);
  // Environment: own directory, no platform token or ambient keys; API-key accounts get their key.
  const env=await f.accounts.env(a,{STUDIO_TOKEN:'t',ANTHROPIC_API_KEY:'ambient',PATH:'p'});
  assert.deepEqual(env,{PATH:'p',CLAUDE_CONFIG_DIR:dir});
  await f.accounts.writeKey(b.id,'sk-ant-xyz');
  assert.equal((await f.accounts.env(b,{})).ANTHROPIC_API_KEY,'sk-ant-xyz');
  assert.equal((await f.accounts.env(c,{OPENAI_API_KEY:'ambient'})).OPENAI_API_KEY,undefined);
  assert.equal((await f.accounts.env(c,{})).CODEX_HOME,f.accounts.dir(c.id));
  assert.ok(!(await fs.readFile(path.join(f.stateDir,'accounts.json'),'utf8')).includes('sk-ant-xyz'),'keys never enter the registry');
  const before=f.accounts.version;await f.accounts.remove(b.id);assert.ok(f.accounts.version>before);
  await assert.rejects(fs.access(f.accounts.dir(b.id)));
  await assert.rejects(f.accounts.get(b.id),e=>e.status===404);
  // A fresh instance reads the same registry.
  assert.deepEqual((await new Accounts({stateDir:f.stateDir,homedir:f.homedir}).list()).map(x=>x.id).sort(),[a.id,c.id].sort());
});

test('runner builds profiles from the registry and hides env, paths and keys',async t=>{
  const f=await fixture(t);
  const a=await f.accounts.create({family:'claude',auth:'api_key',label:'Key'});
  await f.accounts.writeKey(a.id,'sk-ant-secret');
  let profiles=await f.runner.profiles();
  assert.equal(profiles.length,1);assert.equal(profiles[0].id,a.id);assert.equal(profiles[0].family,'claude');assert.equal(profiles[0].available,false);
  assert.match(profiles[0].error,/not signed in/);
  await f.accounts.update(a.id,{status:'signed_in',identity:{email:'e@x',plan:'Max',organization:'private org'},models:[{id:'claude-opus-5-5',label:'Opus 5.5'}]});
  profiles=await f.runner.profiles();
  assert.equal(profiles[0].available,true);assert.deepEqual(profiles[0].identity,{email:'e@x',plan:'Max'});
  assert.deepEqual(profiles[0].models[0].efforts,['low','medium','high','xhigh','max'],'Claude efforts are filled in');
  const text=JSON.stringify(profiles);
  assert.ok(!text.includes('sk-ant-secret')&&!text.includes('CLAUDE_CONFIG_DIR')&&!text.includes('private org'));
  const config=(await f.runner.configuration())[a.id];
  assert.equal(config.env.ANTHROPIC_API_KEY,'sk-ant-secret');assert.equal(config.env.CLAUDE_CONFIG_DIR,f.accounts.dir(a.id));
  assert.equal(config.command,process.execPath,'family default command from agent-profiles.json');
  // Ad-hoc executables (tests) still appear next to registered accounts.
  f.runner.executables={codex:{command:process.execPath,models:[{id:'m'}]}};f.runner.invalidate();
  assert.deepEqual((await f.runner.profiles()).map(p=>[p.id,p.family,p.available]),[[a.id,'claude',true],['codex','codex',true]]);
});

test('Codex device-code sign-in waits for the CLI, then reads identity and models',async t=>{
  const f=await fixture(t);
  const a=await f.accounts.create({family:'codex',auth:'chatgpt'});
  const flow=await f.login.start(a.id);
  assert.equal(flow.kind,'device_code');assert.equal(flow.status,'waiting_device');assert.equal(flow.url,'https://auth.example/device');assert.equal(flow.userCode,'ABCD-EFGH');
  await waitFor(()=>f.login.status(flow.id).status==='ok');
  const account=await f.accounts.get(a.id);
  assert.equal(account.status,'signed_in');assert.deepEqual(account.identity,{email:'codex@example.com',plan:'pro',type:'chatgpt'});
  assert.deepEqual(account.models.map(m=>[m.id,m.efforts,m.defaultEffort,m.isDefault]),[['gpt-6.1-sol',['low','high'],'low',true]],'hidden models are left out');
  assert.ok(f.changes.includes(a.id));
  const profile=(await f.runner.profiles()).find(p=>p.id===a.id);
  assert.equal(profile.available,true);assert.equal(profile.models[0].label,'GPT-6.1-Sol');
  // Sign-out runs the CLI's logout and clears credentials and identity.
  await f.login.logout(a.id);
  assert.equal((await f.accounts.get(a.id)).status,'signed_out');
  assert.equal(await fs.readFile(path.join(f.marks,'logout-'+a.id),'utf8'),'logout');
  await assert.rejects(fs.access(path.join(f.accounts.dir(a.id),'auth.json')));
  assert.deepEqual(f.released,[a.id]);
  assert.equal((await f.runner.profiles()).find(p=>p.id===a.id).available,false);
});

test('API keys: Codex stores through its CLI, Claude keeps a file; bad keys are rejected and dropped',async t=>{
  const f=await fixture(t);
  const codex=await f.accounts.create({family:'codex',auth:'api_key'});
  await assert.rejects(f.login.start(codex.id,{apiKey:'wrong'}),e=>e.message==='api_key_rejected');
  await assert.rejects(f.login.start(codex.id,{apiKey:''}),e=>e.message==='api_key_invalid');
  assert.deepEqual(await f.login.start(codex.id,{apiKey:'sk-test-codex'}),{accountId:codex.id,kind:'api_key',status:'ok'});
  assert.equal((await f.accounts.get(codex.id)).status,'signed_in');
  assert.ok(!(await fs.readFile(path.join(f.stateDir,'accounts.json'),'utf8')).includes('sk-test-codex'));
  const claude=await f.accounts.create({family:'claude',auth:'api_key'});
  await f.runner.profiles(); // cache a configuration without the key, as the page does right after creating the account
  await assert.rejects(f.login.start(claude.id,{apiKey:'sk-ant-bad'}),e=>e.message==='api_key_rejected');
  assert.equal(await f.accounts.readKey(claude.id),null,'a rejected key is not kept');
  assert.equal((await f.accounts.get(claude.id)).status,'signed_out');
  await f.login.start(claude.id,{apiKey:'sk-ant-good'});
  const account=await f.accounts.get(claude.id);
  assert.equal(account.status,'signed_in');assert.equal(account.identity.email,'claude@example.com');
  assert.equal(account.label,'claude@example.com','an automatic label becomes the e-mail at sign-in');
  // A name the user typed stays, and a later manual rename is never overwritten by refresh.
  const named=await f.accounts.create({family:'claude',auth:'api_key',label:'Work key'});
  await f.login.start(named.id,{apiKey:'sk-ant-good'});
  assert.equal((await f.accounts.get(named.id)).label,'Work key');
  await f.accounts.update(claude.id,{label:'Personal'});await f.login.refresh(claude.id);
  assert.equal((await f.accounts.get(claude.id)).label,'Personal');
  assert.deepEqual(account.models.map(m=>[m.id,m.label,m.alias]),[['claude-opus-5-5','Opus 5.5','opus'],['claude-haiku-5-5','Haiku 5.5','haiku'],['claude-haiku-4-5-20251001','Haiku 4.5',undefined]],'aliases resolve to concrete ids; default is skipped');
  assert.deepEqual(account.models.map(m=>m.efforts.length),[5,5,0]);
  assert.deepEqual(account.commands,[{name:'compact',hint:null,description:'Compact'}]);
  assert.equal(await f.accounts.readKey(claude.id),'sk-ant-good');
  assert.equal((await f.runner.configuration())[claude.id].env.ANTHROPIC_API_KEY,'sk-ant-good','the runner sees the key without waiting for its cache to expire');
  const approvals=JSON.parse(await fs.readFile(path.join(f.accounts.dir(claude.id),'.claude.json'),'utf8')).customApiKeyResponses;
  assert.deepEqual(approvals.approved,['sk-ant-good'.slice(-20)]);
  await f.login.logout(claude.id);
  assert.equal(await f.accounts.readKey(claude.id),null);
  assert.equal(await fs.readFile(path.join(f.marks,'logout-'+claude.id),'utf8'),'auth logout');
  await f.login.remove(codex.id);
  await assert.rejects(f.accounts.get(codex.id),e=>e.status===404);
});
