import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {gunzipSync,inflateSync,brotliDecompressSync} from 'node:zlib';
import {safePath,inside,writeJson} from './paths.mjs';
import {ArtifactStorage} from './artifact-storage.mjs';

// Backend artifacts get a minimal environment: no platform token, no provider keys. USER/LOGNAME/SHELL
// stay in because CLIs the backend spawns need them: on macOS Claude Code looks up its OAuth credentials
// in the login Keychain by user name and reports "Not logged in" without USER (seen 2026-10-27).
const runtimeEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','TMPDIR','HOME','USER','LOGNAME','SHELL','USERPROFILE','APPDATA','LOCALAPPDATA','LANG','TZ'].includes(key.toUpperCase())));
const mime={'.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.map':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.avif':'image/avif','.webp':'image/webp','.wasm':'application/wasm','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.pdf':'application/pdf','.txt':'text/plain; charset=utf-8','.csv':'text/csv; charset=utf-8'};
const hopHeaders=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const cookiePairs=header=>(header||'').split(';').map(v=>v.trim().split(/=(.*)/s)).filter(v=>v[0]&&v[1]!==undefined);
const appCookiePrefix=live=>'studio_app_'+live.aid.replace(/[^\w]/g,'')+'__';
const viewCookie=view=>'studio_preview_'+createHash('sha256').update(view.aid+':'+view.parentOrigin).digest('hex').slice(0,24);
function decodeHTML(bytes,contentType=''){const sample=bytes.subarray(0,2048).toString('latin1');const charset=/charset\s*=\s*["']?([^\s;"'>]+)/i.exec(contentType)?.[1]||/<meta\b[^>]*charset\s*=\s*["']?([^\s;"'>]+)/i.exec(sample)?.[1]||'utf-8';try{return new TextDecoder(charset).decode(bytes);}catch{return bytes.toString('utf8');}}
function htmlInsert(html,script){
  // Scan markup, skipping comments and raw-text element bodies rather than matching strings in JS.
  const tags=/<!--[\s\S]*?-->|<!doctype(?:[^"'<>]|"[^"]*"|'[^']*')*>|<\/?[a-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/ig;let token,htmlEnd,doctypeEnd;
  while((token=tags.exec(html))){const tag=token[0];if(tag.startsWith('<!--'))continue;if(/^<!doctype/i.test(tag)){doctypeEnd=tags.lastIndex;continue;}if(/^<head(?:\s|>)/i.test(tag))return html.slice(0,tags.lastIndex)+script+html.slice(tags.lastIndex);if(/^<html(?:\s|>)/i.test(tag))htmlEnd=tags.lastIndex;if(/^<(script|style|textarea|title)(?:\s|>)/i.test(tag)){const name=/^<(\w+)/.exec(tag)[1];const closing=new RegExp('</'+name+'\\s*>','ig');closing.lastIndex=tags.lastIndex;const end=closing.exec(html);if(end)tags.lastIndex=closing.lastIndex;}}
  if(htmlEnd!==undefined)return html.slice(0,htmlEnd)+'<head>'+script+'</head>'+html.slice(htmlEnd);
  if(doctypeEnd!==undefined)return html.slice(0,doctypeEnd)+script+html.slice(doctypeEnd);
  return script+html;
}
function scopedCSP(value,parents,nonce,meta=false){
  const rules=(value||'').split(';').map(v=>v.trim()).filter(Boolean).filter(v=>!/^frame-ancestors\b/i.test(v));
  const alreadyInline=rule=>rule.includes("'unsafe-inline'")&&!/'(?:nonce-|sha(?:256|384|512)-)/.test(rule);
  if(nonce)for(const directive of ['script-src','script-src-elem','style-src','style-src-elem']){
    const index=rules.findIndex(v=>v.split(/\s/)[0]===directive);
    if(index>=0){if(!alreadyInline(rules[index]))rules[index]=rules[index].replace(/\s+'none'/g,'')+` 'nonce-${nonce}'`;}
    else if(directive==='script-src'||directive==='style-src'){const fallback=rules.find(v=>v.startsWith('default-src '));if(fallback&&!alreadyInline(fallback))rules.push(fallback.replace('default-src',directive).replace(/\s+'none'/g,'')+` 'nonce-${nonce}'`);}
  }
  if(!meta)rules.push('frame-ancestors '+parents.join(' '));return rules.join('; ');
}
function rewriteMetaPolicies(html,nonce){
  const decode=value=>value.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi,entity=>{const named={'&quot;':'"','&apos;':"'",'&amp;':'&','&lt;':'<','&gt;':'>'};if(named[entity.toLowerCase()])return named[entity.toLowerCase()];const cp=entity[2].toLowerCase()==='x'?parseInt(entity.slice(3,-1),16):parseInt(entity.slice(2,-1),10);return cp>0&&cp<=0x10ffff?String.fromCodePoint(cp):'\ufffd';});
  const escape=value=>value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const tags=/<!--[\s\S]*?-->|<!doctype(?:[^"'<>]|"[^"]*"|'[^']*')*>|<\/?[a-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/ig;
  let result='',last=0,token;
  while((token=tags.exec(html))){const tag=token[0];if(tag.startsWith('<!--'))continue;
    if(/^<(script|style|textarea|title)(?:\s|>)/i.test(tag)){const name=/^<(\w+)/.exec(tag)[1],closing=new RegExp('</'+name+'\\s*>','ig');closing.lastIndex=tags.lastIndex;if(closing.exec(html))tags.lastIndex=closing.lastIndex;continue;}
    if(!/^<meta(?:\s|>)/i.test(tag))continue;
    const attributes=/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;attributes.lastIndex=5;let attribute,content,equiv;
    while((attribute=attributes.exec(tag))){const name=attribute[1].toLowerCase(),value=decode(attribute[2]??attribute[3]??attribute[4]??'');if(name==='content'&&!content)content={match:attribute,value};if(name==='http-equiv'&&equiv===undefined)equiv=value.toLowerCase();}
    if(equiv!=='content-security-policy'||!content)continue;
    const {match,value}=content,updated=tag.slice(0,match.index)+`content="${escape(scopedCSP(value,[],nonce,true))}"`+tag.slice(match.index+match[0].length);
    result+=html.slice(last,token.index)+updated;last=tags.lastIndex;
  }
  return result+html.slice(last);
}
export class ArtifactManager {
  constructor({store,previewPort=4311,bind='127.0.0.1',bridgeFile,stateDir,exposePort}){Object.assign(this,{store,previewPort,bind,bridgeFile,stateDir,exposePort});this.active=new Map();this.tokens=new Map();this.origins=new Map();this.manifests=new Map();this.portMap={};this.portWrites=Promise.resolve();this.storage=new ArtifactStorage();}
  async listen(){this.bridge=await fs.readFile(this.bridgeFile,'utf8');this.storageBridge=await fs.readFile(new URL('../public/artifact-storage.js',import.meta.url),'utf8');if(this.stateDir){try{this.portMap=JSON.parse(await fs.readFile(path.join(this.stateDir,'preview-ports.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}this.server=http.createServer((req,res)=>this.dispatch(req,res));await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.previewPort,this.bind,resolve)});this.previewPort=this.server.address().port;}
  dispatch(req,res,key){this.serve(req,res,key).catch(e=>{if(!res.headersSent)res.writeHead(e.status||(e.code==='ENOENT'?404:400),{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(e.message)});}
  async ensureOrigin(pid,aid){const key=this.key(pid,aid);if(this.origins.has(key))return await this.origins.get(key);const pending=(async()=>{const requested=this.portMap[key]||0;if(requested&&(!Number.isInteger(requested)||requested<1024||requested>65535))throw new Error('无效的机器预览端口映射');const server=http.createServer((req,res)=>this.dispatch(req,res,key));try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(requested,this.bind,resolve)});}catch(e){throw new Error(`Artifact 独立预览端口 ${requested} 不可用：${e.message}`);}const port=server.address().port;this.portMap[key]=port;if(this.stateDir){this.portWrites=this.portWrites.then(()=>writeJson(path.join(this.stateDir,'preview-ports.json'),this.portMap));try{await this.portWrites;}catch(e){await new Promise(r=>server.close(r));throw e;}}try{await this.exposePort?.(port);}catch(e){await new Promise(r=>server.close(r));throw e;}return {server,port};})();this.origins.set(key,pending);try{return await pending;}catch(e){this.origins.delete(key);throw e;}}
  key(pid,aid){return pid+':'+aid;}
  async lookup(pid,aid){const state=await this.store.read(pid),project=state.project;const artifact=state.artifacts.find(a=>a.id===aid);if(!artifact)throw new Error('Artifact 不存在');return {project,artifact,root:await safePath(project.path,artifact.root,{missing:true})};}
  async availability(project,artifact){try{const root=await safePath(project.path,artifact.root);if(!(await fs.stat(root)).isDirectory())throw new Error('Artifact 根路径不是目录');if(!artifact.command)await safePath(root,artifact.entry);return {filesReady:true};}catch(error){if(error.code==='ENOENT')return {filesReady:false,syncMessage:'Artifact 文件尚未同步到这台电脑，请等待 Syncthing 完成同步。'};throw error;}}
  async dataPath(project,rel,{missing=false}={}){const root=await safePath(project.path);const target=await safePath(project.path,rel,{missing});const platform=await safePath(project.path,'.studio');if(target===root||inside(platform,target))throw new Error('数据路径不能覆盖项目或平台记录');return target;}
  async availablePort(port){await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(new Error('Artifact 端口已被占用')));probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});}
  async config(pid,input,knownProject){
    const project=knownProject||await this.store.getProject(pid);if(!input.name?.trim())throw new Error('需要 Artifact 名称');
    const relative=value=>{if(typeof value!=='string'||value.includes('\0')||path.win32.isAbsolute(value)||path.posix.isAbsolute(value))throw new Error('路径必须相对于项目目录');return value.replaceAll('\\','/');};
    const root=relative(input.root||'.'),entry=relative(input.entry||'index.html');
    const rootPath=await safePath(project.path,root,{missing:true});
    const entryPath=await safePath(project.path,path.posix.join(root,entry),{missing:true});
    if(!inside(rootPath,entryPath))throw new Error('入口路径超出 Artifact 范围');
    if(input.command&&(!Array.isArray(input.command)||!input.command.length||input.command.some(x=>typeof x!=='string'||x.includes('\0'))))throw new Error('启动命令必须为 argv 数组');
    if(input.port&&(!Number.isInteger(input.port)||input.port<1024||input.port>65535))throw new Error('无效端口');
    const dataPaths=input.dataPaths||[];if(!Array.isArray(dataPaths))throw new Error('dataPaths 必须为数组');
    const normalized=[];for(const p of dataPaths){if(typeof p!=='string'||!p)throw new Error('无效数据路径');const rel=relative(p);await this.dataPath(project,rel,{missing:true});normalized.push(rel);}
    return {name:input.name.trim(),root,entry,command:input.command||null,port:input.port||null,dataPaths:normalized};
  }
  async create(pid,input){const artifact={...await this.config(pid,input),id:randomUUID(),createdAt:new Date().toISOString()};await this.store.mutate(pid,'artifact.created',s=>s.artifacts.push(artifact));return artifact;}
  // Runs on every project read. Validation resolves every declared path on disk, so it is
  // repeated only when the manifest file changes or the last check is older than 10 s.
  async discover(pid,known){try{const state=known||await this.store.read(pid),project=state.project;let filename;try{filename=await safePath(project.path,'studio.artifacts.json');}catch(error){if(error.code==='ENOENT')return {};throw error;}const info=await fs.stat(filename),identity=`${filename}:${info.ino}:${info.size}:${info.mtimeMs}`;let manifest=this.manifests.get(pid);if(manifest?.identity!==identity||Date.now()-manifest.checkedAt>10000){manifest={identity,checkedAt:Date.now()};try{manifest.configs=await this.manifestConfigs(pid,project,filename,info);}catch(error){manifest.error=error.message;}this.manifests.set(pid,manifest);}if(manifest.error)throw new Error(manifest.error);const changed=manifest.configs.filter(c=>{const existing=state.artifacts.find(a=>a.manifestKey===c.manifestKey);return !existing||Object.keys(c).some(k=>JSON.stringify(c[k])!==JSON.stringify(existing[k]));});if(changed.length)await this.store.mutate(pid,'artifact.discovered',s=>{for(const config of changed){const item=s.artifacts.find(a=>a.manifestKey===config.manifestKey);if(item)Object.assign(item,config);else {const hash=createHash('sha256').update(pid+':'+config.manifestKey).digest('hex').slice(0,32);const id=hash.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');s.artifacts.push({...config,id,createdAt:state.project.createdAt});}}});return {changed:changed.length>0};}catch(error){return {error:'Artifact 清单未导入：'+error.message};}}
  async manifestConfigs(pid,project,filename,info){if(info.size>256000)throw new Error('Artifact 清单超过 256 KB');const manifest=JSON.parse((await fs.readFile(filename,'utf8')).replace(/^\uFEFF/,''));if(!Array.isArray(manifest.artifacts)||manifest.artifacts.length>100)throw new Error('Artifact 清单需包含 artifacts 数组，最多 100 项');const configs=[],keys=new Set();for(const entry of manifest.artifacts){if(typeof entry.key!=='string'||!entry.key||keys.has(entry.key))throw new Error('Artifact 清单 key 必须唯一且非空');keys.add(entry.key);configs.push({manifestKey:entry.key,...await this.config(pid,entry,project)});}return configs;}
  async start(pid,aid,parentOrigin,previewOrigin=parentOrigin){const key=this.key(pid,aid);const {project,artifact,root}=await this.lookup(pid,aid);const available=await this.availability(project,artifact);if(!available.filesReady)throw Object.assign(new Error(available.syncMessage),{status:409});await this.stop(pid,aid);const token=randomBytes(24).toString('hex');const nonce=randomBytes(18).toString('hex');const live={pid,aid,project,artifact,root,token,nonce,parentOrigin,log:'',child:null,error:null,views:new Map()};live.views.set(parentOrigin,{token,nonce,parentOrigin});this.active.set(key,live);this.tokens.set(token,live);
    try{if(artifact.command){if(!artifact.port)throw new Error('后端 Artifact 必须指定端口');if(artifact.port===this.previewPort||artifact.port===Number(new URL(previewOrigin).port))throw new Error('端口与平台冲突');await this.availablePort(artifact.port);const command=[...artifact.command];if(command[0]==='node')command[0]=process.execPath;const child=spawn(command[0],command.slice(1),{cwd:root,env:{...runtimeEnv(),PORT:String(artifact.port),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});live.child=child;const capture=chunk=>{live.log=(live.log+chunk.toString()).slice(-32000)};child.stdout.on('data',capture);child.stderr.on('data',capture);child.on('error',e=>{live.error=e.message});child.on('exit',code=>{live.child=null;live.error=code?'进程退出：'+code:null});await this.ready(live);}
    return await this.status(pid,aid,parentOrigin,previewOrigin);}catch(error){await this.stop(pid,aid);throw error;}
  }
  async ready(live){const deadline=Date.now()+8000;while(Date.now()<deadline){if(live.error||!live.child)throw new Error(live.error||'Artifact 进程已退出');const connected=await new Promise(resolve=>{const socket=net.connect(live.artifact.port,'127.0.0.1');socket.setTimeout(300);const done=value=>{socket.destroy();resolve(value)};socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.once('timeout',()=>done(false));});if(connected)return;await new Promise(r=>setTimeout(r,80));}throw new Error('Artifact 启动超时，请检查日志或启动命令');}
  async stop(pid,aid){const key=this.key(pid,aid),live=this.active.get(key);if(!live)return;for(const view of live.views.values())this.tokens.delete(view.token);this.active.delete(key);if(live.child){const child=live.child;if(process.platform==='win32'){await new Promise(r=>{const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true});killer.on('error',r);killer.on('exit',r)});}else{try{process.kill(-child.pid,'SIGTERM')}catch{}await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);try{process.kill(-child.pid,'SIGKILL')}catch{}}}}
  // A hard-deleted project: stop its previews, close their origin servers and forget their ports.
  async forget(pid){const prefix=pid+':';for(const live of [...this.active.values()])if(live.pid===pid)await this.stop(pid,live.aid);for(const [key,pending] of [...this.origins])if(key.startsWith(prefix)){this.origins.delete(key);try{const {server}=await pending;server.closeAllConnections?.();await new Promise(r=>server.close(r));}catch{}}this.manifests.delete(pid);const ports=Object.keys(this.portMap).filter(key=>key.startsWith(prefix));if(!ports.length)return;for(const key of ports)delete this.portMap[key];if(this.stateDir){this.portWrites=this.portWrites.catch(()=>{}).then(()=>writeJson(path.join(this.stateDir,'preview-ports.json'),this.portMap));await this.portWrites;}}
  async status(pid,aid,parentOrigin,previewOrigin=parentOrigin){const {project,artifact}=await this.lookup(pid,aid);const availability=await this.availability(project,artifact);const live=this.active.get(this.key(pid,aid));let snapshots=[];try{const dirs=await fs.readdir(path.join(project.path,'.studio','snapshots',aid));for(const id of dirs){if(!/^[0-9a-f-]+$/.test(id))continue;try{snapshots.push(await this.snapshotMeta(project.path,aid,id))}catch{}}}catch{}let view,port=this.portMap[this.key(pid,aid)];if(live){({port}=await this.ensureOrigin(pid,aid));view=live.views.get(parentOrigin);if(!view){view={token:randomBytes(24).toString('hex'),nonce:randomBytes(18).toString('hex'),parentOrigin};live.views.set(parentOrigin,view);this.tokens.set(view.token,{...live,...view});}}const origin=new URL(previewOrigin);origin.port=String(port||this.previewPort);const entry=live?.artifact.entry.split('/').map(encodeURIComponent).join('/');return {...availability,hostId:this.store.hostId,running:!!live&&(!live.artifact.command||!!live.child),url:live?origin.origin+'/p/'+view.token+'/'+entry:undefined,directUrl:live?origin.origin+'/'+entry:undefined,nonce:view?.nonce,error:live?.error,log:live?.log,snapshots:snapshots.map(x=>({id:x.id,createdAt:x.createdAt})),previewOrigin:origin.origin,previewPort:port};}
  async snapshotMeta(projectPath,aid,id){if(!/^[0-9a-f-]+$/.test(id))throw new Error('无效快照 ID');return JSON.parse(await fs.readFile(await safePath(projectPath,path.join('.studio','snapshots',aid,id,'manifest.json')),'utf8'));}
  async snapshot(pid,aid){
    await this.stop(pid,aid);const {project,artifact}=await this.lookup(pid,aid);
    const storageDirectory=await this.storage.directory(project.path,aid);await this.storage.tails.get(storageDirectory);
    const {data}=await this.storage.read(project.path,aid);
    const id=randomUUID(),dir=await safePath(project.path,path.join('.studio','snapshots',aid,id),{missing:true});await fs.mkdir(dir,{recursive:true});
    const entries=[];for(const rel of artifact.dataPaths){const source=await this.dataPath(project,rel);await this.rejectLinks(source);const index=entries.length;await fs.cp(source,path.join(dir,String(index)),{recursive:true});entries.push({path:rel,index});}
    await writeJson(path.join(dir,'local-storage.json'),data);
    await writeJson(path.join(dir,'manifest.json'),{id,createdAt:new Date().toISOString(),entries,localStorage:true});return {snapshotId:id,stopped:true};
  }
  async rejectLinks(root){const s=await fs.lstat(root);if(s.isSymbolicLink())throw new Error('快照数据目录不能含符号链接');if(s.isDirectory())for(const name of await fs.readdir(root))await this.rejectLinks(path.join(root,name));}
  async restore(pid,aid,id){await this.stop(pid,aid);const {project,artifact}=await this.lookup(pid,aid);const meta=await this.snapshotMeta(project.path,aid,id);for(const entry of meta.entries){if(!artifact.dataPaths.includes(entry.path)||!Number.isInteger(entry.index)||entry.index<0)throw new Error('快照数据路径与配置不一致');const dest=await this.dataPath(project,entry.path,{missing:true});if(!inside(project.path,dest)||dest===project.path)throw new Error('恢复路径无效');const source=await safePath(path.join(project.path,'.studio','snapshots',aid,id),String(entry.index));await this.rejectLinks(source);if(await fs.stat(dest).catch(()=>null)){const backup=dest+'.before-restore-'+randomUUID();await fs.rename(dest,backup);}await fs.mkdir(path.dirname(dest),{recursive:true});await fs.cp(source,dest,{recursive:true});}if(meta.localStorage){const file=await safePath(project.path,path.join('.studio','snapshots',aid,id,'local-storage.json'));const data=JSON.parse(await fs.readFile(file,'utf8'));if(!data||Array.isArray(data)||typeof data!=='object'||Object.values(data).some(value=>typeof value!=='string'))throw new Error('无效的浏览器存档快照');await this.storage.save(project.path,aid,{id:randomUUID(),ops:[{type:'clear'},...Object.entries(data).map(([key,value])=>({type:'set',key,value}))]});}return {restored:true,stopped:true};}
  async inject(html,live,views=[live],nonce=randomBytes(16).toString('base64')){
    const candidates=views.map(view=>({nonce:view.nonce,parentOrigin:view.parentOrigin,artifactId:live.aid,viewId:viewCookie(view),styleNonce:nonce}));
    const cfg=JSON.stringify(candidates).replace(/</g,'\\u003c');const cookiePrefix=JSON.stringify(appCookiePrefix(live));const storageKey=JSON.stringify('__studio_'+live.aid+'_parent');
    const setup=`(()=>{const choices=${cfg};const locationURL=new URL(location.href);const requestedView=locationURL.searchParams.get('__studio_view');if(requestedView){locationURL.searchParams.delete('__studio_view');try{history.replaceState(history.state,'',locationURL.href)}catch{}}let origin;try{origin=new URL(document.referrer).origin}catch{}let saved;try{saved=JSON.parse(sessionStorage.getItem(${storageKey})||'null')}catch{}const selected=choices.find(x=>x.viewId===requestedView)||choices.find(x=>x.parentOrigin===origin)||choices.find(x=>x.nonce===saved?.nonce&&x.parentOrigin===saved?.parentOrigin)||(choices.length===1?choices[0]:null);if(selected){window.__STUDIO_BRIDGE__=selected;try{sessionStorage.setItem(${storageKey},JSON.stringify(selected))}catch{}}const prefix=${cookiePrefix};try{const d=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');Object.defineProperty(document,'cookie',{configurable:true,get(){return d.get.call(document).split(';').map(x=>x.trim()).filter(x=>x.startsWith(prefix)).map(x=>x.slice(prefix.length)).join('; ')},set(value){const text=String(value);if(!/^[^=;]+=[\\s\\S]*$/.test(text))return;d.set.call(document,prefix+text.replace(/;\\s*domain=[^;]*/ig,''))}})}catch{}})();`;
    const script=`<script nonce="${nonce}">${setup}</script><script nonce="${nonce}">if(window.__STUDIO_BRIDGE__){${this.bridge.replace(/<\/script/gi,'<\\/script')}\n}</script>`;
    const storage=await this.storage.read(live.project.path,live.aid);
    const seed=JSON.stringify({id:live.aid,data:storage.data,touched:[...storage.touched]}).replace(/</g,'\\u003c');
    const storageScript=`<script nonce="${nonce}">window.__STUDIO_STORAGE__=${seed};${this.storageBridge.replace(/<\/script/gi,'<\\/script')}</script>`;
    const combined=script.replace('</script>','</script>'+storageScript);
    return htmlInsert(rewriteMetaPolicies(html,nonce),combined);
  }
  async serve(req,res,key){
    const url=new URL(req.url,'http://preview');const match=/^\/p\/([a-f0-9]+)\/(.*)$/.exec(url.pathname);
    if(!key){const live=match&&this.tokens.get(match[1]);if(!live){res.writeHead(404);res.end('Preview expired');return;}const origin=await this.ensureOrigin(live.pid,live.aid);const target=new URL(req.url,`http://${req.headers.host}`);target.port=String(origin.port);res.writeHead(303,{Location:target.href,'Cache-Control':'no-store'});res.end();return;}
    const active=this.active.get(key);if(!active){res.writeHead(404);res.end('Preview expired');return;}
    const previewOrigin=`http://${req.headers.host}`;
    if(match){
      const view=this.tokens.get(match[1]);if(!view||this.key(view.pid,view.aid)!==key){res.writeHead(404);res.end('Preview expired');return;}
      if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
      const target=new URL('/'+match[2].replace(/^[/\\]+/,''),previewOrigin);target.search=url.search;target.searchParams.set('__studio_view',viewCookie(view));
      res.writeHead(303,{'Set-Cookie':`${viewCookie(view)}=${view.token}; HttpOnly; SameSite=Strict; Path=/`,Location:target.pathname+target.search,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();return;
    }
    const views=[];for(const [name,value] of cookiePairs(req.headers.cookie)){const view=this.tokens.get(value);if(view&&this.key(view.pid,view.aid)===key&&name===viewCookie(view))views.push(view);}
    if(!views.length){res.writeHead(401,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end('Preview authentication required. Open this Artifact from its execution host workspace.');return;}
    const parents=[...new Set(views.map(v=>v.parentOrigin))];
    if(req.headers.origin&&req.headers.origin!==previewOrigin&&!parents.includes(req.headers.origin)){res.writeHead(403);res.end('Origin rejected');return;}
    if(url.pathname==='/__studio/storage'){await this.storage.handle(req,res,active.project.path,active.aid);return;}
    const relative=decodeURIComponent(url.pathname.slice(1));
    const headers={'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':scopedCSP('',parents),'Cache-Control':'no-cache'};
    if(active.artifact.command){await this.proxy(req,res,url,active,views,headers);return;}
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
    if(relative.split(/[/\\]/).some(p=>p.startsWith('.')))throw new Error('隐藏文件不可预览');
    let file;
    try{file=await safePath(active.root,relative||active.artifact.entry);}catch(e){
      // Extensionless HTML navigations can reload a client-side route; assets still return 404.
      if(e.code==='ENOENT'&&!path.posix.extname(relative)&&(req.headers.accept||'').includes('text/html'))file=await safePath(active.root,active.artifact.entry);else throw e;
    }
    let stats=await fs.stat(file);
    if(stats.isDirectory()){
      if(!url.pathname.endsWith('/')){res.writeHead(308,{Location:url.pathname+'/'+url.search,'Cache-Control':'no-store'});res.end();return;}
      file=await safePath(active.root,path.relative(active.root,path.join(file,'index.html')));stats=await fs.stat(file);
    }
    const type=mime[path.extname(file).toLowerCase()]||'application/octet-stream';
    if(type.startsWith('text/html')){const content=Buffer.from(await this.inject(decodeHTML(await fs.readFile(file)),active,views));res.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Length':content.length});res.end(req.method==='HEAD'?undefined:content);return;}
    const etag=`W/"${stats.size}-${stats.mtimeMs}"`;const out={...headers,'Content-Type':type,'Last-Modified':stats.mtime.toUTCString(),ETag:etag,'Accept-Ranges':'bytes'};
    if(req.headers['if-none-match']===etag){res.writeHead(304,out);res.end();return;}
    let start=0,end=stats.size-1,status=200;const range=req.headers.range;
    if(range){const parts=/^bytes=(\d*)-(\d*)$/.exec(range);if(!parts||(!parts[1]&&!parts[2])){res.writeHead(416,{...out,'Content-Range':`bytes */${stats.size}`});res.end();return;}if(parts[1]){start=Number(parts[1]);end=parts[2]?Number(parts[2]):end;}else start=Math.max(0,stats.size-Number(parts[2]));end=Math.min(end,stats.size-1);if(start>end||start>=stats.size){res.writeHead(416,{...out,'Content-Range':`bytes */${stats.size}`});res.end();return;}status=206;out['Content-Range']=`bytes ${start}-${end}/${stats.size}`;}
    res.writeHead(status,{...out,'Content-Length':Math.max(0,end-start+1)});if(req.method==='HEAD'||!stats.size){res.end();return;}
    await new Promise((resolve,reject)=>{const stream=createReadStream(file,{start,end});stream.on('error',reject);res.once('close',()=>{stream.destroy();resolve()});stream.on('end',resolve);stream.pipe(res);});
  }
  async proxy(req,res,url,live,views,headers){
    const prefix=appCookiePrefix(live),parents=[...new Set(views.map(v=>v.parentOrigin))];
    const requestHeaders={};const connectionTokens=(req.headers.connection||'').split(',').map(x=>x.trim().toLowerCase());
    for(const [name,value] of Object.entries(req.headers))if(!hopHeaders.has(name)&&!connectionTokens.includes(name)&&!['host','cookie','origin','referer','accept-encoding','x-studio-hop','x-studio-parent-origin'].includes(name))requestHeaders[name]=value;
    requestHeaders.host=`127.0.0.1:${live.artifact.port}`;requestHeaders['accept-encoding']='identity';requestHeaders['x-forwarded-host']=req.headers.host;requestHeaders['x-forwarded-proto']='http';requestHeaders['x-forwarded-for']=req.socket.remoteAddress;
    const cookies=cookiePairs(req.headers.cookie).filter(([name])=>name.startsWith(prefix)).map(([name,value])=>name.slice(prefix.length)+'='+value);if(cookies.length)requestHeaders.cookie=cookies.join('; ');
    if(req.headers.origin)requestHeaders.origin=`http://127.0.0.1:${live.artifact.port}`;
    await new Promise((resolve,reject)=>{
      const upstream=http.request({hostname:'127.0.0.1',port:live.artifact.port,path:url.pathname+(()=>{const search=new URLSearchParams(url.search);search.delete('__studio_view');return search.size?'?'+search:''})(),method:req.method,headers:requestHeaders},up=>{
        const output={};const skipped=(up.headers.connection||'').split(',').map(x=>x.trim().toLowerCase());for(const [name,value]of Object.entries(up.headers))if(!hopHeaders.has(name)&&!skipped.includes(name)&&!['content-security-policy','x-frame-options','set-cookie','location','referrer-policy'].includes(name)&&value!==undefined)output[name]=value;
        Object.assign(output,Object.fromEntries(Object.entries(headers).map(([name,value])=>[name.toLowerCase(),value])));output['cache-control']=up.headers['cache-control']||'no-cache';
        const nonce=randomBytes(16).toString('base64');output['content-security-policy']=scopedCSP(up.headers['content-security-policy'],parents,nonce);
        if(up.headers['set-cookie'])output['set-cookie']=up.headers['set-cookie'].map(cookie=>prefix+cookie.replace(/;\s*domain=[^;]*/ig,''));
        if(up.headers.location){const target=new URL(up.headers.location,`http://127.0.0.1:${live.artifact.port}${url.pathname}${url.search}`);if(['127.0.0.1','localhost'].includes(target.hostname)&&target.port===String(live.artifact.port))output.location=target.pathname+target.search+target.hash;else output.location=target.href;}
        const isHTML=/^text\/html(?:;|$)/i.test(up.headers['content-type']||'');
        if(!isHTML||req.method==='HEAD'||[204,304].includes(up.statusCode)){
          if(isHTML){delete output['content-length'];delete output['content-encoding'];delete output.etag;delete output['last-modified'];output['content-type']='text/html; charset=utf-8';output['cache-control']='no-store';}
          res.writeHead(up.statusCode,output);if(/^text\/event-stream/i.test(up.headers['content-type']||''))upstream.setTimeout(0);
          up.on('error',reject);up.on('end',resolve);res.once('close',()=>{upstream.destroy();resolve()});up.pipe(res);return;
        }
        const chunks=[];let size=0;up.on('data',chunk=>{size+=chunk.length;if(size>16*1024*1024){up.destroy();reject(new Error('HTML 响应超过 16 MiB'));}else chunks.push(chunk)});up.on('error',reject);up.on('aborted',()=>reject(new Error('Artifact 响应中断')));
        up.on('end',async()=>{try{let bytes=Buffer.concat(chunks);const encoding=(up.headers['content-encoding']||'').toLowerCase();const limit={maxOutputLength:16*1024*1024};if(encoding==='gzip')bytes=gunzipSync(bytes,limit);else if(encoding==='deflate')bytes=inflateSync(bytes,limit);else if(encoding==='br')bytes=brotliDecompressSync(bytes,limit);else if(encoding&&encoding!=='identity')throw new Error('Unsupported HTML encoding');const data=Buffer.from(await this.inject(decodeHTML(bytes,up.headers['content-type']),live,views,nonce));delete output['content-length'];delete output['content-encoding'];delete output.etag;delete output['last-modified'];output['content-type']='text/html; charset=utf-8';output['cache-control']='no-store';res.writeHead(up.statusCode,{...output,'content-length':data.length});res.end(data);resolve();}catch(e){reject(e)}});
      });
      upstream.setTimeout(30000,()=>upstream.destroy(new Error('Artifact 后端响应超时')));upstream.on('error',reject);req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
    });
  }
  async close(){for(const live of [...this.active.values()])await this.stop(live.pid,live.aid);for(const pending of this.origins.values()){try{const {server}=await pending;await new Promise(r=>server.close(r));}catch{}}this.origins.clear();if(this.server)await new Promise(r=>this.server.close(r));}
}
