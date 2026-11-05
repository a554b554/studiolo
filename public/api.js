// A failed connection (server restarting, network gone) reads as a plain sentence, not "Failed to fetch".
const unreachable = error => Object.assign(new Error('无法连接服务器，它可能正在重启；请稍后重试'), { status: 0, cause: error });
// A read with no answer for a minute (a connection dropped without closing, a laptop waking up) fails
// instead of hanging: a hung refresh would stop every later one. Writes set their own `timeout`.
const READ_TIMEOUT = 60000;
const timedOut = error => Object.assign(new Error('服务器长时间没有回应；请稍后重试'), { name: 'TimeoutError', status: 0, cause: error });
export async function api(path, options = {}) {
  const { renew = true, timeout = !options.method || options.method === 'GET' ? READ_TIMEOUT : 0, ...request } = options;
  const headers = { ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...request.headers };
  const signal = request.signal || (timeout ? AbortSignal.timeout(timeout) : undefined), stopped = error => error.name === 'AbortError' || error.name === 'TimeoutError';
  const response = await fetch(path, { ...request, signal, headers, body: request.body === undefined ? undefined : JSON.stringify(request.body) }).catch(error => { if (stopped(error)) throw request.signal ? error : timedOut(error); throw unreachable(error); });
  // A body cut off by the timeout is a failure, not an empty answer.
  const data = await response.json().catch(error => { if (stopped(error)) throw request.signal ? error : timedOut(error); return {}; });
  if (!response.ok) {
    // Device allowlist: a session lost to a server restart is renewed once with this device's own secret.
    if (response.status === 401 && data.code === 'device' && renew && path !== '/api/device/login') { const { login } = await import('./device.js'); const result = await login().catch(() => null); if (result?.status === 'approved') return api(path, { ...options, renew: false }); }
    const error = new Error(data.error || `HTTP ${response.status}`); error.status = response.status; error.data = data; if (data.code) error.code = data.code; throw error;
  }
  return data;
}
export const post = (path, body = {}) => api(path, { method: 'POST', body });
// A Studiolo page of server `hostId` (an Artifact window), signed in with a one-time ticket from that
// server (src/server.mjs, sign-in handoff): the default browser, or a server that browser never
// signed in to, needs no sign-in or approval of its own. Copied links carry no ticket.
export async function signedIn(hostId, href) {
  const page = new URL(href, location.href);
  try { const { ticket } = await post(`/api/hosts/${encodeURIComponent(hostId)}/handoff`); return new URL(`/api/handoff/${ticket}?next=${encodeURIComponent(page.pathname + page.search)}`, page.origin).href; }
  catch { return page.href; }
}
// Opens it in the default browser, or in a client window if Settings → 版本 says so (desktop/src-tauri,
// open_link). A browser tab keeps the click only until the first await, so it opens first, empty.
export async function openSignedIn(hostId, href) {
  const invoke = window.__TAURI__?.core?.invoke, tab = invoke ? null : window.open('', '_blank');
  const target = await signedIn(hostId, href);
  if (tab) { tab.opener = null; tab.location.href = target; return; }
  if (invoke) { try { await invoke('open_link', { url: target }); return; } catch {} }
  window.open(target, '_blank', 'noopener');
}
// Click handler for links to such pages; a modified click keeps the browser's own behaviour.
export const signedInClick = (hostId, link) => event => { if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); openSignedIn(hostId, link.href); };
// One raw request per file; the server names the stored copy and returns its project path.
export async function upload(path, file, name = file.name) {
  const response = await fetch(`${path}?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }).catch(error => { throw unreachable(error); });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return data;
}
export const projectURL = id => `/api/projects/${encodeURIComponent(id)}`;
export const requestId = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
