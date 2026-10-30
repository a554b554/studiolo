import { t } from './i18n.js';

// When the server this page talks to stops answering, offer the other servers it knows.
// Each serves the same replicated projects, so the page simply reopens there at the same path.
// The list is remembered per browser, so it survives a reload against a dead server's cache.
const KEY = 'studiolo.servers';
const remembered = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };

export function initFailover({ hosts, selfId }) {
  const status = document.querySelector('#connection');
  let downSince = null, banner = null, probing = false;
  const save = () => { try { const list = hosts().filter(h => h.url).map(({ id, name, url }) => ({ id, name, url })); if (list.length) localStorage.setItem(KEY, JSON.stringify(list)); } catch {} };
  const close = () => { banner?.remove(); banner = null; };
  async function offer() {
    if (probing || banner) return;
    probing = true;
    try {
      const known = new Map([...remembered(), ...hosts()].filter(h => h.url && h.id !== selfId()).map(h => [h.id, h]));
      const online = (await Promise.all([...known.values()].map(async host => {
        try { const res = await fetch(new URL('/api/identity', host.url), { signal: AbortSignal.timeout(3000) }); const info = await res.json(); return info.hostId === host.id ? host : null; } catch { return null; }
      }))).filter(Boolean);
      if (!online.length || status?.dataset.online === 'true') return;
      banner = document.createElement('div'); banner.className = 'failover'; banner.setAttribute('role', 'alert');
      banner.append(document.createTextNode(t('当前服务器无响应。切换到：')));
      for (const host of online) {
        const link = document.createElement('a'); link.textContent = host.name || host.id;
        link.href = new URL(location.pathname + location.search + location.hash, host.url).href;
        banner.append(' ', link);
      }
      const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'quiet'; dismiss.textContent = '×'; dismiss.setAttribute('aria-label', t('关闭')); dismiss.onclick = close;
      banner.append(' ', dismiss); document.body.append(banner);
    } finally { probing = false; }
  }
  const check = () => {
    const online = status?.dataset.online !== 'false';
    if (online) { downSince = null; close(); save(); return; }
    downSince ??= Date.now();
    if (Date.now() - downSince > 8000) offer();
  };
  if (status) new MutationObserver(check).observe(status, { attributes: true, attributeFilter: ['data-online'] });
  setInterval(check, 3000);
  save();
}
