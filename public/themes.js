// Presentation preferences only. No project or application state is touched.
export const themes = Object.freeze([{ id: 'brutal', label: 'Brutalist' }, { id: 'oled', label: 'OLED' }]);
export function setTheme(id) {
  const selected = themes.find(theme => theme.id === id) || themes[0];
  document.documentElement.dataset.theme = selected.id;
  document.querySelectorAll('[data-theme-picker]').forEach(picker => { picker.value = selected.id; });
  try { localStorage.setItem('studio-theme', selected.id); } catch {}
}
export function initTheme() {
  document.querySelectorAll('[data-theme-picker]').forEach(picker => {
    themes.forEach(theme => picker.add(new Option(theme.label, theme.id)));
    picker.addEventListener('change', () => setTheme(picker.value));
  });
  let initial = 'brutal';
  try { initial = localStorage.getItem('studio-theme') || initial; } catch {}
  setTheme(initial);
}
