import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {writeJson} from './paths.mjs';

// "Play persistent": an Artifact runs as its own server, outside Studiolo, until someone stops it.
// It keeps running when Studiolo closes or restarts, and any program on this computer can use it at
// 127.0.0.1:<port>. Whether other computers can reach it is the Artifact's own choice (`persistent` in
// studio.artifacts.json): `host` is the address it listens on, `tailnet: true` asks this computer's
// Tailscale to forward the port (that forward lives in tailscaled, not in Studiolo), and `urls` lists any
// address the Artifact provides itself. persistent-artifacts.json in the state directory remembers what
// is running; after a reboot Studiolo starts those again the next time it starts.
const here=path.dirname(fileURLToPath(import.meta.url));
const execute=(file,args)=>new Promise(resolve=>execFile(file,args,{windowsHide:true,timeout:10000},(error,stdout)=>resolve(error?'':stdout)));
const bootAt=()=>Date.now()-os.uptime()*1000;
const imageName=value=>path.basename(String(value||'')).toLowerCase().replace(/\.exe$/,'');
async function processImage(pid){
  if(process.platform==='win32'){const line=(await execute('tasklist',['/FI',`PID eq ${pid}`,'/FO','CSV','/NH'])).trim();const match=/^"([^"]+)","(\d+)"/.exec(line);return match&&Number(match[2])===pid?imageName(match[1]):null;}
  return imageName((await execute('ps',['-o','comm=','-p',String(pid)])).trim())||null;
}
const listening=port=>new Promise(resolve=>{const socket=net.connect(port,'127.0.0.1');socket.setTimeout(400);const done=value=>{socket.destroy();resolve(value)};socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.once('timeout',()=>done(false));});
const freePort=()=>new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address();probe.close(()=>resolve(port));});});

export class PersistentArtifacts {
  constructor({stateDir,forwarder,tailnetName}){Object.assign(this,{stateDir,forwarder,tailnetName});this.file=stateDir&&path.join(stateDir,'persistent-artifacts.json');this.data={running:{},ports:{}};this.checked=new Map();this.writes=Promise.resolve();}
  async load(){if(!this.file)return;try{const data=JSON.parse(await fs.readFile(this.file,'utf8'));this.data={running:data.running||{},ports:data.ports||{}};}catch(error){if(error.code!=='ENOENT')throw error;}}
  save(){if(!this.file)return Promise.resolve();this.writes=this.writes.catch(()=>{}).then(()=>writeJson(this.file,this.data));return this.writes;}
  record(key){return this.data.running[key];}
  logFile(key){return path.join(this.stateDir||os.tmpdir(),'persistent-logs',createHash('sha256').update(key).digest('hex').slice(0,24)+'.log');}
  // A record names a live process only if this boot started it and the pid still runs the same program;
  // a pid reused by something else after a crash or a reboot is never mistaken for the Artifact.
  async alive(record){if(!record?.pid||Math.abs(bootAt()-record.bootAt)>120000)return false;const cached=this.checked.get(record.pid);if(cached&&Date.now()-cached.at<4000)return cached.alive;const image=await processImage(record.pid);const alive=Boolean(image)&&(image.startsWith(record.image)||record.image.startsWith(image));this.checked.set(record.pid,{at:Date.now(),alive});return alive;}
  async status(key){const record=this.record(key);if(!record)return null;const alive=await this.alive(record);const log=await fs.readFile(record.log,'utf8').then(text=>text.slice(-8000)).catch(()=>'');return {running:alive,listening:alive&&await listening(record.port),port:record.port,host:record.host,startedAt:record.startedAt,urls:this.urls(record),tailnet:record.tailnet||false,tailnetError:record.tailnetError||null,error:alive?null:record.error||'常驻进程已退出',log};}
  urls(record){const entry='/'+(record.entry||'').split('/').map(encodeURIComponent).join('/');const list=[{kind:'local',url:`http://127.0.0.1:${record.port}${entry}`}];if(record.tailnet&&this.tailnetName&&!record.tailnetError)list.push({kind:'tailnet',url:`http://${this.tailnetName}:${record.port}${entry}`});if(!['127.0.0.1','localhost','::1'].includes(record.host))list.push({kind:'network',url:`http://${os.hostname().toLowerCase()}:${record.port}${entry}`});for(const url of record.extraUrls||[])list.push({kind:'artifact',url});return list;}
  async port(key,artifact,reserved){const wanted=artifact.persistent?.port||(artifact.command?artifact.port:null)||this.data.ports[key];const port=wanted||await freePort();if(reserved.includes(port))throw new Error('常驻端口与平台端口冲突');if(!artifact.command&&!artifact.persistent?.port&&this.data.ports[key]!==port){this.data.ports[key]=port;await this.save();}return port;}
  async start({key,projectId,artifactId,artifact,root,env,reserved}){
    const port=await this.port(key,artifact,reserved);if(await listening(port))throw new Error(`常驻端口 ${port} 已被占用`);
    const host=artifact.persistent?.host||'127.0.0.1',log=this.logFile(key);
    const command=artifact.command?[...artifact.command]:[process.execPath,path.join(here,'artifact-serve.mjs'),root,artifact.entry];if(command[0]==='node')command[0]=process.execPath;
    await fs.mkdir(path.dirname(log),{recursive:true});await fs.writeFile(log,`[${new Date().toISOString()}] ${command.join(' ')}\n`);
    const pid=await new Promise((resolve,reject)=>{const launcher=spawn(process.execPath,[path.join(here,'persistent-launch.mjs'),JSON.stringify({command,cwd:root,log})],{env:{...env,PORT:String(port),HOST:host,STUDIO_PERSISTENT:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});let output='';const timer=setTimeout(()=>reject(new Error('常驻启动器无响应')),10000);launcher.once('error',error=>{clearTimeout(timer);reject(error)});launcher.stderr.on('data',chunk=>{output+=chunk});launcher.stdout.on('data',chunk=>{output+=chunk;const match=/\{[^}]*\}/.exec(output);if(!match)return;clearTimeout(timer);const result=JSON.parse(match[0]);if(result.pid)resolve(result.pid);else reject(new Error(result.error||'常驻进程未能启动'));});launcher.once('exit',code=>{if(code){clearTimeout(timer);reject(new Error(output.trim()||'常驻启动器退出：'+code));}});});
    const record={projectId,artifactId,pid,image:imageName(command[0]),port,host,entry:artifact.command?'':artifact.entry,startedAt:new Date().toISOString(),bootAt:bootAt(),log,tailnet:Boolean(artifact.persistent?.tailnet),extraUrls:artifact.persistent?.urls||[]};
    this.data.running[key]=record;this.checked.delete(pid);await this.save();
    const deadline=Date.now()+15000;while(!(await listening(port))){this.checked.delete(pid);if(!(await this.alive(record))){const tail=await fs.readFile(log,'utf8').catch(()=>'');delete this.data.running[key];await this.save();throw new Error('常驻进程已退出：'+tail.trim().split('\n').slice(-3).join(' '));}if(Date.now()>deadline){await this.stop(key);throw new Error('常驻 Artifact 启动超时，请检查日志或启动命令');}await new Promise(r=>setTimeout(r,150));}
    if(record.tailnet){if(!this.forwarder)record.tailnetError='这台电脑没有启用 Tailscale 转发';else{try{await this.forwarder.expose(port);}catch(error){record.tailnetError=error.message;}}await this.save();}
    return record;
  }
  async stop(key){
    const record=this.record(key);if(!record)return false;
    if(await this.alive(record)){if(process.platform==='win32')await execute('taskkill',['/PID',String(record.pid),'/T','/F']);else{try{process.kill(-record.pid,'SIGTERM')}catch{}const deadline=Date.now()+3000;while(Date.now()<deadline&&await listening(record.port))await new Promise(r=>setTimeout(r,100));try{process.kill(-record.pid,'SIGKILL')}catch{}}}
    if(record.tailnet&&!record.tailnetError)await this.forwarder?.unexpose?.(record.port).catch(()=>{});
    this.checked.delete(record.pid);delete this.data.running[key];await this.save();return true;
  }
  forget(prefix){for(const key of Object.keys(this.data.ports))if(key.startsWith(prefix))delete this.data.ports[key];return this.save();}
  // Records whose process is gone although nobody stopped them (a reboot, a crash), for Studiolo to restart.
  async stale(){const stale=[];for(const [key,record] of Object.entries(this.data.running))if(!(await this.alive(record)))stale.push({key,record});return stale;}
}
