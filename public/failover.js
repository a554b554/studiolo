import { t } from './i18n.js';

// When the server this page talks to stops answering, move to another server it knows.
// Every server shows the same replicated projects, so the page reopens there
// with the same conversation and its unsent draft, carried in the URL fragment (never sent to a
// server, and cleared on arrival). The switch happens by itself after a short countdown the user may
// cancel; while a message is still on its way to the old server it is only offered, so nothing is
// sent twice or lost. The list of servers is remembered per browser, so it survives a reload against
// a dead server's cache. The page that arrived says so and offers the way back once the old one answers.
const KEY = 'studiolo.servers';
const COUNTDOWN = 5;
const remembered = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const identity = async (url, timeout = 3000) => { const res = await fetch(new URL('/api/identity', url), { signal: AbortSignal.timeout(timeout) }); return res.json(); };

// Read once, before the page picks its conversation: what the previous server's page handed over.
export function takeArrival() {
  if (!location.hash.startsWith('#from=')) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  return { from: params.get('from'), name: params.get('name') || '', url: params.get('url') || '', back: params.get('why') === 'back', projectId: params.get('project') || null, sessionId: params.get('session') || null, draft: params.get('draft') || '' };
}

export function initFailover({ hosts, selfId, carry = () => ({}), busy = () => false, arrival = null }) {
  const status = document.querySelector('#connection');
  let downSince = null, banner = null, probing = false, timer = null, declined = false;
  const save = () => { try { const list = hosts().filter(h => h.url).map(({ id, name, url }) => ({ id, name, url })); if (list.length) localStorage.setItem(KEY, JSON.stringify(list)); } catch {} };
  const close = () => { clearInterval(timer); timer = null; banner?.remove(); banner = null; };
  // `why` is failover (this server stopped answering) or back (returning to one that recovered).
  const target = (host, why = 'failover') => {
    // The server being left also says its name and address: the next one lists only servers that answer.
    const self = hosts().find(h => h.id === selfId());
    const { projectId, sessionId, draft } = carry(), params = new URLSearchParams({ from: selfId() || '', why, name: self?.name || '', url: self?.url || location.origin });
    if (projectId) params.set('project', projectId); if (sessionId) params.set('session', sessionId); if (draft) params.set('draft', draft);
    return new URL('/#' + params, host.url).href;
  };
  const show = (...parts) => {
    close(); banner = document.createElement('div'); banner.className = 'failover'; banner.setAttribute('role', 'alert');
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'quiet'; dismiss.textContent = '×'; dismiss.setAttribute('aria-label', t('关闭'));
    dismiss.onclick = () => { declined = true; close(); };
    banner.append(...parts, ' ', dismiss); document.body.append(banner); return banner;
  };
  const link = (text, href) => { const a = document.createElement('a'); a.textContent = text; a.href = href; return a; };
  async function offer() {
    if (probing || banner || declined) return;
    probing = true;
    try {
      const known = new Map([...remembered(), ...hosts()].filter(h => h.url && h.id !== selfId()).map(h => [h.id, h]));
      const online = (await Promise.all([...known.values()].map(async host => { try { return (await identity(host.url)).hostId === host.id ? host : null; } catch { return null; } }))).filter(Boolean);
      if (!online.length || status?.dataset.online !== 'false' || banner) return;
      if (busy()) {
        show(t('当前服务器无响应。切换到：'), ...online.flatMap(host => [' ', link(host.name || host.id, target(host))]));
        return;
      }
      const host = online[0], name = host.name || host.id;
      let left = COUNTDOWN; const text = document.createTextNode('');
      const tick = () => { text.textContent = t('当前服务器无响应，{seconds} 秒后切换到 {name}。', { seconds: left, name }); };
      const go = document.createElement('button'); go.type = 'button'; go.textContent = t('立即切换'); go.onclick = () => location.assign(target(host));
      const stay = document.createElement('button'); stay.type = 'button'; stay.className = 'quiet'; stay.textContent = t('留在这里'); stay.onclick = () => { declined = true; close(); };
      tick(); show(text, ' ', go, ' ', stay);
      timer = setInterval(() => {
        if (status?.dataset.online !== 'false') { close(); return; }
        if (--left <= 0) { close(); if (!busy()) location.assign(target(host)); return; }
        tick();
      }, 1000);
    } finally { probing = false; }
  }
  const check = () => {
    const online = status?.dataset.online !== 'false';
    // Back online: forget a declined switch, so the next outage offers again.
    if (online) { downSince = null; declined = false; if (timer) close(); else if (banner && !banner.dataset.arrival) close(); save(); return; }
    downSince ??= Date.now();
    if (Date.now() - downSince > 8000) offer();
  };
  if (status) new MutationObserver(check).observe(status, { attributes: true, attributeFilter: ['data-online'] });
  setInterval(check, 3000);
  save();
  if (arrival?.from && !arrival.back) welcome(arrival);

  // Arrived from a server that stopped answering: say so, and offer the way back once it answers again.
  function welcome({ from: fromId, name: carriedName, url: carriedUrl }) {
    const known = [...remembered(), ...hosts()].find(h => h.id === fromId);
    const from = { id: fromId, name: known?.name || carriedName, url: known?.url || carriedUrl }, name = from.name || t('原服务器');
    const note = show(t('{name} 没有响应，已切换到这台服务器。', { name }));
    note.dataset.arrival = 'true'; note.setAttribute('role', 'status');
    if (!from?.url) return;
    const watch = setInterval(async () => {
      if (banner !== note) { clearInterval(watch); return; }
      try {
        if ((await identity(from.url, 5000)).hostId !== fromId) return;
        clearInterval(watch);
        note.firstChild.replaceWith(document.createTextNode(t('{name} 已恢复。', { name }) + ' '), link(t('切回 {name}', { name }), target(from, 'back')));
      } catch {}
    }, 15000);
  }
}
