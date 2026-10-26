import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {claudeUsage,codexUsage,codexCounts} from './usage.mjs';
import {CODEX_COMMANDS,reviewTarget,claudeCapabilities} from './commands.mjs';

const zero=()=>({inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0});
const aborted=()=>Object.assign(new Error('Agent run cancelled'),{name:'AbortError'});
const noTurn=()=>Object.assign(new Error('no_active_turn'),{status:409});
const claudeMode=mode=>mode==='project-write'?'acceptEdits':mode==='read-only'?'plan':mode;
const textInput=text=>[{type:'text',text,text_elements:[]}];
// An interrupted CLI that never completes its turn is killed, as a hard cancel would do.
const INTERRUPT_GRACE_MS=15000;

// One native process per logical conversation. A result ends a turn, not stdin.
// Only public protocol fields are forwarded; native thinking stays in the CLI.
// Verified 2026-10-18 against Claude Code 2.1.296 and codex-cli 0.162.1: both keep the
// process and session alive across interrupt, and both accept a second user message while a
// turn runs (Claude delivers it at the next tool boundary, Codex via turn/steer).
export class ResidentSession {
  constructor(config,initial,redact) {
    this.config=config;this.initial=initial;this.redact=redact;this.id=randomUUID();
    this.nativeSessionId=initial.nativeSessionId;this.total=initial.nativeSessionId?initial.previousUsage:zero();
    this.calls=new Map();this.requests=new Map();this.idleWaiters=new Set();this.seq=0;this.closed=false;
    this.commands=config.family==='codex'?CODEX_COMMANDS.map(c=>({...c})):null;this.capabilities=null;
  }
  snapshot(){
    const t=this.turn;
    return {connected:!!this.child&&!this.closed,busy:!!t,steerable:Boolean(t?.submitted&&!t.interrupting&&!t.command&&(this.config.family==='claude'||t.turnId)),pid:this.child?.pid,instanceId:this.id,nativeSessionId:this.nativeSessionId,...(this.commands?{commands:this.commands}:{})};
  }
  write(e){if(this.closed||this.child?.stdin.destroyed)throw new Error('Native session is closed');this.child.stdin.write(JSON.stringify(e)+'\n');}
  rpc(method,params){return new Promise((resolve,reject)=>{
    const id=String(++this.seq),timer=setTimeout(()=>{this.calls.delete(id);reject(new Error(`Native request timed out: ${method}`));},60000);
    this.calls.set(id,{resolve,reject,timer});
    try{this.write(this.config.family==='claude'?{type:'control_request',request_id:id,request:{subtype:method,...params}}:{id,method,params});}
    catch(e){clearTimeout(timer);this.calls.delete(id);reject(e);}
  });}
  emit(type,text,raw){
    if(this.turn)this.turn.onEvent({type,text:this.redact(text),...(raw?{raw}:{})});
    else if(this.background&&text)this.background({type:'tool',text:this.redact(`Background native event: ${text}`)});
  }
  backgroundReply(e){
    // Complete public assistant messages only; never promote tool results or subagents.
    if(e.parent_tool_use_id)return;
    const callback=this.background||this.turn?.onEvent;
    if(e.type==='assistant'){
      const text=(e.message?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
      if(text){this.backgroundText=text;callback?.({type:'reply',text:this.redact(text)});}
    }else if(e.type==='result'){
      if(typeof e.result==='string'&&e.result&&e.result!==this.backgroundText)
        callback?.({type:e.is_error||e.subtype!=='success'?'status':'reply',text:this.redact(e.result)});
      this.backgroundText=undefined;
    }
  }
  async boot(){
    const c=this.config,o=this.initial;
    const args=c.family==='codex'?['app-server','--listen','stdio://']:['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--permission-prompts','host','--permission-prompt-tool','stdio','--permission-mode',claudeMode(o.permissionMode),'--model',o.model,...(o.nativeSessionId?['--resume',o.nativeSessionId]:[])];
    this.child=spawn(c.command,[...c.args,...args],{cwd:o.cwd,env:{...c.env,...(c.family==='claude'?{CLAUDE_CODE_SDK_READS_SESSION_STATE:'1'}:{})},windowsHide:true,shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    let buffer='';this.stderr='';
    this.exited=new Promise(resolve=>this.child.once('close',()=>{this.closed=true;clearTimeout(this.killTimer);this.fail(new Error(`Native session exited: ${this.stderr}`));resolve();}));
    this.child.on('error',e=>this.fail(e));this.child.stdin.on('error',e=>{if(e.code!=='EPIPE')this.fail(e);});
    this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>{buffer+=chunk;try{let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.trim())this.consume(JSON.parse(line));}if(buffer.length>16*1024*1024)throw Error('Native output exceeded 16 MiB');}catch(e){this.fail(e);void this.close();}});
    this.child.stderr.on('data',s=>{this.stderr=(this.stderr+this.redact(s)).slice(-16000);});
    if(c.family==='claude'){
      const init=await this.rpc('initialize',{});
      // The handshake lists the CLI's slash commands, model aliases and signed-in account.
      this.capabilities=claudeCapabilities(init);this.commands=this.capabilities.commands;
    } else {
      await this.rpc('initialize',{clientInfo:{name:'studio',version:'0.2.0'},capabilities:{experimentalApi:true}});this.write({method:'initialized'});
      const r=await this.rpc(o.nativeSessionId?'thread/resume':'thread/start',{...(o.nativeSessionId?{threadId:o.nativeSessionId}:{}),cwd:o.cwd,model:o.model});
      this.nativeSessionId=r.thread.id;this.defaults={approvalPolicy:r.approvalPolicy,approvalsReviewer:r.approvalsReviewer,sandboxPolicy:r.sandbox,effort:r.reasoningEffort};
    }
  }
  async execute(options){
    if(this.turn)throw Error('Native conversation is already executing');
    if(this.closed)throw Error('Native conversation is closed');
    if(options.signal?.aborted)throw aborted();
    if(this.nativeState&&this.nativeState!=='idle')await new Promise((resolve,reject)=>{
      const abort=()=>{this.idleWaiters.delete(waiter);reject(aborted());};
      const waiter={resolve:()=>{options.signal?.removeEventListener('abort',abort);resolve();},reject:e=>{options.signal?.removeEventListener('abort',abort);reject(e);}};
      this.idleWaiters.add(waiter);options.signal?.addEventListener('abort',abort,{once:true});
    });
    if(this.turn||this.closed)throw Error('Native conversation is unavailable');
    let resolve,reject;const result=new Promise((yes,no)=>{resolve=yes;reject=no;});
    result.catch(()=>{});
    // `uuids` are every user message of this turn (the prompt plus steers); `pending` are the
    // ones without a result yet. `segment` is the text streamed since the last steer.
    const userMessageId=randomUUID();
    const t=this.turn={...options,resolve,reject,userMessageId,uuids:new Set([userMessageId]),pending:new Set([userMessageId]),submitted:false,text:'',segment:'',finalText:undefined,items:new Map(),streamed:new Set(),denied:new Set(),usageBaseline:this.total};
    t.abort=()=>{this.fail(aborted());void this.close();};options.signal?.addEventListener('abort',t.abort,{once:true});
    try {
      if(!this.child)await this.boot();
      if(this.closed||this.turn!==t)throw aborted();
      if(this.config.family==='claude'){
        if(this.model!==options.model)await this.rpc('set_model',{model:options.model});
        await this.rpc('set_permission_mode',{mode:claudeMode(options.permissionMode)});
        await this.rpc('apply_flag_settings',{settings:{effortLevel:options.reasoningEffort||null}});
        const settings=await this.rpc('get_settings',{});
        const applied=settings.applied;
        if(!applied?.model||options.reasoningEffort&&applied.effort!==options.reasoningEffort)throw Error('Native CLI did not confirm requested model/effort');
        if(applied.model.replace(/\[1m\]$/,'')!==options.model.replace(/\[1m\]$/,''))throw Error(`Native CLI model mismatch: ${applied.model}`);
        this.model=applied.model;t.actualEffort=applied.effort;
        this.emit('status',`Native session · ${this.model} · effort=${t.actualEffort} · mode=${options.permissionMode}`,{model:this.model,nativeSessionId:this.nativeSessionId,reasoningEffort:t.actualEffort});
        if(this.closed||this.turn!==t)throw aborted();
        t.submitted=true;
        // A slash command is sent verbatim; the CLI runs it and answers with a local result.
        this.write({type:'user',uuid:t.userMessageId,message:{role:'user',content:options.prompt},session_id:this.nativeSessionId||'',parent_tool_use_id:null});
      }else{
        this.model=options.model;t.actualEffort=options.reasoningEffort||this.defaults.effort;
        const mode=options.permissionMode;
        const permissions=mode==='default'?this.defaults:{approvalPolicy:'on-request',approvalsReviewer:mode==='auto'?'auto_review':'user',sandboxPolicy:mode==='read-only'?{type:'readOnly',networkAccess:false}:{type:'workspaceWrite',writableRoots:[options.cwd],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false}};
        this.emit('status',`Native session · ${this.model} · effort=${t.actualEffort||'default'} · mode=${mode}`,{model:this.model,nativeSessionId:this.nativeSessionId,reasoningEffort:t.actualEffort});
        if(options.command){await this.codexCommand(t,options);}
        else{
          const started=await this.rpc('turn/start',{threadId:this.nativeSessionId,cwd:options.cwd,...permissions,model:options.model,effort:t.actualEffort,input:textInput(options.prompt)});
          if(this.turn===t){t.turnId||=started?.turn?.id;t.submitted=true;}
        }
      }
    }catch(e){if(this.turn===t)this.fail(e);void this.close();}
    return result;
  }
  // Codex has no text commands: the few the composer offers map to app-server requests.
  // compact and review run as a native turn and finish on turn/completed; the lists answer at once.
  async codexCommand(t,o){
    const {name,args}=o.command,threadId=this.nativeSessionId;
    this.emit('status',`Native command · /${name}`);
    t.submitted=true;
    if(name==='compact'){await this.rpc('thread/compact/start',{threadId});return;}
    if(name==='review'){const r=await this.rpc('review/start',{threadId,target:reviewTarget(args)});if(this.turn===t&&r?.turn?.id)t.turnId=r.turn.id;return;}
    if(name==='skills'){
      const r=await this.rpc('skills/list',{cwds:[o.cwd]});const list=(r?.data||[]).flatMap(x=>x.skills||[]);
      if(this.turn===t)this.finish({text:list.length?list.map(s=>`- ${s.name}${s.enabled===false?' (disabled)':''}${s.shortDescription||s.description?': '+(s.shortDescription||s.description):''}`).join('\n'):'No skills are available.'});
      return;
    }
    if(name==='mcp'){
      const r=await this.rpc('mcpServerStatus/list',{});const rows=Array.isArray(r?.data)?r.data:[];
      if(this.turn===t)this.finish({text:rows.length?rows.map(s=>typeof s?.name==='string'?`- ${s.name}: ${typeof s.status==='string'?s.status:s.status?.type||JSON.stringify(s.status??'')}`:`- ${JSON.stringify(s)}`).join('\n'):'No MCP servers are configured.'});
      return;
    }
    throw Error(`Codex does not support /${name}`);
  }
  // Stop the current turn but keep the process and the native session. The turn then ends
  // through the CLI's own result (Claude) or turn/completed (Codex) with status "interrupted".
  async interrupt(){
    const t=this.turn;
    if(!t||!t.submitted||this.closed)throw noTurn();
    if(t.interrupting)return;
    t.interrupting=true;this.emit('status','Interrupt requested');
    try{
      if(this.config.family==='claude')await this.rpc('interrupt',{});
      else{if(!t.turnId)throw Error('Turn id unknown');await this.rpc('turn/interrupt',{threadId:this.nativeSessionId,turnId:t.turnId});}
    }catch(e){if(this.turn===t){this.fail(aborted());void this.close();}throw e;}
    if(this.turn===t){t.interruptTimer=setTimeout(()=>{if(this.turn===t){this.fail(aborted());void this.close();}},INTERRUPT_GRACE_MS);t.interruptTimer.unref?.();}
  }
  // Deliver another user message into the running turn. Claude queues it and reads it at the
  // next tool boundary; Codex steers the active turn. The "steer" event lets the queue record
  // the message in order and start a new assistant segment after it.
  async steer(text){
    const t=this.turn;
    if(!t||!t.submitted||this.closed||t.interrupting||t.command)throw noTurn();
    if(this.config.family==='claude'){
      const uuid=randomUUID();t.uuids.add(uuid);t.pending.add(uuid);
      this.write({type:'user',uuid,message:{role:'user',content:text},session_id:this.nativeSessionId||'',parent_tool_use_id:null});
      t.segment='';this.emit('steer',text);
    }else{
      if(!t.turnId)throw noTurn();
      // Recorded before the request returns: Codex may stream the steered reply in the same
      // chunk as the acknowledgement, and the message must precede that text.
      t.segment='';this.emit('steer',text);
      try{await this.rpc('turn/steer',{threadId:this.nativeSessionId,expectedTurnId:t.turnId,input:textInput(text)});}
      catch(e){if(this.turn===t)this.emit('status','Follow-up message was not delivered; send it again.');throw Object.assign(new Error('steer_failed: '+e.message),{status:409});}
    }
  }
  consume(e){
    if(this.closed)return;
    const claude=this.config.family==='claude';
    const response=claude?e.type==='control_response'&&e.response:e.id!==undefined&&!e.method&&e;
    if(response){const id=String(claude?response.request_id:e.id),c=this.calls.get(id);if(c){this.calls.delete(id);clearTimeout(c.timer);const error=claude?response.subtype==='error'&&response.error:e.error?.message;error?c.reject(new Error(this.redact(error))):c.resolve(claude?response.response||{}:e.result);}return;}
    if(claude&&e.type==='control_cancel_request'){this.requests.get(e.request_id)?.abort();return;}
    if(claude&&e.type==='system'&&e.subtype==='session_state_changed'){
      this.nativeState=e.state;
      // Idle means nothing more will arrive for this turn, whatever is still marked pending.
      if(e.state==='idle'&&this.turn?.pendingResult)this.finish(this.turn.pendingResult);
      if(e.state==='idle'){for(const waiter of this.idleWaiters)waiter.resolve();this.idleWaiters.clear();}
      return;
    }
    if(claude&&e.type==='control_request'||!claude&&e.id!==undefined&&e.method){void this.approval(e);return;}
    if(!claude&&e.method==='serverRequest/resolved'){this.requests.get(e.params.requestId)?.abort();return;}
    if(claude&&e.type==='system'&&e.subtype==='init'){
      this.nativeSessionId=e.session_id;this.model=e.model||this.model;
      this.emit('status',`Started ${this.config.id} · ${this.model}`,{nativeSessionId:this.nativeSessionId,model:this.model});return;
    }
    if(claude&&e.type==='system'&&e.subtype==='compact_boundary'){const m=e.compact_metadata||{};this.emit('status',`Context compacted${m.pre_tokens?` · ${m.pre_tokens} → ${m.post_tokens} tokens`:''}`);return;}
    const t=this.turn;
    if(claude){
      if(e.parent_tool_use_id)return;
      // Claude echoes the client UUID on reply starts and results (including batches).
      // A boot-time rescue or background task result must not finish a queued user send.
      const ids=Array.isArray(e.user_message_uuids)?e.user_message_uuids:typeof e.user_message_uuid==='string'?[e.user_message_uuid]:null;
      const owns=ids=>Boolean(t?.submitted&&ids.some(id=>t.uuids.has(id)));
      if(e.type==='command_lifecycle'){
        this.hasCorrelation=true;
        if(!t?.submitted||!t.uuids.has(e.command_uuid)||!['cancelled','discarded','refused'].includes(e.state))return;
        if(e.command_uuid===t.userMessageId){
          if(t.interrupting)this.finish({text:t.segment,usage:t.pendingResult?.usage,status:'interrupted'});
          else this.finish({text:t.segment,status:'failed',error:`Native message ${e.state}`});
        }else{
          // A steer the CLI dropped must not keep the turn open forever.
          t.pending.delete(e.command_uuid);this.emit('status',`Follow-up message ${e.state}`);
          if(!t.pending.size&&t.pendingResult)this.finish(t.pendingResult);
        }
        return;
      }
      if(ids){this.hasCorrelation=true;this.replyOwner=owns(ids)?t:null;}
      const own=t?.submitted&&(ids?owns(ids):!this.hasCorrelation||e.type!=='result'&&this.replyOwner===t);
      if(!own){
        // Session-scoped startup failures have no user UUID; report them, never succeed empty.
        if(t&&e.type==='result'&&e.is_error&&(e.startup_failure_reason||e.runner_exit)){
          this.finish({text:'',status:'failed',error:e.result||(e.errors||[]).join('\n')||e.subtype});return;
        }
        this.backgroundReply(e);
        if(e.type==='result')this.replyOwner=null;
        return;
      }
    }
    if(!t)return;
    if(claude){
      if(e.type==='stream_event'&&!e.parent_tool_use_id){const v=e.event;if(v?.type==='message_start')t.delta=false;if(v?.type==='content_block_delta'&&v.delta?.type==='text_delta'){t.delta=true;this.text(t,v.delta.text);}}
      if(e.type==='assistant'&&!e.parent_tool_use_id){
        if(e.message?.model)this.model=e.message.model;
        for(const b of e.message?.content||[])if(b.type==='text'&&!t.delta){this.text(t,b.text);}else if(b.type==='tool_use')this.emit('tool',`${b.name}: ${JSON.stringify(b.input)}`);t.delta=false;
      }
      if(e.type==='user')for(const b of e.message?.content||[])if(b.type==='tool_result')this.emit('tool',`Tool result: ${typeof b.content==='string'?b.content:(b.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')}`);
      if(e.type==='system'&&['status','api_retry','informational'].includes(e.subtype)&&(e.status||e.message))this.emit('status',e.status||e.message);
      if(e.type==='result'){
        this.replyOwner=null;
        this.nativeSessionId=e.session_id||this.nativeSessionId;
        const ids=Array.isArray(e.user_message_uuids)?e.user_message_uuids:typeof e.user_message_uuid==='string'?[e.user_message_uuid]:null;
        if(ids)for(const id of ids)t.pending.delete(id);else t.pending.clear();
        const failed=e.is_error||e.subtype!=='success';
        const interrupted=t.interrupting&&failed;
        const denied=e.permission_denials?.some(d=>!t.denied.has(d.tool_name));
        const error=interrupted?undefined:failed?this.redact(e.result||(e.errors||[]).join('\n')||e.subtype):denied?'原生 CLI 权限策略拒绝了操作；自动审核不等于全部批准。':undefined;
        t.pendingResult={text:!interrupted&&typeof e.result==='string'?e.result:t.segment,usage:claudeUsage(e.usage),...(interrupted?{status:'interrupted'}:error?{error,status:'failed'}:{})};
        // Steers still pending get their own result (or run next); the turn stays open for them.
        if(interrupted||error||!t.pending.size&&(!this.nativeState||this.nativeState==='idle'))this.finish(t.pendingResult);
      }
    }else{
      const p=e.params||{};if(p.threadId&&p.threadId!==this.nativeSessionId)return;
      if(e.method==='turn/started'){t.turnId=p.turn.id;}
      if(e.method==='thread/tokenUsage/updated'){if(!t.turnId){t.usageBaseline=codexCounts(p.tokenUsage?.total);this.total=t.usageBaseline;}else if(!p.turnId||p.turnId===t.turnId)t.usageRaw=p.tokenUsage;}
      if(p.turnId&&t.turnId&&p.turnId!==t.turnId)return;
      if(e.method==='item/agentMessage/delta'){t.streamed.add(p.itemId);this.text(t,p.delta);}
      if(e.method==='item/started')t.items.set(p.item.id,p.item);
      if(e.method==='item/completed'){
        const item=p.item;t.items.set(item.id,item);
        if(item.type==='agentMessage'){if(!t.streamed.has(item.id)){this.text(t,item.text);}if(!item.phase||item.phase==='final_answer')t.finalText=item.text;else if(item.phase==='commentary')this.emit('narration','');}
        else if(item.type==='contextCompaction')this.emit('status','Context compacted');
        else if(['commandExecution','fileChange','mcpToolCall','webSearch','dynamicToolCall'].includes(item.type))this.emit('tool',JSON.stringify(item));
      }
      if(e.method==='error')this.emit('status',p.error?.message||'Codex error');
      if(e.method==='turn/completed'){
        const usage=codexUsage(t.usageRaw,t.usageBaseline);if(usage?.sessionTotal)this.total=usage.sessionTotal;
        const status=p.turn.status;
        this.finish({text:t.finalText??t.segment,usage,...(status==='interrupted'?{status:'interrupted'}:status!=='completed'?{status:'failed',error:p.turn.error?.message||`Codex turn ${status}`}:{})});
      }
    }
  }
  text(t,delta){if(!delta)return;t.text+=delta;t.segment+=delta;this.emit('text',delta);}
  async approval(e){
    const claude=this.config.family==='claude',id=claude?e.request_id:e.id,ac=new AbortController();this.requests.set(id,ac);
    const t=this.turn;
    try {
      if(!claude&&e.method==='currentTime/read'){this.write({id,result:{currentTimeAt:Math.floor(Date.now()/1000)}});return;}
      if(!t)throw Error('No active web turn for this native request');
      const p=claude?e.request:e.params||{};let req,response;
      if(claude){
        if(p.subtype!=='can_use_tool')throw Error(`Unsupported native request: ${p.subtype}`);
        const questions=p.tool_name==='AskUserQuestion'?(p.input?.questions||[]).map(q=>({id:q.question,question:q.question,options:q.options||[]})):undefined;
        req={kind:questions?'question':'permission',title:p.tool_name,detail:this.redact(JSON.stringify({input:p.input,reason:p.decision_reason,description:p.description,blockedPath:p.blocked_path},null,2)),...(questions?{questions}:{})};
        const a=await t.onApproval(req,ac.signal);if(a.decision==='deny')t.denied.add(p.tool_name);
        response=a.decision==='allow'?{behavior:'allow',updatedInput:questions?{...p.input,answers:a.answers}:p.input}:{behavior:'deny',message:'User declined this operation. Do not repeat it.'};
      }else{
        if(p.threadId&&p.threadId!==this.nativeSessionId||p.turnId&&t.turnId&&p.turnId!==t.turnId)throw Error('Native approval belongs to a different turn');
        if(['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(e.method)){
          const allow=!p.availableDecisions||p.availableDecisions.includes('accept');
          const a=await t.onApproval({kind:'permission',title:e.method.includes('fileChange')?'修改文件':e.method.includes('permissions')?'申请权限':'执行命令',detail:this.redact(JSON.stringify({...p,changes:t.items.get(p.itemId)?.changes},null,2)),allow},ac.signal);
          response=e.method==='item/permissions/requestApproval'?{permissions:a.decision==='allow'?p.permissions:{},scope:'turn'}:{decision:a.decision==='allow'&&allow?'accept':p.availableDecisions&&!p.availableDecisions.includes('decline')?'cancel':'decline'};
        }else if(e.method==='item/tool/requestUserInput'){
          if(p.questions.some(q=>q.isSecret))throw Error('Secret input requires native client');
          const a=await t.onApproval({kind:'question',title:'Agent 需要补充信息',detail:'',questions:p.questions.map(q=>({id:q.id,question:q.question,options:q.options||[]}))},ac.signal);
          response={answers:Object.fromEntries(p.questions.map(q=>[q.id,{answers:a.decision==='allow'?[a.answers[q.id]]:[]}]))};
        }else throw Error(`Unsupported native request: ${e.method}`);
      }
      if(!ac.signal.aborted&&this.turn===t)this.write(claude?{type:'control_response',response:{subtype:'success',request_id:id,response}}:{id,result:response});
    }catch(error){if(!ac.signal.aborted&&!this.closed){this.emit('status',`Native request unavailable: ${error.message}`);this.write(claude?{type:'control_response',response:{subtype:'error',request_id:id,error:this.redact(error.message)}}:{id,error:{code:-32000,message:this.redact(error.message)}});}}
    finally{this.requests.delete(id);}
  }
  finish(result){const t=this.turn;if(!t)return;this.turn=null;this.background=t.onEvent;clearTimeout(t.interruptTimer);t.signal?.removeEventListener('abort',t.abort);for(const ac of this.requests.values())ac.abort();this.requests.clear();t.resolve({...result,text:this.redact(result.text),nativeSessionId:this.nativeSessionId,model:this.model,reasoningEffort:t.actualEffort,runtime:this.snapshot()});}
  fail(error){const t=this.turn;this.turn=null;if(t){clearTimeout(t.interruptTimer);t.signal?.removeEventListener('abort',t.abort);t.reject(new Error(this.redact(error.message)));}for(const c of this.calls.values()){clearTimeout(c.timer);c.reject(error);}this.calls.clear();for(const ac of this.requests.values())ac.abort();this.requests.clear();for(const waiter of this.idleWaiters)waiter.reject(error);this.idleWaiters.clear();}
  async close(){
    if(this.closing)return this.closing;
    this.closing=(async()=>{this.closed=true;this.fail(new Error('Native session closed'));if(!this.child)return;
      this.child.stdin.end();this.killTimer=setTimeout(()=>{if(process.platform==='win32'){const k=spawn('taskkill.exe',['/pid',String(this.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});k.on('error',()=>this.child.kill());}else{try{process.kill(-this.child.pid,'SIGTERM');}catch{this.child.kill();}}},2000);await this.exited;
    })();return this.closing;
  }
}
