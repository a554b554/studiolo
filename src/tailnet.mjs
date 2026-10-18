import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

// Machine-local opt-in. Never sync credentials or overwrite another Serve endpoint.
export async function loadTailnet(stateDir) {
  let config;
  try { config=JSON.parse(await fs.readFile(path.join(stateDir,'tailnet.json'),'utf8')); }
  catch(e) { if(e.code==='ENOENT')return null; throw new Error('Cannot read tailnet.json: '+e.message); }
  if(!config.enabled)return null;
  const forwarder=new TailnetForwarder({command:config.command});
  if(config.trustTailnet===true){
    const status=JSON.parse(await forwarder.run(['status','--json']));
    if(status.BackendState!=='Running'||!status.Self?.DNSName)throw new Error('Tailscale must be connected before starting trusted tailnet access');
    const dns=status.Self.DNSName.replace(/\.$/,'').toLowerCase();
    const trustedHosts=new Set([dns,dns.split('.')[0],...(status.Self.TailscaleIPs||[]).map(ip=>ip.includes(':')?`[${ip}]`:ip)]);
    return {token:'',trustedHosts,forwarder,dnsName:dns,name:status.Self.HostName};
  }
  const token=(await fs.readFile(path.join(stateDir,'access-token.txt'),'utf8')).trim();
  if(token.length<32)throw new Error('Tailnet access token must contain at least 32 characters');
  return {token,forwarder};
}

export class TailnetForwarder {
  constructor({command='tailscale',run}={}) {
    this.run=run || (async args=>(await execute(command,args,{windowsHide:true,timeout:15000,maxBuffer:1024*1024,env:{...process.env,TAILSCALE_BE_CLI:'1'}})).stdout);
    this.tail=Promise.resolve();
  }
  async expose(port) {
    if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid tailnet port');
    const work=this.tail.catch(()=>{}).then(async()=>{
      const config=JSON.parse(await this.run(['serve','status','--json']));
      const target=`127.0.0.1:${port}`,existing=config.TCP?.[port];
      if(Object.keys(config.AllowFunnel||{}).some(key=>key.endsWith(`:${port}`)&&config.AllowFunnel[key]))throw new Error(`Port ${port} has public Funnel enabled; refusing to use it`);
      if(existing){
        if(existing.TCPForward===target&&!existing.TerminateTLS)return;
        throw new Error(`Tailscale port ${port} belongs to another service; existing configuration was preserved`);
      }
      await this.run(['serve','--bg',`--tcp=${port}`,`tcp://${target}`]);
      const verified=JSON.parse(await this.run(['serve','status','--json']));
      if(verified.TCP?.[port]?.TCPForward!==target)throw new Error(`Tailscale forwarding verification failed for ${port}`);
    });
    this.tail=work;return work;
  }
}
