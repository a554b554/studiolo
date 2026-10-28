// Browser view state, independent of theme and persisted project records.
export const view = { bootstrap: null, projectId: null, sessionId: null, project: null, drafts: new Map(), files: new Map(), resource: 'files' };
export function draftKey() { return `${view.projectId}:${view.sessionId}`; }
export function rememberSelection() { try { localStorage.setItem('studio-selection', JSON.stringify({ projectId:view.projectId, sessionId:view.sessionId })); } catch {} }
export function previousSelection() { try { return JSON.parse(localStorage.getItem('studio-selection') || '{}'); } catch { return {}; } }
