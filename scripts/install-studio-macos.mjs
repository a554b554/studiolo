// Run with Node on the Mac that will host Studio. All configuration stays local.
// Installs the login service net.studiolo.server on 4310/4311; pass
// --label/--port/--preview-port for another instance, e.g. a dev one on 4410/4411.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {DEFAULT_PORT,DEFAULT_PREVIEW_PORT,defaultStateDir} from '../src/defaults.mjs';
if(process.platform!=='darwin')throw new Error('This installer is for macOS');
const {values:opts}=parseArgs({options:{label:{type:'string',default:'net.studiolo.server'},port:{type:'string',default:String(DEFAULT_PORT)},'preview-port':{type:'string',default:String(DEFAULT_PREVIEW_PORT)},path:{type:'string'}}});
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const state=defaultStateDir();await fs.mkdir(state,{recursive:true,mode:0o700});
const tailscale='/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const status=JSON.parse(execFileSync(tailscale,['status','--json'],{encoding:'utf8',env:{...process.env,TAILSCALE_BE_CLI:'1'}}));
if(status.BackendState!=='Running')throw new Error('Connect Tailscale first');
const config=path.join(state,'tailnet.json');
try{const old=JSON.parse(await fs.readFile(config,'utf8'));if(!old.trustTailnet)throw new Error('Existing access policy preserved; configure trusted tailnet access explicitly before installing');}catch(e){if(e.code!=='ENOENT')throw e;await fs.writeFile(config,JSON.stringify({enabled:true,trustTailnet:true,command:tailscale},null,2),{mode:0o600});}
const escape=x=>x.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const label=opts.label,domain=`gui/${process.getuid()}`;
const plist=path.join(os.homedir(),'Library','LaunchAgents',label+'.plist');await fs.mkdir(path.dirname(plist),{recursive:true});
const values={Label:label,WorkingDirectory:root,StandardOutPath:path.join(state,'server.stdout.log'),StandardErrorPath:path.join(state,'server.stderr.log')};
// The native Claude installer puts `claude` in ~/.local/bin, which an SSH or launchd PATH lacks.
const searchPath=[...new Set([path.join(os.homedir(),'.local','bin'),...(opts.path||process.env.PATH||'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin').split(':')])].filter(Boolean).join(':');
const env={PATH:searchPath,STUDIO_STATE_DIR:state,STUDIO_PORT:opts.port,STUDIO_PREVIEW_PORT:opts['preview-port']};
const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${Object.entries(values).map(([k,v])=>`<key>${k}</key><string>${escape(v)}</string>`).join('\n')}\n<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(path.join(root,'src/server.mjs'))}</string></array>\n<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v])=>`<key>${k}</key><string>${escape(v)}</string>`).join('')}</dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>\n</dict></plist>\n`;
await fs.writeFile(plist,xml,{mode:0o600});
// A loaded agent keeps its old plist until it is booted out, so reload it to apply the new one.
try{execFileSync('launchctl',['print',domain+'/'+label],{stdio:'ignore'});execFileSync('launchctl',['bootout',domain+'/'+label]);console.log('Reloading the existing login service with the new configuration.');}catch{}
execFileSync('launchctl',['bootstrap',domain,plist]);
console.log(`Studio login service ${label} installed. URL: http://${status.Self.DNSName.replace(/\.$/,'')}:${opts.port}`);
