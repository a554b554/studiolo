import { t, onLanguageChange } from './i18n.js';
import { api, projectURL, signedInClick } from './api.js';
import { $, node, icon, showError } from './ui.js';
import { markdown, isMarkdownPath } from './markdown.js';
// The side pane: files and Artifacts open as tabs next to the chat. Each project has its own tab
// set and remembers whether its pane is open (localStorage, per browser). Text files are edited in
// place and saved automatically 0.8 s after the last keystroke (Ctrl / ⌘ + S saves at once). Every
// save names the version it was based on; the server refuses it when the file changed meanwhile, and
// the open tab polls the file's version so changes made by an agent or another device show up.
const STORE = 'studio-tabs', MD_MODE = 'studio-md-mode', AUTOSAVE = 800, POLL = 3000;
const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
const fileIcon = path => IMAGE.test(path) ? 'i-image' : isMarkdownPath(path) || /\.(?:txt|log|csv)$/i.test(path) ? 'i-file-text' : /\.(?:m?js|ts|tsx|jsx|css|html?|json|py|sh|ps1|rs|go|java|c|cpp|h)$/i.test(path) ? 'i-file-code' : 'i-file';
const baseName = path => path.split('/').pop() || path;
const formatSize = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
const keyOf = spec => spec.kind === 'artifact' ? `artifact:${spec.artifactId}` : `file:${spec.path}`;
function loadSets() { try { const value = JSON.parse(localStorage.getItem(STORE) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }

export function initTabs({ panes, artifactName = () => '', artifactRunning = () => false, artifactHome = () => null, onActiveChange = () => {} }) {
  const sets = loadSets(), views = new Map();
  let projectId = null;
  const persist = () => { try { localStorage.setItem(STORE, JSON.stringify(sets)); } catch {} };
  const setOf = id => (sets[id] ||= { tabs: [], active: null, open: false });
  const viewKey = (pid, key) => `${pid}\n${key}`;
  const current = () => projectId ? setOf(projectId) : null;
  const activeView = () => { const set = current(); return set?.active ? views.get(viewKey(projectId, set.active)) : null; };

  // ---------- file editor ----------
  function fileView(pid, tab) {
    const path = tab.path, url = `${projectURL(pid)}/file?path=${encodeURIComponent(path)}`, raw = `${projectURL(pid)}/raw?path=${encodeURIComponent(path)}`;
    const el = node('div', 'pane-view file'), head = node('div', 'ed-head'), crumbs = node('div', 'crumbs'), status = node('span', 'save-state'), seg = node('div', 'seg');
    const banner = node('div', 'ed-banner'), bodyEl = node('div', 'ed-body'), foot = node('div', 'ed-foot');
    const code = node('div', 'code'), gutter = node('div', 'gutter'), area = node('textarea'), preview = node('div', 'md-preview markdown markdown-doc');
    area.spellcheck = false; area.setAttribute('autocomplete', 'off'); area.setAttribute('aria-label', path);
    banner.hidden = true; code.append(gutter, area); bodyEl.append(code, preview);
    const parts = path.split('/');
    parts.forEach((part, i) => { if (i) crumbs.append(node('span', 'sl', '/')); crumbs.append(i === parts.length - 1 ? node('b', '', part) : node('span', '', part)); });
    const markdownFile = isMarkdownPath(path), image = IMAGE.test(path);
    const modes = ['edit', 'split', 'preview'], modeButtons = modes.map(mode => { const b = node('button'); b.type = 'button'; b.dataset.mode = mode; b.addEventListener('click', () => setMode(mode)); return b; });
    seg.append(...modeButtons); seg.hidden = !markdownFile;
    head.append(crumbs, status, seg); el.append(head, banner, bodyEl, foot);
    const ed = { el, pid, tab, kind: 'file', version: undefined, base: '', state: 'loading', dirty: false, saving: false, timer: 0, conflictVersion: undefined, error: '', lines: 0, size: 0, savedAt: 0, external: 0 };
    let previewTimer;
    const renderPreview = () => {
      if (!markdownFile) return;
      const scroll = preview.scrollTop;
      preview.replaceChildren(markdown(area.value, document, { file: path, image: p => `${projectURL(pid)}/raw?path=${encodeURIComponent(p)}` }));
      preview.querySelectorAll('img').forEach(img => img.addEventListener('error', () => img.replaceWith(node('span', 'image-missing', '🖼 ' + img.alt)), { once: true }));
      preview.scrollTop = scroll;
    };
    function setMode(mode) { tab.mode = mode; try { localStorage.setItem(MD_MODE, mode); } catch {} persist(); paint(); if (mode !== 'edit') renderPreview(); }
    const gutterText = () => { const count = area.value.split('\n').length; if (count !== ed.lines) { ed.lines = count; gutter.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n'); } gutter.scrollTop = area.scrollTop; };
    function paint() {
      const mode = markdownFile ? tab.mode || 'preview' : 'edit';
      bodyEl.className = `ed-body${mode === 'split' ? ' split' : mode === 'preview' ? ' preview' : ''}`;
      modeButtons.forEach(b => { b.textContent = t({ edit: '编辑', split: '分栏', preview: '预览' }[b.dataset.mode]); b.setAttribute('aria-pressed', String(b.dataset.mode === mode)); });
      status.replaceChildren();
      if (ed.state === 'loading') status.append(node('span', '', t('读取中…')));
      else if (ed.state === 'conflict' || ed.state === 'missing') status.append(node('span', 'bad', t(ed.state === 'missing' ? '文件已删除' : '有冲突')));
      else if (ed.saving) status.append(node('span', '', t('保存中…')));
      else if (ed.error) status.append(node('span', 'bad', t('保存失败')));
      else if (ed.dirty) status.append(node('i', 'pend'), node('span', '', t('未保存')));
      else if (ed.state === 'ready') { status.append(icon('i-check', 'i i-xs ok'), node('span', '', t(ed.external && Date.now() - ed.external < 4000 ? '已载入外部修改' : '已保存'))); }
      status.title = ed.error || '';
      banner.replaceChildren(); banner.hidden = true; banner.classList.remove('bad');
      const action = (label, run, primary) => { const b = node('button', primary ? 'primary' : '', t(label)); b.type = 'button'; b.addEventListener('click', run); return b; };
      if (ed.state === 'conflict') { banner.hidden = false; banner.append(node('span', 'grow', t(ed.conflictVersion === null ? '这个文件已在别处被删除，你的修改尚未保存。' : '这个文件已在别处被修改（可能是 agent 或另一台设备），你的修改尚未保存。')), action('载入新版本', () => reload(true)), action(ed.conflictVersion === null ? '重新创建' : '保留我的版本', keepMine, true)); }
      else if (ed.state === 'missing') { banner.hidden = false; banner.classList.add('bad'); banner.append(node('span', 'grow', t('文件已被删除或移动。')), action('关闭标签', () => close(tab.key)), action('重新创建', keepMine, true)); }
      else if (ed.error) { banner.hidden = false; banner.classList.add('bad'); banner.append(node('span', 'grow', t('保存失败：{error}', { error: t(ed.error) })), action('重试', () => save())); }
      foot.replaceChildren();
      if (ed.state !== 'loading' && ed.state !== 'unsupported') {
        const before = area.value.slice(0, area.selectionStart), line = before.split('\n').length, col = before.length - before.lastIndexOf('\n');
        foot.append(node('span', '', t('第 {line} 行，第 {col} 列', { line, col })), node('span', '', t('{count} 行', { count: ed.lines })), node('span', '', formatSize(new Blob([area.value]).size)), node('span', 'grow'), node('span', '', t('自动保存')));
      }
      tabsChanged();
    }
    function message(text, link) {
      const box = node('div', 'ed-message'); box.append(icon(fileIcon(path), 'i'), node('span', '', text));
      if (link) { const a = node('a', '', t('在新窗口打开')); a.href = raw; a.target = '_blank'; a.rel = 'noopener'; box.append(a); }
      bodyEl.replaceChildren(box); seg.hidden = true; foot.replaceChildren();
    }
    function apply(result, keepCursor) {
      const { selectionStart, selectionEnd, scrollTop } = area;
      area.value = result.content; ed.base = result.content; ed.version = result.version; ed.dirty = false; ed.error = ''; ed.state = 'ready'; ed.conflictVersion = undefined;
      if (keepCursor) { area.selectionStart = Math.min(selectionStart, area.value.length); area.selectionEnd = Math.min(selectionEnd, area.value.length); area.scrollTop = scrollTop; }
      gutterText(); renderPreview(); paint();
    }
    async function load() {
      if (image) { ed.state = 'unsupported'; const box = node('div', 'img-view'), img = node('img'); img.src = raw; img.alt = path; img.addEventListener('error', () => message(t('无法显示这张图片。'), true), { once: true }); box.append(img); bodyEl.replaceChildren(box); paint(); return; }
      try { apply(await api(url)); if (tab.anchor) { preview.querySelector(`#md-${CSS.escape(tab.anchor)}`)?.scrollIntoView({ block: 'start' }); delete tab.anchor; } }
      catch (error) {
        if (/^ENOENT\b/.test(error.message) || error.code === 'missing' || error.status === 404) { ed.state = 'missing'; ed.version = null; ed.base = ''; area.value = ''; gutterText(); paint(); return; }
        ed.state = 'unsupported'; message(t(error.message || String(error)), true); paint();
      }
    }
    // Reloads from disk; "discard" drops unsaved text (the conflict banner's 载入新版本).
    async function reload(discard) {
      if (ed.dirty && !discard) return;
      clearTimeout(ed.timer);
      try { apply(await api(url), true); } catch (error) { if (error.status === 404 || /^ENOENT\b/.test(error.message)) { ed.state = 'missing'; paint(); } else showError(error); }
    }
    function keepMine() { ed.version = ed.state === 'missing' ? null : ed.conflictVersion; ed.state = 'ready'; ed.conflictVersion = undefined; ed.dirty = true; save(); }
    async function save() {
      clearTimeout(ed.timer);
      if (ed.saving || ed.state !== 'ready' || !ed.dirty && !ed.error) return ed.pending;
      ed.saving = true; ed.error = ''; paint();
      const content = area.value;
      ed.pending = (async () => {
        try {
          const result = await api(`${projectURL(pid)}/file`, { method: 'PUT', body: { path, content, version: ed.version ?? null } });
          ed.version = result.version; ed.base = content; ed.dirty = area.value !== content; ed.savedAt = Date.now();
        } catch (error) {
          if (error.status === 409 && error.code === 'conflict') { ed.state = 'conflict'; ed.conflictVersion = error.data?.version ?? null; }
          else ed.error = error.message || String(error);
        } finally { ed.saving = false; ed.pending = null; paint(); if (ed.dirty && ed.state === 'ready' && !ed.error) schedule(); }
      })();
      return ed.pending;
    }
    const schedule = () => { clearTimeout(ed.timer); ed.timer = setTimeout(save, AUTOSAVE); };
    // A changed version on disk reloads a clean editor quietly; with unsaved edits it is a conflict.
    async function check() {
      if (ed.saving || !['ready', 'missing'].includes(ed.state) || document.hidden) return;
      let stat;
      try { stat = await api(`${url}&stat=1`); }
      catch (error) { if (error.status === 404 && ed.state === 'ready' && ed.version !== null) { if (ed.dirty) { ed.state = 'conflict'; ed.conflictVersion = null; } else ed.state = 'missing'; paint(); } return; }
      if (ed.saving) return;
      if (ed.state === 'missing') { if (!ed.dirty) { await reload(true); ed.external = Date.now(); paint(); } else { ed.state = 'conflict'; ed.conflictVersion = stat.version; paint(); } return; }
      if (stat.version === ed.version) return;
      if (ed.dirty) { ed.state = 'conflict'; ed.conflictVersion = stat.version; paint(); }
      else { await reload(); ed.external = Date.now(); paint(); setTimeout(paint, 4100); }
    }
    area.addEventListener('input', () => { ed.dirty = area.value !== ed.base || ed.version === null; gutterText(); if (ed.state === 'ready') schedule(); clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 150); paint(); });
    area.addEventListener('scroll', () => { gutter.scrollTop = area.scrollTop; });
    area.addEventListener('keyup', paint); area.addEventListener('click', paint);
    area.addEventListener('blur', () => { if (ed.dirty) save(); });
    area.addEventListener('keydown', event => {
      if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); document.execCommand('insertText', false, event.shiftKey ? '' : '  '); }
    });
    preview.addEventListener('click', event => {
      const link = event.target.closest('a[data-file], a[data-anchor]'); if (!link) return;
      event.preventDefault();
      if (link.dataset.file) open(pid, { kind: 'file', path: link.dataset.file, anchor: link.dataset.anchor });
      else preview.querySelector(`#md-${CSS.escape(link.dataset.anchor)}`)?.scrollIntoView({ block: 'start' });
    });
    Object.assign(ed, { save, check, paint, reload, focus: () => { if (!image && ed.state !== 'unsupported' && (!markdownFile || tab.mode !== 'preview')) area.focus({ preventScroll: true }); } });
    tab.mode ||= markdownFile ? (localStorage.getItem(MD_MODE) || 'preview') : undefined;
    gutterText(); paint(); load();
    return ed;
  }

  // ---------- Artifact tab: the Artifact page itself, embedded ----------
  // An Artifact that runs on another server cannot be framed here (project-hosts.js, artifactHome): the
  // tab offers that server's windows instead.
  function artifactView(pid, tab) {
    const el = node('div', 'pane-view artifact'), body = node('div', 'art-body'); el.append(body);
    const view = { el, pid, tab, kind: 'artifact', frame: null, paint() {}, check() {}, save() {}, focus() {},
      mount() {
        if (view.frame) return;
        const home = artifactHome(pid), query = `?project=${encodeURIComponent(pid)}&artifact=${encodeURIComponent(tab.artifactId)}`;
        if (home) {
          const link = (path, label) => { const a = node('a', 'button', label); a.href = home.url + path + query; a.target = '_blank'; a.rel = 'noopener'; a.addEventListener('click', signedInClick(home.id, a)); return a; };
          const card = node('div', 'art-remote'), actions = node('div', 'art-remote-actions');
          actions.append(link('/artifact.html', t('打开（编辑模式）')), link('/open.html', t('打开（仅浏览）')));
          card.append(node('p', '', t('这个 Artifact 运行在 {host} 上，在那台电脑的页面里打开。', { host: home.name || home.id })), actions);
          view.frame = card; body.replaceChildren(card); return;
        }
        const frame = node('iframe'); frame.title = artifactName(pid, tab.artifactId) || 'Artifact'; frame.src = `/artifact.html?project=${encodeURIComponent(pid)}&artifact=${encodeURIComponent(tab.artifactId)}&embed=1`; view.frame = frame; body.replaceChildren(frame); },
      unmount() { view.frame?.remove(); view.frame = null; },
      reload() { if (view.frame) view.frame.src = view.frame.src; } };
    return view;
  }

  function viewFor(pid, tab) {
    const id = viewKey(pid, tab.key);
    let view = views.get(id);
    if (!view) { view = tab.kind === 'artifact' ? artifactView(pid, tab) : fileView(pid, tab); view.el.hidden = true; views.set(id, view); $('#pane-views').append(view.el); }
    return view;
  }
  const dropView = (pid, key) => { const id = viewKey(pid, key), view = views.get(id); if (!view) return; clearTimeout(view.timer); view.unmount?.(); view.el.remove(); views.delete(id); };

  // ---------- tab strip ----------
  let dragKey = null;
  function tabsChanged() { if (!rendering) renderStrip(); }
  let rendering = false;
  function renderStrip() {
    const strip = $('#ptabs'), set = current(); strip.replaceChildren();
    for (const tab of set?.tabs || []) {
      const view = views.get(viewKey(projectId, tab.key));
      const el = node('div', `ptab${tab.key === set.active ? ' active' : ''}${view?.dirty || view?.saving ? ' dirty' : ''}`);
      const title = tab.kind === 'artifact' ? artifactName(projectId, tab.artifactId) || tab.artifactId : baseName(tab.path);
      el.setAttribute('role', 'tab'); el.setAttribute('aria-selected', String(tab.key === set.active)); el.tabIndex = 0; el.draggable = true;
      el.title = tab.kind === 'artifact' ? `Artifact · ${title}` : tab.path;
      el.append(icon(tab.kind === 'artifact' ? 'i-box' : fileIcon(tab.path), 'i i-sm ficon'));
      if (tab.kind === 'artifact' && artifactRunning(projectId, tab.artifactId)) el.append(node('i', 'run-dot'));
      el.append(node('span', 'nm', title));
      const x = node('button', 'x'); x.type = 'button'; x.append(icon('i-x', 'i i-xs')); x.setAttribute('aria-label', t('关闭 {name}', { name: title })); x.title = view?.dirty ? t('未保存，关闭前会先保存') : t('关闭');
      x.addEventListener('click', event => { event.stopPropagation(); close(tab.key); });
      el.append(x);
      el.addEventListener('click', () => activate(tab.key));
      el.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); close(tab.key); } });
      el.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(tab.key); } else if (event.key === 'Delete') close(tab.key); });
      el.addEventListener('dragstart', event => { dragKey = tab.key; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/x-studio-tab', tab.key); });
      el.addEventListener('dragend', () => { dragKey = null; strip.querySelectorAll('.drop-before').forEach(item => item.classList.remove('drop-before')); });
      el.addEventListener('dragover', event => { if (!dragKey || dragKey === tab.key) return; event.preventDefault(); strip.querySelectorAll('.drop-before').forEach(item => item.classList.remove('drop-before')); el.classList.add('drop-before'); });
      el.addEventListener('drop', event => { if (!dragKey) return; event.preventDefault(); const tabs = set.tabs, from = tabs.findIndex(item => item.key === dragKey); const [moved] = tabs.splice(from, 1); tabs.splice(tabs.findIndex(item => item.key === tab.key), 0, moved); dragKey = null; persist(); renderStrip(); });
      strip.append(el);
    }
    strip.querySelector('.ptab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function render() {
    rendering = true;
    const set = current();
    for (const [id, view] of views) {
      const mine = view.pid === projectId, active = mine && set?.active === view.tab.key;
      view.el.hidden = !active;
      if (view.kind === 'artifact') { if (mine) view.mount(); else view.unmount(); }
      else if (!mine && !view.dirty && !view.saving && view.state !== 'conflict') dropView(view.pid, view.tab.key);
    }
    if (set?.active) { const tab = set.tabs.find(item => item.key === set.active); if (tab) { const view = viewFor(projectId, tab); view.el.hidden = false; if (view.kind === 'artifact') view.mount(); } }
    $('#pane-empty').hidden = Boolean(set?.tabs.length);
    rendering = false; renderStrip();
    panes.setPaneOpen(Boolean(set?.open));
    onActiveChange(set?.tabs.find(item => item.key === set.active) || null);
  }
  function activate(key) { const set = current(); if (!set) return; set.active = key; persist(); render(); const view = activeView(); view?.check(); view?.focus(); }
  function open(pid, spec, { focus = true } = {}) {
    const set = setOf(pid), key = keyOf(spec);
    let tab = set.tabs.find(item => item.key === key);
    if (!tab) { tab = { key, kind: spec.kind, ...(spec.kind === 'artifact' ? { artifactId: spec.artifactId } : { path: spec.path }) }; const at = set.tabs.findIndex(item => item.key === set.active); set.tabs.splice(at < 0 ? set.tabs.length : at + 1, 0, tab); }
    if (spec.anchor) tab.anchor = spec.anchor;
    set.active = key; set.open = true; persist();
    if (pid !== projectId) return;
    render(); panes.closeDrawers();
    const view = activeView();
    if (spec.anchor && view?.kind === 'file' && view.state === 'ready') { view.el.querySelector(`#md-${CSS.escape(spec.anchor)}`)?.scrollIntoView({ block: 'start' }); delete tab.anchor; }
    view?.check(); if (focus) view?.focus();
  }
  async function close(key) {
    const set = current(); if (!set) return;
    const view = views.get(viewKey(projectId, key));
    if (view?.kind === 'file') {
      if (view.dirty && view.state === 'ready') await view.save();
      if ((view.dirty || view.state === 'conflict') && !confirm(t('{name} 有未保存的修改，仍要关闭吗？', { name: baseName(view.tab.path) }))) return;
    }
    const index = set.tabs.findIndex(item => item.key === key); if (index < 0) return;
    set.tabs.splice(index, 1); dropView(projectId, key);
    if (set.active === key) set.active = set.tabs[Math.min(index, set.tabs.length - 1)]?.key || null;
    persist(); render();
  }

  setInterval(() => { if (!panes.paneOpen || document.hidden) return; activeView()?.check(); }, POLL);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && panes.paneOpen) activeView()?.check(); });
  addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') { const view = activeView(); if (view?.kind === 'file' && panes.paneOpen) { event.preventDefault(); view.save(); } }
  });
  // Unsaved text (a save still pending, failed or in conflict) asks before the page goes away.
  addEventListener('beforeunload', event => {
    let unsaved = false;
    for (const view of views.values()) if (view.kind === 'file' && (view.dirty || view.saving)) { unsaved = true; if (view.state === 'ready') view.save(); }
    if (unsaved) { event.preventDefault(); event.returnValue = ''; }
  });
  onLanguageChange(() => { for (const view of views.values()) view.paint(); renderStrip(); });

  return {
    // Shows another project's tab set and its pane state.
    showProject(id) { projectId = id; render(); },
    open: (pid, spec, options) => open(pid ?? projectId, spec, options),
    setOpen(open) { const set = current(); if (!set) return; set.open = open; persist(); render(); if (open) activeView()?.check(); },
    // Re-reads labels such as Artifact names and run marks after the project reloads.
    refresh() { renderStrip(); for (const view of views.values()) if (view.kind === 'artifact' && view.frame) view.frame.title = artifactName(view.pid, view.tab.artifactId) || 'Artifact'; },
    reloadArtifact(pid, artifactId) { views.get(viewKey(pid, `artifact:${artifactId}`))?.reload(); },
    activeTab() { const set = current(); return set?.tabs.find(item => item.key === set.active) || null; },
  };
}
