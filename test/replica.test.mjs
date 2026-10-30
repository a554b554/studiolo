import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseIgnore,ignored,loadRules,rsyncFilter,scan,contentDigest,manifest,difference,ReplicaFiles,ALWAYS_EXCLUDED} from '../src/replica.mjs';
import {rsyncPath,parseProgress,RsyncTransport,FakeTransport} from '../src/transport.mjs';

const tmp=async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-replica-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;};
const put=async(root,rel,text='x')=>{await fs.mkdir(path.dirname(path.join(root,rel)),{recursive:true});await fs.writeFile(path.join(root,rel),text);};

test('.studioignore follows the gitignore subset: anchors, directories, globs, negation',()=>{
 const rules=parseIgnore(`# comment
node_modules/
/dist/
*.ckpt
!keep.ckpt
docs/**/draft-?.md
\\#literal
`);
 assert.equal(ignored('node_modules',true,rules),true);assert.equal(ignored('web/node_modules',true,rules),true);
 assert.equal(ignored('node_modules',false,rules),false,'dir-only rule skips files');
 assert.equal(ignored('dist',true,rules),true);assert.equal(ignored('web/dist',true,rules),false,'leading / anchors to the root');
 assert.equal(ignored('a/b/model.ckpt',false,rules),true);assert.equal(ignored('keep.ckpt',false,rules),false,'last match wins');
 assert.equal(ignored('docs/draft-1.md',false,rules),true);assert.equal(ignored('docs/x/y/draft-2.md',false,rules),true);assert.equal(ignored('docs/draft-12.md',false,rules),false);
 assert.equal(ignored('#literal',false,rules),true);
 assert.equal(ignored('model.ckptx',false,rules),false);
});

test('rsync filter rules reverse the order so the first rsync match equals the last git match',()=>{
 const text=rsyncFilter(parseIgnore('*.ckpt\n!keep.ckpt\n/dist/'));
 assert.deepEqual(text.trim().split('\n'),['- /dist/','+ keep.ckpt','- *.ckpt']);
 assert.match(rsyncFilter(parseIgnore(ALWAYS_EXCLUDED.join('\n'))),/^- \/\.studio\/events\/$/m);
});

test('scan lists files with / separators and NFC names, skips excluded paths and reuses hashes',async t=>{
 const root=await tmp(t);
 await put(root,'web/index.html','<h1>');await put(root,'node_modules/x/index.js');await put(root,'.studioignore','node_modules/\n');
 await put(root,'.studio/events/000000000001-a.json','{}');await put(root,'.studio/attachments/a.png','png');await put(root,'cafe\u0301.txt','nfd');await put(root,'a.tmp');
 const first=await scan(root,{rules:await loadRules(root)});
 assert.deepEqual(first.entries.map(e=>e[0]),['.studio/attachments/a.png','.studioignore','café.txt','web/index.html']);
 assert.equal(first.entries[2][0],'caf\u00e9.txt','names are NFC');
 const index=Object.fromEntries(Object.entries(first.index).map(([k,v])=>[k,[v[0],v[1],'cached-'+k,v[3]]]));
 const again=await scan(root,{rules:await loadRules(root),index});
 assert.equal(again.entries.find(e=>e[0]==='web/index.html')[3],'cached-web/index.html','unchanged size and mtime reuse the stored hash');
 assert.equal(contentDigest(first.entries),contentDigest(first.entries.map(e=>[e[0],e[1],e[2]+1000,e[3]])),'mtimes do not change content identity');
 const m=manifest({entries:first.entries,hostId:'h'});assert.equal(m.files,4);assert.equal(m.digest,contentDigest(first.entries));
 assert.deepEqual(difference(first.entries,[...first.entries.slice(1),['new',1,0,'z']]),['.studio/attachments/a.png','new']);
});

test('ReplicaFiles keeps a hash index per project and only the wanted versions',async t=>{
 const root=await tmp(t),files=new ReplicaFiles({stateDir:path.join(root,'state')}),project=path.join(root,'p');
 await put(project,'a.txt','a');
 const {entries}=await files.scan('p1',project);assert.equal(entries.length,1);
 assert.ok((await files.readIndex('p1'))['a.txt']);
 const v1=manifest({entries,hostId:'h',id:'00000000-0000-4000-8000-000000000001'}),v2=manifest({entries,hostId:'h',id:'00000000-0000-4000-8000-000000000002'});
 await files.writeVersion(project,v1);await files.writeVersion(project,v2,[v1.id]);
 assert.equal((await files.readVersion(project,v1.id)).id,v1.id);
 await files.writeVersion(project,v2);assert.equal(await files.readVersion(project,v1.id),null);
 assert.throws(()=>files.versionFile(project,'../x'),/Invalid version/);
});

test('rsync arguments use MSYS paths on Windows and SSH only for a remote end',()=>{
 assert.equal(rsyncPath('D:\\Studiolo\\projects\\x','win32'),'/d/Studiolo/projects/x');
 assert.equal(rsyncPath('/Users/me/x','darwin'),'/Users/me/x');
 assert.deepEqual(parseProgress('    1,234,567  45%    1.20MB/s    0:00:10 (xfr#3, to-chk=1/9)'),{bytes:1234567,percent:45,rate:'1.20MB/s'});
 assert.equal(parseProgress('sending incremental file list'),null);
 const t=new RsyncTransport({rsync:'rsync.exe',sshKey:'C:\\Users\\me\\.ssh\\key',platform:'win32'});
 const args=t.args({source:'D:\\p\\x',target:{user:'me',host:'mini',path:'/Users/me/p/x',rsync:'/opt/homebrew/bin/rsync'},filterFile:'C:\\Temp\\f.txt'});
 assert.deepEqual(args.slice(-2),['/d/p/x/','me@mini:/Users/me/p/x/']);
 assert.ok(args.includes('--filter=merge /c/Temp/f.txt'));assert.ok(args.includes('--rsync-path=/opt/homebrew/bin/rsync'));
 assert.equal(args[args.indexOf('-e')+1],'ssh -i /c/Users/me/.ssh/key -o IdentitiesOnly=yes -o BatchMode=yes');
 assert.ok(!new RsyncTransport({rsync:'rsync',platform:'darwin'}).args({source:'/a',target:'/b',filterFile:'/f'}).includes('-e'),'local copies need no ssh');
});

test('FakeTransport mirrors the tree, leaves excluded paths alone and deletes what the source lost',async t=>{
 const root=await tmp(t),source=path.join(root,'s'),target=path.join(root,'t');
 await put(source,'a/b.txt','one');await put(source,'node_modules/m.js','src');await put(source,'.studio/events/e.json','{}');
 await put(target,'gone.txt');await put(target,'node_modules/own.js','target');await put(target,'.studio/events/mine.json','{}');
 const rules=parseIgnore(ALWAYS_EXCLUDED.join('\n')+'\nnode_modules/');
 await new FakeTransport().copy({source,target,rules});
 assert.equal(await fs.readFile(path.join(target,'a/b.txt'),'utf8'),'one');
 await assert.rejects(fs.stat(path.join(target,'gone.txt')));
 assert.equal(await fs.readFile(path.join(target,'node_modules/own.js'),'utf8'),'target');await assert.rejects(fs.stat(path.join(target,'node_modules/m.js')));
 assert.deepEqual(await fs.readdir(path.join(target,'.studio/events')),['mine.json']);
 const [s,d]=await Promise.all([fs.stat(path.join(source,'a/b.txt')),fs.stat(path.join(target,'a/b.txt'))]);assert.ok(Math.abs(s.mtimeMs-d.mtimeMs)<2,"mtimes are kept");
});
