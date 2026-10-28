import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.test-studio-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, 'local');
  const store = await new Store({ stateDir, hostId: 'host-a' }).init();
  const project = await store.createProject({ name: 'Example', path: path.join(dir, 'project'), group: 'Personal' });
  return { dir, stateDir, store, project, root: path.join(project.path, '.studio') };
}

test('reads after commit never join a stale in-flight snapshot',async t=>{
 const {store,root}=await fixture(t),previous=await store._load(root);
 const original=store._loadEvents.bind(store);let release,started;
 const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);let first=true;
 store._loadEvents=async(...args)=>{const delay=first;first=false;const event=await original(...args);if(delay){started();await gate;}return event;};
 const stale=store._load(root);await ready;
 const state=structuredClone(previous.state);state.project.name='Committed';
 await store._commit(root,state,'test.commit',previous);
 const fresh=store._load(root);release();
 assert.equal((await stale).state.project.name,'Example');
 assert.equal((await fresh).state.project.name,'Committed');
});

test('verified history cache sees appended events, tampering, removal and synchronization conflicts',async t=>{
 const {store,project,root}=await fixture(t);
 await store.read(project.id);
 const first=store.eventCache.get(root).event;
 await store.read(project.id);assert.equal(store.eventCache.get(root).event,first);
 await store.mutate(project.id,'rename',s=>{s.project.name='Updated';});
 assert.equal((await store.read(project.id)).project.name,'Updated');
 const files=(await fs.readdir(path.join(root,'events'))).sort();
 const file=path.join(root,'events',files[0]);const original=await fs.readFile(file,'utf8');
 const changed=JSON.parse(original);changed.previousId='invalid';await fs.writeFile(file,JSON.stringify(changed));
 await assert.rejects(store.read(project.id),/Divergent or incomplete|history is missing/);
 await fs.writeFile(file,original);await store.read(project.id);
 const conflict=path.join(root,'events','history.sync-conflict.json');await fs.writeFile(conflict,'{}');await assert.rejects(store.read(project.id),/synchronization conflict/);await fs.unlink(conflict);
 await fs.unlink(file);await assert.rejects(store.read(project.id),/Divergent or incomplete|history is missing/);
});

test('concurrent history readers share validation but receive isolated state copies',async t=>{
 const {store,project}=await fixture(t);let loads=0;
 const load=store._loadEvents.bind(store);store._loadEvents=async(...args)=>{loads++;return load(...args);};
 const rows=await Promise.all(Array.from({length:8},()=>store.read(project.id)));
 assert.equal(loads,1);rows[0].project.name='changed locally';assert.equal(rows[1].project.name,'Example');assert.equal((await store.read(project.id)).project.name,'Example');
});

test('commits survive restart; derived files rebuild and paths remain machine-local', async t => {
  const { store, project, stateDir, root } = await fixture(t);
  const id = randomUUID();
  await store.mutate(project.id, 'session.created', s => {
    s.sessions.push({ id, title: 'A conversation', createdAt: new Date().toISOString() });
    s.messages.push({ id: randomUUID(), sessionId: id, role: 'user', text: 'Hello', createdAt: new Date().toISOString() });
  });
  const snapshot = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
  assert.equal(snapshot.project.path, undefined);
  const names = await fs.readdir(path.join(root, 'events'));
  assert.equal(names.length, 2);
  for (const filename of names) assert.equal(JSON.parse(await fs.readFile(path.join(root, 'events', filename), 'utf8')).state?.project.path, undefined);
  await fs.writeFile(path.join(root, 'state.json'), '{broken');
  await fs.rm(path.join(root, 'history-index.md'));
  const reopened = await new Store({ stateDir, hostId: 'host-a' }).init();
  assert.equal((await reopened.read(project.id)).messages[0].text, 'Hello');
  assert.match(await fs.readFile(path.join(root, 'history-index.md'), 'utf8'), /A conversation/);
  assert.match(await fs.readFile(path.join(root, 'sessions', `${id}.md`), 'utf8'), /Hello/);
});

test('derived views are rewritten only when their content changes, and restored if altered on disk', async t => {
  const { store, project, root } = await fixture(t);
  const id = randomUUID(), other = randomUUID();
  await store.mutate(project.id, 'sessions', s => { for (const sid of [id, other]) s.sessions.push({ id: sid, title: sid, createdAt: new Date().toISOString() }); });
  const untouched = path.join(root, 'sessions', `${other}.md`), changed = path.join(root, 'sessions', `${id}.md`);
  const before = (await fs.stat(untouched)).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 20));
  await store.mutate(project.id, 'message', s => { s.messages.push({ id: randomUUID(), sessionId: id, role: 'user', text: 'Only here', createdAt: new Date().toISOString() }); });
  assert.equal((await fs.stat(untouched)).mtimeMs, before, 'an unrelated session view is not rewritten');
  assert.match(await fs.readFile(changed, 'utf8'), /Only here/);
  await fs.rm(changed); await fs.writeFile(untouched, 'edited outside the platform');
  await store.mutate(project.id, 'touch', s => { s.project.group = 'changed'; });
  assert.match(await fs.readFile(changed, 'utf8'), /Only here/);
  assert.doesNotMatch(await fs.readFile(untouched, 'utf8'), /edited outside/);
});

test('readable session history separates operation logs without losing either', async t => {
  const {store,project,root}=await fixture(t),id=randomUUID();
  await store.mutate(project.id,'session.created',s=>{
    s.sessions.push({id,title:'test'});
    s.messages.push({id:randomUUID(),sessionId:id,role:'system',text:'TOOL_LOG'});
    s.messages.push({id:randomUUID(),sessionId:id,role:'assistant',text:'FINAL_REPLY',progressText:'INTERIM_PROGRESS'});
  });
  const chat=await fs.readFile(path.join(root,'sessions',id+'.md'),'utf8');
  const logs=await fs.readFile(path.join(root,'sessions',id+'.operations.md'),'utf8');
  assert.match(chat,/FINAL_REPLY/);assert.doesNotMatch(chat,/TOOL_LOG|INTERIM_PROGRESS/);
  assert.match(logs,/TOOL_LOG/);assert.match(logs,/INTERIM_PROGRESS/);
  assert.equal((await store.read(project.id)).messages.length,2);
});

test('parallel mutations serialize, failed callbacks roll back, reads are detached', async t => {
  const { store, project, root } = await fixture(t);
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.mutate(project.id, 'session.created', s => s.sessions.push({ id: randomUUID(), title: `Session ${i}`, createdAt: new Date().toISOString() }))));
  await assert.rejects(store.mutate(project.id, 'bad', s => { s.sessions.length = 0; throw new Error('abort'); }), /abort/);
  const state = await store.read(project.id);
  assert.equal(state.sessions.length, 10);
  state.sessions.length = 0;
  assert.equal((await store.read(project.id)).sessions.length, 10);
  assert.equal((await fs.readdir(path.join(root, 'events'))).length, 11);
});

test('incomplete unpublished files are ignored; conflicting committed history is rejected', async t => {
  const { store, project, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'events', 'partial.tmp'), '{');
  assert.equal((await store.read(project.id)).project.id, project.id);
  const name = (await fs.readdir(path.join(root, 'events'))).find(n => n.endsWith('.json'));
  await fs.copyFile(path.join(root, 'events', name), path.join(root, 'events', `000000000001-${randomUUID()}.json`));
  await assert.rejects(store.read(project.id), /Divergent/);
  await assert.rejects(store.mutate(project.id, 'change', s => s.project.name = 'Bad'), /Divergent/);
});

test('registering synced project retains ID and remaps local path without taking ownership', async t => {
  const { dir, store, project } = await fixture(t);
  assert.equal((await store.createProject({ name: 'Again', path: project.path })).id, project.id);
  const copy = path.join(dir, 'second-project');
  await fs.cp(project.path, copy, { recursive: true });
  const second = await new Store({ stateDir: path.join(dir, 'local-b'), hostId: 'host-b' }).init();
  const imported = await second.createProject({ name: 'Ignored', path: copy });
  assert.equal(imported.id, project.id);
  assert.equal(imported.ownerHostId, 'host-a');
  assert.equal(imported.path, realpathSync(copy));
  assert.equal((await second.listProjects()).length, 1);
});

test('partial synchronization cannot replace an existing project identity when authority is missing', async t => {
  const { dir, project, root } = await fixture(t);
  const original = await fs.readFile(path.join(root, 'state.json'), 'utf8');
  await fs.rename(path.join(root, 'events'), path.join(dir, 'events-backup'));
  const second = await new Store({ stateDir: path.join(dir, 'other-local'), hostId: 'b' }).init();
  await assert.rejects(second.createProject({ name: 'Would overwrite', path: project.path }), /not yet synchronized/);
  assert.equal(await fs.readFile(path.join(root, 'state.json'), 'utf8'), original);
  assert.equal((await second.listProjects()).length, 0);
  await fs.mkdir(path.join(root, 'events'));
  await assert.rejects(second.createProject({ name: 'Still missing', path: project.path }), /event history is missing/);
  assert.equal(await fs.readFile(path.join(root, 'state.json'), 'utf8'), original);
});

test('history record IDs cannot be interpreted as filesystem paths', async t => {
  const { store, project } = await fixture(t);
  await assert.rejects(store.mutate(project.id, 'bad-record', s => s.sessions.push({ id: '../../outside', title: 'unsafe' })), /Invalid history record ID/);
  assert.equal((await store.read(project.id)).sessions.length, 0);
});

test('metadata directory junctions/symlinks are rejected before reading or writing', async t => {
  const { dir, store, project, root } = await fixture(t);
  const preserved = path.join(dir, 'preserved-metadata');
  await fs.rename(root, preserved);
  try { await fs.symlink(preserved, root, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('Environment cannot create symlinks/junctions'); return; } throw e; }
  await assert.rejects(store.read(project.id), /symbolic links or junctions/);
  await assert.rejects(store.mutate(project.id, 'unsafe', s => s.project.name = 'changed'), /symbolic links or junctions/);
  await fs.unlink(root);
  await fs.rename(preserved, root);
  const preservedEvents = path.join(dir, 'preserved-events');
  await fs.rename(path.join(root, 'events'), preservedEvents);
  await fs.symlink(preservedEvents, path.join(root, 'events'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.read(project.id), /symbolic links or junctions/);
});

test('derived-view failures surface in read-only API state and clear after successful rebuild', async t => {
  const { store, project } = await fixture(t);
  const original = store._derive;
  store._derive = async () => { throw new Error('Markdown write unavailable'); };
  await store.mutate(project.id, 'renamed', s => s.project.name = 'Persisted');
  const state = await store.read(project.id);
  assert.equal(state.project.name, 'Persisted');
  assert.equal(state.storageWarning, 'Markdown write unavailable');
  const eventDir = path.join(project.path, '.studio', 'events');
  const last = (await fs.readdir(eventDir)).sort().at(-1);
  assert.equal(JSON.parse(await fs.readFile(path.join(eventDir, last), 'utf8')).state?.storageWarning, undefined);
  store._derive = original;
  await store.mutate(project.id, 'rebuild', () => {});
  assert.equal((await store.read(project.id)).storageWarning, undefined);
});

test('metadata guard rejects both directory layers before a read or commit', async t => {
  const { store, project, root } = await fixture(t);
  const original = fs.lstat;
  let forbidden = root;
  t.mock.method(fs, 'lstat', async filename => filename === forbidden ? { isSymbolicLink: () => true } : original(filename));
  await assert.rejects(store.read(project.id), /symbolic links or junctions/);
  forbidden = path.join(root, 'events');
  await assert.rejects(store.mutate(project.id, 'forbidden', s => s.project.name = 'bad'), /symbolic links or junctions/);
});

test('the project list names conversations with a run executing now', async t => {
  const { store, project } = await fixture(t);
  assert.equal((await store.listProjects())[0].running, undefined);
  await store.mutate(project.id, 'test.runs', s => {
    s.runs.push({ id: 'r1', sessionId: 'a', status: 'running' }, { id: 'r2', sessionId: 'a', status: 'running' }, { id: 'r3', sessionId: 'b', status: 'queued' }, { id: 'r4', sessionId: 'c', status: 'succeeded' }, { id: 'r5', artifactId: 'x', status: 'running' });
  });
  const [listed] = await store.listProjects();
  assert.deepEqual(listed.running, ['a']);
  assert.equal(listed.path, project.path);
  assert.equal((await store.getProject(project.id)).running, undefined, 'only the list carries it');
});
