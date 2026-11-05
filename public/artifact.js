import { t, getLanguage, onLanguageChange, initLanguage } from './i18n.js';
import { api, post, projectURL, requestId, openSignedIn, signedIn, signedInClick } from './api.js';
import { initTheme } from './themes.js';
import { renderMessages, reconcileChildren, mergeRuntime, setRecordSource } from './ui.js';
import { mountDictation } from './dictation.js';
import { $, node, button, empty, time, attempt, showError, clearError, showDialog, initDialogs, bootstrap, initChoices, listenChanges, renderRuns, statuses, messageContent } from './ui.js';
import { artifactHostOf, artifactHome } from './project-hosts.js';
initLanguage(); initTheme(); initDialogs();
$('#connection').textContent=t('连接中'); $('#runtime-status').textContent=t('读取状态…'); $('#comments-heading').textContent=t('批注');
const params = new URLSearchParams(location.search), projectId = params.get('project'), artifactId = params.get('artifact');
// Opened as a tab of the workbench's side pane: no top bar, and the comments start folded when narrow.
const embedded = params.get('embed') === '1'; document.body.classList.toggle('embedded', embedded);
const base = projectURL(projectId), artifactBase = `${base}/artifacts/${encodeURIComponent(artifactId)}`;
// Only this Artifact's comment threads, tool records of ended runs as previews.
const viewURL = `${base}?artifact=${encodeURIComponent(artifactId)}`;
setRecordSource(runId => api(`${base}/runs/${encodeURIComponent(runId)}/records`));
let state, artifact, runtime, choices = () => ({}), selection = null, replyId = null, mode = false, selectionMode = 'element', frameOrigin, frameNonce, refreshTimer, submitting = false, lastAnchors = '', frameGeneration = 0;
const pendingRequests = new Map();
const commentCards = new Map();
const frame = $('#preview');
let persistenceStatus='';
function showPersistence(status){persistenceStatus=status;$('#persistence-status').textContent=t(status==='saving'?'保存中…':status==='error'?'存档未保存，正在重试':status==='saved'?'存档已保存到项目':'');}
let runtimeBusy=false;
$('#preview-empty').replaceChildren(empty(t('正在读取项目和 Artifact 状态…')));
for(const id of ['artifact-start','artifact-stop','artifact-persist','select-mode','area-mode','text-mode'])$('#'+id).disabled=true;
const loadingNotice=setTimeout(()=>{if(!runtime)$('#preview-empty').replaceChildren(empty(t('项目读取耗时较长，正在等待服务响应…')));},8000);
function bridge(type, data = {}) { if (frame.contentWindow && frameOrigin && frameNonce) frame.contentWindow.postMessage({type,nonce:frameNonce,...data},frameOrigin); }
const saveWaiters=new Map();
async function flushStorage(){
  if(!runtime?.running||!frameNonce||!persistenceStatus)return;
  const id=requestId();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{saveWaiters.delete(id);reject(new Error(t('存档尚未保存，请稍后重试。')));},15000);saveWaiters.set(id,saved=>{clearTimeout(timer);saveWaiters.delete(id);saved?resolve():reject(new Error(t('存档尚未保存，请稍后重试。')));});bridge('studio:storage-flush',{id});});
}
function setMode(enabled, type = 'element') { mode = enabled; selectionMode = type; for (const [id,value] of [['select-mode','element'],['area-mode','region'],['text-mode','text']]) { $('#'+id).classList.toggle('active-mode',mode && type === value); $('#'+id).setAttribute('aria-pressed',String(mode && type === value)); } bridge('studio:mode',{enabled:mode,mode:selectionMode}); }
function sendAnchors() { if (!state) return; bridge('studio:anchors',{annotations:state.annotations.filter(annotation => annotation.artifactId === artifactId && annotation.status === 'open').map(annotation => ({id:annotation.id,anchor:annotation.anchor,anchorStatus:annotation.anchorStatus}))}); }
function evidencePreview(anchor, annotationId) {
  const evidence = node('div','anchor-evidence');
  if (anchor?.text || anchor?.selector) evidence.append(node('blockquote','anchor-quote',anchor.text || anchor.selector));
  const imageURL = annotationId && anchor?.screenshotPath ? `${base}/annotations/${encodeURIComponent(annotationId)}/evidence` : /^data:image\/(?:png|jpeg|webp);base64,/.test(anchor?.screenshot || '') ? anchor.screenshot : null;
  if (imageURL) { const image = node('img','anchor-image'); image.src = imageURL; image.alt = t('选取时的画面'); evidence.append(image); }
  if (anchor?.captureError) evidence.append(node('p','small muted',anchor.captureError));
  return evidence;
}
function updateSelectionEvidence() { const target = $('#selection-evidence'); target.replaceChildren(); if (selection) target.append(evidencePreview(selection)); target.hidden = !target.childNodes.length; }
function selectReply(id) { replyId = id; selection = null; updateSelectionEvidence(); const annotation = state.annotations.find(item => item.id === id); $('#selection-label').textContent = t('回复：{text}',{text:annotation?.text.slice(0,60) || t('批注')}); $('#selection-clear').hidden = false; $('#comment-text').placeholder = t('回复这条批注…'); showComments(true); $('#comment-text').focus(); focusAnnotation(id); }
function clearSelection() { replyId = selection = null; updateSelectionEvidence(); $('#selection-label').textContent = t('先选取页面内容或直接填写批注'); $('#selection-clear').hidden = true; $('#comment-text').placeholder = t('输入批注…'); document.querySelectorAll('.annotation.focused').forEach(el => el.classList.remove('focused')); }
// `remember` keeps the reader's own choice (the toggle, the shortcut, folding by dragging) for the next visit.
function showComments(show, remember = false) { $('#comments-panel').hidden = !show; $('#comments-toggle').setAttribute('aria-expanded',String(show)); $('.artifact-layout').classList.toggle('comments-hidden',!show); if (remember) { commentsLayout.open = show; saveCommentsLayout(); } }
// The comments sidebar: drag its edge to resize, below the snap width it folds; a double click restores
// the default width. Width and open state are kept per browser, like the workbench's panels.
const COMMENTS = { key: 'studio-artifact-layout', def: 364, min: 260, snap: 180 };
const commentsLayout = (() => { try { return JSON.parse(localStorage.getItem(COMMENTS.key) || '{}'); } catch { return {}; } })();
function saveCommentsLayout() { try { localStorage.setItem(COMMENTS.key, JSON.stringify(commentsLayout)); } catch {} }
const commentsMax = () => Math.max(COMMENTS.min, Math.min(760, innerWidth - 320));
const applyCommentsWidth = (width = commentsLayout.width || COMMENTS.def) => $('.artifact-layout').style.setProperty('--cw', Math.min(width, commentsMax()) + 'px');
{
  const panel = $('#comments-panel'), handle = node('div','comments-handle'); handle.title = t('拖动调整宽度，双击恢复默认'); panel.prepend(handle);
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); handle.setPointerCapture(event.pointerId);
    const x0 = event.clientX, w0 = panel.getBoundingClientRect().width; let width = w0, snap = false;
    document.body.classList.add('resizing'); handle.classList.add('active');
    const move = ev => { const raw = w0 - (ev.clientX - x0); snap = raw < COMMENTS.snap; width = Math.max(COMMENTS.min, Math.min(commentsMax(), raw)); applyCommentsWidth(width); panel.classList.toggle('snapping', snap); };
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing'); handle.classList.remove('active'); panel.classList.remove('snapping');
      if (snap) { applyCommentsWidth(); showComments(false, true); } else { commentsLayout.width = width; saveCommentsLayout(); }
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => { commentsLayout.width = COMMENTS.def; applyCommentsWidth(); saveCommentsLayout(); });
  addEventListener('resize', () => applyCommentsWidth());
  addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'b') { event.preventDefault(); showComments($('#comments-panel').hidden, true); } });
  applyCommentsWidth();
}
function focusAnnotation(id) { const el = document.getElementById(`annotation-${id}`); document.querySelectorAll('.annotation.focused').forEach(item => item.classList.remove('focused')); if (el) { el.classList.add('focused'); el.scrollIntoView({block:'nearest',behavior:'smooth'}); } }
$('#notice').addEventListener('click',clearError);
if (commentsLayout.open === false || embedded && innerWidth < 1000) showComments(false);
$('#settings-open').addEventListener('click',()=>showDialog('#settings-dialog'));
$('#select-mode').addEventListener('click', () => setMode(!mode || selectionMode !== 'element','element'));
$('#area-mode').addEventListener('click', () => setMode(!mode || selectionMode !== 'region','region'));
$('#text-mode').addEventListener('click', () => setMode(!mode || selectionMode !== 'text','text'));
$('#comments-toggle').addEventListener('click', () => showComments($('#comments-panel').hidden, true));
// Browse mode opens the Artifact alone in a new window (open.html); from a workbench tab, edit mode opens this page on its own.
let hereId = null;
const openWindow = url => openSignedIn(hereId, url);
$('#artifact-open-browse').addEventListener('click', () => openWindow(`/open.html?project=${encodeURIComponent(projectId)}&artifact=${encodeURIComponent(artifactId)}`));
$('#artifact-open-edit').hidden = !embedded;
$('#artifact-open-edit').addEventListener('click', () => openWindow(`/artifact.html?project=${encodeURIComponent(projectId)}&artifact=${encodeURIComponent(artifactId)}`));
$('#selection-clear').addEventListener('click',clearSelection);
document.addEventListener('keydown',event => { if (event.key === 'Escape' && mode) setMode(false); });
$('#comment-filter').addEventListener('change', () => renderComments());
frame.addEventListener('load', () => { const generation = ++frameGeneration; sendAnchors(); bridge('studio:mode',{enabled:mode,mode:selectionMode}); setTimeout(() => { if (generation === frameGeneration) { sendAnchors(); bridge('studio:mode',{enabled:mode,mode:selectionMode}); } },300); });
window.addEventListener('message', event => {
  if (!frameNonce || event.source !== frame.contentWindow || event.origin !== frameOrigin || event.data?.nonce !== frameNonce) return;
  const data = event.data;
  if(data.type==='studio:storage-flushed')saveWaiters.get(data.id)?.(data.saved===true);
  if(data.type==='studio:persistence'&&['saving','saved','error'].includes(data.status))showPersistence(data.status);
  if (data.type === 'studio:mode-exit') setMode(false);
  if (data.type === 'studio:ready') { sendAnchors(); bridge('studio:mode',{enabled:mode,mode:selectionMode}); }
  if (data.type === 'studio:selection' && data.anchor && typeof data.anchor === 'object') { selection = data.anchor; replyId = null; updateSelectionEvidence(); $('#selection-label').textContent = t('已选取：{text}',{text:selection.text?.slice(0,65) || selection.selector || (selection.kind === 'region' ? t('页面区域') : t('页面元素'))}); $('#selection-clear').hidden = false; setMode(false); showComments(true); $('#comment-text').focus(); }
  if (data.type === 'studio:open' && typeof data.id === 'string') { $('#comment-filter').value = 'all'; renderComments(); showComments(true); selectReply(data.id); }
  if (data.type === 'studio:anchor-status' && ['attached','unlocated','orphaned'].includes(data.anchorStatus)) { const annotation = state?.annotations.find(item => item.id === data.id && item.artifactId === artifactId); if (annotation && annotation.anchorStatus !== data.anchorStatus) { annotation.anchorStatus = data.anchorStatus; attempt(async () => { await api(`${base}/annotations/${encodeURIComponent(annotation.id)}`,{method:'PATCH',body:{anchorStatus:data.anchorStatus}}); await reload(); }); } }
});
async function loadStatus({ resetFrame = false } = {}) {
  runtime = await api(`${artifactBase}/status`);
  const resident = !!runtime.persistent?.running;
  $('#runtime-status').textContent = resident ? t('常驻运行中') : runtime.running ? t('运行中') : runtime.error ? t('启动失败：{error}',{error:runtime.error}) : runtime.persistent?.error ? t(runtime.persistent.error) : t('已停止');
  renderRuntimeButtons(); renderPersistentInfo();
  // A persistent Artifact is already running: show it here without a second click.
  if (resident && !runtime.running && !attachTried) { attachTried = true; setTimeout(() => changeRuntime('start')); }
  $('#select-mode').disabled = $('#area-mode').disabled = $('#text-mode').disabled = !runtime.running;
  if (runtime.running && runtime.url) {
    const url = new URL(runtime.url,location.href); frameOrigin = url.origin; frameNonce = runtime.nonce;
    $('#preview-empty').hidden = true; frame.hidden = false;
    if (resetFrame || frame.src !== url.href) {showPersistence('');frame.src = url.href;}
  } else { frame.hidden = true; $('#preview-empty').hidden = false; const start=button(t('启动 Artifact'), () => changeRuntime('start'),'primary');start.disabled=runtime.filesReady===false;$('#preview-empty').replaceChildren(empty(runtime.syncMessage?t(runtime.syncMessage):runtime.error || t('Artifact 尚未运行。')),start); frame.removeAttribute('src'); frameOrigin = frameNonce = undefined;showPersistence(''); }
  renderSnapshots();
}
let attachTried = false;
function renderRuntimeButtons() {
  const resident = !!runtime?.persistent?.running, persist = $('#artifact-persist');
  $('#artifact-start').disabled = runtimeBusy || !!runtime?.running || runtime?.filesReady===false;
  $('#artifact-stop').disabled = runtimeBusy || !(runtime?.running || resident);
  persist.disabled = runtimeBusy || runtime?.filesReady===false; persist.setAttribute('aria-pressed', String(resident));
  persist.querySelector('span').textContent = t(resident ? '常驻运行中' : '常驻运行');
  persist.title = t(resident ? '已作为独立服务器运行；Studiolo 关闭后继续。点“停止”结束。' : '常驻运行：作为独立服务器运行，Studiolo 关闭后继续');
}
// Where a persistent Artifact can be reached without Studiolo: this computer, and whatever the Artifact's
// own `persistent` settings add (Tailscale, the local network, its own addresses).
function renderPersistentInfo() {
  const info = $('#persistent-info'), persistent = runtime?.persistent; info.replaceChildren(); info.hidden = !persistent?.running;
  if (!persistent?.running) return;
  const labels = {local:'本机', tailnet:'Tailnet', network:'局域网', artifact:'Artifact 提供'};
  for (const {kind, url} of persistent.urls) { const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = `${t(labels[kind] || kind)} ${new URL(url).host} ↗`; link.title = url; info.append(link); }
  if (persistent.tailnetError) { const note = document.createElement('span'); note.className = 'muted'; note.textContent = t('Tailnet 未转发：{error}', {error: t(persistent.tailnetError)}); info.append(note); }
}
async function changeRuntime(action) {
  if(runtimeBusy)return;
  runtimeBusy=true;renderRuntimeButtons();
  $('#runtime-status').textContent=t(action==='stop'?'正在停止…':'正在启动…');
  if(action!=='stop'&&!runtime?.running)$('#preview-empty').replaceChildren(empty(t('正在启动 Artifact…')));
  try { if(action==='stop')await flushStorage();await post(`${artifactBase}/${action}`); await loadStatus({resetFrame:action!=='stop'}); }
  catch(error){showError(error);$('#runtime-status').textContent=t('操作失败：{error}',{error:error.message});if(!runtime?.running)$('#preview-empty').replaceChildren(empty(error.message),button(t('重试启动'),()=>changeRuntime('start'),'primary'));}
  finally{runtimeBusy=false;renderRuntimeButtons();}
}
$('#artifact-start').addEventListener('click', () => changeRuntime('start'));
$('#artifact-stop').addEventListener('click', () => changeRuntime('stop'));
$('#artifact-persist').addEventListener('click', () => changeRuntime(runtime?.persistent?.running ? 'stop' : 'persist'));
$('#artifact-refresh').addEventListener('click', () => attempt(async()=>{await flushStorage();await loadStatus({resetFrame:true});}));
$('#artifact-snapshots').addEventListener('click', () => attempt(async () => { await loadStatus(); showDialog('#snapshot-dialog'); }));
$('#snapshot-create').addEventListener('click', () => attempt(async () => { const button = $('#snapshot-create'); button.disabled = true; try { await flushStorage();const result = await post(`${artifactBase}/snapshot`); $('#snapshot-restore input').value = result.snapshotId; await loadStatus(); } finally { button.disabled = false; } }));
async function restoreSnapshot(snapshotId) { if (!confirm(t('这会用所选快照替换 Artifact 的持久数据。请确认当前运行已停止，且要恢复此快照。'))) return; await post(`${artifactBase}/restore`,{snapshotId}); await loadStatus(); $('#snapshot-dialog').close(); }
$('#snapshot-restore').addEventListener('submit', event => { event.preventDefault(); attempt(() => restoreSnapshot(new FormData(event.target).get('snapshotId'))); });
function renderSnapshots() { const list = $('#snapshot-list'); list.replaceChildren(); for (const snapshot of runtime?.snapshots || []) { const row = node('li','',`${time(snapshot.createdAt)} · ${snapshot.id}`); row.append(button(t('恢复'), () => attempt(() => restoreSnapshot(snapshot.id)))); list.append(row); } if (!list.childNodes.length) list.append(empty(t('暂无数据快照'))); }
// Returns whether the artifact's own configuration changed, so callers know to refresh its runtime status.
async function reload() { state = await api(viewURL); const previous = JSON.stringify(artifact); artifact = state.artifacts.find(item => item.id === artifactId); if (!artifact) throw new Error(t('找不到这个 Artifact')); $('#artifact-title').textContent = artifact.name; document.title = `${artifact.name} · Studiolo`; renderComments(); const anchors = JSON.stringify(state.annotations.filter(item => item.artifactId === artifactId).map(item => [item.id,item.status,item.anchor])); if (anchors !== lastAnchors) { lastAnchors = anchors; sendAnchors(); } return previous !== undefined && previous !== JSON.stringify(artifact); }
function commentCard(annotation, messages, runs) {
  const card = node('article',`annotation${replyId === annotation.id ? ' focused' : ''}`); card.id = `annotation-${annotation.id}`;
  const head = node('div','annotation-head'); head.append(node('span','',time(annotation.createdAt)),node('span','badge',annotation.status === 'resolved' ? t('已解决') : t('未解决')));
  if (annotation.anchorStatus !== 'attached') head.append(node('span','badge',annotation.anchorStatus === 'orphaned' ? t('原位置已删除') : t('位置未定位')));
  head.append(button(annotation.status === 'resolved' ? t('重新打开') : t('解决'), () => attempt(async () => { await api(`${base}/annotations/${annotation.id}`,{method:'PATCH',body:{status:annotation.status === 'resolved' ? 'open' : 'resolved'}}); await reload(); })));
  card.append(head,evidencePreview(annotation.anchor,annotation.id),node('div','annotation-text',annotation.text));
  let initialUserSkipped = false;
  const replies = messages.filter(message => { if (!initialUserSkipped && message.role === 'user' && message.text === annotation.text) { initialUserSkipped = true; return false; } return true; });
  renderMessages(card,replies,runs);
  for (const run of runs) { const row = node('div','run-row'); row.append(node('span',`run-status status-${run.status}`,`${run.profileId} · ${statuses[run.status] || run.status}`)); if (['running','queued','waiting'].includes(run.status)) row.append(button(t('取消'), () => attempt(async () => { await post(`${base}/runs/${run.id}/cancel`); await reload(); }),'quiet')); card.append(row); }
  if (annotation.anchor?.selector) card.append(button(t('定位'), () => { bridge('studio:locate',{id:annotation.id}); focusAnnotation(annotation.id); },'quiet'));
  card.append(button(t('回复'), () => selectReply(annotation.id),'quiet'));
  return card;
}
function renderComments() {
  if (!state) return;
  const annotations = state.annotations.filter(item => item.artifactId === artifactId), filter = $('#comment-filter').value;
  const shown = annotations.filter(item => filter === 'all' || filter === 'orphaned' && ['orphaned','unlocated'].includes(item.anchorStatus) || item.status === filter);
  $('#comments-heading').textContent = t('批注 · {count}',{count:annotations.length});
  // Each card is rebuilt only when its own comment, replies or runs change, so streaming one
  // reply leaves the other cards, their evidence images and the scroll position alone.
  const list = $('#comments-list'), scroll = list.scrollTop, language = getLanguage(), nodes = [];
  for (const annotation of shown) {
    const messages = state.messages.filter(message => message.annotationId === annotation.id), runs = state.runs.filter(run => run.annotationId === annotation.id);
    const signature = JSON.stringify([language,annotation,messages,runs]);
    let entry = commentCards.get(annotation.id);
    if (entry?.signature !== signature) { entry = {signature,element:commentCard(annotation,messages,runs)}; commentCards.set(annotation.id,entry); }
    nodes.push(entry.element);
  }
  for (const id of commentCards.keys()) if (!annotations.some(annotation => annotation.id === id)) commentCards.delete(id);
  if (!shown.length) nodes.push(empty(filter === 'open' ? t('暂无未解决批注') : t('暂无符合筛选的批注')));
  reconcileChildren(list,nodes); list.scrollTop = scroll;
  // Each comment thread has its own queue (0.2.4) and they run in parallel. The panel shows every thread's
  // work; failures stay listed while their thread is paused, and resuming continues every paused thread.
  const prefix = `artifact:${artifactId}:`, paused = Object.entries(state.queues || {}).filter(([id,queue]) => id.startsWith(prefix) && queue?.paused).map(([id]) => id);
  const runs = state.runs.filter(run => run.artifactId === artifactId && (['queued','running','waiting'].includes(run.status) || paused.includes(run.queueId)));
  const queue = paused.length ? {paused:true,reason:paused.every(id => state.queues[id].reason === 'stopped') ? 'stopped' : 'paused'} : null;
  renderRuns($('#artifact-queue'), runs, queue, runId => attempt(async () => { await post(`${base}/runs/${runId}/cancel`); await reload(); }), () => attempt(async () => { for (const queueId of paused) await post(`${base}/queues/resume`,{queueId}); await reload(); }),async (runId,id,input)=>{await post(`${base}/runs/${runId}/approvals/${id}`,input);await reload();},runId=>attempt(async()=>{await post(`${base}/runs/${runId}/continue`);await reload();}),prefix);
}
$('#comment-text').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('#comment-form').requestSubmit(); } });
$('#comment-form').addEventListener('submit', event => { event.preventDefault(); attempt(async () => {
  const text = $('#comment-text').value.trim(), chosen = choices(); if (!text || submitting) return; if (!chosen.profileId) throw new Error(t('所选电脑没有可用的 CLI。')); submitting = true; $('#comment-send').disabled = true;
  try {
    const anchor = selection || {kind:'page',route:'/' + artifact.entry.replaceAll('\\','/').replace(/^\/+/, '')};
    const signature = JSON.stringify({replyId,text,anchor,...chosen}); if (!pendingRequests.has(signature)) pendingRequests.set(signature,requestId());
    if (replyId) await post(`${base}/messages`,{requestId:pendingRequests.get(signature),artifactId,annotationId:replyId,text,...chosen});
    else await post(`${artifactBase}/annotations`,{requestId:pendingRequests.get(signature),text,anchor,...chosen});
    pendingRequests.delete(signature);
    $('#comment-text').value = ''; clearSelection(); await reload();
  } finally { submitting = false; $('#comment-send').disabled = false; }
}); });
onLanguageChange(() => {
  renderComments(); renderSnapshots();showPersistence(persistenceStatus);
  // The preview iframe and its application state are never reloaded or translated.
  if(runtime){$('#runtime-status').textContent=runtime.persistent?.running?t('常驻运行中'):runtime.running?t('运行中'):runtime.error?t('启动失败：{error}',{error:runtime.error}):t('已停止');renderRuntimeButtons();renderPersistentInfo();}
  if(runtime && !runtime.running){const start=button(t('启动 Artifact'),()=>changeRuntime('start'),'primary');start.disabled=runtime.filesReady===false;$('#preview-empty').replaceChildren(empty(runtime.syncMessage?t(runtime.syncMessage):runtime.error || t('Artifact 尚未运行。')),start);}
  const annotation=state?.annotations.find(item=>item.id===replyId);
  $('#selection-label').textContent=replyId?t('回复：{text}',{text:annotation?.text.slice(0,60)||t('批注')}):selection?t('已选取：{text}',{text:selection.text?.slice(0,65)||selection.selector||t(selection.kind==='region'?'页面区域':'页面元素')}):t('先选取页面内容或直接填写批注');
  $('#comment-text').placeholder=t(replyId?'回复这条批注…':'输入批注…');
});
$('#selection-label').textContent=t('先选取页面内容或直接填写批注');
$('#comment-text').placeholder=t('输入批注…');
attempt(async () => {
  if (!projectId || !artifactId) throw new Error(t('链接缺少项目或 Artifact ID。请从项目文件栏打开。'));
  const data = await bootstrap(); hereId = data.hostId; await reload();
  // An Artifact that runs on another server opens on that server (project-hosts.js, artifactHome): framed
  // in a page of this one, its preview could not sign in. Links copied or kept from here still work.
  const home = artifactHome(state.project, data.hosts, data.hostId);
  if (home) {
    const there = new URL(location.pathname + location.search, home.url); there.searchParams.delete('embed');
    if (!embedded) { location.replace(await signedIn(home.id, there.href)); return; }
    const note = $('#remote-preview-note'), link = node('a', '', t('在 {host} 上打开', { host: home.name || home.id }));
    link.href = there.href; link.target = '_blank'; link.rel = 'noopener'; link.addEventListener('click', signedInClick(home.id, link));
    note.replaceChildren(node('span', '', t('这个 Artifact 运行在 {host} 上，在那台电脑的页面里打开。', { host: home.name || home.id })), link); note.hidden = false;
    clearTimeout(loadingNotice); $('#preview-empty').replaceChildren(); return;
  }
  // Comments run where the artifact runs: the project's artifact host, whichever server serves this page.
  choices = initChoices(data,'',{hostId:artifactHostOf(state.project)||data.hostId});
  // Voice input, once a machine transcribes (Settings → 语音转写).
  if (data.features?.voiceInput) { $('#comment-dictate').hidden = false; mountDictation({ button: $('#comment-dictate'), textarea: $('#comment-text'), controls: $('#comment-form .composer-controls'), onError: showError, keywords: () => [state.project?.name] }); }
  await loadStatus();

  if (innerWidth <= 850) showComments(false);
  // Store events never change the preview process, so its status is re-read only after a
  // reconnect or when the artifact's configuration changes, not on every streamed reply.
  let statusStale = false, fullStale = false;
  const localHostId = data.hostId;
  // Streamed comment replies arrive as run.live: merge the small runtime view instead of
  // downloading the project; any other change reloads it as before.
  const refreshRuntime = async () => { if (!state) return; const live = await api(`${base}/runtime`); if (!state) return; mergeRuntime(state, {...live, messages:(live.messages || []).filter(message => !message.sessionId && message.artifactId === artifactId)}, localHostId); renderComments(); };
  listenChanges(change => { if (change.projectId && change.projectId !== projectId) return; statusStale ||= Boolean(change.reconnect); fullStale ||= Boolean(change.reconnect) || change.type !== 'run.live'; if (refreshTimer) return; refreshTimer = setTimeout(() => { refreshTimer = null; const reconnect = statusStale, full = fullStale; statusStale = fullStale = false; attempt(async () => { if (!full) await refreshRuntime(); else if (await reload() || reconnect) await loadStatus(); }); },180); });
  let polling = false;
  const poll = setInterval(async () => { if (document.hidden || polling) return; polling = true; try { await reload(); await loadStatus(); } catch (error) { showError(error); } finally { polling = false; } },4000);
  // Browser discard clears timers; BFCache freezes and restores this visibility-gated poll.
}).finally(()=>clearTimeout(loadingNotice));
