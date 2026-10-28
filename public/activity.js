// Plain-language progress for an executing run, read from its raw records: the step it is on,
// the last thing the agent said between steps, and how many steps it has taken. Pure (no DOM),
// so it is also covered by node --test. Labels are i18n keys; targets are opaque agent data.
const base = value => String(value || '').split(/[\\/]/).filter(Boolean).pop() || String(value || '');
const line = value => String(value || '').split('\n').map(s => s.trim()).find(Boolean) || '';
// Codex reports commands with their shell wrapper: `/bin/zsh -lc 'npm test'`.
function command(value) {
  const text = Array.isArray(value) ? value.join(' ') : String(value || '');
  const wrapped = /^(?:"?[^\s"]*[\\/])?(?:bash|zsh|sh|pwsh|powershell)(?:\.exe)?"?\s+(?:-\w+\s+)*(['"])([\s\S]*)\1$/i.exec(text.trim());
  return line(wrapped ? wrapped[2] : text);
}
function host(url) { try { const u = new URL(url); return u.host + (u.pathname === '/' ? '' : u.pathname); } catch { return String(url || ''); } }
const files = changes => {
  const names = (Array.isArray(changes) ? changes : Object.keys(changes || {}).map(path => ({path}))).map(c => base(c.path));
  return names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '');
};
function claudeStep(name, input = {}) {
  if (name === 'Bash' || name === 'PowerShell') return {verb:'运行', target:command(input.command) || input.description};
  if (name === 'Read') return {verb:'读取', target:base(input.file_path), title:input.file_path};
  if (['Edit','MultiEdit','NotebookEdit'].includes(name)) return {verb:'编辑', target:base(input.file_path || input.notebook_path), title:input.file_path || input.notebook_path};
  if (name === 'Write') return {verb:'写入', target:base(input.file_path), title:input.file_path};
  if (name === 'Grep') return {verb:'搜索', target:input.pattern};
  if (name === 'Glob') return {verb:'查找', target:input.pattern};
  if (name === 'WebFetch') return {verb:'打开', target:host(input.url), title:input.url};
  if (name === 'WebSearch') return {verb:'搜索网页', target:input.query};
  if (name === 'Task' || name === 'Agent') return {verb:'子任务', target:input.description || line(input.prompt)};
  if (name === 'TodoWrite') return {verb:'待办', target:Array.isArray(input.todos) ? input.todos.find(t => t.status === 'in_progress')?.activeForm || '' : ''};
  if (name === 'Skill') return {verb:'技能', target:input.skill || input.command};
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return {verb:'调用', target:`${mcp[1]} · ${mcp[2]}`};
  return {verb:'调用', target:name};
}
function codexStep(item) {
  const type = String(item.type || '').replace(/_(\w)/g, (_, c) => c.toUpperCase());
  if (type === 'commandExecution') return {verb:'运行', target:command(item.command)};
  if (type === 'fileChange') return {verb:'编辑', target:files(item.changes)};
  if (type === 'webSearch') return {verb:'搜索网页', target:item.query || item.action?.query || ''};
  if (type === 'mcpToolCall') return {verb:'调用', target:[item.server, item.tool].filter(Boolean).join(' · ')};
  if (type === 'dynamicToolCall' || type === 'toolCall') return {verb:'调用', target:item.tool || ''};
  return null;
}
// One raw record → {step} for a tool call, {result:true} for its output, or null for anything else.
export function readRecord(record) {
  if (record?.kind !== 'tool' || typeof record.text !== 'string') return null;
  const text = record.text;
  if (/^Tool result/.test(text)) return {result:true};
  if (text.startsWith('Background native event: ')) return null;
  if (text.startsWith('{')) { try { const step = codexStep(JSON.parse(text)); return step && {step, done:true}; } catch { return null; } }
  const match = /^([\w.:-]+): ([[{][\s\S]*)$/.exec(text);
  if (!match) return null;
  let input = {};
  try { input = JSON.parse(match[2]); } catch {}
  return {step:claudeStep(match[1], input)};
}
// The last sentence of what the agent said between steps, without Markdown decoration.
export function lastSaid(text) {
  const lines = String(text || '').split('\n').map(s => s.replace(/^\s*(?:[#>*+-]+|\d+[.)])\s*/, '').replace(/\*\*|__|`/g, '').trim()).filter(Boolean);
  const last = lines.at(-1) || '';
  return last.length > 160 ? last.slice(0, 159) + '…' : last;
}
// `state` is what the run is doing now: replying, waiting (for an approval), step (a tool call
// without output yet), thinking (between steps) or starting (nothing recorded yet).
export function describeActivity(activity = [], {replying = false, waiting = false} = {}) {
  let step = null, done = false, steps = 0, said = '', last = null;
  for (const record of activity) {
    if (record.role === 'assistant') { said = record.text; last = 'said'; continue; }
    const read = readRecord(record);
    if (!read) continue;
    if (read.result) { done = true; last = 'result'; continue; }
    step = read.step; done = Boolean(read.done); steps++; last = 'step';
  }
  const state = waiting ? 'waiting' : replying ? 'replying' : last === 'step' && !done ? 'step' : steps || last === 'said' ? 'thinking' : 'starting';
  return {state, step, steps, said:lastSaid(said)};
}
// The work of an executing run as the CLIs show it: what the agent said between steps, in full,
// and each stretch of consecutive tool calls as one group. Results complete the oldest open step
// of their group (parallel calls answer in order); Codex reports steps already completed.
export function timeline(activity = []) {
  const entries = [];
  for (const record of activity) {
    if (record.role === 'assistant') { if (String(record.text || '').trim()) entries.push({type:'said', key:record.id, text:record.text}); continue; }
    const read = readRecord(record);
    if (!read) continue;
    let group = entries.at(-1);
    if (read.result) { const open = group?.type === 'steps' && group.steps.find(step => !step.done); if (open) open.done = true; continue; }
    if (group?.type !== 'steps') entries.push(group = {type:'steps', key:record.id, steps:[]});
    group.steps.push({...read.step, done:Boolean(read.done)});
  }
  return entries;
}
// A group of steps in a few words: "ran 2 commands, edited 3 files". Edits count distinct files.
const kinds = {'运行':'command','读取':'read','编辑':'edit','写入':'edit','搜索':'search','查找':'search','搜索网页':'web','打开':'web','子任务':'task','调用':'tool','技能':'tool','待办':'todo'};
const phrases = {
  command:['运行了 1 条命令','运行了 {count} 条命令'], read:['读取了 1 个文件','读取了 {count} 个文件'], edit:['编辑了 1 个文件','编辑了 {count} 个文件'],
  search:['搜索了 1 次','搜索了 {count} 次'], web:['浏览了网页','浏览了网页'], task:['启动了 1 个子任务','启动了 {count} 个子任务'],
  tool:['调用了 1 次工具','调用了 {count} 次工具'], todo:['更新了待办','更新了待办'],
};
export function stepSummary(steps = []) {
  const counts = new Map();
  for (const step of steps) {
    const kind = kinds[step.verb] || 'tool';
    if (!counts.has(kind)) counts.set(kind, new Set());
    counts.get(kind).add(kind === 'edit' ? step.title || step.target : counts.get(kind).size);
  }
  return [...counts].map(([kind, seen]) => ({key:phrases[kind][seen.size === 1 ? 0 : 1], count:seen.size}));
}
export function duration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
