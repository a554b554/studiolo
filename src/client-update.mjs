import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';

// One-click desktop client updates (Settings → 版本, update_client in desktop/src-tauri/src/lib.rs).
// The client asks the server it shows for the client release shipped with it: `clientVersion` (from
// desktop/src-tauri/tauri.conf.json) and `clientBuild` (from desktop/package.json; a version stays open
// while it gains features, so builds of one version are told apart by this number). The signed bundles
// are built into desktop/dist (desktop/README.md「Updates」) on every host. The updater checks each bundle against the public key built into the client,
// so these routes need no sign-in: an older client has no device secret to send.
const BUNDLES={'windows-x86_64':v=>`Studiolo_${v}_x64-setup.exe`,'darwin-aarch64':v=>`Studiolo_${v}_aarch64.app.tar.gz`,'darwin-x86_64':v=>`Studiolo_${v}_x64.app.tar.gz`};
const FILE=/^Studiolo_[0-9][0-9A-Za-z.+-]*_(?:x64|aarch64)(?:-setup\.exe|\.app\.tar\.gz)(?:\.sig)?$/;

export const compareVersions=(a,b)=>{const parts=v=>String(v).split(/[.+-]/).map(n=>parseInt(n,10)||0);const x=parts(a),y=parts(b);for(let i=0;i<Math.max(x.length,y.length);i++)if((x[i]||0)!==(y[i]||0))return (x[i]||0)-(y[i]||0);return 0;};

// The updater's answer for GET /api/client/update/<target>/<arch>/<current>?build=<n>: null (204, nothing
// newer or no bundle built for this platform) or the release with its download address and signature.
// The 0.2.0 client sends no build (0). The client accepts whatever is offered, so the decision is made here.
export const newerClient=({clientVersion,clientBuild=0,current,build=0})=>{const order=compareVersions(clientVersion,current);return order>0||order===0&&clientBuild>build;};
export async function clientUpdate({dist,clientVersion,clientBuild,target,arch,current,build,origin}){
  const name=BUNDLES[`${target}-${arch}`]?.(clientVersion);
  if(!name||!clientVersion||!newerClient({clientVersion,clientBuild,current,build}))return null;
  const [info,signature]=await Promise.all([fs.stat(path.join(dist,name)).catch(()=>null),fs.readFile(path.join(dist,name+'.sig'),'utf8').catch(()=>null)]);
  if(!info?.isFile()||!signature)return null;
  return {version:clientVersion,pub_date:info.mtime.toISOString(),url:`${origin}/api/client/download/${encodeURIComponent(name)}`,signature:signature.trim(),notes:''};
}

// Handles /api/client/…; false for any other path.
export async function serveClientUpdate(req,res,{pathname,origin,dist,clientVersion,clientBuild,build}){
  const check=/^\/api\/client\/update\/([\w-]+)\/([\w-]+)\/([^/]+)$/.exec(pathname),download=/^\/api\/client\/download\/([^/]+)$/.exec(pathname);
  if(!check&&!download)return false;
  if(req.method!=='GET'){res.writeHead(405).end();return true;}
  if(check){
    const update=await clientUpdate({dist,clientVersion,clientBuild,build,target:check[1],arch:check[2],current:decodeURIComponent(check[3]),origin});
    if(!update){res.writeHead(204).end();return true;}
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(JSON.stringify(update));return true;
  }
  const name=decodeURIComponent(download[1]);const info=FILE.test(name)?await fs.stat(path.join(dist,name)).catch(()=>null):null;
  if(!info?.isFile()){res.writeHead(404).end();return true;}
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':info.size,'Content-Disposition':`attachment; filename="${name}"`});
  await pipeline(createReadStream(path.join(dist,name)),res);return true;
}
