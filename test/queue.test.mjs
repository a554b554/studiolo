import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { QueueManager } from '../src/queue.mjs';
import {conversationItems} from '../public/conversation.js';

async function waitFor(fn) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('Condition timed out');
}
async function fixture(t, execute, options = {}) {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.test-studio-queue-'));
  const store = await new Store({ stateDir: path.join(dir, 'local'), hostId: 'a' }).init();
  const project = await store.createProject({ name: 'Test', path: path.join(dir, 'project') });
  const sessions = [randomUUID(), randomUUID()];
  await store.mutate(project.id, 'sessions', s => { s.sessions = sessions.map(id => ({ id, title: id, createdAt: new Date().toISOString() })); });
  const queue = await new QueueManager({ store, runner: { execute }, hostId: 'a', ...options }).init();
  t.after(async () => { await queue.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const submit = (text, sessionId = sessions[0], extra = {}) => queue.submit(project.id, { requestId: randomUUID(), sessionId, text, profileId: 'codex', model: 'test', ...extra });
  const read = () => store.read(project.id);
  return { dir, store, project, sessions, queue, submit, read };
}

test('late resident answers are durable chat messages without replacing the original answer',async t=>{
 let callback;
 const f=await fixture(t,async({onEvent})=>{callback=onEvent;await onEvent({type:'reply',text:'Recovered during setup'});return {text:'Main answer'};});
 const run=await f.submit('question');
 await waitFor(async()=>(await f.read()).runs[0].status==='succeeded');
 await callback({type:'reply',text:'Background finished'});
 const state=await f.read(),answers=state.messages.filter(m=>m.role==='assistant');
 assert.deepEqual(answers.map(m=>m.text),['Recovered during setup','Main answer','Background finished']);
 assert.equal(answers[0].kind,'background_reply');assert.equal(answers[2].kind,'background_reply');
 assert.equal(state.runs[0].id,run.id);assert.equal(state.runs[0].status,'succeeded');
 const visible=conversationItems(state.messages,state.runs).filter(i=>i.kind==='message'&&i.message.role==='assistant');
 assert.deepEqual(visible.map(i=>i.message.text),answers.map(m=>m.text));
 // Reload the journal with an independent store to verify this is not only a live overlay.
 const reloaded=await new Store({stateDir:path.join(f.dir,'local'),hostId:'a'}).init();
 assert.deepEqual((await reloaded.read(f.project.id)).messages.filter(m=>m.role==='assistant'),answers);
});

test('model is fixed, effort stays per message; waiting replies survive restart without replay', async t => {
  const calls=[];
  const f=await fixture(t,async args=>{calls.push(args);return {text:'Permission was denied',status:'waiting',error:'Permission or user input required: Edit'};});
  await f.submit('first',undefined,{model:'a',reasoningEffort:'low'});
  await waitFor(async()=> (await f.read()).runs[0].status==='waiting');
  await assert.rejects(f.submit('wrong model',undefined,{model:'b'}),e=>e.status===409);
  await f.submit('second',undefined,{model:'a',reasoningEffort:'high'});
  await f.queue.close();
  const restarted=await new QueueManager({store:f.store,hostId:'a',runner:{execute:()=>{throw new Error('must not replay');}}}).init();
  t.after(()=>restarted.close());
  const state=await f.read();
  assert.equal(state.runs[0].status,'waiting');assert.equal(state.runs[1].status,'queued');
  assert.deepEqual(state.runs.map(r=>[r.model,r.reasoningEffort]),[['a','low'],['a','high']]);
  assert.equal(calls[0].reasoningEffort,'low');
});

test('service restart preserves native transcript, sends delta and persists token counters', async t => {
  const usage={provider:'codex',sessionTotal:{inputTokens:100,cachedInputTokens:80,outputTokens:10},turn:{inputTokens:100,cachedInputTokens:80,outputTokens:10}};
  const f=await fixture(t,async()=>({text:'first reply',nativeSessionId:'stable-thread',usage}));
  await f.submit('remember marker');
  await waitFor(async()=>(await f.read()).runs[0].status==='succeeded');
  await f.queue.close();
  let invocation;
  const restarted=await new QueueManager({store:f.store,hostId:'a',runner:{execute:async args=>{invocation=args;return {text:'marker',nativeSessionId:'stable-thread'};}}}).init();
  t.after(()=>restarted.close());
  await restarted.submit(f.project.id,{requestId:randomUUID(),sessionId:f.sessions[0],text:'recall marker',profileId:'codex',model:'test'});
  await waitFor(async()=>(await f.read()).runs[1].status==='succeeded');
  assert.equal(invocation.nativeSessionId,'stable-thread');assert.equal(invocation.prompt,'recall marker');
  assert.deepEqual(invocation.previousUsage,usage.sessionTotal);
  assert.deepEqual((await f.read()).runs.map(r=>r.context.mode),['bootstrap','delta']);
  await restarted.close();
});

test('legacy mixed conversation binds latest profile on startup without removing history',async t=>{
 const f=await fixture(t,async()=>({text:'done'}));await f.queue.close();
 await f.store.mutate(f.project.id,'legacy',s=>{s.runs.push({id:'a',hostId:'a',model:'test',sessionId:f.sessions[0],profileId:'claude',status:'succeeded'},{id:'b',hostId:'a',model:'test',sessionId:f.sessions[0],profileId:'codex',status:'succeeded'});});
 const restarted=await new QueueManager({store:f.store,hostId:'a',runner:{execute:async()=>({text:'done'})}}).init();
 try{assert.equal((await f.read()).sessions[0].profileId,'codex');assert.equal((await f.read()).runs.length,2);
 await assert.rejects(restarted.submit(f.project.id,{requestId:randomUUID(),sessionId:f.sessions[0],profileId:'claude',model:'test',text:'mismatch'}),e=>e.status===409);
 }finally{await restarted.close();}
});

test('independent queues run in parallel, each FIFO; duplicate requests run once', async t => {
  const calls = [];
  const releases = new Map();
  const f = await fixture(t, async args => {
    const text = args.prompt.split('\n')[0]; calls.push(text);
    await new Promise(resolve => releases.set(text, resolve));
    return { text: `Done ${text}`, nativeSessionId: `native-${text}` };
  });
  const requestId = randomUUID();
  const first = await f.submit('first', undefined, { requestId });
  const duplicate = await f.submit('first', undefined, { requestId });
  assert.equal(first.id, duplicate.id);
  await f.submit('second');
  await f.submit('parallel', f.sessions[1]);
  await waitFor(() => calls.length === 2);
  assert.deepEqual(new Set(calls), new Set(['first', 'parallel']));
  releases.get('first')();
  await waitFor(() => calls.length === 3);
  assert.equal(calls[2], 'second');
  releases.get('second')(); releases.get('parallel')();
  await waitFor(async () => (await f.read()).runs.every(r => r.status === 'succeeded'));
  assert.equal((await f.read()).runs.length, 3);
});

test('failure pauses queue; accounts are fixed within sessions and project history is shared', async t => {
  const calls = [];
  const f = await fixture(t, async args => {
    calls.push(args);
    if (args.prompt.startsWith('bad\n')) throw new Error('real failure');
    args.onEvent({ type: 'text', text: 'streamed ' });
    args.onEvent({ type: 'tool', text: 'read a file' });
    args.onEvent({ type: 'text', text: 'reply' });
    return { text: 'final reply', nativeSessionId: `native-${args.profileId}` };
  });
  await f.submit('bad'); await f.submit('good');
  await waitFor(async () => (await f.read()).runs[0].status === 'failed');
  assert.equal(calls.length, 1);
  assert.equal((await f.read()).runs[1].status, 'queued');
  await f.queue.resume(f.project.id, `session:${f.sessions[0]}`);
  await waitFor(async () => (await f.read()).runs[1].status === 'succeeded');
  await assert.rejects(f.submit('wrong profile',undefined,{profileId:'claude'}),e=>e.status===409);
  await f.submit('claude', f.sessions[1], { profileId: 'claude' });
  await waitFor(async () => (await f.read()).runs[2].status === 'succeeded');
  await f.submit('codex again');
  await waitFor(async () => (await f.read()).runs[3].status === 'succeeded');
  assert.equal(calls[2].nativeSessionId, undefined);
  assert.equal(calls[3].nativeSessionId, 'native-codex');
  assert.match(calls[2].prompt, /history-index\.md/);
  assert.match(calls[2].prompt, /Current conversation history:.*sessions/);
  assert.match(calls[2].prompt, /studio\.artifacts\.json/);
  assert.match(calls[2].prompt, /Preserve every other existing manifest entry unchanged/);
  assert.equal(calls[3].prompt, 'codex again');
  const s = await f.read();
  assert.equal(s.messages.find(m => m.role === 'assistant').text, 'final reply');
  assert.ok(s.messages.some(m => m.kind === 'tool' && m.text === 'read a file'));
});

test('cancel stops execution and holds later work; waiting cannot be blindly replayed', async t => {
  const f = await fixture(t, async args => {
    if (args.prompt.startsWith('wait\n')) return { text: 'Need permission', status: 'waiting', error: 'approve locally' };
    await new Promise((resolve, reject) => args.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const first = await f.submit('long');
  await waitFor(async () => (await f.read()).runs[0].status === 'running');
  await f.submit('wait');
  await f.queue.cancel(f.project.id, first.id);
  await f.queue.resume(f.project.id, `session:${f.sessions[0]}`);
  await waitFor(async () => (await f.read()).runs[1].status === 'waiting');
  await assert.rejects(f.queue.resume(f.project.id, `session:${f.sessions[0]}`), /cannot be replayed safely/);
  assert.equal((await f.read()).runs[0].status, 'cancelled');
});

test('restart interrupts owned active runs, retains pending work, never replays it automatically', async t => {
  let executions = 0;
  const f = await fixture(t, async () => { executions++; return { text: 'done' }; });
  await f.queue.close();
  await f.store.mutate(f.project.id, 'crash-fixture', s => {
    s.runs.push({ id: randomUUID(), requestId: randomUUID(), hostId: 'a', queueId: `session:${f.sessions[0]}`, sessionId: f.sessions[0], status: 'running', profileId: 'codex', model: 'test', text: 'do not replay', createdAt: new Date().toISOString() });
    s.runs.push({ id: randomUUID(), requestId: randomUUID(), hostId: 'a', queueId: `session:${f.sessions[0]}`, sessionId: f.sessions[0], status: 'queued', profileId: 'codex', model: 'test', text: 'remain queued', createdAt: new Date().toISOString() });
    s.queues[`session:${f.sessions[0]}`] = { paused: false };
  });
  const restarted = await new QueueManager({ store: f.store, runner: { execute: async () => { executions++; } }, hostId: 'a' }).init();
  t.after(() => restarted.close());
  assert.equal((await f.read()).runs[0].status, 'interrupted');
  assert.equal((await f.read()).runs[1].status, 'queued');
  assert.equal((await f.read()).queues[`session:${f.sessions[0]}`].paused, true);
  assert.equal(executions, 0);
});

test('all comments of one artifact share a queue and completion does not resolve comments', async t => {
  let concurrent = 0, max = 0;
  const f = await fixture(t, async args => {
    concurrent++; max = Math.max(max, concurrent);
    assert.match(args.prompt, /Artifact comment evidence:/);
    assert.match(args.prompt, /Artifact configuration \(paths relative to project\):.*"root":"app"/);
    await new Promise(resolve => setTimeout(resolve, 20)); concurrent--;
    return { text: 'Updated it' };
  });
  const aid = randomUUID(), annotations = [randomUUID(), randomUUID()];
  await f.store.mutate(f.project.id, 'artifact', s => {
    s.artifacts.push({ id: aid, name: 'App', root: 'app', createdAt: new Date().toISOString() });
    s.annotations = annotations.map(id => ({ id, artifactId: aid, text: 'fix', status: 'open', anchorStatus: 'orphaned', anchor: { kind: 'element', selector: '#gone' }, createdAt: new Date().toISOString() }));
  });
  for (const id of annotations) await f.queue.submit(f.project.id, { requestId: randomUUID(), artifactId: aid, annotationId: id, text: 'fix', profileId: 'codex', model: 'test' });
  await waitFor(async () => (await f.read()).runs.every(r => r.status === 'succeeded'));
  assert.equal(max, 1);
  const s = await f.read();
  assert.equal(s.runs[0].queueId, s.runs[1].queueId);
  assert.ok(s.annotations.every(a => a.status === 'open' && a.anchorStatus === 'orphaned'));
});

test('shared projects permit local conversations without project takeover', async t => {
  const f=await fixture(t,async()=>({text:'local'}));
  await f.store.mutate(f.project.id,'legacy-owner',s=>{s.project.ownerHostId='b';});
  const run=await f.submit('execute locally');assert.equal(run.hostId,'a');
  await waitFor(async()=>(await f.read()).runs[0].status==='succeeded');
});

test('takeover does not silently migrate requests submitted for a different host', async t => {
  let launched = false;
  const f = await fixture(t, async () => { launched = true; return { text: 'wrong host' }; });
  await f.store.mutate(f.project.id, 'import-queued', s => {
    s.runs.push({ id: randomUUID(), requestId: randomUUID(), hostId: 'b', queueId: `session:${f.sessions[0]}`, sessionId: f.sessions[0], status: 'queued', profileId: 'codex', model: 'test', text: 'run on b', createdAt: new Date().toISOString() });
    s.queues[`session:${f.sessions[0]}`] = { paused: true };
  });
  await assert.rejects(f.queue.resume(f.project.id, `session:${f.sessions[0]}`),/another machine/);
  assert.equal(launched, false);
  assert.equal((await f.read()).runs[0].hostId,'b');
});

test('permission mode is fixed at submission and forwarded unchanged to the runner', async t => {
  const modes = [];
  const f = await fixture(t, async args => { modes.push(args.permissionMode); return { text: 'done' }; });
  const requestId = randomUUID();
  const original = await f.submit('write inside project', undefined, { permissionMode: 'project-write', requestId });
  const duplicate = await f.submit('write inside project', undefined, { permissionMode: 'read-only', requestId });
  assert.equal(duplicate.id, original.id);
  assert.equal(duplicate.permissionMode, 'project-write');
  await f.submit('read only', undefined, { permissionMode: 'read-only' });
  await f.submit('default');
  await assert.rejects(f.submit('unsafe', undefined, { permissionMode: 'all-access' }), /Invalid permission mode/);
  await waitFor(async () => (await f.read()).runs.every(r => r.status === 'succeeded'));
  assert.deepEqual(modes, ['project-write', 'read-only', 'auto']);
  assert.deepEqual((await f.read()).runs.map(r => r.permissionMode), modes);
});

test('shutdown cannot hang forever on an unresponsive runner; interruption remains durable', async t => {
  let invoked = false;
  const f = await fixture(t, async () => { invoked = true; return new Promise(() => {}); });
  await f.submit('unresponsive child');
  await waitFor(() => invoked);
  const result = await f.queue.close({ timeoutMs: 30 });
  assert.equal(result.pendingCancellation, true);
  const state = await f.read();
  assert.equal(state.runs[0].status, 'interrupted');
  assert.equal(state.queues[state.runs[0].queueId].paused, true);
  assert.match(state.runs[0].error, /Verify native processes/);
});

test('native session announced before interruption persists for explicit continuation after restart', async t => {
  let initialized = false;
  const f = await fixture(t, async args => {
    await args.onEvent({ type: 'status', text: 'CLI initialized', raw: { nativeSessionId: 'native-before-final', model: 'actual-model-v2', credential: 'must-not-persist' } });
    return new Promise((resolve, reject) => {
      args.signal.addEventListener('abort', () => reject(new Error('interrupted before result')), { once: true });
      initialized = true;
    });
  });
  await f.submit('first invocation');
  await waitFor(() => initialized);
  await f.queue.close();
  const reopened = await new Store({ stateDir: path.join(f.dir, 'local'), hostId: 'a' }).init();
  const state = await reopened.read(f.project.id);
  assert.equal(state.runs[0].status, 'interrupted');
  assert.equal(state.runs[0].nativeSessionId, 'native-before-final');
  assert.equal(state.runs[0].model, 'test');
  assert.equal(state.runs[0].actualModel, 'actual-model-v2');
  assert.equal(JSON.stringify(state).includes('must-not-persist'), false);
  let receivedSession;
  const restarted = await new QueueManager({ store: reopened, hostId: 'a', runner: { execute: async args => { receivedSession = args.nativeSessionId; return { text: 'continued' }; } } }).init();
  try {
    await restarted.submit(f.project.id, { requestId: randomUUID(), sessionId: f.sessions[0], text: 'continue', profileId: 'codex', model: 'test' });
    assert.equal(receivedSession, undefined);
    await restarted.resume(f.project.id, `session:${f.sessions[0]}`);
    await waitFor(async () => (await reopened.read(f.project.id)).runs[1].status === 'succeeded');
    assert.equal(receivedSession, 'native-before-final');
  } finally { await restarted.close(); }
});

test('streamed output is coalesced into few snapshots, visible live first, with order and final text retained', async t => {
  let release;
  const f = await fixture(t, async args => {
    for (let i = 0; i < 1000; i++) args.onEvent({ type: 'text', text: 'a' });
    args.onEvent({ type: 'tool', text: 'middle tool' });
    for (let i = 0; i < 1000; i++) args.onEvent({ type: 'text', text: 'b' });
    args.onEvent({ type: 'status', text: 'later status' });
    await new Promise(resolve => { release = resolve; });
    args.onEvent({ type: 'text', text: 'last text before error' });
    throw new Error('failure after stream');
  }, { outputCommitMs: 60000 });
  const run = await f.submit('stream');
  await waitFor(() => release);
  const durable = await f.read();
  assert.equal(durable.messages.some(m => m.role === 'assistant'), false, 'output stays in memory until the commit interval');
  const live = f.queue.overlay(f.project.id, await f.read());
  assert.deepEqual(live.messages.filter(m => m.runId === run.id).slice(-3).map(m => m.text), ['a'.repeat(1000) + 'b'.repeat(1000), 'middle tool', 'later status']);
  release();
  await waitFor(async () => (await f.read()).runs[0].status === 'failed');
  const state = await f.read();
  const assistant = state.messages.find(m => m.role === 'assistant');
  assert.equal(assistant.text, 'a'.repeat(1000) + 'b'.repeat(1000) + 'last text before error');
  assert.equal(assistant.id, live.messages.find(m => m.role === 'assistant').id, 'live and durable views share message IDs');
  assert.deepEqual(state.messages.filter(m => m.kind).map(m => m.text), ['middle tool', 'later status']);
  const eventDir = path.join(f.project.path, '.studio', 'events');
  const events = await Promise.all((await fs.readdir(eventDir)).sort().map(name => fs.readFile(path.join(eventDir, name), 'utf8').then(JSON.parse)));
  assert.equal(events.filter(e => e.type === 'run.output').length, 1, '2001 deltas, a tool and a status event become one snapshot');
});

test('buffered output reaches disk on the commit interval while the run continues', async t => {
  let release;
  const f = await fixture(t, async args => {
    args.onEvent({ type: 'text', text: 'progress' });
    await new Promise(resolve => { release = resolve; });
    return { text: 'done' };
  }, { outputCommitMs: 30 });
  await f.submit('interval');
  await waitFor(async () => (await f.read()).messages.some(m => m.role === 'assistant' && m.text === 'progress'));
  assert.equal((await f.read()).runs[0].status, 'running');
  release();
  await waitFor(async () => (await f.read()).runs[0].status === 'succeeded');
});

test('cancellation flushes accepted text even if cancelled status commits before the debounce timer', async t => {
  let started = false;
  const f = await fixture(t, async args => {
    args.onEvent({ type: 'text', text: 'Partial answer' });
    return new Promise((resolve, reject) => {
      args.signal.addEventListener('abort', () => reject(new Error('cancelled during stream')), { once: true });
      started = true;
    });
  });
  const run = await f.submit('partial');
  await waitFor(() => started);
  await f.queue.cancel(f.project.id, run.id);
  await f.queue.close();
  const state = await f.read();
  assert.equal(state.runs[0].status, 'cancelled');
  assert.equal(state.messages.find(m => m.role === 'assistant').text, 'Partial answer');
});

test('web approvals bind exact run, reject duplicates, preserve FIFO and continue same execution', async t => {
  let calls=0;
  const f=await fixture(t,async args=>{
    calls++;
    if(calls===1){const answer=await args.onApproval({kind:'permission',title:'Write',detail:'test.txt'},args.signal);assert.equal(answer.decision,'allow');}
    return {text:'done'};
  });
  const first=await f.submit('first');await f.submit('second');
  await waitFor(async()=> (await f.read()).runs[0].approvals?.[0]?.status==='pending');
  const id=(await f.read()).runs[0].approvals[0].id;
  assert.equal(calls,1);
  await assert.rejects(f.queue.approvals.respond(f.project.id,'wrong-run',id,{decision:'allow'}),/失效/);
  await f.queue.approvals.respond(f.project.id,first.id,id,{decision:'allow'});
  await assert.rejects(f.queue.approvals.respond(f.project.id,first.id,id,{decision:'allow'}),/失效/);
  await waitFor(async()=> (await f.read()).runs[1].status==='succeeded');
  assert.equal(calls,2);assert.equal((await f.read()).runs[0].approvals[0].status,'approved');
});

test('web approval cancellation invalidates buttons and does not execute queued work', async t => {
  const f=await fixture(t,async args=>{await args.onApproval({kind:'permission',title:'Write',detail:'test.txt'},args.signal);throw new Error('must not execute');});
  const first=await f.submit('first');await f.submit('second');
  await waitFor(async()=> (await f.read()).runs[0].approvals?.[0]?.status==='pending');
  const id=(await f.read()).runs[0].approvals[0].id;
  await f.queue.cancel(f.project.id,first.id);
  await assert.rejects(f.queue.approvals.respond(f.project.id,first.id,id,{decision:'allow'}),/失效/);
  await waitFor(async()=> (await f.read()).runs[0].approvals[0].status==='expired');
  assert.equal((await f.read()).runs[0].status,'cancelled');assert.equal((await f.read()).runs[1].status,'queued');
});

test('restart expires live approval instead of showing an actionable stale button', async t => {
  const f=await fixture(t,async()=>({text:'unused'}));
  await f.queue.close();
  await f.store.mutate(f.project.id,'test.crash',s=>{s.runs.push({id:'lost',status:'waiting',hostId:'a',queueId:'q',approvals:[{id:'old',status:'pending'}]});s.queues.q={paused:false};});
  const q=await new QueueManager({store:f.store,runner:{},hostId:'a'}).init();t.after(()=>q.close());
  const run=(await f.read()).runs[0];assert.equal(run.status,'interrupted');assert.equal(run.approvals[0].status,'expired');
  await assert.rejects(q.approvals.respond(f.project.id,'lost','old',{decision:'allow'}),/失效/);
});

test('legacy waiting continuation is explicit, idempotent and runs before later queued messages',async t=>{
 const calls=[];const f=await fixture(t,async args=>{calls.push(args);return calls.length===1?{status:'waiting',error:'Permission or user input required',text:'blocked'}:{text:'done'};});
 const old=await f.submit('original');await waitFor(async()=>(await f.read()).runs[0].status==='waiting');await waitFor(()=>!f.queue.controllers.has(old.id));
 await f.submit('later');const next=await f.queue.continueWaiting(f.project.id,old.id);const again=await f.queue.continueWaiting(f.project.id,old.id);assert.equal(next.id,again.id);
 await waitFor(async()=>(await f.read()).runs.every(r=>['succeeded','cancelled'].includes(r.status)));
 assert.equal(calls.length,3);assert.match(calls[1].prompt,/原请求：\noriginal/);assert.match(calls[2].prompt,/^later/);assert.equal(calls[1].permissionMode,'auto');
});
