// Conversation drafts follow the user to other devices. view.drafts stays the tab's
// working copy; the text is saved to the conversation 2 s after typing stops, on blur and when
// leaving the conversation. A conversation that is opened, or whose window comes back into
// view, takes the server's copy when it is newer than the tab's last edit there.
import { api, projectURL } from './api.js';
import { view } from './state.js';

const IDLE = 2000;
const saved = new Map(), edited = new Map(), timers = new Map();
let chain = Promise.resolve();
const parts = key => { const [projectId, sessionId] = key.split(':'); return sessionId && sessionId !== 'null' ? { projectId, sessionId } : null; };
const url = ({ projectId, sessionId }) => `${projectURL(projectId)}/sessions/${encodeURIComponent(sessionId)}/draft`;

// Saves are sent one at a time, so an older text never lands after a newer one.
function save(key) {
  clearTimeout(timers.get(key)); timers.delete(key);
  const target = parts(key), text = view.drafts.get(key) ?? '';
  if (!target || (saved.get(key) ?? '') === text) return chain;
  saved.set(key, text);
  chain = chain.then(() => api(url(target), { method: 'PUT', body: { text } })).catch(() => { if (saved.get(key) === text) saved.delete(key); });
  return chain;
}
export function draftEdited(key) {
  edited.set(key, Date.now());
  clearTimeout(timers.get(key)); timers.set(key, setTimeout(() => save(key), IDLE));
}
export const flushDraft = key => save(key);
// A sent message leaves no draft behind, here or on the server.
export function draftSent(key) { view.drafts.delete(key); edited.set(key, Date.now()); save(key); }

// Takes the server's copy when it is newer than the tab's last edit and nothing is waiting to be
// saved; returns whether the tab's text changed.
export function adoptDraft(key, remote) {
  if (!remote || typeof remote.text !== 'string' || timers.has(key)) return false;
  const at = Date.parse(remote.at) || 0;
  if (at <= (edited.get(key) || 0)) return false;
  edited.set(key, at); saved.set(key, remote.text);
  if ((view.drafts.get(key) ?? '') === remote.text) return false;
  view.drafts.set(key, remote.text); return true;
}
// Asks the server for the conversation's current draft (the loaded project may be older).
export async function refreshDraft(key, apply) {
  const target = parts(key); if (!target) return;
  const remote = await api(url(target)).catch(() => null);
  if (adoptDraft(key, remote)) apply(view.drafts.get(key));
}
