import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,randomBytes,timingSafeEqual,createHash} from 'node:crypto';
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
import {markSeen} from './unread.mjs';
import {UiState} from './ui-state.mjs';
import {loadTailnet} from './tailnet.mjs';
import {Devices} from './devices.mjs';
import {Hosts} from './hosts.mjs';
import {sessionBinding,journalDigest} from './journal.mjs';
import {validateModelPermission} from '../public/model-permissions.js';
import {isSynced,runHosts,artifactHostOf,replicasOf,syncOf} from '../public/project-hosts.js';
import {ReplicaSync} from './sync-engine.mjs';
import {RsyncTransport} from './transport.mjs';
import {saveUpload,normalizeAttachments,assertAttachmentsExist} from './uploads.mjs';
import {OpenAITranscriber,readAudio,transcribeOptions,DEFAULT_LIMIT as TRANSCRIBE_LIMIT} from './transcribe.mjs';
import {SubagentPolicy,SubagentKnowledge} from './subagents.mjs';
import {PeerIndex} from './peer-index.mjs';
import {DEFAULT_PORT,DEFAULT_PREVIEW_PORT,defaultStateDir,defaultProjectRoot,legacyProjectRoot} from './defaults.mjs';
import {moveLegacyProjects} from './move-projects.mjs';
import {serveClientUpdate} from './client-update.mjs';
import {reveal as revealInFileManager,fileManager} from './reveal.mjs';
import {pageView,runRecords} from './page-view.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));const publicRoot=path.resolve(here,'../public');
const localAddress=x=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(x);
const DRAFT_LIMIT=200000,EDIT_LIMIT=1024*1024;
// A text file's version for the editor: the first 16 hex characters of the SHA-256 of its bytes.
export const fileVersion=bytes=>createHash('sha256').update(bytes).digest('hex').slice(0,16);
// The release this server runs: `version` (package.json, the open version until it is fixed, see CHANGELOG.md), the
// desktop client release shipped with it (`clientVersion`, `clientBuild`) and `build`, a hash of the code, which an open page
// compares with later bootstraps to offer a reload after an update.
async function buildInfo(){const hash=createHash('sha256');for(const [dir,pattern] of [[publicRoot,/\.(js|css|html)$/],[here,/\.mjs$/]])for(const name of (await fs.readdir(dir)).filter(n=>pattern.test(n)).sort())hash.update(name+'\0').update(await fs.readFile(path.join(dir,name)));const read=async(rel,key='version')=>{try{return JSON.parse(await fs.readFile(path.resolve(here,rel),'utf8'))[key]??null;}catch{return null;}};return {version:await read('../package.json')||'0.0.0',clientVersion:await read('../desktop/src-tauri/tauri.conf.json'),clientBuild:await read('../desktop/package.json','build')||0,build:hash.digest('hex').slice(0,16)};}
const categoryName=name=>{if(typeof name!=='string'||!name.trim()||[...name.trim()].length>60||/[\r\n\x00-\x1f]/.test(name))throw httpError('分类名称需为 1–60 个字符的单行文本');return name.trim();};
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
  const stateDir=options.stateDir||defaultStateDir();await fs.mkdir(stateDir,{recursive:true});const tailnet=await loadTailnet(stateDir);const bind=options.bind||process.env.STUDIO_BIND||'127.0.0.1';const token=options.token??process.env.STUDIO_TOKEN??tailnet?.token??'';if(!localAddress(bind)&&!token)throw new Error('非回环监听需要设置 STUDIO_TOKEN');
  // Device allowlist (README「设备白名单」): with it, `token` is the peer token hosts use for each other and every browser or app must be an approved device.
  const devices=(options.deviceAllowlist??tailnet?.deviceAllowlist??false)?await new Devices({stateDir}).load():null;
  if(tailnet&&(bind!=='127.0.0.1'||(!token&&!tailnet.trustedHosts)))throw new Error('Tailscale Serve requires loopback binding and an explicit access policy');
  let machine;try{machine=JSON.parse(await fs.readFile(path.join(stateDir,'machine.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('本机配置无法读取，拒绝重建身份：'+error.message);machine={hostId:randomUUID(),name:tailnet?.name||os.hostname(),hosts:[]};await writeJson(path.join(stateDir,'machine.json'),machine);}
  const projectRoot=options.projectRoot||defaultProjectRoot();
  // Projects left inside the installation by a release before 0.2.0 move next to it once (src/defaults.mjs).
  const moveFrom=options.moveProjectsFrom??(!options.projectRoot&&!process.env.STUDIO_PROJECT_ROOT?legacyProjectRoot():null);
  if(moveFrom)await moveLegacyProjects({from:moveFrom,to:projectRoot,stateDir,homedir:options.homedir,env:options.env});
  const hostId=machine.hostId;const store=options.store||new Store({stateDir,hostId,projectRoot});await store.init();const accounts=options.accounts||new Accounts({stateDir});const runner=options.runner||new CliRunner({stateDir,hostId,accounts});const accountUsage=options.accountUsage||new AccountUsage({runner});
  // Subagent routing rules are one shared document (projects/.studio-settings.json), exchanged with
  // every peer in the host index; the accounts of this machine and their quota are appended when a
  // conversation starts.
  const subagentPolicy=new SubagentPolicy({file:path.join(projectRoot,'.studio-settings.json'),hostId});const subagentKnowledge=new SubagentKnowledge({runner,accountUsage,policy:subagentPolicy,helperPath:path.resolve(here,'../scripts/subagent.mjs')});
  let replicas=null;const queue=new QueueManager({store,runner,hostId,knowledge:()=>subagentKnowledge.describe(),hooks:{beforeRun:(p,run,say,signal)=>replicas?.barrier(p,run,say,signal),afterRun:p=>replicas?.afterRun(p)}});const artifacts=new ArtifactManager({store,stateDir,previewPort:options.previewPort??Number(process.env.STUDIO_PREVIEW_PORT||DEFAULT_PREVIEW_PORT),bind,exposePort:tailnet ? port=>tailnet.forwarder.expose(port) : undefined,forwarder:tailnet?.forwarder,tailnetName:tailnet?.dnsName,platformPorts:()=>[server?.address()?.port].filter(Boolean),bridgeFile:path.join(publicRoot,'bridge.js')});await artifacts.listen();const purger=new ProjectPurger({store,runner,artifacts,stateDir,homedir:options.homedir,env:options.env});const clients=new Set(),sessions=new Set(),handoffs=new Map();
  // Sign-in handoff: a signed-in page opens a Studiolo page in the default browser, or on another server,
  // with a one-time ticket (60 s) instead of making that browser sign in again. A signed-in page can
  // already approve devices on every server (/api/hosts/:id/devices), so a ticket grants nothing new.
  const mintHandoff=()=>{const now=Date.now();for(const [ticket,expires] of handoffs)if(expires<now)handoffs.delete(ticket);if(handoffs.size>=100)throw httpError('登录票据过多，请稍后再试',429);const ticket=randomBytes(24).toString('hex');handoffs.set(ticket,now+60000);return ticket;};
  const unsubscribe=store.subscribe(event=>{for(const res of clients)res.write('event: change\ndata: '+JSON.stringify(event)+'\n\n');});
  const uiState=new UiState({file:path.join(projectRoot,'.studio-ui.json'),hostId});
  const peerIndex=new PeerIndex({store,policy:subagentPolicy,ui:uiState,hostId});
  const app=await buildInfo();
  const hosts=new Hosts({machine,version:app.version,publicUrl:options.publicUrl||(tailnet?.dnsName?`http://${tailnet.dnsName}:${options.port||process.env.STUDIO_PORT||DEFAULT_PORT}`:undefined),profiles:()=>runner.profiles(),files:{projectRoot:store.projectRoot,ssh:machine.ssh?{rsync:machine.rsync,...machine.ssh}:null,rsync:Boolean(machine.rsync)}});
  // A peer is identified by what its own /api/identity reports at the given address.
  async function verifyHost({url,token}){let target;try{target=new URL(url);}catch{throw httpError('仅支持 HTTP(S) 主机地址');}if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw httpError('仅支持 HTTP(S) 主机地址');const host={url:target.origin,token};const info=await hosts.request(host,'/api/identity');if(info.protocol!==2)throw httpError('Upgrade the remote server first',409);if(info.hostId===hostId)throw httpError('不能把本机登记为远程主机');return {...host,id:info.hostId,name:info.name||info.hostId};}
  const hostName=id=>id===hostId?machine.name:machine.hosts.find(h=>h.id===id)?.name||id;
  // Which host holds a project's working tree.
  // Synced projects: this host while its copy is at the head, otherwise the head host.
  const fileHost=state=>{const p=state.project;if(!isSynced(p))return p.ownerHostId||hostId;const mine=replicasOf(p)[hostId];return mine?.state==='ready'&&(!p.head||mine.version===p.head.id)?hostId:p.head?.hostId||p.ownerHostId||hostId;};
  // Saved edits in a synced project are committed like a run's changes, once typing pauses.
  const editCommits=new Map();const commitEdits=pid=>{clearTimeout(editCommits.get(pid));const timer=setTimeout(()=>{editCommits.delete(pid);replicas.afterRun(pid).catch(()=>{});},5000);timer.unref?.();editCommits.set(pid,timer);};
  // Writes to one file run one at a time, so a version check and its write are not interleaved.
  const fileLocks=new Map();const serialFile=(key,fn)=>{const next=(fileLocks.get(key)||Promise.resolve()).catch(()=>{}).then(fn);fileLocks.set(key,next);next.finally(()=>{if(fileLocks.get(key)===next)fileLocks.delete(key);}).catch(()=>{});return next;};
  replicas=new ReplicaSync({store,hosts,hostId,machine,stateDir,transport:options.transport||new RsyncTransport({rsync:machine.rsync,sshKey:machine.sshKey}),hostName});
  // What one replica host does for a project, run here or on that host through /peer/<action>.
  const replicaActions={
    'commit-now':pid=>replicas.commitNow(pid),commit:(pid,i)=>replicas.commit(pid,{force:i.force===true}),push:(pid,i)=>replicas.push(pid,i.hostId),drop:pid=>replicas.drop(pid),footprint:pid=>replicas.footprint(pid),
    status:async pid=>({hostId,status:replicas.status.get(pid)||null}),
    // A project view on a server without the files asks this one to read the Artifact manifest.
    'discover-artifacts':pid=>artifacts.discover(pid),
    // Copies can take hours: they run in the background and report through status.
    add:async(pid,i)=>{replicas.add(pid,{replace:i.replace===true}).catch(()=>{});return {started:true};},
    pull:async(pid,i)=>{replicas.pull(pid,{force:i.force===true}).catch(e=>replicas.report(pid,{phase:'error',error:e.message}));return {started:true};},
  };
  const onReplica=async(id,pid,action,input={},origin)=>id===hostId?replicaActions[action](pid,input):hosts.request(await filesOnline(id,origin),`/api/projects/${pid}/peer/${action}`,{method:'POST',data:input,timeout:6*3600000});
  const filesOnline=async(id,origin)=>{try{return await hosts.get(id,origin);}catch{const name=machine.hosts.find(h=>h.id===id)?.name||id;throw httpError(`${name} is offline; this project's files are only there`,503);}};
  async function saveHost(host){machine.hosts=[...(machine.hosts||[]).filter(h=>h.id!==host.id),host];await writeJson(path.join(stateDir,'machine.json'),machine);hosts.cache=null;}
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
        if(old.hostId!==host.id||!rebind&&old.profileId!==input.profileId)throw httpError('Conversation machine and account are fixed. Create a new conversation to change them.',409);
        if(!rebind&&old.model===input.model)return old;
        const target=s.sessions.find(x=>x.id===id);Object.assign(target,{profileId:input.profileId,model:input.model,selection:{model:input.model,reasoningEffort:input.reasoningEffort||null,permissionMode:input.permissionMode||'auto'}});return target;
      }
      if((old.createdHostId||s.project.ownerHostId)!==hostId)throw httpError('Bind on the conversation creation server',409);
      // A conversation runs where the project's files are: the owner of an unsynced
      // project, or a ready replica of a synced one.
      const allowed=runHosts(s.project);if(allowed&&!allowed.includes(host.id))throw httpError(isSynced(s.project)?`${hostName(host.id)} has no ready copy of this project's files`:`This project is not synced; it runs on ${hostName(s.project.ownerHostId)}`,409);
      const target=s.sessions.find(x=>x.id===id);Object.assign(target,{hostId:host.id,profileId:input.profileId,model:input.model,selection:{model:input.model,reasoningEffort:input.reasoningEffort||null,permissionMode:input.permissionMode||'auto'}});return target;
    });
  }
  async function forward(target,pid,pathname,method,input,origin,headers){
    const host=await hosts.get(target,origin);await hosts.sync(store,host,pid);
    const result=await hosts.request(host,pathname,{method,data:input,timeout:30000,headers});
    await hosts.sync(store,host,pid);return result;
  }
  // Sign-in runs on the machine that owns the account; pages on other machines reach it through
  // /api/hosts/:id/accounts. Claude subscription sign-in is the pasted-code flow in AccountAuth.
  const accountChanged=()=>{accountUsage.invalidate?.();hosts.cache=null;};
  const accountAuth=options.accountAuth||new AccountAuth({runner,onSuccess:async id=>{accountChanged();await login.refresh(id).catch(()=>{});}});
  const login=options.accountLogin||new AccountLogin({accounts,runner,oauth:accountAuth,onChange:accountChanged});
  const accountsView=async()=>{const list=await accounts.list();return (await runner.profiles()).map(p=>({...p,seed:list.find(a=>a.id===p.id)?.seed,lastError:list.find(a=>a.id===p.id)?.lastError||null}));};
  const revealFile=options.reveal||revealInFileManager;
  const uploadLimit=options.uploadLimit??Number(process.env.STUDIO_UPLOAD_LIMIT||100*1024*1024);
  const transcribeLimit=options.transcribeLimit??Number(process.env.STUDIO_TRANSCRIBE_LIMIT||TRANSCRIBE_LIMIT);
  // Voice input (Settings → 语音转写, README「语音输入」): one machine keeps an OpenAI API key, like an account
  // belongs to a machine, and every other server forwards its recordings there. The key never leaves it.
  const openaiTranscriber=options.openaiTranscriber||new OpenAITranscriber({keyFile:path.join(stateDir,'openai-api-key.txt'),model:process.env.STUDIO_TRANSCRIBE_MODEL||undefined});
  const transcriptionHost=async origin=>{if(await openaiTranscriber.available())return {id:hostId,name:machine.name,local:true};return (await hosts.online(origin)).find(h=>!h.local&&h.transcribe)||null;};
  async function transcriptionSettings(req,origin,input){
    const hop=Boolean(req.headers['x-studio-hop']),local=async()=>({hostId,hostName:machine.name,provider:'openai',configured:await openaiTranscriber.available(),hint:await openaiTranscriber.hint()});
    if(req.method==='GET'){if(hop)return await local();const bound=await transcriptionHost(origin);if(!bound)return {provider:'openai',hostId:null,hostName:null,hint:null};if(bound.local)return await local();const remote=await hosts.request(bound,'/api/settings/transcription').catch(()=>({}));return {provider:'openai',hostId:bound.id,hostName:bound.name,hint:remote.hint||null};}
    if(req.method==='PUT'&&hop){await openaiTranscriber.saveKey(input.apiKey);hosts.cache=null;return await local();}
    if(req.method==='DELETE'&&hop){await openaiTranscriber.removeKey();hosts.cache=null;return {ok:true};}
    const peers=(await hosts.online(origin)).filter(h=>!h.local);
    if(req.method==='PUT'){
      const target=input.hostId||hostId;if(input.provider&&input.provider!=='openai')throw httpError('目前只支持 OpenAI');
      if(target===hostId)await openaiTranscriber.saveKey(input.apiKey);else{const host=peers.find(h=>h.id===target);if(!host)throw httpError('这台机器不在线',503);await hosts.request(host,'/api/settings/transcription',{method:'PUT',data:{apiKey:input.apiKey},timeout:30000});}
      // One machine transcribes for all: a key kept elsewhere before is removed.
      if(target!==hostId)await openaiTranscriber.removeKey();for(const host of peers)if(host.id!==target&&host.transcribe)await hosts.request(host,'/api/settings/transcription',{method:'DELETE'}).catch(()=>{});
      hosts.cache=null;return await transcriptionSettings({method:'GET',headers:{}},origin);
    }
    if(req.method==='DELETE'){await openaiTranscriber.removeKey();for(const host of peers)if(host.transcribe)await hosts.request(host,'/api/settings/transcription',{method:'DELETE'}).catch(()=>{});hosts.cache=null;return {provider:'openai',hostId:null,hostName:null,hint:null};}
    throw httpError('Method not allowed',405);
  }
  async function handler(req,res){
    const url=new URL(req.url,'http://localhost');const pathname=url.pathname;const origin='http://'+req.headers.host;
    if(!pathname.startsWith('/api/')){if(!['GET','HEAD'].includes(req.method))throw httpError('Method not allowed',405);const file=await safePath(publicRoot,decodeURIComponent(pathname.slice(1)||'index.html'));const info=await fs.stat(file);const etag=`W/"${info.size}-${Math.trunc(info.mtimeMs)}"`;const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.svg':'image/svg+xml','.png':'image/png'};const headers={'Content-Type':types[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Security-Policy':"frame-ancestors 'self'",'Cache-Control':'no-cache',ETag:etag};if(req.headers['if-none-match']===etag){res.writeHead(304,headers);res.end();return;}const content=await fs.readFile(file);res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:content);return;}
    const bearer=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):null;const cookie=/studio_session=([^;]+)/.exec(req.headers.cookie||'')?.[1];const ownHost=new URL(origin).hostname;const local=localAddress(req.socket.remoteAddress)&&['127.0.0.1','localhost','[::1]'].includes(ownHost)&&localAddress(bind);
    // Reachability probe for other origins (the desktop client's launcher, failover in another server's page): name, id and release only, no auth.
    if(pathname==='/api/identity'&&req.method==='GET'&&req.headers.origin&&req.headers.origin!==origin){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');return send(res,{protocol:2,hostId,name:machine.name,version:app.version});}
    // Desktop client updates (client-update.mjs): signed bundles, no auth.
    if(pathname.startsWith('/api/client/')&&await serveClientUpdate(req,res,{pathname,origin,dist:options.clientDist||path.resolve(here,'../desktop/dist'),clientVersion:app.clientVersion,clientBuild:app.clientBuild,build:Number(url.searchParams.get('build'))||0}))return;
    if(req.headers.origin&&req.headers.origin!==origin)throw httpError('跨站请求已拒绝',403);
    const peer=Boolean(token)&&equals(bearer,token);const trustedTailnet=tailnet?.trustedHosts?.has(ownHost.toLowerCase())&&localAddress(req.socket.remoteAddress);
    const sessionCookie=sid=>res.setHeader('Set-Cookie',`studio_session=${sid}; HttpOnly; SameSite=Strict; Path=/`);
    const handoff=/^\/api\/handoff\/([0-9a-f]{48})$/.exec(pathname);
    if(handoff&&req.method==='GET'){const expires=handoffs.get(handoff[1]);handoffs.delete(handoff[1]);if(!expires||expires<Date.now())throw httpError('这个登录链接已失效，请回到 Studiolo 重新打开',401);const sid=randomBytes(32).toString('hex');sessions.add(sid);sessionCookie(sid);const next=url.searchParams.get('next')||'/';res.writeHead(303,{Location:/^\/(?![/\\])/.test(next)?next:'/','Cache-Control':'no-store'});res.end();return;}
    let device=null;
    if(devices){
      // Device allowlist: the tailnet only carries the connection. A browser or app presents the secret it
      // registered and must have been approved; hosts reach each other with the peer token; a page opened
      // on this machine itself needs nothing. The waiting page gets a `device` code to tell these apart.
      if(!local&&!peer&&tailnet?.trustedHosts&&!trustedTailnet)throw httpError('需要访问令牌',401);
      if(pathname==='/api/device/login'&&req.method==='POST'){const input=await body(req);const known=await devices.identify({id:input.id,name:input.name,secret:input.secret,agent:req.headers['user-agent']});if(known.status==='approved')sessionCookie(devices.createSession(known.id));return send(res,{status:known.status,device:known});}
      if(['/api/auth','/api/login'].includes(pathname)&&req.method==='POST'){const input=await body(req);const known=devices.byBearer(input.token);if(!known)throw httpError('访问令牌不正确',401);sessionCookie(devices.createSession(known.id));return send(res,{ok:true,device:known});}
      if(!local&&!peer){device=devices.session(cookie)||devices.byBearer(bearer);if(!device&&!sessions.has(cookie))throw Object.assign(httpError('此设备尚未获准访问',401),{code:'device'});}
    }else{
      if(['/api/auth','/api/login'].includes(pathname)&&req.method==='POST'){const input=await body(req);if(!token||!equals(input.token,token))throw httpError('访问令牌不正确',401);const sid=randomBytes(32).toString('hex');sessions.add(sid);sessionCookie(sid);return send(res,{ok:true});}
      if(!(token?peer||sessions.has(cookie):local||trustedTailnet))throw httpError('需要访问令牌',401);
    }
    let parentOrigin=origin;if(req.headers['x-studio-parent-origin']){if(req.headers['x-studio-hop']!=='1')throw httpError('无效预览来源',403);const candidate=new URL(req.headers['x-studio-parent-origin']);if(!['http:','https:'].includes(candidate.protocol)||candidate.origin!==req.headers['x-studio-parent-origin'])throw httpError('无效预览来源');parentOrigin=candidate.origin;}
    if(pathname==='/api/logout'&&req.method==='POST'){sessions.delete(cookie);devices?.endSession(cookie);res.setHeader('Set-Cookie','studio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(res,{ok:true});}
    if(pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});res.write('event: change\ndata: {}\n\n');clients.add(res);const timer=setInterval(()=>res.write(': heartbeat\n\n'),15000);req.on('close',()=>{clearInterval(timer);clients.delete(res)});return;}
    // Sign-in handoff (above): a ticket for this server, or one from another server through the peer token.
    const mint=/^\/api\/hosts\/([^/]+)\/handoff$/.exec(pathname);
    if(mint&&req.method==='POST'){if(mint[1]===hostId)return send(res,{ticket:mintHandoff()});if(req.headers['x-studio-hop'])throw httpError('Host not found',404);const host=await hosts.get(mint[1],origin);return send(res,await hosts.request(host,`/api/hosts/${encodeURIComponent(mint[1])}/handoff`,{method:'POST',data:{}}));}
    // Account management and quota, for this machine or (forwarded) for another online host.
    let accountPath=pathname==='/api/account-usage'||pathname.startsWith('/api/accounts')?pathname:null;
    const viaHost=/^\/api\/hosts\/([^/]+)(\/(?:accounts|account-usage|devices)(?:\/.*)?)$/.exec(pathname);
    if(viaHost){
      if(viaHost[1]!==hostId){
        if(req.headers['x-studio-hop'])throw httpError('Host not found',404);
        const host=await hosts.get(viaHost[1],origin);const input=['POST','PATCH','PUT'].includes(req.method)?await body(req):undefined;
        return send(res,await hosts.request(host,'/api'+viaHost[2]+url.search,{method:req.method,data:input,timeout:120000}),req.method==='POST'&&['/accounts','/devices/tokens'].includes(viaHost[2])?201:200);
      }
      accountPath='/api'+viaHost[2];
    }
    // Device allowlist management, for this machine or (above) a peer through /api/hosts/:id/devices.
    const deviceRoute=/^\/api\/devices(?:\/([^/]+))?(?:\/(approve|revoke))?$/.exec(viaHost?accountPath:pathname);
    if(deviceRoute){
      const devicePath=viaHost?accountPath:pathname;
      if(devicePath==='/api/devices'&&req.method==='GET')return send(res,{hostId,hostName:machine.name,enabled:Boolean(devices),devices:devices?devices.list():[],current:device?.id||null});
      if(!devices)throw httpError('此服务未启用设备白名单',409);
      if(devicePath==='/api/devices/tokens'&&req.method==='POST'){const input=await body(req);return send(res,await devices.createToken({name:input.name}),201);}
      const id=decodeURIComponent(deviceRoute[1]||''),self=Boolean(device)&&device.id===id;
      if(deviceRoute[2]==='approve'&&req.method==='POST')return send(res,{device:await devices.approve(id)});
      if(deviceRoute[2]==='revoke'&&req.method==='POST'){if(self)throw httpError('不能吊销当前设备',409);return send(res,{device:await devices.revoke(id)});}
      if(!deviceRoute[2]&&req.method==='PATCH'){const input=await body(req);return send(res,{device:await devices.rename(id,input.name)});}
      if(!deviceRoute[2]&&req.method==='DELETE'){if(self)throw httpError('不能删除当前设备',409);await devices.remove(id);return send(res,{ok:true});}
      throw httpError('Method not allowed',405);
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
    if(pathname==='/api/transcribe'&&req.method==='POST'){
      const audio=await readAudio(req,{limit:transcribeLimit}),input={...audio,...transcribeOptions(url,req.headers)};
      if(await openaiTranscriber.available())return send(res,await openaiTranscriber.transcribe(input));
      const bound=req.headers['x-studio-hop']?null:await transcriptionHost(origin);
      if(bound)return send(res,await hosts.request(bound,'/api/transcribe'+url.search,{method:'POST',raw:audio.bytes,headers:{'Content-Type':req.headers['content-type']},timeout:90000}));
      throw httpError('还没有设置语音转写：在设置 → 语音转写里添加 OpenAI API key',503);
    }
    // Live dictation: a short-lived OpenAI client secret from the machine with the key; the page then streams to OpenAI itself.
    if(pathname==='/api/transcribe/realtime'&&req.method==='POST'){
      if(await openaiTranscriber.available())return send(res,await openaiTranscriber.realtimeSecret(transcribeOptions(url,req.headers)));
      const bound=req.headers['x-studio-hop']?null:await transcriptionHost(origin);
      if(bound)return send(res,await hosts.request(bound,'/api/transcribe/realtime'+url.search,{method:'POST',timeout:30000}));
      throw httpError('还没有设置语音转写：在设置 → 语音转写里添加 OpenAI API key',503);
    }
    if(pathname==='/api/settings/transcription')return send(res,await transcriptionSettings(req,origin,['PUT'].includes(req.method)?await body(req):{}));
    // Subagent routing rules (shared) plus a preview of the section this machine would append to a new conversation.
    if(pathname==='/api/settings/subagents'){
      if(req.method==='GET'){const policy=await subagentPolicy.get();const knowledge=await subagentKnowledge.describe().catch(e=>({error:e.message}));return send(res,{hostId,hostName:machine.name,...policy,helperPath:subagentKnowledge.helperPath,preview:knowledge?.text||null,previewError:knowledge?.error||null});}
      if(req.method==='PUT'){const input=await body(req);return send(res,{hostId,hostName:machine.name,...await subagentPolicy.set({enabled:input.enabled,rules:input.rules},machine.name)});}
      throw httpError('Method not allowed',405);
    }
    // Per-user UI state: last selection, theme and language, shared with every peer.
    if(pathname==='/api/settings/ui'){if(req.method==='GET')return send(res,await uiState.read());if(req.method==='PUT')return send(res,await uiState.set(await body(req)));throw httpError('Method not allowed',405);}
    if(pathname==='/api/archives'&&req.method==='GET')return send(res,await listArchives(store));
    if(pathname==='/api/identity')return send(res,{protocol:2,hostId,name:machine.name,...app,profiles:await runner.profiles(),transcribe:await openaiTranscriber.available(),...(req.headers['x-studio-hop']?{files:hosts.files}:{})});
    if(pathname==='/api/bootstrap')return send(res,{protocol:2,hostId,...app,features:{voiceInput:Boolean(await transcriptionHost(origin)),transcribe:Boolean(await transcriptionHost(origin)),deviceAllowlist:Boolean(devices),reveal:local?fileManager():null},device:device?{id:device.id,name:device.name}:null,projects:await store.listProjects(),profiles:await runner.profiles(),hosts:hosts.visible(await hosts.online(origin)),ui:await uiState.read()});
    // Server registry (machine.json). Registering B on A also registers A on B through B's
    // /api/peer/hello, so the user does it once; removal tells the peer the same way.
    if(pathname==='/api/hosts'&&req.method==='GET')return send(res,await hosts.configured(origin));
    if(pathname==='/api/hosts'&&req.method==='POST'){const input=await body(req);const host=await verifyHost({url:input.url,token:input.token||''});host.name=input.name?.trim()||host.name;await saveHost(host);let mutual=true,mutualError;try{await hosts.request(host,'/api/peer/hello',{method:'POST',data:{hostId,name:machine.name,url:hosts.publicUrl||origin,token}});}catch(e){mutual=false;mutualError=e.message;}const {token:secret,...visible}=host;return send(res,{...visible,mutual,mutualError});}
    const hostEdit=/^\/api\/hosts\/([^/]+)$/.exec(pathname);
    if(hostEdit&&req.method==='PATCH'){const input=await body(req);const old=machine.hosts.find(h=>h.id===hostEdit[1]);if(!old)throw httpError('Host not found',404);let host={...old};if(input.url!==undefined||input.token!==undefined){host={...await verifyHost({url:input.url??old.url,token:input.token??old.token??''}),name:old.name};if(host.id!==old.id)throw httpError('That address belongs to another server',409);}if(input.name?.trim())host.name=input.name.trim();await saveHost(host);const {token:secret,...visible}=host;return send(res,visible);}
    if(hostEdit&&req.method==='DELETE'){const old=machine.hosts.find(h=>h.id===hostEdit[1]);if(!old)throw httpError('Host not found',404);await hosts.request(old,'/api/peer/goodbye',{method:'POST',data:{hostId}}).catch(()=>{});machine.hosts=machine.hosts.filter(h=>h.id!==old.id);await writeJson(path.join(stateDir,'machine.json'),machine);hosts.cache=null;return send(res,{ok:true});}
    if(pathname==='/api/peer/hello'&&req.method==='POST'){if(req.headers['x-studio-hop']!=='1')throw httpError('Peers only',403);const input=await body(req);const host=await verifyHost({url:input.url,token:input.token||''});if(host.id!==input.hostId)throw httpError('Caller identity does not match its address',409);const old=machine.hosts.find(h=>h.id===host.id);await saveHost({...host,name:old?.name||input.name||host.name});return send(res,{hostId,name:machine.name});}
    // Host index exchange: a digest-only probe, or a full index that is merged before ours is returned.
    if(pathname==='/api/peer/index'&&req.method==='POST'){if(req.headers['x-studio-hop']!=='1')throw httpError('Peers only',403);const input=await body(req);if(typeof input.digest==='string'&&!input.projects){const own=await peerIndex.build();return send(res,{same:own.digest===input.digest,digest:own.digest});}await peerIndex.merge(input);return send(res,await peerIndex.build());}
    if(pathname==='/api/peer/goodbye'&&req.method==='POST'){if(req.headers['x-studio-hop']!=='1')throw httpError('Peers only',403);const input=await body(req);machine.hosts=machine.hosts.filter(h=>h.id!==input.hostId);await writeJson(path.join(stateDir,'machine.json'),machine);hosts.cache=null;return send(res,{ok:true});}
    const hostMatch=/^\/api\/hosts\/([^/]+)\/bootstrap$/.exec(pathname);if(hostMatch){const host=await hosts.get(hostMatch[1],origin);return send(res,{hostId:host.id,profiles:host.profiles});}
    if(pathname==='/api/projects'){if(req.method==='GET')return send(res,await store.listProjects());if(req.method==='POST'){const input=await body(req);if(typeof input.name!=='string'||!input.name.trim())throw httpError('需要项目名称');if(Object.hasOwn(input,'path'))throw httpError('项目目录由平台自动管理，不接受自定义路径');return send(res,await store.createProject({name:input.name.trim()}),201);}}
    const m=/^\/api\/projects\/([^/]+)(.*)$/.exec(pathname);if(!m)throw httpError('接口不存在',404);const pid=m[1],tail=m[2];
    await store.discoverProjects();
    if(tail==='/journal'&&req.method==='POST'){const input=await body(req);
      // Digest-only probe from a peer whose journal matched ours last time: answer from file names alone.
      if(typeof input.digest==='string'&&input.known===undefined&&input.events===undefined){const names=await store.journalNames(pid),digest=journalDigest(names);return send(res,digest===input.digest?{same:true,digest,names:[],events:[]}:{names,events:[],digest});}
      await store.importJournal(pid,input.events||[]);const result=await store.journal(pid,input.known||[]);return send(res,{...result,digest:journalDigest(result.names)});}
    let state=await store.read(pid);const project=state.project;
    // A run's full tool records for the page's raw log, from this server's own copy of the journal.
    const recordsRoute=/^\/runs\/([^/]+)\/records$/.exec(tail);
    if(recordsRoute&&req.method==='GET')return send(res,runRecords(state,recordsRoute[1]));
    if(tail==='/runtime'&&req.method==='GET'){const live=queue.overlay(pid,state);const ids=new Set([...queue.live.values()].filter(x=>x.projectId===pid).map(x=>x.runId));return send(res,{runs:live.runs.filter(r=>ids.has(r.id)),messages:live.messages.filter(m=>ids.has(m.runId)),nativeRuntime:runner.runtime?.(`${pid}:`)||{}});}
    // Peer side of replica work (sync-engine.mjs); /peer/versions/<id> hands out a manifest.
    const peerAction=/^\/peer\/([a-z-]+)$/.exec(tail),peerVersion=/^\/peer\/versions\/([^/]+)$/.exec(tail);
    if(peerAction||peerVersion){if(req.headers['x-studio-hop']!=='1')throw httpError('Peers only',403);
      if(peerVersion){const version=await replicas.files.readVersion(project.path,peerVersion[1]);if(!version)throw httpError('Version not found',404);return send(res,version);}
      if(!Object.hasOwn(replicaActions,peerAction[1])||req.method!=='POST')throw httpError('接口不存在',404);return send(res,await replicaActions[peerAction[1]](pid,await body(req))??{});}
    // Sync settings and replicas. Changes that touch files run on a host that holds them.
    if(tail==='/sync'&&req.method==='GET'){const ids=[...new Set([hostId,...Object.keys(replicasOf(project))])];const status=Object.fromEntries(await Promise.all(ids.map(async id=>[id,await onReplica(id,pid,'status',{},origin).then(r=>r.status,()=>({phase:'offline'}))])));return send(res,{ownerHostId:project.ownerHostId,sync:syncOf(project),replicas:replicasOf(project),head:project.head,diverged:project.diverged||null,status});}
    if(tail==='/sync'&&req.method==='PATCH'){const input=await body(req);const files=fileHost(state);
      if(files!==hostId){if(req.headers['x-studio-hop'])throw httpError('Project files are not on this server',409);return send(res,await hosts.request(await filesOnline(files,origin),pathname,{method:'PATCH',data:input,timeout:600000}));}
      const was=isSynced(project),next={...syncOf(project)};
      if(typeof input.enabled==='boolean')next.enabled=input.enabled;if(['auto','manual'].includes(input.commit))next.commit=input.commit;if(typeof input.prefetch==='boolean')next.prefetch=input.prefetch;
      if(input.artifactHostId!==undefined){if(input.artifactHostId!==null&&replicasOf(project)[input.artifactHostId]?.state!=='ready')throw httpError(`${hostName(input.artifactHostId)} has no ready copy of this project`,409);next.artifactHostId=input.artifactHostId;}
      if(was&&!next.enabled){const owner=project.ownerHostId,copy=replicasOf(project)[owner];if(project.head&&copy?.version!==project.head.id)throw httpError(`Bring ${hostName(owner)} up to date first: an unsynced project keeps only its copy`,409);next.artifactHostId=null;}
      // The owner keeps the copy an unsynced project runs on; it moves only to an up-to-date copy.
      let owner=project.ownerHostId;if(input.ownerHostId!==undefined&&input.ownerHostId!==owner){const copy=replicasOf(project)[input.ownerHostId];if(!was||!next.enabled)throw httpError('Only a synced project can change its owner',409);if(copy?.state!=='ready'||project.head&&copy.version!==project.head.id)throw httpError(`${hostName(input.ownerHostId)} needs an up-to-date copy first`,409);owner=input.ownerHostId;}
      if(!was&&next.enabled)await replicas.ensureIgnoreFile(project.path);
      // Explicit replica entries before the owner changes: replicasOf fills in only the current owner.
      await store.mutate(pid,'project.sync',s=>{s.project.sync=next;if(owner!==s.project.ownerHostId){s.project.replicas=replicasOf(s.project);s.project.ownerHostId=owner;}});
      if(!was&&next.enabled)await replicas.commit(pid);
      return send(res,(await store.read(pid)).project);}
    if(tail==='/replicas'&&req.method==='POST'){const input=await body(req);if(!isSynced(project))throw httpError('Turn sync on first',409);const target=input.hostId||hostId;if(replicasOf(project)[target]?.state==='ready')throw httpError(`${hostName(target)} already has a copy`,409);return send(res,await onReplica(target,pid,'add',{replace:input.replace===true},origin),202);}
    const replicaRoute=/^\/replicas\/([^/]+)(\/footprint)?$/.exec(tail);
    if(replicaRoute&&replicaRoute[2]&&req.method==='GET')return send(res,await onReplica(replicaRoute[1],pid,'footprint',{},origin));
    if(replicaRoute&&!replicaRoute[2]&&req.method==='DELETE'){const target=replicaRoute[1],copies=replicasOf(project);
      if(url.searchParams.get('confirm')!=='1')throw httpError('Deleting a copy needs confirmation',400);
      if(target===project.ownerHostId)throw httpError(`${hostName(target)} owns this project and always keeps a copy`,409);
      if(!copies[target])throw httpError(`${hostName(target)} has no copy`,404);
      if(!Object.entries(copies).some(([id,r])=>id!==target&&r.state==='ready'&&(!project.head||r.version===project.head.id)))throw httpError(`Another host must be up to date before ${hostName(target)} deletes its copy`,409);
      if(syncOf(project).artifactHostId===target)await store.mutate(pid,'project.sync',s=>{s.project.sync.artifactHostId=null;});
      return send(res,await onReplica(target,pid,'drop',{},origin));}
    if(tail==='/commit'&&req.method==='POST'){const input=await body(req);return send(res,await onReplica(input.hostId||hostId,pid,'commit',{},origin));}
    // Brings one copy up to the head now instead of before its next run; progress shows in /sync.
    if(tail==='/pull'&&req.method==='POST'){const input=await body(req),target=input.hostId||hostId;if(!isSynced(project))throw httpError('This project is not synced',409);if(replicasOf(project)[target]?.state!=='ready')throw httpError(`${hostName(target)} has no copy yet; add one first`,409);if(project.diverged)throw httpError('Choose which copy to keep first',409);return send(res,await onReplica(target,pid,'pull',{},origin),202);}
    // A diverged project keeps one host's files: it commits them as the head, the others are overwritten.
    if(tail==='/resolve'&&req.method==='POST'){const input=await body(req);if(!project.diverged)throw httpError('This project has not diverged',409);const keep=input.hostId;if(replicasOf(project)[keep]?.state!=='ready')throw httpError(`${hostName(keep)} has no ready copy`,409);
      const head=await onReplica(keep,pid,'commit',{force:true},origin);if(keep!==hostId)await hosts.sync(store,await hosts.get(keep,origin),pid);const others=Object.entries(replicasOf((await store.read(pid)).project)).filter(([id,r])=>id!==keep&&r.state==='ready').map(([id])=>id);
      for(const id of others)await onReplica(id,pid,'pull',{force:true},origin).catch(()=>{});return send(res,{head,pulling:others});}
    if(tail==='/takeover')throw httpError('Projects are shared. Choose a machine when starting a new conversation.',409);
    const bindingRoute=/^\/sessions\/([^/]+)\/bind$/.exec(tail);
    if(bindingRoute&&req.method==='POST')return send(res,await bindSession(pid,bindingRoute[1],await body(req),origin));
    // Project files live on the host that holds them (an unsynced project: its owner).
    // Other servers forward file reads, uploads and artifact creation there; this server may
    // hold only the metadata stub.
    const files=fileHost(state);
    if(files!==hostId&&(tail==='/uploads'&&req.method==='POST'||['/files','/file','/raw'].includes(tail)&&['GET','HEAD'].includes(req.method)||tail==='/file'&&req.method==='PUT'||tail==='/artifacts'&&req.method==='POST')){
      if(req.headers['x-studio-hop'])throw httpError('Project files are not on this server',409);
      const host=await filesOnline(files,origin);
      if(tail==='/artifacts')return send(res,await forward(host.id,pid,pathname,'POST',await body(req),origin),201);
      if(tail==='/files')return send(res,await hosts.request(host,pathname+url.search,{timeout:30000}));
      // File reads and edits pass the file host's answer through as is, so a conflict keeps its code and current version.
      return hosts.proxy(host,req,res,pathname+url.search);
    }
    // Raw file bodies, one file per request, written to the project's uploads/ folder on the host
    // that holds the project's files (requests reach it through the forwarding above).
    if(tail==='/uploads'&&req.method==='POST'){if(inactive(state.project))throw httpError('项目已归档或删除，请先恢复',409);const name=url.searchParams.get('name');if(!name?.trim())throw httpError('需要文件名');return send(res,await saveUpload(project.path,name,req,{limit:uploadLimit}),201);}
    let input;
    if(['POST','PATCH','PUT'].includes(req.method))input=await body(req);
    if(input && (tail==='/messages'||/^\/artifacts\/[^/]+\/annotations$/.test(tail)))validateModelPermission(input.profileId,input.model,input.permissionMode);
    let target=hostId;
    if(tail==='/messages'&&(!input?.text?.trim()||!input?.requestId))throw httpError('需要消息与 requestId');
    // Attachments were uploaded to the host with the files, which is the executing host, so they
    // are checked there (below, once the request has reached it).
    if(tail==='/messages'&&input)input.attachments=normalizeAttachments(input.attachments);
    if(tail==='/messages'&&input?.sessionId){
      let bound=sessionBinding(state,input.sessionId);if(!bound)throw httpError('Session not found',404);
      if(!bound.hostId){const creator=bound.createdHostId||project.ownerHostId||hostId;bound=creator===hostId?await bindSession(pid,input.sessionId,input,origin):await forward(creator,pid,`/api/projects/${pid}/sessions/${input.sessionId}/bind`,'POST',input,origin);}
      // Conversations bound before the project's files left their host stay readable, not runnable.
      const allowed=runHosts(project);if(allowed&&!allowed.includes(bound.hostId))throw httpError(`This project's files are only on ${allowed.map(hostName).join(', ')}. Fork to continue there.`,409);
      if(input.hostId&&input.hostId!==bound.hostId)throw httpError('Conversation machine and account are fixed. Create a new conversation to change them.',409);
      // The model may change between messages: the executing machine checks it and records it on the
      // conversation, and the native session continues on the new model (as /model does in the CLI).
      if(input.profileId!==bound.profileId){
        // Only a conversation whose account disappeared from its machine may switch accounts.
        if(!accountGone(await hosts.get(bound.hostId,origin),bound.profileId))throw httpError('Conversation machine and account are fixed. Create a new conversation to change them.',409);
        bound=bound.hostId===hostId?await bindSession(pid,input.sessionId,input,origin):await forward(bound.hostId,pid,`/api/projects/${pid}/sessions/${input.sessionId}/bind`,'POST',input,origin);
      }
      target=bound.hostId;
    }
    const runRoute=/^\/runs\/([^/]+)/.exec(tail);
    if(runRoute)target=state.runs.find(r=>r.id===runRoute[1])?.hostId||hostId;
    if(tail==='/queues/resume')target=state.runs.findLast(r=>r.queueId===input.queueId)?.hostId||hostId;
    // Artifacts, their comment agents and evidence live on the artifact host.
    const artifactRoute=/^\/artifacts\/[^/]+\/(?:start|persist|stop|status|snapshot|restore|annotations)$/.test(tail)||tail==='/messages'&&input&&!input.sessionId;
    if(artifactRoute){target=artifactHostOf(project)||hostId;if(input?.hostId&&input.hostId!==target)throw httpError(`Artifact comments run on ${hostName(target)}`,409);}
    const sessionLifecycle=/^\/sessions\/([^/]+)\/lifecycle$/.exec(tail);
    if(sessionLifecycle)target=sessionBinding(state,sessionLifecycle[1])?.hostId||hostId;
    if(target!==hostId){if(req.headers['x-studio-hop'])throw httpError('Machine binding has not synchronized yet',409);const headers=artifactRoute?{'X-Studio-Parent-Origin':parentOrigin}:undefined;return send(res,await forward(target,pid,pathname+url.search,req.method,input,origin,headers),tail.endsWith('/annotations')||tail==='/messages'?201:200);}
    if(tail==='/messages'&&input?.attachments)await assertAttachmentsExist(project.path,input.attachments);
    const readBody=async()=>input||{};
    // Viewing a conversation clears its unseen-result mark on whichever machine the browser uses.
    const seen=/^\/sessions\/([^/]+)\/seen$/.exec(tail);
    if(seen&&req.method==='POST'){const {at}=await readBody();if(markSeen({project:{unread:{...state.project.unread}}},seen[1],at))await store.mutate(pid,'session.seen',s=>{markSeen(s,seen[1],at);});return send(res,{ok:true});}
    // A conversation's unsent text, saved by the client so another device opening it finds it.
    // An empty draft is kept with its time, so a cleared draft wins over an older one elsewhere.
    const draft=/^\/sessions\/([^/]+)\/draft$/.exec(tail);
    if(draft){const session=state.sessions.find(s=>s.id===draft[1]);if(!session)throw httpError('Session not found',404);
      if(req.method==='GET')return send(res,session.draft||{text:'',at:null});
      if(req.method!=='PUT')throw httpError('Method not allowed',405);
      const {text}=await readBody();if(typeof text!=='string'||text.length>DRAFT_LIMIT)throw httpError(`A draft is text of at most ${DRAFT_LIMIT} characters`);
      if((session.draft?.text||'')===text)return send(res,session.draft||{text,at:null});
      const value={text,at:new Date().toISOString(),hostId};await store.mutate(pid,'session.draft',s=>{const target=s.sessions.find(x=>x.id===draft[1]);if(target)target.draft=value;});return send(res,value);}
    const lifecycle=/^\/(?:lifecycle|sessions\/([^/]+)\/lifecycle)$/.exec(tail);
    if(lifecycle&&req.method==='POST'){
      const {action}=await readBody();
      if(!lifecycle[1]&&action==='delete')return send(res,await deleteProject(purger,pid));
      const result=await changeLifecycle(store,pid,lifecycle[1],action);
      if(action!=='restore')await runner.release?.(`${pid}:${lifecycle[1]?'session:'+lifecycle[1]+':':''}`);
      return send(res,result);
    }
    if(inactive(state.project)&&req.method!=='GET')throw httpError('项目已归档或删除，请先恢复',409);
    // The complete project view: artifacts discovered, uncommitted live output overlaid, runs
    // executing on other online machines refreshed, every conversation bound to its machine. A run of
    // this machine that ended since the read has left the live overlay too, so the read is repeated:
    // the page would otherwise get it executing without its last output.
    // Artifacts are discovered where the files are: a server holding only the metadata asks the file host,
    // and the journal it then pulls brings the new Artifacts here.
    const discover=async()=>{if(inactive(state.project))return {};const files=fileHost(state);if(files===hostId||req.headers['x-studio-hop'])return artifacts.discover(pid,state);
      try{const host=await hosts.get(files,origin);const result=await hosts.request(host,`/api/projects/${pid}/peer/discover-artifacts`,{method:'POST',data:{},timeout:4000});if(result.changed)await hosts.sync(store,host,pid);return result;}catch{return {};}};
    const assemble=async()=>{const discovery=await discover();const ended=()=>state.runs.some(r=>r.status==='running'&&(!r.hostId||r.hostId===hostId)&&!queue.controllers.has(r.id));if(discovery.changed||ended())state=await store.read(pid);state=queue.overlay(pid,state);const nativeRuntime=runner.runtime?.(`${pid}:`)||{};
      if(!req.headers['x-studio-hop'])await Promise.all((await hosts.online(origin)).filter(h=>!h.local&&state.runs.some(r=>r.hostId===h.id&&['running','waiting','queued'].includes(r.status))).map(async h=>{try{const live=await hosts.request(h,`/api/projects/${pid}/runtime`);for(const r of live.runs){const i=state.runs.findIndex(x=>x.id===r.id&&x.hostId===h.id);if(i>=0)state.runs[i]=r;}for(const message of live.messages){const i=state.messages.findIndex(x=>x.id===message.id);if(i>=0)state.messages[i]=message;else state.messages.push(message);}Object.assign(nativeRuntime,live.nativeRuntime);}catch{}}));
      return {...state,filesHostId:fileHost(state),sessions:state.sessions.map(s=>sessionBinding(state,s.id)),artifactDiscoveryError:discovery.error||undefined,nativeRuntime};};
    // The web page asks for one conversation (?session=) or one Artifact's threads (?artifact=), with
    // tool records of ended runs as previews; without either, the full view.
    if(!tail&&req.method==='GET'){const sessionId=url.searchParams.get('session'),artifactId=url.searchParams.get('artifact');const full=await assemble();return send(res,sessionId||artifactId?pageView(full,{sessionId,artifactId}):full);}
    if(tail==='/sessions'&&req.method==='POST'){const input=await readBody();if(input.title!==undefined&&(typeof input.title!=='string'||[...input.title.trim()].length>120||/[\r\n\x00-\x1f]/.test(input.title)))throw httpError('请输入 1–120 个字符的单行标题');const session={id:randomUUID(),createdHostId:hostId,title:input.title?.trim()||'新会话',createdAt:new Date().toISOString()};session.titleSource=needsTitle(session)?'pending':'manual';await store.mutate(pid,'session.created',s=>s.sessions.push(session));return send(res,session,201);}
    // A fork starts unbound: the first send picks its computer and account.
    const forkRoute=/^\/sessions\/([^/]+)\/fork$/.exec(tail);if(forkRoute&&req.method==='POST'){await readBody();const source=state.sessions.find(s=>s.id===forkRoute[1]&&!s.deletedAt);if(!source)throw httpError('会话不存在',404);if(inactive(project))throw httpError('项目已归档或删除，请先恢复',409);const at=new Date().toISOString(),session={id:randomUUID(),createdHostId:hostId,title:`${source.title} · 分叉`.slice(0,120),titleSource:'manual',createdAt:at,forkOf:{projectId:pid,sessionId:source.id,at}};await store.mutate(pid,'session.forked',s=>{s.sessions.push(session);const from=s.sessions.find(x=>x.id===source.id);from.forks=[...(from.forks||[]),session.id];});return send(res,session,201);}
    // A conversation's title and its category; forks are listed under the conversation they came from, so they take no category of their own.
    const sessionRoute=/^\/sessions\/([^/]+)$/.exec(tail);if(sessionRoute&&req.method==='PATCH'){const input=await readBody();let session=input.title!==undefined?await renameSession(store,pid,sessionRoute[1],input.title):null;
      if(Object.hasOwn(input,'categoryId')){const cid=input.categoryId;if(cid!==null&&typeof cid!=='string')throw httpError('无效分类');session=await store.mutate(pid,'session.categorized',s=>{const target=s.sessions.find(x=>x.id===sessionRoute[1]);if(!target)throw httpError('对话不存在',404);if(target.forkOf)throw httpError('分叉跟随原对话，不能单独分类',409);if(cid!==null&&!(s.project.categories||[]).some(c=>c.id===cid))throw httpError('分类不存在',404);if(cid===null)delete target.categoryId;else target.categoryId=cid;return target;});}
      if(!session)throw httpError('需要标题或分类');return send(res,session);}
    if(tail==='/categories'&&req.method==='POST'){const input=await readBody();const name=categoryName(input.name),ids=input.sessionIds??[];if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))throw httpError('sessionIds 需为对话 ID 数组');const category={id:randomUUID(),name,createdAt:new Date().toISOString()};
      await store.mutate(pid,'category.created',s=>{const targets=ids.map(id=>s.sessions.find(x=>x.id===id));if(targets.some(x=>!x))throw httpError('对话不存在',404);if(targets.some(x=>x.forkOf))throw httpError('分叉跟随原对话，不能单独分类',409);s.project.categories=[...(s.project.categories||[]),category];for(const target of targets)target.categoryId=category.id;});return send(res,category,201);}
    const categoryRoute=/^\/categories\/([^/]+)$/.exec(tail);
    if(categoryRoute&&['PATCH','DELETE'].includes(req.method)){const cid=categoryRoute[1],name=req.method==='PATCH'?categoryName((await readBody()).name):null;let result={ok:true};
      await store.mutate(pid,req.method==='PATCH'?'category.renamed':'category.deleted',s=>{const list=s.project.categories||[],index=list.findIndex(c=>c.id===cid);if(index<0)throw httpError('分类不存在',404);if(name){s.project.categories=list.map(c=>c.id===cid?{...c,name}:c);result=s.project.categories[index];return;}s.project.categories=list.filter(c=>c.id!==cid);for(const target of s.sessions)if(target.categoryId===cid)delete target.categoryId;});return send(res,result);}
    // Detaching makes a fork an ordinary conversation: it leaves its source's fork list and joins the category of the conversation it came from.
    const detachRoute=/^\/sessions\/([^/]+)\/detach$/.exec(tail);if(detachRoute&&req.method==='POST'){await readBody();return send(res,await store.mutate(pid,'session.detached',s=>{const target=s.sessions.find(x=>x.id===detachRoute[1]);if(!target)throw httpError('对话不存在',404);if(!target.forkOf)throw httpError('这个对话不是分叉',409);
      let root=target;const seen=new Set();while(root.forkOf&&!seen.has(root.id)){seen.add(root.id);root=s.sessions.find(x=>x.id===root.forkOf.sessionId)||{id:root.id};}
      const source=s.sessions.find(x=>x.id===target.forkOf.sessionId);if(source)source.forks=(source.forks||[]).filter(id=>id!==target.id);
      target.detachedFrom={sessionId:target.forkOf.sessionId,at:new Date().toISOString()};delete target.forkOf;if(root.categoryId)target.categoryId=root.categoryId;else delete target.categoryId;return target;}));}
    if(tail==='/messages'&&req.method==='POST'){const input=await readBody();if(!input.text?.trim()||!input.requestId)throw httpError('需要消息与 requestId');if(input.hostId&&input.hostId!==hostId)throw httpError('Select this web server for Artifact comments',409);if(input.sessionId&&!state.sessions.some(s=>s.id===input.sessionId))throw httpError('会话不存在',404);if(input.artifactId&&!state.artifacts.some(a=>a.id===input.artifactId))throw httpError('Artifact 不存在',404);if(!input.sessionId&&(!input.artifactId||!state.annotations.some(a=>a.id===input.annotationId&&a.artifactId===input.artifactId)))throw httpError('缺少会话或批注');return send(res,await queue.submit(pid,{...input,text:input.text.trim(),hostId,queueId:input.sessionId?'session:'+input.sessionId:'artifact:'+input.artifactId}),201);}
    const approval=/^\/runs\/([^/]+)\/approvals\/([^/]+)$/.exec(tail);if(approval&&req.method==='POST')return send(res,await queue.approvals.respond(pid,approval[1],approval[2],await readBody()));
    const continuation=/^\/runs\/([^/]+)\/continue$/.exec(tail);if(continuation&&req.method==='POST')return send(res,await queue.continueWaiting(pid,continuation[1]));
    const cancel=/^\/runs\/([^/]+)\/cancel$/.exec(tail);if(cancel&&req.method==='POST'){await queue.cancel(pid,cancel[1]);return send(res,{ok:true});}
    // Stop the current turn but keep the native process and session (Esc in the CLIs).
    const interrupt=/^\/runs\/([^/]+)\/interrupt$/.exec(tail);if(interrupt&&req.method==='POST'){await queue.interrupt(pid,interrupt[1]);return send(res,{ok:true});}if(tail==='/queues/resume'&&req.method==='POST'){const input=await readBody();await queue.resume(pid,input.queueId);return send(res,{ok:true});}
    // Show in File Explorer: only for a page on this machine (127.0.0.1), and only where the files are.
    if(tail==='/reveal'&&req.method==='POST'){if(!local)throw httpError('只能在这台电脑上用 127.0.0.1 打开 Studiolo 时使用',403);if(files!==hostId)throw httpError('项目文件不在这台电脑上',409);const rel=typeof input.path==='string'?input.path:'';const target=await safePath(project.path,rel);await revealFile(target,{directory:(await fs.stat(target)).isDirectory()});return send(res,{ok:true});}
    if(tail==='/files'){const rel=url.searchParams.get('path')||'';const dir=await safePath(project.path,rel);const entries=await fs.readdir(dir,{withFileTypes:true});const results=[];for(const entry of entries.filter(e=>!['.git','node_modules'].includes(e.name))){const p=path.posix.join(rel.replaceAll('\\','/'),entry.name);try{await safePath(project.path,p);results.push({name:entry.name,path:p,type:entry.isDirectory()?'directory':'file'});}catch{}}return send(res,results.sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):a.type==='directory'?-1:1));}
    // Text files carry a version (fileVersion); an edit names the version it started from and is refused once the file changed.
    const fileMeta=(rel,bytes,info)=>({path:rel,version:fileVersion(bytes),size:info.size,mtime:info.mtime.toISOString()});
    if(tail==='/file'&&req.method==='PUT'){const rel=typeof input.path==='string'?input.path:'';if(!rel)throw httpError('需要文件路径');if(rel.split(/[\\/]/).some(p=>['.studio','.git'].includes(p.toLowerCase())))throw httpError('不能编辑 .studio 或 .git 里的文件',403);if(typeof input.content!=='string'||Buffer.byteLength(input.content)>EDIT_LIMIT)throw httpError('文件内容需为不超过 1 MB 的文本',413);if(input.version!==null&&typeof input.version!=='string')throw httpError('需要文件版本');
      const file=await safePath(project.path,rel,{missing:true});
      const saved=await serialFile(file,async()=>{let current=null;try{const info=await fs.stat(file);if(!info.isFile())throw httpError('不是文件');current=fileVersion(await fs.readFile(file));}catch(e){if(e.code!=='ENOENT')throw e;}
        if(current!==input.version)return {conflict:current};
        if(current===null)await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,input.content);const bytes=await fs.readFile(file);return fileMeta(rel,bytes,await fs.stat(file));});
      if(Object.hasOwn(saved,'conflict'))return send(res,{error:saved.conflict===null?'文件已被删除':'文件已被修改',code:'conflict',version:saved.conflict},409);
      if(isSynced(project))commitEdits(pid);return send(res,saved);}
    if(tail==='/file'){const rel=url.searchParams.get('path')||'';const stat=url.searchParams.get('stat')==='1';let file;try{file=await safePath(project.path,rel);}catch(e){if(stat&&e.code==='ENOENT')throw Object.assign(httpError('文件不存在',404),{code:'missing'});throw e;}const info=await fs.stat(file);if(stat){if(!info.isFile())throw httpError('不是文件');return send(res,fileMeta(rel,await fs.readFile(file),info));}if(info.size>1024*1024)throw httpError('文件超过 1 MB 预览限制',413);const data=await fs.readFile(file);if(data.includes(0))throw httpError('二进制文件暂不支持文本预览');return send(res,{...fileMeta(rel,data,info),content:data.toString('utf8')});}
    // Images referenced by Markdown previews. Sandboxed like evidence so a project SVG cannot run script.
    if(tail==='/raw'){const rel=url.searchParams.get('path')||'';const type=rawImageTypes[path.extname(rel).toLowerCase()];if(!type)throw httpError('仅支持预览图片文件',415);const file=await safePath(project.path,rel);const info=await fs.stat(file);if(!info.isFile())throw httpError('不是文件');if(info.size>10*1024*1024)throw httpError('图片超过 10 MB 预览限制',413);const etag=`W/"${info.size}-${Math.trunc(info.mtimeMs)}"`;const headers={'Content-Type':type,'Cache-Control':'private, no-cache',ETag:etag,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox"};if(req.headers['if-none-match']===etag){res.writeHead(304,headers);res.end();return;}const bytes=await fs.readFile(file);res.writeHead(200,{...headers,'Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);return;}
    if(tail==='/artifacts'&&req.method==='POST')return send(res,await artifacts.create(pid,await readBody()),201);
    const art=/^\/artifacts\/([^/]+)\/(start|persist|stop|status|snapshot|restore|annotations)$/.exec(tail);if(art){const aid=art[1],action=art[2];if(action==='status')return send(res,await artifacts.status(pid,aid,parentOrigin,origin));if(req.method!=='POST')throw httpError('需要 POST',405);if(action==='start')return send(res,await artifacts.start(pid,aid,parentOrigin,origin));if(action==='persist')return send(res,await artifacts.persist(pid,aid,parentOrigin,origin));if(action==='stop'){await artifacts.halt(pid,aid);return send(res,{running:false});}if(action==='snapshot')return send(res,await artifacts.snapshot(pid,aid));if(action==='restore')return send(res,await artifacts.restore(pid,aid,(await readBody()).snapshotId));if(action==='annotations'){const input=await readBody();if(input.hostId&&input.hostId!==hostId)throw httpError('Select this web server for Artifact comments',409);await artifacts.lookup(pid,aid);if(!input.text?.trim()||!input.requestId)throw httpError('需要批注文本及 requestId');let annotation=state.annotations.find(a=>a.requestId===input.requestId);if(!annotation){const annotationId=randomUUID();const anchor=await saveAnchorEvidence(project,annotationId,input.anchor||{});annotation={id:annotationId,requestId:input.requestId,artifactId:aid,text:input.text.trim(),anchor,anchorStatus:'attached',status:'open',createdAt:new Date().toISOString()};await store.mutate(pid,'annotation.created',s=>{if(!s.annotations.some(a=>a.requestId===input.requestId))s.annotations.push(annotation);else annotation=s.annotations.find(a=>a.requestId===input.requestId);});}const run=await queue.submit(pid,{...input,artifactId:aid,annotationId:annotation.id,queueId:'artifact:'+aid,hostId});return send(res,{annotation,run},201);}}
    const evidence=/^\/annotations\/([^/]+)\/evidence$/.exec(tail);if(evidence&&req.method==='GET'&&artifactHostOf(project)&&artifactHostOf(project)!==hostId&&!req.headers['x-studio-hop'])return hosts.proxy(await filesOnline(artifactHostOf(project),origin),req,res,pathname);if(evidence&&req.method==='GET'){const annotation=state.annotations.find(a=>a.id===evidence[1]);if(!annotation)throw httpError('批注不存在',404);return sendImage(res,await readAnchorEvidence(project,annotation));}
    const ann=/^\/annotations\/([^/]+)$/.exec(tail);if(ann&&req.method==='PATCH'){const input=await readBody();let result;await store.mutate(pid,'annotation.updated',s=>{const a=s.annotations.find(a=>a.id===ann[1]);if(!a)throw httpError('批注不存在',404);if(input.status){if(!['open','resolved'].includes(input.status))throw httpError('无效状态');a.status=input.status;}if(input.anchorStatus){if(!['attached','orphaned','unlocated'].includes(input.anchorStatus))throw httpError('无效锚点状态');a.anchorStatus=input.anchorStatus;}result=a;});
      // A resolved thread with nothing left to run closes its agent process; a later reply resumes its native session.
      if(result.status==='resolved'&&!(await store.read(pid)).runs.some(r=>r.annotationId===result.id&&['queued','running','waiting'].includes(r.status)))await runner.release?.(`${pid}:artifact:${result.artifactId}:${result.id}:`);
      return send(res,result);}
    throw httpError('接口不存在',404);
  }
  const server=http.createServer((req,res)=>handler(req,res).catch(e=>{if(!res.headersSent)send(res,{error:e.message,...(e.status&&typeof e.code==='string'?{code:e.code}:{})},e.status||400);else res.end();}));const port=options.port??Number(process.env.STUDIO_PORT||DEFAULT_PORT);try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,bind,resolve)});if(tailnet)await tailnet.forwarder.expose(server.address().port);await queue.init();artifacts.resumePersistent().catch(error=>console.error('常驻 Artifact 恢复失败：',error.message));}catch(error){unsubscribe();await queue.close();await artifacts.close();if(server.listening)await new Promise(r=>server.close(r));throw error;}
  let syncing=false,syncWork=Promise.resolve();const syncTimer=setInterval(()=>{if(syncing)return;syncing=true;syncWork=(async()=>{try{await purger.reconcile().catch(e=>{purger.lastError=e.message;});const peers=(await hosts.online(`http://${bind}:${server.address().port}`)).filter(h=>!h.local);if(!peers.length)return;for(const h of peers)try{await hosts.syncIndex(peerIndex,h);}catch(e){hosts.lastSyncError=e.message;}const ids=await store.projectIds();for(const h of peers)for(const id of ids)try{await hosts.sync(store,h,id);}catch(e){hosts.lastSyncError=e.message;}}catch(e){hosts.lastSyncError=e.message;}finally{syncing=false;}})();},3000);syncTimer.unref();
  // Projects soft-deleted before hard deletion existed are removed once, after startup.
  const legacyPurge=purger.reconcile({legacy:true}).catch(e=>{purger.lastError=e.message;console.error('Project purge failed: '+e.message);});
  return {server,store,queue,artifacts,purger,legacyPurge,hosts,hostId,port:server.address().port,stateDir,async close(){clearInterval(syncTimer);for(const timer of editCommits.values())clearTimeout(timer);await syncWork;await legacyPurge;unsubscribe();accountAuth.close?.();login.close?.();for(const res of clients)res.end();const shutdown=await queue.close();if(shutdown?.pendingCancellation)console.error(shutdown.error);await artifacts.close();await store.flushAll?.();await devices?.close();await new Promise(r=>server.close(r));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const app=await createStudio();console.log(`Studio: http://${process.env.STUDIO_BIND||'127.0.0.1'}:${app.port}`);let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await app.close();process.exit(0)});}
