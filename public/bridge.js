(() => {
  'use strict';
  const cfg = window.__STUDIO_BRIDGE__;
  if (!cfg?.nonce || !cfg.parentOrigin || window.__studioBridgeInstalled) return;
  window.__studioBridgeInstalled = true;
  let enabled = false, mode = 'element', down, host, shadow, box, selected, scheduled = false, suppressClick = false;
  const anchors = new Map(), bindings = new Map(), known = new Set(), pins = new Map(), statuses = new Map(), observed = new WeakSet(), captures = new Map();
  const send = (type, extra = {}) => parent.postMessage({ type, nonce: cfg.nonce, ...extra }, cfg.parentOrigin);
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
  const route = () => location.pathname.replace(/^\/p\/[a-f0-9]+/, '') + location.search + location.hash;
  const rect = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });
  const hash = text => { let n = 2166136261; for (const char of text) n = Math.imul(n ^ char.charCodeAt(0), 16777619); return (n >>> 0).toString(16).padStart(8, '0'); };
  function captureId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    // randomUUID requires a secure context; getRandomValues also works on private HTTP.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  const isOverlay = event => event.composedPath().includes(host);
  const targetOf = event => event.composedPath().find(node => node instanceof Element && node !== host);
  const textOf = el => normalize(el?.textContent).slice(0, 4000);

  function overlay() {
    if (host?.isConnected) return;
    host = document.createElement('studio-selection-layer'); host.dataset.studioOverlay = 'true';
    const styles = { all: 'initial', position: 'fixed', inset: '0', width: '100vw', height: '100vh', margin: '0', padding: '0', border: '0', background: 'transparent', overflow: 'visible', 'pointer-events': 'none', 'z-index': '2147483647', 'max-width': 'none', 'max-height': 'none', transform: 'none', zoom: '1', opacity: '1', visibility: 'visible' };
    for (const [name, value] of Object.entries(styles)) host.style.setProperty(name, value, 'important');
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    if (cfg.styleNonce) style.nonce = cfg.styleNonce;
    style.textContent = ':host{color-scheme:light}*{box-sizing:border-box}.box{position:fixed;display:none;pointer-events:none;border:2px solid #387d34;background:#90db5830;box-shadow:0 0 0 1px #fff9;z-index:1}.pin{position:fixed;appearance:none;width:24px;height:24px;padding:0;margin:0;border:1px solid #173d19;border-radius:50%;background:#b9ec8d;color:#142015;font:600 12px/22px system-ui;cursor:pointer;pointer-events:auto;z-index:2}.pin:focus-visible{outline:3px solid #2061c0;outline-offset:2px}';
    box = document.createElement('div'); box.className = 'box'; shadow.append(style, box); document.documentElement.append(host);
    if (typeof host.showPopover === 'function') { host.setAttribute('popover', 'manual'); try { host.showPopover(); } catch { host.removeAttribute('popover'); } }
    for (const pin of pins.values()) shadow.append(pin);
  }
  function draw(r) { overlay(); Object.assign(box.style, { display: 'block', left: `${r.x}px`, top: `${r.y}px`, width: `${Math.max(0, r.width)}px`, height: `${Math.max(0, r.height)}px` }); }
  function hideBox() { if (box) box.style.display = 'none'; }
  function unique(root, selector) { try { return root.querySelectorAll(selector).length === 1; } catch { return false; } }

  function localSelector(el) {
    const root = el.getRootNode();
    if (el.id && unique(root, '#' + CSS.escape(el.id))) return { selector: '#' + CSS.escape(el.id), stable: true };
    for (const attr of ['data-studio-id', 'data-testid', 'data-test']) { const value = el.getAttribute(attr); const selector = value ? `[${attr}="${CSS.escape(value)}"]` : ''; if (selector && unique(root, selector)) return { selector, stable: true }; }
    const parts = [];
    for (let current = el; current instanceof Element; current = current.parentElement) {
      const siblings = [...(current.parentNode?.children || [])].filter(s => s.localName === current.localName);
      parts.unshift(CSS.escape(current.localName) + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''));
      if (!current.parentElement) break;
    }
    return { selector: parts.join(' > '), stable: false };
  }
  function locator(el) {
    const leaf = localSelector(el), shadowPath = []; let root = el.getRootNode();
    while (root instanceof ShadowRoot) { shadowPath.unshift(localSelector(root.host).selector); root = root.host.getRootNode(); }
    return { selector: leaf.selector, shadowPath, selectorReliability: leaf.stable ? 'stable' : 'positional' };
  }
  function identity(el) {
    return { tag: el.localName, namespace: el.namespaceURI, id: el.id || '', textHash: hash(textOf(el)), textLength: textOf(el).length,
      attributes: Object.fromEntries(['data-studio-id', 'data-testid', 'name', 'type', 'role', 'href', 'src', 'aria-label'].filter(a => el.hasAttribute(a)).map(a => [a, el.getAttribute(a)])) };
  }
  function evidence(el) {
    const fingerprint = identity(el), root = el.getRootNode();
    const similar = [...root.querySelectorAll(CSS.escape(el.localName))].filter(node => hash(textOf(node)) === fingerprint.textHash && node.id === el.id);
    return { fingerprint, ambiguous: similar.length > 1, context: { before: textOf(el.previousElementSibling).slice(-180), after: textOf(el.nextElementSibling).slice(0, 180), parentTag: el.parentElement?.localName || 'shadow-root' }, outerHTML: el.outerHTML.slice(0, 4000), sourceHash: hash(el.outerHTML),
      source: { file: el.getAttribute('data-source-file') || el.getAttribute('data-file') || undefined, line: el.getAttribute('data-source-line') || undefined, tag: el.localName } };
  }
  function resolve(anchor) {
    let root = document;
    try {
      for (const selector of anchor.shadowPath || []) { if (!unique(root, selector)) return null; root = root.querySelector(selector).shadowRoot; if (!root) return null; observe(root); }
      return anchor.selector && unique(root, anchor.selector) ? root.querySelector(anchor.selector) : null;
    } catch { return null; }
  }
  function matches(el, anchor) {
    const fp = anchor.fingerprint;
    const stable = anchor.selectorReliability === 'stable' || (!fp && /^#[^ >+~]+$/.test(anchor.selector || ''));
    if (!fp) return stable || !anchor.text || textOf(el) === normalize(anchor.text);
    const current = identity(el);
    if (current.tag !== fp.tag || current.namespace !== fp.namespace) return false;
    // Unique explicit markers identify the component across text/style edits and reloads.
    // Positional paths still require the original contents and neighbouring evidence.
    if (stable) return true;
    if (current.id !== fp.id || current.textHash !== fp.textHash || current.textLength !== fp.textLength) return false;
    for (const [key, value] of Object.entries(fp.attributes || {})) if (el.getAttribute(key) !== value) return false;
    if (anchor.selectorReliability === 'positional' && (anchor.ambiguous || anchor.context?.before !== textOf(el.previousElementSibling).slice(-180) || anchor.context?.after !== textOf(el.nextElementSibling).slice(0, 180))) return false;
    return true;
  }
  function locate(id, anchor) {
    if (anchor.route && anchor.route !== route()) return { status: 'unlocated' };
    const previous = bindings.get(id) || captures.get(anchor.captureId);
    if (previous?.isConnected) {
      bindings.set(id, previous); known.add(id);
      if (anchor.kind === 'text' && anchor.textQuote && !quoteRange(previous, anchor)) return { status: 'orphaned' };
      return { status: 'attached', el: previous };
    }
    const candidate = resolve(anchor);
    if (previous && anchor.selectorReliability === 'positional') return { status: 'orphaned' };
    if (candidate && matches(candidate, anchor)) {
      if (anchor.kind === 'text' && anchor.textQuote && !quoteRange(candidate, anchor)) return { status: known.has(id) ? 'orphaned' : 'unlocated' };
      bindings.set(id, candidate); known.add(id); return { status: 'attached', el: candidate };
    }
    return { status: known.has(id) ? 'orphaned' : 'unlocated' };
  }
  function quoteRange(el, anchor) {
    const exact = anchor.textQuote?.exact;
    if (!exact) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes = []; let text = '', node;
    while ((node = walker.nextNode())) { nodes.push({ node, start: text.length }); text += node.textContent; }
    const candidates = []; let from = 0, index;
    while ((index = text.indexOf(exact, from)) !== -1) {
      const before = normalize(text.slice(0, index)), after = normalize(text.slice(index + exact.length));
      if ((!anchor.textQuote.prefix || before.endsWith(normalize(anchor.textQuote.prefix))) && (!anchor.textQuote.suffix || after.startsWith(normalize(anchor.textQuote.suffix)))) candidates.push(index);
      from = index + 1;
    }
    if (candidates.length !== 1) return null;
    const start = candidates[0], end = start + exact.length;
    const a = nodes.find(n => n.start <= start && n.start + n.node.length > start), b = nodes.find(n => n.start < end && n.start + n.node.length >= end);
    if (!a || !b) return null;
    const range = document.createRange(); range.setStart(a.node, start - a.start); range.setEnd(b.node, end - b.start); return range;
  }
  function anchorRect(el, anchor) {
    if (anchor.kind === 'text' && anchor.textQuote) { const range = quoteRange(el, anchor); if (range) return rect(range.getBoundingClientRect()); }
    const r = el.getBoundingClientRect(), n = anchor.normalizedRect;
    if (n && ['region', 'canvas'].includes(anchor.kind)) return { x: r.x + n.x * r.width, y: r.y + n.y * r.height, width: n.width * r.width, height: n.height * r.height };
    return rect(r);
  }
  function update() {
    scheduled = false; overlay();
    for (const [id, pin] of pins) if (!anchors.has(id)) { pin.remove(); pins.delete(id); bindings.delete(id); statuses.delete(id); }
    let index = 0;
    for (const [id, anchor] of anchors) {
      index++; const result = locate(id, anchor);
      if (statuses.get(id) !== result.status) { statuses.set(id, result.status); send('studio:anchor-status', { id, anchorStatus: result.status }); }
      let pin = pins.get(id); if (!result.el) { if (pin) pin.hidden = true; continue; }
      if (!pin) {
        pin = document.createElement('button'); pin.type = 'button'; pin.className = 'pin'; pin.title = '打开批注'; pin.setAttribute('aria-label', `打开批注 ${index}`);
        pin.addEventListener('pointerdown', e => e.stopPropagation()); pin.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); send('studio:open', { id }); });
        shadow.append(pin); pins.set(id, pin);
      }
      const r = anchorRect(result.el, anchor);
      pin.hidden = r.width <= 0 || r.height <= 0 || r.y + r.height < 0 || r.y > innerHeight || r.x + r.width < 0 || r.x > innerWidth;
      Object.assign(pin.style, { left: `${Math.min(innerWidth - 25, Math.max(0, r.x + r.width - 12))}px`, top: `${Math.max(0, r.y - 12)}px` }); pin.textContent = String(index);
    }
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(update); } }
  function observe(root) {
    if (observed.has(root)) return; observed.add(root);
    new MutationObserver(records => {
      let changed = false;
      for (const record of records) {
        if (record.target === host || record.target?.closest?.('studio-selection-layer')) continue;
        changed = true;
        // Attribute animations do not introduce shadow roots. Only scan newly added
        // subtrees, avoiding a full-document traversal for every animation frame.
        if (record.type === 'childList') for (const node of record.addedNodes) {
          if (!(node instanceof Element) || node === host) continue;
          if (node.shadowRoot) observe(node.shadowRoot);
          discover(node);
        }
      }
      if (changed) schedule();
    }).observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    discover(root);
  }
  function discover(root) { for (const el of root.querySelectorAll('*')) if (el.shadowRoot) observe(el.shadowRoot); }
  function setMode(value, nextMode = 'element') { enabled = value; mode = ['element', 'text', 'region'].includes(nextMode) ? nextMode : 'element'; down = undefined; hideBox(); }
  window.addEventListener('message', e => {
    if (e.source !== parent || e.origin !== cfg.parentOrigin || e.data?.nonce !== cfg.nonce) return;
    const data = e.data;
    if (data.type === 'studio:mode') setMode(!!data.enabled, data.mode);
    if (data.type === 'studio:anchors') { anchors.clear(); for (const a of data.annotations || []) { anchors.set(a.id, a.anchor || {}); if (a.anchorStatus === 'orphaned') known.add(a.id); } schedule(); }
    if (data.type === 'studio:locate') {
      const anchor = anchors.get(data.id); if (!anchor) return; const result = locate(data.id, anchor);
      if (result.el) { result.el.scrollIntoView({ block: 'center', inline: 'nearest' }); requestAnimationFrame(() => draw(anchorRect(result.el, anchor))); send('studio:open', { id: data.id }); }
      else { send('studio:anchor-status', { id: data.id, anchorStatus: result.status }); hideBox(); }
    }
  });
  function selectionFor(el) { const root = el.getRootNode(); return typeof root.getSelection === 'function' ? root.getSelection() : getSelection(); }
  function selectedAnchor(el, r, kind) {
    const target = el.getBoundingClientRect();
    const anchor = { version: 2, captureId: captureId(), kind, ...locator(el), ...evidence(el), text: textOf(el).slice(0, 2000), rect: rect(r), documentRect: { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }, targetRect: rect(target), route: route(), viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio, scale: window.visualViewport?.scale || 1, offsetLeft: window.visualViewport?.offsetLeft || 0, offsetTop: window.visualViewport?.offsetTop || 0 }, frame: { nested: parent !== top, document: route(), title: document.title }, capturedAt: new Date().toISOString() };
    captures.set(anchor.captureId, el); if (captures.size > 100) captures.delete(captures.keys().next().value);
    if (target.width && target.height) anchor.normalizedRect = { x: (r.x - target.x) / target.width, y: (r.y - target.y) / target.height, width: r.width / target.width, height: r.height / target.height };
    if (el.localName === 'iframe') anchor.boundary = 'iframe-element-only';
    if (el.getRootNode() instanceof ShadowRoot) anchor.boundary = 'open-shadow-root';
    if (el.localName === 'canvas') { try { const shot = el.toDataURL('image/png'); if (shot.length <= 1400000 && shot !== 'data:,') { anchor.screenshot = shot; anchor.captureMethod = 'canvas-bitmap'; } else anchor.captureError = 'Canvas 截图为空或超过 1.4 MB'; } catch { anchor.captureError = 'Canvas 含跨域内容，浏览器拒绝导出截图'; } }
    else if (kind === 'region') anchor.captureError = '此 DOM 区域已保存位置和 HTML 证据；浏览器脚本无法直接截取 DOM 像素。';
    return anchor;
  }
  function intercept(e) { if (enabled && !isOverlay(e)) { e.stopImmediatePropagation(); if (mode !== 'text') e.preventDefault(); } }
  window.addEventListener('pointerdown', e => {
    if (!enabled || isOverlay(e) || e.button !== 0) return; selected = targetOf(e); if (!selected) return;
    observe(selected.getRootNode()); down = { x: e.clientX, y: e.clientY, pointerId: e.pointerId }; e.stopImmediatePropagation();
    if (mode !== 'text') { getSelection()?.removeAllRanges(); e.preventDefault(); }
  }, true);
  window.addEventListener('pointermove', e => {
    if (!enabled || isOverlay(e)) return;
    if (mode === 'text') { if (down) e.stopImmediatePropagation(); return; }
    e.stopImmediatePropagation(); e.preventDefault();
    if (mode === 'region' && down) draw({ x: Math.min(down.x, e.clientX), y: Math.min(down.y, e.clientY), width: Math.abs(down.x - e.clientX), height: Math.abs(down.y - e.clientY) });
    else { const el = targetOf(e); if (el) draw(el.getBoundingClientRect()); }
  }, true);
  window.addEventListener('pointerup', e => {
    if (!enabled || !down || isOverlay(e)) return; e.preventDefault(); e.stopImmediatePropagation(); const start = down; down = undefined;
    if (!selected?.isConnected) { hideBox(); return; }
    let el = selected, r = rect(el.getBoundingClientRect()), kind = el.localName === 'canvas' ? 'canvas' : 'element', selection;
    if (mode === 'region') { if (Math.abs(start.x - e.clientX) + Math.abs(start.y - e.clientY) < 5) { hideBox(); return; } r = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), width: Math.abs(start.x - e.clientX), height: Math.abs(start.y - e.clientY) }; kind = 'region'; }
    else if (mode === 'text') {
      selection = selectionFor(el); if (!selection || selection.isCollapsed || !selection.toString().trim() || !selection.rangeCount) { hideBox(); return; }
      const range = selection.getRangeAt(0), common = range.commonAncestorContainer; el = common instanceof Element ? common : common.parentElement;
      if (!el || el === host) return; r = rect(range.getBoundingClientRect()); kind = 'text';
    }
    const anchor = selectedAnchor(el, r, kind);
    if (selection) { anchor.text = selection.toString().slice(0, 4000); const full = textOf(el), index = full.indexOf(normalize(anchor.text)); anchor.textQuote = { exact: anchor.text, prefix: index >= 0 ? full.slice(Math.max(0, index - 120), index) : '', suffix: index >= 0 ? full.slice(index + normalize(anchor.text).length, index + normalize(anchor.text).length + 120) : '' }; }
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 350);
    draw(r); send('studio:selection', { anchor });
  }, true);
  for (const type of ['mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchmove', 'touchend']) window.addEventListener(type, intercept, { capture: true, passive: false });
  for (const type of ['click', 'dblclick', 'contextmenu', 'submit']) window.addEventListener(type, e => { if ((enabled || (type === 'click' && suppressClick)) && !isOverlay(e)) { e.preventDefault(); e.stopImmediatePropagation(); if (type === 'click') suppressClick = false; } }, true);
  window.addEventListener('pointercancel', () => { down = undefined; hideBox(); }, true);
  window.addEventListener('keydown', e => { if (!enabled) return; if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setMode(false); send('studio:mode-exit', { reason: 'escape' }); } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  for (const type of ['scroll', 'resize', 'hashchange', 'popstate']) window.addEventListener(type, schedule, true);
  window.visualViewport?.addEventListener('resize', schedule); window.visualViewport?.addEventListener('scroll', schedule);
  function ready() { overlay(); observe(document.documentElement); schedule(); send('studio:ready', { capabilities: { element: true, text: true, region: true, openShadow: true, crossOriginFrameContents: false, closedShadowContents: false } }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
})();
