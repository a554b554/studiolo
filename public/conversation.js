import { t } from './i18n.js';
// Older residents stored late public assistant text as tools. Project it without
// changing immutable history; the original remains available in the raw log.
function backgroundReply(message) {
  if (message.role === 'assistant' && message.kind === 'background_reply') return message;
  const prefix = 'Background native event: ';
  if (message.role !== 'system' || message.kind !== 'tool' || !message.text?.startsWith(prefix)) return null;
  const text = message.text.slice(prefix.length);
  if (!text.trim() || /^(Started |Native session · |Native request unavailable: )/.test(text)) return null;
  return {...message,role:'assistant',text,kind:'background_reply'};
}
// A presentation projection only: original messages and operation records remain intact.
// What an agent says between tool calls (narration) folds into the raw log with the tools, in
// the order it happened; replies show where they arrive, and the one an executing run is still
// writing is marked `streaming` (nothing has happened in that run since it began).
// A request that runs on a different model than the one before it is preceded by a `switch` marker.
// While a run executes its activity is `live`: it carries the reply being written (`stream`) so
// the page can show the work in order, and the reply joins the conversation when the run ends.
// `pending` are messages this page sent that the server has not recorded yet: they show at once,
// and a new turn is followed by a live placeholder until its run records something. A `slot`
// (the request id) keys both, so the recorded message and run take their place without a jump.
export function conversationItems(messages, runs = [], pending = []) {
  const result = [], emitted = new Set(), streams = new Map(), embedded = new Set();
  const reply = message => ({kind:'message',message,...(streams.get(message.runId) === message.id ? {streaming:true} : {})});
  const placeholder = request => ({kind:'activity',key:`pending:${request.requestId}`,slot:request.requestId,activity:[],status:'running',live:true,since:request.createdAt,agent:request.agent});
  const waiting = new Map(pending.filter(request => request.placeholder).map(request => [request.requestId, request]));
  let model = null;
  for (const message of messages) {
    if (message.role === 'user') {
      const run = message.kind === 'steer' ? null : runs.find(r => r.id === message.runId);
      if (run?.model) { if (model && run.model !== model) result.push({kind:'switch',key:message.id,model:run.model,profileId:run.profileId}); model = run.model; }
      result.push({kind:'message',message,...(run?.requestId ? {slot:run.requestId} : {})});
      const request = run && waiting.get(run.requestId);
      if (request && ['queued','running'].includes(run.status) && !messages.some(m => m.runId === run.id && m.role !== 'user')) result.push(placeholder(request));
      continue;
    }
    const background = backgroundReply(message);
    if (background) { result.push({kind:'message',message:background}); continue; }
    const key = message.runId || message.id;
    const run = runs.find(r => r.id === message.runId);
    const shown = message.role === 'assistant' && message.kind !== 'narration';
    if (emitted.has(key)) {
      if (shown && !embedded.has(message.id)) result.push(reply(message));
      continue;
    }
    emitted.add(key);
    const group = messages.filter(m => (m.runId || m.id) === key && m.role !== 'user');
    const answers = group.filter(m => m.role === 'assistant' && m.kind !== 'background_reply');
    const activity = group.filter(m => m.role === 'system' || m.kind === 'narration');
    for (const answer of answers) if (answer.progressText) activity.push({...answer,text:answer.progressText});
    // Stable sort; a record without a time (the run error below) stays last.
    activity.sort((a,b) => (a.createdAt || '￿') < (b.createdAt || '￿') ? -1 : (a.createdAt || '￿') > (b.createdAt || '￿') ? 1 : 0);
    const current = run?.status === 'running' ? answers.filter(m => m.kind !== 'narration').at(-1) : null;
    if (current && !messages.some(m => m.runId === key && ['tool','steer','narration'].includes(m.kind) && m.createdAt > current.createdAt)) streams.set(key, current.id);
    if (run?.error && !activity.some(m => m.text === run.error)) activity.push({role:'system',text:run.error});
    const live = ['running','waiting'].includes(run?.status);
    // After a steer the reply belongs below the steered message, so it streams there instead.
    const stream = live && activity.length && streams.has(key) && !messages.some(m => m.runId === key && m.kind === 'steer') ? group.find(m => m.id === streams.get(key)) : null;
    if (stream) embedded.add(stream.id);
    if (activity.length) result.push({kind:'activity',key,activity,status:run?.status,replying:streams.has(key),...(live ? {live:true,stream} : {}),...(run?.requestId ? {slot:run.requestId} : {})});
    if (run?.error) result.push({kind:'notice',key,text:run.error});
    if (shown && !embedded.has(message.id)) result.push(reply(message));
  }
  for (const request of pending) {
    if (recorded(request, messages, runs)) continue;
    result.push({kind:'message',slot:request.requestId,message:{id:`pending:${request.requestId}`,role:'user',text:request.text,createdAt:request.createdAt,...(request.steer ? {kind:'steer'} : {}),...(request.attachments?.length ? {attachments:request.attachments} : {}),pending:request.failed ? 'failed' : 'sending',requestId:request.requestId}});
    if (request.placeholder && !request.failed) result.push(placeholder(request));
  }
  return result;
}
// Whether the server has recorded a message sent from this page: its run exists, or (a steer,
// which joins the executing run) one more steer with its text appeared than when it was sent.
export const steerCount = (messages, request) => messages.filter(m => m.kind === 'steer' && m.sessionId === request.sessionId && m.text?.trim() === request.text.trim()).length;
export function recorded(request, messages, runs) {
  return runs.some(run => run.requestId === request.requestId) || Boolean(request.steer && request.sentAt && steerCount(messages, request) > (request.steers || 0));
}

export function runNotice(text) {
  if (/Permission or user input required|CLI requires user input/i.test(text || '')) return t('旧版 CLI 调用已结束，无法补交批准。点击“用自动审核继续”可在新执行中接续未完成的工作。新执行的批准请求可直接在网页处理。');
  return String(text || '').split('\n')[0].slice(0,220);
}
// Accounts known to the page (every host's profiles), so an account id reads as its name.
const directory = new Map();
export function setAccountDirectory(hosts = []) {
  directory.clear();
  for (const host of hosts) for (const profile of host.profiles || []) directory.set(profile.id, { label: profile.label || profile.id, family: profile.family, email: profile.identity?.email || null, model: profile.models });
}
export const familyName = family => family === 'codex' ? 'Codex' : family === 'claude' ? 'Claude' : '';
// Display name of the account behind a run or message: the run's own snapshot first (accounts can
// be renamed or removed later), then the live directory, then the raw id.
export function accountName(profileId, run) {
  const known = run?.account || directory.get(profileId);
  return known?.label || profileId || 'Agent';
}
const modelNames = {'claude-fable-5-1':'Fable 5.1','claude-opus-5-5':'Opus 5.5','claude-sonnet-5-5':'Sonnet 5.5','claude-haiku-4-5-20251001':'Haiku 4.5'};
// Display name of a model: known names first, then the label its account's machine reports.
export function modelName(model, profileId) {
  return modelNames[model] || directory.get(profileId)?.model?.find(m => m.id === model)?.label || model;
}
export function agentLabel(message, run = {}) {
  const model = run.actualModel || run.model || message.model;
  return [accountName(message.profileId || run.profileId, run), modelName(model, message.profileId || run.profileId), run.actualReasoningEffort || run.reasoningEffort || t('effort: CLI 默认')].filter(Boolean).join(' · ');
}
