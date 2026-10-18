import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import http from 'node:http';
import {gunzipSync} from 'node:zlib';
// fetch() decompresses transparently; the raw bytes show whether the body was really gzip.
const rawGet = (url, headers) => new Promise((resolve, reject) => { http.get(url, { headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); res.on('error', reject); }).on('error', reject); });
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {Hosts} from '../src/hosts.mjs';
import {CliRunner} from '../src/runner.mjs';
import {createStudio} from '../src/server.mjs';
import {changes, jsonEqual, journalDigest} from '../src/journal.mjs';

// The original diff compared JSON.stringify output at every level; the structural version
// must produce exactly the same operations.
const plain = x => x && typeof x === 'object' && !Array.isArray(x);
const collections = new Set(['sessions','messages','runs','artifacts','annotations']);
function referenceChanges(before, after, location = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (location.length === 1 && collections.has(location[0])) {
    const a = Object.fromEntries((before || []).map(x => [x.id,x])), b = Object.fromEntries((after || []).map(x => [x.id,x]));
    return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(id => referenceChanges(a[id],b[id],[...location,id]));
  }
  if (plain(before) && plain(after)) return [...new Set([...Object.keys(before),...Object.keys(after)])].flatMap(key => referenceChanges(before[key],after[key],[...location,key]));
  return [{path:location,...(after === undefined ? {remove:true} : {value:after})}];
}

test('structural JSON equality matches JSON.stringify equality, including dropped and non-finite values', () => {
  const samples = [null, undefined, 0, -0, 1, 1.5, NaN, Infinity, 'a', '', true, false, [], [1,2], [2,1], [1,undefined], [1,null], [undefined], [null], {}, {a:1}, {a:1,b:2}, {b:2,a:1}, {a:undefined}, {a:[{x:1}]}, {a:[{x:1,y:2}]}, {a:[{y:2,x:1}]}, {d:new Date(0)}, {d:new Date(1)}, {f(){}}, {a:{b:{c:[1,{d:null}]}}}, {a:{b:{c:[1,{d:undefined}]}}}, 'null', [[]], [{}]];
  for (const a of samples) for (const b of samples) assert.equal(jsonEqual(a,b), JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
});

test('journal changes are identical to the serialization-based reference on realistic mutations', () => {
  const base = { schemaVersion: 1, project: { id: 'p', name: 'Example', ownerHostId: 'a', createdAt: 't0' },
    sessions: [{ id: 's1', title: 'One', selection: { model: 'm', reasoningEffort: null, permissionMode: 'auto' } }, { id: 's2', title: 'Two' }],
    messages: [{ id: 'm1', sessionId: 's1', role: 'user', text: 'hi' }, { id: 'm2', sessionId: 's1', role: 'assistant', text: 'partial' }],
    runs: [{ id: 'r1', sessionId: 's1', status: 'running', approvals: [{ id: 'a1', status: 'pending' }], usage: { turn: { inputTokens: 1 } } }, { id: 'r2', sessionId: 's2', status: 'succeeded' }],
    artifacts: [{ id: 'x1', name: 'App', command: ['node', 'server.mjs'], dataPaths: ['data'] }], annotations: [], queues: { 'session:s1': { paused: false } }, nativeSessions: {} };
  const after = structuredClone(base);
  after.sessions.push({ id: 's3', title: 'Three' });
  after.sessions[0].title = 'Renamed'; after.sessions[0].selection = { permissionMode: 'auto', model: 'm', reasoningEffort: null };
  after.messages[1].text = 'partial and more'; after.messages.push({ id: 'm3', sessionId: 's1', role: 'system', text: 'done' });
  after.runs = after.runs.filter(r => r.id !== 'r2'); after.runs[0].status = 'succeeded'; after.runs[0].approvals[0].status = 'approved'; after.runs[0].usage.turn.outputTokens = 2; delete after.runs[0].usage.turn.inputTokens;
  after.artifacts[0].command = ['node', 'server.mjs', '--port']; after.artifacts[0].dataPaths = ['data'];
  after.queues['session:s1'] = { paused: true, reason: 'x' }; after.nativeSessions['a:claude:s1'] = 'native';
  after.project.archivedAt = 't1'; after.extra = undefined;
  assert.deepEqual(changes(base, after), referenceChanges(base, after));
  assert.deepEqual(changes(base, structuredClone(base)), []);
  assert.deepEqual(changes(undefined, base), referenceChanges(undefined, base));
  assert.deepEqual(changes(base, undefined), referenceChanges(base, undefined));
  const reordered = structuredClone(base); reordered.sessions[0] = { title: 'One', id: 's1', selection: { permissionMode: 'auto', model: 'm', reasoningEffort: null } };
  assert.deepEqual(changes(base, reordered), referenceChanges(base, reordered));
});

async function replicas(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-efficiency-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = await new Store({ stateDir: path.join(root, 'a'), hostId: 'a' }).init(); const p = await a.createProject({ name: 'Shared' });
  const copy = path.join(root, 'copy'); await fs.cp(p.path, copy, { recursive: true });
  const b = await new Store({ stateDir: path.join(root, 'b'), hostId: 'b' }).init(); await b.createProject({ path: copy, name: 'Shared' });
  return { root, a, b, p };
}

test('importing a journal that adds nothing neither notifies clients nor touches the read cache', async t => {
  const { a, b, p } = await replicas(t); const events = []; b.subscribe(e => events.push(e));
  await a.mutate(p.id, 'rename', s => { s.project.name = 'renamed'; });
  const journal = await a.journal(p.id);
  await b.importJournal(p.id, journal.events);
  assert.equal(events.filter(e => e.type === 'journal.synced').length, 1);
  assert.equal((await b.read(p.id)).project.name, 'renamed');
  const cached = b.eventCache.get(path.join(b.registry.projects[0].path, '.studio')).event;
  await b.importJournal(p.id, journal.events); await b.importJournal(p.id, []);
  assert.equal(events.filter(e => e.type === 'journal.synced').length, 1);
  assert.equal(b.eventCache.get(path.join(b.registry.projects[0].path, '.studio')).event, cached);
  assert.deepEqual(await b.journalNames(p.id), journal.names);
  assert.deepEqual((await b.journal(p.id)).names, journal.names);
  assert.deepEqual((await b.journal(p.id, journal.names)).events, []);
});

// A fake peer that behaves like the /journal route of another server.
function peer(store, id, log, { digests = true } = {}) {
  return async (host, url, { data } = {}) => {
    log.push(data);
    if (digests && typeof data.digest === 'string' && data.known === undefined && data.events === undefined) {
      const names = await store.journalNames(id), digest = journalDigest(names);
      return digest === data.digest ? { same: true, digest, names: [], events: [] } : { names, events: [], digest };
    }
    await store.importJournal(id, data.events || []);
    const result = await store.journal(id, data.known || []);
    return digests ? { ...result, digest: journalDigest(result.names) } : result;
  };
}

test('idle peers exchange one digest probe instead of two name lists, and still converge after changes on either side', async t => {
  const { root, a, b, p } = await replicas(t), log = [];
  const hosts = new Hosts({ machine: { hostId: 'a', name: 'A', hosts: [] }, projectRoot: path.join(root, 'servers'), profiles: async () => [] }); await hosts.init();
  const host = { id: 'b', name: 'B', url: 'http://b.invalid' };
  hosts.request = peer(b, p.id, log);
  await a.mutate(p.id, 'one', s => { s.project.name = 'one'; });
  await hosts.sync(a, host, p.id);
  assert.equal((await b.read(p.id)).project.name, 'one');
  assert.ok(log.length >= 2 && log.every(d => Array.isArray(d.known)), 'first synchronization uses the full protocol');
  log.length = 0; await hosts.sync(a, host, p.id);
  assert.equal(log.length, 1); assert.equal(typeof log[0].digest, 'string'); assert.equal(log[0].known, undefined); assert.equal(log[0].events, undefined);
  await b.mutate(p.id, 'two', s => { s.project.name = 'two'; });
  log.length = 0; await hosts.sync(a, host, p.id);
  assert.equal((await a.read(p.id)).project.name, 'two');
  assert.equal(typeof log[0].digest, 'string'); assert.ok(log.slice(1).every(d => Array.isArray(d.known)));
  log.length = 0; await hosts.sync(a, host, p.id); assert.equal(log.length, 1);
  await a.mutate(p.id, 'three', s => { s.project.name = 'three'; });
  log.length = 0; await hosts.sync(a, host, p.id);
  assert.ok(Array.isArray(log[0].known), 'a local change skips the probe');
  assert.equal((await b.read(p.id)).project.name, 'three');
  assert.deepEqual(await a.journalNames(p.id), await b.journalNames(p.id));
  // A peer running the previous protocol never reports a digest, so it is never probed again.
  hosts.request = peer(b, p.id, log, { digests: false });
  await hosts.sync(a, host, p.id); log.length = 0; await hosts.sync(a, host, p.id);
  assert.ok(log.length >= 1 && log.every(d => Array.isArray(d.known)));
});

test('executable discovery is reused across calls, returns independent copies and follows the machine profile file at once', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-config-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const runner = new CliRunner({ stateDir: dir, hostId: 'x', executables: { claude: { command: process.execPath, models: [{ id: 'm' }] } } });
  let walks = 0; const inner = runner._configuration.bind(runner); runner._configuration = async () => { walks++; return inner(); };
  const first = await runner.configuration(), second = await runner.configuration();
  assert.equal(walks, 1); assert.deepEqual(first, second); assert.notEqual(first, second);
  second.claude.models.push({ id: 'mutated' });
  assert.equal((await runner.configuration()).claude.models.length, 1);
  await fs.writeFile(path.join(dir, 'agent-profiles.json'), JSON.stringify({ codex: { command: process.execPath, models: [{ id: 'from-disk' }] } }));
  assert.equal((await runner.configuration()).codex.models[0].id, 'from-disk'); assert.equal(walks, 2);
  assert.ok((await runner.profiles()).find(p => p.id === 'codex').available); assert.equal(walks, 2);
  const uncached = new CliRunner({ stateDir: dir, hostId: 'x', configTtlMs: 0 }); let direct = 0; const run = uncached._configuration.bind(uncached); uncached._configuration = async () => { direct++; return run(); };
  await uncached.configuration(); await uncached.configuration(); assert.equal(direct, 2);
});

async function studio(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-efficiency-server-'));
  const runner = { profiles: async () => [{ id: 'fake', label: 'test', available: true, models: [{ id: 'test', label: 'Test' }] }], execute: async () => ({ text: 'ok' }) };
  const app = await createStudio({ stateDir: path.join(root, 'local'), projectRoot: path.join(root, 'projects'), port: 0, previewPort: 0, runner });
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.port}`;
  const raw = (url, options = {}) => fetch(base + url, options);
  const api = async (url, method = 'GET', data) => { const res = await raw(url, { method, headers: { 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined }); const result = await res.json(); if (!res.ok) throw Object.assign(Error(result.error), { status: res.status }); return result; };
  return { app, api, raw };
}

test('the journal route answers digest probes without reading events and reports its digest on full exchanges', async t => {
  const { app, api } = await studio(t); const p = await api('/api/projects', 'POST', { name: 'digest' });
  await app.store.mutate(p.id, 'rename', s => { s.project.name = 'digest-2'; });
  const names = await app.store.journalNames(p.id), digest = journalDigest(names);
  assert.equal(names.length, 1);
  assert.deepEqual(await api(`/api/projects/${p.id}/journal`, 'POST', { digest }), { same: true, digest, names: [], events: [] });
  const stale = await api(`/api/projects/${p.id}/journal`, 'POST', { digest: 'different' });
  assert.deepEqual(stale, { names, events: [], digest });
  const full = await api(`/api/projects/${p.id}/journal`, 'POST', { known: [], events: [] });
  assert.deepEqual(full.names, names); assert.equal(full.events.length, 1); assert.equal(full.digest, digest);
  const partial = await api(`/api/projects/${p.id}/journal`, 'POST', { known: names });
  assert.deepEqual(partial.events, []); assert.equal(partial.digest, digest);
});

test('repeated large responses are served compressed from the content cache with identical bodies', async t => {
  const { app, api, raw } = await studio(t); const p = await api('/api/projects', 'POST', { name: 'large' });
  const s = await api(`/api/projects/${p.id}/sessions`, 'POST', { title: 'Big' });
  await app.store.mutate(p.id, 'fill', state => { for (let i = 0; i < 12; i++) state.messages.push({ id: randomUUID(), sessionId: s.id, role: 'user', text: `${i}:${'x'.repeat(4000)}`, createdAt: new Date().toISOString() }); });
  const url = `http://127.0.0.1:${app.port}/api/projects/${p.id}`;
  const plain = (await rawGet(url, { 'Accept-Encoding': 'identity' })).body.toString('utf8');
  assert.ok(plain.length > 32768);
  const bodies = [];
  for (let i = 0; i < 3; i++) { const res = await rawGet(url, { 'Accept-Encoding': 'gzip' }); assert.equal(res.headers['content-encoding'], 'gzip'); assert.ok(res.body.length < plain.length / 4); bodies.push(gunzipSync(res.body).toString('utf8')); }
  assert.deepEqual(bodies, [plain, plain, plain]);
  await app.store.mutate(p.id, 'rename', state => { state.project.name = 'changed'; });
  const res = await rawGet(url, { 'Accept-Encoding': 'gzip' });
  assert.equal(JSON.parse(gunzipSync(res.body).toString('utf8')).project.name, 'changed');
  assert.equal(JSON.parse((await rawGet(url, { 'Accept-Encoding': 'identity' })).body.toString('utf8')).project.name, 'changed');
});

test('the browser merges a runtime view like the server: executing runs replaced, their messages upserted, local native runtime refreshed', async () => {
  const ui = await fs.readFile(new URL('../public/ui.js', import.meta.url), 'utf8');
  const source = ui.slice(ui.indexOf('export function mergeRuntime('), ui.indexOf('export const $')).replace('export function', 'function');
  const context = {}; vm.createContext(context); vm.runInContext(source + ';this.mergeRuntime=mergeRuntime;', context);
  const state = { runs: [{ id: 'r1', status: 'running' }, { id: 'r2', status: 'succeeded' }], messages: [{ id: 'm1', runId: 'r1', text: 'a' }, { id: 'm0', runId: 'r2', text: 'old' }],
    nativeRuntime: { 'p:session:s:claude:local': { busy: false }, 'p:session:t:codex:remote': { busy: true } } };
  const live = { runs: [{ id: 'r1', status: 'running', outputSeq: 3 }, { id: 'unknown', status: 'running' }], messages: [{ id: 'm1', runId: 'r1', text: 'ab' }, { id: 'm2', runId: 'r1', text: 'tool' }], nativeRuntime: { 'p:session:u:claude:local': { busy: true } } };
  context.mergeRuntime(state, live, 'local');
  assert.deepEqual(state.runs, [{ id: 'r1', status: 'running', outputSeq: 3 }, { id: 'r2', status: 'succeeded' }]);
  assert.deepEqual(state.messages.map(m => m.text), ['ab', 'old', 'tool']);
  // Objects built inside the vm realm have another prototype; compare their JSON shape.
  const shape = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(shape(state.nativeRuntime), { 'p:session:t:codex:remote': { busy: true }, 'p:session:u:claude:local': { busy: true } });
  context.mergeRuntime(state, { runs: [], messages: [] }, 'local');
  assert.deepEqual(shape(state.nativeRuntime), { 'p:session:t:codex:remote': { busy: true } });
});
