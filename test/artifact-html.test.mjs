import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {createStudio} from '../src/server.mjs';
import {previewClient} from './preview-client.mjs';

const runner={profiles:async()=>[],execute:async()=>({text:''})};
async function setup(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-html-'));let app;
  const start=async()=>{app=await createStudio({stateDir:path.join(dir,'state'),projectRoot:path.join(dir,'projects'),port:0,previewPort:0,runner,token:''});return app;};
  await start();t.after(async()=>{try{await app.close();}finally{await fs.rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50});}});
  const api=async(route,input)=>{const base=`http://127.0.0.1:${app.port}`;const response=await fetch(base+route,{method:input===undefined?'GET':'POST',headers:{Origin:base,'Content-Type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;};
  return {dir,api,restart:async()=>{await app.close();await start();}};
}
async function availablePort(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}

test('native nested HTML, root modules and separate authenticated persistent origins',async t=>{
  const {api,restart}=await setup(t);const p=await api('/api/projects',{name:'native html'});
  for(const root of ['one','two']){await fs.mkdir(path.join(p.path,root,'pages'),{recursive:true});await fs.mkdir(path.join(p.path,root,'assets'));
    await fs.writeFile(path.join(p.path,root,'pages','index.html'),'<!DOCTYPE html><HTML><HEAD class="test" title="x>y"><BASE href="../"><script type="module" src="/assets/main.mjs"></script></HEAD><BODY><h1>HTML</h1></BODY></HTML>');
    await fs.writeFile(path.join(p.path,root,'assets','main.mjs'),`import './dep.mjs';export const name='${root}';`);await fs.writeFile(path.join(p.path,root,'assets','dep.mjs'),`export const id='${root}';`);
    await fs.writeFile(path.join(p.path,root,'assets','style.css'),'@import "sub.css";body{background:url(/assets/icon.svg)}');await fs.writeFile(path.join(p.path,root,'assets','sub.css'),'body{color:blue}');await fs.writeFile(path.join(p.path,root,'assets','icon.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
    await fs.writeFile(path.join(p.path,root,'clip.mp4'),'0123456789');await fs.writeFile(path.join(p.path,root,'fragment.htm'),'<main><h2>Fragment</h2></main>');
    await fs.writeFile(path.join(p.path,root,'meta.html'),`<!doctype html><head><meta id="policy" content="default-src &#39;self&#39;; script-src &#39;self&#39;; style-src &#39;self&#39;" HTTP-EQUIV="Content-Security-Policy"><script type="application/json">{"sample":"<meta http-equiv='Content-Security-Policy' content='UNCHANGED'>"}</script></head><body>Meta CSP</body>`);}
  const a=await api(`/api/projects/${p.id}/artifacts`,{name:'A',root:'one',entry:'pages/index.html'});const b=await api(`/api/projects/${p.id}/artifacts`,{name:'B',root:'two',entry:'pages/index.html'});
  const route=id=>`/api/projects/${p.id}/artifacts/${id}`;let first=await api(route(a.id)+'/start',{}),second=await api(route(b.id)+'/start',{});
  assert.notEqual(first.previewOrigin,second.previewOrigin,'origin/localStorage partition differs for each artifact');
  assert.equal((await fetch(first.directUrl)).status,401,'scanning a port cannot read HTML');
  let client=await previewClient(first),other=await previewClient(second);assert.equal(new URL(client.base).pathname,'/pages/index.html');
  const html=await(await client.request()).text();assert.ok(html.startsWith('<!DOCTYPE html>'));assert.equal((html.match(/<base\b/ig)||[]).length,1);assert.ok(html.includes('<BASE href="../">'));assert.ok(html.includes('<HEAD class="test" title="x>y"><script'));assert.ok(!html.includes('<base href="/p/'));
  assert.match(await(await client.request('/assets/main.mjs')).text(),/name='one'/);assert.match(await(await other.request('/assets/main.mjs')).text(),/name='two'/);
  assert.match((await client.request('/assets/main.mjs')).headers.get('content-type'),/javascript/);assert.match(await(await client.request('/assets/dep.mjs')).text(),/id='one'/);assert.equal((await client.request('/assets/sub.css')).status,200);assert.match((await client.request('/assets/icon.svg')).headers.get('content-type'),/image\/svg/);
  assert.equal((await fetch(second.directUrl,{headers:{Cookie:client.cookies.join('; ')}})).status,401,'other artifact token cannot authorize this origin');
  assert.equal((await client.request('/fragment.htm',{headers:{Origin:'https://untrusted.example'}})).status,403);
  assert.match(await(await client.request('/fragment.htm')).text(),/__STUDIO_BRIDGE__/);
  const meta=await(await client.request('/meta.html')).text();const policy=/<meta id="policy" content="([^"]*)"/.exec(meta)?.[1];assert.ok(policy);assert.match(policy,/script-src 'self' 'nonce-/);assert.match(policy,/style-src 'self' 'nonce-/);assert.ok(!policy.includes('frame-ancestors'));assert.ok(meta.includes("<meta http-equiv='Content-Security-Policy' content='UNCHANGED'>"),'do not rewrite meta strings inside raw script text');
  assert.match(await(await client.request('/app/notes',{headers:{Accept:'text/html'}})).text(),/<h1>HTML/,'SPA navigation falls back to its entry');
  assert.equal((await client.request('/missing.mjs')).status,404,'missing asset is never replaced with HTML');
  const directory=await client.request('/pages');assert.equal(directory.status,308);assert.equal(directory.headers.get('location'),'/pages/');
  const range=await client.request('/clip.mp4',{headers:{Range:'bytes=2-5'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 2-5/10');assert.equal(await range.text(),'2345');
  const head=await client.request('/clip.mp4',{method:'HEAD'});assert.equal(head.headers.get('content-length'),'10');assert.equal(await head.text(),'');const cached=await client.request('/clip.mp4',{headers:{'If-None-Match':head.headers.get('etag')}});assert.equal(cached.status,304);
  const oldPort=first.previewPort;await restart();first=await api(route(a.id)+'/start',{});assert.equal(first.previewPort,oldPort,'machine-private stable port survives complete server restart');client=await previewClient(first);assert.match(await(await client.request('/assets/main.mjs')).text(),/name='one'/);
});

test('backend proxy preserves forms, redirects, cookies, compression, cache validators and streaming',async t=>{
  const {api}=await setup(t);const p=await api('/api/projects',{name:'proxy compatibility'});await fs.mkdir(path.join(p.path,'web'));
  await fs.writeFile(path.join(p.path,'web','server.mjs'),`import http from 'node:http';import {gzipSync} from 'node:zlib';http.createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname==='/index.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Encoding':'gzip','Content-Security-Policy':(url.searchParams.has('inline')?"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'":"default-src 'self'; script-src 'self'; frame-ancestors 'none'"),ETag:'old'});res.end(gzipSync('<!doctype html><HTML><HEAD><title>Proxy</title></HEAD><BODY>你好<form action="/form" method="post"></form></BODY></HTML>'));return;}if(url.pathname==='/redirect'){res.writeHead(302,{Location:'http://127.0.0.1:'+process.env.PORT+'/final?ok=1'});res.end();return;}if(url.pathname==='/sse'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: first\\n\\n');setTimeout(()=>res.end('data: last\\n\\n'),700);return;}if(url.pathname==='/cached'){if(req.headers['if-none-match']==='fixture'){res.writeHead(304,{ETag:'fixture'});res.end();return;}res.writeHead(200,{'Content-Type':'text/plain',ETag:'fixture','Cache-Control':'max-age=60'});res.end('cache');return;}let body='';for await(const chunk of req)body+=chunk;res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':'session=backend-value; Path=/; HttpOnly'});res.end(JSON.stringify({method:req.method,path:url.pathname,query:url.search,body,cookie:req.headers.cookie||'',accept:req.headers.accept,origin:req.headers.origin}));}).listen(Number(process.env.PORT),'127.0.0.1');`);
  const a=await api(`/api/projects/${p.id}/artifacts`,{name:'Proxy',root:'web',command:['node','server.mjs'],port:await availablePort()});const live=await api(`/api/projects/${p.id}/artifacts/${a.id}/start`,{});const client=await previewClient(live);
  const html=await client.request();assert.equal(html.headers.get('content-encoding'),null);assert.equal(html.headers.get('etag'),null);assert.match(html.headers.get('content-security-policy'),/script-src 'self' 'nonce-/);assert.match(html.headers.get('content-security-policy'),/style-src 'self' 'nonce-/);const markup=await html.text();assert.match(markup,/你好/);assert.match(markup,/"styleNonce":/);
  const inline=await client.request('/index.html?inline');assert.match(inline.headers.get('content-security-policy'),/unsafe-inline/);assert.ok(!inline.headers.get('content-security-policy').includes('nonce-'),'do not disable existing unsafe-inline semantics');
  const redirect=await client.request('/redirect');assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),'/final?ok=1');
  const form=await client.request('/form?source=preview',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:'message=%E4%BD%A0%E5%A5%BD'});const received=await form.json();assert.equal(received.method,'POST');assert.equal(received.query,'?source=preview');assert.equal(received.body,'message=%E4%BD%A0%E5%A5%BD');assert.equal(received.cookie,'','Studio auth cookie is not forwarded to app');
  const next=await(await client.request('/form?step=2')).json();assert.equal(next.cookie,'session=backend-value','backend receives its original cookie name only');
  assert.match(form.headers.get('set-cookie'),/^studio_app_/,'cookie namespace prevents cross-artifact leakage');
  const cache=await client.request('/cached');assert.equal(cache.headers.get('etag'),'fixture');assert.equal(cache.headers.get('cache-control'),'max-age=60');assert.equal((await client.request('/cached',{headers:{'If-None-Match':'fixture'}})).status,304);
  const stream=await client.request('/sse');const reader=stream.body.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/first/);assert.ok(!new TextDecoder().decode(first.value).includes('last'),'first event delivered without buffering until response end');while(!(await reader.read()).done){}
});
