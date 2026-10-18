import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CliRunner} from '../src/runner.mjs';
import {ResidentSession} from '../src/resident.mjs';

async function fixture(t,family,body){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'studio-resident-')),script=path.join(cwd,'fake.mjs');
 await writeFile(script,`import {createInterface} from 'node:readline';const send=e=>process.stdout.write(JSON.stringify(e)+'\\n');let model='one',effort='medium',mode='auto',turn=0;const r=createInterface({input:process.stdin});r.on('line',l=>{const e=JSON.parse(l);${body}});r.on('close',()=>process.exit(0));`);
 const runner=new CliRunner({executables:{[family]:{command:process.execPath,args:[script],models:['one','two'].map(id=>({id,efforts:['low','medium']}))}}});
 t.after(async()=>{await runner.close();await rm(cwd,{recursive:true,force:true});});
 const execute=options=>runner.execute({cwd,profileId:family,model:'one',reasoningEffort:'low',permissionMode:'auto',sessionKey:'project:session:a',prompt:'hello',onApproval:async()=>({decision:'deny'}),signal:AbortSignal.timeout(5000),...options});
 return {runner,execute};
}
const claude=`
 if(e.type==='control_request'){
  const q=e.request;if(q.subtype==='set_model')model=q.model;if(q.subtype==='set_permission_mode')mode=q.mode;if(q.subtype==='apply_flag_settings')effort=q.settings.effortLevel||'medium';
  send({type:'control_response',response:{request_id:e.request_id,subtype:'success',response:q.subtype==='get_settings'?{applied:{model,effort}}:{}}});
 }
 if(e.type==='user'){
  send({type:'system',subtype:'init',session_id:'native-claude',model});
  if(e.message.content==='wait')return;
  if(e.message.content==='approval'){send({type:'control_request',request_id:'approve',request:{subtype:'can_use_tool',tool_name:'Write',input:{content:'original'}}});return;}
  send({type:'result',subtype:'success',session_id:'native-claude',result:model+':'+effort+':'+mode+':'+(++turn)});
 }
 if(e.type==='control_response'){send({type:'result',subtype:'success',session_id:'native-claude',result:e.response.response.behavior+':'+(e.response.response.updatedInput?.content||'none')});}
`;

test('Claude ignores rescue results during setup and unrelated results after submission',async t=>{
 const body=claude.replace("const q=e.request;",`const q=e.request;
  if(q.subtype==='get_settings')send({type:'result',subtype:'success',result:''});`)
 .replace("if(e.type==='user'){",`if(e.type==='user'){
  send({type:'command_lifecycle',command_uuid:e.uuid,state:'queued'});
  send({type:'result',subtype:'success',user_message_uuid:'older-message',result:''});
  send({type:'result',subtype:'success',result:''});
  send({type:'system',subtype:'session_state_changed',state:'idle'});`)
 .replace("session_id:'native-claude',result:model", "session_id:'native-claude',user_message_uuid:e.uuid,result:model");
 const f=await fixture(t,'claude',body),events=[];
 const a=await f.execute({onEvent:e=>events.push(e)});
 assert.equal(a.text,'one:low:auto:1');
 const b=await f.execute({nativeSessionId:a.nativeSessionId});
 assert.equal(b.text,'one:low:auto:2');assert.equal(a.runtime.pid,b.runtime.pid);
 assert.ok(!events.some(e=>e.text?.startsWith('Background native event: Native session')));
});

test('Claude correlates batched replies and preserves background answers without tool/subagent text',async()=>{
 const events=[],sent=[];
 const session=new ResidentSession({family:'claude',id:'claude'},{},s=>String(s??''));
 session.child={};session.nativeState='idle';
 session.rpc=async method=>method==='get_settings'?{applied:{model:'one',effort:'low'}}:{};
 let submit;const submitted=new Promise(resolve=>submit=resolve);
 session.write=e=>{sent.push(e);submit();};
 const pending=session.execute({model:'one',reasoningEffort:'low',permissionMode:'auto',prompt:'status',onEvent:e=>events.push(e)});
 await submitted;const id=sent[0].uuid;assert.ok(id);
 session.consume({type:'command_lifecycle',command_uuid:id,state:'started'});
 session.consume({type:'assistant',parent_tool_use_id:'subagent',message:{content:[{type:'text',text:'private subagent'}]}});
 session.consume({type:'assistant',user_message_uuid:'background',message:{content:[{type:'text',text:'Background finished'}]}});
 session.consume({type:'result',subtype:'success',user_message_uuid:'background',result:'Background finished'});
 session.consume({type:'stream_event',user_message_uuids:[id,'folded'],event:{type:'message_start'}});
 session.consume({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Current answer'}}});
 session.consume({type:'assistant',message:{content:[{type:'text',text:'Current answer'}]}});
 session.consume({type:'result',subtype:'success',user_message_uuid:'folded',user_message_uuids:[id,'folded'],result:'Current answer'});
 assert.equal((await pending).text,'Current answer');
 session.consume({type:'assistant',message:{content:[{type:'text',text:'Later report'},{type:'thinking',thinking:'never expose'}]}});
 session.consume({type:'result',subtype:'success',result:'Later report'});
 session.consume({type:'user',message:{content:[{type:'tool_result',content:'tool output'}]}});
 assert.deepEqual(events.filter(e=>e.type==='reply').map(e=>e.text),['Background finished','Later report']);
 assert.deepEqual(events.filter(e=>e.type==='text').map(e=>e.text),['Current answer']);
 assert.ok(!JSON.stringify(events).includes('private subagent'));
 assert.ok(!JSON.stringify(events).includes('never expose'));
 assert.ok(!JSON.stringify(events).includes('tool output'));
});
test('resident Claude stays alive, applies model/effort/mode and resets default without another process',async t=>{
 const f=await fixture(t,'claude',claude);
 const a=await f.execute({}),b=await f.execute({nativeSessionId:a.nativeSessionId,model:'two',reasoningEffort:'medium',permissionMode:'read-only'}),c=await f.execute({nativeSessionId:a.nativeSessionId,reasoningEffort:null});
 assert.equal(a.runtime.pid,b.runtime.pid);assert.equal(a.runtime.instanceId,c.runtime.instanceId);
 assert.equal(a.text,'one:low:auto:1');assert.equal(b.text,'two:medium:plan:2');assert.equal(c.text,'one:medium:auto:3');
 assert.equal(c.reasoningEffort,'medium');assert.equal(f.runner.runtime()['project:session:a'].connected,true);
 await f.runner.release('project:');assert.deepEqual(f.runner.runtime(),{});
});
test('resident approvals use current turn callback and exact tool input',async t=>{
 const f=await fixture(t,'claude',claude);
 const a=await f.execute({prompt:'approval',onApproval:async()=>({decision:'allow',updatedInput:{content:'fake'}})});
 const b=await f.execute({prompt:'approval',nativeSessionId:a.nativeSessionId,onApproval:async()=>({decision:'deny'})});
 assert.equal(a.text,'allow:original');assert.equal(b.text,'deny:none');assert.equal(a.runtime.pid,b.runtime.pid);
});
test('cancel closes only its process, next explicit turn resumes saved native ID',async t=>{
 const f=await fixture(t,'claude',claude),first=await f.execute({});
 const parallel=await f.execute({sessionKey:'project:session:b'});
 const controller=new AbortController(),pending=f.execute({prompt:'wait',nativeSessionId:first.nativeSessionId,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]),onEvent:event=>{if(event.text?.startsWith('Started '))controller.abort();}});
 // Wait for the fake CLI to accept the turn; a fixed 40 ms timer could fire before execution under parallel load.
 await assert.rejects(pending,/cancelled/);
 const resumed=await f.execute({nativeSessionId:first.nativeSessionId});
 assert.notEqual(resumed.runtime.instanceId,first.runtime.instanceId);assert.equal(resumed.nativeSessionId,first.nativeSessionId);
 assert.equal(f.runner.runtime()['project:session:b'].instanceId,parallel.runtime.instanceId);
});
test('native setting mismatch fails before submitting a message',async t=>{
 const f=await fixture(t,'claude',claude.replace('effort=q.settings.effortLevel||\'medium\'','effort=\'unsupported\''));
 await assert.rejects(f.execute({}),/did not confirm/);
});
test('Claude result waits for native idle before handing the FIFO to another message',async t=>{
 const body=claude.replace("send({type:'system',subtype:'init',session_id:'native-claude',model});","send({type:'system',subtype:'init',session_id:'native-claude',model});send({type:'system',subtype:'session_state_changed',state:'running'});")
   .replace("result:model+':'+effort+':'+mode+':'+(++turn)});","result:model+':'+effort+':'+mode+':'+(++turn)});setTimeout(()=>send({type:'system',subtype:'session_state_changed',state:'idle'}),100);");
 const f=await fixture(t,'claude',body);const a=await f.execute({});
 assert.equal(a.text,'one:low:auto:1');assert.equal(f.runner.sessions.get('project:session:a').nativeState,'idle');
 const b=await f.execute({nativeSessionId:a.nativeSessionId});assert.equal(a.runtime.pid,b.runtime.pid);
});
test('resident Codex uses one thread with turn-level settings and cumulative usage deltas',async t=>{
 const f=await fixture(t,'codex',`
 if(e.method==='initialize')send({id:e.id,result:{}});
 if(e.method==='thread/start')send({id:e.id,result:{thread:{id:'native-codex'},reasoningEffort:'medium',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}}});
 if(e.method==='turn/start'){
  const p=e.params;turn++;const id='turn-'+turn;
  send({id:e.id,result:{turn:{id}}});send({method:'turn/started',params:{threadId:'native-codex',turn:{id}}});
  send({method:'item/completed',params:{threadId:'native-codex',turnId:id,item:{type:'agentMessage',id:'answer',phase:'final_answer',text:p.model+':'+p.effort+':'+p.approvalsReviewer+':'+p.sandboxPolicy.type}}});
  send({method:'thread/tokenUsage/updated',params:{threadId:'native-codex',turnId:id,tokenUsage:{total:{inputTokens:100*turn,cachedInputTokens:80*turn,outputTokens:10*turn},last:{inputTokens:100,cachedInputTokens:80,outputTokens:10}}}});
  send({method:'turn/completed',params:{threadId:'native-codex',turn:{id,status:'completed'}}});
 }
 `);
 const a=await f.execute({}),b=await f.execute({nativeSessionId:a.nativeSessionId,model:'two',reasoningEffort:'medium',permissionMode:'read-only'});
 assert.equal(a.runtime.pid,b.runtime.pid);assert.equal(a.text,'one:low:auto_review:workspaceWrite');assert.equal(b.text,'two:medium:user:readOnly');
 assert.deepEqual(b.usage.turn,{inputTokens:100,cachedInputTokens:80,outputTokens:10});
});
