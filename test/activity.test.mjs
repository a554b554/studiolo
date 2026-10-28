import test from 'node:test';
import assert from 'node:assert/strict';
import {describeActivity,readRecord,lastSaid,duration,timeline,stepSummary} from '../public/activity.js';

const tool = text => ({role:'system',kind:'tool',text});
test('Claude tool calls read as the step in progress, and their output as thinking',()=>{
 const records=[{role:'system',text:'正在处理。'},{role:'system',kind:'status',text:'CLI invocation: claude'},
  {role:'assistant',kind:'narration',text:'## Plan\n\nI will check the **queue** first.'},
  tool('Read: {"file_path":"D:\\\\repo\\\\src\\\\queue.mjs"}'),tool('Tool result: 1 import'),tool('Bash: {"command":"npm test\\nnpm run check","description":"Run tests"}')];
 const running=describeActivity(records);
 assert.equal(running.state,'step');assert.deepEqual(running.step,{verb:'运行',target:'npm test'});assert.equal(running.steps,2);
 assert.equal(running.said,'I will check the queue first.');
 const after=describeActivity([...records,tool('Tool result: ok')]);
 assert.equal(after.state,'thinking');assert.equal(after.step.target,'npm test');
 assert.deepEqual(readRecord(records[3]).step,{verb:'读取',target:'queue.mjs',title:'D:\\repo\\src\\queue.mjs'});
 assert.equal(readRecord(tool('mcp__Claude_Browser__navigate: {"url":"x"}')).step.target,'Claude_Browser · navigate');
 assert.equal(readRecord(tool('Background native event: Started claude')),null);
 assert.equal(readRecord({role:'system',text:'Bash: {}'}),null,'only tool records are steps');
});
test('Codex items are completed steps; their shell wrapper is removed',()=>{
 const records=[tool(JSON.stringify({type:'commandExecution',command:"/bin/zsh -lc 'npm test -- --watch'",status:'completed'})),
  tool(JSON.stringify({type:'fileChange',changes:[{path:'/r/a.js'},{path:'/r/b.js'},{path:'/r/c.js'}]}))];
 const info=describeActivity(records);
 assert.equal(info.state,'thinking');assert.equal(info.steps,2);assert.deepEqual(info.step,{verb:'编辑',target:'a.js, b.js +1'});
 assert.equal(readRecord(records[0]).step.target,'npm test -- --watch');
 assert.equal(readRecord(tool(JSON.stringify({type:'command_execution',command:'ls'}))).step.target,'ls','codex exec item names too');
});
test('replying, waiting and starting take precedence in that order',()=>{
 assert.equal(describeActivity([],{}).state,'starting');
 assert.equal(describeActivity([tool('Read: {}')],{replying:true}).state,'replying');
 assert.equal(describeActivity([tool('Read: {}')],{replying:true,waiting:true}).state,'waiting');
 assert.equal(lastSaid('x'.repeat(200)).length,160);
 assert.equal(duration(65000),'1:05');assert.equal(duration(3725000),'1:02:05');
});
test('the live timeline keeps narration in full and folds consecutive steps into groups',()=>{
 const said=(id,text)=>({id,role:'assistant',kind:'narration',text});
 const records=[{id:'s',role:'system',text:'正在处理。'},said('n1','Looking first.'),
  {...tool('Bash: {"command":"ls"}'),id:'t1'},{...tool('Read: {"file_path":"/r/a.js"}'),id:'t2'},tool('Tool result: x'),tool('Tool result: y'),
  said('n2','Now editing.'),{...tool('Edit: {"file_path":"/r/a.js"}'),id:'t3'},tool('Tool result: ok'),{...tool('Edit: {"file_path":"/r/a.js"}'),id:'t4'},said('blank',' ')];
 const entries=timeline(records);
 assert.deepEqual(entries.map(e=>[e.type,e.key]),[['said','n1'],['steps','t1'],['said','n2'],['steps','t3']]);
 assert.deepEqual(entries[1].steps.map(s=>[s.verb,s.done]),[['运行',true],['读取',true]],'results complete steps in order');
 assert.deepEqual(entries[3].steps.map(s=>s.done),[true,false],'the last edit is still running');
 assert.deepEqual(stepSummary(entries[1].steps),[{key:'运行了 1 条命令',count:1},{key:'读取了 1 个文件',count:1}]);
 assert.deepEqual(stepSummary(entries[3].steps),[{key:'编辑了 1 个文件',count:1}],'edits count distinct files');
 assert.deepEqual(stepSummary([{verb:'运行'},{verb:'运行'},{verb:'搜索网页'},{verb:'?'}]),[{key:'运行了 {count} 条命令',count:2},{key:'浏览了网页',count:1},{key:'调用了 1 次工具',count:1}]);
});
