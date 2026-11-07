import { t } from './i18n.js';
import { api, projectURL } from './api.js';
import { $, node, button, showDialog, attempt } from './ui.js';

// One project's settings: which computers hold a copy of its files, which
// may run it, and archive/delete. Every computer keeps its own copy; nothing is synchronized, so
// the only setting is the allow list. The dialog reads GET /sync while open, so another computer's
// change shows up on its own.
let current = null, timer = null;

export function openProjectSettings(project, { hosts, hostName, lifecycle }) {
  current = { project, hosts, hostName, lifecycle };
  const dialog = $('#project-settings');
  $('#project-settings-name').textContent = project.name;
  dialog.addEventListener('close', () => { clearInterval(timer); timer = null; current = null; }, { once: true });
  showDialog('#project-settings');
  attempt(render); clearInterval(timer); timer = setInterval(() => render().catch(() => {}), 2000);
}

const section = (title, ...children) => { const el = node('section', 'settings-section'); el.append(node('h3', '', title), ...children); return el; };

async function render() {
  if (!current) return;
  const { project, hosts, hostName, lifecycle } = current, url = projectURL(project.id);
  // Every registered computer, online or not (GET /api/hosts lists the peers; the serving one comes from the page).
  const [view, registered] = await Promise.all([api(url + '/sync'), api('/api/hosts').catch(() => [])]);
  if (!current) return;
  const body = $('#project-settings-body'), owner = view.ownerHostId || project.ownerHostId;
  const known = new Map(hosts().map(h => [h.id, { name: h.name || h.id, online: true }]));
  for (const h of registered) if (!known.has(h.id)) known.set(h.id, { name: h.name || h.id, online: Boolean(h.online) });
  for (const id of [owner, ...view.allowedHostIds, ...view.copies]) if (id && !known.has(id)) known.set(id, { name: hostName(id), online: false });
  const allowed = new Set(view.allowedHostIds);

  // Where the files are.
  const place = section(t('文件位置'));
  place.append(node('p', '', t('创建于 {name}。有文件副本的电脑：{names}。', { name: hostName(owner), names: view.copies.map(hostName).join('、') || hostName(owner) })));
  place.append(node('p', 'small muted', t('每台电脑各自保存一份项目文件，不会自动同步。需要另一台电脑上的文件时，在对话里告诉 agent，它会通过 SSH 自己去取。')));

  // Which computers may run it: the owner always, the others by this list.
  const run = section(t('可运行的电脑'));
  const list = node('div', 'run-hosts');
  for (const [id, info] of known) {
    const row = node('label', 'settings-check'), input = document.createElement('input');
    input.type = 'checkbox'; input.checked = id === owner || allowed.has(id); input.disabled = id === owner;
    input.onchange = () => attempt(async () => {
      input.disabled = true;
      try { const next = new Set(allowed); if (input.checked) next.add(id); else next.delete(id); await api(url + '/sync', { method: 'PATCH', body: { allowedHostIds: [...next].filter(x => x !== owner) } }); }
      finally { input.disabled = id === owner; }
      await render();
    });
    const label = node('span', '', info.name);
    if (id === owner) label.append(node('small', 'sync-owner', t('所有者')));
    if (!info.online) label.append(node('small', 'sync-owner', t('离线')));
    row.append(input, label); list.append(row);
  }
  run.append(list, node('p', 'small muted', t('所有者永远可以运行。勾选其他电脑后，新建对话时可以选它来执行；它第一次运行时会得到一个空的项目文件夹。')));

  const manage = section(t('归档与删除'));
  const actions = node('div', 'project-settings-actions');
  for (const [label, action, cls] of [[t('归档项目'), 'archive', 'quiet'], [t('删除项目'), 'delete', 'quiet danger']]) actions.append(button(label, () => { $('#project-settings').close(); lifecycle(action); }, cls));
  manage.append(actions);

  if (document.activeElement && body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  body.replaceChildren(place, run, manage);
}
