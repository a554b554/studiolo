import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {loadRules,ignored,rsyncFilter} from './replica.mjs';

// The only place that copies project files between hosts. An endpoint is a local
// directory or {user, host, path, rsync} on a host that accepts SSH. A host without sshd (typically
// Windows) is always the rsync client, whichever way the files flow.

// MSYS2 rsync (Windows) wants /d/dir for D:\dir; POSIX paths pass through.
export function rsyncPath(local, platform = process.platform) {
  if (platform !== 'win32') return local;
  const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(local);
  return m ? `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : local.replace(/\\/g, '/');
}
const slash = p => p.endsWith('/') ? p : p + '/';
const remote = end => `${end.user}@${end.host}:${slash(end.path.replace(/'/g, ''))}`;
// "1,234,567  45%  1.2MB/s  0:00:10" lines from --info=progress2.
export function parseProgress(line) {
  const m = /([\d,]+)\s+(\d+)%\s+(\S+\/s)/.exec(line);
  return m ? { bytes: Number(m[1].replace(/,/g, '')), percent: Number(m[2]), rate: m[3] } : null;
}

export class RsyncTransport {
  constructor({ rsync, sshKey, platform = process.platform } = {}) { Object.assign(this, { rsync, sshKey, platform }); }
  get available() { return Boolean(this.rsync); }
  args({ source, target, filterFile }) {
    const ssh = ['ssh', ...(this.sshKey ? ['-i', rsyncPath(this.sshKey.replace(/^~(?=[\\/])/, os.homedir()), this.platform), '-o', 'IdentitiesOnly=yes'] : []), '-o', 'BatchMode=yes'].join(' ');
    const far = [source, target].find(end => typeof end === 'object');
    return ['-a', '--delete', '--no-perms', '--no-owner', '--no-group', '--omit-dir-times', '--info=progress2', `--filter=merge ${rsyncPath(filterFile, this.platform)}`,
      ...(far ? ['-e', ssh, ...(far.rsync ? [`--rsync-path=${far.rsync}`] : [])] : []),
      typeof source === 'object' ? remote(source) : slash(rsyncPath(source, this.platform)),
      typeof target === 'object' ? remote(target) : slash(rsyncPath(target, this.platform))];
  }
  // Copies source to target, deleting target files the source no longer has (excluded paths
  // are left alone). A failed transfer starts over next time: MSYS rsync keeps no partial files.
  async copy({ source, target, rules, onProgress = () => {}, signal }) {
    if (!this.rsync) throw Object.assign(new Error('rsync is not configured on this host (machine.json "rsync")'), { status: 503 });
    const filterFile = path.join(os.tmpdir(), `studiolo-filter-${randomUUID()}.txt`);
    await fs.writeFile(filterFile, rsyncFilter(rules));
    if (typeof target === 'string') await fs.mkdir(target, { recursive: true });
    // Git for Windows' usr/bin supplies the msys runtime and the ssh client rsync.exe needs.
    const env = this.platform === 'win32' ? { ...process.env, PATH: `C:\\Program Files\\Git\\usr\\bin;${process.env.PATH}` } : process.env;
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(this.rsync, this.args({ source, target, filterFile }), { env, windowsHide: true, signal });
        let err = '', out = '';
        child.stdout.on('data', chunk => { out = (out + chunk).slice(-4000); for (const line of String(chunk).split(/[\r\n]/)) { const p = parseProgress(line); if (p) onProgress(p); } });
        child.stderr.on('data', chunk => { err = (err + chunk).slice(-4000); });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`rsync exited with ${code}: ${err.trim() || out.trim()}`)));
      });
    } finally { await fs.rm(filterFile, { force: true }); }
  }
}

// Tests: the same contract with local directories and fs calls.
export class FakeTransport {
  // `local`: both hosts share one disk, so a source is <its projectRoot>/<project id> (see sync-engine).
  constructor() { this.copies = []; this.local = true; }
  get available() { return true; }
  async copy({ source, target, rules, onProgress = () => {} }) {
    if (typeof source !== 'string' || typeof target !== 'string') throw new Error('FakeTransport copies local directories only');
    this.copies.push({ source, target });
    const seen = new Set();
    async function walk(rel) {
      const from = path.join(source, rel), to = path.join(target, rel);
      await fs.mkdir(to, { recursive: true });
      for (const item of await fs.readdir(from, { withFileTypes: true })) {
        const child = rel ? rel + '/' + item.name : item.name;
        if (ignored(child, item.isDirectory(), rules) || item.isSymbolicLink()) continue;
        seen.add(child);
        if (item.isDirectory()) await walk(child);
        else { await fs.copyFile(path.join(from, item.name), path.join(to, item.name)); const info = await fs.stat(path.join(from, item.name)); await fs.utimes(path.join(to, item.name), info.atime, info.mtime); }
      }
    }
    async function prune(rel) {
      for (const item of await fs.readdir(path.join(target, rel), { withFileTypes: true }).catch(() => [])) {
        const child = rel ? rel + '/' + item.name : item.name;
        if (ignored(child, item.isDirectory(), rules)) continue;
        if (!seen.has(child)) await fs.rm(path.join(target, child), { recursive: true, force: true });
        else if (item.isDirectory()) await prune(child);
      }
    }
    await walk(''); await prune(''); onProgress({ bytes: 0, percent: 100, rate: '' });
  }
}
export { loadRules };
