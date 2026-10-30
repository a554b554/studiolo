import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {writeJson} from './paths.mjs';

// A synced project's working tree as a version manifest: every file with size, mtime
// and sha256, sorted by NFC path with "/" separators. Hashes are reused from a machine-local
// index while size, mtime and ctime are unchanged, so a rescan reads only files that changed.

// Never copied between hosts: the journal travels on its own, the rest is derived or local.
export const ALWAYS_EXCLUDED = [
  '/.studio/events/', '/.studio/state.json', '/.studio/history-index.md', '/.studio/sessions/', '/.studio/artifacts/',
  '/.studio/versions/', '/.studio/stub', '/.studio-rsync-partial/', '*.tmp', '*.sync-conflict-*',
];
export const IGNORE_FILE = '.studioignore';
export const IGNORE_TEMPLATE = `# Paths in this project that Studiolo never copies between hosts (gitignore syntax).
# Each host keeps its own copy of anything matched here; deleting it on one host leaves the others alone.
# Installed packages contain per-OS binaries (Windows and macOS differ), so each host installs its own:
node_modules/
# Large data or build output usually belongs here. Examples:
# experiments/
# *.ckpt
# /dist/
# !keep-this.ckpt
`;

// gitignore subset: # comments, ! negation, leading or inner / anchors to the root,
// trailing / matches directories only, ** spans directories, * and ? stay within one name.
export function parseIgnore(text = '') {
  const rules = [];
  for (let line of String(text).split(/\r?\n/)) {
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!'); if (negate) line = line.slice(1);
    line = line.replace(/^\\([#!])/, '$1');
    const dirOnly = line.endsWith('/'); if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.includes('/'); line = line.replace(/^\//, '');
    if (!line) continue;
    let source = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '*' && line[i + 1] === '*') {
        const slashBefore = i === 0 || line[i - 1] === '/', slashAfter = line[i + 2] === '/' || i + 2 === line.length;
        if (slashBefore && slashAfter) { if (line[i + 2] === '/') { source += '(?:.*/)?'; i += 2; } else { source += '.*'; i += 1; } continue; }
        source += '[^/]*'; i += 1; continue;
      }
      if (c === '*') source += '[^/]*';
      else if (c === '?') source += '[^/]';
      else if (c === '[') { const end = line.indexOf(']', i + 1); if (end > i) { source += '[' + line.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = end; } else source += '\\['; }
      else if (c === '\\' && i + 1 < line.length) { source += line[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }
      else source += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
    rules.push({ pattern: (negate ? '!' : '') + (anchored ? '/' : '') + line + (dirOnly ? '/' : ''), negate, dirOnly, anchored, regex: new RegExp((anchored ? '^' : '^(?:.*/)?') + source + '$') });
  }
  return rules;
}
// Last matching rule wins, as in git. A path inside an ignored directory is never reached by
// the scan, so it cannot be re-included either (also as in git).
export function ignored(rel, isDir, rules) {
  let result = false;
  for (const rule of rules) if ((!rule.dirOnly || isDir) && rule.regex.test(rel)) result = !rule.negate;
  return result;
}
export async function loadRules(root) {
  const own = await fs.readFile(path.join(root, IGNORE_FILE), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  return [...parseIgnore(ALWAYS_EXCLUDED.join('\n')), ...parseIgnore(own)];
}
// rsync filter rules with the same meaning: rsync takes the first match, git the last, so the
// order is reversed and negations become includes.
export function rsyncFilter(rules) {
  return [...rules].reverse().map(rule => `${rule.negate ? '+' : '-'} ${rule.anchored ? '/' : ''}${rule.pattern.replace(/^!/, '').replace(/^\//, '')}`).join('\n') + '\n';
}

const toPosix = rel => rel.split(path.sep).join('/').normalize('NFC');
async function sha256(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }

// Walks the tree; symlinks are never followed (listed in errors and skipped).
export async function scan(root, { rules, index = {} } = {}) {
  rules ||= await loadRules(root);
  const entries = [], errors = [], nextIndex = {};
  async function walk(dir, prefix) {
    let list;
    try { list = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT' && prefix) return; throw e; }
    for (const item of list) {
      const rel = toPosix(prefix ? prefix + '/' + item.name : item.name), full = path.join(dir, item.name);
      if (item.isSymbolicLink()) { if (!ignored(rel, false, rules)) errors.push({ path: rel, error: 'symbolic link skipped' }); continue; }
      if (item.isDirectory()) { if (!ignored(rel, true, rules)) await walk(full, rel); continue; }
      if (!item.isFile() || ignored(rel, false, rules)) continue;
      const info = await fs.stat(full).catch(() => null); if (!info) continue;
      // ctime too (as git does): a copy that keeps size and mtime still gets a new ctime.
      const mtimeMs = Math.trunc(info.mtimeMs), ctimeMs = Math.trunc(info.ctimeMs), cached = index[rel];
      const digest = cached && cached[0] === info.size && cached[1] === mtimeMs && cached[3] === ctimeMs ? cached[2] : await sha256(full);
      nextIndex[rel] = [info.size, mtimeMs, digest, ctimeMs];
      entries.push([rel, info.size, mtimeMs, digest]);
    }
  }
  await walk(root, '');
  entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return { entries, errors, index: nextIndex };
}
// Content identity ignores mtimes: two hosts with the same bytes at the same paths are equal.
export const contentDigest = entries => createHash('sha256').update(JSON.stringify(entries.map(([rel, size, , sha]) => [rel, size, sha]))).digest('hex');
export function manifest({ entries, parent = null, hostId, at = new Date().toISOString(), id = randomUUID() }) {
  return { id, parent, hostId, at, files: entries.length, bytes: entries.reduce((sum, e) => sum + e[1], 0), digest: contentDigest(entries), entries };
}
// Paths whose content differs between two entry lists.
export function difference(a, b) {
  const left = new Map(a.map(e => [e[0], e])), right = new Map(b.map(e => [e[0], e])), changed = [];
  for (const [rel, e] of left) { const o = right.get(rel); if (!o || o[1] !== e[1] || o[3] !== e[3]) changed.push(rel); }
  for (const rel of right.keys()) if (!left.has(rel)) changed.push(rel);
  return changed.sort();
}

// Version manifests and the hash index of one project on this machine.
export class ReplicaFiles {
  constructor({ stateDir }) { this.stateDir = stateDir; }
  indexFile(pid) { return path.join(this.stateDir, 'replica-index', pid + '.json'); }
  async readIndex(pid) { try { return JSON.parse(await fs.readFile(this.indexFile(pid), 'utf8')); } catch { return {}; } }
  async scan(pid, root) {
    const result = await scan(root, { index: await this.readIndex(pid) });
    await writeJson(this.indexFile(pid), result.index);
    return result;
  }
  versionFile(root, id) { if (!/^[0-9a-f-]{36}$/.test(id || '')) throw Object.assign(new Error('Invalid version id'), { status: 400 }); return path.join(root, '.studio', 'versions', id + '.json'); }
  async readVersion(root, id) { try { return JSON.parse(await fs.readFile(this.versionFile(root, id), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  // Keeps only the given versions (the current one, and the previous during a transfer).
  async writeVersion(root, version, keep = []) {
    await writeJson(this.versionFile(root, version.id), version);
    const dir = path.join(root, '.studio', 'versions'), wanted = new Set([version.id, ...keep].map(id => id + '.json'));
    for (const name of await fs.readdir(dir).catch(() => [])) if (name.endsWith('.json') && !wanted.has(name)) await fs.rm(path.join(dir, name), { force: true });
  }
}
