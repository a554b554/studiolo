import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {writeJson} from './paths.mjs';

// Moves the managed projects out of the installation (src/defaults.mjs): one rename of the whole folder,
// which keeps every project, .deleted tombstone, shared setting and replica record. Claude Code finds a
// conversation to resume by its working directory (a folder under <config>/projects named after the path),
// so those folders are renamed to the new path in every configuration directory on this machine: the
// user's own and each account's. Codex resumes by thread id and needs nothing. The registry in the state
// directory is rebuilt from the folder at startup, so it needs nothing either.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const claudeName=directory=>directory.replace(/[^a-zA-Z0-9]/g,'-');
const entries=directory=>fs.readdir(directory,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return null;throw e;});

async function claudeConfigDirs({stateDir,homedir,env}){
  const dirs=new Set([env.CLAUDE_CONFIG_DIR||path.join(homedir,'.claude')]);
  for(const entry of await entries(path.join(stateDir,'accounts'))||[])if(entry.isDirectory())dirs.add(path.join(stateDir,'accounts',entry.name));
  return [...dirs];
}
// "<config>/projects/D--Studiolo-projects-<id>[-subfolder]" → "D--studiolo-projects-<id>[-subfolder]".
async function renameTranscripts(configDir,from,to){
  const root=path.join(configDir,'projects'),old=claudeName(from)+'-',next=claudeName(to)+'-';let renamed=0;
  for(const entry of await entries(root)||[]){
    if(!entry.isDirectory()||!entry.name.toLowerCase().startsWith(old.toLowerCase()))continue;
    const target=next+entry.name.slice(old.length);if(target===entry.name)continue;
    // A case-only change is the same folder on Windows and macOS; rename still fixes the spelling.
    if(target.toLowerCase()!==entry.name.toLowerCase()&&await fs.lstat(path.join(root,target)).then(()=>true,()=>false))continue;
    await fs.rename(path.join(root,entry.name),path.join(root,target));renamed++;
  }
  return renamed;
}

// Runs before the store opens. Does nothing once the move is done or when there is nothing to move.
export async function moveLegacyProjects({from,to,stateDir,homedir=os.homedir(),env=process.env,log=console.log}){
  const legacy=await entries(from);if(!legacy||!legacy.length)return null;
  if(path.resolve(from).toLowerCase()===path.resolve(to).toLowerCase())return null;
  const existing=await entries(to);
  if(existing?.length)throw new Error(`项目同时存在于旧位置 ${from} 和新位置 ${to}。请合并到 ${to} 并删除旧文件夹，或用 STUDIO_PROJECT_ROOT 指定要用的文件夹。`);
  if(existing)await fs.rmdir(to);
  // mkdir of a drive root ("D:\", the parent of D:\studiolo-projects) fails with EPERM on Windows, even recursive.
  if(!await fs.stat(path.dirname(to)).catch(()=>null))await fs.mkdir(path.dirname(to),{recursive:true});
  try{await fs.rename(from,to);}
  catch(error){throw new Error(`无法把项目从 ${from} 移到 ${to}：${error.code==='EXDEV'?'不在同一个磁盘，请手动移动或设置 STUDIO_PROJECT_ROOT':error.code==='EBUSY'||error.code==='EPERM'?'有程序正在使用这个文件夹（终端、编辑器或常驻 Artifact），关闭后重新启动':error.message}`);}
  const result={from,to,movedAt:new Date().toISOString(),projects:legacy.filter(e=>e.isDirectory()&&UUID.test(e.name)).length,claudeTranscripts:0};
  for(const dir of await claudeConfigDirs({stateDir,homedir,env})){
    try{result.claudeTranscripts+=await renameTranscripts(dir,from,to);}catch(error){log(`Claude 会话目录改名失败（${dir}）：${error.message}`);}
  }
  await writeJson(path.join(stateDir,'projects-moved.json'),result);
  log(`项目已从 ${from} 移到 ${to}（${result.projects} 个项目，${result.claudeTranscripts} 个 Claude 会话目录改名）`);
  return result;
}
