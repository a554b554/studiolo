import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliRunner, redact } from '../src/runner.mjs';

async function harness(t, body, profile = 'claude', options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-cli-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'fake.mjs');
  await writeFile(script, `let input=''; for await (const chunk of process.stdin) input+=chunk;\nconst send=e=>process.stdout.write(JSON.stringify(e)+'\\n');\n${body}`);
  const runner = new CliRunner({ stateDir: dir, executables: { [profile]: { command: process.execPath, args: [script], models: [{ id: profile === 'codex' ? 'test-model' : 'claude-opus-5-5', label: 'Test', evidence: 'test' }], ...options } } });
  const events = [];
  return { dir, runner, events, execute: extra => runner.execute({ cwd: dir, profileId: profile, prompt: 'test', onEvent: e => events.push(e), ...extra }) };
}

test('Claude stdin handles shell syntax literally; streaming avoids duplicated text and private thinking', async t => {
  const h = await harness(t, `
    if (process.argv.includes('$(danger)')) process.exit(10);
    send({type:'system',subtype:'init',session_id:'native-1',model:'claude-opus-5-5',apiKey:'private'});
    send({type:'stream_event',event:{type:'message_start'}});
    send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'HIDDEN_REASONING'}}});
    send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:input.trim()}}});
    send({type:'assistant',message:{content:[{type:'text',text:input.trim()},{type:'thinking',thinking:'HIDDEN_REASONING'},{type:'tool_use',name:'Write',input:{file_path:'note.txt',content:'hello'}}]}});
    send({type:'result',subtype:'success',result:input.trim(),session_id:'native-1'});
  `);
  const prompt = '$(danger); & "quotes"\n中文输入';
  const result = await h.execute({ prompt });
  assert.equal(result.text, prompt);
  assert.equal(result.nativeSessionId, 'native-1');
  assert.equal(h.events.find(e => e.raw?.nativeSessionId).raw.nativeSessionId, 'native-1');
  assert.deepEqual(Object.keys(h.events.find(e => e.raw?.nativeSessionId).raw).sort(), ['model','nativeSessionId']);
  assert.equal(h.events.filter(e => e.type === 'text').map(e => e.text).join(''), prompt);
  assert.equal(h.events.filter(e => e.type === 'tool').length, 1);
  assert.ok(!JSON.stringify(h.events).includes('HIDDEN_REASONING'));
  assert.ok(!JSON.stringify(h.events).includes('apiKey'));
});

test('Claude permission denial returns waiting, not success; resume and wrapper identity preserved', async t => {
  const h = await harness(t, `
    if (!process.env.CLAUDE_CONFIG_DIR.endsWith('.claude1')) process.exit(11);
    if (!process.argv.includes('--resume') || !process.argv.includes('session-old')) process.exit(12);
    if (!process.argv.includes('--permission-prompts') || !process.argv.includes('none')) process.exit(13);
    send({type:'result',subtype:'success',result:'Cannot write',session_id:'session-old',permission_denials:[{tool_name:'Write',tool_input:{file_path:'x'}}]});
  `, 'claude1', { configDir: path.join(os.tmpdir(), 'studio-wrapper', '.claude1') });
  const result = await h.execute({ nativeSessionId: 'session-old' });
  assert.equal(result.status, 'waiting');
  assert.match(result.error, /Write/);
});

test('Codex normalizes public events and resumes exact native session', async t => {
  const h = await harness(t, `
    if (!process.argv.includes('resume') || !process.argv.includes('prior-session')) process.exit(15);
    send({type:'thread.started',thread_id:'prior-session'});
    send({type:'item.completed',item:{type:'reasoning',text:'HIDDEN'}});
    send({type:'item.completed',item:{type:'agent_message',text:'done'}});
    send({type:'item.completed',item:{type:'command_execution',command:'node test',aggregated_output:'passed',exit_code:0,status:'completed'}});
    send({type:'turn.completed'});
  `, 'codex');
  const result = await h.execute({ nativeSessionId: 'prior-session' });
  assert.equal(result.text, 'done');
  assert.equal(result.nativeSessionId, 'prior-session');
  assert.equal(h.events.find(e => e.raw?.nativeSessionId).raw.nativeSessionId, 'prior-session');
  assert.ok(h.events.some(e => e.type === 'tool' && e.text.includes('passed')));
  assert.ok(!JSON.stringify(h.events).includes('HIDDEN'));
});

test('Codex final answer excludes interim agent messages but preserves progress events', async t => {
  const h = await harness(t, `
    send({type:'item.completed',item:{type:'agent_message',phase:'commentary',text:'Inspecting files'}});
    send({type:'item.completed',item:{type:'command_execution',command:'test',status:'completed'}});
    send({type:'item.completed',item:{type:'agent_message',phase:'final_answer',text:'Fixed and tested'}});
    send({type:'turn.completed'});
  `, 'codex');
  assert.equal((await h.execute()).text,'Fixed and tested');
  assert.ok(h.events.some(e=>e.type==='text'&&e.text.includes('Inspecting files')));
});

test('Codex legacy exec protocol uses the last agent message as the final reply', async t => {
  const h = await harness(t, `
    send({type:'item.completed',item:{type:'agent_message',text:'Inspecting files'}});
    send({type:'item.completed',item:{type:'agent_message',text:'Done'}});
    send({type:'turn.completed'});
  `, 'codex');
  assert.equal((await h.execute()).text,'Done');
});

test('Errors, incomplete stream and invalid model never become successful turns', async t => {
  const h = await harness(t, `send({type:'result',subtype:'error_during_execution',is_error:true,result:'model unavailable'});`);
  await assert.rejects(h.execute(), /model unavailable/);
  await assert.rejects(h.execute({ model: 'unknown' }), /not available/);
  const incomplete = await harness(t, `send({type:'assistant',message:{content:[{type:'text',text:'partial'}]}});`);
  await assert.rejects(incomplete.execute(), /without a completed response/);
});

test('Cancelling terminates long running process and reports AbortError', async t => {
  const h = await harness(t, `send({type:'system',subtype:'init',session_id:'cancel-test'});setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const result = h.execute({ signal: controller.signal });
  setTimeout(() => controller.abort(), 250);
  await assert.rejects(result, { name: 'AbortError' });
});

test('Haiku rejects auto before starting a CLI and preserves explicit Plan mode', async t => {
  const h = await harness(t, `if(!process.argv.includes('plan'))process.exit(33);send({type:'result',subtype:'success',result:'plan-ok'});`, 'claude1', {models:[{id:'claude-haiku-4-5-20251001'}]});
  await assert.rejects(h.execute({permissionMode:'auto',sessionKey:'haiku'}), /Haiku 4.5.*Auto/);
  assert.equal(h.runner.sessions.size,0);
  assert.equal((await h.execute({permissionMode:'read-only'})).text,'plan-ok');
});

test('Machine-local configuration and models do not expose env secrets through profiles', async t => {
  const h = await harness(t, '', 'codex');
  await writeFile(path.join(h.dir, 'agent-profiles.json'), JSON.stringify({ claude: { command: process.execPath, env: { API_KEY: 'private-value' }, models: [{ id: 'a', label: 'A', evidence: 'configured' }] } }));
  const profiles = await h.runner.profiles();
  assert.equal(profiles.find(p => p.id === 'claude').models[0].id, 'a');
  assert.ok(!JSON.stringify(profiles).includes('private-value'));
  assert.equal(redact('api_key=abcdef Bearer mytoken'), 'api_key=[REDACTED] Bearer [REDACTED]');
});

test('An account without any model list is unavailable and never spawns', async t => {
  const h = await harness(t, '', 'claude2', { models: [] });
  await assert.rejects(h.execute({ model: 'claude-fable-5-1' }), /No models/);
  assert.equal((await h.runner.profiles()).find(p => p.id === 'claude2').available, false);
});

test('Split UTF-8 JSON stream and missing final newline are parsed', async t => {
  const h = await harness(t, `const b=Buffer.from(JSON.stringify({type:'result',subtype:'success',result:'你好'}));process.stdout.write(b.subarray(0,b.length-3));setTimeout(()=>process.stdout.write(b.subarray(b.length-3)),20);`);
  assert.equal((await h.execute()).text, '你好');
});

test('Explicit permission modes stay per invocation and never bypass native approval', async t => {
  const claude = await harness(t, `
    if (!process.argv.includes('--permission-mode') || !process.argv.includes('acceptEdits')) process.exit(30);
    if (process.argv.some(a=>a.includes('bypass') || a.includes('dangerously'))) process.exit(31);
    send({type:'result',subtype:'success',result:'ok'});
  `);
  assert.equal((await claude.execute({permissionMode:'project-write'})).text, 'ok');
  await assert.rejects(claude.execute({permissionMode:'bypass'}), /Invalid permission mode/);
  const codex = await harness(t, `
    if (process.argv.includes('resume')) {
      if (!process.argv.includes('sandbox_mode="workspace-write"')) process.exit(33);
    } else if (!process.argv.includes('--sandbox') || !process.argv.includes('workspace-write')) process.exit(34);
    if (process.argv.some(a=>a.includes('bypass') || a.includes('dangerously'))) process.exit(35);
    send({type:'item.completed',item:{type:'agent_message',text:'ok'}}); send({type:'turn.completed'});
  `, 'codex');
  assert.equal((await codex.execute({permissionMode:'project-write'})).text, 'ok');
  assert.equal((await codex.execute({permissionMode:'project-write',nativeSessionId:'test-resume'})).text, 'ok');
});

test('Codex read-only refusal remains visible as a status warning', async t => {
  const h = await harness(t, `send({type:'item.completed',item:{type:'agent_message',text:'The workspace is read-only and approvals are disabled.'}});send({type:'turn.completed'});`, 'codex');
  await h.execute();
  assert.ok(h.events.some(e => e.type === 'status' && e.text.includes('does not confirm')));
});

test('Malformed JSON values do not crash process handlers and platform token is excluded', async t => {
  const h = await harness(t, `if (process.env.STUDIO_TOKEN) process.exit(99);process.stdout.write('null\\n[]\\n"str"\\n');send({type:'result',subtype:'success',result:'ok'});`, 'claude', {env:{STUDIO_TOKEN:'do-not-forward'}});
  assert.equal((await h.execute()).text, 'ok');
});

test('model and effort are explicit on fresh and resumed invocations; unsupported effort never spawns', async t => {
  for (const profile of ['claude','codex']) {
    const model = profile === 'claude' ? 'claude-opus-5-5' : 'test-model';
    const h = await harness(t, `
      if (!process.argv.includes('--model') || !process.argv.includes('${model}')) process.exit(40);
      const level = process.argv.includes('resume') || process.argv.includes('--resume') ? 'high' : 'low';
      if ('${profile}' === 'claude') {
        if (process.argv[process.argv.indexOf('--effort')+1] !== level) process.exit(41);
        send({type:'result',subtype:'success',result:'ok'});
      } else {
        if (!process.argv.includes('model_reasoning_effort="'+level+'"')) process.exit(42);
        send({type:'turn.completed'});
      }
    `,profile,{models:[{id:model,label:'Test',efforts:['low','high']}]});
    await h.execute({model,reasoningEffort:'low'});
    await h.execute({model,reasoningEffort:'high',nativeSessionId:'previous'});
    await assert.rejects(h.execute({model,reasoningEffort:'ultra'}), /not available/);
  }
});
test('Claude cumulative billing never overwrites the model that produced this reply', async t => {
 const h=await harness(t, `
 send({type:'system',subtype:'init',model:'claude-opus-5-5'});
 send({type:'assistant',message:{model:'claude-opus-5-5',content:[{type:'text',text:'current'}]}});
 send({type:'result',subtype:'success',result:'current',modelUsage:{'claude-fable-5-1':{},'claude-opus-5-5':{}}});
 `);
 assert.equal((await h.execute()).model,'claude-opus-5-5');
});
