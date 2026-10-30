import { t } from './i18n.js';
import { api, post, projectURL } from './api.js';
import { $, node, button, showDialog, attempt } from './ui.js';

// The project's sync settings and its copies on each computer. The dialog reads
// GET /sync while open, so copy progress and another computer's changes show up on their own.
let current = null, timer = null;
const size = bytes => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(bytes / 1e3)} KB`;

export function openSync(project, { hosts, hostName }) {
  current = { project, hosts, hostName };
  const dialog = $('#sync-dialog');
  $('#sync-name').textContent = project.name;
  dialog.addEventListener('close', () => { clearInterval(timer); timer = null; current = null; }, { once: true });
  showDialog('#sync-dialog');
  attempt(render); clearInterval(timer); timer = setInterval(() => render().catch(() => {}), 2000);
}

function copyState(id, copy, view) {
  const status = view.status[id];
  if (status?.phase === 'pulling') return t('正在复制 {percent}%', { percent: status.percent ?? 0 });
  if (status?.phase === 'checking') return t('正在检查');
  if (status?.phase === 'blocked' || status?.phase === 'error' || status?.phase === 'stale') return t('出错：{error}', { error: status.error });
  if (!copy) return t('没有副本');
  if (copy.state === 'adding') return t('正在添加');
  if (!view.head || copy.version === view.head.id) return t('最新');
  return t('落后');
}

async function render() {
  if (!current) return;
  const { project, hosts, hostName } = current, url = projectURL(project.id);
  const view = await api(url + '/sync');
  if (!current) return;
  const body = $('#sync-body'), enabled = view.sync.enabled, owner = view.ownerHostId || project.ownerHostId;
  const toggle = node('label', 'settings-check'), check = document.createElement('input');
  check.type = 'checkbox'; check.checked = enabled;
  check.onchange = () => attempt(async () => { check.disabled = true; try { await api(url + '/sync', { method: 'PATCH', body: { enabled: check.checked } }); } finally { check.disabled = false; } await render(); });
  toggle.append(check, node('span', '', t('在多台电脑上保留此项目的文件，对话可在任一有副本的电脑上运行')));
  const parts = [toggle];
  if (!enabled) parts.push(node('p', 'small muted', t('未同步：文件只在 {name}，对话只能在那里运行。', { name: hostName(owner) })));
  else {
    const auto = node('label', 'settings-check'), autoCheck = document.createElement('input');
    autoCheck.type = 'checkbox'; autoCheck.checked = view.sync.commit === 'auto';
    autoCheck.onchange = () => attempt(() => api(url + '/sync', { method: 'PATCH', body: { commit: autoCheck.checked ? 'auto' : 'manual' } }));
    auto.append(autoCheck, node('span', '', t('每次运行结束后自动提交文件版本')));
    const pre = node('label', 'settings-check'), preCheck = document.createElement('input');
    preCheck.type = 'checkbox'; preCheck.checked = view.sync.prefetch !== false;
    preCheck.onchange = () => attempt(() => api(url + '/sync', { method: 'PATCH', body: { prefetch: preCheck.checked } }));
    pre.append(preCheck, node('span', '', t('有新版本时在后台预先复制')));
    parts.push(auto, pre);
    if (view.head) parts.push(node('p', 'small muted', t('当前版本：{host} · {files} 个文件 · {size}', { host: hostName(view.head.hostId), files: view.head.files, size: size(view.head.bytes) })));
    if (view.diverged) {
      const box = node('div', 'sync-diverged');
      box.append(node('p', '', t('两台电脑各自改了文件，需要选择保留哪一份；另一份会被覆盖。')));
      for (const head of view.diverged.heads) box.append(button(t('保留 {name} 的文件', { name: hostName(head.hostId) }), () => attempt(async () => { if (!confirm(t('另一台电脑上的改动会被覆盖，无法恢复。继续？'))) return; await post(url + '/resolve', { hostId: head.hostId }); await render(); }), 'primary danger'));
      parts.push(box);
    }
    const list = node('div', 'sync-copies');
    const ids = [...new Set([...hosts().map(h => h.id), ...Object.keys(view.replicas)])];
    for (const id of ids) {
      const copy = view.replicas[id], online = hosts().some(h => h.id === id), row = node('div', 'sync-copy');
      row.append(node('strong', '', hostName(id)), node('span', 'muted small', (online ? copyState(id, copy, view) : t('离线')) + (id === owner ? ' · ' + t('所有者') : '')));
      const actions = node('span', 'sync-actions');
      if (online && !copy) actions.append(button(t('复制到这台'), () => attempt(async () => { await post(url + '/replicas', { hostId: id }); await render(); }), 'quiet'));
      if (online && copy?.state === 'ready') actions.append(button(t('立即提交'), () => attempt(async () => { await post(url + '/commit', { hostId: id }); await render(); }), 'quiet'));
      if (copy?.state === 'ready' && id !== owner && (!view.head || copy.version === view.head.id)) actions.append(button(t('设为所有者'), () => attempt(async () => { await api(url + '/sync', { method: 'PATCH', body: { ownerHostId: id } }); await render(); }), 'quiet'));
      if (online && copy && id !== owner) actions.append(button(t('删除副本'), () => attempt(async () => {
        const footprint = await api(`${url}/replicas/${encodeURIComponent(id)}/footprint`);
        if (!confirm(t('删除 {name} 上的 {files} 个文件（{size}）？其他电脑上的副本不受影响。', { name: hostName(id), files: footprint.files, size: size(footprint.bytes) }))) return;
        await api(`${url}/replicas/${encodeURIComponent(id)}?confirm=1`, { method: 'DELETE' }); await render();
      }), 'quiet danger'));
      row.append(actions); list.append(row);
    }
    parts.push(node('h3', '', t('各电脑上的副本')), list);
    const ready = Object.entries(view.replicas).filter(([, r]) => r.state === 'ready').map(([id]) => id);
    if (ready.length > 1) {
      const label = node('label'), select = document.createElement('select');
      select.add(new Option(t('项目所有者（{name}）', { name: hostName(owner) }), ''));
      for (const id of ready.filter(id => id !== owner)) select.add(new Option(hostName(id), id));
      select.value = view.sync.artifactHostId || '';
      select.onchange = () => attempt(() => api(url + '/sync', { method: 'PATCH', body: { artifactHostId: select.value || null } }));
      label.append(node('span', '', t('Artifact 运行电脑')), select);
      parts.push(label);
    }
  }
  if (document.activeElement && body.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
  body.replaceChildren(...parts);
}
