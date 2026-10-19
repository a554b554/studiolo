import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {inside,writeJson} from './paths.mjs';

// Hard deletion of projects. The deleting server writes a tombstone to the synced
// projects/.deleted folder and removes the project folder; Syncthing carries both to the
// other machines. Every server then removes what only it holds for that project: resident
// agent processes, Artifact previews, and the native Claude/Codex transcripts of runs whose
// working directory was the project folder. The tombstone also stops a folder that Syncthing
// recreates from a late peer write from coming back as a project.

const claudeName=directory=>directory.replace(/[^a-zA-Z0-9]/g,'-');
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const within=(root,target)=>process.platform==='win32'?inside(root.toLowerCase(),target.toLowerCase()):inside(root,target);
const exists=file=>fs.lstat(file).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const remove=target=>fs.rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});

// Claude Code keeps one transcript folder per working directory, named by replacing every
// non-alphanumeric character with "-"; subdirectories of the project add a "-…" suffix.
async function purgeClaude(configDir,projectPath){
  const root=path.join(configDir,'projects'),name=claudeName(projectPath);let removed=0;
  let entries;try{entries=await fs.readdir(root,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return 0;throw e;}
  for(const entry of entries)if(entry.isDirectory()&&(samePath(entry.name,name)||entry.name.toLowerCase().startsWith(name.toLowerCase()+'-'))){await remove(path.join(root,entry.name));removed++;}
  return removed;
}

// Codex rollouts are grouped by date; the first line (session_meta) records the working directory.
async function rolloutCwd(file){
  const handle=await fs.open(file,'r');
  try{const {buffer,bytesRead}=await handle.read(Buffer.alloc(32768),0,32768,0);const head=buffer.subarray(0,bytesRead).toString('utf8').split('\n')[0];const match=/"cwd":("(?:[^"\\]|\\.)*")/.exec(head);return match?JSON.parse(match[1]):null;}
  finally{await handle.close();}
}
async function purgeCodex(codexHome,projectPath){
  let removed=0;
  const walk=async directory=>{
    let entries;try{entries=await fs.readdir(directory,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
    for(const entry of entries){
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())await walk(file);
      else if(entry.isFile()&&/^rollout-.*\.jsonl$/.test(entry.name)){const cwd=await rolloutCwd(file).catch(()=>null);if(cwd&&within(projectPath,cwd)){await fs.rm(file,{force:true});removed++;}}
    }
  };
  for(const name of ['sessions','archived_sessions'])await walk(path.join(codexHome,name));
  return removed;
}

export class ProjectPurger {
  constructor({store,runner,artifacts,stateDir,homedir=os.homedir(),env=process.env}){
    Object.assign(this,{store,runner,artifacts,stateDir,homedir,env});
    this.file=path.join(stateDir,'purged-projects.json');this.purged=null;this.running=null;
  }
  async loadPurged(){
    if(this.purged)return this.purged;
    try{this.purged=new Set(JSON.parse(await fs.readFile(this.file,'utf8')).ids||[]);}catch(e){if(e.code!=='ENOENT')throw e;this.purged=new Set();}
    return this.purged;
  }
  // Every configuration directory this machine's agents write transcripts to.
  async nativeDirectories(){
    const claude=new Set([this.env.CLAUDE_CONFIG_DIR||path.join(this.homedir,'.claude')]),codex=new Set([this.env.CODEX_HOME||path.join(this.homedir,'.codex')]);
    for(const config of Object.values(await this.runner.configuration?.().catch(()=>({}))||{})){
      if(config?.env?.CLAUDE_CONFIG_DIR)claude.add(config.env.CLAUDE_CONFIG_DIR);
      if(config?.env?.CODEX_HOME)codex.add(config.env.CODEX_HOME);
    }
    // Accounts that are no longer configured may still hold transcripts.
    for(const entry of await fs.readdir(path.join(this.stateDir,'accounts'),{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory()){const dir=path.join(this.stateDir,'accounts',entry.name);claude.add(dir);codex.add(dir);}
    return {claude:[...claude],codex:[...codex]};
  }
  // Everything this machine holds for a project. Safe to repeat.
  async purgeLocal(pid){
    await this.runner.release?.(`${pid}:`);
    await this.artifacts.forget?.(pid);
    const projectPath=this.store.projectPath(pid),result={folder:false,claude:0,codex:0};
    // Also when Syncthing already removed the folder: drops the registry entry and tells open pages.
    result.folder=await exists(projectPath);await this.store.removeFolder(pid);
    const dirs=await this.nativeDirectories();
    for(const dir of dirs.claude)result.claude+=await purgeClaude(dir,projectPath);
    for(const dir of dirs.codex)result.codex+=await purgeCodex(dir,projectPath);
    const purged=await this.loadPurged();purged.add(pid);await writeJson(this.file,{ids:[...purged].sort()});
    return result;
  }
  // Deletion requested on this server; `check` runs under the project's write lock.
  async remove(pid,check){await this.store.removeProject(pid,check);return this.purgeLocal(pid);}
  // Tombstones written by other servers, folders recreated by late synchronization, and
  // projects soft-deleted before hard deletion existed.
  reconcile({legacy=false}={}){
    if(this.running)return this.running;
    this.running=(async()=>{
      const purged=await this.loadPurged(),results={};
      for(const pid of await this.store.deletedIds())if(!purged.has(pid)||await exists(this.store.projectPath(pid)))results[pid]=await this.purgeLocal(pid);
      if(legacy)for(const project of await this.store.listProjects())if(project.deletedAt&&!project.unavailable)results[project.id]=await this.remove(project.id);
      return results;
    })();
    return this.running.finally(()=>{this.running=null;});
  }
}
