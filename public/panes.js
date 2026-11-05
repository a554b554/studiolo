import { $ } from './ui.js';
// Collapsible, resizable panels: projects on the left, resources on the right and the tabbed side
// pane between the chat and the resources. Widths and the two side panels' open state belong to
// this browser (localStorage); whether the side pane is open belongs to the project (tabs.js).
// Dragging a handle below its snap width collapses that panel; a double click restores the default.
const DEF = { left: 280, right: 300, pane: 520 }, MIN = { left: 200, right: 220, pane: 320 }, SNAP = { left: 140, right: 140, pane: 220 }, CHAT_MIN = 360;
// The project list keeps USAGE_ROOM above the account usage panel (layout.css).
const USAGE_ROOM = 160;
const KEY = 'studio-layout';
const narrow = matchMedia('(max-width:900px)');
function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } }
export function initPanes({ onPaneToggle }) {
  const saved = load(), body = document.body, ws = $('#workspace');
  const layout = { left: saved.left || DEF.left, right: saved.right || DEF.right, pane: saved.pane || DEF.pane, leftOpen: saved.leftOpen !== false, rightOpen: saved.rightOpen !== false, paneOpen: false, paneMax: false, usage: saved.usage || null };
  let restored = false;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ left: layout.left, right: layout.right, pane: layout.pane, leftOpen: layout.leftOpen, rightOpen: layout.rightOpen, usage: layout.usage })); } catch {} };
  // The side pane may grow until the chat would drop below CHAT_MIN.
  const maxW = (side, live) => {
    if (side === 'left') return 480;
    if (side === 'right') return 560;
    const lw = layout.leftOpen ? live?.left ?? layout.left : 0, rw = layout.rightOpen ? live?.right ?? layout.right : 0;
    return Math.max(MIN.pane, Math.min(1400, ws.clientWidth - lw - rw - CHAT_MIN));
  };
  function apply(live) {
    let lw = live?.left ?? layout.left, rw = live?.right ?? layout.right;
    const pw = Math.min(live?.pane ?? layout.pane, maxW('pane', live));
    // When the window cannot hold both panels, the open pane and the chat's minimum, the side
    // panels give up width down to their own minimums (nothing collapses); the chat takes the rest.
    if (layout.paneOpen && !layout.paneMax && !narrow.matches) {
      let over = (layout.leftOpen ? lw : 0) + (layout.rightOpen ? rw : 0) + pw + CHAT_MIN - ws.clientWidth;
      if (over > 0 && layout.rightOpen) { const give = Math.min(over, rw - MIN.right); rw -= give; over -= give; }
      if (over > 0 && layout.leftOpen) { const give = Math.min(over, lw - MIN.left); lw -= give; }
    }
    ws.style.setProperty('--lw-open', lw + 'px'); ws.style.setProperty('--rw-open', rw + 'px');
    ws.style.setProperty('--lw', layout.leftOpen && !live?.leftSnap ? lw + 'px' : '0px');
    ws.style.setProperty('--rw', layout.rightOpen && !live?.rightSnap ? rw + 'px' : '0px');
    ws.style.setProperty('--pw', layout.paneOpen && !live?.paneSnap ? pw + 'px' : '0px');
    body.classList.toggle('left-closed', !layout.leftOpen);
    body.classList.toggle('right-closed', !layout.rightOpen);
    body.classList.toggle('pane-closed', !layout.paneOpen);
    body.classList.toggle('pane-max', layout.paneOpen && layout.paneMax);
    $('#toggle-left').setAttribute('aria-pressed', String(layout.leftOpen));
    $('#toggle-right').setAttribute('aria-pressed', String(layout.rightOpen));
    $('#toggle-pane').setAttribute('aria-pressed', String(layout.paneOpen));
    $('#pane-max use').setAttribute('href', layout.paneMax ? '#i-min' : '#i-max');
    $('#pane-max').dataset.maximized = String(layout.paneMax);
  }
  // On narrow screens the side panels are drawers over the chat (data-drawer, as before).
  function toggle(side, force) {
    if (side === 'pane') return onPaneToggle(force ?? !layout.paneOpen);
    if (narrow.matches) { const drawer = side === 'left' ? 'projects' : 'files'; if (force ?? ws.dataset.drawer !== drawer) ws.dataset.drawer = drawer; else delete ws.dataset.drawer; return; }
    layout[side + 'Open'] = force ?? !layout[side + 'Open']; apply(); save();
  }
  $('#toggle-left').addEventListener('click', () => toggle('left'));
  $('#toggle-right').addEventListener('click', () => toggle('right'));
  $('#toggle-pane').addEventListener('click', () => toggle('pane'));
  $('#pane-close').addEventListener('click', () => toggle('pane', false));
  $('#pane-max').addEventListener('click', () => { layout.paneMax = !layout.paneMax; apply(); });
  addEventListener('resize', () => apply());
  document.querySelectorAll('.handle').forEach(handle => {
    const side = handle.dataset.side;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); handle.setPointerCapture(event.pointerId);
      const x0 = event.clientX, w0 = Math.min(layout[side], side === 'pane' ? maxW('pane') : Infinity); let width = w0, snap = false;
      body.classList.add('resizing'); handle.classList.add('active');
      const move = ev => { const dx = ev.clientX - x0, raw = side === 'left' ? w0 + dx : w0 - dx; snap = raw < SNAP[side]; width = Math.max(MIN[side], Math.min(maxW(side), raw)); apply({ [side]: width, [side + 'Snap']: snap }); };
      const up = () => {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
        body.classList.remove('resizing'); handle.classList.remove('active');
        if (snap) { if (side === 'pane') { layout.paneMax = false; onPaneToggle(false); } else layout[side + 'Open'] = false; } else layout[side] = width;
        apply(); save();
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('dblclick', () => { layout[side] = DEF[side]; apply(); save(); });
  });
  // The account usage panel at the foot of the sidebar: its top edge sets its height (null: as tall as
  // it needs, layout.css caps it); the account list scrolls inside.
  const usage = $('#account-usage'), usageHandle = $('#usage-handle');
  const sizeUsage = height => { usage.style.height = height ? height + 'px' : ''; usage.classList.toggle('sized', Boolean(height)); };
  sizeUsage(layout.usage);
  usageHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); usageHandle.setPointerCapture(event.pointerId);
    // At least the title, the footer and one account stay visible.
    const rows = usage.querySelector('.quota-rows'), y0 = event.clientY, h0 = usage.getBoundingClientRect().height;
    const min = h0 - (rows?.clientHeight || 0) + (rows?.firstElementChild?.offsetHeight || 40), max = usage.parentElement.clientHeight - USAGE_ROOM; let height = h0;
    body.classList.add('resizing'); usageHandle.classList.add('active');
    const move = ev => { height = Math.round(Math.max(min, Math.min(max, h0 - (ev.clientY - y0)))); sizeUsage(height); };
    const up = () => {
      usageHandle.removeEventListener('pointermove', move); usageHandle.removeEventListener('pointerup', up); usageHandle.removeEventListener('pointercancel', up);
      body.classList.remove('resizing'); usageHandle.classList.remove('active');
      layout.usage = height; save();
    };
    usageHandle.addEventListener('pointermove', move); usageHandle.addEventListener('pointerup', up); usageHandle.addEventListener('pointercancel', up);
  });
  usageHandle.addEventListener('dblclick', () => { layout.usage = null; sizeUsage(null); save(); });
  addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === 'b' && !event.shiftKey) { event.preventDefault(); toggle(event.altKey ? 'right' : 'left'); }
    else if (event.key === '\\' || event.code === 'Backslash') { event.preventDefault(); toggle('pane'); }
  });
  apply();
  return {
    // Called by the tab manager whenever the open project's pane opens or closes.
    // The first call restores the project's pane as the page loads, without the slide.
    setPaneOpen(open) {
      const first = !restored; restored = true;
      if (layout.paneOpen === open) return; layout.paneOpen = open; if (!open) layout.paneMax = false;
      if (first) { ws.style.transition = 'none'; apply(); requestAnimationFrame(() => requestAnimationFrame(() => { ws.style.transition = ''; })); } else apply();
    },
    get paneOpen() { return layout.paneOpen; },
    // Opening a tab on a narrow screen closes a drawer that covers it.
    closeDrawers() { delete ws.dataset.drawer; },
  };
}
