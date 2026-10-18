import path from 'node:path';
import fs from 'node:fs/promises';
import {realpath as realpathCallback} from 'node:fs';
import {promisify} from 'node:util';
// Same component-by-component algorithm as realpathSync, but it no longer blocks the event
// loop: every static file, preview asset and project read resolved paths synchronously.
const realpath=promisify(realpathCallback);
export function inside(root, target) { const rel=path.relative(root,target); return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)); }
export async function safePath(root, relative='', {missing=false}={}) {
  if(typeof relative!=='string'||relative.includes('\0')||path.isAbsolute(relative)) throw new Error('路径必须相对于项目目录');
  const base=await realpath(root);const dest=path.resolve(base,relative);
  if(!inside(base,dest)) throw new Error('路径超出项目范围');
  try {const real=await realpath(dest);if(!inside(base,real))throw new Error('符号链接超出项目范围');return real;}
  catch(error){if(!missing||error.code!=='ENOENT')throw error;let parent=path.dirname(dest);while(true){try{const real=await realpath(parent);if(!inside(base,real))throw new Error('路径超出项目范围');return dest;}catch(e){if(e.code!=='ENOENT')throw e;const next=path.dirname(parent);if(next===parent)throw e;parent=next;}}}
}
export async function writeJson(file,data){await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(data,null,2),{mode:0o600});await fs.rename(temp,file);}
export function httpError(message,status=400){return Object.assign(new Error(message),{status});}
