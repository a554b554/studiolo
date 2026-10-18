// Deliberately supports text Markdown only: raw HTML is never interpreted.
export function safeLink(value) {
  try { const url = new URL(value, 'http://studio.invalid/'); return ['http:','https:','mailto:'].includes(url.protocol) ? value : null; } catch { return null; }
}
export const isMarkdownPath = value => /\.(?:md|markdown|mdown|mkd|mdx)$/i.test(String(value));
const decode = value => { try { return decodeURIComponent(value); } catch { return value; } };
const relative = href => !/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('//') && !href.startsWith('#');
// Resolves a link inside a project file against that file's folder; null when it leaves the project.
export function resolvePath(base, href) {
  let target; try { target = decodeURIComponent(String(href).split(/[?#]/)[0]); } catch { return null; }
  if (!target) return null;
  const parts = target.startsWith('/') ? [] : String(base).replaceAll('\\','/').split('/').slice(0,-1);
  for (const part of target.replaceAll('\\','/').split('/')) {
    if (!part || part === '.') continue;
    if (part !== '..') parts.push(part); else if (parts.length) parts.pop(); else return null;
  }
  return parts.join('/') || null;
}
// GitHub-style heading anchors, so links like [Setup](#setup) keep working.
export const slug = value => String(value).replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/[`*~]/g,'').toLowerCase().trim().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu,'').replace(/\s/g,'-');

const INLINE = new RegExp([
  /\\[!-/:-@[-`{-~]/,                                                  // backslash escape
  /(?: {2,}|\\)\n/,                                                     // hard line break
  /(?<!`)(`+)(?!`)[\s\S]*?[^`]\1(?!`)/,                                 // code span (the only capture group)
  /<!--[\s\S]*?-->/,                                                    // HTML comment
  /<[Bb][Rr]\s*\/?>/,                                                   // <br>
  /<(?:https?:\/\/|mailto:)[^\s<>]+>/,                                  // autolink
  /!\[[^\]\n]*\]\(\s*<?(?:[^\s<>()]|\([^\s<>()]*\))+>?(?:\s+"[^"\n]*")?\s*\)/,                          // image
  /\[(?:[^[\]\n]|\[[^[\]\n]*\])+\]\(\s*<?(?:[^\s<>()]|\([^\s<>()]*\))+>?(?:\s+"[^"\n]*")?\s*\)/,       // link
  /\[(?:[^[\]\n]|\[[^[\]\n]*\])+\]\[[^[\]\n]*\]/,                       // reference link
  /https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]*_~]/,                           // bare URL
  /\*\*\*(?=\S)[\s\S]*?\S\*\*\*/,
  /\*\*(?=\S)[\s\S]*?\S\*\*/,
  /(?<!\w)__(?=\S)[\s\S]*?\S__(?!\w)/,
  /~~(?=\S)[\s\S]*?\S~~/,
  /\*(?=[^\s*])[\s\S]*?[^\s*]\*(?!\*)/,
  /(?<!\w)_(?=[^\s_])[\s\S]*?[^\s_]_(?!\w)/,
].map(r => r.source).join('|'), 'g');
const LINK = /^!?\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*<?((?:[^\s<>()]|\([^\s<>()]*\))+)>?(?:\s+"([^"\n]*)")?\s*\)$/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])( +)(.*)$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const CALLOUT = /^\[!(note|tip|important|warning|caution)\]\s*$/i;

/**
 * Renders Markdown into DOM nodes built with createElement/textContent only.
 * Chat replies use the defaults. Project files pass `file` (the file's project path), which
 * turns on document features: real heading levels and anchors, front matter, hidden comments,
 * relative links marked with data-file, and project images through `image(path)`.
 */
export function markdown(text, doc = document, options = {}) {
  const {file, image} = options, isDocument = typeof file === 'string', headingOffset = options.headingOffset ?? (isDocument ? 0 : 1);
  const make = (tag, value) => { const el = doc.createElement(tag); if (value !== undefined) el.textContent = value; return el; };
  const refs = new Map(), slugs = new Map();
  const anchorId = value => { const base = slug(value) || 'section', count = slugs.get(base) || 0; slugs.set(base, count + 1); return count ? `${base}-${count}` : base; };
  const link = (href, title, label) => {
    let el;
    const target = href.split('#')[0], hash = href.includes('#') ? slug(decode(href.slice(href.indexOf('#') + 1))) : '';
    if (isDocument && href.startsWith('#')) { el = make('a'); el.setAttribute('href', '#' + hash); el.setAttribute('data-anchor', hash); }
    else if (isDocument && relative(href)) {
      const path = resolvePath(file, target);
      if (path) { el = make('a'); el.setAttribute('href', '#'); el.setAttribute('data-file', path); if (hash) el.setAttribute('data-anchor', hash); }
    } else if (safeLink(href) !== null) { el = make('a'); el.setAttribute('href', href); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
    el ||= make('span');
    if (title) el.setAttribute('title', title);
    if (typeof label === 'string') el.textContent = label; else label(el);
    return el;
  };
  // Remote images are links, never auto-loaded: an agent-written file must not beacon data out.
  const picture = (alt, src, title, linked) => {
    let url = null;
    if (isDocument && image && /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[\w+/=]+$/i.test(src)) url = src;
    else if (isDocument && image && relative(src)) { const path = resolvePath(file, src); if (path) url = image(path); }
    if (url) { const img = make('img'); img.setAttribute('src', url); img.setAttribute('alt', alt); img.setAttribute('loading', 'lazy'); if (title) img.setAttribute('title', title); return img; }
    if (!linked && /^https?:/i.test(src)) { const el = link(src, title, '🖼 ' + (alt || src)); el.className = 'image-link'; return el; }
    return make('span', alt);
  };
  const inline = (parent, value, depth = 0, linked = false) => {
    if (depth > 8) { parent.append(doc.createTextNode(value)); return; }
    let offset = 0;
    for (const match of value.matchAll(INLINE)) {
      parent.append(doc.createTextNode(value.slice(offset, match.index)));
      const token = match[0]; let element = null;
      if (/^(?: {2,}|\\)\n$/.test(token)) element = isDocument ? make('br') : doc.createTextNode('\n');
      else if (token[0] === '\\') element = doc.createTextNode(token[1]);
      else if (token[0] === '`') {
        const ticks = match[1].length; let code = token.slice(ticks, -ticks).replace(/\n/g, ' ');
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        element = make('code', code);
      }
      else if (token.startsWith('<!--')) element = isDocument ? null : doc.createTextNode(token);
      else if (/^<br/i.test(token)) element = make('br');
      else if (token[0] === '<') element = linked ? doc.createTextNode(token.slice(1, -1)) : link(token.slice(1, -1), '', token.slice(1, -1).replace(/^mailto:/, ''));
      else if (token.startsWith('![')) { const [, alt, src, title] = LINK.exec(token); element = picture(alt, src, title, linked); }
      else if (token[0] === '[') {
        const direct = LINK.exec(token), reference = direct ? null : /^\[(.+)\]\[(.*)\]$/s.exec(token);
        const target = direct ? {href: direct[2], title: direct[3]} : refs.get((reference[2] || reference[1]).trim().toLowerCase());
        const label = direct ? direct[1] : reference[1];
        if (!target) { parent.append(doc.createTextNode('[')); inline(parent, label, depth + 1, linked); element = doc.createTextNode(token.slice(label.length + 1)); }
        else if (linked) { inline(parent, label, depth + 1, true); }
        else element = link(target.href, target.title, el => inline(el, label, depth + 1, true));
      }
      else if (/^https?:/.test(token)) element = linked ? doc.createTextNode(token) : link(token, '', token);
      else {
        const [mark, tag] = token.startsWith('***') ? ['***', 'strong'] : /^(?:\*\*|__)/.test(token) ? [token.slice(0, 2), 'strong'] : token.startsWith('~~') ? ['~~', 'del'] : [token[0], 'em'];
        element = make(tag);
        if (mark === '***') { const em = make('em'); inline(em, token.slice(3, -3), depth + 1, linked); element.append(em); }
        else inline(element, token.slice(mark.length, -mark.length), depth + 1, linked);
      }
      if (element) parent.append(element);
      offset = match.index + token.length;
    }
    parent.append(doc.createTextNode(value.slice(offset)));
  };

  const cells = line => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, '|'));
  const tableRule = line => line?.includes('|') && cells(line).every(s => /^:?-+:?$/.test(s));
  const startsBlock = line => /^ {0,3}(?:#{1,6}(?:\s|$)|```|~~~|>)/.test(line) || LIST.test(line) || RULE.test(line);
  const blocks = (lines, parent, tight = false) => {
    for (let i = 0; i < lines.length;) {
      const line = lines[i]; if (!line.trim()) { i++; continue; }
      const fence = FENCE.exec(line);
      if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
        const [, indent, mark, info] = fence, close = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`), code = []; i++;
        while (i < lines.length && !close.test(lines[i])) code.push(lines[i++].replace(new RegExp(`^ {0,${indent.length}}`), ''));
        i++;
        const pre = make('pre'), el = make('code', code.join('\n')), language = info.trim().split(/\s+/)[0];
        if (language) { pre.setAttribute('data-lang', language); el.className = 'language-' + language; }
        pre.append(el); parent.append(pre); continue;
      }
      if (isDocument && /^ {0,3}<!--/.test(line)) {
        let end = i; while (end < lines.length && !lines[end].includes('-->')) end++;
        if (end < lines.length && lines[end].trim().endsWith('-->')) { i = end + 1; continue; }
      }
      if (line.includes('|') && tableRule(lines[i + 1])) {
        const wrap = make('div'), table = make('table'), head = make('thead'), body = make('tbody'); wrap.className = 'table-scroll';
        const header = cells(line), align = cells(lines[i + 1]).map(s => s.endsWith(':') ? (s.startsWith(':') ? 'center' : 'right') : '');
        const row = (values, tag) => { const tr = make('tr'); header.forEach((_, index) => { const td = make(tag); if (align[index]) td.setAttribute('style', 'text-align:' + align[index]); inline(td, values[index] ?? ''); tr.append(td); }); return tr; };
        head.append(row(header, 'th')); i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) body.append(row(cells(lines[i++]), 'td'));
        table.append(head, body); wrap.append(table); parent.append(wrap); continue;
      }
      const heading = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/.exec(line);
      if (heading) { emitHeading(parent, heading[1].length, heading[2] || ''); i++; continue; }
      if (RULE.test(line)) { parent.append(make('hr')); i++; continue; }
      if (/^ {0,3}>/.test(line)) {
        const inner = [];
        while (i < lines.length && (/^ {0,3}>/.test(lines[i]) || lines[i].trim() && inner.at(-1)?.trim() && !startsBlock(lines[i]))) inner.push(lines[i++].replace(/^ {0,3}> ?/, ''));
        const quote = make('blockquote'), callout = CALLOUT.exec(inner[0]);
        if (callout) { const kind = callout[1].toLowerCase(), title = make('p', kind[0].toUpperCase() + kind.slice(1)); quote.className = 'callout callout-' + kind; title.className = 'callout-title'; quote.append(title); inner.shift(); }
        blocks(inner, quote); parent.append(quote); continue;
      }
      const item = LIST.exec(line);
      if (item) { i = list(lines, i, parent); continue; }
      const paragraph = [line.replace(/^\s+/, '')]; let level = 0; i++;
      while (i < lines.length && lines[i].trim()) {
        const underline = /^ {0,3}(=+|-+)\s*$/.exec(lines[i]);
        if (underline) { level = underline[1][0] === '=' ? 1 : 2; i++; break; }
        if (startsBlock(lines[i]) || lines[i].includes('|') && tableRule(lines[i + 1])) break;
        paragraph.push(lines[i++].replace(/^\s+/, ''));
      }
      if (level) emitHeading(parent, level, paragraph.join(' '));
      else if (tight) inline(parent, paragraph.join('\n'));
      else { const el = make('p'); inline(el, paragraph.join('\n')); parent.append(el); }
    }
  };
  const emitHeading = (parent, level, value) => {
    const el = make(`h${Math.min(6, level + headingOffset)}`); inline(el, value);
    if (isDocument) el.setAttribute('id', 'md-' + anchorId(value));
    parent.append(el);
  };
  const list = (lines, i, parent) => {
    const first = LIST.exec(lines[i]), ordered = /\d/.test(first[2]), el = make(ordered ? 'ol' : 'ul'), items = [];
    if (ordered && parseInt(first[2], 10) !== 1) el.setAttribute('start', parseInt(first[2], 10));
    let loose = false;
    while (i < lines.length) {
      const m = LIST.exec(lines[i]);
      if (!m || /\d/.test(m[2]) !== ordered) break;
      const markerIndent = m[1].length, spaces = m[3].length, contentIndent = markerIndent + m[2].length + (spaces > 4 ? 1 : spaces);
      const content = [m[4]]; i++;
      while (i < lines.length) {
        const next = lines[i], indent = /^ */.exec(next)[0].length;
        if (!next.trim()) { content.push(''); i++; continue; }
        // Nested items indented past the parent marker belong to it even when short of its content column.
        if (indent >= contentIndent || indent > markerIndent && LIST.test(next)) { content.push(next.slice(Math.min(indent, contentIndent))); i++; continue; }
        if (content.at(-1).trim() && !startsBlock(next) && !(next.includes('|') && tableRule(lines[i + 1]))) { content.push(next.trim()); i++; continue; }
        break;
      }
      let trailing = 0; while (content.length > 1 && !content.at(-1).trim()) { content.pop(); trailing++; }
      if (content.some((value, index) => !value.trim() && index > 0)) loose = true;
      const sibling = i < lines.length && LIST.exec(lines[i]);
      if (trailing && sibling && /\d/.test(sibling[2]) === ordered) loose = true;
      items.push(content);
    }
    for (const content of items) {
      const li = make('li'), task = /^\[([ xX])\]\s+/.exec(content[0]);
      if (task) { const box = make('input'); box.setAttribute('type', 'checkbox'); box.setAttribute('disabled', ''); if (task[1] !== ' ') box.setAttribute('checked', ''); li.className = 'task'; li.append(box); content[0] = content[0].slice(task[0].length); }
      blocks(content, li, !loose); el.append(li);
    }
    parent.append(el); return i;
  };

  // Leading tabs become spaces outside code fences; reference definitions are collected and removed.
  let lines = [], fenced = null;
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const fence = FENCE.exec(line);
    if (fenced) { if (fence && fence[2][0] === fenced[0] && fence[2].length >= fenced.length && !fence[3].trim()) fenced = null; lines.push(line); continue; }
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) { fenced = fence[2]; lines.push(line); continue; }
    const definition = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/.exec(line);
    if (definition && !definition[1].startsWith('^')) { const key = definition[1].trim().toLowerCase(); if (!refs.has(key)) refs.set(key, {href: definition[2], title: definition[3] ?? definition[4] ?? definition[5]}); continue; }
    lines.push(line.replace(/^\t+/, tabs => '    '.repeat(tabs.length)));
  }
  const root = doc.createDocumentFragment();
  if (isDocument && /^---\s*$/.test(lines[0] || '')) {
    const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
    if (end > 0) { const pre = make('pre'); pre.className = 'front-matter'; pre.append(make('code', lines.slice(1, end).join('\n'))); root.append(pre); lines = lines.slice(end + 1); }
  }
  blocks(lines, root);
  return root;
}
