#!/usr/bin/env node
// One-shot subagent launcher for the accounts signed in to Studiolo on this machine.
// Agents running inside Studiolo conversations call it to delegate to another account (Claude Code
// or Codex); the platform tells them how in the prompt section built by src/subagents.mjs. It can
// also be used by hand. Credentials stay in the account directories; nothing is printed but the
// subagent's answer (stdout) and a one-line summary (stderr).
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Accounts} from '../src/accounts.mjs';
import {CliRunner} from '../src/runner.mjs';
import {AccountUsage} from '../src/account-usage.mjs';
import {SubagentPolicy,accountLine} from '../src/subagents.mjs';
import {supportsAuto} from '../public/model-permissions.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const USAGE=`Usage:
  node subagent.mjs --list [--no-quota] [--json]
  node subagent.mjs --account <label|id> --model <model id> [options] "<task>"   (or the task on stdin, or "-")
Options:
  --effort <low|medium|high|xhigh|max>   reasoning effort (model-dependent)
  --permissions <auto|project-write|read-only|default>
                     default: auto when the model supports it, otherwise project-write
  --cwd <dir>        working directory of the subagent (default: current directory)
  --timeout <sec>    abort after this many seconds (default 1800)
  --json             print {account, model, permissions, status, text, error, usage} instead of the plain answer
  --verbose          stream the subagent's tool activity to stderr
  --state-dir <dir>  Studiolo state directory (default: STUDIO_STATE_DIR or ~/.studio-local)
Exit codes: 0 finished · 1 failed · 2 bad arguments · 3 stopped at a permission it could not ask about`;
const FLAGS=new Set(['list','no-quota','json','verbose','help']);
const VALUES=new Set(['account','model','effort','permissions','cwd','timeout','state-dir','settings']);

function fail(message,code=2){process.stderr.write(`subagent: ${message}\n${code===2?USAGE+'\n':''}`);process.exit(code);}
function parse(argv){
  const opts={task:[]};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--'){opts.task.push(...argv.slice(i+1));break;}
    if(arg==='-'){opts.stdin=true;continue;}
    const m=/^--([a-z-]+)(?:=([\s\S]*))?$/.exec(arg);
    if(!m){opts.task.push(arg);continue;}
    const [,key,inline]=m;
    if(FLAGS.has(key)){if(inline!==undefined)fail(`--${key} takes no value`);opts[key]=true;continue;}
    if(!VALUES.has(key))fail(`Unknown option --${key}`);
    const value=inline!==undefined?inline:argv[++i];
    if(value===undefined)fail(`--${key} needs a value`);
    opts[key]=value;
  }
  return opts;
}
const clip=(text,n=400)=>{text=String(text??'').replace(/\s+/g,' ').trim();return text.length>n?text.slice(0,n)+'…':text;};
const log=line=>process.stderr.write(line+'\n');

async function list(runner,policy,opts){
  const profiles=await runner.profiles();
  const usage=opts['no-quota']?null:await new AccountUsage({runner}).get();
  const rules=(await policy.get()).rules;
  if(opts.json){process.stdout.write(JSON.stringify({accounts:profiles.map(p=>({...p,usage:usage?.accounts.find(u=>u.id===p.id)||null})),rules},null,2)+'\n');return 0;}
  const lines=profiles.map(p=>accountLine(p,usage?.accounts.find(u=>u.id===p.id))+(p.available===false?`   [unavailable: ${p.error}]`:''));
  process.stdout.write(['Accounts on this machine (label · id · CLI · plan · quota · models):',...(lines.length?lines:['- none']),'','Routing rules:',rules].join('\n')+'\n');
  return 0;
}

async function main(){
  const opts=parse(process.argv.slice(2));
  if(opts.help){process.stdout.write(USAGE+'\n');return 0;}
  const stateDir=opts['state-dir']||process.env.STUDIO_STATE_DIR||path.join(os.homedir(),'.studio-local');
  const accounts=new Accounts({stateDir});
  const runner=new CliRunner({stateDir,hostId:'subagent',accounts});
  const policy=new SubagentPolicy({file:opts.settings||process.env.STUDIO_SETTINGS_FILE||path.resolve(here,'../projects/.studio-settings.json')});
  if(opts.list)return list(runner,policy,opts);
  if(!opts.account)fail('--account is required (label or id); --list shows the accounts');
  const configs=Object.values(await runner.configuration());
  const needle=opts.account.trim().toLowerCase();
  const exact=configs.filter(c=>c.id.toLowerCase()===needle||String(c.label||'').toLowerCase()===needle);
  const found=exact.length?exact:configs.filter(c=>String(c.label||'').toLowerCase().includes(needle)||c.id.toLowerCase().includes(needle));
  if(found.length!==1)fail(found.length?`Account "${opts.account}" is ambiguous: ${found.map(c=>c.label).join(', ')}`:`No account "${opts.account}" on this machine. Accounts: ${configs.map(c=>`${c.label} (${c.id})`).join(', ')||'none'}`);
  const account=found[0];
  if(account.status==='signed_out')fail(`${account.label} is signed out`,1);
  if(!account.command)fail(`${account.label}: ${account.family} executable not found`,1);
  const models=account.models||[];
  if(!models.length)fail(`${account.label} has no models`,1);
  let model;
  if(opts.model){
    const m=opts.model.trim().toLowerCase();
    model=models.find(x=>x.id.toLowerCase()===m)||models.find(x=>x.id.toLowerCase().includes(m)||String(x.label||'').toLowerCase().includes(m));
    if(!model)fail(`Model "${opts.model}" is not available for ${account.label}. Models: ${models.map(x=>x.id).join(', ')}`);
  }else if(models.length===1)model=models[0];
  else fail(`--model is required for ${account.label}. Models: ${models.map(x=>x.id).join(', ')}`);
  const permissionMode=opts.permissions||(supportsAuto(account.family,model.id)?'auto':'project-write');
  if(!['auto','default','read-only','project-write'].includes(permissionMode))fail('--permissions must be auto, project-write, read-only or default');
  if(permissionMode==='auto'&&!supportsAuto(account.family,model.id))fail(`${model.id} does not support --permissions auto; use project-write or read-only`);
  if(opts.effort&&!(model.efforts||[]).includes(opts.effort))fail(`Effort "${opts.effort}" is not available for ${model.id}${model.efforts?.length?`; choose ${model.efforts.join(', ')}`:''}`);
  const cwd=path.resolve(opts.cwd||process.cwd());
  const timeout=Number(opts.timeout??1800);
  if(!Number.isFinite(timeout)||timeout<=0)fail('--timeout must be a positive number of seconds');
  let prompt=opts.task.join(' ').trim();
  if(opts.stdin||(!prompt&&!process.stdin.isTTY)){let input='';for await(const chunk of process.stdin)input+=chunk;if(input.trim())prompt=[prompt,input.trim()].filter(Boolean).join('\n');}
  if(!prompt)fail('A task is required: pass it as the last argument or on stdin');

  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeout*1000);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>controller.abort());
  const started=Date.now();
  let result;
  try{
    result=await runner.execute({cwd,prompt,profileId:account.id,model:model.id,reasoningEffort:opts.effort||undefined,permissionMode,signal:controller.signal,onEvent:e=>{if(opts.verbose&&e.type!=='text')log(`[${e.type}] ${clip(e.text)}`);}});
  }catch(e){
    clearTimeout(timer);
    const seconds=Math.round((Date.now()-started)/1000);
    // A signed-in account that reports "Not logged in" means the CLI could not reach its credentials
    // (macOS Keychain or the account directory), which happens inside command sandboxes such as Codex's.
    const hint=/not logged in|please run \/login|invalid api key|authentication/i.test(e.message)?'\nHint: this account is signed in on this machine. If you are running inside a command sandbox (for example Codex\'s), the CLI cannot reach its credentials or the network; rerun this launcher outside the sandbox (request escalated permissions / run without the sandbox).':'';
    fail(`${account.label} · ${model.id}: ${controller.signal.aborted?`aborted after ${seconds} s (timeout ${timeout} s or signal)`:e.message}${hint}`,1);
  }
  clearTimeout(timer);
  const status=result.status||'succeeded';
  const turn=result.usage?.turn||result.usage?.sessionTotal||null;
  const text=result.text||'';
  if(opts.json)process.stdout.write(JSON.stringify({account:{id:account.id,label:account.label,family:account.family},model:result.model||model.id,permissions:permissionMode,status,text,error:result.error||null,usage:result.usage||null},null,2)+'\n');
  else process.stdout.write(text+(text&&!text.endsWith('\n')?'\n':''));
  log(`[subagent] account=${account.label} (${account.id}) model=${result.model||model.id} permissions=${permissionMode} status=${status} seconds=${Math.round((Date.now()-started)/1000)}${turn?` tokens_in=${turn.inputTokens??'?'} tokens_out=${turn.outputTokens??'?'}`:''}`);
  if(result.error)log(`[subagent] ${result.error}`);
  return status==='waiting'?3:status==='failed'?1:0;
}

main().then(code=>{process.exitCode=code;},e=>fail(e.message,1));
