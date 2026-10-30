import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {httpError} from './paths.mjs';
import {ReplicaFiles,parseIgnore,ALWAYS_EXCLUDED,IGNORE_FILE,IGNORE_TEMPLATE,manifest,contentDigest,difference} from './replica.mjs';
import {isSynced,replicasOf,syncOf} from '../public/project-hosts.js';

// Commit and pull for synced projects. Each host writes only its own replica
// entry; the committing host writes the head. Work on one project is serialized here.
const now = () => new Date().toISOString();
const active = status => ['running', 'waiting'].includes(status);

export class ReplicaSync {
  constructor({ store, hosts, hostId, machine, stateDir, transport, hostName }) {
    Object.assign(this, { store, hosts, hostId, machine, transport, hostName });
    this.files = new ReplicaFiles({ stateDir });
    this.tails = new Map(); this.status = new Map(); this.prefetching = new Set(); this.closed = false;
    this.unsubscribe = store.subscribe(event => { if (['journal.synced', 'project.committed'].includes(event.type)) this.prefetch(event.projectId); });
  }
  close() { this.closed = true; this.unsubscribe(); }
  serial(pid, fn) {
    const next = (this.tails.get(pid) || Promise.resolve()).catch(() => {}).then(fn);
    this.tails.set(pid, next); next.finally(() => { if (this.tails.get(pid) === next) this.tails.delete(pid); }).catch(() => {});
    return next;
  }
  // What the UI shows while a replica is busy or failed: {phase, files, percent, error, at}.
  report(pid, value) { if (value) this.status.set(pid, { ...value, at: now() }); else this.status.delete(pid); this.store.notify(pid, 'replica.status'); }
  async context(pid) {
    const state = await this.store.read(pid), project = state.project;
    return { state, project, root: project.path, me: replicasOf(project)[this.hostId] || null, head: project.head || null };
  }
  async ignoreText(root) { return fs.readFile(path.join(root, IGNORE_FILE), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; }); }
  rules(ignore) { return [...parseIgnore(ALWAYS_EXCLUDED.join('\n')), ...parseIgnore(ignore)]; }

  // Records the working tree as the new head, unless it equals the head already. A host that
  // was behind and changed files anyway has forked the project: that is recorded, never merged.
  commit(pid, { force = false } = {}) {
    return this.serial(pid, async () => {
      const { project, root, me, head } = await this.context(pid);
      if (!isSynced(project)) throw httpError('This project is not synced', 409);
      if (me?.state !== 'ready') throw httpError(`${this.hostName(this.hostId)} has no ready copy of this project`, 409);
      if (project.diverged && !force) throw httpError('This project has diverged copies; choose which host to keep first', 409);
      const scanned = await this.files.scan(pid, root);
      if (head && contentDigest(scanned.entries) === head.digest) {
        if (me.version !== head.id) await this.adopt(pid, root, { ...head, entries: scanned.entries });
        return head;
      }
      if (head && me.version !== head.id && !force) {
        await this.store.mutate(pid, 'project.diverged', s => { s.project.diverged = { at: now(), heads: [{ hostId: head.hostId, version: head.id }, { hostId: this.hostId, version: null, digest: contentDigest(scanned.entries) }] }; });
        throw httpError(`${this.hostName(this.hostId)} changed files while it was behind ${this.hostName(head.hostId)}; choose which host to keep`, 409);
      }
      const version = { ...manifest({ entries: scanned.entries, parent: head?.id || null, hostId: this.hostId }), ignore: await this.ignoreText(root) };
      await this.files.writeVersion(root, version, [head?.id].filter(Boolean));
      const record = { id: version.id, parent: version.parent, hostId: this.hostId, at: version.at, files: version.files, bytes: version.bytes, digest: version.digest };
      await this.store.mutate(pid, 'project.committed', s => {
        s.project.head = record; s.project.replicas[this.hostId] = { state: 'ready', version: version.id, at: version.at };
        if (force) delete s.project.diverged;
      });
      return record;
    });
  }
  // This host's files already equal a version: keep its manifest and record it as current.
  async adopt(pid, root, version) {
    await this.files.writeVersion(root, version);
    await this.store.mutate(pid, 'replica.current', s => { s.project.replicas[this.hostId] = { state: 'ready', version: version.id, at: now() }; });
  }

  // Brings this host to the head: the head host commits first, then its files are copied here
  // and verified against its manifest. Local uncommitted changes stop the pull (E8).
  pull(pid, { force = false, onProgress = () => {}, onStart = () => {} } = {}) {
    return this.serial(pid, async () => {
      let { project } = await this.context(pid);
      if (!isSynced(project)) throw httpError('This project is not synced', 409);
      const sourceId = project.head?.hostId || project.ownerHostId;
      if (sourceId === this.hostId && project.head) return project.head;
      const source = await this.hosts.get(sourceId).catch(() => { throw httpError(`${this.hostName(sourceId)} is offline; files are not up to date`, 503); });
      await this.hosts.sync(this.store, source, pid);
      await this.hosts.request(source, `/api/projects/${pid}/peer/commit-now`, { method: 'POST', timeout: 600000 });
      await this.hosts.sync(this.store, source, pid);
      const { root, me, head, project: current } = await this.context(pid); project = current;
      if (!head) throw httpError(`${this.hostName(sourceId)} has not committed this project yet`, 409);
      if (me?.state === 'ready' && me.version === head.id) return head;
      this.report(pid, { phase: 'checking', source: sourceId });
      const local = await this.files.scan(pid, root);
      // A host commits only while it is at the head (commit refuses otherwise), so its own last
      // version is an ancestor of the head: once its files still equal that version, nothing is lost.
      if (!force) {
        const own = me?.state === 'ready' && me.version ? await this.files.readVersion(root, me.version) : null;
        if (own && difference(local.entries, own.entries).length) { this.report(pid, { phase: 'blocked', error: 'local changes not committed' }); throw httpError(`${this.hostName(this.hostId)} has uncommitted changes in this project; commit them or discard them before pulling`, 409); }
        if (!own && local.entries.length && contentDigest(local.entries) !== head.digest) { this.report(pid, { phase: 'blocked', error: 'differs' }); throw httpError(`${this.hostName(this.hostId)} has its own copy of this project that differs from ${this.hostName(head.hostId)}'s; choose which to keep`, 409); }
      }
      const version = await this.hosts.request(source, `/api/projects/${pid}/peer/versions/${head.id}`, { timeout: 120000 });
      if (contentDigest(local.entries) !== version.digest) {
        await onStart();
        for (let attempt = 0; ; attempt++) {
          this.report(pid, { phase: 'pulling', source: sourceId, files: difference(local.entries, version.entries).length, percent: 0 });
          await this.transfer(source, pid, root, version, p => { this.report(pid, { phase: 'pulling', source: sourceId, percent: p.percent }); onProgress(p); });
          const check = await this.files.scan(pid, root);
          if (!difference(check.entries, version.entries).length) break;
          if (attempt) { this.report(pid, { phase: 'stale', error: 'copied files do not match the version' }); throw httpError(`Files copied from ${this.hostName(sourceId)} do not match its version; try again`, 502); }
        }
      }
      await this.files.writeVersion(root, version);
      if (!project.replica) await this.store.setStub(pid, false);
      await this.store.mutate(pid, 'replica.pulled', s => { s.project.replicas[this.hostId] = { state: 'ready', version: version.id, at: now() }; });
      this.report(pid, null);
      return head;
    });
  }
  // Copies the source host's tree here. The side that can open SSH runs rsync: this host when
  // the source accepts SSH, otherwise the source pushes (a Windows host usually accepts no SSH).
  async transfer(source, pid, root, version, onProgress) {
    const rules = this.rules(version.ignore), files = source.files || {};
    if (this.transport.local) return this.transport.copy({ source: path.join(files.projectRoot, pid), target: root, rules, onProgress });
    if (files.ssh && this.transport.available) return this.transport.copy({ source: { ...files.ssh, path: `${files.projectRoot}/${pid}` }, target: root, rules, onProgress });
    if (this.machine.ssh && files.rsync) return this.hosts.request(source, `/api/projects/${pid}/peer/push`, { method: 'POST', data: { hostId: this.hostId, version: version.id }, timeout: 6 * 3600000 });
    throw httpError(`No SSH path between ${this.hostName(source.id)} and ${this.hostName(this.hostId)}: one of them needs sshd and the other rsync`, 409);
  }
  // The head host answers a pull: anything changed since its last commit becomes a new version.
  async commitNow(pid) {
    const { project, me } = await this.context(pid);
    return isSynced(project) && me?.state === 'ready' && !project.diverged ? this.commit(pid) : project.head;
  }
  // Runs on the source when the target cannot reach it (see transfer).
  async push(pid, targetId) {
    const { root } = await this.context(pid), target = await this.hosts.get(targetId);
    if (!target.files?.ssh) throw httpError(`${this.hostName(targetId)} does not accept SSH`, 409);
    await this.transport.copy({ source: root, target: { ...target.files.ssh, path: `${target.files.projectRoot}/${pid}` }, rules: this.rules(await this.ignoreText(root)) });
    return { ok: true };
  }

  // Background pulls after the head moves, one at a time per project (E4).
  prefetch(pid) {
    if (this.closed || this.prefetching.has(pid)) return;
    this.prefetching.add(pid);
    setTimeout(async () => {
      try {
        const { project, me, head } = await this.context(pid);
        if (!isSynced(project) || !syncOf(project).prefetch || me?.state !== 'ready' || !head || me.version === head.id || head.hostId === this.hostId || project.diverged) return;
        await this.pull(pid);
      } catch (e) { this.report(pid, { phase: 'error', error: e.message }); }
      finally { this.prefetching.delete(pid); }
    }, 500).unref?.();
  }

  // Before a run of a synced project starts here: no run elsewhere, files current.
  async barrier(pid, run, say, signal) {
    if (!isSynced((await this.context(pid)).project)) return;
    // Another host's run may only look active here (its journal lags): ask that host, then wait.
    for (let waiting = false; ;) {
      const other = (await this.context(pid)).state.runs.find(r => r.id !== run.id && r.hostId !== this.hostId && active(r.status));
      if (!other) break;
      const host = await this.hosts.get(other.hostId).catch(() => null);
      if (!host) throw httpError(`${this.hostName(other.hostId)} was running this project and is offline now`, 503);
      await this.hosts.sync(this.store, host, pid);
      if (!(await this.context(pid)).state.runs.some(r => r.id === other.id && active(r.status))) continue;
      if (!waiting) { await say(`Waiting for ${this.hostName(other.hostId)} to finish its run…`); waiting = true; }
      await sleep(2000, null, { signal });
    }
    const { project, me, head } = await this.context(pid);
    if (project.diverged) throw httpError('This project has diverged copies; choose which host to keep first', 409);
    if (me?.state !== 'ready') throw httpError(`${this.hostName(this.hostId)} has no ready copy of this project`, 409);
    if (!head || head.hostId === this.hostId) return;
    // The head host may hold changes it has not committed yet (uploads, an artifact's data), so it
    // is asked even when this host is at the recorded head; offline is fine only then.
    try { await this.pull(pid, { onStart: () => say(`Pulling files from ${this.hostName(head.hostId)}…`) }); }
    catch (e) { if (e.status !== 503 || me.version !== head.id) throw e; }
  }
  async afterRun(pid) {
    const { project, me } = await this.context(pid);
    if (isSynced(project) && syncOf(project).commit === 'auto' && me?.state === 'ready') await this.commit(pid);
  }

  // This host becomes a replica: it marks itself adding, copies the head, then is ready.
  async add(pid, { replace = false } = {}) {
    const { project, root } = await this.context(pid);
    if (!isSynced(project)) throw httpError('Turn sync on first', 409);
    await this.store.mutate(pid, 'replica.adding', s => { s.project.replicas[this.hostId] = { state: 'adding', version: null, at: now() }; });
    try { return await this.pull(pid, { force: replace }); }
    catch (e) { this.report(pid, { phase: 'error', error: e.message }); throw e; }
  }
  // Gives up this host's working tree (confirmed by the user): keep the journal as a stub.
  async drop(pid) {
    return this.serial(pid, async () => {
      const { root, state } = await this.context(pid);
      // Checked here, where this host's own runs are current (a peer's view may lag).
      if (state.runs.some(r => r.hostId === this.hostId && ['queued', 'running', 'waiting'].includes(r.status))) throw httpError(`${this.hostName(this.hostId)} is running this project`, 409);
      for (const name of await fs.readdir(root)) if (name !== '.studio') await fs.rm(path.join(root, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      for (const name of await fs.readdir(path.join(root, '.studio')).catch(() => [])) if (!['events', 'stub'].includes(name)) await fs.rm(path.join(root, '.studio', name), { recursive: true, force: true });
      await this.store.setStub(pid, true);
      await this.store.mutate(pid, 'replica.dropped', s => { delete s.project.replicas[this.hostId]; });
      return { dropped: true };
    });
  }
  // Size of this host's copy, for the confirmation before it is deleted.
  async footprint(pid) {
    const { root } = await this.context(pid), { entries } = await this.files.scan(pid, root), top = new Map();
    for (const [rel, size] of entries) { const key = rel.split('/')[0]; const t = top.get(key) || { path: key, files: 0, bytes: 0 }; t.files++; t.bytes += size; top.set(key, t); }
    return { hostId: this.hostId, files: entries.length, bytes: entries.reduce((n, e) => n + e[1], 0), top: [...top.values()].sort((a, b) => b.bytes - a.bytes) };
  }
  async ensureIgnoreFile(root) { const file = path.join(root, IGNORE_FILE); try { await fs.writeFile(file, IGNORE_TEMPLATE, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
}
