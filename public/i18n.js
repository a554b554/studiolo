import {english} from './translations.js';

const storageKey = 'studio-interface-language';
let language = 'zh-CN';
try { if (globalThis.localStorage?.getItem(storageKey) === 'en') language = 'en'; } catch {}
export const getLanguage = () => language;
// Only explicitly marked platform copy is translated. Parameters are opaque user data.
export function t(key, params = {}) {
  const template = language === 'en' && Object.hasOwn(english,key) ? english[key] : key;
  return template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params,name) ? String(params[name]) : match);
}
export function localize(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  for (const attr of ['aria-label','placeholder','title','alt']) {
    root.querySelectorAll(`[data-i18n-${attr}]`).forEach(el => el.setAttribute(attr,t(el.getAttribute(`data-i18n-${attr}`))));
  }
}
export function onLanguageChange(fn) { globalThis.addEventListener?.('studio:language',fn); }
export function setLanguage(value, persist = true) {
  language = value === 'en' ? 'en' : 'zh-CN';
  if (persist) try { localStorage.setItem(storageKey,language); } catch {}
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
  localize();
  document.querySelectorAll('[data-language-picker]').forEach(el => { el.value = language; });
  window.dispatchEvent(new Event('studio:language'));
}
export function initLanguage() {
  document.querySelectorAll('[data-language-picker]').forEach(el => el.addEventListener('change',()=>setLanguage(el.value)));
  setLanguage(language,false);
  window.addEventListener('storage',event => { if (event.key === storageKey || event.key === null) setLanguage(event.newValue,false); });
}
