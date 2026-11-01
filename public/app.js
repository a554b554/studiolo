import {initAccountUsage} from './account-usage.js';
import { t, getLanguage, onLanguageChange, initLanguage, setLanguage } from './i18n.js';
import { api, post, upload, projectURL, requestId } from './api.js';
import { initTheme, setTheme } from './themes.js';
import { view, draftKey, rememberSelection, previousSelection } from './state.js';
import { syncMessages, mergeRuntime } from './ui.js';
import { category, visibleItems, moreButton } from './lifecycle.js';
import { mountDictation } from './dictation.js';
import { $, node, button, icon, empty, time, showError, clearError, attempt, showDialog, initDialogs, bootstrap, initChoices, listenChanges, renderRuns, statuses, messageContent } from './ui.js';
import { platformCommands, codexCommands, parseSlash, mergeCommands, createSlashMenu } from './commands.js';
import { initAccounts } from './accounts.js';
import { setAccountDirectory, accountName, familyName, recorded, steerCount } from './conversation.js';
import { isSynced, runHosts, readyHosts } from './project-hosts.js';
import { openProjectSettings } from './project-settings.js';
import { notifyResults } from './notify.js';
import { initFailover } from './failover.js';
import { draftEdited, flushDraft, draftSent, adoptDraft, refreshDraft } from './drafts.js';
import { initPanes } from './panes.js';
import { initTabs } from './tabs.js';
import { createNavigation } from './navigation.js';
let usage = { setHost() {}, reload() {} }, accountsUI = null, lastComposerHost = null;

initLanguage(); initTheme(); initDialogs();
// The side pane's tabs follow the open project; its open state is the project's too (tabs.js).
const artifactStatus = new Map();
const panes = initPanes({ onPaneToggle: open => tabs.setOpen(open) });
const tabs = initTabs({ panes,
  artifactName: (projectId, id) => (projectId === view.projectId ? view.project?.artifacts : [])?.find(a => a.id === id)?.name || '',
  artifactRunning: (projectId, id) => projectId === view.projectId && Boolean(artifactStatus.get(id)?.running || artifactStatus.get(id)?.persistent?.running),
  onActiveChange: tab => markOpenResource(tab) });
$('#connection').textContent=t('连接中'); $('#session-title').textContent=t('选择项目'); $('#prompt').placeholder=t('输入消息…');
let choices = () => ({}), refreshTimer, loadVersion = 0, messageSignature = '', navigationSignature = '', artifactSignature = '';
let projectSelectionPending=false;
const pendingRequests = new Map();
const formBody = form => Object.fromEntries(new FormData(form));
const path = () => projectURL(view.projectId);
// Last selection, theme and language follow the user to other devices; localStorage
// keeps this browser's copy for when no server answers.
const savePreferences = patch => api('/api/settings/ui',{method:'PUT',body:patch}).catch(() => {});
function remember() { rememberSelection(); savePreferences({selection:{projectId:view.projectId,sessionId:view.sessionId}}); }
// Shows the open conversation's draft: the newer of this tab's and the server's copy.
function openDraft() {
  const key = draftKey(), prompt = $('#prompt');
  adoptDraft(key, view.project?.sessions?.find(s => s.id === view.sessionId)?.draft);
  prompt.value = view.drafts.get(key) || '';
  refreshDraft(key, text => { if (draftKey() === key) prompt.value = text; });
}
function closeDrawer() { delete $('#workspace').dataset.drawer; }
document.querySelectorAll('[data-drawer]').forEach(el => el.addEventListener('click', () => { $('#workspace').dataset.drawer = el.dataset.drawer; }));
document.querySelectorAll('[data-close-drawer]').forEach(el => el.addEventListener('click', closeDrawer));
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDrawer(); });
$('#notice').addEventListener('click', clearError);
$('#project-new').addEventListener('click', () => showDialog('#project-dialog'));
$('#settings-open').addEventListener('click', () => { renderHosts(); showDialog('#settings-dialog'); attempt(renderArchives); attempt(renderSubagentSettings); attempt(renderDevices); attempt(renderTranscription); });
$('#files-refresh').addEventListener('click', () => attempt(async () => { await reloadProject(); await loadFiles(); }));
document.querySelectorAll('[data-resource]').forEach(tab => tab.addEventListener('click', () => {
  view.resource = tab.dataset.resource;
  document.querySelectorAll('[data-resource]').forEach(item => item.setAttribute('aria-selected', String(item === tab)));
  $('#files-section').hidden = view.resource !== 'files'; $('#artifacts').hidden = view.resource !== 'artifacts';
  if (view.resource === 'artifacts') attempt(pollArtifacts);
}));
$('#chat-new').addEventListener('click', () => { if (!view.projectId) return showError(new Error(t('请先打开项目'))); attempt(() => createProjectSession(view.projectId)); });
$('#update-reload').addEventListener('click', () => location.reload());

// Uploads: files from the OS file manager or a file picker go to the project's uploads/ folder.
// Dropped on the resource pane they only land there; dropped on the chat they also become
// attachments of the next message. Per-session attachment drafts survive switching sessions.
view.attachments = new Map();
const attachmentList = () => { const key = draftKey(); if (!view.attachments.has(key)) view.attachments.set(key, []); return view.attachments.get(key); };
const formatSize = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
function renderAttachments() {
  const container = $('#attachments'), list = view.sessionId ? attachmentList() : [];
  container.replaceChildren();
  for (const item of list) {
    const chip = node('span', `attachment-chip attachment-${item.status}`);
    chip.append(node('span', 'attachment-name', `📎 ${item.name}`));
    chip.title = item.status === 'ready' ? item.path : item.status === 'failed' ? item.error : t('上传中…');
    chip.append(node('small', 'muted', item.status === 'ready' ? formatSize(item.size) : item.status === 'failed' ? t('上传失败') : t('上传中…')));
    const remove = button('×', () => { const current = attachmentList(); const index = current.indexOf(item); if (index >= 0) current.splice(index, 1); renderAttachments(); }, 'attachment-remove');
    remove.setAttribute('aria-label', t('移除附件 {name}', {name: item.name})); remove.title = t('移除附件');
    chip.append(remove); container.append(chip);
  }
  container.hidden = !list.length;
}
// Directories cannot be uploaded; browsers expose them as empty files, so they are skipped.
function droppedFiles(transfer) {
  const files = [], skipped = [];
  if (transfer.items?.length) {
    for (const item of transfer.items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) { skipped.push(entry.name); continue; }
      const file = item.getAsFile(); if (file) files.push(file);
    }
  } else files.push(...transfer.files);
  return {files, skipped};
}
async function addAttachments(files) {
  if (!files.length) return;
  if (!view.sessionId || $('#prompt').disabled) throw new Error(t('请先选择可以继续对话的会话，再添加附件。'));
  const projectId = view.projectId, list = attachmentList();
  const items = files.map(file => ({id: requestId(), name: file.name, size: file.size, status: 'uploading', file}));
  list.push(...items); renderAttachments();
  for (const item of items) {
    try { const saved = await upload(`${projectURL(projectId)}/uploads`, item.file); Object.assign(item, {status: 'ready', path: saved.path, name: saved.name, size: saved.size}); }
    catch (error) { Object.assign(item, {status: 'failed', error: error.message}); showError(new Error(t('上传失败：{error}', {error: error.message}))); }
    delete item.file; renderAttachments();
    if (view.projectId === projectId) attempt(loadFiles);
  }
}
async function uploadToProject(files) {
  if (!files.length) return;
  if (!view.projectId) throw new Error(t('请先打开项目'));
  const projectId = view.projectId, status = $('#upload-status'); let done = 0;
  try {
    for (const file of files) {
      status.textContent = t('上传中 {done}/{total}：{name}', {done: done + 1, total: files.length, name: file.name});
      await upload(`${projectURL(projectId)}/uploads`, file); done++;
    }
    status.textContent = t('已上传 {count} 个文件到 uploads/', {count: done});
  } finally {
    if (view.projectId === projectId) { await loadFiles(); revealUploads(); }
    setTimeout(() => { if (status.textContent.startsWith(t('已上传'))) status.textContent = ''; }, 6000);
  }
}
function revealUploads() { for (const folder of $('#files').querySelectorAll(':scope > details')) if (folder.querySelector(':scope > summary')?.textContent === 'uploads') folder.open = true; }
// Highlight a pane while files are dragged over it; the counter survives child enter/leave pairs.
function dropZone(element, onFiles) {
  let depth = 0;
  const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  element.addEventListener('dragenter', event => { if (!hasFiles(event)) return; event.preventDefault(); depth++; element.classList.add('drag-over'); });
  element.addEventListener('dragover', event => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
  element.addEventListener('dragleave', event => { if (!hasFiles(event)) return; depth = Math.max(0, depth - 1); if (!depth) element.classList.remove('drag-over'); });
  element.addEventListener('drop', event => {
    if (!hasFiles(event)) return; event.preventDefault(); depth = 0; element.classList.remove('drag-over');
    const {files, skipped} = droppedFiles(event.dataTransfer);
    attempt(async () => { if (skipped.length) showError(new Error(t('不支持上传文件夹，已跳过：{names}', {names: skipped.join(', ')}))); await onFiles(files); });
  });
}
// Dropping anywhere else must not make the browser open the file and leave the workbench.
for (const type of ['dragover','drop']) document.addEventListener(type, event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });
dropZone($('.conversation'), addAttachments);
dropZone($('.explorer'), uploadToProject);
$('#attach').addEventListener('click', () => $('#attach-input').click());
$('#attach-input').addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; attempt(() => addAttachments(files)); });
// Voice input: the button shows once a machine transcribes (features.voiceInput, Settings → 语音转写).
// Text lands at the caret and the input event keeps the draft logic in sync.
let dictation = { setEnabled() {} }, dictationMounted = false;
function syncDictation(enabled) {
  $('#dictate').hidden = !enabled;
  if (enabled && !dictationMounted) { dictationMounted = true; dictation = mountDictation({ button: $('#dictate'), textarea: $('#prompt'), onError: showError }); }
}

// Interactive controls, matching the terminal CLIs: Esc / ■ stops the current turn but keeps the
// native session; a message sent while a run executes is delivered into that turn (steer) unless
// the user chose to queue it; "/" opens the command list.
const stopRequests = new Map();
let sendMode = 'auto';
const currentSession = () => view.project?.sessions.find(item => item.id === view.sessionId);
const activeRunOf = session => session ? (view.project?.runs || []).filter(r => r.sessionId === session.id && ['running','waiting'].includes(r.status)).at(-1) : undefined;
const nativeOf = session => session ? Object.entries(view.project?.nativeRuntime || {}).find(([key]) => key.startsWith(`${view.projectId}:session:${session.id}:`))?.[1] : undefined;
let noteTimer;
function note(text) {
  const el = $('#compose-note'); clearTimeout(noteTimer);
  el.textContent = text; el.classList.add('flash');
  noteTimer = setTimeout(() => { el.textContent = t(el.dataset.i18n); el.classList.remove('flash'); }, 6000);
}
// Picking another model keeps the conversation (its native session continues on that model), but
// the first turn on it reads the whole context again without the prompt cache: say so before sending.
function renderModelNote() {
  let el = $('#model-note');
  if (!el) { el = node('span','model-note'); el.id = 'model-note'; $('#compose-note').after(el); }
  const next = currentSession() && choices.switching?.();
  el.hidden = !next;
  el.textContent = next ? t('下一条消息起改用 {model}，对话继续；这一轮会重新读取全部上下文，额度消耗更多。',{model:next}) : '';
}
const watchChoices = picker => { picker.onUpdate?.(renderModelNote); return picker; };
$('#model').addEventListener('change', renderModelNote);
function availableCommands() {
  const session = currentSession(), native = nativeOf(session)?.commands;
  // Before the native session connects, the account's own command list (read at sign-in) is used.
  const profile = choices.profile?.() || view.bootstrap?.profiles?.find(p => p.id === (session?.profileId || $('#profile').value));
  const family = profile?.family || ((session?.profileId || $('#profile').value || '').startsWith('codex') ? 'codex' : 'claude');
  return mergeCommands(platformCommands(), native || profile?.commands || (family === 'codex' ? codexCommands() : []));
}
const slashMenu = createSlashMenu({ textarea: $('#prompt'), menu: $('#slash-menu'), commands: availableCommands, onSubmit: () => $('#composer').requestSubmit() });
async function stopActiveRun() {
  const run = activeRunOf(currentSession()); if (!run) return;
  const hard = stopRequests.has(run.id) && Date.now() - stopRequests.get(run.id) > 12000;
  if (!stopRequests.has(run.id)) stopRequests.set(run.id, Date.now());
  await post(`${path()}/runs/${run.id}/${hard ? 'cancel' : 'interrupt'}`); await reloadProject();
}
function selectOption(select, value, label) {
  const wanted = String(value).toLowerCase();
  const option = Array.from(select.options).find(o => !o.disabled && (o.value.toLowerCase() === wanted || o.textContent.trim().toLowerCase() === wanted));
  if (!option) throw new Error(t('{label}不存在：{value}', {label, value}));
  if (select.disabled) throw new Error(t('{label}已固定，更换请新建对话。', {label}));
  select.value = option.value; select.dispatchEvent(new Event('change'));
  return option.textContent.trim();
}
// Commands that never reach the server. Returns false for the ones the queue or the CLI run.
async function runLocalCommand({name, args}) {
  const session = currentSession();
  switch (name) {
    case 'help': slashMenu.showAll(); return true;
    case 'stop': await stopActiveRun(); return true;
    case 'new': if (view.projectId) await createProjectSession(view.projectId); return true;
    case 'model': if (!args) throw new Error(t('用法：/model <模型>')); note(t('模型：{value}', {value: selectOption($('#model'), args, t('模型'))})); return true;
    case 'effort': if (!args) throw new Error(t('用法：/effort <low|medium|high|xhigh|max>')); note(t('Effort：{value}', {value: selectOption($('#effort'), args, 'Effort')})); return true;
    case 'mode': {
      const modes = {auto:'auto', default:'default', cli:'default', plan:'read-only', 'read-only':'read-only', readonly:'read-only', write:'project-write', 'project-write':'project-write', edit:'project-write'};
      if (!modes[args.toLowerCase()]) throw new Error(t('用法：/mode <auto|cli|plan|write>'));
      note(t('执行权限：{value}', {value: selectOption($('#permission'), modes[args.toLowerCase()], t('执行权限'))})); return true;
    }
    case 'rename': {
      if (!session) return true; if (!args) throw new Error(t('用法：/rename <标题>'));
      await api(`${path()}/sessions/${encodeURIComponent(session.id)}`, {method:'PATCH', body:{title: args}}); await reloadProject(); return true;
    }
    case 'status': {
      if (!session) return true;
      const native = nativeOf(session), last = (view.project?.runs || []).filter(r => r.sessionId === session.id).at(-1);
      const host = view.bootstrap.hosts.find(h => h.id === session.hostId);
      const parts = [host ? host.name : t('未绑定电脑'), session.profileId ? accountName(session.profileId, last) : '—', last?.actualModel || session.model || '—', last?.actualReasoningEffort ? `effort ${last.actualReasoningEffort}` : null, native?.connected ? t('原生会话已连接') + (native.busy ? t('（执行中）') : '') : t('原生会话未连接'), last?.usage?.sessionTotal?.totalTokens ? t('会话累计 {n} tokens', {n: last.usage.sessionTotal.totalTokens}) : null];
      note(parts.filter(Boolean).join(' · ')); return true;
    }
    default: return false;
  }
}
$('#stop').addEventListener('click', () => attempt(stopActiveRun));
$('#queue-send').addEventListener('click', () => { sendMode = 'queue'; $('#composer').requestSubmit(); });
$('#files-upload').addEventListener('click', () => { if (!view.projectId) return showError(new Error(t('请先打开项目'))); $('#files-input').click(); });
$('#files-input').addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; attempt(() => uploadToProject(files)); });

const creatingSessions = new Set();
async function createProjectSession(projectId, categoryId) {
  if (creatingSessions.has(projectId)) return;
  creatingSessions.add(projectId);
  const navigationVersion = loadVersion;
  renderNavigation();
  try {
    // Bind the request to the clicked project, even if another project is selected.
    const session = await post(`${projectURL(projectId)}/sessions`,{title:t('新会话')});
    if (categoryId) await api(`${projectURL(projectId)}/sessions/${encodeURIComponent(session.id)}`,{method:'PATCH',body:{categoryId}}).catch(showError);
    navigation.expand(projectId);
    if (navigationVersion === loadVersion) await selectProject(projectId,session.id);
  } finally {
    creatingSessions.delete(projectId);
    renderNavigation();
  }
}
// Conversations whose agent finished or needs an answer since anyone last looked; the open
// project's own copy is the freshest.
const unreadOf = project => (project.id === view.projectId && view.project ? view.project.project.unread : project.unread) || {};
const attention = mark => ['failed','interrupted','waiting'].includes(mark.status);
// Conversations with a run executing now. The open project's own runs are the freshest; others
// come from the project list (a server without this field shows none).
const runningOf = project => project.id === view.projectId && view.project ? [...new Set(view.project.runs.filter(r => r.status === 'running' && r.sessionId).map(r => r.sessionId))] : project.running || [];
function runningMark() {
  const el = node('span','nav-spinner'); el.title = t('运行中'); el.setAttribute('role','img'); el.setAttribute('aria-label',el.title);
  return el;
}
function unreadDot(marks) {
  if (!marks.length) return null;
  const urgent = marks.some(attention), dot = node('span',`unread-dot${urgent ? ' attention' : ''}`);
  dot.title = t(urgent ? '需要你查看' : '有新结果'); dot.setAttribute('role','img'); dot.setAttribute('aria-label',dot.title);
  return dot;
}
// The open conversation counts as seen while the page is visible. The mark is dropped locally
// at once (refreshes racing the request must not bring the dot back) and on the server.
const seenRequests = new Set();
function markSeen() {
  const projectId = view.projectId, sessionId = view.sessionId, mark = view.project?.project.unread?.[sessionId];
  if (!mark || document.hidden) return;
  delete view.project.project.unread[sessionId];
  const listed = view.bootstrap.projects.find(p => p.id === projectId)?.unread;
  if (listed?.[sessionId] && listed[sessionId].at <= mark.at) delete listed[sessionId];
  renderNavigation();
  const key = `${projectId}:${sessionId}:${mark.at}`;
  if (seenRequests.has(key)) return;
  seenRequests.add(key);
  post(`${projectURL(projectId)}/sessions/${encodeURIComponent(sessionId)}/seen`,{at:mark.at}).catch(() => {}).finally(() => seenRequests.delete(key));
}
document.addEventListener('visibilitychange', markSeen);
// Names of every registered server, online or not, so labels survive a host going offline.
async function loadHostNames() { for (const host of await api('/api/hosts')) view.hostNames.set(host.id, host.name || host.id); navigationSignature = ''; renderNavigation(); }
const hostName = id => view.bootstrap?.hosts?.find(h => h.id === id)?.name || view.hostNames.get(id) || id;
// The top bar names every server this page reaches, the serving one first.
function renderConnectedHosts() { $('#machine-label').textContent = t('已连接：{names}',{names:(view.bootstrap?.hosts || []).map(h => h.name || h.id).join(' · ')}); }
// Where a project's files are: only on its owner, or synced to several hosts.
const projectPlace = project => isSynced(project) ? t('同步 · {names}',{names:readyHosts(project).map(hostName).join('、')}) + (project.diverged ? ' · ' + t('有冲突') : '') : project.ownerHostId ? t('仅 {name}',{name:hostName(project.ownerHostId)}) : '';
// The project tree (navigation.js). The open project's own records are the freshest; the others
// come from the project list, which carries each project's chats and categories.
const navigation = createNavigation($('#project-list'), $('#drag-hint'), {
  selectedSession: () => view.sessionId, language: getLanguage, runningMark, unreadDot,
  selectProject: id => attempt(() => selectProject(id)),
  selectSession: (projectId, sessionId) => projectId === view.projectId && view.project ? selectSession(sessionId) : attempt(() => selectProject(projectId, sessionId)),
  newChat: (projectId, categoryId) => attempt(() => createProjectSession(projectId, categoryId)),
  projectActions, sessionActions, categoryActions,
  moveSession: (project, sessionId, categoryId) => attempt(() => moveSession(project, sessionId, categoryId)),
  groupSessions: (project, sessionIds) => attempt(() => groupSessions(project, sessionIds)),
});
function renderNavigation() {
  const projects = visibleItems(view.bootstrap.projects);
  notifyResults(projects, unreadOf, mark => statuses[mark.status] || mark.status);
  navigation.render(projects.map(project => {
    const current = project.id === view.projectId && view.project?.project.id === project.id, record = current ? view.project.project : project;
    return { project, current, full: true, place: projectPlace(project), unread: unreadOf(project), running: runningOf(project), creating: creatingSessions.has(project.id),
      categories: record.categories || [], sessions: current ? visibleItems(view.project.sessions) : project.sessions || [] };
  }));
}
// A fork is a new conversation that starts from an agent summary of this one; the user
// picks its computer and account on the first send, limited to computers with the project's files.
async function forkSession(project,session) {
  const fork=await post(`${projectURL(project.id)}/sessions/${session.id}/fork`);
  await selectProject(project.id,fork.id);
}
const sessionURL = (project, id) => `${projectURL(project.id)}/sessions/${encodeURIComponent(id)}`;
const categoryURL = (project, id) => `${projectURL(project.id)}/categories${id ? '/' + encodeURIComponent(id) : ''}`;
function projectActions(project) {
  return [
    {label:t('新建对话'),run:()=>attempt(()=>createProjectSession(project.id))},
    {label:t('新增分类'),run:()=>openNameDialog({heading:'新增分类',label:'分类名称',value:'',projectId:project.id,submit:name=>post(categoryURL(project),{name})})},
    {label:t('项目设置…'),run:()=>openProjectSettings(project,{hosts:()=>view.bootstrap?.hosts||[],hostName,lifecycle:action=>attempt(()=>updateLifecycle(project,null,action))})},
    {label:t('归档项目'),run:()=>attempt(()=>updateLifecycle(project,null,'archive'))},
    {label:t('删除项目'),danger:true,run:()=>attempt(()=>updateLifecycle(project,null,'delete'))},
  ];
}
function sessionActions(project,session,{fork,category}={}) {
  return [
    {label:t('重命名'),run:()=>openNameDialog({heading:'重命名对话',label:'对话标题',value:session.title,projectId:project.id,submit:title=>api(sessionURL(project,session.id),{method:'PATCH',body:{title}})})},
    {label:t('分叉到新对话'),run:()=>attempt(()=>forkSession(project,session))},
    ...(fork?[{label:t('脱离为独立会话'),run:()=>attempt(()=>detachSession(project,session))}]:[]),
    ...(category&&!fork?[{label:t('移出分类'),run:()=>attempt(()=>moveSession(project,session.id,null))}]:[]),
    {label:t('归档对话'),run:()=>attempt(()=>updateLifecycle(project,session,'archive'))},
    {label:t('删除对话'),danger:true,run:()=>attempt(()=>updateLifecycle(project,session,'delete'))},
  ];
}
function categoryActions(project,category) {
  return [
    {label:t('在此分类新建对话'),run:()=>attempt(()=>createProjectSession(project.id,category.id))},
    {label:t('重命名分类'),run:()=>openNameDialog({heading:'重命名分类',label:'分类名称',value:category.name,projectId:project.id,submit:name=>api(categoryURL(project,category.id),{method:'PATCH',body:{name}})})},
    {label:t('取消分组（保留对话）'),run:()=>attempt(()=>ungroupCategory(project,category))},
  ];
}
// Tree edits change both the project list (other projects' trees) and the open project.
async function afterTreeChange(projectId) { view.bootstrap.projects = await api('/api/projects'); if (view.projectId === projectId) await reloadProject(); else renderNavigation(); }
async function moveSession(project,sessionId,categoryId) { await api(sessionURL(project,sessionId),{method:'PATCH',body:{categoryId}}); if (categoryId) navigation.expandCategory(categoryId); await afterTreeChange(project.id); }
async function groupSessions(project,sessionIds) {
  const category = await post(categoryURL(project),{name:t('新分类'),sessionIds}); await afterTreeChange(project.id);
  openNameDialog({heading:'命名新分类',label:'分类名称',value:category.name,projectId:project.id,submit:name=>api(categoryURL(project,category.id),{method:'PATCH',body:{name}})});
}
async function ungroupCategory(project,category) { await api(categoryURL(project,category.id),{method:'DELETE'}); await afterTreeChange(project.id); }
async function detachSession(project,session) { await post(`${sessionURL(project,session.id)}/detach`); await afterTreeChange(project.id); }
// One small naming dialog serves chat titles and category names.
let nameTarget;
function openNameDialog({heading,label,value,projectId,submit}) {
  nameTarget={projectId,submit};
  const title=$('#rename-heading'),caption=$('#rename-label'),input=$('#rename-title');
  title.dataset.i18n=heading;title.textContent=t(heading);caption.dataset.i18n=label;caption.textContent=t(label);
  input.maxLength=label==='分类名称'?60:120;input.value=value;input.setCustomValidity('');
  $('#rename-error').textContent=''; showDialog('#rename-dialog'); input.focus(); input.select();
}
$('#rename-title').addEventListener('input',()=>$('#rename-title').setCustomValidity(''));
$('#rename-form').addEventListener('submit',async event=>{
  event.preventDefault(); const input=$('#rename-title'),value=input.value.trim();
  if(!value){input.setCustomValidity(t('请输入名称'));input.reportValidity();return;}
  const target={...nameTarget},save=$('#rename-save');save.disabled=true;$('#rename-error').textContent='';
  try{ await target.submit(value); $('#rename-dialog').close(); await afterTreeChange(target.projectId); }
  catch(error){$('#rename-error').textContent=t(error.message);}
  finally{save.disabled=false;}
});
function confirmLifecycle(project,session,action) {
  const dialog=$('#lifecycle-dialog');
  if(dialog.open)return Promise.resolve(false);
  const deleting=action==='delete';
  $('#lifecycle-title').textContent=t(deleting?(session?'删除对话':'删除项目'):(session?'归档对话':'归档项目'));
  $('#lifecycle-name').textContent=session?.title || project.name;
  $('#lifecycle-description').textContent=t(deleting
    ? (session?'删除后，该对话及其消息记录将无法在平台恢复。':'删除后，该项目的文件夹、对话记录和各电脑上的 agent 会话记录都会被永久删除，无法恢复。')
    : (session?'归档后，对话将从列表隐藏，可在设置中恢复。':'归档后，项目及其对话将从列表隐藏，可在设置中恢复。'));
  const confirm=$('#lifecycle-confirm');
  confirm.textContent=t(deleting?'确认删除':'确认归档');confirm.className=deleting?'primary danger':'primary';
  dialog.returnValue='';
  return new Promise(resolve=>{
    dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true});
    showDialog('#lifecycle-dialog');$('#lifecycle-cancel').focus();
  });
}
const lifecyclePending=new Set();
async function updateLifecycle(project,session,action) {
  const key=`${project.id}:${session?.id || ''}`;
  if(lifecyclePending.has(key))return;
  lifecyclePending.add(key);
  try {
  if(['archive','delete'].includes(action)&&!await confirmLifecycle(project,session,action))return;
  await post(`${projectURL(project.id)}/${session?`sessions/${session.id}/`:''}lifecycle`,{action});
  if(action==='delete'&&session){view.drafts.delete(`${project.id}:${session.id}`);view.attachments.delete(`${project.id}:${session.id}`);}
  view.bootstrap.projects=await api('/api/projects');await reconcileSelection();
  if($('#settings-dialog').open)await renderArchives();
  } finally { lifecyclePending.delete(key); }
}
async function reconcileSelection() {
  if(projectSelectionPending)return;
  const projects=visibleItems(view.bootstrap.projects),selected=projects.find(p=>p.id===view.projectId);
  if(selected) await reloadProject();
  else if(projects.length)await selectProject(projects[0].id);
  else {view.projectId=null;view.sessionId=null;view.project=null;tabs.showProject(null);$('#prompt').value='';messageSignature='';renderNavigation();renderConversation();renderPath();renderArtifacts();$('#files').replaceChildren();remember();}
}
function renderConversation() {
  const session = view.project?.sessions.find(item => item.id === view.sessionId);
  $('#session-title').textContent = session?.title || (view.project ? t('创建会话') : t('选择项目'));
  $('#project-title').textContent = view.project?.project.name || '';
  const writable=session && category(session)==='active' && category(view.project.project)==='active';
  const machineOnline=!session?.hostId||view.bootstrap.hosts.some(h=>h.id===session.hostId);
  // A conversation bound to a host that no longer has the project's files stays readable only.
  const allowedHosts=runHosts(view.project?.project),stranded=Boolean(session?.hostId&&allowedHosts&&!allowedHosts.includes(session.hostId));
  $('#prompt').disabled = !writable || stranded; $('#send').disabled = !writable || !machineOnline || stranded; $('#attach').disabled = !writable || stranded; dictation.setEnabled(writable && !stranded);
  renderAttachments();
  $('#prompt').placeholder=session&&!writable?t('已归档或删除，恢复后可继续对话'):stranded?t('此项目的文件只在 {hosts}，这个对话不能继续；请分叉到那里继续。',{hosts:allowedHosts.map(hostName).join('、')}):t('输入消息…');
  const messages = view.project?.messages.filter(message => message.sessionId === view.sessionId) || [];
  const runs = view.project?.runs.filter(run => run.sessionId === view.sessionId) || [];
  // While this conversation executes, sending steers that turn; the user can queue instead or stop.
  const activeRun = runs.filter(run => ['running','waiting'].includes(run.status)).at(-1);
  const steering = Boolean(activeRun && writable && machineOnline);
  $('#stop').hidden = !activeRun; $('#stop').disabled = !machineOnline;
  $('#stop').querySelector('span').textContent = activeRun && stopRequests.has(activeRun.id) && Date.now() - stopRequests.get(activeRun.id) > 12000 ? t('强制终止') : t('■ 停止');
  $('#queue-send').hidden = !steering;
  $('#send-label').textContent = t(steering ? '插话 ↑' : '发送 ↑');
  $('#prompt').placeholder = steering ? t('输入插话内容，Ctrl / ⌘ + Enter 发送给正在执行的 agent…') : $('#prompt').placeholder;
  for (const [id, at] of stopRequests) if (!runs.some(r => r.id === id && ['running','waiting'].includes(r.status)) && Date.now() - at > 60000) stopRequests.delete(id);
  choices.allowHosts?.(allowedHosts,Object.fromEntries(view.hostNames)); choices.bindSession?.(session,runs); renderModelNote();
  // The quota panel follows the composer's machine only when that changes (switching
  // conversations); a machine picked in the panel itself stays until then.
  const composerHost = $('#host').value || view.bootstrap?.hostId;
  if (composerHost !== lastComposerHost) { lastComposerHost = composerHost; usage.setHost(composerHost); }
  const native=Object.entries(view.project?.nativeRuntime||{}).find(([key])=>key.startsWith(`${view.projectId}:session:${view.sessionId}:`))?.[1];
  $('#session-title').title=native?.connected?t('原生会话在线')+(native.busy?t(' · 执行中'):t(' · 等待消息')):t('发送消息时建立或恢复原生会话');
  let nativeStatus=$('#native-session-status');
  if(!nativeStatus){nativeStatus=node('span','muted');nativeStatus.id='native-session-status';$('#project-title').after(nativeStatus);}
  // Which machine and account this conversation talks to, then the native session state.
  const boundRun=runs.at(-1),boundAccount=session?.profileId||boundRun?.profileId;
  const who=session&&boundAccount?[view.bootstrap.hosts.find(h=>h.id===(session.hostId||boundRun?.hostId))?.name,`${familyName(boundRun?.account?.family||view.bootstrap.hosts.flatMap(h=>h.profiles||[]).find(p=>p.id===boundAccount)?.family)} ${accountName(boundAccount,boundRun)}`.trim()].filter(Boolean).join(' · '):'';
  let forkLinks=$('#fork-links');
  if(!forkLinks){forkLinks=node('span','fork-links');forkLinks.id='fork-links';nativeStatus.after(forkLinks);}
  const link=(label,id)=>button(label,()=>selectSession(id),'quiet fork-link');
  const source=session?.forkOf&&view.project.sessions.find(s=>s.id===session.forkOf.sessionId);
  forkLinks.replaceChildren(...(source?[link(t('分叉自：{title}',{title:source.title}),source.id)]:[]),...(session?.forks||[]).map(id=>view.project.sessions.find(s=>s.id===id)).filter(s=>s&&category(s)==='active').map(s=>link(t('分叉：{title}',{title:s.title}),s.id)),...(stranded&&writable?[button(t('分叉以继续'),()=>attempt(()=>forkSession(view.project.project,session)),'quiet fork-link')]:[]));
  nativeStatus.textContent=session?[who,!machineOnline?t('执行电脑离线'):native?.connected?t('原生会话 · {status}',{status:native.busy?t('执行中'):t('已连接')}):t('原生会话 · 待连接')].filter(Boolean).join(' · '):'';
  const pending = view.project ? outboxFor(view.sessionId) : [];
  const signature = JSON.stringify([getLanguage(),view.projectId,view.sessionId,messages,runs,pending.map(p => [p.requestId,p.failed,Boolean(p.sentAt)])]);
  if (signature !== messageSignature) {
    messageSignature = signature; const container = $('#messages');
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    // Some transports persist incremental output on runs until the final assistant message.
    const trailing = [];
    for (const run of runs.filter(run => ['running','waiting'].includes(run.status))) {
      if (!messages.some(message => message.runId === run.id && message.role === 'assistant') && (run.output || run.partialText)) { const article = node('article','message message-assistant'); article.append(node('div','message-header',`${run.profileId} · ${statuses[run.status]}`),node('div','message-body',run.output || run.partialText)); trailing.push(article); }
    }
    syncMessages(container,messages,runs,trailing,{pending,scope:`${view.projectId}:${view.sessionId}`});
    if (!container.childNodes.length) container.append(empty(session ? writable ? t('发送消息开始这个会话。') : t('恢复后可继续这个对话。') : view.project ? category(view.project.project)==='active' ? t('新建会话后选择 agent 发送消息。') : t('暂无对话。') : t('打开一个项目以开始。')));
    if (nearBottom || !messages.length) container.scrollTop = container.scrollHeight;
  }
  const queueId = `session:${view.sessionId}`;
  renderRuns($('#queue'), runs, view.project?.queues?.[queueId], runId => attempt(async () => { await post(`${path()}/runs/${runId}/cancel`); await reloadProject(); }), () => attempt(async () => { await post(`${path()}/queues/resume`,{queueId}); await reloadProject(); }), async (runId,id,input)=>{await post(`${path()}/runs/${runId}/approvals/${id}`,input);await reloadProject();},runId=>attempt(async()=>{await post(`${path()}/runs/${runId}/continue`);await reloadProject();}),`${view.projectId}:${queueId}`,
    runId => attempt(async () => { if (!stopRequests.has(runId)) stopRequests.set(runId, Date.now()); await post(`${path()}/runs/${runId}/interrupt`); await reloadProject(); }), stopRequests);
  markSeen();
}
function selectSession(id) {
  view.drafts.set(draftKey(),$('#prompt').value); flushDraft(draftKey()); view.sessionId = id; openDraft(); messageSignature = ''; renderNavigation(); renderConversation(); remember(); closeDrawer(); $('#messages').scrollTop = $('#messages').scrollHeight;
}
async function selectProject(id, sessionId) {
  const version=++loadVersion;projectSelectionPending=true;
  try {
  view.drafts.set(draftKey(),$('#prompt').value); flushDraft(draftKey());
  let state;
  try { state = await api(projectURL(id)); }
  catch (error) {
    if(version!==loadVersion)return;
    const registered = view.bootstrap.projects.find(project => project.id === id);
    if (error.status !== 409 || !registered) throw error;
    view.projectId = id; view.sessionId = null; view.project = {project:registered,sessions:[],messages:[],runs:[],artifacts:[],annotations:[],queues:{}}; artifactStatus.clear(); tabs.showProject(id);
    $('#prompt').value = ''; renderNavigation(); renderConversation(); renderPath(); renderArtifacts(); $('#files').replaceChildren(empty(t('项目所在电脑上线后可读取文件。'))); showError(error); return;
  }
  if (version !== loadVersion) return;
  if (view.projectId !== id) artifactStatus.clear();
  view.projectId = id; view.project = state; tabs.showProject(id);
  view.sessionId = visibleItems(state.sessions).some(session => session.id === sessionId) ? sessionId : visibleItems(state.sessions).at(-1)?.id || null;
  openDraft(); messageSignature = '';
  renderNavigation(); renderConversation(); renderArtifacts(); renderPath(); remember(); closeDrawer(); attempt(pollArtifacts); await loadFiles(); $('#messages').scrollTop = $('#messages').scrollHeight;
  } finally { if(version===loadVersion)projectSelectionPending=false; }
}
async function reloadProject() {
  if (!view.projectId) return;
  const id = view.projectId, state = await api(projectURL(id)); if (view.projectId !== id || projectSelectionPending) return;
  view.project = state;
  if(!visibleItems(state.sessions).some(s=>s.id===view.sessionId)){view.sessionId=visibleItems(state.sessions).at(-1)?.id||null;openDraft();remember();}
  renderNavigation(); renderConversation(); renderArtifacts(); renderPath();
}
// Uncommitted streamed output only changes the executing runs, so a run.live tick refreshes
// them from the small runtime view; every other change still reloads the whole project.
async function refreshRuntime() {
  if (!view.projectId || !view.project || projectSelectionPending) return;
  const id = view.projectId, live = await api(`${projectURL(id)}/runtime`);
  if (view.projectId !== id || projectSelectionPending || view.project?.project.id !== id) return;
  mergeRuntime(view.project, live, view.bootstrap.hostId);
  renderConversation();
}
function renderPath() { if(view.project?.storageWarning)showError(new Error(t('记录阅读视图更新失败：')+view.project.storageWarning)); const el = $('#project-path'); el.replaceChildren(node('span','',t('项目目录')),node('code','',view.project?.project.path || '—')); }
async function loadFiles() {
  if (!view.projectId) return;
  const id = view.projectId, result = await api(`${projectURL(id)}/files`); if (view.projectId !== id) return;
  // Top-level folders that were open stay open, so a refresh after an upload does not collapse them.
  const open = new Set([...$('#files').querySelectorAll(':scope > details[open] > summary')].map(summary => summary.textContent));
  $('#files').replaceChildren(); appendFiles($('#files'), result, id);
  for (const folder of $('#files').querySelectorAll(':scope > details')) if (open.has(folder.querySelector(':scope > summary')?.textContent)) folder.open = true;
}
function appendFiles(container, entries, projectId) {
  if (!entries.length) { const label=empty(t('目录为空')); label.dataset.i18n='目录为空'; container.append(label); return; }
  const open = tabs.activeTab();
  for (const entry of entries) {
    if (entry.type === 'directory') {
      const folder = node('details'), summary = node('summary','',entry.name), children = node('div'); folder.append(summary,children); let loaded = false;
      folder.addEventListener('toggle', () => { if (folder.open && !loaded) attempt(async () => { const result = await api(`${projectURL(projectId)}/files?path=${encodeURIComponent(entry.path)}`); children.replaceChildren(); appendFiles(children,result,projectId); loaded = true; }); }); container.append(folder);
    } else {
      const file = button(entry.name, () => tabs.open(projectId, {kind:'file', path:entry.path}), `tree-file${open?.kind === 'file' && open.path === entry.path ? ' current' : ''}`);
      file.dataset.path = entry.path; file.title = entry.path; container.append(file);
    }
  }
}
// The file tree and the Artifact list mark what the side pane shows.
function markOpenResource(tab) {
  document.querySelectorAll('#files .tree-file.current, #artifact-list .artifact-row.current').forEach(el => el.classList.remove('current'));
  if (tab?.kind === 'file') document.querySelectorAll('#files .tree-file').forEach(el => { if (el.dataset.path === tab.path) el.classList.add('current'); });
  if (tab?.kind === 'artifact') document.querySelector(`#artifact-list .artifact-row[data-artifact-id="${CSS.escape(tab.artifactId)}"]`)?.classList.add('current');
}
// Artifacts: play / pause in the list, ∞ runs it persistently (its own server, outside Studiolo, until
// stopped), the row opens it as a tab of the side pane, ↗ in a window of its own. Status is read when a
// project opens and every few seconds while the list is visible.
const artifactBusy = new Map();
const artifactURL = (projectId, id) => `${projectURL(projectId)}/artifacts/${encodeURIComponent(id)}`;
const artifactPage = (projectId, id) => `/artifact.html?project=${encodeURIComponent(projectId)}&artifact=${encodeURIComponent(id)}`;
const browsePage = (projectId, id) => `/open.html?project=${encodeURIComponent(projectId)}&artifact=${encodeURIComponent(id)}`;
function iconButton(name, label, action, className = '') { const el = button('', action, `icon-btn ${className}`.trim()); el.title = label; el.setAttribute('aria-label', label); el.append(icon(name)); return el; }
function renderArtifacts() {
  const artifacts = view.project?.artifacts || [];
  const signature = JSON.stringify([getLanguage(),view.projectId,artifacts.map(a=>[a.id,a.name,a.root,a.entry,Boolean(a.command)]),view.project?.artifactDiscoveryError,artifacts.map(a=>{const s=artifactStatus.get(a.id);return s?[s.running,s.error||'',s.persistent?.running,s.persistent?.port,s.persistent?.error||'']:null;}),[...artifactBusy]]);
  if (signature !== artifactSignature) {
    artifactSignature = signature;
    const list = $('#artifact-list'); list.replaceChildren();
    for (const artifact of artifacts) {
      const status = artifactStatus.get(artifact.id), busy = artifactBusy.has(artifact.id), resident = Boolean(status?.persistent?.running), running = Boolean(status?.running) || resident;
      const row = node('div','artifact-row'), main = node('div','a-main'), sub = node('div','a-sub');
      row.dataset.artifactId = artifact.id; row.tabIndex = 0; row.setAttribute('role','button'); row.title = `${artifact.root}/${artifact.entry}`;
      main.append(node('div','a-name',artifact.name),sub);
      if (busy) sub.append(node('i','spinner'),node('span','',t(artifactBusy.get(artifact.id) === 'stop' ? '正在停止…' : '正在启动…')));
      else if (resident) sub.append(node('i','run-dot resident'),node('span','',t('常驻 · 端口 {port}',{port:status.persistent.port})));
      else if (status?.error || status?.persistent?.error) sub.append(node('span','err',t('出错')),node('span','',status.error || t(status.persistent.error)));
      else if (running) sub.append(node('i','run-dot'),node('span','',t('运行中')));
      else sub.append(node('span','',t(artifact.command ? '后端 · 未运行' : '静态网页 · 未运行')));
      const play = iconButton(running ? 'i-pause' : 'i-play', t(running ? '停止' : '启动'), () => attempt(() => changeArtifact(artifact, running ? 'stop' : 'start')), 'play'); play.disabled = busy;
      const persist = iconButton('i-persist', t(resident ? '停止常驻运行' : '常驻运行：作为独立服务器运行，Studiolo 关闭后继续'), () => attempt(() => changeArtifact(artifact, resident ? 'stop' : 'persist')), 'persist'); persist.disabled = busy; persist.setAttribute('aria-pressed', String(resident));
      // Two ways out of the workbench: edit mode (the Artifact with its comments and toolbar) and browse
      // mode (the Artifact alone, like any web application).
      const windowLink = (href, label, name) => { const link = node('a','icon-btn'); link.href = href; link.target = '_blank'; link.rel = 'noopener'; link.title = label; link.setAttribute('aria-label', label); link.append(icon(name)); return link; };
      row.append(main,play,persist,windowLink(artifactPage(view.projectId, artifact.id), t('在新窗口中以编辑模式打开'), 'i-annotate'),windowLink(browsePage(view.projectId, artifact.id), t('在新窗口中打开（仅浏览）'), 'i-external'));
      const openTab = () => tabs.open(view.projectId, {kind:'artifact', artifactId:artifact.id});
      row.addEventListener('click', event => { if (!event.target.closest('button, a')) openTab(); });
      row.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target === row) { event.preventDefault(); openTab(); } });
      list.append(row);
    }
    if (view.project?.artifactDiscoveryError) list.append(node('p','run-error',view.project.artifactDiscoveryError));
    if (!artifacts.length) list.append(empty(t('暂无 Artifact。')));
    markOpenResource(tabs.activeTab());
  }
  $('#artifacts-running').hidden = !artifacts.some(a => artifactStatus.get(a.id)?.running || artifactStatus.get(a.id)?.persistent?.running);
  $('[data-resource="artifacts"] span').textContent = `Artifacts${artifacts.length ? ' ' + artifacts.length : ''}`;
  tabs.refresh();
}
async function changeArtifact(artifact, action) {
  const projectId = view.projectId; artifactBusy.set(artifact.id, action); renderArtifacts();
  try { const result = await post(`${artifactURL(projectId, artifact.id)}/${action}`); if (view.projectId === projectId) artifactStatus.set(artifact.id, action === 'stop' ? {running:false} : result); }
  finally { artifactBusy.delete(artifact.id); if (view.projectId === projectId) { renderArtifacts(); tabs.reloadArtifact(projectId, artifact.id); } }
}
let artifactPolling = false;
async function pollArtifacts() {
  const projectId = view.projectId, artifacts = view.project?.artifacts || [];
  if (!projectId || artifactPolling || !artifacts.length) return;
  artifactPolling = true;
  try {
    // An unreachable host reads as "not running" here; the Artifact page itself explains why.
    await Promise.all(artifacts.map(async artifact => { const status = await api(`${artifactURL(projectId, artifact.id)}/status`).catch(() => ({running:false})); if (view.projectId === projectId && !artifactBusy.has(artifact.id)) artifactStatus.set(artifact.id, status); }));
  } finally { artifactPolling = false; }
  if (view.projectId === projectId) renderArtifacts();
}
setInterval(() => { if (!document.hidden && view.resource === 'artifacts' && !document.body.classList.contains('right-closed')) attempt(pollArtifacts); }, 6000);
// Every registered server (machine.json of the serving server), online or not. Registering one
// registers this server on it too; removing tells it the same.
// Releases are dotted numbers (0.2.0); a missing part counts as 0.
function compareVersions(a, b) { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return Math.sign(d); } return 0; }
async function renderHosts() {
  const list = $('#host-list'); list.replaceChildren();
  const local = view.bootstrap?.hosts?.find(h => h.local);
  if (local) { const row = node('div','host-item'); row.append(node('span','',local.name || local.id),node('small','muted',t('本机'))); list.append(row); }
  let peers;
  try { peers = await api('/api/hosts'); } catch (error) { list.append(node('p','run-error',error.message)); return; }
  for (const host of peers) {
    const row = node('div','host-item'), name = node('span','',host.name || host.id);
    name.append(node('small','muted host-url',host.url || ''));
    const remove = async () => { if (!confirm(t('移除 {name}？对方也会移除本机；已有对话的历史保留。',{name:host.name || host.id}))) return; await api(`/api/hosts/${encodeURIComponent(host.id)}`,{method:'DELETE'}); await refreshHosts(); };
    row.append(name,node('small','badge',t(host.online ? '在线' : '离线')),button(t('编辑'),() => editHost(host),'quiet'),button(t('移除'),() => attempt(remove),'quiet danger'));
    list.append(row);
  }
}
async function refreshHosts() { view.bootstrap = await api('/api/bootstrap'); setAccountDirectory(view.bootstrap.hosts); choices.updateHosts(view.bootstrap.hosts); renderConnectedHosts(); await renderHosts(); await loadHostNames(); attempt(renderDevices); }
// Device allowlist (README「设备白名单」): every server lists the browsers and apps that registered
// with it; approving, revoking and token creation reach a peer through /api/hosts/:id/devices.
const deviceStatus = { pending: '待批准', approved: '已批准', revoked: '已吊销' };
// Settings → 语音转写: one OpenAI key on one machine (like an account); every server sends recordings there.
async function renderTranscription() {
  const status = $('#transcription-status'), form = $('#transcription-form'); if (!status) return;
  const data = await api('/api/settings/transcription'), hosts = view.bootstrap?.hosts || [];
  const picker = form.elements.host; picker.replaceChildren();
  for (const host of [...hosts.filter(h => h.local), ...hosts.filter(h => !h.local)]) picker.add(new Option(host.name || host.id, host.id));
  picker.value = data.hostId || hosts.find(h => h.local)?.id || '';
  status.replaceChildren();
  if (data.hostId) { const row = node('div','host-item'); const name = node('span','',`OpenAI · ${data.hostName || data.hostId}`); name.append(node('small','muted host-url',t('密钥 {hint}',{hint:data.hint || '…'}))); row.append(node('i','run-dot'),name); status.append(row); }
  else status.append(node('p','small muted',t('未设置。保存一个 OpenAI API key 后，聊天和批注输入框旁会出现麦克风按钮。')));
  $('#transcription-remove').hidden = !data.hostId;
  form.elements.apiKey.placeholder = data.hostId ? t('输入新的 key 以替换') : 'sk-…';
  syncDictation(Boolean(data.hostId));
}
$('#transcription-form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget, submit = form.querySelector('[type=submit]'); submit.disabled = true; attempt(async () => { try { await api('/api/settings/transcription',{method:'PUT',body:{provider:form.elements.provider.value,hostId:form.elements.host.value,apiKey:form.elements.apiKey.value}}); form.elements.apiKey.value = ''; await renderTranscription(); } finally { submit.disabled = false; } }); });
$('#transcription-remove').addEventListener('click', () => attempt(async () => { if (!confirm(t('移除语音转写的 API key？麦克风按钮会隐藏。'))) return; await api('/api/settings/transcription',{method:'DELETE'}); await renderTranscription(); }));
async function renderDevices() {
  const list = $('#device-list'), form = $('#device-token-form'); if (!list) return; list.replaceChildren();
  const hosts = view.bootstrap?.hosts || [], ordered = [...hosts.filter(h => h.local), ...hosts.filter(h => !h.local)];
  const picker = form.elements.host, chosen = picker.value; picker.replaceChildren(); for (const host of ordered) picker.add(new Option(host.name || host.id, host.id)); if (chosen) picker.value = chosen;
  for (const host of ordered) {
    const base = host.local ? '/api' : `/api/hosts/${encodeURIComponent(host.id)}`;
    let data; try { data = await api(`${base}/devices`); } catch (error) { list.append(node('p','run-error',`${host.name || host.id}: ${error.message}`)); continue; }
    const head = node('div','device-host'); head.append(node('strong','',host.name || host.id)); if (!data.enabled) head.append(node('small','muted',t('未启用设备白名单（tailnet.json 的 deviceAllowlist）'))); list.append(head);
    if (!data.enabled) continue;
    if (!data.devices.length) list.append(node('p','small muted',t('还没有设备登记。')));
    for (const device of data.devices) {
      const row = node('div','host-item device-item'), name = node('span','',device.name);
      name.append(node('small','muted host-url',[device.fingerprint, device.kind === 'token' ? t('接入令牌') : '', device.lastSeenAt ? t('最近 {time}',{time:time(device.lastSeenAt)}) : ''].filter(Boolean).join(' · ')));
      const act = async (method, suffix, body) => { await api(`${base}/devices/${encodeURIComponent(device.id)}${suffix}`,{method,body}); await renderDevices(); };
      row.append(name, node('small',`badge device-${device.status}`,t(deviceStatus[device.status] || device.status)));
      if (device.id === data.current) row.append(node('small','muted',t('本设备')));
      if (device.status !== 'approved') row.append(button(t(device.status === 'pending' ? '批准' : '恢复'),() => attempt(() => act('POST','/approve')),'primary'));
      if (device.status === 'approved' && device.id !== data.current) row.append(button(t('吊销'),() => attempt(async () => { if (!confirm(t('吊销 {name}？它会立即失去访问。',{name:device.name}))) return; await act('POST','/revoke'); }),'quiet danger'));
      row.append(button(t('重命名'),() => attempt(async () => { const value = prompt(t('新的设备名称'),device.name); if (value === null || !value.trim() || value.trim() === device.name) return; await act('PATCH','',{name:value.trim()}); }),'quiet'));
      if (device.id !== data.current) row.append(button(t('删除'),() => attempt(async () => { if (!confirm(t('删除 {name}？它下次连接时需要重新批准。',{name:device.name}))) return; await act('DELETE',''); }),'quiet danger'));
      list.append(row);
    }
  }
}
$('#device-token-form')?.addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget, result = $('#device-token-result'); submitForm(form, async body => {
  const local = view.bootstrap?.hosts?.find(h => h.local), base = !body.host || body.host === local?.id ? '/api' : `/api/hosts/${encodeURIComponent(body.host)}`;
  const { device, secret } = await post(`${base}/devices/tokens`,{name:body.name});
  result.replaceChildren(node('span','',t('{name} 的接入令牌（只显示这一次）：',{name:device.name})),node('code','device-secret',secret)); result.hidden = false; form.elements.name.value = ''; await renderDevices();
}); });
function editHost(host) {
  const form = $('#host-form'); form.dataset.hostId = host.id; form.elements.name.value = host.name || ''; form.elements.url.value = host.url || ''; form.elements.token.value = '';
  form.elements.token.placeholder = t('留空则保持不变'); form.querySelector('[type=submit] span').textContent = t('保存电脑'); form.elements.name.focus();
}
function resetHostForm(form) { delete form.dataset.hostId; form.reset(); form.elements.token.placeholder = ''; form.querySelector('[type=submit] span').textContent = t('连接电脑'); }
// Subagent routing rules: a shared prompt the agents read; each machine appends its own accounts
// and quota when a conversation starts, so the preview shows what this server would send.
let subagentSettings = null;
async function renderSubagentSettings() {
  const status = $('#subagent-status'); status.textContent = t('正在读取…');
  try {
    subagentSettings = await api('/api/settings/subagents');
    $('#subagent-enabled').checked = subagentSettings.enabled !== false;
    $('#subagent-rules').value = subagentSettings.rules || '';
    $('#subagent-preview').textContent = subagentSettings.preview || (subagentSettings.previewError ? `${t('无法生成预览')}: ${subagentSettings.previewError}` : t(subagentSettings.enabled === false ? '已关闭：新对话不会收到子代理说明。' : '本机没有可用账号，新对话不会收到子代理说明。'));
    status.textContent = subagentSettings.updatedAt ? t('上次保存：{time}', {time: time(subagentSettings.updatedAt)}) : t('使用默认规则');
  } catch (error) {
    // A server still running the previous version has no settings route; say so instead of raising a notice.
    if (error.status === 404) { status.textContent = t('此服务器尚未启用子代理设置（需要重启服务）'); $('#subagent-preview').textContent = ''; return; }
    status.textContent = ''; throw error;
  }
}
async function saveSubagentSettings() {
  const status = $('#subagent-status'); status.textContent = t('正在保存…');
  await api('/api/settings/subagents', {method: 'PUT', body: {enabled: $('#subagent-enabled').checked, rules: $('#subagent-rules').value}});
  await renderSubagentSettings();
  status.textContent = t('已保存。新对话立即生效，进行中的对话在下一条消息收到更新。');
}
$('#subagent-save').addEventListener('click', () => attempt(saveSubagentSettings));
$('#subagent-reset').addEventListener('click', () => { if (subagentSettings) $('#subagent-rules').value = subagentSettings.defaultRules || ''; });
async function renderArchives() {
  const list=$('#archive-list');list.replaceChildren(empty(t('正在读取…')));
  try {
    const archived=await api('/api/archives');list.replaceChildren();
    list.append(node('h3','',t('已归档项目')));
    for(const project of archived.projects){const row=node('div','archive-row');row.append(node('span','',project.name),button(t('恢复项目'),()=>attempt(()=>updateLifecycle(project,null,'restore')),'quiet'));list.append(row);}
    if(!archived.projects.length)list.append(empty(t('无')));
    list.append(node('h3','',t('已归档对话')));
    for(const session of archived.sessions){
      const row=node('div','archive-row'),label=node('div');label.append(node('span','',session.title),node('small','muted',session.projectName));
      const restore=button(t('恢复对话'),()=>attempt(()=>updateLifecycle({id:session.projectId},session,'restore')),'quiet');restore.disabled=session.projectArchived;if(session.projectArchived)restore.title=t('请先恢复所属项目');row.append(label,restore);list.append(row);
    }
    if(!archived.sessions.length)list.append(empty(t('无')));
    for(const error of archived.errors || [])list.append(node('p','run-error',`${error.name}：${error.error}`));
  } catch(error){list.replaceChildren(node('p','run-error',error.message));}
}
async function submitForm(form, fn) {
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try { clearError(); await fn(formBody(form)); }
  catch (error) { showError(error); }
  finally { submit.disabled = false; }
}
$('#project-form').addEventListener('submit', event => { event.preventDefault(); submitForm(event.currentTarget, async body => { const project = await post('/api/projects',body); view.bootstrap.projects = await api('/api/projects'); $('#project-dialog').close(); event.target.reset(); if(category(project)!=='active')throw new Error(project.deletedAt?t('项目已删除，不能从平台恢复。'):t('项目已归档，请在设置中恢复。')); await selectProject(project.id); }); });
$('#host-form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; submitForm(form, async body => {
  const id = form.dataset.hostId;
  if (id) { const change = {name: body.name, url: body.url}; if (body.token) change.token = body.token; await api(`/api/hosts/${encodeURIComponent(id)}`,{method:'PATCH',body:change}); }
  else { const added = await post('/api/hosts',body); if (added.mutual === false) showError(new Error(t('已连接 {name}，但它没能反向登记本机：{error}。请在那台电脑的设置里也添加本机。',{name:added.name,error:added.mutualError || ''}))); }
  resetHostForm(form); await refreshHosts();
}); });
$('#prompt').addEventListener('input', () => { view.drafts.set(draftKey(),$('#prompt').value); draftEdited(draftKey()); });
$('#prompt').addEventListener('blur', () => flushDraft(draftKey()));
// Back in this window: another device may have changed the open conversation's draft.
document.addEventListener('visibilitychange', () => { if (!document.hidden && document.activeElement !== $('#prompt')) { const key = draftKey(); refreshDraft(key, text => { if (draftKey() === key) $('#prompt').value = text; }); } });
$('#prompt').addEventListener('keydown', event => {
  if (slashMenu.handleKey(event)) { event.preventDefault(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('#composer').requestSubmit(); return; }
  // Esc stops the executing turn, like the terminal CLIs; the drawer handler only runs otherwise.
  if (event.key === 'Escape' && activeRunOf(currentSession()) && !$('#stop').hidden) { event.preventDefault(); event.stopPropagation(); attempt(stopActiveRun); }
});
// Sending is optimistic: the message shows at once (with a live status for a new turn) and the
// request follows in the background, in the order sent. The server's record later takes the
// message's place; a failed send stays in the conversation with retry and edit. Requests keep
// their id until accepted, so a retry never runs twice.
view.outbox = new Map();
function outboxFor(sessionId) {
  const {messages, runs} = view.project, list = [];
  for (const [id, request] of view.outbox) {
    if (request.projectId !== view.projectId) continue;
    const run = runs.find(r => r.requestId === id);
    const started = run && (!['queued','running'].includes(run.status) || messages.some(m => m.runId === run.id && m.role !== 'user'));
    if (recorded(request, messages, runs) && (!request.placeholder || !run || started) || request.sentAt && Date.now() - request.sentAt > 120000) { view.outbox.delete(id); continue; }
    if (request.sessionId === sessionId) list.push(request);
  }
  return list;
}
let sending = Promise.resolve();
async function deliver(request) {
  request.failed = null; request.sentAt = null; showOutbox(request);
  const send = () => post(`${projectURL(request.projectId)}/messages`,request.body), result = sending.then(send,send);
  sending = result.catch(() => {});
  try { await result; }
  catch (error) { request.failed = error.message || String(error); showOutbox(request); throw error; }
  request.sentAt = Date.now(); pendingRequests.delete(request.pendingKey);
  if (view.projectId === request.projectId) await reloadProject();
}
function showOutbox(request) { if (view.projectId === request.projectId && view.sessionId === request.sessionId) renderConversation(); }
$('#messages').addEventListener('studio:outbox', event => {
  const request = view.outbox.get(event.detail.requestId); if (!request) return;
  if (event.detail.action === 'retry') { attempt(() => deliver(request)); return; }
  // Back into the composer, ahead of anything typed since; attachments return with it.
  view.outbox.delete(request.requestId);
  const prompt = $('#prompt'), draft = draftKey() === request.draftKey ? prompt.value : view.drafts.get(request.draftKey) || '';
  const value = draft.trim() ? `${request.text}\n\n${draft}` : request.text;
  view.drafts.set(request.draftKey,value); draftEdited(request.draftKey);
  if (request.attachmentItems.length) view.attachments.set(request.draftKey,[...request.attachmentItems,...(view.attachments.get(request.draftKey) || [])]);
  if (draftKey() === request.draftKey) { prompt.value = value; prompt.focus(); }
  renderAttachments(); renderConversation();
});
$('#composer').addEventListener('submit', event => { event.preventDefault(); const mode = sendMode; sendMode = 'auto'; attempt(async () => {
  const text = $('#prompt').value.trim(), chosen = choices(); if (!text || !view.sessionId) return;
  const command = parseSlash(text);
  if (command && await runLocalCommand(command)) { $('#prompt').value = ''; draftSent(draftKey()); return; }
  if (!chosen.profileId) throw new Error(t('所选电脑没有可用的 CLI 入口。'));
  const pendingUploads = attachmentList().filter(item => item.status === 'uploading');
  if (pendingUploads.length) throw new Error(t('附件仍在上传，请稍候再发送。'));
  const attachmentItems = attachmentList().filter(item => item.status === 'ready'), attachments = attachmentItems.map(item => item.path);
  // Steer by default while a run executes; attachments and commands always queue.
  const active = activeRunOf(currentSession()), steer = mode !== 'queue' && !command && !attachments.length && Boolean(active);
  const originalKey = draftKey(), sessionId = view.sessionId, projectId = view.projectId;
  const signature = JSON.stringify({sessionId,text,attachments,steer,...chosen}), pendingKey = `${originalKey}:${signature}`;
  if (!pendingRequests.has(pendingKey)) pendingRequests.set(pendingKey,requestId());
  const id = pendingRequests.get(pendingKey); if (view.outbox.has(id) && !view.outbox.get(id).failed) return;
  const request = {requestId:id,projectId,sessionId,text,steer,attachments,attachmentItems,pendingKey,draftKey:originalKey,createdAt:new Date().toISOString(),
    agent:{profileId:chosen.profileId,model:chosen.model,reasoningEffort:chosen.reasoningEffort},placeholder:!steer && !active,steers:steer ? steerCount(view.project.messages,{sessionId,text}) : 0,
    body:{requestId:id,sessionId,text,...(attachments.length ? {attachments} : {}),...(steer ? {steer:true} : {}),...chosen}};
  view.outbox.set(id,request);
  $('#prompt').value = ''; draftSent(originalKey); view.attachments.delete(originalKey); renderAttachments();
  renderConversation();
  const messages = $('#messages'); messages.scrollTo({top:messages.scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
  await deliver(request);
}); });

async function start() {
  view.bootstrap = await bootstrap(); setAccountDirectory(view.bootstrap.hosts); choices = watchChoices(initChoices(view.bootstrap)); attempt(loadHostNames);
  const refreshAccounts = async () => { view.bootstrap = await api('/api/bootstrap'); setAccountDirectory(view.bootstrap.hosts); choices.updateHosts(view.bootstrap.hosts); choices.reloadProfiles?.(); usage.reload(); renderHosts(); messageSignature = ''; renderConversation(); };
  accountsUI = initAccounts({ hosts: () => view.bootstrap.hosts, localHostId: view.bootstrap.hostId, onChange: () => attempt(refreshAccounts) });
  usage = initAccountUsage({ hosts: () => view.bootstrap.hosts, localHostId: view.bootstrap.hostId, openAccounts: (hostId, accountId) => accountsUI.open(hostId, accountId) });
  $('#accounts-open').addEventListener('click', () => { $('#settings-dialog').close(); accountsUI.open($('#host').value || view.bootstrap.hostId); });
  $('#host').addEventListener('change', () => usage.setHost($('#host').value));
  syncDictation(Boolean(view.bootstrap.features?.voiceInput));
  renderConnectedHosts(); initFailover({ hosts: () => view.bootstrap?.hosts || [], selfId: () => view.bootstrap?.hostId });
  // Release check (CHANGELOG.md): this page runs the front end of the release it was loaded with. The
  // server reports its current release on every bootstrap, so after an update the page offers a reload;
  // peers and the desktop client report theirs, and Settings → 版本 flags any that differ.
  const page = { version: view.bootstrap.version, build: view.bootstrap.build };
  let latest = { ...page, clientVersion: view.bootstrap.clientVersion }, clientVersion = null, versionKey = '';
  const renderVersions = () => {
    const stale = Boolean(latest.build && page.build && latest.build !== page.build), hosts = view.bootstrap.hosts || [], local = hosts.find(h => h.local);
    const peers = hosts.filter(h => !h.local), mismatch = peers.some(h => h.version && h.version !== latest.version), oldClient = Boolean(clientVersion && latest.clientVersion && compareVersions(clientVersion, latest.clientVersion) < 0);
    const key = JSON.stringify([getLanguage(), page, latest, clientVersion, peers.map(h => [h.id, h.name, h.version])]);
    if (key === versionKey) return; versionKey = key;
    $('#update-banner').hidden = !stale;
    $('#update-text').textContent = latest.version && latest.version !== page.version ? t('Studiolo 已更新到 {version}，刷新页面以使用新版本。', {version: latest.version}) : t('Studiolo 已更新，刷新页面以使用新版本。');
    const badge = $('#version-badge'); badge.hidden = !page.version; badge.textContent = 'v' + page.version;
    badge.classList.toggle('attention', stale || mismatch || oldClient); badge.title = t('当前版本 {version}，点击查看详情', {version: page.version});
    const list = $('#version-info'); list.replaceChildren();
    const row = (label, version, note, warn) => { const item = node('div', 'host-item'); item.append(node('span', '', label), node('code', 'version-number', version || '—')); if (note) item.append(node('small', 'badge' + (warn ? ' warn' : ''), note)); list.append(item); };
    row(t('网页'), page.version, stale ? t('需要刷新') : '', stale);
    row(t('服务器（{name}）', {name: local?.name || view.bootstrap.hostId}), latest.version);
    for (const host of peers) row(t('服务器（{name}）', {name: host.name || host.id}), host.version, host.version && host.version !== latest.version ? t('版本不同') : '', true);
    if (clientVersion) row(t('桌面客户端'), clientVersion, oldClient ? t('有新版本 {version}', {version: latest.clientVersion}) : '', true);
    if (page.build) list.append(node('p', 'small muted', t('构建 {build}', {build: page.build})));
  };
  window.__TAURI__?.app?.getVersion?.().then(version => { clientVersion = version; renderVersions(); }).catch(() => {});
  $('#version-badge').addEventListener('click', () => { $('#settings-open').click(); $('#version-heading').scrollIntoView({block: 'start'}); });
  renderVersions(); onLanguageChange(renderVersions);
  const checkBuild = fresh => { latest = { version: fresh.version, build: fresh.build, clientVersion: fresh.clientVersion }; view.bootstrap.hosts = fresh.hosts; renderVersions(); };
  const ui = view.bootstrap.ui || {};
  if (ui.theme) setTheme(ui.theme); if (ui.language && ui.language !== getLanguage()) setLanguage(ui.language);
  document.querySelectorAll('[data-theme-picker]').forEach(el => el.addEventListener('change', () => savePreferences({theme:el.value})));
  document.querySelectorAll('[data-language-picker]').forEach(el => el.addEventListener('change', () => savePreferences({language:getLanguage()})));
  const previous = ui.selection || previousSelection(), projects=visibleItems(view.bootstrap.projects), project = projects.find(item => item.id === previous.projectId) || projects[0];
  if (project) await selectProject(project.id,previous.sessionId); else { renderNavigation(); renderConversation(); }
  // Run output and conversation events only touch their own project; the project list
  // changes only on reconnect, project-level events or a run starting or ending in another
  // project (its spinner), so most refreshes skip it.
  let listStale = false, fullStale = false;
  listenChanges(change => {
    // Drafts are saved on every pause in typing; open conversations fetch them on their own.
    if (change.type === 'session.draft') return;
    const listChanged = !change.projectId || change.reconnect || String(change.type || '').startsWith('project.') || change.projectId !== view.projectId && /^run\.(started|finished|failed|cancelled)$/.test(change.type);
    if (!listChanged && change.projectId !== view.projectId) return;
    listStale ||= listChanged;
    fullStale ||= listChanged || change.type !== 'run.live';
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; const list = listStale, full = fullStale; listStale = fullStale = false; attempt(async () => { if (list) { view.bootstrap.projects = await api('/api/projects'); await reconcileSelection(); } else if (full) await reloadProject(); else await refreshRuntime(); }); },180);
  });
  let polling = false;
  const poll = setInterval(async () => {
    if (document.hidden || polling) return;
    polling = true;
    try {
      const fresh = await api('/api/bootstrap');checkBuild(fresh);view.bootstrap.hosts=fresh.hosts;view.bootstrap.profiles=fresh.profiles;setAccountDirectory(fresh.hosts);choices.updateHosts(fresh.hosts);renderHosts();
      const projects = fresh.projects;
      if (JSON.stringify(projects) !== JSON.stringify(view.bootstrap.projects)) {
        view.bootstrap.projects = projects; await reconcileSelection();
      } else if (view.projectId) await reloadProject();
    } catch (error) { showError(error); } finally { polling = false; }
  },4000);
  // Browser discard clears timers; BFCache freezes and restores this visibility-gated poll.
}
onLanguageChange(() => {
  if (!view.bootstrap) return;
  // Re-render presentation only; drafts, choices, selected sessions and project data stay intact.
  const scroll = $('#messages').scrollTop;
  const openLogs = [...document.querySelectorAll('.run-activity[open]')].map(el=>el.dataset.runId);
  renderNavigation(); renderConversation(); renderPath(); renderArtifacts(); renderHosts();
  $('#messages').scrollTop = scroll;
  document.querySelectorAll('.run-activity').forEach(el=>{el.open=openLogs.includes(el.dataset.runId);});
  renderConnectedHosts();
  if ($('#settings-dialog').open) attempt(renderArchives);
});
attempt(start);
