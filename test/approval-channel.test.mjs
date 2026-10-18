import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CliRunner} from '../src/runner.mjs';

async function fixture(t,family,body){
  const cwd=await mkdtemp(path.join(os.tmpdir(),'studio-approval-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const script=path.join(cwd,'fake.mjs');
  await writeFile(script,`import {createInterface} from 'node:readline';
const send=e=>process.stdout.write(JSON.stringify(e)+'\\n');
const read=createInterface({input:process.stdin});
read.on('line',line=>{const e=JSON.parse(line);${body}});
read.on('close',()=>process.exit(0));`);
  const runner=new CliRunner({executables:{[family]:{command:process.execPath,args:[script],models:[{id:'test',label:'Test',efforts:['low']}]}}});
  return extra=>runner.execute({cwd,profileId:family,model:'test',reasoningEffort:'low',permissionMode:'auto',signal:AbortSignal.timeout(8000),...extra});
}
test('Claude duplex sends native auto, exact tool input, and answers a live approval without replay',async t=>{
  let requests=0;
  const execute=await fixture(t,'claude',`
    if(!process.argv.includes('host')||!process.argv.includes('auto'))process.exit(1);
    if(e.type==='control_request')send({type:'control_response',response:{request_id:e.request_id,subtype:'success',response:{}}});
    if(e.type==='user'){
      send({type:'system',subtype:'init',session_id:'native-live',model:'test'});
      send({type:'control_request',request_id:'request-1',request:{subtype:'can_use_tool',tool_name:'Write',input:{file_path:'file.txt',content:'original'}}});
    }
    if(e.type==='control_response'){
      if(e.response.request_id!=='request-1'||e.response.response.behavior!=='allow'||e.response.response.updatedInput.content!=='original')process.exit(2);
      send({type:'result',subtype:'success',result:'approved once',session_id:'native-live'});
    }
  `);
  const result=await execute({prompt:'write',onApproval:async request=>{requests++;assert.match(request.detail,/original/);return {decision:'allow',updatedInput:{content:'cannot replace'}};}});
  assert.equal(requests,1);assert.equal(result.text,'approved once');assert.equal(result.nativeSessionId,'native-live');
});
test('Codex app-server resumes exact thread, sends native auto reviewer and effort, supports denial',async t=>{
  const execute=await fixture(t,'codex',`
    if(e.method==='initialize')send({id:e.id,result:{}});
    if(e.method==='thread/resume'){
      if(e.params.threadId!=='prior'||e.params.approvalsReviewer!=='auto_review'||e.params.approvalPolicy!=='on-request'||e.params.sandbox!=='workspace-write')process.exit(3);
      send({id:e.id,result:{thread:{id:'prior'},model:'test',approvalsReviewer:'auto_review'}});
    }
    if(e.method==='turn/start'){
      if(e.params.effort!=='low'||e.params.model!=='test')process.exit(4);
      send({id:e.id,result:{turn:{id:'turn-1'}}});
      send({method:'turn/started',params:{threadId:'prior',turn:{id:'turn-1'}}});
      send({id:99,method:'item/commandExecution/requestApproval',params:{threadId:'prior',turnId:'turn-1',itemId:'tool',command:'test command',cwd:'test directory'}});
    }
    if(e.id===99&&e.result){
      if(e.result.decision!=='decline')process.exit(5);
      send({method:'item/completed',params:{threadId:'prior',item:{type:'agentMessage',id:'answer',text:'Did not execute',phase:'final_answer'}}});
      send({method:'turn/completed',params:{threadId:'prior',turn:{id:'turn-1',status:'completed'}}});
    }
  `);
  const result=await execute({prompt:'test',nativeSessionId:'prior',onApproval:async request=>{assert.match(request.detail,/test command/);return {decision:'deny'};}});
  assert.equal(result.text,'Did not execute');assert.equal(result.nativeSessionId,'prior');
});

test('native policy denial remains a failed operation and preserves the final explanation',async t=>{
 const execute=await fixture(t,'claude',`
   if(e.type==='control_request')send({type:'control_response',response:{request_id:e.request_id,subtype:'success'}});
   if(e.type==='user')send({type:'result',subtype:'success',result:'Write was blocked by policy',permission_denials:[{tool_name:'Write',tool_input:{file_path:'blocked.txt'}}]});
 `);
 const result=await execute({prompt:'write',onApproval:async()=>{throw Error('must not bypass policy');}});
 assert.equal(result.status,'failed');assert.equal(result.text,'Write was blocked by policy');assert.match(result.error,/权限策略拒绝/);
});

test('Codex turn usage uses resume baseline, counts multiple requests once and ignores another turn',async t=>{
 const execute=await fixture(t,'codex',`
  if(e.method==='initialize')send({id:e.id,result:{}});
  if(e.method==='thread/resume'){
   send({id:e.id,result:{thread:{id:'prior'},model:'test'}});
   send({method:'thread/tokenUsage/updated',params:{threadId:'prior',turnId:'old',tokenUsage:{total:{inputTokens:100,cachedInputTokens:50,outputTokens:10}}}});
  }
  if(e.method==='turn/start'){
   send({id:e.id,result:{turn:{id:'current'}}});
   send({method:'turn/started',params:{threadId:'prior',turn:{id:'current'}}});
   for(const input of [200,350,350])send({method:'thread/tokenUsage/updated',params:{threadId:'prior',turnId:'current',tokenUsage:{total:{inputTokens:input,cachedInputTokens:150,outputTokens:30},last:{inputTokens:150,cachedInputTokens:100,outputTokens:10}}}});
   send({method:'thread/tokenUsage/updated',params:{threadId:'prior',turnId:'unrelated',tokenUsage:{total:{inputTokens:999}}}});
   send({method:'turn/completed',params:{threadId:'prior',turn:{id:'current',status:'completed'}}});
  }
 `);
 const result=await execute({prompt:'test',nativeSessionId:'prior',previousUsage:{inputTokens:1,cachedInputTokens:1,outputTokens:1},onApproval:async()=>({decision:'deny'})});
 assert.deepEqual(result.usage.turn,{inputTokens:250,cachedInputTokens:100,outputTokens:20});
 assert.equal(result.usage.lastRequest.inputTokens,150);
});

test('Claude reports turn usage rather than cumulative modelUsage',async t=>{
 const execute=await fixture(t,'claude',`
  if(e.type==='control_request')send({type:'control_response',response:{request_id:e.request_id,subtype:'success'}});
  if(e.type==='user')send({type:'result',subtype:'success',result:'done',usage:{input_tokens:2,cache_read_input_tokens:98,cache_creation_input_tokens:0,output_tokens:3},modelUsage:{test:{inputTokens:99999,outputTokens:99999}}});
 `);
 const result=await execute({prompt:'test',onApproval:async()=>({decision:'deny'})});
 assert.equal(result.usage.turn.inputTokens,100);assert.equal(result.usage.turn.outputTokens,3);
});
