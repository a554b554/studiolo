// Slash commands typed into the web composer. The browser handles its own commands (model,
// effort, mode, rename…); the queue handles /clear; everything else reaches the native CLI:
// Claude receives the text unchanged and runs its own command, Codex has no text commands so
// the few it supports are mapped to app-server requests here.
export const CODEX_COMMANDS=Object.freeze([
  {name:'compact',description:'Compact the conversation context'},
  {name:'review',hint:'[base <branch> | commit <sha> | <instructions>]',description:'Review the current changes'},
  {name:'skills',description:'List available skills'},
  {name:'mcp',description:'List MCP server status'},
]);

// "/name args" at the start of a message. A leading path such as /usr/bin is not a command.
export function parseCommand(text){
  const match=/^\/([a-zA-Z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(String(text??'').trim());
  return match?{name:match[1].toLowerCase(),args:(match[2]||'').trim()}:null;
}

export function reviewTarget(args){
  const base=/^(?:base|branch)\s+(\S+)$/i.exec(args);
  if(base)return {type:'baseBranch',branch:base[1]};
  const commit=/^commit\s+([0-9a-f]{7,40})$/i.exec(args);
  if(commit)return {type:'commit',sha:commit[1],title:null};
  return args?{type:'custom',instructions:args}:{type:'uncommittedChanges'};
}

// Only plain descriptive fields of the CLI's initialize response are kept; never tokens.
export function claudeCapabilities(init){
  const commands=Array.isArray(init?.commands)?init.commands.filter(c=>typeof c?.name==='string').map(c=>({name:c.name,hint:typeof c.argumentHint==='string'&&c.argumentHint?c.argumentHint:null,description:typeof c.description==='string'?c.description.slice(0,160):null})):[];
  const models=Array.isArray(init?.models)?init.models.filter(m=>typeof m?.value==='string').map(m=>({id:m.value,label:typeof m.displayName==='string'?m.displayName:m.value,description:typeof m.description==='string'?m.description.slice(0,160):null})):[];
  const account=init?.account&&typeof init.account==='object'?{email:typeof init.account.email==='string'?init.account.email:null,plan:typeof init.account.subscriptionType==='string'?init.account.subscriptionType:null,organization:typeof init.account.organization==='string'?init.account.organization:null,provider:typeof init.account.apiProvider==='string'?init.account.apiProvider:null}:null;
  return {commands,models,account};
}
