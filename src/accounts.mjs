import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {writeJson,httpError} from './paths.mjs';

// Machine-local registry of CLI accounts. Each account owns a configuration directory under
// STUDIO_STATE_DIR/accounts/<id>, used as CLAUDE_CONFIG_DIR or CODEX_HOME, so sign-ins never
// touch the user's own ~/.claude or ~/.codex and several accounts of one family coexist.
// Only labels, identity and model lists are stored here; credentials stay in the CLI's files
// (or the api-key file inside the account directory). Nothing in this registry is synchronized.
export const FAMILIES=Object.freeze({
  claude:{label:'Claude Code',auths:['oauth','api_key'],home:'.claude',dirEnv:'CLAUDE_CONFIG_DIR',command:'claude',credentialFiles:['.credentials.json'],copy:['settings.json','CLAUDE.md'],link:['skills','plugins','agents','commands','output-styles','hooks']},
  codex:{label:'Codex',auths:['chatgpt','api_key'],home:'.codex',dirEnv:'CODEX_HOME',command:'codex',credentialFiles:['auth.json'],copy:['config.toml','AGENTS.md'],link:['skills','prompts','plugins']},
});
const now=()=>new Date().toISOString();
const PUBLIC_FIELDS=['id','label','labelAuto','family','auth','createdAt','status','identity','models','modelsCheckedAt','commands','lastError','seed'];

export class Accounts {
  constructor({stateDir,homedir=os.homedir()}){
    this.stateDir=stateDir;this.homedir=homedir;this.file=path.join(stateDir,'accounts.json');this.root=path.join(stateDir,'accounts');
    this.loaded=null;this.version=0;
  }
  async load(){
    if(this.loaded)return this.loaded;
    try{const data=JSON.parse(await fs.readFile(this.file,'utf8'));this.loaded=Array.isArray(data?.accounts)?data.accounts:[];}
    catch(e){if(e.code!=='ENOENT')throw new Error('Invalid machine-local accounts.json: '+e.message);this.loaded=[];}
    return this.loaded;
  }
  async save(){await writeJson(this.file,{version:1,accounts:this.loaded});this.version++;}
  async list(){return (await this.load()).map(a=>this.view(a));}
  async get(id){const a=(await this.load()).find(a=>a.id===id);if(!a)throw httpError('account_not_found',404);return this.view(a);}
  async has(id){return (await this.load()).some(a=>a.id===id);}
  view(a){return structuredClone(Object.fromEntries(PUBLIC_FIELDS.filter(k=>a[k]!==undefined).map(k=>[k,a[k]])));}
  dir(id){return path.join(this.root,id);}
  keyFile(id){return path.join(this.dir(id),'api-key');}

  async create({family,auth,label}={}){
    const spec=FAMILIES[family];
    if(!spec)throw httpError('family_invalid',400);
    if(!spec.auths.includes(auth))throw httpError('auth_invalid',400);
    label=typeof label==='string'?label.trim():'';
    if(label.length>60||/[\r\n\x00-\x1f]/.test(label))throw httpError('label_invalid',400);
    const accounts=await this.load();
    const id='acc_'+randomBytes(4).toString('hex');
    // An automatic label ("Claude 2") is replaced by the account's e-mail once it signs in,
    // so the web shows who is talking; a label the user typed is kept.
    const labelAuto=!label;
    if(!label){const n=accounts.filter(a=>a.family===family).reduce((max,a)=>Math.max(max,Number(/^(?:Claude|Codex) (\d+)$/.exec(a.label)?.[1]||0)),0)+1;label=`${family==='claude'?'Claude':'Codex'} ${n}`;}
    const account={id,label,labelAuto,family,auth,createdAt:now(),status:'signed_out',identity:null,models:null,modelsCheckedAt:null,commands:null,lastError:null};
    await fs.mkdir(this.dir(id),{recursive:true,mode:0o700});
    account.seed=await this.seed(account);
    accounts.push(account);await this.save();
    return this.view(account);
  }
  async update(id,patch){
    const account=(await this.load()).find(a=>a.id===id);
    if(!account)throw httpError('account_not_found',404);
    for(const [key,value] of Object.entries(patch)){
      if(key==='label'){if(typeof value!=='string'||!value.trim()||value.trim().length>60||/[\r\n\x00-\x1f]/.test(value))throw httpError('label_invalid',400);account.label=value.trim();account.labelAuto=patch.labelAuto===true;}
      else if(['status','identity','models','modelsCheckedAt','commands','lastError'].includes(key))account[key]=value;
    }
    await this.save();return this.view(account);
  }
  async remove(id){
    const accounts=await this.load(),index=accounts.findIndex(a=>a.id===id);
    if(index<0)throw httpError('account_not_found',404);
    accounts.splice(index,1);await this.save();
    await fs.rm(this.dir(id),{recursive:true,force:true});
  }
  // The key file feeds the account's environment, so writing or removing it changes the
  // runner configuration: bump the version so cached configurations are rebuilt.
  async writeKey(id,key){
    await fs.mkdir(this.dir(id),{recursive:true,mode:0o700});await fs.writeFile(this.keyFile(id),key,{mode:0o600});
    const account=(await this.load()).find(a=>a.id===id);
    // Claude Code asks once whether an ANTHROPIC_API_KEY may be used and remembers the key's
    // last 20 characters; record that approval so the CLI never waits for a prompt it cannot show.
    if(account?.family==='claude'){
      const file=path.join(this.dir(id),'.claude.json');let json={};
      try{json=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
      const responses=json.customApiKeyResponses&&typeof json.customApiKeyResponses==='object'?json.customApiKeyResponses:{};
      const approved=Array.isArray(responses.approved)?responses.approved:[];const suffix=key.slice(-20);
      json.customApiKeyResponses={...responses,approved:approved.includes(suffix)?approved:[...approved,suffix],rejected:(Array.isArray(responses.rejected)?responses.rejected:[]).filter(s=>s!==suffix)};
      json.hasCompletedOnboarding=true;
      await fs.writeFile(file,JSON.stringify(json,null,2),{mode:0o600});
    }
    this.version++;
  }
  async readKey(id){try{return (await fs.readFile(this.keyFile(id),'utf8')).trim()||null;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async removeKey(id){
    const key=await this.readKey(id);
    await fs.rm(this.keyFile(id),{force:true});
    if(key){
      // Forget the approval recorded for this key as well.
      const file=path.join(this.dir(id),'.claude.json');
      try{const json=JSON.parse(await fs.readFile(file,'utf8'));const responses=json.customApiKeyResponses;if(Array.isArray(responses?.approved)){responses.approved=responses.approved.filter(s=>s!==key.slice(-20));await fs.writeFile(file,JSON.stringify(json,null,2),{mode:0o600});}}catch{}
    }
    this.version++;
  }
  async removeCredentials(id){
    const account=(await this.load()).find(a=>a.id===id);if(!account)return;
    for(const file of FAMILIES[account.family].credentialFiles)await fs.rm(path.join(this.dir(id),file),{force:true});
    if(account.auth==='api_key')await this.removeKey(id);
  }

  // Process environment for this account's CLI. The platform token never reaches a CLI, and
  // ambient provider keys are dropped so an account only ever uses its own credentials.
  async env(account,base={}){
    const env={...base};
    delete env.STUDIO_TOKEN;delete env.ANTHROPIC_API_KEY;delete env.OPENAI_API_KEY;delete env.CLAUDE_CODE_OAUTH_TOKEN;delete env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN;
    env[FAMILIES[account.family].dirEnv]=this.dir(account.id);
    if(account.family==='claude'&&account.auth==='api_key'){const key=await this.readKey(account.id);if(key)env.ANTHROPIC_API_KEY=key;}
    return env;
  }

  // Seed the account directory from the user's default CLI directory so the agent keeps the
  // same skills, plugins, settings and MCP servers as the terminal. Directories are linked
  // (junctions on Windows) so later changes stay shared; files are copied once. Credentials and
  // onboarding state are never copied. Best effort: a missing source is simply skipped.
  async seed(account){
    const spec=FAMILIES[account.family],source=path.join(this.homedir,spec.home),target=this.dir(account.id),result={from:source,copied:[],linked:[],skipped:[]};
    try{await fs.access(source);}catch{return {...result,skipped:['(default directory not found)']};}
    for(const name of spec.copy){
      try{await fs.copyFile(path.join(source,name),path.join(target,name),fs.constants.COPYFILE_EXCL);result.copied.push(name);}
      catch(e){if(e.code!=='ENOENT'&&e.code!=='EEXIST')result.skipped.push(`${name}: ${e.code||e.message}`);}
    }
    for(const name of spec.link){
      const from=path.join(source,name),to=path.join(target,name);
      try{if(!(await fs.stat(from)).isDirectory())continue;}catch{continue;}
      try{await fs.symlink(from,to,process.platform==='win32'?'junction':'dir');result.linked.push(name);}
      catch(e){if(e.code!=='EEXIST')result.skipped.push(`${name}: ${e.code||e.message}`);}
    }
    if(account.family==='claude'){
      // MCP servers live in .claude.json; onboarding is marked done so the CLI never prompts.
      let mcpServers={};
      try{const json=JSON.parse(await fs.readFile(path.join(source,'.claude.json'),'utf8'));if(json&&typeof json.mcpServers==='object')mcpServers=json.mcpServers;}catch{}
      try{await fs.writeFile(path.join(target,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,mcpServers},null,2),{flag:'wx',mode:0o600});result.copied.push('.claude.json (mcpServers only)');}catch(e){if(e.code!=='EEXIST')result.skipped.push('.claude.json: '+(e.code||e.message));}
    }
    return result;
  }
}
