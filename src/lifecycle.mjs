import {httpError} from './paths.mjs';

export const inactive = item => Boolean(item?.archivedAt || item?.deletedAt);
const pendingWork = (state, sessionId) => state.runs.some(r => (!sessionId || r.sessionId===sessionId) && ['queued','running','waiting'].includes(r.status));
const busy = () => httpError('请先取消或完成该项目／对话中的排队、执行和等待任务',409);
// Project deletion is permanent: the folder, its history and this machine's agent
// transcripts are removed (see purge.mjs). Archiving remains the reversible option.
export async function deleteProject(purger, projectId) {
  await purger.remove(projectId, state => { if (pendingWork(state)) throw busy(); });
  return {id:projectId,deleted:true};
}
export async function changeLifecycle(store, projectId, sessionId, action) {
  if (!['archive','delete','restore'].includes(action)) throw httpError('无效操作');
  return store.mutate(projectId, `${sessionId ? 'session' : 'project'}.${action}`, state => {
    const target = sessionId ? state.sessions.find(s=>s.id===sessionId) : state.project;
    if (!target) throw httpError('对话不存在',404);
    if (target.deletedAt) throw httpError('已删除，不能恢复',410);
    if (sessionId && inactive(state.project)) throw httpError('请先恢复项目',409);
    if (action !== 'restore' && pendingWork(state, sessionId)) throw busy();
    if (action === 'archive') {
      target.archivedAt ||= new Date().toISOString();
    } else if (action === 'delete' && sessionId) {
      state.sessions=state.sessions.filter(s=>s.id!==sessionId);
      state.messages=state.messages.filter(m=>m.sessionId!==sessionId);
      state.runs=state.runs.filter(r=>r.sessionId!==sessionId);
      delete state.queues[`session:${sessionId}`];
      for(const key of Object.keys(state.nativeSessions))if(key.endsWith(`:${sessionId}`))delete state.nativeSessions[key];
      return {id:sessionId,deleted:true};
    } else if (action === 'delete') target.deletedAt = new Date().toISOString();
    else { delete target.archivedAt; delete target.deletedAt; }
    return target;
  });
}

export async function listArchives(store) {
  const projects=[],sessions=[],errors=[];
  for(const project of await store.listProjects()){
    if(project.deletedAt)continue;
    try {
      const state=await store.read(project.id);
      if(state.project.deletedAt)continue;
      if(project.archivedAt)projects.push({id:project.id,name:project.name});
      for(const s of state.sessions.filter(s=>s.archivedAt&&!s.deletedAt))sessions.push({id:s.id,title:s.title,projectId:project.id,projectName:project.name,projectArchived:Boolean(project.archivedAt)});
    }catch(e){errors.push({projectId:project.id,name:project.name,error:e.message});}
  }
  return {projects,sessions,errors};
}
