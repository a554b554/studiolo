import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {moveLegacyProjects} from '../src/move-projects.mjs';
import {createStudio} from '../src/server.mjs';

const ID='51df52af-a379-4017-96d5-771e71218f4f';
const claudeName=directory=>directory.replace(/[^a-zA-Z0-9]/g,'-');
async function layout(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-move-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const from=path.join(root,'Studiolo','projects'),to=path.join(root,'studiolo-projects'),stateDir=path.join(root,'state'),homedir=path.join(root,'home');
 return {root,from,to,stateDir,homedir};
}

test('projects move next to the installation once, and Claude finds its conversations under the new path',async t=>{
 const {from,to,stateDir,homedir}=await layout(t);
 await fs.mkdir(path.join(from,ID,'.studio'),{recursive:true});await fs.writeFile(path.join(from,'.studio-settings.json'),'{}');await fs.mkdir(path.join(from,'.deleted'));
 // The user's own Claude config and one account's, each with a transcript folder for the project and one for a subfolder.
 const configs=[path.join(homedir,'.claude'),path.join(stateDir,'accounts','acc_1')];
 for(const config of configs)for(const suffix of ['','-site'])await fs.mkdir(path.join(config,'projects',claudeName(path.join(from,ID))+suffix),{recursive:true});
 await fs.mkdir(path.join(configs[0],'projects','X--elsewhere'),{recursive:true});
 const logs=[];const result=await moveLegacyProjects({from,to,stateDir,homedir,env:{},log:line=>logs.push(line)});
 assert.deepEqual([result.projects,result.claudeTranscripts],[1,4]);
 await assert.rejects(fs.access(from),'the old folder is gone');
 assert.deepEqual((await fs.readdir(to)).sort(),['.deleted','.studio-settings.json',ID]);
 for(const config of configs)assert.deepEqual((await fs.readdir(path.join(config,'projects'))).filter(n=>n!=='X--elsewhere').sort(),[claudeName(path.join(to,ID)),claudeName(path.join(to,ID))+'-site'].sort());
 assert.ok(await fs.access(path.join(configs[0],'projects','X--elsewhere')).then(()=>true),'other folders are untouched');
 assert.equal(JSON.parse(await fs.readFile(path.join(stateDir,'projects-moved.json'),'utf8')).to,to);
 assert.equal(await moveLegacyProjects({from,to,stateDir,homedir,env:{}}),null,'nothing to do the second time');
});

test('the move refuses to merge two project folders',async t=>{
 const {from,to,stateDir,homedir}=await layout(t);
 await fs.mkdir(path.join(from,ID),{recursive:true});await fs.mkdir(path.join(to,'f78b66d6-3f33-4d6f-8572-7f8c60ca276b'),{recursive:true});
 await assert.rejects(moveLegacyProjects({from,to,stateDir,homedir,env:{}}),/同时存在/);
 assert.ok(await fs.access(path.join(from,ID)).then(()=>true),'nothing was moved');
});

test('the server moves the old projects before it opens them, and lists them from the new folder',async t=>{
 const {from,to,stateDir,homedir}=await layout(t);const runner={profiles:async()=>[],execute:async()=>({text:''})};
 const seed=await createStudio({stateDir,projectRoot:from,port:0,previewPort:0,runner});
 const base=`http://127.0.0.1:${seed.port}`;const project=await (await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({name:'Moved'})})).json();await seed.close();
 const app=await createStudio({stateDir,projectRoot:to,moveProjectsFrom:from,homedir,env:{},port:0,previewPort:0,runner});t.after(()=>app.close());
 const listed=await (await fetch(`http://127.0.0.1:${app.port}/api/projects`)).json();
 assert.deepEqual(listed.map(p=>[p.id,p.name,p.path]),[[project.id,'Moved',path.join(await fs.realpath(to),project.id)]]);
});
