import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const csp="default-src 'self'; script-src 'self'; style-src 'self'";
let visits=0;
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    res.setHeader('X-Content-Type-Options','nosniff');
    if(url.pathname==='/api/session'){
      if(req.method==='POST')visits++;
      const session=/(?:^|;\s*)fixture_session=([^;]+)/.exec(req.headers.cookie||'')?.[1]||null;
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':'fixture_session=strict-cookie-ok; Path=/; HttpOnly; SameSite=Strict'});
      res.end(JSON.stringify({session,visits}));return;
    }
    if(url.pathname==='/events'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
      let count=0;const send=()=>res.write('data: '+JSON.stringify({step:++count,label:'事件 '+count})+'\n\n');send();
      const timer=setInterval(()=>{send();if(count===3){clearInterval(timer);res.end();}},350);
      res.on('close',()=>clearInterval(timer));return;
    }
    if(url.pathname==='/form'&&req.method==='POST'){
      let content='';for await(const chunk of req){content+=chunk;if(content.length>4096){res.writeHead(413);res.end();return;}}
      const note=new URLSearchParams(content).get('note')||'';
      res.writeHead(303,{Location:'/index.html?note='+encodeURIComponent(note),'Cache-Control':'no-store'});res.end();return;
    }
    const routes={'/':'index.html','/index.html':'index.html','/app.mjs':'app.mjs','/style.css':'style.css'};
    const name=routes[url.pathname];if(!name){res.writeHead(404);res.end('Not found');return;}
    const type=name.endsWith('.mjs')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8';
    res.writeHead(200,{'Content-Type':type,'Content-Security-Policy':csp,'Cache-Control':'no-store'});
    res.end(await fs.readFile(path.join(root,name)));
  }catch(error){if(!res.headersSent)res.writeHead(500);res.end(error.message);}
});
server.listen(Number(process.env.PORT||4323),process.env.HOST||'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
