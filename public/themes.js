import { t, onLanguageChange } from './i18n.js';
// Presentation preferences only. No project or application state is touched.
// "system" follows the OS light/dark setting; the retired Brutalist and OLED themes map onto it.
export const themes = Object.freeze([{ id: 'system', label: '跟随系统' }, { id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }]);
const legacy = { brutal: 'system', oled: 'dark' };
export function setTheme(id) {
  const selected = themes.find(theme => theme.id === (legacy[id] || id)) || themes[0];
  document.documentElement.dataset.theme = selected.id;
  document.querySelectorAll('[data-theme-picker]').forEach(picker => { picker.value = selected.id; });
  try { localStorage.setItem('studio-theme', selected.id); } catch {}
}
export function initTheme() {
  document.querySelectorAll('[data-theme-picker]').forEach(picker => {
    themes.forEach(theme => picker.add(new Option(t(theme.label), theme.id)));
    picker.addEventListener('change', () => setTheme(picker.value));
  });
  onLanguageChange(() => document.querySelectorAll('[data-theme-picker] option').forEach(option => { option.textContent = t(themes.find(theme => theme.id === option.value)?.label || option.value); }));
  let initial = 'system';
  try { initial = localStorage.getItem('studio-theme') || initial; } catch {}
  setTheme(initial);
}
