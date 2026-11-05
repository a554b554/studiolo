// Which hosts hold a project's files and may run it. Shared by the server and the
// web UI so both apply the same rules.
export const syncOf = project => ({ enabled: false, commit: 'auto', prefetch: true, artifactHostId: null, ...(project?.sync || {}) });
export const isSynced = project => syncOf(project).enabled === true;
// Projects from before replicas existed have their files on the owner. The owner's entry is
// filled in when absent, so a journal that only ever wrote other hosts' entries keeps it.
export function replicasOf(project) {
  const raw = project?.replicas && typeof project.replicas === 'object' ? project.replicas : {};
  return project?.ownerHostId && !raw[project.ownerHostId] ? { [project.ownerHostId]: { state: 'ready', version: null, at: project.createdAt || null }, ...raw } : raw;
}
export const readyHosts = project => Object.entries(replicasOf(project)).filter(([, r]) => r?.state === 'ready').map(([id]) => id);
// Hosts a conversation may run on: an unsynced project only on its owner, a synced one on any
// ready replica. null means unrestricted (a project without an owner record).
export const runHosts = project => isSynced(project) ? readyHosts(project) : project?.ownerHostId ? [project.ownerHostId] : null;
export const artifactHostOf = project => (isSynced(project) && syncOf(project).artifactHostId) || project?.ownerHostId || null;
// The server an Artifact runs on, when that is another server than the one this page came from (`selfId`).
// Its pages open there: a page here cannot frame it, because the preview's sign-in cookie never crosses
// sites (src/artifacts.mjs, SameSite=Strict), and a link there works from any device on the tailnet.
export const artifactHome = (project, hosts, selfId) => { const id = artifactHostOf(project); if (!id || id === selfId) return null; const host = hosts?.find(h => h.id === id); return host?.url ? host : null; };
// In-memory defaults for the new fields; a journal write records them only when they change.
export function migrateProject(project) { project.sync = syncOf(project); project.replicas = replicasOf(project); if (project.head === undefined) project.head = null; return project; }
