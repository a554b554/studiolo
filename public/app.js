import {initAccountUsage} from './account-usage.js';
import { t, getLanguage, onLanguageChange, initLanguage } from './i18n.js';
import { api, post, upload, projectURL, requestId } from './api.js';
import { initTheme } from './themes.js';
import { view, draftKey, rememberSelection, previousSelection } from './state.js';
import { syncMessages, mergeRuntime } from './ui.js';
import { category, visibleItems, moreButton } from './lifecycle.js';
import { markdown, isMarkdownPath } from './markdown.js';
import { $, node, button, empty, time, showError, clearError, attempt, showDialog, initDialogs, bootstrap, initChoices, listenChanges, renderRuns, statuses, messageContent } from './ui.js';
import { platformCommands, codexCommands, parseSlash, mergeCommands, createSlashMenu } from './commands.js';
import { initAccounts } from './accounts.js';
import { setAccountDirectory, accountName, familyName } from './conversation.js';
let usage = { setHost() {}, reload() {} }, accountsUI = null, lastComposerHost = null;

initLanguage(); initTheme(); initDialogs();
$('#connection').textContent=t('连接中'); $('#session-title').textContent=t('选择项目'); $('#prompt').placeholder=t('输入消息…');
let choices = () => ({}), refreshTimer, loadVersion = 0, messageSignature = '', navigationSignature = '', artifactSignature = '';
let projectSelectionPending=false;
const pendingRequests = new Map();
const formBody = form => Object.fromEntries(new FormData(form));
const path = () => projectURL(view.projectId);
function closeDrawer() { delete $('#workspace').dataset.drawer; }
document.querySelectorAll('[data-drawer]').forEach(el => el.addEventListener('click', () => { $('#workspace').dataset.drawer = el.dataset.drawer; }));
document.querySelectorAll('[data-close-drawer]').forEach(el => el.addEventListener('click', closeDrawer));
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDrawer(); });
$('#notice').addEventListener('click', clearError);
$('#project-new').addEventListener('click', () => showDialog('#project-dialog'));
$('#settings-open').addEventListener('click', () => { renderHosts(); showDialog('#settings-dialog'); attempt(renderArchives); attempt(renderSubagentSettings); });
$('#artifact-new').addEventListener('click', () => { if (!view.projectId) return showError(new Error(t('请先打开项目'))); showDialog('#artifact-dialog'); });
$('#files-refresh').addEventListener('click', () => attempt(async () => { await reloadProject(); await loadFiles(); }));
document.querySelectorAll('[data-resource]').forEach(tab => tab.addEventListener('click', () => {
  view.resource = tab.dataset.resource;
  document.querySelectorAll('[data-resource]').forEach(item => item.setAttribute('aria-selected', String(item === tab)));
  $('#files-section').hidden = view.resource !== 'files'; $('#artifacts').hidden = view.resource !== 'artifacts';
}));

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
async function createProjectSession(projectId) {
  if (creatingSessions.has(projectId)) return;
  creatingSessions.add(projectId);
  const navigationVersion = loadVersion;
  renderNavigation();
  try {
    // Bind the request to the clicked project, even if another project is selected.
    const session = await post(`${projectURL(projectId)}/sessions`,{title:t('新会话')});
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
function renderNavigation() {
  const projects = visibleItems(view.bootstrap.projects);
  // Rebuilding on every refresh would swallow clicks and orphan an open menu.
  const signature = JSON.stringify([getLanguage(),view.projectId,view.sessionId,[...creatingSessions],projects.map(p=>[p.id,p.name,unreadOf(p)]),view.project&&visibleItems(view.project.sessions).map(s=>[s.id,s.title])]);
  if (signature === navigationSignature) return;
  navigationSignature = signature;
  const list = $('#project-list'); list.replaceChildren();
  for (const project of projects) {
    const selected = project.id === view.projectId, unread = unreadOf(project);
    const el = button('', () => attempt(() => selectProject(project.id)), `project-button${selected ? ' active' : ''}`);
    el.append(node('span','muted','▧'),node('span','',project.name));
    const projectDot = unreadDot(Object.values(unread)); if (projectDot) el.append(projectDot);
    const add = button('＋', () => attempt(() => createProjectSession(project.id)), 'project-session-new');
    add.setAttribute('aria-label',t('在 {name} 中新建会话',{name:project.name}));
    add.title = t('新建会话'); add.disabled = creatingSessions.has(project.id);
    const projectRow = node('div','navigation-row');
    projectRow.append(el,add,moreButton(t('项目 {name}',{name:project.name}),lifecycleActions(project)));
    list.append(projectRow);
    if (selected && view.project) {
      const sessions = node('div','session-list');
      for (const session of visibleItems(view.project.sessions)) {
        const sessionButton = button('', () => selectSession(session.id), `session${session.id === view.sessionId ? ' active' : ''}`);
        sessionButton.title = session.title; sessionButton.append(node('span','session-name',session.title));
        const sessionDot = unreadDot(unread[session.id] ? [unread[session.id]] : []); if (sessionDot) sessionButton.append(sessionDot);
        const row = node('div','navigation-row');
        row.append(sessionButton,moreButton(t('对话 {name}',{name:session.title}),lifecycleActions(project,session)));
        sessions.append(row);
      }
      if (!visibleItems(view.project.sessions).length) sessions.append(empty(t('暂无对话')));
      list.append(sessions);
    }
  }
  if (!projects.length) list.append(empty(t('还没有项目。')));
}
function lifecycleActions(project,session) {
  return [
    ...(session ? [{label:t('重命名'),run:()=>openRename(project,session)}] : []),
    {label:t(session?'归档对话':'归档项目'),run:()=>attempt(()=>updateLifecycle(project,session,'archive'))},
    {label:t(session?'删除对话':'删除项目'),danger:true,run:()=>attempt(()=>updateLifecycle(project,session,'delete'))},
  ];
}
let renameTarget;
function openRename(project,session) {
  renameTarget={projectId:project.id,sessionId:session.id};
  const input=$('#rename-title'); input.value=session.title; input.setCustomValidity('');
  $('#rename-error').textContent=''; showDialog('#rename-dialog'); input.focus(); input.select();
}
$('#rename-title').addEventListener('input',()=>$('#rename-title').setCustomValidity(''));
$('#rename-form').addEventListener('submit',async event=>{
  event.preventDefault(); const input=$('#rename-title'),title=input.value.trim();
  if(!title){input.setCustomValidity(t('请输入标题'));input.reportValidity();return;}
  const target={...renameTarget},save=$('#rename-save');save.disabled=true;$('#rename-error').textContent='';
  try{
    await api(`${projectURL(target.projectId)}/sessions/${encodeURIComponent(target.sessionId)}`,{method:'PATCH',body:{title}});
    $('#rename-dialog').close();if(view.projectId===target.projectId)await reloadProject();
  }catch(error){$('#rename-error').textContent=error.message;}
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
  else {view.projectId=null;view.sessionId=null;view.project=null;$('#prompt').value='';messageSignature='';renderNavigation();renderConversation();renderPath();renderArtifacts();$('#files').replaceChildren();rememberSelection();}
}
function renderConversation() {
  const session = view.project?.sessions.find(item => item.id === view.sessionId);
  $('#session-title').textContent = session?.title || (view.project ? t('创建会话') : t('选择项目'));
  $('#project-title').textContent = view.project?.project.name || '';
  const writable=session && category(session)==='active' && category(view.project.project)==='active';
  const machineOnline=!session?.hostId||view.bootstrap.hosts.some(h=>h.id===session.hostId);
  $('#prompt').disabled = !writable; $('#send').disabled = !writable || !machineOnline || view.submitting; $('#attach').disabled = !writable;
  renderAttachments();
  $('#prompt').placeholder=session&&!writable?t('已归档或删除，恢复后可继续对话'):t('输入消息…');
  $('#takeover').hidden = true;
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
  choices.bindSession?.(session,runs); renderModelNote();
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
  nativeStatus.textContent=session?[who,!machineOnline?t('执行电脑离线'):native?.connected?t('原生会话 · {status}',{status:native.busy?t('执行中'):t('已连接')}):t('原生会话 · 待连接')].filter(Boolean).join(' · '):'';
  const signature = JSON.stringify([getLanguage(),view.projectId,view.sessionId,messages,runs]);
  if (signature !== messageSignature) {
    messageSignature = signature; const container = $('#messages');
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    // Some transports persist incremental output on runs until the final assistant message.
    const trailing = [];
    for (const run of runs.filter(run => ['running','waiting'].includes(run.status))) {
      if (!messages.some(message => message.runId === run.id && message.role === 'assistant') && (run.output || run.partialText)) { const article = node('article','message message-assistant'); article.append(node('div','message-header',`${run.profileId} · ${statuses[run.status]}`),node('div','message-body',run.output || run.partialText)); trailing.push(article); }
    }
    syncMessages(container,messages,runs,trailing);
    if (!container.childNodes.length) container.append(empty(session ? writable ? t('发送消息开始这个会话。') : t('恢复后可继续这个对话。') : view.project ? category(view.project.project)==='active' ? t('新建会话后选择 agent 发送消息。') : t('暂无对话。') : t('打开一个项目以开始。')));
    if (nearBottom || !messages.length) container.scrollTop = container.scrollHeight;
  }
  const queueId = `session:${view.sessionId}`;
  renderRuns($('#queue'), runs, view.project?.queues?.[queueId], runId => attempt(async () => { await post(`${path()}/runs/${runId}/cancel`); await reloadProject(); }), () => attempt(async () => { await post(`${path()}/queues/resume`,{queueId}); await reloadProject(); }), async (runId,id,input)=>{await post(`${path()}/runs/${runId}/approvals/${id}`,input);await reloadProject();},runId=>attempt(async()=>{await post(`${path()}/runs/${runId}/continue`);await reloadProject();}),`${view.projectId}:${queueId}`,
    runId => attempt(async () => { if (!stopRequests.has(runId)) stopRequests.set(runId, Date.now()); await post(`${path()}/runs/${runId}/interrupt`); await reloadProject(); }), stopRequests);
  markSeen();
}
function selectSession(id) {
  view.drafts.set(draftKey(),$('#prompt').value); view.sessionId = id; $('#prompt').value = view.drafts.get(draftKey()) || ''; messageSignature = ''; renderNavigation(); renderConversation(); rememberSelection(); closeDrawer(); $('#messages').scrollTop = $('#messages').scrollHeight;
}
async function selectProject(id, sessionId) {
  const version=++loadVersion;projectSelectionPending=true;
  try {
  view.drafts.set(draftKey(),$('#prompt').value);
  let state;
  try { state = await api(projectURL(id)); }
  catch (error) {
    if(version!==loadVersion)return;
    const registered = view.bootstrap.projects.find(project => project.id === id);
    if (error.status !== 409 || !registered) throw error;
    view.projectId = id; view.sessionId = null; view.project = {project:registered,sessions:[],messages:[],runs:[],artifacts:[],annotations:[],queues:{}};
    $('#prompt').value = ''; renderNavigation(); renderConversation(); renderPath(); renderArtifacts(); $('#files').replaceChildren(empty(t('接管或连接项目所在电脑后可读取文件。'))); $('#takeover').hidden = false; showError(error); return;
  }
  if (version !== loadVersion) return;
  view.projectId = id; view.project = state;
  view.sessionId = visibleItems(state.sessions).some(session => session.id === sessionId) ? sessionId : visibleItems(state.sessions).at(-1)?.id || null;
  $('#prompt').value = view.drafts.get(draftKey()) || ''; messageSignature = '';
  renderNavigation(); renderConversation(); renderArtifacts(); renderPath(); rememberSelection(); closeDrawer(); await loadFiles(); $('#messages').scrollTop = $('#messages').scrollHeight;
  } finally { if(version===loadVersion)projectSelectionPending=false; }
}
async function reloadProject() {
  if (!view.projectId) return;
  const id = view.projectId, state = await api(projectURL(id)); if (view.projectId !== id || projectSelectionPending) return;
  view.project = state;
  if(!visibleItems(state.sessions).some(s=>s.id===view.sessionId)){view.sessionId=visibleItems(state.sessions).at(-1)?.id||null;$('#prompt').value=view.drafts.get(draftKey())||'';rememberSelection();}
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
  for (const entry of entries) {
    if (entry.type === 'directory') {
      const folder = node('details'), summary = node('summary','',entry.name), children = node('div'); folder.append(summary,children); let loaded = false;
      folder.addEventListener('toggle', () => { if (folder.open && !loaded) attempt(async () => { const result = await api(`${projectURL(projectId)}/files?path=${encodeURIComponent(entry.path)}`); children.replaceChildren(); appendFiles(children,result,projectId); loaded = true; }); }); container.append(folder);
    } else { const file = button(entry.name, () => attempt(() => { fileHistory.length = 0; return openFile(projectId, entry.path); }),'tree-file'); container.append(file); }
  }
}
// Markdown files open rendered; relative links inside them open the linked file in the same dialog.
let fileMode = 'rendered', currentFile = null; const fileHistory = [];
function setFileMode(mode) {
  const rendered = !$('#file-view').hidden && mode === 'rendered';
  $('#file-rendered').hidden = !rendered; $('#file-source').hidden = rendered;
  document.querySelectorAll('[data-file-mode]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.fileMode === mode)));
}
async function openFile(projectId, filePath, anchor = '', remember = false) {
  const result = await api(`${projectURL(projectId)}/file?path=${encodeURIComponent(filePath)}`), isMarkdown = isMarkdownPath(result.path), rendered = $('#file-rendered');
  if (remember && currentFile) fileHistory.push(currentFile);
  currentFile = {projectId, path: result.path};
  $('#file-title').textContent = result.path; $('#file-content').textContent = result.content; $('#file-error').hidden = true;
  rendered.replaceChildren(...(isMarkdown ? [markdown(result.content, document, {file: result.path, image: p => `${projectURL(projectId)}/raw?path=${encodeURIComponent(p)}`})] : []));
  rendered.querySelectorAll('img').forEach(img => img.addEventListener('error', () => img.replaceWith(node('span', 'image-missing', '🖼 ' + img.alt)), {once: true}));
  $('#file-view').hidden = !isMarkdown; $('#file-back').hidden = !fileHistory.length;
  setFileMode(fileMode); showDialog('#file-dialog');
  rendered.scrollTop = $('#file-source').scrollTop = 0;
  if (anchor) document.getElementById('md-' + anchor)?.scrollIntoView({block: 'start'});
}
// The page-level notice sits under the modal dialog, so navigation errors are shown inside it.
const openLinkedFile = (projectId, filePath, ...rest) => openFile(projectId, filePath, ...rest).catch(error => { const el = $('#file-error'); el.textContent = /^ENOENT\b/.test(error.message) ? t('文件不存在：{path}', {path: filePath}) : t(error.message || String(error)); el.hidden = false; });
document.querySelectorAll('[data-file-mode]').forEach(el => el.addEventListener('click', () => { fileMode = el.dataset.fileMode; setFileMode(fileMode); }));
$('#file-back').addEventListener('click', () => { const previous = fileHistory.pop(); if (previous) openLinkedFile(previous.projectId, previous.path); });
$('#file-rendered').addEventListener('click', event => {
  const link = event.target.closest('a[data-file], a[data-anchor]'); if (!link) return;
  event.preventDefault();
  if (link.dataset.file) openLinkedFile(currentFile.projectId, link.dataset.file, link.dataset.anchor, true);
  else if (link.dataset.anchor) document.getElementById('md-' + link.dataset.anchor)?.scrollIntoView({block: 'start'});
});
function renderArtifacts() {
  const signature = JSON.stringify([getLanguage(),view.projectId,(view.project?.artifacts||[]).map(a=>[a.id,a.name,a.root,a.entry]),view.project?.artifactDiscoveryError]);
  if (signature === artifactSignature) return;
  artifactSignature = signature;
  const list = $('#artifact-list'); list.replaceChildren();
  $('[data-resource="artifacts"]').textContent = `Artifacts${view.project?.artifacts.length ? ' ' + view.project.artifacts.length : ''}`;
  for (const artifact of view.project?.artifacts || []) {
    const item = node('article','artifact-item'), link = node('a','',`${artifact.name} ↗`); link.href = `/artifact.html?project=${encodeURIComponent(view.projectId)}&artifact=${encodeURIComponent(artifact.id)}`; link.target = '_blank'; link.rel = 'noopener'; item.append(link,node('small','',`${artifact.root}/${artifact.entry}`)); list.append(item);
  }
  if (view.project?.artifactDiscoveryError) list.append(node('p','run-error',view.project.artifactDiscoveryError));
  if (!list.childNodes.length) list.append(empty(t('暂无 Artifact。让 agent 生成网页，或登记已有入口。')));
}
function renderHosts() {
  const list = $('#host-list'); list.replaceChildren();
  for (const host of view.bootstrap?.hosts || []) { const row = node('div','host-item'); row.append(node('span','',host.name || host.id),node('small','muted',host.local ? t('本机') : host.url || '')); list.append(row); }
}
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
$('#artifact-form').addEventListener('submit', event => { event.preventDefault(); submitForm(event.currentTarget, async body => { const command = body.command.trim() ? JSON.parse(body.command) : undefined; if (command && (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string'))) throw new Error(t('启动命令必须是非空字符串数组，例如 ["node", "server.mjs"]')); await post(`${path()}/artifacts`,{...body,command,port:body.port ? Number(body.port) : undefined,dataPaths:body.dataPaths.split('\n').map(value => value.trim()).filter(Boolean)}); await reloadProject(); $('#artifact-dialog').close(); event.target.reset(); }); });
$('#host-form').addEventListener('submit', event => { event.preventDefault(); submitForm(event.currentTarget, async body => { await post('/api/hosts',body); view.bootstrap = await api('/api/bootstrap'); choices = watchChoices(initChoices(view.bootstrap)); renderHosts(); event.target.reset(); }); });
$('#takeover').addEventListener('click', () => attempt(async () => { if (!confirm(t('确认原电脑已停止执行和 Artifact 写入，并且项目数据已同步。现在由本机接管此项目？'))) return; await post(`${path()}/takeover`,{confirm:true}); await reloadProject(); }));
$('#prompt').addEventListener('input', () => view.drafts.set(draftKey(),$('#prompt').value));
$('#prompt').addEventListener('keydown', event => {
  if (slashMenu.handleKey(event)) { event.preventDefault(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('#composer').requestSubmit(); return; }
  // Esc stops the executing turn, like the terminal CLIs; the drawer handler only runs otherwise.
  if (event.key === 'Escape' && activeRunOf(currentSession()) && !$('#stop').hidden) { event.preventDefault(); event.stopPropagation(); attempt(stopActiveRun); }
});
$('#composer').addEventListener('submit', event => { event.preventDefault(); const mode = sendMode; sendMode = 'auto'; attempt(async () => {
  const text = $('#prompt').value.trim(), chosen = choices(); if (!text || !view.sessionId || view.submitting) return;
  const command = parseSlash(text);
  if (command && await runLocalCommand(command)) { $('#prompt').value = ''; view.drafts.delete(draftKey()); return; }
  if (!chosen.profileId) throw new Error(t('所选电脑没有可用的 CLI 入口。'));
  const pendingUploads = attachmentList().filter(item => item.status === 'uploading');
  if (pendingUploads.length) throw new Error(t('附件仍在上传，请稍候再发送。'));
  const attachments = attachmentList().filter(item => item.status === 'ready').map(item => item.path);
  // Steer by default while a run executes; attachments and commands always queue.
  const steer = mode !== 'queue' && !command && !attachments.length && Boolean(activeRunOf(currentSession()));
  view.submitting = true; $('#send').disabled = true; const originalKey = draftKey(), sessionId = view.sessionId, projectId = view.projectId;
  const signature = JSON.stringify({sessionId,text,attachments,steer,...chosen}), pendingKey = `${originalKey}:${signature}`;
  if (!pendingRequests.has(pendingKey)) pendingRequests.set(pendingKey,requestId());
  try { await post(`${projectURL(projectId)}/messages`,{requestId:pendingRequests.get(pendingKey),sessionId,text,...(attachments.length ? {attachments} : {}),...(steer ? {steer:true} : {}),...chosen}); pendingRequests.delete(pendingKey); view.drafts.delete(originalKey); view.attachments.delete(originalKey); if (draftKey() === originalKey && $('#prompt').value.trim() === text) $('#prompt').value = ''; renderAttachments(); await reloadProject(); $('#messages').scrollTop = $('#messages').scrollHeight; }
  finally { view.submitting = false; $('#send').disabled = !view.sessionId; }
}); });

async function start() {
  view.bootstrap = await bootstrap(); setAccountDirectory(view.bootstrap.hosts); choices = watchChoices(initChoices(view.bootstrap));
  const refreshAccounts = async () => { view.bootstrap = await api('/api/bootstrap'); setAccountDirectory(view.bootstrap.hosts); choices.updateHosts(view.bootstrap.hosts); choices.reloadProfiles?.(); usage.reload(); renderHosts(); messageSignature = ''; renderConversation(); };
  accountsUI = initAccounts({ hosts: () => view.bootstrap.hosts, localHostId: view.bootstrap.hostId, onChange: () => attempt(refreshAccounts) });
  usage = initAccountUsage({ hosts: () => view.bootstrap.hosts, localHostId: view.bootstrap.hostId, openAccounts: (hostId, accountId) => accountsUI.open(hostId, accountId) });
  $('#accounts-open').addEventListener('click', () => { $('#settings-dialog').close(); accountsUI.open($('#host').value || view.bootstrap.hostId); });
  $('#host').addEventListener('change', () => usage.setHost($('#host').value));
  $('#machine-label').textContent = t('本机 · {id}',{id:view.bootstrap.hosts.find(h=>h.local)?.name||view.bootstrap.hostId});
  const previous = previousSelection(), projects=visibleItems(view.bootstrap.projects), project = projects.find(item => item.id === previous.projectId) || projects[0];
  if (project) await selectProject(project.id,previous.sessionId); else { renderNavigation(); renderConversation(); }
  // Run output and conversation events only touch their own project; the project list
  // changes only on reconnect or project-level events, so most refreshes skip it.
  let listStale = false, fullStale = false;
  listenChanges(change => {
    const listChanged = !change.projectId || change.reconnect || String(change.type || '').startsWith('project.');
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
      const fresh = await api('/api/bootstrap');view.bootstrap.hosts=fresh.hosts;view.bootstrap.profiles=fresh.profiles;setAccountDirectory(fresh.hosts);choices.updateHosts(fresh.hosts);renderHosts();
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
  $('#machine-label').textContent = t('本机 · {id}',{id:view.bootstrap.hosts.find(h=>h.local)?.name||view.bootstrap.hostId});
  if ($('#settings-dialog').open) attempt(renderArchives);
});
attempt(start);
