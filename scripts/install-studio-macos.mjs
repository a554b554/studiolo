// Run with Node on the Mac that will host Studio. All configuration stays local.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
if(process.platform!=='darwin')throw new Error('This installer is for macOS');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const state=path.join(os.homedir(),'.studio-local');await fs.mkdir(state,{recursive:true});
const tailscale='/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const status=JSON.parse(execFileSync(tailscale,['status','--json'],{encoding:'utf8',env:{...process.env,TAILSCALE_BE_CLI:'1'}}));
if(status.BackendState!=='Running')throw new Error('Connect Tailscale first');
const config=path.join(state,'tailnet.json');
try{const old=JSON.parse(await fs.readFile(config,'utf8'));if(!old.trustTailnet)throw new Error('Existing access policy preserved; configure trusted tailnet access explicitly before installing');}catch(e){if(e.code!=='ENOENT')throw e;await fs.writeFile(config,JSON.stringify({enabled:true,trustTailnet:true,command:tailscale},null,2),{mode:0o600});}
const escape=x=>x.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const label='net.studio-local.server',domain=`gui/${process.getuid()}`;
const plist=path.join(os.homedir(),'Library','LaunchAgents',label+'.plist');await fs.mkdir(path.dirname(plist),{recursive:true});
const values={Label:label,WorkingDirectory:root,StandardOutPath:path.join(state,'server.stdout.log'),StandardErrorPath:path.join(state,'server.stderr.log')};
const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${Object.entries(values).map(([k,v])=>`<key>${k}</key><string>${escape(v)}</string>`).join('\n')}\n<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(path.join(root,'src/server.mjs'))}</string></array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(process.env.PATH||'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')}</string><key>STUDIO_STATE_DIR</key><string>${escape(state)}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>\n</dict></plist>\n`;
await fs.writeFile(plist,xml,{mode:0o600});
try{execFileSync('launchctl',['print',domain+'/'+label],{stdio:'ignore'});console.log('Login service already loaded; configuration saved. Restart with launchctl kickstart -k '+domain+'/'+label);}catch{execFileSync('launchctl',['bootstrap',domain,plist]);}
console.log(`Studio login service installed. URL: http://${status.Self.DNSName.replace(/\.$/,'')}:4310`);
