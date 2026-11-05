import { t, initLanguage } from './i18n.js';
import { api, post, projectURL, signedIn } from './api.js';
import { initTheme } from './themes.js';
import { bootstrap } from './ui.js';
// Browse mode: the Artifact alone, as a web application in its own window, without the workbench,
// comments or toolbar. This page starts the Artifact if needed and then replaces itself with the
// Artifact's own preview address (the same one the edit view frames), so the window holds nothing else.
initLanguage(); initTheme();
const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search), projectId = params.get('project'), artifactId = params.get('artifact');
const editPage = `/artifact.html?project=${encodeURIComponent(projectId || '')}&artifact=${encodeURIComponent(artifactId || '')}`;
document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
async function open() {
  if (!projectId || !artifactId) throw new Error(t('链接缺少项目或 Artifact ID。请从项目文件栏打开。'));
  // Signs in first: a link from another server's page arrives here without this server's session.
  const self = await bootstrap();
  const base = `${projectURL(projectId)}/artifacts/${encodeURIComponent(artifactId)}`;
  let runtime = await api(`${base}/status`);
  // An Artifact that runs on another server opens on that server, so the window's address is its own
  // (project-hosts.js, artifactHome). That server's status then names itself, so this happens once.
  const home = runtime.hostId && runtime.hostId !== self.hostId ? self.hosts?.find(h => h.id === runtime.hostId) : null;
  if (home?.url) { location.replace(await signedIn(home.id, new URL(location.pathname + location.search, home.url).href)); return; }
  if (!runtime.running) {
    if (runtime.filesReady === false) throw new Error(runtime.syncMessage ? t(runtime.syncMessage) : t('Artifact 文件尚未就绪。'));
    $('#open-status').textContent = t('正在启动 Artifact…');
    await post(`${base}/start`); runtime = await api(`${base}/status`);
  }
  if (!runtime.running || !runtime.url) throw new Error(runtime.error || t('Artifact 未能启动。'));
  location.replace(new URL(runtime.url, location.href).href);
}
open().catch(error => {
  $('#open-status').hidden = true; $('#open-error').hidden = false; $('#open-error').textContent = error.message;
  $('#open-actions').hidden = false; $('#open-edit').href = editPage;
});
