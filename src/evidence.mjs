import fs from 'node:fs/promises';
import path from 'node:path';
import {safePath,httpError} from './paths.mjs';

const uuid=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export function decodeScreenshot(value){
  if(typeof value!=='string')throw httpError('截图格式无效');
  const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z\d+/]+={0,2})$/.exec(value);
  if(!match||match[2].length%4!==0)throw httpError('截图必须为 PNG、JPEG 或 WebP');
  const bytes=Buffer.from(match[2],'base64'),type=match[1];
  if(bytes.length>1024*1024)throw httpError('截图超过 1 MB',413);
  const valid=type==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):type==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(!valid)throw httpError('截图内容与类型不匹配');
  return {bytes,type,mime:'image/'+type};
}

export async function saveAnchorEvidence(project,annotationId,input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw httpError('无效选取证据');
  const anchor=structuredClone(input);
  // Paths are issued by the server, never accepted from a generated page.
  delete anchor.screenshotPath;delete anchor.screenshotMime;
  if(!anchor.screenshot)return anchor;
  if(!uuid.test(annotationId))throw httpError('无效批注 ID');
  const {bytes,type,mime}=decodeScreenshot(anchor.screenshot);
  const relative=path.posix.join('.studio','attachments',annotationId+'.'+type);
  const directory=await safePath(project.path,'.studio/attachments',{missing:true});
  await fs.mkdir(directory,{recursive:true});
  if((await fs.lstat(directory)).isSymbolicLink())throw httpError('截图目录不能为符号链接');
  const filename=await safePath(project.path,relative,{missing:true});
  const handle=await fs.open(filename,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  delete anchor.screenshot;
  anchor.screenshotPath=relative;anchor.screenshotMime=mime;
  return anchor;
}

export async function readAnchorEvidence(project,annotation){
  const anchor=annotation.anchor||{};
  if(anchor.screenshotPath){
    const expectedPrefix='.studio/attachments/'+annotation.id+'.';
    if(!uuid.test(annotation.id)||!['png','jpeg','webp'].some(ext=>anchor.screenshotPath===expectedPrefix+ext))throw httpError('截图引用无效');
    const filename=await safePath(project.path,anchor.screenshotPath);
    if((await fs.stat(filename)).size>1024*1024)throw httpError('截图超过 1 MB',413);
    return {bytes:await fs.readFile(filename),mime:'image/'+path.extname(filename).slice(1)};
  }
  // Existing projects can still render comments made before file-backed evidence.
  if(anchor.screenshot)return decodeScreenshot(anchor.screenshot);
  throw httpError('这条批注没有截图',404);
}
