import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';

// Reads apply only the journal events that are new since the last replay when they sort after it;
// anything else replays in full. Every case is checked against a
// fresh store's full replay of the same files.
async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-replay-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const projectRoot = path.join(dir, 'projects');
  const store = await new Store({stateDir: path.join(dir, 'a'), projectRoot, hostId: 'a', deriveDelay: 1e9, stateDelay: 1e9, ...options}).init();
  const project = await store.createProject({name: 'replay'});
  const root = path.join(project.path, '.studio');
  const spy = {full: 0, incremental: 0};
  const replay = store._replay.bind(store), applyNew = store._applyNew.bind(store);
  store._replay = async (...a) => { spy.full++; return replay(...a); };
  store._applyNew = async (...a) => { spy.incremental++; return applyNew(...a); };
  const fresh = async () => JSON.stringify((await (await new Store({stateDir: path.join(dir, 'fresh-' + randomUUID()), projectRoot, hostId: 'fresh', deriveDelay: 1e9}).init())._load(root)).state);
  const current = async () => JSON.stringify((await store._load(root)).state);
  return {dir, store, project, root, spy, fresh, current};
}
const message = (sessionId, text) => s => { s.messages.push({id: randomUUID(), sessionId, role: 'user', text, createdAt: new Date().toISOString()}); };

test('commits and reads apply one event at a time and match a full replay', async t => {
  const {store, project, spy, fresh, current} = await setup(t);
  const sid = randomUUID();
  await store.mutate(project.id, 'session', s => { s.sessions.push({id: sid, title: 'one'}); });
  await store.read(project.id);
  spy.full = spy.incremental = 0;
  for (let i = 0; i < 20; i++) {
    await store.mutate(project.id, 'message', message(sid, `m${i}`));
    if (i % 3 === 0) await store.mutate(project.id, 'edit', s => { s.messages.find(m => m.text === `m${i}`).text += ' (edited)'; });
    if (i === 7) await store.mutate(project.id, 'remove', s => { s.messages = s.messages.filter(m => m.text !== 'm1'); });
    await store.read(project.id);
  }
  assert.equal(spy.full, 0, 'no full replay after the first');
  assert.ok(spy.incremental >= 20);
  assert.equal(await current(), await fresh());
  assert.ok(!(await store.read(project.id)).messages.some(m => m.text === 'm1'));
});

test('an event from another host that sorts before the last applied one replays in full, with the same result', async t => {
  const {store: a, project, root, spy, fresh, current} = await setup(t);
  const sid = randomUUID();
  await a.mutate(project.id, 'session', s => { s.sessions.push({id: sid, title: 'shared'}); });
  // Host b works on its own copy of the journal: a concurrent branch from the same tip.
  const dirB = path.join(path.dirname(path.dirname(project.path)), 'b-projects');
  await fs.cp(path.dirname(root), path.join(dirB, project.id), {recursive: true});
  const b = await new Store({stateDir: path.join(dirB, '..', 'b-state'), projectRoot: dirB, hostId: 'b', deriveDelay: 1e9}).init();
  for (let i = 0; i < 3; i++) await a.mutate(project.id, 'a', message(sid, `from a ${i}`));
  await b.mutate(project.id, 'b', message(sid, 'from b'));
  await a.read(project.id);
  spy.full = spy.incremental = 0;
  const {events} = await b.journal(project.id, await a.journalNames(project.id));
  await a.importJournal(project.id, events);
  const merged = await a.read(project.id);
  assert.equal(spy.full, 1, 'the earlier event forces a full replay');
  assert.deepEqual(merged.messages.map(m => m.text).sort(), ['from a 0', 'from a 1', 'from a 2', 'from b']);
  assert.equal(await current(), await fresh());
  await a.mutate(project.id, 'after merge', message(sid, 'after'));
  assert.equal(await current(), await fresh(), 'a commit after the merge (two tips as parents) is applied incrementally too');
});

test('concurrent reads never apply the same new events twice', async t => {
  const {store, project, root, fresh, spy} = await setup(t);
  const sid = randomUUID();
  await store.mutate(project.id, 'session', s => { s.sessions.push({id: sid, title: 'one'}); });
  await store.read(project.id);
  // Events written behind the store's back (as a sync would), then read by overlapping loads.
  const writer = await new Store({stateDir: path.join(path.dirname(path.dirname(project.path)), 'w'), projectRoot: path.dirname(project.path), hostId: 'a', deriveDelay: 1e9}).init();
  for (let i = 0; i < 5; i++) await writer.mutate(project.id, 'message', message(sid, `w${i}`));
  spy.full = 0;
  const states = await Promise.all([store._load(root), store._load(root, true), store.read(project.id), store._load(root)]);
  for (const result of states) assert.equal((result.state || result).messages.length, 5);
  assert.equal(spy.full, 0, 'the overlapping load waits and finds nothing new, instead of failing over to a full replay');
  assert.equal(JSON.stringify((await store._load(root)).state), await fresh());
});

test('every file is rechecked after verifyInterval, so a replaced event file is noticed', async t => {
  const {store, project, root, spy} = await setup(t, {verifyInterval: 50});
  const sid = randomUUID();
  await store.mutate(project.id, 'session', s => { s.sessions.push({id: sid, title: 'one'}); });
  await store.mutate(project.id, 'message', message(sid, 'original'));
  await store.read(project.id);
  const events = path.join(root, 'events'), last = (await fs.readdir(events)).sort().at(-1);
  const event = JSON.parse(await fs.readFile(path.join(events, last), 'utf8'));
  event.changes = event.changes.map(op => op.path[0] === 'messages' ? {...op, value: {...op.value, text: 'replaced'}} : op);
  await fs.writeFile(path.join(events, last), JSON.stringify(event));
  spy.full = 0;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await store.read(project.id)).messages[0].text, 'replaced');
  assert.equal(spy.full, 1);
});
