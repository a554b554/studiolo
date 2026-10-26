import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationItems,agentLabel,runNotice,modelName} from '../public/conversation.js';
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

test('narration folds into the raw log in order while the reply being written streams',()=>{
 const records=[{id:'u',role:'user',runId:'r',text:'fix it',createdAt:'1'},{id:'s',role:'system',runId:'r',text:'正在处理。',createdAt:'2'},
  {id:'n',role:'assistant',kind:'narration',runId:'r',text:'Let me look.',createdAt:'3'},{id:'t',role:'system',kind:'tool',runId:'r',text:'Read: {}',createdAt:'3'},
  {id:'a',role:'assistant',runId:'r',text:'Fixed',createdAt:'5'}];
 const running=conversationItems(records,[{id:'r',status:'running'}]);
 assert.deepEqual(running.map(i=>i.kind),['message','activity','message']);
 assert.deepEqual(running[1].activity.map(m=>m.id),['s','n','t']);assert.equal(running[1].replying,true);
 assert.equal(running[2].streaming,true);
 // A step after the reply began means the text was narration after all (it folds on the next tick).
 const stepped=conversationItems([...records,{id:'t2',role:'system',kind:'tool',runId:'r',text:'Bash: {}',createdAt:'6'}],[{id:'r',status:'running'}]);
 assert.equal(stepped.at(-1).streaming,undefined);assert.equal(stepped[1].replying,false);
 const done=conversationItems(records,[{id:'r',status:'succeeded'}]);
 assert.deepEqual(done.filter(i=>i.kind==='message').map(i=>[i.message.text,Boolean(i.streaming)]),[['fix it',false],['Fixed',false]]);
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
