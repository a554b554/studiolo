import {randomUUID} from 'node:crypto';
import {markUnread} from './unread.mjs';

const fail = message => Object.assign(new Error(message), {status:409});
// Only the native request callback lives in memory. Durable records are display/audit data,
// never reusable grants. Browser clients cannot replace the operation being approved.
export class Approvals {
  constructor(store, hostId) { this.store=store; this.hostId=hostId; this.pending=new Map(); }
  async request(projectId, runId, request, signal) {
    if(signal.aborted)throw fail('执行已取消');
    const id=randomUUID();
    let resolve,reject;
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    promise.catch(()=>{});
    const abort=()=>{
      this.pending.delete(id);reject(fail('批准请求已失效'));
      void this.store.mutate(projectId,'approval.withdrawn',s=>{
        const run=s.runs.find(r=>r.id===runId),a=run?.approvals?.find(a=>a.id===id);
        if(a?.status==='pending')a.status='expired';
        if(run?.status==='waiting'&&!run.approvals?.some(a=>a.status==='pending'))run.status='running';
      }).catch(()=>{});
    };
    this.pending.set(id,{projectId,runId,resolve,reject,signal});
    signal.addEventListener('abort',abort,{once:true});
    try {
      await this.store.mutate(projectId,'approval.requested',s=>{
        const run=s.runs.find(r=>r.id===runId);
        if(signal.aborted||run?.hostId!==this.hostId||!run||!['running','waiting'].includes(run.status))throw fail('执行已结束');
        (run.approvals ||= []).push({...request,id,status:'pending',createdAt:new Date().toISOString()});
        run.status='waiting';markUnread(s,run);
      });
      return await promise;
    } finally {signal.removeEventListener('abort',abort);this.pending.delete(id);}
  }
  async respond(projectId,runId,id,input) {
    const pending=this.pending.get(id);
    if(!pending||pending.projectId!==projectId||pending.runId!==runId||pending.signal.aborted)throw fail('批准请求已失效，请刷新页面');
    const {decision,answers}=input;
    if(!['allow','deny'].includes(decision))throw fail('无效批准决定');
    await this.store.mutate(projectId,'approval.decided',s=>{
      const run=s.runs.find(r=>r.id===runId),approval=run?.approvals?.find(a=>a.id===id);
      if(run?.hostId!==this.hostId||run?.status!=='waiting'||approval?.status!=='pending'||pending.signal.aborted)throw fail('批准请求已失效');
      if(decision==='allow'&&approval.allow===false)throw fail('该请求不支持批准');
      if(decision==='allow'&&approval.questions?.some(q=>typeof answers?.[q.id]!=='string'||!answers[q.id].trim()||answers[q.id].length>10000))throw fail('请回答所有问题');
      approval.status=decision==='allow'?'approved':'denied';approval.decidedAt=new Date().toISOString();
      s.messages.push({id:randomUUID(),runId,role:'system',kind:'status',text:`网页${decision==='allow'?'批准':'拒绝'}：${approval.title}`,createdAt:approval.decidedAt,profileId:run.profileId,...(run.sessionId?{sessionId:run.sessionId}:{artifactId:run.artifactId,annotationId:run.annotationId})});
      if(!run.approvals.some(a=>a.status==='pending'))run.status='running';
    });
    this.pending.delete(id);pending.resolve({decision,answers});
    return {ok:true};
  }
  async expire(projectId,runId) {
    for(const [id,p] of this.pending)if(p.projectId===projectId&&p.runId===runId){this.pending.delete(id);p.reject(fail('执行已结束'));}
    if(!(await this.store.read(projectId)).runs.find(r=>r.id===runId)?.approvals?.some(a=>a.status==='pending'))return;
    await this.store.mutate(projectId,'approval.expired',s=>{
      for(const a of s.runs.find(r=>r.id===runId)?.approvals||[])if(a.status==='pending')a.status='expired';
    });
  }
}
