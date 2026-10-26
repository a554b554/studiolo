import { t, getLanguage, onLanguageChange } from './i18n.js';
import { api, post } from './api.js';
import { conversationItems, runNotice, agentLabel, accountName, familyName, modelName } from './conversation.js';
import { markdown } from './markdown.js';
import {supportsAuto,validateModelPermission} from './model-permissions.js';
import { describeActivity, duration } from './activity.js';
// Executing runs show how long they have been working; one ticker updates every counter on the page.
let ticker;
function tick() {
  const counters = document.querySelectorAll('[data-since]');
  for (const el of counters) el.textContent = duration(Date.now() - Date.parse(el.dataset.since));
  if (!counters.length) { clearInterval(ticker); ticker = undefined; }
}
function elapsed(since) {
  const el = node('span','activity-elapsed',duration(Date.now() - Date.parse(since)));
  el.dataset.since = since; ticker ||= setInterval(tick,1000); return el;
}
const stepNodes = step => { const target = node('code','activity-target',step.target || ''); if (step.title) target.title = step.title; return [node('span','activity-verb',t(step.verb)),target]; };
// While a run executes, the collapsed raw log reads as a status line: the step the agent is on,
// elapsed time and step count, and below it the last thing the agent said between steps.
function activitySummary(item, run) {
  const summary = node('summary');
  if (!['running','waiting'].includes(item.status)) {
    summary.textContent = t('Raw log · {status} · {count} 条',{status:statuses[item.status] || t('记录'),count:item.activity.length});
    if (run?.startedAt && run.endedAt) summary.append(node('span','activity-duration',` · ${duration(Date.parse(run.endedAt) - Date.parse(run.startedAt))}`));
    return summary;
  }
  const approval = run?.approvals?.find(a => a.status === 'pending');
  const info = describeActivity(item.activity,{replying:item.replying,waiting:item.status === 'waiting'});
  summary.className = 'activity-live';
  const now = node('span','activity-now');
  now.append(node('span',`activity-pulse state-${info.state}`));
  if (info.state === 'step') now.append(...stepNodes(info.step));
  else {
    now.append(node('span','activity-state',t({replying:'正在回复',waiting:'等待你处理',thinking:'思考中',starting:'启动中'}[info.state])));
    if (approval?.title) now.append(node('span','activity-target',approval.title));
    else if (info.state === 'thinking' && info.step) now.append(node('span','activity-previous',t('上一步')),...stepNodes(info.step));
  }
  const meta = node('span','activity-meta');
  if (run?.startedAt) meta.append(elapsed(run.startedAt));
  if (info.steps) meta.append(node('span','',t('{count} 步',{count:info.steps})));
  meta.append(node('span','activity-toggle','Raw log'));
  summary.append(now,meta);
  if (info.said) summary.append(node('span','activity-said',info.said));
  return summary;
}
// Reveals streamed text at an even pace that spreads each batch over about the time until the
// next one (the server sends every ~0.4 s), so it reads as continuous writing; the final batch
// drains faster. Progress follows elapsed time, not frames, and a timer backs up the animation
// frame: an embedded pane that is not on screen can report itself visible yet fire few or no
// frames, and the reply must still appear. Markdown re-renders as it grows.
function streamingBody(text, fresh) {
  const body = node('div','message-body markdown streaming');
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let target = text, shown = fresh && !reduced ? 0 : text.length, painted = -1, frame = 0, done = false, last = 0, rate = text.length / 500;
  const paint = () => {
    if (painted === shown) return;
    const scroller = body.closest('.messages'), stick = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
    body.replaceChildren(markdown(target.slice(0,shown))); painted = shown;
    if (stick) scroller.scrollTop = scroller.scrollHeight;
  };
  const step = now => {
    frame = 0;
    const elapsed = last && now ? now - last : 16; last = now || 0;
    if (target.length > shown) shown = reduced ? target.length : Math.min(target.length, shown + Math.max(1, Math.round(rate * elapsed)));
    paint();
    if (shown < target.length) later();
    else { last = 0; body.classList.toggle('streaming',!done); }
  };
  const later = () => {
    let raf, timer;
    const run = now => { cancelAnimationFrame(raf); clearTimeout(timer); step(now); };
    raf = requestAnimationFrame(run); timer = setTimeout(() => run(performance.now()), 100); frame = 1;
  };
  // A final text that does not extend what is on screen (the transport replaced it) shows at once.
  body.studioSet = (next, finished) => {
    done = finished; if (!next.startsWith(target.slice(0,shown))) shown = next.length;
    target = next; rate = (target.length - shown) / (finished ? 250 : 500);
    if (!frame) step();
  };
  step();
  return body;
}
function speaker(message, runs) { return message.role === 'user' ? (message.kind === 'steer' ? t('你 · 插话') : t('你')) : agentLabel(message,runs?.find(run => run.id === message.runId)); }
function renderItem(item, runs, previous, animate = false) {
  if (item.kind === 'notice') return node('p','run-error',runNotice(item.text));
  if (item.kind === 'switch') return node('p','model-switch',t('已切换到 {model}',{model:modelName(item.model,item.profileId)}));
  if (item.kind === 'activity') {
    const details = node('details','run-activity');
    details.dataset.runId = item.key;
    details.append(activitySummary(item,runs?.find(run => run.id === item.key)));
    // Raw logs are collapsed by default and can hold large tool output: build records on first open.
    let filled = false;
    const fill = () => { if (filled || !details.open) return; filled = true; for (const record of item.activity) details.append(node(record.role === 'assistant' ? 'p' : 'pre',record.role === 'assistant' ? 'raw-said' : 'raw-record',record.text)); };
    details.addEventListener('toggle', fill);
    // An open log follows new records when it was scrolled to the end, else keeps its place.
    if (previous?.open) { details.open = true; fill(); details.studioScroll = previous.scrollHeight - previous.scrollTop - previous.clientHeight < 40 ? Infinity : previous.scrollTop; }
    return details;
  }
  const message = item.message, article = node('article',`message message-${message.role}`);
  const head = node('div','message-header'), name = node('strong','',speaker(message,runs));
  head.append(name,node('time','',time(message.createdAt)));
  if (animate && item.streaming) {
    const body = streamingBody(message.text || '', Date.now() - Date.parse(message.createdAt) < 5000);
    // Later refreshes update this element in place instead of rebuilding it.
    article.studioStream = (next, nextRuns) => { name.textContent = speaker(next.message,nextRuns); body.studioSet(next.message.text || '',!next.streaming); };
    article.append(head,body); return article;
  }
  article.append(head,messageContent(message)); return article;
}
export function renderMessages(container, messages, runs) {
  for (const item of conversationItems(messages,runs)) container.append(renderItem(item, runs));
}
// Move existing nodes into the requested order with minimal DOM changes; drop the rest.
export function reconcileChildren(container, nodes) {
  let cursor = container.firstChild;
  for (const child of nodes) { if (child === cursor) cursor = cursor.nextSibling; else container.insertBefore(child, cursor); }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}
// Keyed render for the live conversation: unchanged items keep their DOM nodes, so streaming
// refreshes do not rebuild every message, collapse open logs or reset text selection.
export function syncMessages(container, messages, runs, trailing = []) {
  const language = getLanguage(), previous = container.studioItems?.language === language ? container.studioItems.items : new Map();
  const items = new Map(), nodes = [];
  for (const item of conversationItems(messages,runs)) {
    const key = `${item.kind}:${item.key || item.message.id}`;
    const run = item.message && runs?.find(run => run.id === item.message.runId);
    const signature = JSON.stringify([item, run && [run.profileId, run.model, run.actualModel, run.reasoningEffort, run.actualReasoningEffort]]);
    let entry = previous.get(key);
    if (entry?.signature !== signature) {
      if (entry?.element.studioStream && item.kind === 'message') { entry.element.studioStream(item, runs); entry = { ...entry, signature }; }
      else entry = { signature, element: renderItem(item, runs, entry?.element, true) };
    }
    items.set(key, entry); nodes.push(entry.element);
  }
  container.studioItems = { language, items };
  reconcileChildren(container, [...nodes, ...trailing]);
  for (const el of nodes) if (el.studioScroll !== undefined) { el.scrollTop = el.studioScroll === Infinity ? el.scrollHeight : el.studioScroll; delete el.studioScroll; }
}
// Mirrors how the server folds a machine's live runtime into project state: executing runs are
// replaced, their messages upserted, and this machine's native runtime entries refreshed. Streamed
// output then costs a few kilobytes per tick instead of the whole project.
export function mergeRuntime(state, live, hostId) {
  for (const run of live?.runs || []) { const index = state.runs.findIndex(r => r.id === run.id); if (index >= 0) state.runs[index] = run; }
  for (const message of live?.messages || []) { const index = state.messages.findIndex(m => m.id === message.id); if (index >= 0) state.messages[index] = message; else state.messages.push(message); }
  const runtime = { ...state.nativeRuntime };
  for (const key of Object.keys(runtime)) if (key.endsWith(`:${hostId}`)) delete runtime[key];
  state.nativeRuntime = Object.assign(runtime, live?.nativeRuntime || {});
  return state;
}
export const $ = (selector, root = document) => root.querySelector(selector);
export function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
export function button(text, action, className = '') { const el = node('button', className, text); el.type = 'button'; el.addEventListener('click', action); return el; }
export function showError(error) { const panel = $('#notice'); if (!panel) return; panel.textContent = t(error.message || String(error)); panel.hidden = false; }
export function clearError() { const panel = $('#notice'); if (panel) panel.hidden = true; }
export async function attempt(fn) { try { clearError(); return await fn(); } catch (error) { showError(error); return undefined; } }
export function time(value) { return value ? new Date(value).toLocaleString(getLanguage(), { month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit' }) : ''; }
const statusKeys = {queued:'排队中',running:'执行中',waiting:'等待用户',succeeded:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
export const statuses = new Proxy(statusKeys,{get:(target,key)=>target[key] ? t(target[key]) : undefined});
export function empty(text) { return node('p', 'empty', text); }
export function messageContent(message, className = 'message-body') {
  const body = node('div',className), text = message.text || '';
  let record; if (message.role === 'system' && text.trim().startsWith('{')) { try { record = JSON.parse(text); } catch {} }
  if (record && typeof record === 'object') {
    const details = node('details','tool-record');
    details.append(node('summary','',t('工具记录 · {type}{status}',{type:record.type || message.kind || t('操作'),status:record.status ? ' · '+record.status : ''})),node('pre','',JSON.stringify(record,null,2)));
    body.append(details);
  } else if (message.role === 'assistant') { body.classList.add('markdown'); body.append(markdown(text)); }
  else body.textContent = text;
  // Files uploaded with a user message are shown as chips named after the stored file.
  if (message.role === 'user' && message.attachments?.length) {
    const list = node('div','attachment-list');
    for (const path of message.attachments) { const chip = node('span','attachment-chip',`📎 ${String(path).split('/').pop()}`); chip.title = path; list.append(chip); }
    body.append(list);
  }
  return body;
}
export function showDialog(id) { const el = $(id); if (!el.open) el.showModal(); }
export function initDialogs() {
  document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => el.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog && (event.clientX < dialog.getBoundingClientRect().left || event.clientX > dialog.getBoundingClientRect().right || event.clientY < dialog.getBoundingClientRect().top || event.clientY > dialog.getBoundingClientRect().bottom)) dialog.close(); }));
}
export async function bootstrap() {
  try { return await api('/api/bootstrap'); }
  catch (error) {
    if (error.status !== 401 && error.status !== 403) throw error;
    const dialog = $('#auth-dialog'); if (!dialog) throw error;
    showDialog('#auth-dialog');
    return new Promise(resolve => {
      $('#auth-form').onsubmit = async event => {
        event.preventDefault(); const submit = event.submitter; submit.disabled = true;
        try { await post('/api/auth', { token: $('#auth-token').value }); const result = await api('/api/bootstrap'); $('#auth-token').value = ''; dialog.close(); resolve(result); }
        catch (failure) { $('#auth-error').textContent = t(failure.message); }
        finally { submit.disabled = false; }
      };
    });
  }
}
export function initChoices(data, prefix = '', {hostId:fixedHostId} = {}) {
  const profiles=$(`#${prefix}profile`),models=$(`#${prefix}model`),hosts=$(`#${prefix}host`),efforts=$(`#${prefix}effort`),permission=$(`#${prefix}permission`);
  let available=data.hosts||[],bound=null,sessionId=null,loading=false,generation=0,current=[],notify=()=>{};
  const selectedProfile=()=>current.find(p=>p.id===profiles.value);
  const familyOf=p=>p?.family||(p?.id?.startsWith('codex')?'codex':p?.id?.startsWith('claude')?'claude':null);
  const modeLabels=()=>{if(permission){const profile=selectedProfile(),codex=familyOf(profile)==='codex';const auto=permission.querySelector('[value="auto"]');auto.disabled=!supportsAuto(profile||profiles.value,models.value);auto.textContent=auto.disabled?t('Auto · 此模型不支持'):codex?'Approve for me':'Auto';permission.querySelector('[value="read-only"]').textContent=codex?t('只读'):'Plan';}};
  const setValue=(select,value)=>{if(value&&!Array.from(select.options).some(o=>o.value===value))select.add(new Option(value,value));if(value)select.value=value;};
  const fillModels=(list,selection)=>{
    const old=selection?.model||models.value;models.replaceChildren();
    for(const m of list.find(p=>p.id===profiles.value)?.models||[])models.add(new Option(m.label||m.id,m.id));
    if(Array.from(models.options).some(o=>o.value===old))models.value=old;
    // Opening a conversation selects the model it last used; the user may pick another for the next message.
    if(selection&&bound?.model&&(!bound.profileId||list.some(p=>p.id===bound.profileId)))setValue(models,selection.model||bound.model);
    const model=list.find(p=>p.id===profiles.value)?.models?.find(m=>m.id===models.value);
    const effort=selection?.reasoningEffort??efforts?.value??'';
    if(efforts){efforts.replaceChildren(new Option(t('Effort · CLI 默认'),''));for(const e of model?.efforts||[])efforts.add(new Option(e,e));efforts.value=model?.efforts?.includes(effort)?effort:model?.defaultEffort||'';efforts.disabled=!model?.efforts?.length;}
    models.disabled=loading;modeLabels();notify();
  };
  const load=async(selection)=>{
    const version=++generation,selected=hosts.value;loading=true;profiles.disabled=models.disabled=true;
    try{
      const host=available.find(h=>h.id===selected);
      const list=host?.profiles||(selected===data.hostId?data.profiles:host?(await api(`/api/hosts/${encodeURIComponent(selected)}/bootstrap`)).profiles:[]);
      if(version!==generation)return;
      current=list||[];
      const old=bound?.profileId||profiles.value;profiles.replaceChildren();
      // Family first, then the account's name (its e-mail once signed in), so two accounts of one person stay apart.
      for(const p of current){const option=new Option(`${familyName(p.family)?familyName(p.family)+' · ':''}${p.label||p.id}${p.status==='signed_out'?t(' · 未登录'):p.available===false?t(' · 不可用'):''}`,p.id);option.disabled=p.available===false;option.title=[p.label,p.identity?.email,p.identity?.plan].filter(Boolean).join(' · ');profiles.add(option);}
      if(!Array.from(profiles.options).some(o=>!o.disabled)){const placeholder=new Option(t(current.length?'账号未登录，请先登录':'该电脑尚未登录账号'),'');placeholder.disabled=true;placeholder.selected=true;profiles.add(placeholder,0);}
      // A conversation whose account was removed from its machine may continue with another one.
      const boundMissing=bound?.profileId&&!current.some(p=>p.id===bound.profileId);
      if(bound?.profileId&&!boundMissing)setValue(profiles,bound.profileId);else if(Array.from(profiles.options).some(o=>o.value===old&&!o.disabled))profiles.value=old;else profiles.value=Array.from(profiles.options).find(o=>!o.disabled)?.value||'';
      loading=false;profiles.disabled=Boolean(bound?.profileId)&&!boundMissing;if(boundMissing)profiles.title=t('原账号已从该电脑移除，可选择其他账号继续；原生会话上下文不会保留。');fillModels(list||[],selection);
      profiles.onchange=()=>fillModels(list||[]);models.onchange=()=>fillModels(list||[]);
    }catch(error){if(version===generation){profiles.replaceChildren();models.replaceChildren();loading=false;showError(error);}}
  };
  const fillHosts=()=>{
    const selected=fixedHostId||bound?.hostId||hosts.value||data.hostId;hosts.replaceChildren();
    for(const h of available)hosts.add(new Option(h.name||h.id,h.id));
    if(bound?.hostId&&!available.some(h=>h.id===bound.hostId)){const option=new Option(t('执行电脑离线'),bound.hostId);option.disabled=true;hosts.add(option);}
    hosts.value=Array.from(hosts.options).some(o=>o.value===selected)?selected:data.hostId;
    hosts.disabled=Boolean(fixedHostId||bound?.hostId);
    hosts.title=fixedHostId?t('批注由当前 Artifact 运行服务器执行。'):bound?.hostId?t('电脑和账号已固定；更换请新建对话。'):'';
  };
  hosts.onchange=()=>load();fillHosts();load();
  const choose=()=>{const choice={hostId:hosts.value,profileId:loading||!available.some(h=>h.id===hosts.value)?'':profiles.value,model:models.value,reasoningEffort:efforts?.value||null,permissionMode:permission?.value||'auto'};validateModelPermission(selectedProfile()||choice.profileId,choice.model,choice.permissionMode);return choice;};
  choose.profile=selectedProfile;
  // The label of the model the next message switches the conversation to, or null when it stays.
  choose.switching=()=>!loading&&bound?.model&&models.value&&models.value!==bound.model?models.selectedOptions[0]?.textContent||models.value:null;
  choose.onUpdate=fn=>{notify=fn;};
  choose.bindSession=(session,runs=[])=>{
    const last=runs.at(-1),next=session?{hostId:session.hostId||last?.hostId,profileId:session.profileId||last?.profileId,model:session.model||session.selection?.model||last?.model}:null;
    const changed=sessionId!==(session?.id||null)||JSON.stringify(next)!==JSON.stringify(bound);sessionId=session?.id||null;bound=next;
    if(changed){fillHosts();const selection=session?.selection||last;load(selection);if(permission)permission.value=selection?.permissionMode||'auto';}
  };
  choose.updateHosts=next=>{if(JSON.stringify(next)===JSON.stringify(available))return;available=next;fillHosts();load();};
  choose.reloadProfiles=()=>load();
  onLanguageChange(()=>{fillHosts();modeLabels();});return choose;
}
export function listenChanges(onChange) {
  const status = $('#connection');
  let worker, timer, closed = false, fallback, source, sourceDown, polling = false;
  const connection = online => { if (status) { status.textContent = online ? t('已连接') : t('连接中断 · 自动重连'); status.dataset.online = String(online); } };
  const closeWorker = () => { clearTimeout(fallback); fallback = undefined; worker?.port.postMessage({type:'close'}); worker?.port.close(); worker = null; };
  const closeSource = () => { clearTimeout(sourceDown); sourceDown = undefined; source?.close(); source = null; };
  const poll = () => {
    if (timer || closed) return;
    closeWorker(); closeSource();
    const refresh = async () => {
      if (document.hidden || closed || polling) return;
      polling = true;
      try {
        await api('/api/projects',{signal:AbortSignal.timeout(5000)});
        if (closed) return;
        if (status) { status.textContent = t('定时同步'); status.dataset.online = 'true'; }
        onChange({reconnect:true});
      } catch { if (!closed) connection(false); }
      finally { polling = false; }
    };
    timer = setInterval(refresh,2000); refresh();
  };
  // Some embedded browsers cannot stream from a SharedWorker. Without this fallback the page
  // would stop receiving changes entirely and the open conversation would appear frozen.
  // Also fall back after an established stream fails. EventSource may enter CLOSED
  // after a failed response, or a worker may stop delivering after browser sleep.
  const direct = () => {
    if (closed || source || timer) return;
    closeWorker();
    source = new EventSource('/api/events');
    sourceDown = setTimeout(poll,5000);
    source.onopen = () => { clearTimeout(sourceDown); sourceDown = undefined; connection(true); onChange({reconnect:true}); };
    source.addEventListener('change', event => { try { onChange(JSON.parse(event.data)); } catch {} });
    source.onerror = () => { connection(false); sourceDown ||= setTimeout(poll,5000); };
  };
  const open = () => {
    closed = false;
    try {
      if (!window.SharedWorker) { direct(); }
      else {
        worker = new SharedWorker('/events-worker.js',{name:'studio-events-v1'});
        fallback = setTimeout(direct,5000);
        worker.port.onmessage = event => {
          if (event.data?.type === 'connection') { connection(event.data.online); if (event.data.online) { clearTimeout(fallback); fallback = undefined; } else fallback ||= setTimeout(direct,5000); }
          if (event.data?.type === 'change') onChange(event.data.value);
        };
        worker.onerror = event => { event.preventDefault(); direct(); };
        worker.port.start(); onChange({reconnect:true});
      }
    } catch { poll(); }
  };
  const close = () => { closed = true; if (timer) clearInterval(timer); timer = null; closeWorker(); closeSource(); };
  onLanguageChange(()=>{if(status){if(timer&&status.dataset.online==='true')status.textContent=t('定时同步');else connection(status.dataset.online==='true');}});
  open(); window.addEventListener('pagehide',close);
  window.addEventListener('pageshow',event => { if (event.persisted) open(); });
  const catchUp = () => { if (!closed && !document.hidden) onChange({reconnect:true}); };
  document.addEventListener('visibilitychange',catchUp);
  window.addEventListener('online',catchUp);
  return {close};
}
const approvalDrafts=new Map();
// `scope` identifies the queue the callbacks act on; unchanged output is not rebuilt, so
// buttons stay clickable and approval answers keep focus while agents stream.
// `onInterrupt` stops an executing run softly (the native session survives) and withdraws a
// queued one; `stopRequests` (runId → time) decides when to offer the hard cancel instead.
export function renderRuns(container, runs, queue, onCancel, onResume, onApproval, onContinue, scope = '', onInterrupt, stopRequests) {
  for (const run of runs) for (const approval of run.approvals || []) if (approval.status !== 'pending') approvalDrafts.delete(approval.id);
  const active = runs.filter(run => ['queued','running','waiting'].includes(run.status) || queue?.paused && ['failed','interrupted'].includes(run.status));
  const hardStop = run => Boolean(onInterrupt && stopRequests?.has(run.id) && Date.now() - stopRequests.get(run.id) > 12000);
  const signature = JSON.stringify([getLanguage(), scope, active.slice(-12), queue, Boolean(onInterrupt), active.map(hardStop)]);
  if (container.studioSignature === signature) return;
  container.studioSignature = signature;
  container.replaceChildren();
  for (const run of active.slice(-12)) {
    const row = node('div','run-row'); const text = node('span','run-text',run.text); text.title = run.text;
    row.append(node('span',`run-status status-${run.status}`,statuses[run.status] || run.status),text);
    if (run.status === 'queued') row.append(button(t(onInterrupt ? '撤回' : '取消'),() => (onInterrupt || onCancel)(run.id),'quiet'));
    else if (['running','waiting'].includes(run.status)) {
      if (onInterrupt && !hardStop(run)) row.append(button(t('停止'),() => onInterrupt(run.id),'quiet'));
      if (!onInterrupt || hardStop(run)) row.append(button(t(hardStop(run) ? '强制终止' : '取消'),() => onCancel(run.id),'quiet danger'));
    }
    container.append(row);
    if(run.status==='waiting'&&!run.approvals?.some(a=>a.status==='pending')&&onContinue)container.append(button(t('用自动审核继续'),()=>onContinue(run.id),'resume-button'));
    for(const approval of run.approvals?.filter(a=>a.status==='pending')||[]){
      const card=node('section','approval-card');card.setAttribute('aria-label',t('待批准操作'));
      card.append(node('strong','',`${accountName(run.profileId, run)} · ${approval.title}`));
      if(approval.detail)card.append(node('pre','approval-detail',approval.detail));
      const answers=approvalDrafts.get(approval.id)||{};approvalDrafts.set(approval.id,answers);
      for(const q of approval.questions||[]){
        const label=node('label','approval-question',q.question),input=node('input');input.value=answers[q.id]||'';
        input.setAttribute('aria-label',q.question);input.addEventListener('input',()=>{answers[q.id]=input.value;});label.append(input);
        for(const option of q.options||[])label.append(button(option.label,()=>{input.value=option.label;answers[q.id]=option.label;},'quiet'));
        card.append(label);
      }
      const actions=node('div','approval-actions');
      const decide=async decision=>{for(const b of actions.querySelectorAll('button'))b.disabled=true;try{await onApproval(run.id,approval.id,{decision,answers});}finally{for(const b of actions.querySelectorAll('button'))b.disabled=false;}};
      if(approval.allow!==false)actions.append(button(approval.kind==='question'?t('提交回答'):t('批准本次'),()=>attempt(()=>decide('allow')),'primary'));
      actions.append(button(t('拒绝'),()=>attempt(()=>decide('deny')),'quiet'));
      card.append(actions);container.append(card);
    }
    if (run.error) container.append(node('p','run-error',runNotice(run.error)));
  }
  if (!active.some(run => run.status === 'waiting') && queue?.paused) container.append(button(t(queue.reason === 'stopped' ? '继续执行排队消息' : '恢复队列'),onResume,'resume-button'));
  container.hidden = !container.childNodes.length;
  container.classList.toggle('has-approval',Boolean(container.querySelector('.approval-card')));
}
