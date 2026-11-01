// Device allowlist (README「设备白名单」): this browser identifies itself with a secret it generated
// here and keeps in this origin's storage. The server stores only its hash and the name; the user
// approves the device once, in Settings on an approved device or on the server machine itself.
import { post } from './api.js';
import { t } from './i18n.js';

const KEY = 'studiolo.device';
// crypto.subtle and randomUUID need a secure context, which a plain-HTTP tailnet page is not.
const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
export function guessName() {
  const ua = navigator.userAgent || '';
  const platform = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : t('设备');
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [platform, browser].filter(Boolean).join(' · ');
}
export function identity() {
  let me = null;
  try { me = JSON.parse(localStorage.getItem(KEY)); } catch {}
  if (!me?.id || !me?.secret) { me = { id: hex(16), secret: hex(32), name: guessName() }; try { localStorage.setItem(KEY, JSON.stringify(me)); } catch {} }
  return me;
}
export function renameIdentity(name) { const me = identity(); me.name = name; try { localStorage.setItem(KEY, JSON.stringify(me)); } catch {} return me; }
export const login = () => { const me = identity(); return post('/api/device/login', { id: me.id, name: me.name, secret: me.secret }); };
// Resolves once this device is approved (the server has then set the session cookie), showing the
// waiting dialog meanwhile. A server that is down or a device that is revoked keeps being retried.
export async function ensureDevice() {
  let result = await login();
  if (result.status === 'approved') return result.device;
  const dialog = document.querySelector('#device-dialog');
  if (!dialog) throw Object.assign(new Error(t('此设备尚未获准访问')), { status: 401, code: 'device' });
  const name = dialog.querySelector('#device-name'), status = dialog.querySelector('#device-status'), code = dialog.querySelector('#device-fingerprint'), id = dialog.querySelector('#device-id');
  name.value = identity().name;
  name.onchange = () => { name.value = renameIdentity(name.value.trim() || guessName()).name; };
  const render = r => {
    code.textContent = r.device?.fingerprint || ''; id.textContent = r.device?.id || identity().id;
    status.textContent = r.status === 'revoked' ? t('此设备的访问已被吊销。在已获准的设备上恢复它，或删除后重新登记。') : t('等待批准…');
    status.classList.toggle('run-error', r.status === 'revoked'); name.disabled = r.status !== 'pending';
  };
  render(result); if (!dialog.open) dialog.showModal();
  return new Promise(resolve => {
    const tick = async () => {
      try { result = await login(); render(result); if (result.status === 'approved') { dialog.close(); resolve(result.device); return; } }
      catch (error) { status.textContent = t(error.message); status.classList.add('run-error'); }
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 3000);
  });
}
