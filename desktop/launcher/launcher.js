// Server list of the desktop client. Each server answers /api/identity to other origins with
// its id and name (src/server.mjs), so the list shows which are online; opening one loads that
// server's own web UI in this window. "?choose=1" (tray: Switch server…) skips the auto-open.
const KEY = 'studiolo.desktop.servers', LAST = 'studiolo.desktop.last';
const DEFAULTS = ['http://127.0.0.1:4310'];
const $ = selector => document.querySelector(selector);
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const store = list => localStorage.setItem(KEY, JSON.stringify(list));
const choosing = new URLSearchParams(location.search).has('choose');
let servers = load(), status = new Map(), opened = false;

async function probe(url) {
  try {
    const res = await fetch(new URL('/api/identity', url), { signal: AbortSignal.timeout(3000) });
    const info = await res.json();
    return info.protocol === 2 && info.hostId ? info : null;
  } catch { return null; }
}
function open(server) {
  opened = true;
  localStorage.setItem(LAST, server.url);
  location.replace(server.url);
}
function render() {
  const list = $('#servers'); list.replaceChildren();
  if (!servers.length) { const empty = document.createElement('li'); empty.className = 'muted'; empty.textContent = '还没有服务器。输入一台运行 Studiolo 的电脑的地址。'; list.append(empty); }
  for (const server of servers) {
    const info = status.get(server.url), item = document.createElement('li');
    const dot = document.createElement('span'); dot.className = 'dot' + (info ? ' online' : ''); dot.title = info ? '在线' : status.has(server.url) ? '离线' : '检查中';
    const who = document.createElement('div'); who.className = 'who';
    const name = document.createElement('strong'); name.textContent = info?.name || server.name || server.url;
    const address = document.createElement('span'); address.textContent = server.url + (info || !status.has(server.url) ? '' : ' · 离线');
    who.append(name, address);
    const go = document.createElement('button'); go.className = 'primary'; go.textContent = '打开'; go.disabled = !info; go.onclick = () => open(server);
    const remove = document.createElement('button'); remove.className = 'quiet'; remove.textContent = '移除'; remove.setAttribute('aria-label', `移除 ${server.url}`);
    remove.onclick = () => { servers = servers.filter(s => s.url !== server.url); store(servers); render(); };
    item.append(dot, who, go, remove); list.append(item);
  }
}
// While the list is empty, offer a server on this computer as soon as one answers.
async function addDefaults() {
  for (const url of DEFAULTS) { const info = await probe(url); if (info && !servers.length) { servers.push({ url, name: info.name, id: info.hostId }); store(servers); } }
}
async function refresh() {
  if (!servers.length) await addDefaults();
  await Promise.all(servers.map(async server => {
    const info = await probe(server.url);
    if (info) { status.set(server.url, info); if (server.name !== info.name || server.id !== info.hostId) { Object.assign(server, { name: info.name, id: info.hostId }); store(servers); } }
    else status.set(server.url, null);
  }));
  render();
  // Opens the last used server, else the first online one, unless the user came to choose.
  if (!choosing && !opened) {
    const last = servers.find(s => s.url === localStorage.getItem(LAST) && status.get(s.url)) || servers.find(s => status.get(s.url));
    if (last) open(last);
  }
}

$('#add').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('#error'); error.textContent = '';
  let url;
  try { url = new URL($('#url').value.trim()); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { error.textContent = '请输入 http:// 或 https:// 开头的地址。'; return; }
  const origin = url.origin;
  if (servers.some(s => s.url === origin)) { error.textContent = '已在列表中。'; return; }
  const info = await probe(origin);
  if (!info) { error.textContent = `${origin} 没有响应，或不是 Studiolo 服务器。`; return; }
  servers.push({ url: origin, name: info.name, id: info.hostId }); store(servers); status.set(origin, info);
  $('#url').value = ''; render();
});

render(); refresh();
setInterval(() => { if (!opened) refresh(); }, 4000);
