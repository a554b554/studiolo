import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {gzip} from 'node:zlib';
import {Store} from './store.mjs';
import {QueueManager} from './queue.mjs';
import {CliRunner} from './runner.mjs';
import {ArtifactManager} from './artifacts.mjs';
import {safePath,writeJson,httpError} from './paths.mjs';
import {saveAnchorEvidence,readAnchorEvidence} from './evidence.mjs';
import {changeLifecycle,deleteProject,inactive,listArchives} from './lifecycle.mjs';
import {ProjectPurger} from './purge.mjs';
import {AccountUsage} from './account-usage.mjs';
import {AccountAuth} from './account-auth.mjs';
import {Accounts} from './accounts.mjs';
import {AccountLogin} from './account-login.mjs';
import {renameSession,needsTitle} from './session-titles.mjs';
import {loadTailnet} from './tailnet.mjs';
import {Hosts} from './hosts.mjs';
import {sessionBinding,journalDigest} from './journal.mjs';
import {validateModelPermission} from '../public/model-permissions.js';
import {saveUpload,normalizeAttachments,assertAttachmentsExist} from './uploads.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));const publicRoot=path.resolve(here,'../public');
const localAddress=x=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(x);
const equals=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024)throw httpError('请求过大',413);chunks.push(chunk);}const buf=Buffer.concat(chunks).toString('utf8');try{return buf?JSON.parse(buf):{};}catch{throw httpError('无效 JSON');}}
const rawImageTypes={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.svg':'image/svg+xml'};
// Evidence is written once per annotation ID and never changes, so browsers may keep it.
const sendImage=(res,data)=>{res.writeHead(200,{'Content-Type':data.mime,'Content-Length':data.bytes.length,'Cache-Control':'private, max-age=86400, immutable','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});res.end(data.bytes);};
// Project state is hundreds of KB and refreshed while agents stream; compress it for remote browsers.
// Idle tabs poll the same multi-megabyte state every few seconds, so the last compressed bodies
// are kept (content-addressed, bounded) instead of compressing identical output again.
const compressed=[];let compressedBytes=0;
const remember=(text,zipped)=>{if(compressed.some(e=>e.text===text))return;compressed.push({text,zipped});compressedBytes+=text.length;while(compressed.length>1&&compressedBytes>16*1024*1024)compressedBytes-=compressed.shift().text.length;};
const send=(res,data,status=200)=>{const text=JSON.stringify(data??{}),headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};if(text.length<32768||!/\bgzip\b/.test(res.req?.headers['accept-encoding']||'')){res.writeHead(status,headers);res.end(text);return;}const zippedHeaders={...headers,'Content-Encoding':'gzip',Vary:'Accept-Encoding'};const cached=compressed.find(e=>e.text.length===text.length&&e.text===text);if(cached){res.writeHead(status,zippedHeaders);res.end(cached.zipped);return;}gzip(text,{level:1},(error,zipped)=>{if(error){res.writeHead(status,headers);res.end(text);return;}remember(text,zipped);res.writeHead(status,zippedHeaders);res.end(zipped);});};

export async function createStudio(options={}){
  const stateDir=options.stateDir||process.env.STUDIO_STATE_DIR||path.join(os.homedir(),'.studio-local');await fs.mkdir(stateDir,{recursive:true});const tailnet=await loadTailnet(stateDir);const bind=options.bind||process.env.STUDIO_BIND||'127.0.0.1';const token=options.token??process.env.STUDIO_TOKEN??tailnet?.token??'';if(!localAddress(bind)&&!token)throw new Error('非回环监听需要设置 STUDIO_TOKEN');
  if(tailnet&&(bind!=='127.0.0.1'||(!token&&!tailnet.trustedHosts)))throw new Error('Tailscale Serve requires loopback binding and an explicit access policy');
  let machine;try{machine=JSON.parse(await fs.readFile(path.join(stateDir,'machine.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('本机配置无法读取，拒绝重建身份：'+error.message);machine={hostId:randomUUID(),name:tailnet?.name||os.hostname(),hosts:[]};await writeJson(path.join(stateDir,'machine.json'),machine);}
  const projectRoot=options.projectRoot||path.resolve(here,'../projects');
  const hostId=machine.hostId;const store=options.store||new Store({stateDir,hostId,projectRoot});await store.init();const accounts=options.accounts||new Accounts({stateDir});const runner=options.runner||new CliRunner({stateDir,hostId,accounts});const queue=new QueueManager({store,runner,hostId});const artifacts=new ArtifactManager({store,stateDir,previewPort:options.previewPort??Number(process.env.STUDIO_PREVIEW_PORT||4311),bind,exposePort:tailnet ? port=>tailnet.forwarder.expose(port) : undefined,bridgeFile:path.join(publicRoot,'bridge.js')});await artifacts.listen();const purger=new ProjectPurger({store,runner,artifacts,stateDir,homedir:options.homedir,env:options.env});const clients=new Set(),sessions=new Set();const unsubscribe=store.subscribe(event=>{for(const res of clients)res.write('event: change\ndata: '+JSON.stringify(event)+'\n\n');});
  const hosts=new Hosts({machine,projectRoot,publicUrl:options.publicUrl||(tailnet?.dnsName?`http://${tailnet.dnsName}:${options.port||process.env.STUDIO_PORT||4310}`:undefined),profiles:()=>runner.profiles()});await hosts.init();
  // Accounts live per machine; a conversation bound to an account that no longer exists on
  // its machine may continue with another account there (the native transcript is not kept).
  const accountGone=(host,profileId)=>Boolean(profileId)&&!host.profiles.some(p=>p.id===profileId);
  async function bindSession(pid,id,input,origin){
    const host=await hosts.get(input.hostId||hostId,origin);
    const profile=host.profiles.find(p=>p.id===input.profileId);
    if(!profile||profile.available===false||!profile.models.some(m=>m.id===input.model))throw httpError('Selected account or model is unavailable',409);
    validateModelPermission(profile,input.model,input.permissionMode);
    return store.mutate(pid,'session.bound',s=>{
      const old=sessionBinding(s,id);if(!old)throw httpError('Session not found',404);
      if(old.hostId){
        const rebind=old.hostId===host.id&&accountGone(host,old.profileId);
        if(old.hostId!==host.id||!rebind&&(old.profileId!==input.profileId||old.model!==input.model))throw httpError('Conversation machine, account and model are fixed. Create a new conversation to change them.',409);
        if(!rebind)return old;
        const target=s.sessions.find(x=>x.id===id);Object.assign(target,{profileId:input.profileId,model:input.model,selection:{model:input.model,reasoningEffort:input.reasoningEffort||null,permissionMode:input.permissionMode||'auto'}});return target;
      }
      if((old.createdHostId||s.project.ownerHostId)!==hostId)throw httpError('Bind on the conversation creation server',409);
      const target=s.sessions.find(x=>x.id===id);Object.assign(target,{hostId:host.id,profileId:input.profileId,model:input.model,selection:{model:input.model,reasoningEffort:input.reasoningEffort||null,permissionMode:input.permissionMode||'auto'}});return target;
    });
  }
  async function forward(target,pid,pathname,method,input,origin){
    const host=await hosts.get(target,origin);await hosts.sync(store,host,pid);
    const result=await hosts.request(host,pathname,{method,data:input,timeout:30000});
    await hosts.sync(store,host,pid);return result;
  }
  const accountUsage=options.accountUsage||new AccountUsage({runner});
  // Sign-in runs on the machine that owns the account; pages on other machines reach it through
  // /api/hosts/:id/accounts. Claude subscription sign-in is the pasted-code flow in AccountAuth.
  const accountChanged=()=>{accountUsage.invalidate?.();hosts.cache=null;};
  const accountAuth=options.accountAuth||new AccountAuth({runner,onSuccess:async id=>{accountChanged();await login.refresh(id).catch(()=>{});}});
  const login=options.accountLogin||new AccountLogin({accounts,runner,oauth:accountAuth,onChange:accountChanged});
  const accountsView=async()=>{const list=await accounts.list();return (await runner.profiles()).map(p=>({...p,seed:list.find(a=>a.id===p.id)?.seed,lastError:list.find(a=>a.id===p.id)?.lastError||null}));};
  const uploadLimit=options.uploadLimit??Number(process.env.STUDIO_UPLOAD_LIMIT||100*1024*1024);
  async function handler(req,res){
    const url=new URL(req.url,'http://localhost');const pathname=url.pathname;const origin='http://'+req.headers.host;
    if(!pathname.startsWith('/api/')){if(!['GET','HEAD'].includes(req.method))throw httpError('Method not allowed',405);const file=await safePath(publicRoot,decodeURIComponent(pathname.slice(1)||'index.html'));const info=await fs.stat(file);const etag=`W/"${info.size}-${Math.trunc(info.mtimeMs)}"`;const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.svg':'image/svg+xml'};const headers={'Content-Type':types[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Security-Policy':"frame-ancestors 'none'",'Cache-Control':'no-cache',ETag:etag};if(req.headers['if-none-match']===etag){res.writeHead(304,headers);res.end();return;}const content=await fs.readFile(file);res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:content);return;}
    const bearer=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):null;const cookie=/studio_session=([^;]+)/.exec(req.headers.cookie||'')?.[1];const ownHost=new URL(origin).hostname;const local=localAddress(req.socket.remoteAddress)&&['127.0.0.1','localhost','[::1]'].includes(ownHost)&&localAddress(bind);
    if(req.headers.origin&&req.headers.origin!==origin)throw httpError('跨站请求已拒绝',403);
    if(['/api/auth','/api/login'].includes(pathname)&&req.method==='POST'){const input=await body(req);if(!token||!equals(input.token,token))throw httpError('访问令牌不正确',401);const sid=randomBytes(32).toString('hex');sessions.add(sid);res.setHeader('Set-Cookie',`studio_session=${sid}; HttpOnly; SameSite=Strict; Path=/`);return send(res,{ok:true});}
    const trustedTailnet=tailnet?.trustedHosts?.has(ownHost.toLowerCase())&&localAddress(req.socket.remoteAddress);
    if(!(token?equals(bearer,token)||sessions.has(cookie):local||trustedTailnet))throw httpError('需要访问令牌',401);
    let parentOrigin=origin;if(req.headers['x-studio-parent-origin']){if(!equals(bearer,token)||req.headers['x-studio-hop']!=='1')throw httpError('无效预览来源',403);const candidate=new URL(req.headers['x-studio-parent-origin']);if(!['http:','https:'].includes(candidate.protocol)||candidate.origin!==req.headers['x-studio-parent-origin'])throw httpError('无效预览来源');parentOrigin=candidate.origin;}
    if(pathname==='/api/logout'&&req.method==='POST'){sessions.delete(cookie);res.setHeader('Set-Cookie','studio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(res,{ok:true});}
    if(pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});res.write('event: change\ndata: {}\n\n');clients.add(res);const timer=setInterval(()=>res.write(': heartbeat\n\n'),15000);req.on('close',()=>{clearInterval(timer);clients.delete(res)});return;}
    // Account management and quota, for this machine or (forwarded) for another online host.
    let accountPath=pathname==='/api/account-usage'||pathname.startsWith('/api/accounts')?pathname:null;
    const viaHost=/^\/api\/hosts\/([^/]+)(\/(?:accounts|account-usage)(?:\/.*)?)$/.exec(pathname);
    if(viaHost){
      if(viaHost[1]!==hostId){
        if(req.headers['x-studio-hop'])throw httpError('Host not found',404);
        const host=await hosts.get(viaHost[1],origin);const input=['POST','PATCH','PUT'].includes(req.method)?await body(req):undefined;
        return send(res,await hosts.request(host,'/api'+viaHost[2]+url.search,{method:req.method,data:input,timeout:120000}),req.method==='POST'&&viaHost[2]==='/accounts'?201:200);
      }
      accountPath='/api'+viaHost[2];
    }
    if(accountPath==='/api/account-usage'&&req.method==='GET')return send(res,{hostId,hostName:machine.name,...await accountUsage.get({refresh:url.searchParams.get('refresh')==='1'})});
    if(accountPath==='/api/accounts'){
      if(req.method==='GET')return send(res,{hostId,hostName:machine.name,accounts:await accountsView()});
      if(req.method==='POST'){const input=await body(req);const created=await accounts.create({family:input.family,auth:input.auth,label:input.label});runner.invalidate();accountChanged();return send(res,created,201);}
    }
    const accountRoute=accountPath&&/^\/api\/accounts\/([^/]+)(?:\/(login|logout|refresh)(?:\/([^/]+)(\/code)?)?)?$/.exec(accountPath);
    if(accountRoute){
      const [,id,action,flowId,code]=accountRoute;
      if(!action&&req.method==='PATCH'){const input=await body(req);const updated=await accounts.update(id,{label:input.label});runner.invalidate();accountChanged();return send(res,updated);}
      if(!action&&req.method==='DELETE'){await login.remove(id);return send(res,{ok:true});}
      if(action==='login'&&!flowId&&req.method==='POST')return send(res,await login.start(id,await body(req)),201);
      if(action==='login'&&flowId&&!code&&req.method==='GET')return send(res,login.status(flowId));
      if(action==='login'&&flowId&&code&&req.method==='POST')return send(res,await login.submit(flowId,(await body(req)).code));
      if(action==='login'&&flowId&&!code&&req.method==='DELETE')return send(res,login.cancel(flowId));
      if(action==='logout'&&req.method==='POST')return send(res,await login.logout(id));
      if(action==='refresh'&&req.method==='POST')return send(res,await login.refresh(id));
    }
    if(pathname==='/api/account-auth'&&req.method==='POST')return send(res,await accountAuth.start((await body(req)).profileId),201);
    const authFlow=/^\/api\/account-auth\/([^/]+)(\/code)?$/.exec(pathname);
    if(authFlow?.[2]&&req.method==='POST')return send(res,await accountAuth.submit(authFlow[1],(await body(req)).code));
    if(authFlow&&!authFlow[2]&&req.method==='DELETE')return send(res,accountAuth.cancel(authFlow[1]));
    if(pathname==='/api/archives'&&req.method==='GET')return send(res,await listArchives(store));
    if(pathname==='/api/identity')return send(res,{protocol:2,hostId,name:machine.name,profiles:await runner.profiles()});
    if(pathname==='/api/bootstrap')return send(res,{protocol:2,hostId,features:{},projects:await store.listProjects(),profiles:await runner.profiles(),hosts:hosts.visible(await hosts.online(origin))});
    if(pathname==='/api/hosts'&&req.method==='POST'){const input=await body(req);const target=new URL(input.url);if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw httpError('仅支持 HTTP(S) 主机地址');const host={url:target.origin,token:input.token};const info=await hosts.request(host,'/api/identity');if(info.protocol!==2)throw httpError('Upgrade the remote server first',409);if(info.hostId===hostId)throw httpError('不能把本机登记为远程主机');host.id=info.hostId;host.name=input.name||info.name||info.hostId;machine.hosts=machine.hosts.filter(h=>h.id!==host.id);machine.hosts.push(host);await writeJson(path.join(stateDir,'machine.json'),machine);const {token:secret,...visible}=host;hosts.cache=null;return send(res,visible);}
    const hostMatch=/^\/api\/hosts\/([^/]+)\/bootstrap$/.exec(pathname);if(hostMatch){const host=await hosts.get(hostMatch[1],origin);return send(res,{hostId:host.id,profiles:host.profiles});}
    if(pathname==='/api/projects'){if(req.method==='GET')return send(res,await store.listProjects());if(req.method==='POST'){const input=await body(req);if(typeof input.name!=='string'||!input.name.trim())throw httpError('需要项目名称');if(Object.hasOwn(input,'path'))throw httpError('项目目录由平台自动管理，不接受自定义路径');return send(res,await store.createProject({name:input.name.trim()}),201);}}
    const m=/^\/api\/projects\/([^/]+)(.*)$/.exec(pathname);if(!m)throw httpError('接口不存在',404);const pid=m[1],tail=m[2];
    await store.discoverProjects();
    if(tail==='/journal'&&req.method==='POST'){const input=await body(req);
      // Digest-only probe from a peer whose journal matched ours last time: answer from file names alone.
      if(typeof input.digest==='string'&&input.known===undefined&&input.events===undefined){const names=await store.journalNames(pid),digest=journalDigest(names);return send(res,digest===input.digest?{same:true,digest,names:[],events:[]}:{names,events:[],digest});}
      await store.importJournal(pid,input.events||[]);const result=await store.journal(pid,input.known||[]);return send(res,{...result,digest:journalDigest(result.names)});}
    let state=await store.read(pid);const project=state.project;
    if(tail==='/runtime'&&req.method==='GET'){const live=queue.overlay(pid,state);const ids=new Set([...queue.live.values()].filter(x=>x.projectId===pid).map(x=>x.runId));return send(res,{runs:live.runs.filter(r=>ids.has(r.id)),messages:live.messages.filter(m=>ids.has(m.runId)),nativeRuntime:runner.runtime?.(`${pid}:`)||{}});}
    if(tail==='/takeover')throw httpError('Projects are shared. Choose a machine when starting a new conversation.',409);
    const bindingRoute=/^\/sessions\/([^/]+)\/bind$/.exec(tail);
    if(bindingRoute&&req.method==='POST')return send(res,await bindSession(pid,bindingRoute[1],await body(req),origin));
    // Raw file bodies, one file per request, written to the project's uploads/ folder on this
    // server; Syncthing carries them to the other machines like any other project file.
    if(tail==='/uploads'&&req.method==='POST'){if(inactive(state.project))throw httpError('项目已归档或删除，请先恢复',409);const name=url.searchParams.get('name');if(!name?.trim())throw httpError('需要文件名');return send(res,await saveUpload(project.path,name,req,{limit:uploadLimit}),201);}
    let input;
    if(['POST','PATCH','PUT'].includes(req.method))input=await body(req);
    if(input && (tail==='/messages'||/^\/artifacts\/[^/]+\/annotations$/.test(tail)))validateModelPermission(input.profileId,input.model,input.permissionMode);
    let target=hostId;
    if(tail==='/messages'&&(!input?.text?.trim()||!input?.requestId))throw httpError('需要消息与 requestId');
    // Attachments are checked where the browser uploaded them; a forwarded request may reach
    // the executing machine before Syncthing delivers the file, so hops skip the existence check.
    if(tail==='/messages'&&input){input.attachments=normalizeAttachments(input.attachments);if(input.attachments&&!req.headers['x-studio-hop'])await assertAttachmentsExist(project.path,input.attachments);}
    if(tail==='/messages'&&input?.sessionId){
      let bound=sessionBinding(state,input.sessionId);if(!bound)throw httpError('Session not found',404);
      if(!bound.hostId){const creator=bound.createdHostId||project.ownerHostId||hostId;bound=creator===hostId?await bindSession(pid,input.sessionId,input,origin):await forward(creator,pid,`/api/projects/${pid}/sessions/${input.sessionId}/bind`,'POST',input,origin);}
      if(input.hostId&&input.hostId!==bound.hostId)throw httpError('Conversation machine, account and model are fixed. Create a new conversation to change them.',409);
      if(input.profileId!==bound.profileId||input.model!==bound.model){
        // Only a conversation whose account disappeared from its machine may switch accounts.
        if(!accountGone(await hosts.get(bound.hostId,origin),bound.profileId))throw httpError('Conversation machine, account and model are fixed. Create a new conversation to change them.',409);
        bound=bound.hostId===hostId?await bindSession(pid,input.sessionId,input,origin):await forward(bound.hostId,pid,`/api/projects/${pid}/sessions/${input.sessionId}/bind`,'POST',input,origin);
      }
      target=bound.hostId;
    }
    const runRoute=/^\/runs\/([^/]+)/.exec(tail);
    if(runRoute)target=state.runs.find(r=>r.id===runRoute[1])?.hostId||hostId;
    if(tail==='/queues/resume')target=state.runs.findLast(r=>r.queueId===input.queueId)?.hostId||hostId;
    const sessionLifecycle=/^\/sessions\/([^/]+)\/lifecycle$/.exec(tail);
    if(sessionLifecycle)target=sessionBinding(state,sessionLifecycle[1])?.hostId||hostId;
    if(target!==hostId){if(req.headers['x-studio-hop'])throw httpError('Machine binding has not synchronized yet',409);return send(res,await forward(target,pid,pathname+url.search,req.method,input,origin));}
    const readBody=async()=>input||{};
    const lifecycle=/^\/(?:lifecycle|sessions\/([^/]+)\/lifecycle)$/.exec(tail);
    if(lifecycle&&req.method==='POST'){
      const {action}=await readBody();
      if(!lifecycle[1]&&action==='delete')return send(res,await deleteProject(purger,pid));
      const result=await changeLifecycle(store,pid,lifecycle[1],action);
      if(action!=='restore')await runner.release?.(`${pid}:${lifecycle[1]?'session:'+lifecycle[1]+':':''}`);
      return send(res,result);
    }
    if(inactive(state.project)&&req.method!=='GET')throw httpError('项目已归档或删除，请先恢复',409);
    if(!tail&&req.method==='GET'){const discovery=inactive(state.project)?{}:await artifacts.discover(pid,state);if(discovery.changed)state=await store.read(pid);state=queue.overlay(pid,state);const nativeRuntime=runner.runtime?.(`${pid}:`)||{};
      if(!req.headers['x-studio-hop'])await Promise.all((await hosts.online(origin)).filter(h=>!h.local&&state.runs.some(r=>r.hostId===h.id&&['running','waiting','queued'].includes(r.status))).map(async h=>{try{const live=await hosts.request(h,`/api/projects/${pid}/runtime`);for(const r of live.runs){const i=state.runs.findIndex(x=>x.id===r.id&&x.hostId===h.id);if(i>=0)state.runs[i]=r;}for(const message of live.messages){const i=state.messages.findIndex(x=>x.id===message.id);if(i>=0)state.messages[i]=message;else state.messages.push(message);}Object.assign(nativeRuntime,live.nativeRuntime);}catch{}}));
      return send(res,{...state,sessions:state.sessions.map(s=>sessionBinding(state,s.id)),artifactDiscoveryError:discovery.error||undefined,nativeRuntime});}
    if(tail==='/sessions'&&req.method==='POST'){const input=await readBody();if(input.title!==undefined&&(typeof input.title!=='string'||[...input.title.trim()].length>120||/[\r\n\x00-\x1f]/.test(input.title)))throw httpError('请输入 1–120 个字符的单行标题');const session={id:randomUUID(),createdHostId:hostId,title:input.title?.trim()||'新会话',createdAt:new Date().toISOString()};session.titleSource=needsTitle(session)?'pending':'manual';await store.mutate(pid,'session.created',s=>s.sessions.push(session));return send(res,session,201);}
    const sessionRoute=/^\/sessions\/([^/]+)$/.exec(tail);if(sessionRoute&&req.method==='PATCH')return send(res,await renameSession(store,pid,sessionRoute[1],(await readBody()).title));
    if(tail==='/messages'&&req.method==='POST'){const input=await readBody();if(!input.text?.trim()||!input.requestId)throw httpError('需要消息与 requestId');if(input.hostId&&input.hostId!==hostId)throw httpError('Select this web server for Artifact comments',409);if(input.sessionId&&!state.sessions.some(s=>s.id===input.sessionId))throw httpError('会话不存在',404);if(input.artifactId&&!state.artifacts.some(a=>a.id===input.artifactId))throw httpError('Artifact 不存在',404);if(!input.sessionId&&(!input.artifactId||!state.annotations.some(a=>a.id===input.annotationId&&a.artifactId===input.artifactId)))throw httpError('缺少会话或批注');return send(res,await queue.submit(pid,{...input,text:input.text.trim(),hostId,queueId:input.sessionId?'session:'+input.sessionId:'artifact:'+input.artifactId}),201);}
    const approval=/^\/runs\/([^/]+)\/approvals\/([^/]+)$/.exec(tail);if(approval&&req.method==='POST')return send(res,await queue.approvals.respond(pid,approval[1],approval[2],await readBody()));
    const continuation=/^\/runs\/([^/]+)\/continue$/.exec(tail);if(continuation&&req.method==='POST')return send(res,await queue.continueWaiting(pid,continuation[1]));
    const cancel=/^\/runs\/([^/]+)\/cancel$/.exec(tail);if(cancel&&req.method==='POST'){await queue.cancel(pid,cancel[1]);return send(res,{ok:true});}
    // Stop the current turn but keep the native process and session (Esc in the CLIs).
    const interrupt=/^\/runs\/([^/]+)\/interrupt$/.exec(tail);if(interrupt&&req.method==='POST'){await queue.interrupt(pid,interrupt[1]);return send(res,{ok:true});}if(tail==='/queues/resume'&&req.method==='POST'){const input=await readBody();await queue.resume(pid,input.queueId);return send(res,{ok:true});}
    if(tail==='/files'){const rel=url.searchParams.get('path')||'';const dir=await safePath(project.path,rel);const entries=await fs.readdir(dir,{withFileTypes:true});const results=[];for(const entry of entries.filter(e=>!['.git','node_modules'].includes(e.name))){const p=path.posix.join(rel.replaceAll('\\','/'),entry.name);try{await safePath(project.path,p);results.push({name:entry.name,path:p,type:entry.isDirectory()?'directory':'file'});}catch{}}return send(res,results.sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):a.type==='directory'?-1:1));}
    if(tail==='/file'){const rel=url.searchParams.get('path')||'';const file=await safePath(project.path,rel);if((await fs.stat(file)).size>1024*1024)throw httpError('文件超过 1 MB 预览限制',413);const data=await fs.readFile(file);if(data.includes(0))throw httpError('二进制文件暂不支持文本预览');return send(res,{path:rel,content:data.toString('utf8')});}
    // Images referenced by Markdown previews. Sandboxed like evidence so a project SVG cannot run script.
    if(tail==='/raw'){const rel=url.searchParams.get('path')||'';const type=rawImageTypes[path.extname(rel).toLowerCase()];if(!type)throw httpError('仅支持预览图片文件',415);const file=await safePath(project.path,rel);const info=await fs.stat(file);if(!info.isFile())throw httpError('不是文件');if(info.size>10*1024*1024)throw httpError('图片超过 10 MB 预览限制',413);const etag=`W/"${info.size}-${Math.trunc(info.mtimeMs)}"`;const headers={'Content-Type':type,'Cache-Control':'private, no-cache',ETag:etag,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox"};if(req.headers['if-none-match']===etag){res.writeHead(304,headers);res.end();return;}const bytes=await fs.readFile(file);res.writeHead(200,{...headers,'Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);return;}
    if(tail==='/artifacts'&&req.method==='POST')return send(res,await artifacts.create(pid,await readBody()),201);
    const art=/^\/artifacts\/([^/]+)\/(start|stop|status|snapshot|restore|annotations)$/.exec(tail);if(art){const aid=art[1],action=art[2];if(action==='status')return send(res,await artifacts.status(pid,aid,parentOrigin,origin));if(req.method!=='POST')throw httpError('需要 POST',405);if(action==='start')return send(res,await artifacts.start(pid,aid,parentOrigin,origin));if(action==='stop'){await artifacts.stop(pid,aid);return send(res,{running:false});}if(action==='snapshot')return send(res,await artifacts.snapshot(pid,aid));if(action==='restore')return send(res,await artifacts.restore(pid,aid,(await readBody()).snapshotId));if(action==='annotations'){const input=await readBody();if(input.hostId&&input.hostId!==hostId)throw httpError('Select this web server for Artifact comments',409);await artifacts.lookup(pid,aid);if(!input.text?.trim()||!input.requestId)throw httpError('需要批注文本及 requestId');let annotation=state.annotations.find(a=>a.requestId===input.requestId);if(!annotation){const annotationId=randomUUID();const anchor=await saveAnchorEvidence(project,annotationId,input.anchor||{});annotation={id:annotationId,requestId:input.requestId,artifactId:aid,text:input.text.trim(),anchor,anchorStatus:'attached',status:'open',createdAt:new Date().toISOString()};await store.mutate(pid,'annotation.created',s=>{if(!s.annotations.some(a=>a.requestId===input.requestId))s.annotations.push(annotation);else annotation=s.annotations.find(a=>a.requestId===input.requestId);});}const run=await queue.submit(pid,{...input,artifactId:aid,annotationId:annotation.id,queueId:'artifact:'+aid,hostId});return send(res,{annotation,run},201);}}
    const evidence=/^\/annotations\/([^/]+)\/evidence$/.exec(tail);if(evidence&&req.method==='GET'){const annotation=state.annotations.find(a=>a.id===evidence[1]);if(!annotation)throw httpError('批注不存在',404);return sendImage(res,await readAnchorEvidence(project,annotation));}
    const ann=/^\/annotations\/([^/]+)$/.exec(tail);if(ann&&req.method==='PATCH'){const input=await readBody();let result;await store.mutate(pid,'annotation.updated',s=>{const a=s.annotations.find(a=>a.id===ann[1]);if(!a)throw httpError('批注不存在',404);if(input.status){if(!['open','resolved'].includes(input.status))throw httpError('无效状态');a.status=input.status;}if(input.anchorStatus){if(!['attached','orphaned','unlocated'].includes(input.anchorStatus))throw httpError('无效锚点状态');a.anchorStatus=input.anchorStatus;}result=a;});return send(res,result);}
    throw httpError('接口不存在',404);
  }
  const server=http.createServer((req,res)=>handler(req,res).catch(e=>{if(!res.headersSent)send(res,{error:e.message},e.status||400);else res.end();}));const port=options.port??Number(process.env.STUDIO_PORT||4310);try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,bind,resolve)});if(tailnet)await tailnet.forwarder.expose(server.address().port);await queue.init();}catch(error){unsubscribe();await queue.close();await artifacts.close();if(server.listening)await new Promise(r=>server.close(r));throw error;}
  let syncing=false,syncWork=Promise.resolve();const syncTimer=setInterval(()=>{if(syncing)return;syncing=true;syncWork=(async()=>{try{await purger.reconcile().catch(e=>{purger.lastError=e.message;});const peers=(await hosts.online(`http://${bind}:${server.address().port}`)).filter(h=>!h.local);if(!peers.length)return;const ids=await store.projectIds();for(const h of peers)for(const id of ids)try{await hosts.sync(store,h,id);}catch(e){hosts.lastSyncError=e.message;}}catch(e){hosts.lastSyncError=e.message;}finally{syncing=false;}})();},3000);syncTimer.unref();
  // Projects soft-deleted before hard deletion existed are removed once, after startup.
  const legacyPurge=purger.reconcile({legacy:true}).catch(e=>{purger.lastError=e.message;console.error('Project purge failed: '+e.message);});
  return {server,store,queue,artifacts,purger,legacyPurge,hostId,port:server.address().port,stateDir,async close(){clearInterval(syncTimer);await syncWork;await legacyPurge;unsubscribe();accountAuth.close?.();login.close?.();for(const res of clients)res.end();const shutdown=await queue.close();if(shutdown?.pendingCancellation)console.error(shutdown.error);await artifacts.close();await new Promise(r=>server.close(r));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const app=await createStudio();console.log(`Studio: http://${process.env.STUDIO_BIND||'127.0.0.1'}:${app.port}`);let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await app.close();process.exit(0)});}
