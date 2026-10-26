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
export function conversationItems(messages, runs = []) {
  const result = [], emitted = new Set(), streams = new Map();
  const reply = message => ({kind:'message',message,...(streams.get(message.runId) === message.id ? {streaming:true} : {})});
  for (const message of messages) {
    if (message.role === 'user') { result.push({kind:'message',message}); continue; }
    const background = backgroundReply(message);
    if (background) { result.push({kind:'message',message:background}); continue; }
    const key = message.runId || message.id;
    const run = runs.find(r => r.id === message.runId);
    const shown = message.role === 'assistant' && message.kind !== 'narration';
    if (emitted.has(key)) {
      if (shown) result.push(reply(message));
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
    if (activity.length) result.push({kind:'activity',key,activity,status:run?.status,replying:streams.has(key)});
    if (run?.error) result.push({kind:'notice',key,text:run.error});
    if (shown) result.push(reply(message));
  }
  return result;
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
export function agentLabel(message, run = {}) {
  const model = run.actualModel || run.model || message.model;
  const names = {'claude-fable-5-1':'Fable 5.1','claude-opus-5-5':'Opus 5.5','claude-sonnet-5-5':'Sonnet 5.5','claude-haiku-4-5-20251001':'Haiku 4.5'};
  const known = run.account || directory.get(message.profileId || run.profileId);
  const modelLabel = names[model] || known?.model?.find(m => m.id === model)?.label || model;
  return [accountName(message.profileId || run.profileId, run), modelLabel, run.actualReasoningEffort || run.reasoningEffort || t('effort: CLI 默认')].filter(Boolean).join(' · ');
}
