import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {createStudio} from '../src/server.mjs';

// Readable views (state.json, history Markdown) are written after commits, not in them, and only for
// the conversations and Artifacts that changed. Agents still read current
// history: a run flushes its project first, and closing the server flushes everything.
const read = file => fs.readFile(file, 'utf8');

test('a run starts with the shared history written out, and close() writes what is still pending', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-derive-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const projectRoot = path.join(dir, 'projects');
  let seen = null;
  const runner = {profiles: async () => [{id: 'fake', label: 'test', available: true, models: [{id: 'test', label: 'Test'}]}],
    execute: async ({cwd}) => { const sessions = path.join(cwd, '.studio', 'sessions'); seen = await Promise.all((await fs.readdir(sessions)).filter(n => !n.includes('operations')).map(n => read(path.join(sessions, n)))); return {text: 'reply', nativeSessionId: 'n'}; }};
  const app = await createStudio({stateDir: path.join(dir, 'state'), projectRoot, port: 0, previewPort: 0, runner, homedir: path.join(dir, 'home'), env: {}});
  let closed = false; t.after(() => closed || app.close());
  app.store.deriveDelay = app.store.stateDelay = 60000;
  const api = async (p, method = 'GET', data) => { const res = await fetch(`http://127.0.0.1:${app.port}${p}`, {method, headers: data ? {'Content-Type': 'application/json'} : {}, body: data ? JSON.stringify(data) : undefined}); const body = await res.json(); if (!res.ok) throw new Error(body.error); return body; };
  const project = await api('/api/projects', 'POST', {name: 'derive'}), root = `/api/projects/${project.id}`;
  const session = await api(`${root}/sessions`, 'POST', {title: 'History'});
  await api(`${root}/messages`, 'POST', {requestId: 'r1', sessionId: session.id, text: 'remember the blue door', profileId: 'fake', model: 'test'});
  for (let i = 0; i < 100 && !seen; i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(seen.some(text => text.includes('remember the blue door')), 'the agent reads the message that started its run');
  const view = path.join(project.path, '.studio', 'sessions', `${session.id}.md`);
  for (let i = 0; i < 100 && (await app.store.read(project.id)).runs.some(r => r.status !== 'succeeded'); i++) await new Promise(r => setTimeout(r, 50));
  assert.doesNotMatch(await read(view), /reply/, 'the reply waits for the delay');
  await app.close(); closed = true;
  assert.match(await read(view), /reply/, 'close() writes it');
  assert.ok(JSON.parse(await read(path.join(project.path, '.studio', 'state.json'))).messages.some(m => m.text === 'reply'));
});

test('an imported journal rewrites the views of the conversations it touched, and only those', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-derive-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const a = await new Store({stateDir: path.join(dir, 'a'), projectRoot: path.join(dir, 'pa'), hostId: 'a'}).init();
  const b = await new Store({stateDir: path.join(dir, 'b'), projectRoot: path.join(dir, 'pb'), hostId: 'b'}).init();
  const project = await a.createProject({name: 'shared'});
  const x = randomUUID(), y = randomUUID(), artifact = randomUUID(), annotation = randomUUID();
  await a.mutate(project.id, 'setup', s => {
    s.sessions.push({id: x, title: 'X'}, {id: y, title: 'Y'});
    s.artifacts.push({id: artifact, name: 'Page', root: 'web'});
    s.annotations.push({id: annotation, artifactId: artifact, text: 'make it red', status: 'open', anchorStatus: 'attached', anchor: {}});
  });
  const sync = async () => { const {events} = await a.journal(project.id, await b.journalNames(project.id).catch(() => [])); await b.importJournal(project.id, events); await b.flushDerived(project.id); };
  await fs.mkdir(path.join(dir, 'pb', project.id, '.studio', 'events'), {recursive: true});
  await b.discoverProjects();
  await sync();
  const viewX = path.join(dir, 'pb', project.id, '.studio', 'sessions', `${x}.md`), viewY = viewX.replace(x, y);
  const viewArtifact = path.join(dir, 'pb', project.id, '.studio', 'artifacts', `${artifact}.md`);
  await fs.writeFile(viewY, 'edited by hand');
  await a.mutate(project.id, 'message', s => { s.messages.push({id: randomUUID(), sessionId: x, role: 'user', text: 'from host a', createdAt: new Date().toISOString()}); });
  await sync();
  assert.match(await read(viewX), /from host a/);
  assert.equal(await read(viewY), 'edited by hand', 'an untouched conversation is not rebuilt');
  await a.mutate(project.id, 'comment reply', s => { s.messages.push({id: randomUUID(), annotationId: annotation, role: 'assistant', text: 'made it red', createdAt: new Date().toISOString()}); });
  await sync();
  assert.match(await read(viewArtifact), /made it red/, 'a comment reply without artifactId still reaches its Artifact view');
});
