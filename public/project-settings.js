import { t } from './i18n.js';
import { api, post, projectURL } from './api.js';
import { $, node, button, showDialog, attempt } from './ui.js';

// One project's settings: where its files are, sync and the copy on each computer,
// and archive/delete. The dialog reads GET /sync while open, so copy progress and another
// computer's changes show up on their own.
let current = null, timer = null;
const size = bytes => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(bytes / 1e3)} KB`;

export function openProjectSettings(project, { hosts, hostName, lifecycle }) {
  current = { project, hosts, hostName, lifecycle };
  const dialog = $('#project-settings');
  $('#project-settings-name').textContent = project.name;
  dialog.addEventListener('close', () => { clearInterval(timer); timer = null; current = null; }, { once: true });
  showDialog('#project-settings');
  attempt(render); clearInterval(timer); timer = setInterval(() => render().catch(() => {}), 2000);
}

// What one computer's copy is doing, and a tone for its badge.
function copyState(id, copy, view, online) {
  const status = view.status[id];
  if (!online) return [t('离线'), 'off'];
  if (status?.phase === 'pulling') return [t('正在复制 {percent}%', { percent: status.percent ?? 0 }), 'busy'];
  if (status?.phase === 'checking') return [t('正在检查'), 'busy'];
  if (status?.phase === 'blocked' || status?.phase === 'error' || status?.phase === 'stale') return [t('出错：{error}', { error: status.error }), 'bad'];
  if (!copy) return [t('没有副本'), 'off'];
  if (copy.state === 'adding') return [t('正在添加'), 'busy'];
  if (!view.head || copy.version === view.head.id) return [t('最新'), 'ok'];
  return [t('落后'), 'warn'];
}

const check = (label, checked, change) => {
  const row = node('label', 'settings-check'), input = document.createElement('input');
  input.type = 'checkbox'; input.checked = checked;
  input.onchange = () => attempt(async () => { input.disabled = true; try { await change(input.checked); } finally { input.disabled = false; } await render(); });
  row.append(input, node('span', '', label)); return row;
};
const section = (title, ...children) => { const el = node('section', 'settings-section'); el.append(node('h3', '', title), ...children); return el; };

async function render() {
  if (!current) return;
  const { project, hosts, hostName, lifecycle } = current, url = projectURL(project.id);
  const view = await api(url + '/sync');
  if (!current) return;
  const body = $('#project-settings-body'), enabled = view.sync.enabled, owner = view.ownerHostId || project.ownerHostId;
  const online = id => hosts().some(h => h.id === id) && view.status[id]?.phase !== 'offline';
  const act = fn => () => attempt(async () => { await fn(); await render(); });
  const patch = input => api(url + '/sync', { method: 'PATCH', body: input });
  const ready = Object.entries(view.replicas).filter(([, r]) => r.state === 'ready').map(([id]) => id);

  // Where the files are and where conversations may run.
  const place = section(t('文件位置'));
  place.append(node('p', '', enabled
    ? t('{n} 台电脑有副本：{names}。对话可在副本为最新的电脑上运行；所有者是 {owner}。', { n: ready.length, names: ready.map(hostName).join('、'), owner: hostName(owner) })
    : t('文件只在 {name}（所有者）。对话只能在这台电脑上运行。', { name: hostName(owner) })));
  if (view.head) place.append(node('p', 'small muted', t('当前版本：{host} · {files} 个文件 · {size}', { host: hostName(view.head.hostId), files: view.head.files, size: size(view.head.bytes) })));
  if (view.diverged) {
    const box = node('div', 'sync-diverged');
    box.append(node('p', '', t('两台电脑各自改了文件，需要选择保留哪一份；另一份会被覆盖。')));
    for (const head of view.diverged.heads) box.append(button(t('保留 {name} 的文件', { name: hostName(head.hostId) }), () => attempt(async () => { if (!confirm(t('另一台电脑上的改动会被覆盖，无法恢复。继续？'))) return; await post(url + '/resolve', { hostId: head.hostId }); await render(); }), 'primary danger'));
    place.append(box);
  }

  const sync = section(t('同步'), check(t('在多台电脑上保留此项目的文件，对话可在任一有副本的电脑上运行'), enabled, value => patch({ enabled: value })));
  if (!enabled) sync.append(node('p', 'small muted', t('开启后可把文件复制到其他电脑并在那里运行对话。要把项目搬到另一台电脑：开启同步，复制过去，设为所有者，再关闭同步。')));
  else {
    // One row per computer: its copy, then what can be done with it from here.
    const list = node('div', 'sync-copies');
    for (const id of [...new Set([...hosts().map(h => h.id), ...Object.keys(view.replicas)])]) {
      const copy = view.replicas[id], up = online(id), [state, tone] = copyState(id, copy, view, up);
      const behind = copy?.state === 'ready' && view.head && copy.version !== view.head.id, busy = tone === 'busy';
      const row = node('div', 'sync-copy'), who = node('span', 'sync-host');
      who.append(node('strong', '', hostName(id)));
      if (id === owner) who.append(node('small', 'sync-owner', t('所有者')));
      row.append(who, node('span', `sync-state sync-${tone}`, state));
      const actions = node('span', 'sync-actions');
      if (up && !copy) actions.append(button(t('复制到这台'), act(() => post(url + '/replicas', { hostId: id })), 'quiet'));
      if (up && copy && copy.state !== 'ready' && tone === 'bad') actions.append(button(t('重试'), act(() => post(url + '/replicas', { hostId: id })), 'quiet'));
      if (up && behind && !busy && !view.diverged) actions.append(button(t('拉取最新'), act(() => post(url + '/pull', { hostId: id })), 'quiet'));
      if (up && copy?.state === 'ready' && !behind && !busy) actions.append(button(t('立即提交'), act(() => post(url + '/commit', { hostId: id })), 'quiet'));
      if (copy?.state === 'ready' && id !== owner && !behind) actions.append(button(t('设为所有者'), act(() => patch({ ownerHostId: id })), 'quiet'));
      if (up && copy && id !== owner) actions.append(button(t('删除副本'), () => attempt(async () => {
        const footprint = await api(`${url}/replicas/${encodeURIComponent(id)}/footprint`);
        if (!confirm(t('删除 {name} 上的 {files} 个文件（{size}）？其他电脑上的副本不受影响。', { name: hostName(id), files: footprint.files, size: size(footprint.bytes) }))) return;
        await api(`${url}/replicas/${encodeURIComponent(id)}?confirm=1`, { method: 'DELETE' }); await render();
      }), 'quiet danger'));
      row.append(actions); list.append(row);
    }
    sync.append(node('h4', '', t('各电脑上的副本')), list,
      check(t('每次运行结束后自动提交文件版本'), view.sync.commit === 'auto', value => patch({ commit: value ? 'auto' : 'manual' })),
      check(t('有新版本时在后台预先复制'), view.sync.prefetch !== false, value => patch({ prefetch: value })));
    if (ready.length > 1) {
      const label = node('label'), select = document.createElement('select');
      select.add(new Option(t('项目所有者（{name}）', { name: hostName(owner) }), ''));
      for (const id of ready.filter(id => id !== owner)) select.add(new Option(hostName(id), id));
      select.value = view.sync.artifactHostId || '';
      select.onchange = () => attempt(() => patch({ artifactHostId: select.value || null }));
      label.append(node('span', '', t('Artifact 运行电脑')), select);
      sync.append(label);
    }
    sync.append(node('p', 'small muted', t('不需要复制的路径（例如大型运行结果）写进项目根目录的 .studioignore，语法同 .gitignore。')));
  }

  const manage = section(t('归档与删除'));
  const actions = node('div', 'project-settings-actions');
  for (const [label, action, cls] of [[t('归档项目'), 'archive', 'quiet'], [t('删除项目'), 'delete', 'quiet danger']]) actions.append(button(label, () => { $('#project-settings').close(); lifecycle(action); }, cls));
  manage.append(actions);

  if (document.activeElement && body.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
  body.replaceChildren(place, sync, manage);
}
