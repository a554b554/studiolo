import {httpError} from './paths.mjs';
import {inactive} from './lifecycle.mjs';

const defaults = new Set(['新会话', '新建会话', 'New conversation']);
export const needsTitle = session => Boolean(session && ((!session.titleSource && defaults.has(session.title)) || session.titleSource === 'pending'));
export function cleanTitle(value, limit = 60) {
  if (typeof value !== 'string') return '';
  return [...value.trim().split(/\r?\n/)[0].replace(/^(?:标题|Title)\s*[:：]\s*/i, '').replace(/^[#*`"“「]+|[*`"”」]+$/g, '').replace(/\s+/g, ' ').trim()].slice(0, limit).join('');
}
export async function renameSession(store, projectId, sessionId, title) {
  if (typeof title !== 'string' || !title.trim() || [...title.trim()].length > 120 || /[\r\n\x00-\x1f]/.test(title)) throw httpError('请输入 1–120 个字符的单行标题');
  return store.mutate(projectId, 'session.renamed', state => {
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) throw httpError('对话不存在', 404);
    if (inactive(state.project) || inactive(session)) throw httpError('请先恢复项目和对话', 409);
    session.title = title.trim(); session.titleSource = 'manual'; session.titleUpdatedAt = new Date().toISOString();
    return session;
  });
}

export class SessionTitles {
  constructor({store, runner, hostId}) { Object.assign(this, {store, runner, hostId}); this.jobs = new Map(); this.closed = false; }
  schedule(projectId, runId) {
    if (this.closed) return;
    const key = `${projectId}:${runId}`;
    if (this.jobs.has(key)) return;
    const controller = new AbortController();
    const promise = this.generate(projectId, runId, controller.signal).catch(() => {}).finally(() => this.jobs.delete(key));
    this.jobs.set(key, {controller, promise});
  }
  async generate(projectId, runId, signal) {
    const state = await this.store.read(projectId), run = state.runs.find(r => r.id === runId);
    const session = state.sessions.find(s => s.id === run?.sessionId);
    if (!needsTitle(session) || inactive(session) || inactive(state.project) || run?.hostId !== this.hostId || run?.status !== 'succeeded') return;
    if (state.runs.find(r => r.sessionId === session.id && r.status === 'succeeded')?.id !== runId) return;
    const user = state.messages.find(m => m.runId === runId && m.role === 'user')?.text || run.text;
    const assistant = state.messages.find(m => m.runId === runId && m.role === 'assistant' && m.kind !== 'narration')?.text || '';
    let title, usage;
    try {
      const result = await this.runner.summarizeTitle?.({cwd:state.project.path, profileId:run.profileId, model:run.model, user, assistant, signal:AbortSignal.any([signal, AbortSignal.timeout(45000)])});
      if (result?.error) throw new Error(result.error);
      title = cleanTitle(result?.text); usage = result?.usage;
    } catch { /* A failed title must never fail the user's answer. */ }
    if (signal.aborted || this.closed) return;
    const generated = Boolean(title);
    title ||= cleanTitle(user, 40) || '新会话';
    await this.store.mutate(projectId, 'session.titled', current => {
      const target = current.sessions.find(s => s.id === session.id);
      // A rename, deletion, archive or host takeover wins over a late summary.
      if (!needsTitle(target) || inactive(target) || inactive(current.project) || current.runs.find(r=>r.id===runId)?.hostId !== this.hostId) return;
      target.title = title; target.titleSource = generated ? 'auto' : 'fallback';
      target.titleUpdatedAt = new Date().toISOString();
      if (usage) target.titleUsage = usage;
    });
  }
  async close() { this.closed = true; for (const job of this.jobs.values()) job.controller.abort(); await Promise.allSettled([...this.jobs.values()].map(job => job.promise)); }
}
