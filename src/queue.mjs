import {buildContext} from './context.mjs';
import { randomUUID } from 'node:crypto';
import {inactive} from './lifecycle.mjs';
import {Approvals} from './approvals.mjs';
import {SessionTitles} from './session-titles.mjs';
import {sessionBinding} from './journal.mjs';
import {parseCommand} from './commands.mjs';
import {markUnread} from './unread.mjs';

const now = () => new Date().toISOString();
const noActiveTurn = e => e?.message === 'no_active_turn';
const active = status => status === 'running' || status === 'waiting';
function error(message, status = 400) { return Object.assign(new Error(message), { status, statusCode: status }); }
const scrub = text => String(text ?? '').replace(/\b(?:Bearer)\s+[\w.\-~+/]+=*/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]').replace(/((?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY)\s*[=:]\s*)[^\s,"']+/gi, '$1[REDACTED]');
const mappingKey = (hostId, run) => `${hostId}:${run.profileId}:${run.sessionId || `artifact:${run.artifactId}`}`;
function rememberNative(state, run, hostId, metadata) {
  // Only explicitly exposed public IDs are persisted, never entire protocol events.
  if (typeof metadata?.nativeSessionId === 'string' && /^[\w-]{1,150}$/.test(metadata.nativeSessionId)) {
    run.nativeSessionId = metadata.nativeSessionId;
    state.nativeSessions[mappingKey(hostId, run)] = metadata.nativeSessionId;
  }
  if (typeof metadata?.model === 'string' && /^[\w./:+-]{1,200}$/.test(metadata.model)) run.actualModel = metadata.model;
  if (typeof metadata?.modelLabel === 'string') run.modelLabel = metadata.modelLabel;
  if (typeof metadata?.reasoningEffort === 'string') run.actualReasoningEffort = metadata.reasoningEffort;
}

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {}); return { promise, resolve, reject }; };

export class QueueManager {
  // Each commit writes a full project snapshot, so streamed output is committed at most
  // every outputCommitMs; clients see uncommitted output through overlay() meanwhile.
  // `knowledge` resolves the machine-specific shared knowledge ({text, hash} or null) appended to
  // platform prompts; see subagents.mjs. A failure there never blocks the run.
  constructor({ store, runner, hostId, knowledge = null, outputCommitMs = 3000, liveNotifyMs = 400, outputBufferChars = 1024 * 1024 }) {
    this.knowledge = knowledge;
    this.store = store;
    this.runner = runner;
    this.hostId = hostId;
    this.drains = new Map();
    this.controllers = new Map();
    this.approvals = new Approvals(store,hostId);
    this.titles = new SessionTitles({store,runner,hostId});
    this.closed = false;
    this.live = new Map();
    this.liveTimers = new Map();
    Object.assign(this, { outputCommitMs, liveNotifyMs, outputBufferChars });
  }

  // Read-only: apply the uncommitted output of executing runs to a state copy for clients.
  overlay(projectId, state) {
    for (const live of this.live.values()) if (live.projectId === projectId && live.events.length) this._applyOutput(state, live);
    return state;
  }

  _liveNotify(projectId) {
    if (this.liveTimers.has(projectId)) return;
    this.liveTimers.set(projectId, setTimeout(() => { this.liveTimers.delete(projectId); this.store.notify?.(projectId, 'run.live'); }, this.liveNotifyMs));
  }

  // Applies buffered output in arrival order, skipping events already in the run's durable
  // outputSeq. Commits pass `upto`; the overlay leaves the durable marker untouched.
  _applyOutput(s, live, upto) {
    const current = s.runs.find(r => r.id === live.runId);
    // Events accepted before abort must remain in the partial transcript even if
    // cancellation committed before the final buffered batch reached disk.
    if (!current || current.hostId !== this.hostId) return;
    const done = current.outputSeq || 0;
    // Text streams into the current assistant segment; a steer (a user message delivered
    // mid-turn) is recorded in order and opens a new segment for what the agent says next.
    // So does a tool call (or Codex marking a message as commentary): the text before it was the
    // agent narrating its work, which belongs with the operation records, and the reply that
    // follows streams as a segment of its own.
    let text = '', textAt, assistantId = live.assistantId;
    const appendText = () => {
      if (!text) return;
      let msg = s.messages.find(m => m.id === assistantId);
      if (!msg) { msg = this._message(current, 'assistant', ''); msg.id = assistantId; msg.createdAt = textAt; s.messages.push(msg); }
      msg.text = scrub(msg.text + text); text = '';
    };
    for (const event of live.events) {
      if (event.seq <= done || upto !== undefined && event.seq > upto) continue;
      if (event.type === 'text') { if (!text) textAt = event.at; text += event.text; continue; }
      appendText();
      if (event.type === 'steer') {
        s.messages.push({ ...this._message(current, 'user', event.text), id: event.id, createdAt: event.at, kind: 'steer' });
        assistantId = event.assistantId; continue;
      }
      if (event.type === 'reply') {
        if (event.text) s.messages.push({...this._message(current, 'assistant', event.text), id:event.id, createdAt:event.at, kind:'background_reply'});
        continue;
      }
      if ((event.type === 'tool' || event.type === 'narration') && event.assistantId) {
        const segment = s.messages.find(m => m.id === assistantId);
        if (segment) { segment.kind = 'narration'; assistantId = event.assistantId; }
      }
      if (event.type === 'status') rememberNative(s, current, this.hostId, event.raw);
      if (!event.text) continue;
      const msg = this._message(current, 'system', event.text);
      Object.assign(msg, { id: event.id, createdAt: event.at, kind: event.type });
      s.messages.push(msg);
    }
    appendText();
    if (upto !== undefined) { current.outputSeq = Math.max(done, upto); live.assistantId = assistantId; }
  }

  _sessionKey(projectId, run) { return `${projectId}:${run.queueId}:${run.profileId}:${this.hostId}`; }

  async init() {
    for (const project of await this.store.listProjects()) {
      if (project.unavailable) continue;
      let state = await this.store.read(project.id);
      const legacy=state.sessions.filter(s=>!s.hostId&&sessionBinding(state,s.id)?.hostId===this.hostId);
      if(legacy.length){await this.store.mutate(project.id,'sessions.bound',s=>{for(const old of legacy){const bound=sessionBinding(s,old.id),target=s.sessions.find(x=>x.id===old.id);Object.assign(target,{hostId:bound.hostId,profileId:bound.profileId,model:bound.model});}});state=await this.store.read(project.id);}
      const lost = r => (r.status === 'running' || r.status === 'waiting' && r.approvals?.some(a=>a.status==='pending')) && r.hostId === this.hostId;
      if (state.runs.some(lost)) {
        await this.store.mutate(project.id, 'queue.recovered', s => {
          for (const run of s.runs.filter(lost)) {
            for(const a of run.approvals||[])if(a.status==='pending')a.status='expired';
            run.status = 'interrupted'; run.endedAt = now(); run.error = 'Execution interrupted by service restart; it will not be replayed automatically.';
            s.queues[run.queueId] = { ...s.queues[run.queueId], paused: true, reason: run.error };
            markUnread(s, run);
          }
        });
        state = await this.store.read(project.id);
      }
      for (const queueId of new Set(state.runs.filter(r => r.status === 'queued' && r.hostId === this.hostId).map(r => r.queueId))) this._kick(project.id, queueId);
      for (const session of state.sessions.filter(s => s.titleSource === 'pending')) {
        const first = state.runs.find(r => r.sessionId === session.id && r.status === 'succeeded');
        if (first?.hostId === this.hostId) this.titles.schedule(project.id, first.id);
      }
    }
    return this;
  }

  async submit(projectId, input) {
    if (this.closed) throw error('Queue manager is closed', 503);
    let profiles = null;
    if(this.runner.profiles){profiles=await this.runner.profiles();const p=profiles.find(p=>p.id===input.profileId);if(!p||p.available===false||!p.models.some(m=>m.id===input.model))throw error('Selected account or model is unavailable',409);}
    if (input.steer) { const steered = await this._steer(projectId, input); if (steered) return steered; }
    const command = parseCommand(input.text);
    if (command?.name === 'clear') return this._clear(projectId, input);
    const run = await this.store.mutate(projectId, 'run.queued', state => {

      if (inactive(state.project) || input.sessionId && inactive(state.sessions.find(s=>s.id===input.sessionId))) throw error('项目或对话已归档／删除，请先恢复',409);
      if (!input.requestId || typeof input.requestId !== 'string') throw error('requestId is required');
      const existing = state.runs.find(r => r.requestId === input.requestId);
      if (existing) return existing;
      if (typeof input.text !== 'string' || !input.text.trim()) throw error('Message text is required');
      if (!input.profileId || typeof input.profileId !== 'string' || !input.model || typeof input.model !== 'string') throw error('Agent and model are required');
      const permissionMode = input.permissionMode ?? 'auto';
      if (!['auto', 'default', 'read-only', 'project-write'].includes(permissionMode)) throw error('Invalid permission mode');
      if (input.reasoningEffort && !['none','minimal','low','medium','high','xhigh','max','ultra'].includes(input.reasoningEffort)) throw error('Invalid reasoning effort');
      if (input.hostId && input.hostId !== this.hostId) throw error('Submit this request to the selected host', 409);
      if (Boolean(input.sessionId) === Boolean(input.artifactId)) throw error('Specify a session or an artifact');
      if (input.sessionId && !state.sessions.some(s => s.id === input.sessionId)) throw error('Session not found', 404);
      if (input.artifactId && (!state.artifacts.some(a => a.id === input.artifactId) || !state.annotations.some(a => a.id === input.annotationId && a.artifactId === input.artifactId))) throw error('Artifact comment not found', 404);
      if(input.sessionId){
        const session=state.sessions.find(s=>s.id===input.sessionId);
        const bound=sessionBinding(state,session.id);
        // An account removed from this machine releases its conversations to another account here.
        const gone=Boolean(bound.profileId)&&profiles!==null&&!profiles.some(p=>p.id===bound.profileId);
        // The model may change from one message to the next; machine and account stay.
        if(bound.hostId&&bound.hostId!==this.hostId||!gone&&bound.profileId&&bound.profileId!==input.profileId)throw error('This conversation is fixed to its machine and account. Create a new conversation to change them.',409);
        session.hostId=this.hostId;session.profileId=input.profileId;session.model=input.model;
        session.selection={model:input.model,reasoningEffort:input.reasoningEffort||null,permissionMode};
      }
      const queueId = input.sessionId ? `session:${input.sessionId}` : `artifact:${input.artifactId}:${this.hostId}`;
      const item = { id: randomUUID(), requestId: input.requestId, queueId, text: input.text, profileId: input.profileId, model: input.model, reasoningEffort: input.reasoningEffort || null, permissionMode, hostId: this.hostId, status: 'queued', createdAt: now() };
      for (const field of ['sessionId', 'artifactId', 'annotationId']) if (input[field]) item[field] = input[field];
      // A slash command reaches the CLI verbatim (Claude) or as a mapped native request (Codex).
      if (command) item.command = command;
      // Who ran it, as shown at the time: accounts can be renamed or removed later.
      const account = profiles?.find(p => p.id === input.profileId);
      if (account) item.account = { label: account.label, family: account.family, email: account.identity?.email || null };
      // Uploaded files the user attached to this request, as project-relative paths.
      if (Array.isArray(input.attachments) && input.attachments.length) item.attachments = input.attachments.filter(a => typeof a === 'string');
      state.runs.push(item);
      state.queues[queueId] ||= { paused: false };
      // A queue the user merely stopped resumes when they send again; failures still need an explicit resume.
      if (state.queues[queueId].paused && state.queues[queueId].reason === 'stopped') state.queues[queueId] = { paused: false };
      state.messages.push(this._message(item, 'user', input.text));
      return item;
    });
    this._kick(projectId, run.queueId);
    return run;
  }

  // Deliver a message into the turn that is executing right now instead of queueing it.
  // Returns null when nothing is executing here, so the caller queues it normally.
  async _steer(projectId, input) {
    if (!input.sessionId || typeof input.text !== 'string' || !input.text.trim() || !input.requestId || input.attachments?.length) return null;
    if (this.steered?.has(input.requestId)) return this.steered.get(input.requestId);
    const state = await this.store.read(projectId);
    const current = state.runs.find(r => r.sessionId === input.sessionId && active(r.status) && r.hostId === this.hostId);
    if (!current || !this.runner.steer || parseCommand(input.text)) return null;
    if (current.profileId !== input.profileId || current.model !== input.model) throw error('This conversation is fixed to its machine, account and model. Create a new conversation to change them.', 409);
    try { await this.runner.steer(this._sessionKey(projectId, current), input.text); }
    catch (e) { if (noActiveTurn(e)) return null; throw e; }
    const result = { ...current, steered: true };
    (this.steered ||= new Map()).set(input.requestId, result);
    if (this.steered.size > 500) this.steered.delete(this.steered.keys().next().value);
    return result;
  }

  // /clear: forget the native session so the next message starts a fresh one. Shared history
  // files are untouched; the agent re-reads them on demand like any new conversation.
  async _clear(projectId, input) {
    const run = await this.store.mutate(projectId, 'session.cleared', state => {
      if (inactive(state.project) || input.sessionId && inactive(state.sessions.find(s=>s.id===input.sessionId))) throw error('项目或对话已归档／删除，请先恢复',409);
      if (!input.requestId || typeof input.requestId !== 'string') throw error('requestId is required');
      const existing = state.runs.find(r => r.requestId === input.requestId);
      if (existing) return existing;
      if (!input.sessionId || !state.sessions.some(s => s.id === input.sessionId)) throw error('Session not found', 404);
      if (!input.profileId || !input.model) throw error('Agent and model are required');
      const bound = sessionBinding(state, input.sessionId);
      if (bound.hostId && bound.hostId !== this.hostId || bound.profileId && bound.profileId !== input.profileId) throw error('This conversation is fixed to its machine, account and model. Create a new conversation to change them.', 409);
      const queueId = `session:${input.sessionId}`;
      if (state.runs.some(r => r.queueId === queueId && (active(r.status) || r.status === 'queued'))) throw error('请先停止当前执行，再清空上下文', 409);
      const stamp = now();
      const item = { id: randomUUID(), requestId: input.requestId, queueId, sessionId: input.sessionId, text: input.text, command: { name: 'clear', args: '' }, profileId: input.profileId, model: input.model, hostId: this.hostId, status: 'succeeded', createdAt: stamp, startedAt: stamp, endedAt: stamp };
      delete state.nativeSessions[mappingKey(this.hostId, item)];
      state.runs.push(item);
      state.messages.push(this._message(item, 'user', input.text), { ...this._message(item, 'system', 'Context cleared. The next message starts a new native session.'), kind: 'status' });
      return item;
    });
    await this.runner.release?.(this._sessionKey(projectId, run));
    return run;
  }

  _assertRun(run) { if(run?.hostId!==this.hostId)throw error('Run belongs to another machine',409); }

  _message(run, role, text) {
    const result = { id: randomUUID(), runId: run.id, role, text: scrub(text), createdAt: now(), profileId: run.profileId };
    for (const field of ['sessionId', 'artifactId', 'annotationId']) if (run[field]) result[field] = run[field];
    if (role === 'user' && run.attachments?.length) result.attachments = [...run.attachments];
    return result;
  }

  _kick(projectId, queueId) {
    const key = `${projectId}:${queueId}`;
    if (this.closed || this.drains.has(key)) return;
    const drain = Promise.resolve().then(() => this._drain(projectId, queueId));
    this.drains.set(key, drain);
    let failed = false;
    drain.catch(e => { failed = true; this.lastError = e.message; }).finally(async () => {
      this.drains.delete(key);
      if (this.closed || failed) return;
      try {
        const s = await this.store.read(projectId);
        if (!s.queues[queueId]?.paused && !s.runs.some(r => r.queueId === queueId && active(r.status)) && s.runs.some(r => r.queueId === queueId && r.status === 'queued' && r.hostId === this.hostId)) this._kick(projectId, queueId);
      } catch (e) { this.lastError = e.message; }
    });
  }

  async _drain(projectId, queueId) {
    while (!this.closed) {
      const state = await this.store.read(projectId);
      if (inactive(state.project) || state.queues[queueId]?.paused || state.runs.some(r => r.queueId === queueId && active(r.status))) return;
      const next = state.runs.find(r => r.queueId === queueId && r.status === 'queued' && r.hostId === this.hostId);
      if (!next) return;
      if (next.sessionId && inactive(state.sessions.find(s=>s.id===next.sessionId))) return;
      if(next.sessionId&&state.sessions.find(s=>s.id===next.sessionId)?.profileId&&state.sessions.find(s=>s.id===next.sessionId)?.profileId!==next.profileId){
        await this.store.mutate(projectId,'run.profile-conflict',s=>{const r=s.runs.find(r=>r.id===next.id);r.status='failed';r.error='此旧排队消息的账号与对话绑定不一致，请在新对话发送。';r.endedAt=now();s.queues[queueId]={paused:true,reason:r.error};});return;
      }
      await this._execute(projectId, next.id);
    }
  }

  async _execute(projectId, runId) {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const live = { projectId, runId, assistantId: randomUUID(), events: [], seq: 0, queuedUpto: 0, chars: 0, next: null, timer: undefined, tail: Promise.resolve() };
    // Commits are serialized; a failed commit rejects the tail and fails the run, as before.
    const commit = () => {
      clearTimeout(live.timer); live.timer = undefined;
      const upto = live.events.at(-1)?.seq ?? 0;
      if (upto <= live.queuedUpto) return live.tail;
      const waiting = live.next; live.next = null; live.queuedUpto = upto; live.chars = 0;
      live.tail = live.tail
        .then(() => this.store.mutate(projectId, 'run.output', s => this._applyOutput(s, live, upto)))
        .then(() => { live.events = live.events.filter(e => e.seq > upto); waiting?.resolve(); }, e => { waiting?.reject(e); throw e; });
      live.tail.catch(() => {});
      return live.tail;
    };
    try {
      const run = await this.store.mutate(projectId, 'run.started', state => {

        const item = state.runs.find(r => r.id === runId);
        this._assertRun(item);
        if (item.status !== 'queued' || this.closed || state.queues[item.queueId]?.paused) return null;
        item.status = 'running'; item.startedAt = now();
        state.messages.push(this._message(item, 'system', '正在处理。'));
        return item;
      });
      if (!run) return;
      const state = await this.store.read(projectId);
      const nativeSessionId = state.nativeSessions[mappingKey(this.hostId, run)];
      // Slash commands go to the CLI verbatim: no platform prompt, no attachment notes.
      const knowledge = run.command || !this.knowledge ? null : await Promise.resolve().then(() => this.knowledge(run)).catch(() => null);
      const {prompt, metadata} = run.command ? {prompt: run.text, metadata: {version:1, mode:'command', promptChars: run.text.length}} : buildContext(state, run, nativeSessionId, this.hostId, knowledge);
      const previousUsage = state.runs.findLast(r => r.id !== run.id && r.hostId === this.hostId && r.profileId === run.profileId && r.queueId === run.queueId && r.nativeSessionId === nativeSessionId && r.usage?.sessionTotal)?.usage?.sessionTotal;
      await this.store.mutate(projectId, 'run.context', s => { s.runs.find(r => r.id === runId).context = metadata; });
      this.live.set(runId, live);
      // Runners emit without awaiting. The returned promise settles when the event is durable.
      const onEvent = event => {
        if (this.closed || controller.signal.aborted || !['text', 'tool', 'status', 'reply', 'steer', 'narration'].includes(event?.type)) return Promise.resolve();
        const text = typeof event.text === 'string' ? event.text : '';
        if ((event.type === 'text' || event.type === 'steer') && !text) return Promise.resolve();
        const item = { type: event.type, text, raw: event.raw, seq: ++live.seq, at: now() };
        if (event.type !== 'text') item.id = randomUUID();
        if (['steer', 'tool', 'narration'].includes(event.type)) item.assistantId = randomUUID();
        live.events.push(item); live.chars += text.length;
        live.next ||= deferred();
        const durable = live.next.promise;
        // Native session identity must survive a crash, so it is committed at once; so is a
        // steered user message, which the sender expects to see in the conversation right away.
        if (event.type === 'reply' || event.type === 'steer' || event.type === 'status' && event.raw || live.chars > this.outputBufferChars) commit();
        else live.timer ||= setTimeout(commit, this.outputCommitMs);
        this._liveNotify(projectId);
        return durable;
      };
      const onApproval = async (request,requestSignal=controller.signal) => {
        await commit();
        return this.approvals.request(projectId,runId,request,AbortSignal.any([controller.signal,requestSignal]));
      };
      const result = await this.runner.execute({ cwd: state.project.path, prompt, profileId: run.profileId, model: run.model, reasoningEffort: run.reasoningEffort, permissionMode: run.permissionMode ?? 'auto', nativeSessionId, previousUsage, sessionKey: this._sessionKey(projectId, run), command: run.command, onEvent, onApproval, signal: controller.signal });
      await commit();
      await this.store.mutate(projectId, 'run.finished', s => {
        const item = s.runs.find(r => r.id === runId);
        if (item.status !== 'running') return;
        let stopped = false;
        if (item.hostId !== this.hostId) {
          item.status = 'interrupted'; item.error = 'Project ownership changed during execution';
        } else if (this.closed || controller.signal.aborted) {
          item.status = this.closed ? 'interrupted' : 'cancelled';
        } else if (result.status === 'interrupted') {
          // Stopped by the user; the native session is intact and later messages continue it.
          item.status = 'cancelled'; stopped = true;
        } else if (result.status === 'waiting') {
          item.status = 'waiting'; item.error = scrub(result.error || 'CLI requires user input or approval; cancel this run and submit a continuation after completing the required action.');
        } else if (result.error) {
          item.status = 'failed'; item.error = scrub(result.error);
        } else item.status = 'succeeded';
        rememberNative(s, item, this.hostId, result);
        if (result.usage) item.usage = result.usage;
        if (result.runtime) item.nativeRuntime = result.runtime;
        // The final text replaces the last streamed segment (the one after the latest steer or
        // tool call). A transport that reports the whole turn's text instead (an interrupted
        // turn) matches the segments already, so they stay as streamed.
        const segments = s.messages.filter(m => m.runId === runId && m.role === 'assistant' && m.kind !== 'background_reply');
        const message = segments.at(-1)?.kind === 'narration' ? null : segments.at(-1);
        const steeredAt = s.messages.findLast(m => m.runId === runId && m.kind === 'steer')?.createdAt || '';
        const squash = value => value.replace(/\s+/g, ''), turn = squash(segments.filter(m => m.createdAt > steeredAt).map(m => m.text).join(''));
        if (result.text && (!turn || squash(scrub(result.text)) !== turn)) {
          if (message) { if (message.text !== scrub(result.text)) message.progressText = message.text; message.text = scrub(result.text); }
          else s.messages.push(this._message(item, 'assistant', result.text));
        }
        if (item.status !== 'waiting') item.endedAt = now();
        markUnread(s, item);
        if (stopped) {
          // Hold later queued messages until the user decides; a plain stop needs no resume click.
          const pending = s.runs.some(r => r.queueId === item.queueId && r.status === 'queued');
          s.queues[item.queueId] = pending ? { paused: true, reason: 'stopped' } : { paused: false };
          s.messages.push({ ...this._message(item, 'system', 'Stopped.'), kind: 'status' });
        } else {
          if (item.status !== 'succeeded') s.queues[item.queueId] = { paused: true, reason: item.error || item.status };
          s.messages.push(this._message(item, 'system', item.status === 'succeeded' ? '处理完成。' : item.error || item.status));
        }
      });
      this.titles.schedule(projectId, runId);
    } catch (e) {
      await commit().catch(() => {});
      await this.store.mutate(projectId, 'run.failed', s => {
        const run = s.runs.find(r => r.id === runId);
        if (!run || !active(run.status)) return;
        run.status = this.closed ? 'interrupted' : controller.signal.aborted || e.name === 'AbortError' ? 'cancelled' : 'failed';
        run.error = scrub(e.message); run.endedAt = now();
        s.queues[run.queueId] = { paused: true, reason: run.error };
        s.messages.push(this._message(run, 'system', run.error));
        markUnread(s, run);
      });
    } finally { clearTimeout(live.timer); live.timer = undefined; this.live.delete(runId); this.controllers.delete(runId); await this.approvals.expire(projectId,runId); }
  }

  // Stop like Esc in the CLIs: the current turn ends, the process and native session stay.
  // A queued message is simply withdrawn. Without a resident turn to interrupt (older
  // transport, boot in progress) this falls back to the hard cancel.
  async interrupt(projectId, runId) {
    const state = await this.store.read(projectId);
    const run = state.runs.find(r => r.id === runId);
    if (!run) throw error('Run not found', 404);
    this._assertRun(run);
    if (run.status === 'queued') {
      return this.store.mutate(projectId, 'run.cancelled', s => {
        const item = s.runs.find(r => r.id === runId);
        if (item.status === 'queued') { item.status = 'cancelled'; item.endedAt = now(); s.messages.push({ ...this._message(item, 'system', 'Queued message withdrawn.'), kind: 'status' }); }
        return item;
      });
    }
    if (!active(run.status)) return run;
    if (!this.runner.interrupt) return this.cancel(projectId, runId);
    try { await this.runner.interrupt(this._sessionKey(projectId, run)); }
    catch (e) { if (!noActiveTurn(e)) throw e; return this.cancel(projectId, runId); }
    return run;
  }

  async cancel(projectId, runId) {
    const result = await this.store.mutate(projectId, 'run.cancelled', s => {

      const run = s.runs.find(r => r.id === runId);
      if (!run) throw error('Run not found', 404);
      this._assertRun(run);
      if (run.status === 'queued' || active(run.status)) {
        run.status = 'cancelled'; run.endedAt = now();
        s.queues[run.queueId] = { paused: true, reason: 'Cancelled by user' };
        s.messages.push(this._message(run, 'system', '已取消。队列已暂停。'));
      }
      return run;
    });
    this.controllers.get(runId)?.abort();
    return result;
  }

  async continueWaiting(projectId,runId) {
    const next=await this.store.mutate(projectId,'run.continued',s=>{

      const old=s.runs.find(r=>r.id===runId);
      if(!old)throw error('Run not found',404);
      this._assertRun(old);
      if(old.continuationId)return s.runs.find(r=>r.id===old.continuationId);
      if(inactive(s.project)||old.sessionId&&inactive(s.sessions.find(x=>x.id===old.sessionId)))throw error('请先恢复项目和对话',409);
      if(old.status!=='waiting'||old.approvals?.some(a=>a.status==='pending')||this.controllers.has(runId))throw error('仅能继续已结束的旧版等待任务',409);
      if(old.sessionId&&s.sessions.find(x=>x.id===old.sessionId)?.profileId!==old.profileId)throw error('此旧任务的账号与当前对话绑定不一致，请在新对话接续。',409);
      old.status='cancelled';old.endedAt=now();
      const item={id:randomUUID(),continuationOf:runId,requestId:`continue:${runId}`,queueId:old.queueId,profileId:old.profileId,model:old.model,reasoningEffort:old.reasoningEffort,permissionMode:'auto',hostId:this.hostId,status:'queued',createdAt:now(),text:`上次执行因权限请求无法交互而结束。请先检查当前文件，只继续尚未完成的部分，避免重复已完成操作。原请求：\n${old.text}`};
      for(const key of ['sessionId','artifactId','annotationId'])if(old[key])item[key]=old[key];
      if(old.attachments?.length)item.attachments=[...old.attachments];
      old.continuationId=item.id;
      s.runs.splice(s.runs.indexOf(old)+1,0,item);s.messages.push(this._message(item,'user',item.text));s.queues[item.queueId]={paused:false};
      return item;
    });
    this._kick(projectId,next.queueId);return next;
  }

  async resume(projectId, queueId) {
    await this.store.mutate(projectId, 'queue.resumed', s => {

      this._assertRun(s.runs.findLast(r=>r.queueId===queueId));
      if (!s.queues[queueId]) throw error('Queue not found', 404);
      if (s.runs.some(r => r.queueId === queueId && r.status === 'waiting')) throw error('A run is waiting for CLI input. Cancel it, complete the requested local action, and submit a continuation; it cannot be replayed safely.', 409);
      s.queues[queueId] = { paused: false };
    });
    this._kick(projectId, queueId);
    return { queueId, paused: false };
  }

  async close({ timeoutMs = 8000 } = {}) {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const timer of this.liveTimers.values()) clearTimeout(timer);
    this.liveTimers.clear();
    this.closing = (async () => {
      for (const controller of this.controllers.values()) controller.abort();
      let timer;
      const completed = await Promise.race([
        Promise.allSettled([...this.drains.values()]).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
      clearTimeout(timer);
      await this.titles.close();
      await this.runner.close?.();
      if (completed) return { pendingCancellation: false };
      this.lastError = 'CLI cancellation did not finish before shutdown timeout. Verify native processes before restarting work.';
      for (const project of await this.store.listProjects()) {
        if (project.unavailable) continue;
        await this.store.mutate(project.id, 'queue.shutdown-timeout', s => {
          for (const run of s.runs.filter(r => r.hostId === this.hostId && active(r.status))) {
            run.status = 'interrupted'; run.error = this.lastError; run.endedAt = now();
            s.queues[run.queueId] = { paused: true, reason: run.error };
            s.messages.push(this._message(run, 'system', run.error));
          }
        });
      }
      return { pendingCancellation: true, error: this.lastError };
    })();
    return this.closing;
  }
}

