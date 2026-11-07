import { promises as fs, realpath as resolveRealpath } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {changes,applyChanges} from './journal.mjs';
import {defaultStateDir} from './defaults.mjs';
import {migrateProject} from '../public/project-hosts.js';

const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const realpath = promisify(resolveRealpath);
const digest = text => createHash('sha1').update(text).digest('hex');
const journalName = /^(?:v2-)?\d{12}-[\da-f-]+\.json$/;
// A metadata stub holds a project's journal but none of its files.
const isStub = directory => fs.access(path.join(directory, '.studio', 'stub')).then(() => true, () => false);
function error(message, status = 400) { return Object.assign(new Error(message), { status, statusCode: status }); }
async function fingerprint(root, name) {
  const info = await fs.stat(path.join(root, 'events', name));
  return `${name}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

async function assertMetadataDirectories(root) {
  for (const directory of [root, ...['events', 'sessions', 'artifacts'].map(name => path.join(root, name))]) {
    let info;
    try { info = await fs.lstat(directory); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (info.isSymbolicLink()) throw error('Platform metadata directories must not be symbolic links or junctions', 409);
    if (!info.isDirectory()) throw error('Platform metadata path must be a directory', 409);
  }
}

// Authoritative events are flushed to disk. Derived views are rebuildable, so they skip
// fsync: on Windows each flush costs milliseconds and they were rewritten on every commit.
async function atomicWrite(filename, value, { durable = true } = {}) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const tmp = `${filename}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(value, 'utf8'); if (durable) await handle.sync(); } finally { await handle.close(); }
  await fs.rename(tmp, filename);
  // Directory fsync is unavailable on Windows; the file itself was flushed before rename.
  if (durable && process.platform !== 'win32') {
    const dir = await fs.open(path.dirname(filename), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
}

// Serialize without the machine-local path, avoiding a deep clone of the whole state.
function syncedJson(state) {
  const { path: _, ...project } = state.project;
  return JSON.stringify({ ...state, project });
}

function validateState(state) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (state.schemaVersion !== 1 || !uuid.test(state.project?.id ?? '')) throw error('Invalid project state schema or ID', 409);
  for (const key of ['sessions', 'messages', 'runs', 'artifacts', 'annotations']) {
    if (!Array.isArray(state[key])) throw error(`Invalid project state collection: ${key}`, 409);
  }
  for (const key of ['queues', 'nativeSessions']) {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) throw error(`Invalid project state map: ${key}`, 409);
  }
  // These IDs become Markdown filenames. Treat imported histories as data, not paths.
  for (const record of [...state.sessions, ...state.artifacts]) {
    if (!uuid.test(record?.id ?? '')) throw error('Invalid history record ID', 409);
  }
}

// When each conversation last had a message sent or answered: the latest
// createdAt among its user and assistant messages. Opening, renaming or moving a chat does not count.
export function lastMessageTimes(state) {
  const last = new Map();
  for (const m of state.messages) if (m.sessionId && (m.role === 'user' || m.role === 'assistant') && m.createdAt && !(last.get(m.sessionId) >= m.createdAt)) last.set(m.sessionId, m.createdAt);
  return last;
}

// Which readable views a commit changes: the conversations and Artifacts its records belong to.
// The history index is always rewritten. Without a change list (a full state) everything is.
function dirtyViews(before, after, patch) {
  if (!Array.isArray(patch)) return null;
  const sessions = new Set(), artifacts = new Set(), indexes = new Map();
  const find = (collection, id) => {
    let index = indexes.get(collection);
    if (!index) { index = new Map(); for (const state of [before, after]) for (const record of state?.[collection] || []) index.set(record.id, record); indexes.set(collection, index); }
    return index.get(id);
  };
  for (const op of patch) {
    const [collection, id] = op.path || [];
    if (collection === 'messages') {
      const message = find('messages', id); if (!message) continue;
      if (message.sessionId) sessions.add(message.sessionId);
      const artifactId = message.artifactId || (message.annotationId && find('annotations', message.annotationId)?.artifactId);
      if (artifactId) artifacts.add(artifactId);
    } else if (collection === 'sessions') sessions.add(id);
    else if (collection === 'annotations') { const annotation = find('annotations', id); if (annotation) artifacts.add(annotation.artifactId); }
    else if (collection === 'artifacts') artifacts.add(id);
  }
  return { sessions, artifacts };
}
// The order a distributed journal is replayed in.
const eventOrder = (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id);
const later = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; };

/** Immutable transaction files are authoritative; state.json and Markdown are rebuildable. */
export class Store {
  // Readable views are written after the commit, not in it: the Markdown of
  // the conversations and Artifacts that changed `deriveDelay` ms later, state.json once the project
  // has been quiet for `stateDelay` ms (at most four times that after its first change). A run
  // flushes its project first, so the agent reads current history; close() flushes everything.
  constructor({ stateDir = defaultStateDir(), hostId, projectRoot, deriveDelay = 1500, stateDelay = 15000, verifyInterval = 60000 } = {}) {
    if (!hostId) throw error('hostId is required');
    this.stateDir = path.resolve(stateDir);
    this.hostId = hostId;
    this.projectRoot = projectRoot ? path.resolve(projectRoot) : null;
    this.registry = { schemaVersion: 1, projects: [] };
    this.tails = new Map();
    this.listeners = new Set();
    this.derivedErrors = new Map();
    this.eventCache = new Map();
    this.eventLoads = new Map();
    this.derivedCache = new Map();
    this.journalCache = new Map();
    this.deriveDelay = deriveDelay;
    this.stateDelay = stateDelay;
    this.derivePending = new Map();
    // Journal replays (_loadDistributed): one at a time per journal; every file rechecked this often.
    this.journalLocks = new Map();
    this.verifyInterval = verifyInterval;
  }

  _scheduleDerive(id, root, dirty) {
    let pending = this.derivePending.get(id);
    if (!pending) { pending = { root, all: false, markdown: false, sessions: new Set(), artifacts: new Set(), patches: [], since: Date.now() }; this.derivePending.set(id, pending); }
    pending.root = root; pending.markdown = true;
    // Views of a journal still missing parents cannot be built yet; only a local commit reports that.
    if (!dirty?.patch && dirty !== null) pending.strict = true;
    // `patch`: imported changes, resolved against the state when the views are written.
    if (!dirty) pending.all = true;
    else if (dirty.patch) pending.patches.push(dirty.patch);
    else { for (const sid of dirty.sessions) pending.sessions.add(sid); for (const aid of dirty.artifacts) pending.artifacts.add(aid); }
    pending.timer ||= later(() => this.flushDerived(id, { state: false }), this.deriveDelay);
    clearTimeout(pending.stateTimer);
    pending.stateTimer = later(() => this.flushDerived(id), Math.max(0, Math.min(this.stateDelay, pending.since + 4 * this.stateDelay - Date.now())));
  }

  // Writes the pending views of a project now; `state: false` leaves state.json for its own timer.
  async flushDerived(id, { state = true } = {}) {
    if (!this.derivePending.has(id)) return;
    return this._serial(id, async () => {
      const pending = this.derivePending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer); pending.timer = null;
      const work = { strict: pending.strict, all: pending.all, markdown: pending.markdown, sessions: pending.sessions, artifacts: pending.artifacts, patches: pending.patches, state };
      Object.assign(pending, { strict: false, all: false, markdown: false, sessions: new Set(), artifacts: new Set(), patches: [] });
      if (state) { clearTimeout(pending.stateTimer); this.derivePending.delete(id); }
      if (!work.markdown && !state) return;
      try {
        const entry = this._entry(id);
        if (entry.stub) return;
        const current = (await this._load(pending.root)).state;
        for (const patch of work.patches) { const views = dirtyViews(null, current, patch); for (const sid of views.sessions) work.sessions.add(sid); for (const aid of views.artifacts) work.artifacts.add(aid); }
        await this._derive(pending.root, current, work);
        this.derivedErrors.delete(id);
      } catch (e) { if (work.strict) { this.lastDerivedError = e.message; this.derivedErrors.set(id, e.message); } }
    });
  }

  async flushAll() { await Promise.all([...this.derivePending.keys()].map(id => this.flushDerived(id))); }

  _cancelDerive(id) {
    const pending = this.derivePending.get(id);
    if (pending) { clearTimeout(pending.timer); clearTimeout(pending.stateTimer); this.derivePending.delete(id); }
  }

  async init() {
    await fs.mkdir(this.stateDir, { recursive: true });
    try { this.registry = JSON.parse(await fs.readFile(path.join(this.stateDir, 'registry.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw error(`Cannot read local project registry: ${e.message}`, 500); }
    if (this.registry.schemaVersion !== 1 || !Array.isArray(this.registry.projects)) throw error('Unsupported registry schema', 500);
    if (this.projectRoot) {
      await fs.mkdir(this.projectRoot, {recursive:true});
      if ((await fs.lstat(this.projectRoot)).isSymbolicLink()) throw error('Managed projects root must not be a symbolic link',409);
      this.projectRoot = await realpath(this.projectRoot);
      // Absolute paths in the local registry are only a cache. The synced folders are authoritative.
      this.registry.projects = [];
      await this.discoverProjects();
    }
    for (const entry of this.registry.projects) {
      try {
        const root = path.join(entry.path, '.studio');
        const event = await this._load(root);
        if (event.state.project.id !== entry.id) throw error('Project identity mismatch', 409);
        // Each host derives its own readable views; a metadata stub has no working tree to put them in.
        if (!entry.stub) await this._derive(root, event.state);
      } catch (e) { this.lastDerivedError = e.message; this.derivedErrors.set(entry.id, e.message); }
    }
    return this;
  }

  _serial(key, fn) {
    const next = (this.tails.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    this.tails.set(key, next);
    next.finally(() => { if (this.tails.get(key) === next) this.tails.delete(key); }).catch(() => {});
    return next;
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  _notify(projectId, type) { for (const listener of this.listeners) { try { listener({ projectId, type }); } catch {} } }
  // Lets the queue announce uncommitted live output without writing an event.
  notify(projectId, type) { this._notify(projectId, type); }

  // Hard-deleted project IDs: one tombstone per project in projects/.deleted (exchanged with
  // peers in the host index). Names are parsed, not contents, so stray copies count as well.
  async deletedIds() {
    if (!this.projectRoot) return new Set();
    const names = await fs.readdir(path.join(this.projectRoot, '.deleted')).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    return new Set(names.map(name => /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b.*\.json$/i.exec(name)?.[1]?.toLowerCase()).filter(Boolean));
  }

  projectPath(id) {
    if (!this.projectRoot || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw error('Hard deletion requires a managed project ID', 409);
    return path.join(this.projectRoot, id);
  }

  // Deletes the project for every machine. `check` sees the current state under the project's
  // write lock, so no transaction can be committed between the check and the deletion. The
  // tombstone is written before the folder goes, so an interrupted deletion is finished by the
  // next reconcile instead of reappearing.
  async removeProject(id, check = () => {}) {
    return this._serial(id, async () => {
      const entry = this._entry(id);
      await this._checkManagedEntry(entry);
      check((await this._load(path.join(entry.path, '.studio'))).state);
      await atomicWrite(path.join(this.projectRoot, '.deleted', `${id}.json`), JSON.stringify({ id, name: entry.name, deletedAt: now(), hostId: this.hostId }));
      await this._dropFolder(id);
    });
  }

  // Removes this machine's copy of a tombstoned project and forgets it locally.
  async removeFolder(id) { return this._serial(id, () => this._dropFolder(id)); }

  async _dropFolder(id) {
    const directory = this.projectPath(id);
    const info = await fs.lstat(directory).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (info && (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory)) throw error('Project directory must remain inside managed projects', 409);
    if (info) await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    const root = path.join(directory, '.studio');
    for (const key of [root, root + ':legacy']) this.eventCache.delete(key);
    for (const key of [`${root}:false`, `${root}:true`]) this.eventLoads.delete(key);
    this.journalCache.delete(root);
    for (const filename of this.derivedCache.keys()) if (filename.startsWith(root + path.sep)) this.derivedCache.delete(filename);
    this.derivedErrors.delete(id);
    this._cancelDerive(id);
    await this._serial('registry', async () => {
      const before = this.registry.projects.length;
      this.registry.projects = this.registry.projects.filter(p => p.id !== id);
      if (this.registry.projects.length !== before) await atomicWrite(path.join(this.stateDir, 'registry.json'), JSON.stringify(this.registry, null, 2));
    });
    this._notify(id, 'project.deleted');
  }

  async discoverProjects() {
    if (!this.projectRoot) return;
    return this._serial('registry',async()=>{
      const entries=await fs.readdir(this.projectRoot,{withFileTypes:true});
      const deleted=await this.deletedIds();
      const found=[];
      for (const entry of entries) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name)) continue;
        if (deleted.has(entry.name.toLowerCase())) continue;
        const directory=path.join(this.projectRoot,entry.name);
        const cached=this.registry.projects.find(p=>p.id===entry.name);
        try {
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw error('Managed project must be a real directory',409);
          if(cached && !cached.unavailable){found.push(cached);continue;}
          const stub=cached ? Boolean(cached.stub) : await isStub(directory);
          const event=await this._load(path.join(directory,'.studio'));
          if(event.state.project.id!==entry.name)throw error('Project folder ID does not match history',409);
          found.push({...event.state.project,path:directory,...(stub?{stub:true}:{})});
        } catch(e) {
          // A stub whose journal has not arrived yet is visible as unavailable, never initialized or overwritten.
          const stub=cached ? Boolean(cached.stub) : await isStub(directory);
          found.push({id:entry.name,name:cached?.name||entry.name,path:directory,unavailable:true,error:e.message,...(stub?{stub:true}:{})});
        }
      }
      found.sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||'')||a.id.localeCompare(b.id));
      // Cached entries are reused by reference, so an unchanged registry needs no serialization.
      const current=this.registry.projects;
      const same=found.length===current.length&&found.every((entry,i)=>entry===current[i]);
      if(!same&&JSON.stringify(found)!==JSON.stringify(current)){
        this.registry.projects=found;
        await atomicWrite(path.join(this.stateDir,'registry.json'),JSON.stringify(this.registry,null,2));
      }
    });
  }

  // Registered project IDs (including partially synchronized folders) without loading any
  // history. Peer synchronization only needs the IDs.
  async projectIds() {
    await this.discoverProjects();
    return this.registry.projects.map(entry => entry.id);
  }

  // Each project also names its conversations with a run executing now (on any machine), so the
  // project list can show them working without loading every project's messages.
  async listProjects() {
    await this.discoverProjects();
    return Promise.all(this.registry.projects.map(async entry => {
      try {
        const { entry: current, event } = await this._loadEntry(entry.id);
        const running = [...new Set(event.state.runs.filter(r => r.status === 'running' && r.sessionId).map(r => r.sessionId))];
        // The sidebar lists every project's conversations (with forks and categories) without loading their messages.
        const last = lastMessageTimes(event.state);
        const sessions = event.state.sessions.filter(s => !s.archivedAt && !s.deletedAt).map(s => ({ id: s.id, title: s.title, createdAt: s.createdAt, lastMessageAt: last.get(s.id) || s.createdAt || null, forkOf: s.forkOf, forks: s.forks, categoryId: s.categoryId, hostId: s.hostId }));
        // The project's own time is its newest conversation's, so the sidebar can order projects by it.
        const lastMessageAt = sessions.reduce((latest, s) => s.lastMessageAt > latest ? s.lastMessageAt : latest, event.state.project.createdAt || '') || null;
        return { ...clone(event.state.project), path: current.path, replica: !current.stub, lastMessageAt, sessions: clone(sessions), ...(running.length ? { running } : {}) };
      }
      catch (e) { const { stub, ...rest } = clone(entry); return { ...rest, replica: !stub, unavailable: true, error: e.message }; }
    }));
  }

  // Same checks as read(), but clones only the project record instead of every message.
  async getProject(id) {
    const { entry, event } = await this._loadEntry(id);
    return { ...clone(event.state.project), path: entry.path, replica: !entry.stub };
  }

  async createProject({ name, path: directory, group = '' } = {}) {
    return this._serial('registry', async () => {
      if (typeof name !== 'string' || !name.trim()) throw error('Project name is required');
      if (this.projectRoot && directory !== undefined) throw error('Projects use automatically managed folders; custom paths are not accepted');
      if (this.projectRoot && await realpath(this.projectRoot)!==this.projectRoot) throw error('Managed projects root has changed',409);
      const id = randomUUID();
      const target = this.projectRoot ? path.join(this.projectRoot,id) : directory ? path.resolve(directory) : path.join(this.stateDir, 'projects', id);
      await fs.mkdir(target, { recursive: !this.projectRoot });
      const actual = await realpath(target);
      const samePath = this.registry.projects.find(p => process.platform === 'win32' ? p.path.toLowerCase() === actual.toLowerCase() : p.path === actual);
      if (samePath) return this.getProject(samePath.id);
      const root = path.join(actual, '.studio');
      const existing = await this._load(root, true);
      let project;
      if (existing) {
        project = { ...existing.state.project, path: actual };
        const duplicate = this.registry.projects.find(p => p.id === project.id);
        if (duplicate && duplicate.path !== actual) throw error('This project ID is already mapped to another local directory', 409);
      } else {
        project = migrateProject({ id, name: name.trim(), group: String(group), ownerHostId: this.hostId, createdAt: now(), path: actual });
        const state = { schemaVersion: 1, project, sessions: [], messages: [], runs: [], artifacts: [], annotations: [], queues: {}, nativeSessions: {} };
        await this._commit(root, state, 'project.created', null);
      }
      this.registry.projects.push(clone(project));
      await atomicWrite(path.join(this.stateDir, 'registry.json'), JSON.stringify(this.registry, null, 2));
      await this._derive(root, (await this._load(root)).state);
      this._notify(project.id, 'project.created');
      return clone(project);
    });
  }

  _entry(id) {
    const entry = this.registry.projects.find(p => p.id === id);
    if (!entry) throw error('Project not found', 404);
    return entry;
  }
  // Whether this host holds only the project's journal, not a working folder.
  isStub(id) { return Boolean(this.registry.projects.find(p => p.id === id)?.stub); }

  async _load(root, allowMissing = false) {
    // Coalesce concurrent readers while preserving a fresh filesystem check per completed read.
    const key = `${root}:${allowMissing}`;
    if (this.eventLoads.has(key)) return this.eventLoads.get(key);
    const pending = this._loadEvents(root, allowMissing);
    this.eventLoads.set(key, pending);
    try { return await pending; } finally { if(this.eventLoads.get(key)===pending)this.eventLoads.delete(key); }
  }

  async _loadEvents(root, allowMissing = false, legacyOnly = false) {
    await assertMetadataDirectories(root);
    let files;
    try { files = await fs.readdir(path.join(root, 'events')); }
    catch (e) {
      if (allowMissing && e.code === 'ENOENT') {
        const entries = await fs.readdir(root).catch(err => { if (err.code === 'ENOENT') return []; throw err; });
        if (entries.some(name => !name.endsWith('.tmp'))) throw error('Project event history is missing or not yet synchronized; existing metadata will not be replaced', 409);
        return null;
      }
      throw e;
    }
    if (files.some(name => name.includes('sync-conflict'))) throw error('Project event history has a synchronization conflict; resolve it before writing', 409);
    const distributed=files.filter(name=>/^v2-\d{12}-[\da-f-]+\.json$/.test(name)).sort();
    if(!legacyOnly && distributed.length)return this._loadDistributed(root,distributed);
    const cacheKey=legacyOnly ? root+':legacy' : root;
    const names = files.filter(name => /^\d{12}-[\da-f-]+\.json$/.test(name)).sort();
    if (!names.length) {
      const rootEntries = await fs.readdir(root);
      if (allowMissing && !rootEntries.some(name => name !== 'events' && !name.endsWith('.tmp'))) return null;
      throw error('Project event history is missing', 409);
    }
    // Events are immutable snapshots. Recheck names and file identity on every read;
    // parse only appended snapshots when the entire verified prefix is unchanged.
    const fingerprints = [];
    for (let offset = 0; offset < names.length; offset += 32) {
      fingerprints.push(...await Promise.all(names.slice(offset, offset + 32).map(name => fingerprint(root, name))));
    }
    const cached = this.eventCache.get(cacheKey);
    const prefixValid = cached && cached.fingerprints.length <= fingerprints.length && cached.fingerprints.every((value, i) => value === fingerprints[i]);
    let previous = prefixValid ? cached.event : null;
    for (let i = prefixValid ? cached.fingerprints.length : 0; i < names.length; i++) {
      let event;
      try { event = JSON.parse(await fs.readFile(path.join(root, 'events', names[i]), 'utf8')); }
      catch (e) { throw error(`Invalid project event ${names[i]}: ${e.message}`, 409); }
      if (event.schemaVersion !== 1 || event.sequence !== i + 1 || event.previousId !== (previous?.id ?? null) || !event.state?.project?.id || event.state.schemaVersion !== 1) {
        throw error(`Divergent or incomplete project history at ${names[i]}`, 409);
      }
      if (previous && event.state.project.id !== previous.state.project.id) throw error('Project ID changed in event history', 409);
      previous = event;
    }
    validateState(previous.state);
    migrateProject(previous.state.project);
    this.eventCache.set(cacheKey, { fingerprints, event: previous });
    return previous;
  }

  // The distributed journal replays every event in (sequence, id) order onto the root snapshot. A new
  // event made the cached replay stale and every read replayed thousands of events again (300–450 ms on
  // a large project). When the journal only gained events that sort after everything already applied,
  // applying just those to the cached state is the same replay, so that is done instead.
  // Anything else (an event from a concurrent branch that sorts earlier, a
  // file gone or replaced, an error) and a periodic check of every file's identity take the full
  // replay. One journal is replayed by one load at a time, so no event is applied twice.
  async _loadDistributed(root, names) {
    const previous=this.journalLocks.get(root)||Promise.resolve();
    let release;const lock=new Promise(resolve=>{release=resolve;});const chained=previous.then(()=>lock);
    this.journalLocks.set(root,chained);
    await previous;
    try{
      const base=await this._loadEvents(root,false,true);
      const baseKey=(this.eventCache.get(root+':legacy')?.fingerprints||[base.id]).join('|');
      const cached=this.eventCache.get(root);
      if(cached?.baseKey===baseKey&&Date.now()-cached.verifiedAt<this.verifyInterval&&cached.names.length<=names.length&&cached.names.every((name,i)=>name===names[i])){
        if(cached.names.length===names.length)return cached.event;
        try{return await this._applyNew(root,cached,names,base);}
        catch{this.eventCache.delete(root);}
      }
      return await this._replay(root,names,base,baseKey);
    }finally{release();if(this.journalLocks.get(root)===chained)this.journalLocks.delete(root);}
  }

  _checkEvent(event,name,base){
    if(event.schemaVersion!==2 || event.projectId!==base.state.project.id || !Array.isArray(event.parents) || !event.parents.length || !Array.isArray(event.changes) || name!==`v2-${String(event.sequence).padStart(12,'0')}-${event.id}.json`)throw error('Invalid distributed journal event',409);
  }

  _applyEvents(state,events,seen,tips){
    for(const event of events){
      if(seen.has(event.id)||event.parents.some(id=>!seen.has(id))||event.sequence!==1+Math.max(...event.parents.map(id=>seen.get(id))))throw error('Divergent or incomplete distributed history; waiting for synchronization',409);
      applyChanges(state,event.changes);seen.set(event.id,event.sequence);
      for(const id of event.parents)tips.delete(id);tips.add(event.id);
    }
  }

  async _replay(root,names,base,baseKey){
    const prints=await Promise.all(names.map(name=>fingerprint(root,name)));
    const cached=this.eventCache.get(root);
    const signature=baseKey+':'+prints.join('|');
    if(cached?.signature===signature){cached.names=names;cached.verifiedAt=Date.now();return cached.event;}
    let parsed=this.journalCache.get(root)||new Map();
    const events=[];
    for(let i=0;i<names.length;i++){
      let event=parsed.get(prints[i]);
      if(!event){event=JSON.parse(await fs.readFile(path.join(root,'events',names[i]),'utf8'));parsed.set(prints[i],event);}
      this._checkEvent(event,names[i],base);
      events.push(event);
    }
    this.journalCache.set(root,new Map(prints.map(x=>[x,parsed.get(x)])));
    events.sort(eventOrder);
    const seen=new Map([[base.id,base.sequence]]),tips=new Set([base.id]);
    const state=clone(base.state);
    this._applyEvents(state,events,seen,tips);
    validateState(state);if(state.project.id!==base.state.project.id)throw error('Project identity changed in journal',409);migrateProject(state.project);
    const last=events.at(-1),result={...last,state,tips:[...tips].sort()};
    this.eventCache.set(root,{signature,baseKey,names,prints,seen,tips,last,verifiedAt:Date.now(),event:result});return result;
  }

  // The cached replay state is advanced in place; a failure drops the cache and replays in full.
  async _applyNew(root,cached,names,base){
    const fresh=names.slice(cached.names.length);
    const prints=await Promise.all(fresh.map(name=>fingerprint(root,name)));
    const parsed=this.journalCache.get(root)||new Map();
    const events=[];
    for(let i=0;i<fresh.length;i++){
      let event=parsed.get(prints[i]);
      if(!event){event=JSON.parse(await fs.readFile(path.join(root,'events',fresh[i]),'utf8'));parsed.set(prints[i],event);}
      this._checkEvent(event,fresh[i],base);
      events.push(event);
    }
    events.sort(eventOrder);
    if(eventOrder(events[0],cached.last)<=0)throw error('Journal gained an earlier event',409);
    const state=cached.event.state;
    this._applyEvents(state,events,cached.seen,cached.tips);
    validateState(state);if(state.project.id!==base.state.project.id)throw error('Project identity changed in journal',409);migrateProject(state.project);
    const last=events.at(-1),result={...last,state,tips:[...cached.tips].sort()};
    this.journalCache.set(root,parsed);
    cached.prints=[...cached.prints,...prints];cached.names=names;cached.signature=cached.baseKey+':'+cached.prints.join('|');cached.last=last;cached.event=result;
    return result;
  }

  // Sorted journal file names, the root snapshot events (v1) first: peers compare these every
  // few seconds, so no event body is read or parsed here. A metadata stub on another server
  // starts from nothing, so the root events travel too.
  async journalNames(id) {
    const entry=this._entry(id);await this._checkManagedEntry(entry);const root=path.join(entry.path,'.studio','events');await assertMetadataDirectories(path.dirname(root));
    return (await fs.readdir(root).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).filter(n=>journalName.test(n)).sort();
  }
  async journal(id, known=[]) {
    const names=await this.journalNames(id),root=path.join(this._entry(id).path,'.studio','events');
    const have=new Set(known),events=[];let bytes=0;
    for(const name of names){if(have.has(name))continue;const text=await fs.readFile(path.join(root,name),'utf8');if(bytes+text.length>1000000&&events.length)break;bytes+=text.length;events.push({name,event:JSON.parse(text)});}
    return {names,events};
  }
  async importJournal(id, events) {
    if(!Array.isArray(events))throw error('Invalid journal');
    return this._serial(id,async()=>{
      const entry=this._entry(id);await this._checkManagedEntry(entry);
      const root=path.join(entry.path,'.studio');await assertMetadataDirectories(root);
      let written=0;const imported=[];
      for(const {name,event} of events){
        const valid=name.startsWith('v2-')
          ? event?.schemaVersion===2&&event.projectId===id&&name===`v2-${String(event.sequence).padStart(12,'0')}-${event.id}.json`&&Array.isArray(event.changes)&&Array.isArray(event.parents)
          : event?.schemaVersion===1&&event.state?.project?.id===id&&name===`${String(event.sequence).padStart(12,'0')}-${event.id}.json`;
        if(!journalName.test(name)||!valid)throw error('Invalid journal');
        const file=path.join(root,'events',name),text=JSON.stringify(event);
        try{const old=await fs.readFile(file,'utf8');if(old!==text)throw error('Journal identity collision',409);}catch(e){if(e.code!=='ENOENT')throw e;await atomicWrite(file,text);written++;imported.push(name.startsWith('v2-')?event.changes:null);}
      }
      // Peers exchange empty journals every few seconds while idle. Only a file that actually
      // landed on disk invalidates in-flight reads and wakes every connected browser tab.
      if(!written)return;
      this.eventLoads.delete(`${root}:false`);this.eventLoads.delete(`${root}:true`);
      // Replicas keep their own readable history views current; a journal still missing parents is skipped.
      if(!entry.stub)this._scheduleDerive(id,root,imported.every(Boolean)?{patch:imported.flat()}:null);
      this._notify(id,'journal.synced');
    });
  }

  // A project known only from a peer's index: an empty journal plus the stub marker, filled by
  // the next journal exchange. Tombstoned or already known projects are left alone.
  async adoptProject(id, name = id) {
    if (!this.projectRoot || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw error('Only managed projects can be adopted');
    return this._serial('registry', async () => {
      if (this.registry.projects.some(p => p.id === id) || (await this.deletedIds()).has(id)) return false;
      const directory = path.join(this.projectRoot, id);
      // A folder already there (copied in, not yet discovered) is a real copy: discovery registers it.
      if (await fs.stat(directory).then(() => true, () => false)) return false;
      await fs.mkdir(path.join(directory, '.studio', 'events'), { recursive: true });
      await atomicWrite(path.join(directory, '.studio', 'stub'), JSON.stringify({ adoptedAt: now(), hostId: this.hostId }));
      this.registry.projects.push({ id, name: String(name), path: directory, unavailable: true, stub: true });
      await atomicWrite(path.join(this.stateDir, 'registry.json'), JSON.stringify(this.registry, null, 2));
      this._notify(id, 'project.adopted');
      return true;
    });
  }

  // A replica gains its working tree (pull) or gives it up (drop): the stub marker follows.
  async setStub(id, stub) {
    return this._serial('registry', async () => {
      const entry = this._entry(id); await this._checkManagedEntry(entry);
      const marker = path.join(entry.path, '.studio', 'stub');
      if (stub) await atomicWrite(marker, JSON.stringify({ droppedAt: now(), hostId: this.hostId })); else await fs.rm(marker, { force: true });
      if (Boolean(entry.stub) === Boolean(stub)) return;
      if (stub) entry.stub = true; else delete entry.stub;
      await atomicWrite(path.join(this.stateDir, 'registry.json'), JSON.stringify(this.registry, null, 2));
      if (!stub) try { const root = path.join(entry.path, '.studio'); await this._derive(root, (await this._load(root)).state); } catch {}
      this._notify(id, stub ? 'replica.dropped' : 'replica.ready');
    });
  }

  async _loadEntry(id) {
    if(this.projectRoot && !this.registry.projects.some(p=>p.id===id))await this.discoverProjects();
    const entry = this._entry(id);
    await this._checkManagedEntry(entry);
    const event = await this._load(path.join(entry.path, '.studio'));
    if (event.state.project.id !== id) throw error('Project directory identity does not match registry', 409);
    return { entry, event };
  }

  async read(id) {
    const { entry, event } = await this._loadEntry(id);
    const state = clone(event.state);
    state.project.path = entry.path;
    state.project.replica = !entry.stub;
    return this.derivedErrors.has(id) ? { ...state, storageWarning: this.derivedErrors.get(id) } : state;
  }

  async mutate(id, type, fn) {
    return this._serial(id, async () => {
      const entry = this._entry(id);
      await this._checkManagedEntry(entry);
      const root = path.join(entry.path, '.studio');
      const previous = await this._load(root);
      if (previous.state.project.id !== id) throw error('Project directory identity does not match registry', 409);
      const state = clone(previous.state);
      state.project.path = entry.path;
      const result = fn(state);
      delete state.project.replica;
      if (result && typeof result.then === 'function') throw error('Store mutation callback must be synchronous');
      if (state.project.id !== id) throw error('Project identity cannot change');
      // _commit serializes before writing. Failed callbacks never publish an event.
      const event = await this._commit(root, state, type, previous);
      // Once the authority committed, a failed derived view must not report a failed transaction;
      // the views follow shortly after (see the constructor).
      if (!entry.stub) this._scheduleDerive(id, root, event.dirty);
      this._notify(id, type);
      return clone(result);
    });
  }

  async _checkManagedEntry(entry) {
    if(!this.projectRoot)return;
    if(entry.path!==path.join(this.projectRoot,entry.id)||(await fs.lstat(entry.path)).isSymbolicLink()||await realpath(entry.path)!==entry.path)throw error('Project directory must remain inside managed projects',409);
  }

  async _commit(root, state, type, previous) {
    // Serialize once: the parsed copy is validated, cached and derived; the text is written.
    const json = syncedJson(state);
    const synced = JSON.parse(json);
    validateState(synced);
    // The change list and the views it touches are taken before the first await: the loaded state is
    // the cached replay, which a concurrent read advances in place once new journal files appear.
    const header = { schemaVersion: previous ? 2 : 1, id: randomUUID(), sequence: (previous?.sequence || 0) + 1, previousId: previous?.id ?? null, createdAt: now(), hostId: this.hostId, type };
    const event = previous ? {...header, projectId:state.project.id, parents:previous.tips||[previous.id], changes:changes(previous.state,synced)} : {...header,state:synced};
    const dirty = previous ? dirtyViews(previous.state, synced, event.changes) : null;
    await assertMetadataDirectories(root);
    const filename = `${previous?'v2-':''}${String(header.sequence).padStart(12, '0')}-${header.id}.json`;
    await atomicWrite(path.join(root, 'events', filename), JSON.stringify(event));
    // The cached replay stays: the next read applies this one event (see _loadDistributed).
    this.eventLoads.delete(`${root}:false`);this.eventLoads.delete(`${root}:true`);
    // The callback needs the committed state; the file only contains changed fields.
    Object.defineProperty(event, 'dirty', { value: dirty, enumerable: false });
    event.state=synced;

    return event;
  }

  // Rewrite a derived view only when its content changed or the file was altered on disk.
  async _writeDerived(filename, content) {
    const hash = digest(content), cached = this.derivedCache.get(filename);
    if (cached?.hash === hash) {
      const info = await fs.stat(filename).catch(() => null);
      if (info && info.size === cached.size && info.mtimeMs === cached.mtimeMs) return;
    } else if (!cached) {
      // After restart, leave an identical file untouched instead of rewriting every view.
      const existing = await fs.readFile(filename, 'utf8').catch(() => null);
      if (existing === content) {
        const info = await fs.stat(filename);
        this.derivedCache.set(filename, { hash, size: info.size, mtimeMs: info.mtimeMs });
        return;
      }
    }
    this.derivedCache.delete(filename);
    await atomicWrite(filename, content, { durable: false });
    const info = await fs.stat(filename);
    this.derivedCache.set(filename, { hash, size: info.size, mtimeMs: info.mtimeMs });
  }

  // `work` (from flushDerived) limits the Markdown to what changed and says whether state.json is due.
  async _derive(root, state, work = null) {
    await assertMetadataDirectories(root);
    const all = !work || work.all;
    if (!work || work.state) await this._writeDerived(path.join(root, 'state.json'), JSON.stringify(state, null, 2));
    if (!all && !work.markdown) return;
    const writeSession = id => all || work.sessions.has(id), writeArtifact = id => all || work.artifacts.has(id);
    // Remove obsolete derived session exports after authoritative deletion.
    // Immutable events remain the sync journal, not a user-facing recycle bin.
    const sessionDir=path.join(root,'sessions');
    const exports=await fs.readdir(sessionDir).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    const sessionIds=new Set(state.sessions.map(s=>s.id));
    for(const filename of exports){
      const match=/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.operations)?\.md$/i.exec(filename);
      if(match&&!sessionIds.has(match[1])){await fs.unlink(path.join(sessionDir,filename));this.derivedCache.delete(path.join(sessionDir,filename));}
    }
    // Group once instead of scanning every message for every session and comment.
    const bySession = new Map(), byAnnotation = new Map(), byArtifact = new Map();
    const group = (map, key, value) => { if (key === undefined) return; const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
    for (const m of state.messages) { group(bySession, m.sessionId, m); group(byAnnotation, m.annotationId, m); }
    for (const a of state.annotations) group(byArtifact, a.artifactId, a);
    const lines = [`# ${state.project.name} — shared project history`, '', 'These are public conversations and operation records. Each agent decides which history to read.', '', '## Sessions', ''];
    const format = messages => messages.map(m => `## ${m.createdAt} · ${m.role}${m.profileId ? ` · ${m.profileId}` : ''}\n\n${m.text}\n${m.attachments?.length ? `\nAttachments: ${m.attachments.join(', ')}\n` : ''}${m.runId ? `\nRun: ${m.runId}\n` : ''}`).join('\n');
    for (const session of state.sessions) {
      const name = `sessions/${session.id}.md`;
      if (!session.deletedAt) lines.push(`- [${String(session.title).replace(/[\[\]\r\n]/g, ' ')}](${name})${session.archivedAt ? ' · archived' : ''}`);
      if (!writeSession(session.id)) continue;
      const messages = bySession.get(session.id) || [];
      await this._writeDerived(path.join(root, name), `# ${session.title}\n\nOperation records: [${session.id}.operations.md](${session.id}.operations.md)\n\n${format(messages.filter(m => m.role !== 'system' && m.kind !== 'narration'))}`);
      // What agents said between tool calls is part of the operation record, not the conversation.
      await this._writeDerived(path.join(root, 'sessions', `${session.id}.operations.md`), `# Operation records — ${session.title}\n\n${format(messages.filter(m => m.role === 'system' || m.progressText || m.kind === 'narration').map(m => m.progressText ? {...m,text:m.progressText} : m))}`);
    }
    lines.push('', '## Artifact comments', '');
    for (const artifact of state.artifacts) {
      const name = `artifacts/${artifact.id}.md`;
      lines.push(`- [${String(artifact.name).replace(/[\[\]\r\n]/g, ' ')}](${name})`);
      if (!writeArtifact(artifact.id)) continue;
      const annotations = (byArtifact.get(artifact.id) || []).map(a => `## Comment ${a.id} · ${a.status} · ${a.anchorStatus}\n\n${a.text}\n\nAnchor: ${JSON.stringify(a.anchor)}\n\n${format(byAnnotation.get(a.id) || [])}`).join('\n');
      await this._writeDerived(path.join(root, name), `# ${artifact.name}\n\n${annotations}`);
    }
    lines.push('', '## Runs', '', ...state.runs.map(r => `- ${r.id} · ${r.status} · ${r.profileId} · ${r.model} · host ${r.hostId}`), '');
    await this._writeDerived(path.join(root, 'history-index.md'), lines.join('\n'));
  }
}
