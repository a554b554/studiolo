import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {safePath,httpError} from './paths.mjs';

// Every upload lands in the project's uploads/ folder, whether it came from the chat
// composer or the resource pane. Browsers send the original name; only its last path
// segment survives, with characters Windows, macOS and Syncthing cannot store removed.
export const UPLOAD_DIR='uploads';
const reserved=/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
export function safeUploadName(input){
  const raw=String(input??'').replace(/[\\/]+/g,'/');
  let name=raw.split('/').filter(Boolean).at(-1)||'';
  name=name.replace(/[\x00-\x1f\x7f<>:"|?*]/g,'').replace(/[. ]+$/,'').replace(/^[. ]+/,'').trim();
  if(!name||name==='.'||name==='..')name='file';
  if(reserved.test(name))name='_'+name;
  if(name.length>150){const ext=path.extname(name).slice(0,20);name=name.slice(0,150-ext.length)+ext;}
  return name;
}
// Reserve a free name with an exclusive create so two concurrent uploads of the same
// file name never overwrite each other; the finished temp file is then renamed over it.
async function reserveName(dir,name){
  const ext=path.extname(name),stem=name.slice(0,name.length-ext.length);
  for(let i=1;i<1000;i++){
    const candidate=i===1?name:`${stem} (${i})${ext}`;
    try{const handle=await fs.open(path.join(dir,candidate),'wx');await handle.close();return candidate;}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  throw httpError('同名文件过多',409);
}
export async function saveUpload(projectPath,requestedName,req,{limit=100*1024*1024}={}){
  const name=safeUploadName(requestedName);
  const declared=Number(req.headers['content-length']);
  if(Number.isFinite(declared)&&declared>limit)throw httpError(`文件超过 ${Math.round(limit/1024/1024)} MB 上传限制`,413);
  const dir=await safePath(projectPath,UPLOAD_DIR,{missing:true});
  await fs.mkdir(dir,{recursive:true});
  const temp=path.join(dir,`.upload-${randomUUID()}.tmp`);
  const handle=await fs.open(temp,'wx',0o644);
  let size=0;
  try{
    for await(const chunk of req){size+=chunk.length;if(size>limit)throw httpError(`文件超过 ${Math.round(limit/1024/1024)} MB 上传限制`,413);await handle.write(chunk);}
  }catch(error){await handle.close();await fs.rm(temp,{force:true});throw error;}
  await handle.close();
  const finalName=await reserveName(dir,name);
  await fs.rename(temp,path.join(dir,finalName));
  return {name:finalName,path:`${UPLOAD_DIR}/${finalName}`,size};
}
// Attachments reference uploaded files by project-relative path. Only files directly in
// uploads/ are accepted, so a message can never point an agent at platform metadata.
export function normalizeAttachments(input){
  if(input===undefined||input===null)return undefined;
  if(!Array.isArray(input)||input.length>50)throw httpError('附件必须是不超过 50 项的路径数组');
  const result=[];
  for(const item of input){
    if(typeof item!=='string')throw httpError('附件路径必须是字符串');
    const normalized=item.replace(/\\/g,'/').replace(/^\.\//,'');
    const parts=normalized.split('/');
    if(parts.length!==2||parts[0]!==UPLOAD_DIR||safeUploadName(parts[1])!==parts[1])throw httpError('附件必须位于项目 uploads 文件夹内');
    if(!result.includes(normalized))result.push(normalized);
  }
  return result.length?result:undefined;
}
export async function assertAttachmentsExist(projectPath,attachments=[]){
  for(const rel of attachments){
    let info;
    try{info=await fs.stat(await safePath(projectPath,rel));}
    catch(error){if(error.code==='ENOENT')throw httpError(`附件不存在：${rel}`,404);throw error;}
    if(!info.isFile())throw httpError(`附件不是文件：${rel}`);
  }
}
