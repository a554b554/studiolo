import { t } from './i18n.js';
import { node, icon } from './ui.js';
import { moreButton } from './lifecycle.js';
// The sidebar tree: project → category (one level, stored in the project) → chat → its forks.
// A fork sits under the chat it came from and moves with it; it cannot be dragged on its own and
// leaves the tree only through "Detach". Dragging a chat onto a category moves it there, onto
// another chat creates a category holding both, and onto the project row takes it out of its
// category. Which projects, categories and fork lists are expanded is remembered per browser.
const STORE = 'studio-nav';
function loadOpen() { try { const value = JSON.parse(localStorage.getItem(STORE) || '{}'); return { projects: value.projects || {}, categories: value.categories || {}, forks: value.forks || {} }; } catch { return { projects: {}, categories: {}, forks: {} }; } }
// Roots are chats that are not forks of a chat still listed; each root carries its forks, nested.
export function sessionTree(sessions) {
  const listed = new Set(sessions.map(s => s.id)), children = new Map();
  for (const session of sessions) { const parent = session.forkOf?.sessionId; if (parent && listed.has(parent) && parent !== session.id) { if (!children.has(parent)) children.set(parent, []); children.get(parent).push(session); } }
  const build = (session, depth, seen) => ({ session, depth, forks: seen.has(session.id) ? [] : (children.get(session.id) || []).map(child => build(child, depth + 1, new Set([...seen, session.id]))) });
  return sessions.filter(s => !s.forkOf?.sessionId || !listed.has(s.forkOf.sessionId)).map(root => build(root, 0, new Set()));
}
const countTree = nodes => nodes.reduce((sum, item) => sum + 1 + countTree(item.forks), 0);

export function createNavigation(container, hint, handlers) {
  const open = loadOpen();
  let dragging = null, signature = '';
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(open)); } catch {} };
  const isProjectOpen = model => open.projects[model.project.id] ?? model.current;
  const showHint = text => { hint.textContent = text; hint.hidden = !text; };
  const clearDrop = () => container.querySelectorAll('.drop-into').forEach(el => el.classList.remove('drop-into'));
  // One drop target: accepts the dragged chat when `allowed` says so and runs `drop`.
  function target(el, model, allowed, drop, text) {
    el.addEventListener('dragover', event => {
      if (!dragging || dragging.projectId !== model.project.id || !allowed()) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
      if (!el.classList.contains('drop-into')) { clearDrop(); el.classList.add('drop-into'); showHint(text()); }
    });
    el.addEventListener('dragleave', event => { if (!el.contains(event.relatedTarget)) el.classList.remove('drop-into'); });
    el.addEventListener('drop', event => {
      if (!dragging || dragging.projectId !== model.project.id || !allowed()) return;
      event.preventDefault(); event.stopPropagation();
      const moved = dragging; dragging = null; clearDrop(); showHint('');
      drop(moved);
    });
  }
  function sessionRow(model, item, category) {
    const { session, depth } = item, fork = depth > 0, active = model.current && session.id === handlers.selectedSession();
    const row = node('div', `session${active ? ' active' : ''}`);
    row.style.setProperty('--depth', String(Math.min(depth, 4)));
    row.setAttribute('role', 'button'); row.tabIndex = 0; row.title = session.title;
    row.dataset.sessionId = session.id;
    if (fork) row.append(node('span', 'elbow'));
    if (item.forks.length) {
      const closed = Boolean(open.forks[session.id]), caret = node('span', `caret${closed ? ' closed' : ''}`);
      caret.append(icon('i-chev', 'i i-xs')); caret.setAttribute('role', 'button');
      caret.setAttribute('aria-label', t(closed ? '展开分叉' : '收起分叉')); caret.title = caret.getAttribute('aria-label');
      caret.addEventListener('click', event => { event.stopPropagation(); open.forks[session.id] = !closed; if (!open.forks[session.id]) delete open.forks[session.id]; save(); rerender(); });
      row.append(caret);
    }
    row.append(node('span', 'session-name', session.title));
    const end = node('span', 'end'), unread = model.unread[session.id];
    if (model.running.includes(session.id)) end.append(handlers.runningMark());
    else if (unread) { const dot = handlers.unreadDot([unread]); if (dot) end.append(dot); }
    if (model.full) end.append(moreButton(t('对话 {name}', { name: session.title }), handlers.sessionActions(model.project, session, { fork, category })));
    row.append(end);
    const select = () => handlers.selectSession(model.project.id, session.id);
    row.addEventListener('click', event => { if (!event.target.closest('.more-button')) select(); });
    row.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target === row) { event.preventDefault(); select(); } });
    if (!fork && model.full) {
      row.draggable = true;
      row.addEventListener('dragstart', event => {
        dragging = { projectId: model.project.id, sessionId: session.id, categoryId: category?.id || null };
        event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', session.title);
        requestAnimationFrame(() => row.classList.add('dragging'));
        showHint(t('拖到另一个对话上创建分类，拖到分类上移入，拖到项目上移出分类'));
      });
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); dragging = null; clearDrop(); showHint(''); });
      // Onto another chat: join its category, or make a new category of the two.
      target(row, model, () => dragging.sessionId !== session.id && !(category && dragging.categoryId === category.id),
        moved => category ? handlers.moveSession(model.project, moved.sessionId, category.id) : handlers.groupSessions(model.project, [session.id, moved.sessionId]),
        () => category ? t('移入分类「{name}」', { name: category.name }) : t('与「{name}」组成新分类', { name: session.title }));
    } else row.draggable = false;
    return row;
  }
  function appendTree(list, model, nodes, category) {
    for (const item of nodes) {
      list.append(sessionRow(model, item, category));
      if (item.forks.length && !open.forks[item.session.id]) appendTree(list, model, item.forks, category);
    }
  }
  function categoryBlock(model, category, nodes) {
    const isOpen = open.categories[category.id] !== false, block = node('div', `cat${isOpen ? ' open' : ''}`), row = node('div', 'cat-row');
    row.setAttribute('role', 'button'); row.tabIndex = 0; row.setAttribute('aria-expanded', String(isOpen));
    row.append(icon('i-chev', 'i i-xs chev'), icon('i-folder', 'i i-sm folder'), node('span', 'name', category.name), node('span', 'count', String(countTree(nodes))));
    const actions = node('span', 'row-actions');
    const add = node('button', 'icon-btn'); add.type = 'button'; add.append(icon('i-plus', 'i i-xs')); add.title = t('在此分类新建对话'); add.setAttribute('aria-label', add.title);
    add.addEventListener('click', event => { event.stopPropagation(); handlers.newChat(model.project.id, category.id); });
    actions.append(add, moreButton(t('分类 {name}', { name: category.name }), handlers.categoryActions(model.project, category)));
    row.append(actions);
    const toggle = () => { open.categories[category.id] = !isOpen; if (open.categories[category.id]) delete open.categories[category.id]; save(); rerender(); };
    row.addEventListener('click', event => { if (!event.target.closest('.row-actions')) toggle(); });
    row.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target === row) { event.preventDefault(); toggle(); } });
    const list = node('div', 'cat-sessions');
    if (nodes.length) appendTree(list, model, nodes, category); else list.append(node('div', 'cat-empty', t('把对话拖到这里')));
    block.append(row, list);
    target(block, model, () => dragging.categoryId !== category.id, moved => handlers.moveSession(model.project, moved.sessionId, category.id), () => t('移入分类「{name}」', { name: category.name }));
    return block;
  }
  function projectBlock(model) {
    const { project } = model, isOpen = isProjectOpen(model);
    const block = node('div', `project${isOpen ? ' open' : ''}${model.current ? ' current' : ''}`), row = node('div', 'project-row');
    row.setAttribute('role', 'button'); row.tabIndex = 0; row.setAttribute('aria-expanded', String(isOpen));
    const label = node('span', 'label'); label.append(node('span', 'name', project.name)); if (model.place) label.append(node('span', 'place', model.place));
    const chev = icon('i-chev', 'i i-xs chev');
    row.append(chev, label);
    if (model.running.length) row.append(handlers.runningMark());
    const dot = handlers.unreadDot(Object.values(model.unread)); if (dot) row.append(dot);
    row.append(node('span', 'count', String(model.sessions.length)));
    const actions = node('span', 'row-actions');
    const add = node('button', 'icon-btn'); add.type = 'button'; add.append(icon('i-plus', 'i i-xs')); add.title = t('新建对话'); add.setAttribute('aria-label', t('在 {name} 中新建会话', { name: project.name })); add.disabled = model.creating;
    add.addEventListener('click', event => { event.stopPropagation(); handlers.newChat(project.id); });
    actions.append(add, moreButton(t('项目 {name}', { name: project.name }), handlers.projectActions(project)));
    row.append(actions);
    const setOpen = value => { open.projects[project.id] = value; save(); rerender(); };
    // The row opens a project; clicking the open project's row (or its chevron) folds it.
    row.addEventListener('click', event => {
      if (event.target.closest('.row-actions')) return;
      if (event.target.closest('.chev') || model.current && isOpen) return setOpen(!isOpen);
      if (!isOpen) open.projects[project.id] = true, save();
      handlers.selectProject(project.id);
    });
    row.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target === row) { event.preventDefault(); row.click(); } else if (event.key === 'ArrowLeft' && isOpen) setOpen(false); else if (event.key === 'ArrowRight' && !isOpen) setOpen(true); });
    target(row, model, () => Boolean(dragging.categoryId), moved => handlers.moveSession(project, moved.sessionId, null), () => t('移出分类'));
    block.append(row);
    const list = node('div', 'sessions');
    const categories = model.categories || [], known = new Set(categories.map(c => c.id)), roots = sessionTree(model.sessions);
    for (const category of categories) list.append(categoryBlock(model, category, roots.filter(item => item.session.categoryId === category.id)));
    appendTree(list, model, roots.filter(item => !known.has(item.session.categoryId)), null);
    if (!model.sessions.length) list.append(node('p', 'empty', t('暂无对话')));
    target(list, model, () => Boolean(dragging.categoryId), moved => handlers.moveSession(project, moved.sessionId, null), () => t('移出分类'));
    block.append(list);
    return block;
  }
  let lastModels = [];
  function rerender() { signature = ''; render(lastModels); }
  function render(models) {
    lastModels = models;
    // Rebuilding on every refresh would swallow clicks and orphan an open menu; a drag in progress
    // keeps the tree until it ends.
    const next = JSON.stringify([models.map(m => [m.project.id, m.project.name, m.current, m.full, m.place, m.unread, m.running, m.creating, m.categories, m.sessions.map(s => [s.id, s.title, s.forkOf?.sessionId, s.categoryId])]), handlers.selectedSession(), open, handlers.language()]);
    if (next === signature || dragging) return;
    signature = next;
    const scroll = container.scrollTop;
    container.replaceChildren(...models.map(projectBlock));
    if (!models.length) container.append(node('p', 'empty', t('还没有项目。')));
    container.scrollTop = scroll;
  }
  return { render, rerender, expand(projectId) { open.projects[projectId] = true; save(); rerender(); }, expandCategory(id) { delete open.categories[id]; save(); } };
}
