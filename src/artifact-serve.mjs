// The server a static Artifact runs as in persistent mode: `node artifact-serve.mjs <root> <entry>` with
// PORT and HOST. It serves the files as they are, with no Studiolo bridge, so the page keeps its data in
// the browser's own storage. Hidden files are never served; an extensionless page route gets the entry.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
const [root,entry='index.html']=process.argv.slice(2).map((value,index)=>index?value:path.resolve(value));
const mime={'.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.map':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.avif':'image/avif','.webp':'image/webp','.wasm':'application/wasm','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.pdf':'application/pdf','.txt':'text/plain; charset=utf-8','.csv':'text/csv; charset=utf-8'};
async function resolve(pathname,acceptsHTML){
  const relative=decodeURIComponent(pathname).replace(/^[/\\]+/,'');
  if(relative.split(/[/\\]/).some(part=>part.startsWith('.')))return null;
  const file=path.resolve(root,relative||entry);if(file!==root&&!file.startsWith(root+path.sep))return null;
  const stats=await fs.stat(file).catch(()=>null);
  if(stats?.isDirectory())return resolve(path.posix.join(pathname,'index.html'),false);
  if(stats)return {file,stats};
  return !path.extname(relative)&&acceptsHTML?resolve('/'+entry,false):null;
}
http.createServer(async(req,res)=>{
  try{
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
    const found=await resolve(new URL(req.url,'http://artifact').pathname,(req.headers.accept||'').includes('text/html'));
    if(!found){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Not found');return;}
    res.writeHead(200,{'Content-Type':mime[path.extname(found.file).toLowerCase()]||'application/octet-stream','Content-Length':found.stats.size,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
    if(req.method==='HEAD'){res.end();return;}
    createReadStream(found.file).on('error',()=>res.destroy()).pipe(res);
  }catch(error){if(!res.headersSent)res.writeHead(400);res.end(error.message);}
}).listen(Number(process.env.PORT),process.env.HOST||'127.0.0.1',()=>console.log(`Artifact: http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT}/`));
