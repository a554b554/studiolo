// A failed connection (server restarting, network gone) reads as a plain sentence, not "Failed to fetch".
const unreachable = error => Object.assign(new Error('无法连接服务器，它可能正在重启；请稍后重试'), { status: 0, cause: error });
export async function api(path, options = {}) {
  const headers = { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
  const response = await fetch(path, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }).catch(error => { if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error; throw unreachable(error); });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return data;
}
export const post = (path, body = {}) => api(path, { method: 'POST', body });
// One raw request per file; the server names the stored copy and returns its project path.
export async function upload(path, file, name = file.name) {
  const response = await fetch(`${path}?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }).catch(error => { throw unreachable(error); });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return data;
}
export const projectURL = id => `/api/projects/${encodeURIComponent(id)}`;
export const requestId = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
