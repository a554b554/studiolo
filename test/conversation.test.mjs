import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationItems,agentLabel,runNotice,modelName,recorded,steerCount} from '../public/conversation.js';
const messages=[{id:'u',role:'user',runId:'r',text:'question'},{id:'s',role:'system',runId:'r',text:'Started'},{id:'a',role:'assistant',runId:'r',text:'Final answer'},{id:'t',role:'system',runId:'r',kind:'tool',text:'long tool output'},{id:'e',role:'system',runId:'r',text:'finished'}];
test('legacy tool and status records fold before the final answer without changing storage',()=>{
 const original=JSON.stringify(messages),items=conversationItems(messages,[{id:'r',status:'succeeded'}]);
 assert.deepEqual(items.map(i=>i.kind),['message','activity','message']);
 assert.equal(items[1].activity.length,3);assert.equal(items.at(-1).message.text,'Final answer');
 assert.equal(JSON.stringify(messages),original);
});
test('active output folds as progress; failures remain visible',()=>{
 const items=conversationItems(messages,[{id:'r',status:'waiting',error:'Permission required'}]);
 assert.deepEqual(items.map(i=>i.kind),['message','activity','notice','message']);
 assert.equal(items[1].activity.length,4);assert.equal(items[2].text,'Permission required');
});
test('completed intermediate text stays accessible, separate from the final reply',()=>{
 const items=conversationItems([{...messages[2],progressText:'I will inspect'}],[{id:'r',status:'succeeded'}]);
 assert.equal(items[0].activity[0].text,'I will inspect');assert.equal(items[1].message.text,'Final answer');
});
test('permission payload stays in raw log and reply identity belongs to its run',()=>{
 const error='Permission or user input required: Edit {"new_string":"PRIVATE LARGE PATCH"}';
 const items=conversationItems(messages,[{id:'r',status:'waiting',error}]);
 assert.equal(items.at(-1).message.text,'Final answer');
 assert.ok(items.find(i=>i.kind==='activity').activity.some(m=>m.text===error));
 assert.ok(!runNotice(error).includes('PRIVATE LARGE PATCH'));
 assert.equal(agentLabel({profileId:'claude'},{actualModel:'claude-fable-5-1',reasoningEffort:'high'}),'claude · Fable 5.1 · high');
 assert.match(agentLabel({profileId:'claude'},{model:'claude-fable-5-1'}),/CLI 默认/);
});

test('legacy background replies are visible in arrival order and retain their original raw records',()=>{
 const records=[...messages,{id:'u2',role:'user',runId:'r2',text:'status'},
  {id:'s2',role:'system',kind:'tool',runId:'r2',text:'Background native event: Started claude · model'},
  {id:'b',role:'system',kind:'tool',runId:'r',text:'Background native event: All games finished.'},
  {id:'a2',role:'system',kind:'tool',runId:'r2',text:'Background native event: Here is the status.'}];
 const before=JSON.stringify(records);
 const items=conversationItems(records,[{id:'r',status:'succeeded'},{id:'r2',status:'succeeded'}]);
 assert.deepEqual(items.filter(i=>i.kind==='message').map(i=>i.message.text),['question','Final answer','status','All games finished.','Here is the status.']);
 assert.ok(items.some(i=>i.kind==='activity'&&i.activity.some(m=>m.id==='b')));
 assert.equal(JSON.stringify(records),before);
});

test('background answers stay visible while a newer user request runs',()=>{
 const records=[...messages,{id:'u2',role:'user',runId:'r2',text:'next'},
  {id:'b',role:'assistant',kind:'background_reply',runId:'r',text:'Background report'},
  {id:'a2',role:'assistant',runId:'r2',text:'Working'}];
 const items=conversationItems(records,[{id:'r',status:'succeeded'},{id:'r2',status:'running'}]);
 assert.deepEqual(items.filter(i=>i.kind==='message').map(i=>[i.message.text,Boolean(i.streaming)]),[['question',false],['Final answer',false],['next',false],['Background report',false],['Working',true]]);
});

test('a live run carries its narration in order and the reply being written; the reply joins the conversation when it ends',()=>{
 const records=[{id:'u',role:'user',runId:'r',text:'fix it',createdAt:'1'},{id:'s',role:'system',runId:'r',text:'正在处理。',createdAt:'2'},
  {id:'n',role:'assistant',kind:'narration',runId:'r',text:'Let me look.',createdAt:'3'},{id:'t',role:'system',kind:'tool',runId:'r',text:'Read: {}',createdAt:'3'},
  {id:'a',role:'assistant',runId:'r',text:'Fixed',createdAt:'5'}];
 const running=conversationItems(records,[{id:'r',status:'running',requestId:'q'}]);
 assert.deepEqual(running.map(i=>i.kind),['message','activity']);
 assert.deepEqual(running[1].activity.map(m=>m.id),['s','n','t']);assert.equal(running[1].replying,true);
 assert.equal(running[1].live,true);assert.equal(running[1].stream.id,'a');
 assert.equal(running[0].slot,'q');assert.equal(running[1].slot,'q','the request id keys the message and its live run');
 // A step after the reply began means the text was narration after all (it folds on the next tick).
 const stepped=conversationItems([...records,{id:'t2',role:'system',kind:'tool',runId:'r',text:'Bash: {}',createdAt:'6'}],[{id:'r',status:'running'}]);
 assert.equal(stepped.at(-1).streaming,undefined);assert.equal(stepped[1].replying,false);
 const done=conversationItems(records,[{id:'r',status:'succeeded'}]);
 assert.deepEqual(done.filter(i=>i.kind==='message').map(i=>[i.message.text,Boolean(i.streaming)]),[['fix it',false],['Fixed',false]]);
 assert.equal(done[1].live,undefined);
 // After a steer the reply streams below the steered message instead.
 const steered=conversationItems([...records.slice(0,4),{id:'st',role:'user',kind:'steer',runId:'r',text:'also',createdAt:'4'},records[4]],[{id:'r',status:'running'}]);
 assert.equal(steered[1].stream,null);assert.deepEqual(steered.slice(2).map(i=>[i.message.id,Boolean(i.streaming)]),[['st',false],['a',true]]);
});

test('messages sent from the page show until recorded, and a new turn keeps a live placeholder until its run records',()=>{
 const request={requestId:'q',sessionId:'S',text:' hi ',createdAt:'9',placeholder:true,agent:{profileId:'p',model:'m'}};
 const sent=conversationItems([],[],[request]);
 assert.deepEqual(sent.map(i=>[i.kind,i.slot]),[['message','q'],['activity','q']]);
 assert.equal(sent[0].message.pending,'sending');assert.equal(sent[1].live,true);assert.equal(sent[1].since,'9');
 assert.equal(conversationItems([],[],[{...request,failed:'offline'}]).map(i=>i.message?.pending).join(),'failed','a failed send has no placeholder');
 // Recorded and queued: the server's message takes the slot and the placeholder stays.
 const user={id:'u',role:'user',runId:'r',sessionId:'S',text:'hi'};
 const queued=conversationItems([user],[{id:'r',requestId:'q',status:'queued'}],[request]);
 assert.deepEqual(queued.map(i=>[i.kind,i.slot,i.message?.id]),[['message','q','u'],['activity','q',undefined]]);
 // Once the run records, its own live activity holds the slot.
 const started=conversationItems([user,{id:'s',role:'system',runId:'r',text:'正在处理。'}],[{id:'r',requestId:'q',status:'running'}],[request]);
 assert.deepEqual(started.map(i=>[i.kind,i.slot,i.key]),[['message','q',undefined],['activity','q','r']]);
 // A steer is recorded when one more steer with its text appears after it was accepted.
 const steer={requestId:'x',sessionId:'S',text:'also',steer:true,steers:1};
 const old={id:'o',role:'user',kind:'steer',sessionId:'S',text:'also'};
 assert.equal(recorded(steer,[old],[]),false);assert.equal(recorded({...steer,sentAt:1},[old],[]),false);
 assert.equal(recorded({...steer,sentAt:1},[old,{...old,id:'o2'}],[]),true);
 assert.equal(steerCount([old,{...old,sessionId:'T'}],{sessionId:'S',text:' also '}),1);
});

test('a request on a different model than the previous one is preceded by a switch marker',()=>{
 const records=[{id:'u1',role:'user',runId:'r1',text:'one'},{id:'a1',role:'assistant',runId:'r1',text:'1'},
  {id:'u2',role:'user',runId:'r2',text:'two'},{id:'s2',role:'user',kind:'steer',runId:'r2',text:'also'},{id:'a2',role:'assistant',runId:'r2',text:'2'},
  {id:'u3',role:'user',runId:'r3',text:'three'},{id:'a3',role:'assistant',runId:'r3',text:'3'}];
 const runs=[{id:'r1',status:'succeeded',model:'claude-opus-5-5',profileId:'p'},{id:'r2',status:'succeeded',model:'claude-sonnet-5-5',profileId:'p'},{id:'r3',status:'succeeded',model:'claude-sonnet-5-5',profileId:'p'}];
 const items=conversationItems(records,runs);
 assert.deepEqual(items.filter(i=>i.kind==='switch').map(i=>[i.key,i.model]),[['u2','claude-sonnet-5-5']]);
 assert.equal(items[items.findIndex(i=>i.kind==='switch')+1].message.id,'u2','the marker precedes the request');
 assert.equal(modelName('claude-sonnet-5-5','p'),'Sonnet 5.5');
});
