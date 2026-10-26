import {spawn} from 'node:child_process';
import {codexCounts,codexUsage} from './usage.mjs';

// Local CLI JSON-RPC channel. No API key, HTTP listener, or permission bypass.
export function codexChannel(config,{cwd,prompt,model,reasoningEffort,nativeSessionId,previousUsage,permissionMode,onEvent,onApproval,signal,redact}) {
  return new Promise((resolve,reject)=>{
    let child,buffer='',stderr='',finalText='',output='',failure,completed=false,closed=false,seq=0,threadId=nativeSessionId,turnId,stopTimer;
    let usageRaw, usageBaseline=nativeSessionId?previousUsage:{inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0};
    const calls=new Map(),requests=new Map(),items=new Map(),streamed=new Set();
    const emit=(type,text,raw)=>{if(!closed)onEvent({type,text:redact(text),...(raw?{raw}:{})});};
    const write=message=>{if(!closed&&!child.stdin.destroyed)child.stdin.write(JSON.stringify(message)+'\n');};
    const rpc=(method,params)=>new Promise((yes,no)=>{
      const id=++seq,timer=setTimeout(()=>{calls.delete(id);no(new Error(`${method} timed out`));},60000);
      calls.set(id,{yes,no,timer});write({id,method,params});
    });
    const kill=()=>{
      if(!child?.pid||closed)return;
      if(process.platform==='win32') {const p=spawn('taskkill.exe',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});p.on('error',()=>child.kill());}
      else {try{process.kill(-child.pid,'SIGTERM');}catch{child.kill();}}
    };
    const stop=()=>{child?.stdin.end();stopTimer ||= setTimeout(kill,2000);};
    const abort=()=>{failure=Object.assign(new Error('Agent run cancelled'),{name:'AbortError'});kill();};
    const request=async e=>{
      const p=e.params||{},method=e.method,ac=new AbortController();requests.set(e.id,ac);
      try {
        if(p.threadId&&p.threadId!==threadId)throw new Error('Approval belongs to another thread');
        if(p.turnId&&turnId&&p.turnId!==turnId)throw new Error('Approval belongs to another turn');
        let response;
        if(['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(method)){
          const detail={...p};delete detail.threadId;delete detail.turnId;
          if(method==='item/fileChange/requestApproval')detail.changes=items.get(p.itemId)?.changes;
          const allow=!p.availableDecisions||p.availableDecisions.includes('accept');
          const answer=await onApproval({kind:'permission',title:method.includes('commandExecution')?'执行命令':method.includes('fileChange')?'修改文件':'申请权限',detail:redact(JSON.stringify(detail,null,2)),allow},ac.signal);
          if(method==='item/permissions/requestApproval') response={permissions:answer.decision==='allow'?p.permissions:{},scope:'turn'};
          else response={decision:answer.decision==='allow'&&allow?'accept':p.availableDecisions&&!p.availableDecisions.includes('decline')?'cancel':'decline'};
        } else if(method==='item/tool/requestUserInput'){
          // Secret answers must not enter project history or the generic form.
          if(p.questions.some(q=>q.isSecret))throw new Error('Secret input requires native client');
          const answer=await onApproval({kind:'question',title:'Agent 需要补充信息',detail:'',questions:p.questions.map(q=>({id:q.id,question:q.question,options:q.options||[]}))},ac.signal);
          response={answers:Object.fromEntries(p.questions.map(q=>[q.id,{answers:answer.decision==='allow'?[answer.answers[q.id]]:[]}]))};
        } else if(method==='currentTime/read')response={currentTimeAt:Math.floor(Date.now()/1000)};
        else {write({id:e.id,error:{code:-32601,message:`Unsupported host request: ${method}`}});emit('status',`Unsupported native request: ${method}`);return;}
        if(!ac.signal.aborted)write({id:e.id,result:response});
      } catch(error) {if(!ac.signal.aborted)write({id:e.id,error:{code:-32000,message:redact(error.message)}});}
      finally{requests.delete(e.id);}
    };
    const consume=line=>{
      let e;try{e=JSON.parse(line);}catch{stderr=(stderr+'\n'+redact(line)).slice(-16000);return;}
      if(e.id!==undefined&&!e.method){const c=calls.get(e.id);if(c){calls.delete(e.id);clearTimeout(c.timer);e.error?c.no(new Error(redact(e.error.message))):c.yes(e.result);}return;}
      if(e.id!==undefined&&e.method){void request(e);return;}
      const p=e.params||{};
      if(e.method==='serverRequest/resolved'){requests.get(p.requestId)?.abort();return;}
      if(p.threadId&&p.threadId!==threadId)return;
      if(e.method==='thread/tokenUsage/updated'){
        if(!turnId) usageBaseline=codexCounts(p.tokenUsage?.total);
        else if(!p.turnId||p.turnId===turnId) usageRaw=p.tokenUsage;
      }
      if(e.method==='turn/started')turnId=p.turn?.id;
      if(e.method==='item/agentMessage/delta'){streamed.add(p.itemId);output+=p.delta;emit('text',p.delta);}
      if(e.method==='item/started')items.set(p.item.id,p.item);
      if(e.method==='item/completed'){
        const item=p.item;items.set(item.id,item);
        if(item.type==='agentMessage'){
          if(!streamed.has(item.id)){output+=item.text;emit('text',item.text);}
          if(!item.phase||item.phase==='final_answer')finalText=item.text;else if(item.phase==='commentary')emit('narration','');
        } else if(['commandExecution','fileChange','mcpToolCall','webSearch','dynamicToolCall'].includes(item.type))emit('tool',JSON.stringify(item));
      }
      if(e.method==='error'){emit('status',p.error?.message||'Codex error');}
      if(e.method==='turn/completed'){
        completed=true;
        if(p.turn.status!=='completed')failure=new Error(redact(p.turn.error?.message||`Codex turn ${p.turn.status}`));
        stop();
      }
    };
    try{child=spawn(config.command,[...config.args,'app-server','--listen','stdio://'],{cwd,env:config.env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});}
    catch(e){reject(e);return;}
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;let i;try{while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.trim())consume(line);}if(buffer.length>16*1024*1024)throw new Error('CLI output line exceeded 16 MiB');}
      catch(e){failure=e;kill();}
    });
    child.stderr.on('data',chunk=>{stderr=(stderr+redact(chunk)).slice(-16000);});
    child.stdin.on('error',e=>{if(e.code!=='EPIPE'){failure=e;kill();}});
    child.on('error',e=>{failure=e;});
    child.on('close',()=>{
      closed=true;clearTimeout(stopTimer);signal?.removeEventListener('abort',abort);
      for(const c of calls.values()){clearTimeout(c.timer);c.no(new Error('CLI channel closed'));}
      for(const ac of requests.values())ac.abort();
      if(failure||!completed)return reject(failure||new Error(`Codex channel closed before completion: ${stderr}`));
      resolve({text:redact(finalText||output),nativeSessionId:threadId,model,usage:codexUsage(usageRaw,usageBaseline)});
    });
    (async()=>{
      await rpc('initialize',{clientInfo:{name:'studio',version:'0.1.0'},capabilities:{experimentalApi:true}});write({method:'initialized'});
      const permissions=permissionMode==='auto'?{approvalPolicy:'on-request',approvalsReviewer:'auto_review',sandbox:'workspace-write'}:permissionMode==='default'?{}:{approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:permissionMode==='project-write'?'workspace-write':'read-only'};
      const thread=await rpc(nativeSessionId?'thread/resume':'thread/start',{...(nativeSessionId?{threadId:nativeSessionId}:{}),cwd,model,...permissions});
      threadId=thread.thread.id;model=thread.model||model;
      emit('status',`Started codex · ${model} · reviewer=${thread.approvalsReviewer||permissions.approvalsReviewer||'inherited'}`,{nativeSessionId:threadId,model});
      await rpc('turn/start',{threadId,cwd,model,...(reasoningEffort?{effort:reasoningEffort}:{}),input:[{type:'text',text:prompt}]});
    })().catch(e=>{if(!closed){failure=e;stop();}});
  });
}
