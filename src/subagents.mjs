import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {writeJson,httpError} from './paths.mjs';

// Shared knowledge about subagents. Every account signed in to Studiolo on the executing machine
// can run a separate one-shot CLI subagent (Claude Code or Codex) through scripts/subagent.mjs, so
// an agent of either family can delegate to the other and spread work across accounts. The routing
// rules are a prompt the user edits in Settings; they are saved beside the synchronized projects,
// so every machine reads the same copy. The account list and quota are appended per machine when a
// conversation starts (see context.mjs), and again whenever the rules or the accounts change.

export const DEFAULT_RULES=[
  '- Smaller or cheaper models (Sonnet, Haiku, older Opus): prefer a team or secondary account when there is one.',
  '- Premium models (the newest or largest of a family): keep them on the main account, the one with the largest plan.',
  '- If every preferred account has less than 30% remaining in any quota window, fall back to the main account.',
  '- Codex subagents run on a Codex account, Claude Code subagents on a Claude account.',
  '- Pass --model explicitly and pick the smallest model that can do the task; use the same model family the user asked for.',
  '- If the user names an account or model in the message, use that instead of these rules.',
].join('\n');
export const RULES_LIMIT=4000;

const pad=n=>String(n).padStart(2,'0');
const stamp=iso=>{const d=new Date(iso);return Number.isNaN(d.getTime())?'?':`${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;};

// One line of quota for an account, from the normalized usage record of account-usage.mjs.
export function quotaText(usage){
  if(!usage)return 'quota unknown (run --list)';
  if(usage.status==='unavailable')return usage.error==='not_logged_in'?'signed out':'quota unavailable';
  const windows=usage.windows||[];
  if(usage.auth==='api_key'&&!windows.length)return 'pay-as-you-go API key, no quota window';
  const bucket=usage.summary?.bucket;
  const parts=windows.filter(w=>['five_hour','seven_day'].includes(w.kind||w.id)&&(!bucket||!w.bucket||w.bucket===bucket))
    .map(w=>`${(w.kind||w.id)==='five_hour'?'5h':'7d'} ${w.remainingPercent===null||w.remainingPercent===undefined?'?':w.remainingPercent+'%'} left${w.resetsAt?`, resets ${stamp(w.resetsAt)}`:''}`);
  if(!parts.length&&usage.summary&&usage.summary.remainingPercent!==null&&usage.summary.remainingPercent!==undefined)parts.push(`${usage.summary.label}: ${usage.summary.remainingPercent}% left`);
  if(!parts.length)return 'quota unknown (run --list)';
  return parts.join(' · ')+(usage.updatedAt?` (as of ${stamp(usage.updatedAt)}${usage.status==='stale'?', stale':''})`:'');
}

export const FAMILY_NAMES={claude:'Claude Code',codex:'Codex'};
export function accountLine(account,usage){
  const plan=account.identity?.plan||(account.auth==='api_key'?'API key':'plan unknown');
  const models=(account.models||[]).map(m=>m.id).join(', ')||'no models';
  return `- ${account.label} · ${account.id} · ${FAMILY_NAMES[account.family]||account.family} · ${plan} · ${quotaText(usage)} · models: ${models}`;
}

export function knowledgeText({helperPath,accounts,usage,rules}){
  const helper=`node "${helperPath}"`;
  return [
    'Subagents (Studiolo): every account signed in on this machine can run a separate CLI subagent, Claude Code or Codex, so a Codex session can delegate to Claude and vice versa and work can be spread across accounts. This is in addition to any built-in subagent tool of your own CLI, which always uses your own account. Launch one from the shell:',
    `  ${helper} --account "<label or id>" --model <model id> [--effort low|medium|high|xhigh|max] [--permissions auto|project-write|read-only] [--cwd <dir>] [--timeout <seconds>] [--verbose] "<task>"`,
    `The task may instead be piped on stdin. The subagent's final answer is printed on stdout and a one-line summary (account, model, tokens) on stderr; --verbose also streams its tool activity to stderr. Exit code 0 means it finished, 3 means it stopped at a permission it could not ask about (rerun with a narrower task or --permissions auto), anything else is a failure. It has no memory of this conversation and nobody answers its questions, so state the task, the relevant files and the expected output in full. \`${helper} --list\` prints these accounts with their current quota.`,
    'Run the launcher outside any command sandbox, from the first attempt (Codex: request escalated permissions / run without the sandbox): the CLIs read their sign-in from the account directory or the macOS Keychain and need network access, so a sandboxed launch fails with "Not logged in" or a connection error even though the account is signed in.',
    'Accounts on this machine (label · id · CLI · plan · quota · models):',
    ...accounts.map(a=>accountLine(a,usage?.accounts?.find(u=>u.id===a.id))),
    'Routing rules (the user edits them in Settings → Subagents):',
    rules,
    'When the user names an account or model for a subagent, follow the request. Otherwise choose by these rules and the quota above, and tell the user which account and model the subagent used.',
  ].join('\n');
}

// Platform-wide settings file beside the synchronized projects: {version, subagents:{enabled, rules, updatedAt, updatedBy}}.
// `rules` is absent while the default text is in use, so a later default change reaches every machine.
export class SubagentPolicy{
  constructor({file}){this.file=file;this.cache=null;this.lastError=null;}
  async read(){
    let info=null;
    try{info=await fs.stat(this.file);}catch(e){if(e.code!=='ENOENT')throw e;}
    const key=info?`${info.size}:${info.mtimeMs}`:'missing';
    if(this.cache&&this.cache.key===key)return this.cache.data;
    let data={};
    if(info){try{data=JSON.parse(await fs.readFile(this.file,'utf8'));this.lastError=null;}catch(e){this.lastError=e.message;data={};}}
    if(!data||typeof data!=='object'||Array.isArray(data))data={};
    this.cache={key,data};return data;
  }
  async get(){
    const data=await this.read(),s=data.subagents&&typeof data.subagents==='object'?data.subagents:{};
    const custom=typeof s.rules==='string';
    return {enabled:s.enabled!==false,rules:custom?s.rules:DEFAULT_RULES,custom,defaultRules:DEFAULT_RULES,updatedAt:s.updatedAt||null,updatedBy:s.updatedBy||null,file:this.file,...(this.lastError?{error:this.lastError}:{})};
  }
  async set({enabled,rules}={},updatedBy=null){
    if(enabled!==undefined&&typeof enabled!=='boolean')throw httpError('enabled must be true or false');
    if(rules!==undefined){
      if(typeof rules!=='string')throw httpError('rules must be text');
      rules=rules.replace(/\r\n?/g,'\n');
      if(rules.length>RULES_LIMIT)throw httpError(`rules must be at most ${RULES_LIMIT} characters`);
      if(/[^\P{Cc}\n\t]/u.test(rules))throw httpError('rules must not contain control characters');
    }
    const data=await this.read(),current=await this.get();
    const next={...(data.subagents&&typeof data.subagents==='object'?data.subagents:{}),enabled:enabled??current.enabled,updatedAt:new Date().toISOString(),updatedBy};
    if(rules!==undefined){if(rules.trim()===DEFAULT_RULES||!rules.trim())delete next.rules;else next.rules=rules;}
    await writeJson(this.file,{...data,version:1,subagents:next});
    this.cache=null;return this.get();
  }
}

// Builds the prompt section for one run. Quota comes from the usage cache only (never waits for a
// CLI); a refresh is started in the background so later conversations see recent numbers. The hash
// covers what changes rarely (helper path, rules, accounts and their models), not the quota, so an
// existing native session is only told again when something it should act on differs.
export class SubagentKnowledge{
  constructor({runner,accountUsage=null,policy,helperPath,now=Date.now}){Object.assign(this,{runner,accountUsage,policy,helperPath,now});}
  async describe(){
    const policy=await this.policy.get();
    if(!policy.enabled)return null;
    const accounts=(await this.runner.profiles()).filter(p=>p.available!==false&&p.status!=='signed_out');
    if(!accounts.length)return null;
    const usage=this.accountUsage?.peek?.()||null;
    const age=usage?this.now()-Date.parse(usage.checkedAt):Infinity;
    if(this.accountUsage&&!(age<(this.accountUsage.ttlMs??60000)))Promise.resolve().then(()=>this.accountUsage.get()).catch(()=>{});
    const text=knowledgeText({helperPath:this.helperPath,accounts,usage,rules:policy.rules});
    const hash=createHash('sha256').update(JSON.stringify({helper:this.helperPath,rules:policy.rules,accounts:accounts.map(a=>[a.id,a.label,a.family,a.identity?.plan||null,(a.models||[]).map(m=>m.id)])})).digest('hex');
    return {text,hash};
  }
}
