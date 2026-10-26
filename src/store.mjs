import { promises as fs, realpath as resolveRealpath } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import {changes,applyChanges} from './journal.mjs';

const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const realpath = promisify(resolveRealpath);
const digest = text => createHash('sha1').update(text).digest('hex');
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

/** Immutable transaction files are authoritative; state.json and Markdown are rebuildable. */
export class Store {
  constructor({ stateDir = path.join(os.homedir(), '.studio-local'), hostId, projectRoot } = {}) {
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
        if (!this.projectRoot || event.state.project.ownerHostId === this.hostId) await this._derive(root, event.state);
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

  // Hard-deleted project IDs: one tombstone per project in the synced projects/.deleted
  // folder. Names are parsed, not contents, so Syncthing conflict copies count as well.
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
          const event=await this._load(path.join(directory,'.studio'));
          if(event.state.project.id!==entry.name)throw error('Project folder ID does not match history',409);
          found.push({...event.state.project,path:directory});
        } catch(e) {
          // Partial Syncthing arrivals are visible as unavailable, never initialized or overwritten.
          found.push({id:entry.name,name:cached?.name||entry.name,path:directory,unavailable:true,error:e.message});
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

  async listProjects() {
    await this.discoverProjects();
    return Promise.all(this.registry.projects.map(async entry => {
      try { return await this.getProject(entry.id); }
      catch (e) { return { ...clone(entry), unavailable: true, error: e.message }; }
    }));
  }

  // Same checks as read(), but clones only the project record instead of every message.
  async getProject(id) {
    const { entry, event } = await this._loadEntry(id);
    return { ...clone(event.state.project), path: entry.path };
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
        project = { id, name: name.trim(), group: String(group), ownerHostId: this.hostId, createdAt: now(), path: actual };
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
    this.eventCache.set(cacheKey, { fingerprints, event: previous });
    return previous;
  }

  async _loadDistributed(root, names) {
    const base=await this._loadEvents(root,false,true);
    const prints=await Promise.all(names.map(name=>fingerprint(root,name)));
    const cached=this.eventCache.get(root);
    const signature=(this.eventCache.get(root+':legacy')?.fingerprints||[base.id]).join('|')+':'+prints.join('|');
    if(cached?.signature===signature)return cached.event;
    let parsed=this.journalCache.get(root)||new Map();
    const events=[];
    for(let i=0;i<names.length;i++){
      let event=parsed.get(prints[i]);
      if(!event){event=JSON.parse(await fs.readFile(path.join(root,'events',names[i]),'utf8'));parsed.set(prints[i],event);}
      if(event.schemaVersion!==2 || event.projectId!==base.state.project.id || !Array.isArray(event.parents) || !event.parents.length || !Array.isArray(event.changes) || names[i]!==`v2-${String(event.sequence).padStart(12,'0')}-${event.id}.json`)throw error('Invalid distributed journal event',409);
      events.push(event);
    }
    this.journalCache.set(root,new Map(prints.map(x=>[x,parsed.get(x)])));
    events.sort((a,b)=>a.sequence-b.sequence||a.id.localeCompare(b.id));
    const seen=new Map([[base.id,base.sequence]]),tips=new Set([base.id]);
    const state=clone(base.state);
    for(const event of events){
      if(seen.has(event.id)||event.parents.some(id=>!seen.has(id))||event.sequence!==1+Math.max(...event.parents.map(id=>seen.get(id))))throw error('Divergent or incomplete distributed history; waiting for synchronization',409);
      applyChanges(state,event.changes);seen.set(event.id,event.sequence);
      for(const id of event.parents)tips.delete(id);tips.add(event.id);
    }
    validateState(state);if(state.project.id!==base.state.project.id)throw error('Project identity changed in journal',409);
    const last=events.at(-1),result={...last,state,tips:[...tips].sort()};
    this.eventCache.set(root,{signature,event:result});return result;
  }

  // Sorted v2 journal file names only: peers compare these every few seconds, so no event
  // body is read or parsed here.
  async journalNames(id) {
    const entry=this._entry(id);await this._checkManagedEntry(entry);const root=path.join(entry.path,'.studio','events');await assertMetadataDirectories(path.dirname(root));
    return (await fs.readdir(root)).filter(n=>/^v2-\d{12}-[\da-f-]+\.json$/.test(n)).sort();
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
      let written=0;
      for(const {name,event} of events){
        if(!/^v2-\d{12}-[\da-f-]+\.json$/.test(name)||event.schemaVersion!==2||event.projectId!==id||name!==`v2-${String(event.sequence).padStart(12,'0')}-${event.id}.json`||!Array.isArray(event.changes)||!Array.isArray(event.parents))throw error('Invalid journal');
        const file=path.join(root,'events',name),text=JSON.stringify(event);
        try{const old=await fs.readFile(file,'utf8');if(old!==text)throw error('Journal identity collision',409);}catch(e){if(e.code!=='ENOENT')throw e;await atomicWrite(file,text);written++;}
      }
      // Peers exchange empty journals every few seconds while idle. Only a file that actually
      // landed on disk invalidates in-flight reads and wakes every connected browser tab.
      if(!written)return;
      this.eventLoads.delete(`${root}:false`);this.eventLoads.delete(`${root}:true`);
      this._notify(id,'journal.synced');
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
      if (result && typeof result.then === 'function') throw error('Store mutation callback must be synchronous');
      if (state.project.id !== id) throw error('Project identity cannot change');
      // _commit serializes before writing. Failed callbacks never publish an event.
      const event = await this._commit(root, state, type, previous);
      // Once the authority committed, a failed derived view must not report a failed transaction.
      try { await this._derive(root, event.state); this.derivedErrors.delete(id); }
      catch (e) { this.lastDerivedError = e.message; this.derivedErrors.set(id, e.message); }
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
    await assertMetadataDirectories(root);
    const header = { schemaVersion: previous ? 2 : 1, id: randomUUID(), sequence: (previous?.sequence || 0) + 1, previousId: previous?.id ?? null, createdAt: now(), hostId: this.hostId, type };
    const event = previous ? {...header, projectId:state.project.id, parents:previous.tips||[previous.id], changes:changes(previous.state,synced)} : {...header,state:synced};
    const filename = `${previous?'v2-':''}${String(header.sequence).padStart(12, '0')}-${header.id}.json`;
    await atomicWrite(path.join(root, 'events', filename), JSON.stringify(event));
    this.eventLoads.delete(`${root}:false`);this.eventLoads.delete(`${root}:true`);
    this.eventCache.delete(root);
    // The callback needs the committed state; the file only contains changed fields.
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

  async _derive(root, state) {
    await assertMetadataDirectories(root);
    await this._writeDerived(path.join(root, 'state.json'), JSON.stringify(state, null, 2));
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
      const messages = bySession.get(session.id) || [];
      await this._writeDerived(path.join(root, name), `# ${session.title}\n\nOperation records: [${session.id}.operations.md](${session.id}.operations.md)\n\n${format(messages.filter(m => m.role !== 'system' && m.kind !== 'narration'))}`);
      // What agents said between tool calls is part of the operation record, not the conversation.
      await this._writeDerived(path.join(root, 'sessions', `${session.id}.operations.md`), `# Operation records — ${session.title}\n\n${format(messages.filter(m => m.role === 'system' || m.progressText || m.kind === 'narration').map(m => m.progressText ? {...m,text:m.progressText} : m))}`);
    }
    lines.push('', '## Artifact comments', '');
    for (const artifact of state.artifacts) {
      const name = `artifacts/${artifact.id}.md`;
      lines.push(`- [${String(artifact.name).replace(/[\[\]\r\n]/g, ' ')}](${name})`);
      const annotations = (byArtifact.get(artifact.id) || []).map(a => `## Comment ${a.id} · ${a.status} · ${a.anchorStatus}\n\n${a.text}\n\nAnchor: ${JSON.stringify(a.anchor)}\n\n${format(byAnnotation.get(a.id) || [])}`).join('\n');
      await this._writeDerived(path.join(root, name), `# ${artifact.name}\n\n${annotations}`);
    }
    lines.push('', '## Runs', '', ...state.runs.map(r => `- ${r.id} · ${r.status} · ${r.profileId} · ${r.model} · host ${r.hostId}`), '');
    await this._writeDerived(path.join(root, 'history-index.md'), lines.join('\n'));
  }
}
