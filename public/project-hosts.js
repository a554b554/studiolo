// Which hosts hold a copy of a project and may run it (since 0.2.5). Shared by the
// server and the web UI so both apply the same rules. Every host keeps its own copy of the project
// folder and nothing is synchronized automatically; agents fetch what they need over SSH.
//
// Hosts with a working folder. Projects from before copies existed have their files on the owner;
// the owner's entry is filled in when absent, so a journal that only ever wrote other hosts' entries
// keeps it.
export function replicasOf(project) {
  const raw = project?.replicas && typeof project.replicas === 'object' ? project.replicas : {};
  return project?.ownerHostId && !raw[project.ownerHostId] ? { [project.ownerHostId]: { state: 'ready', at: project.createdAt || null }, ...raw } : raw;
}
export const readyHosts = project => Object.entries(replicasOf(project)).filter(([, r]) => r?.state === 'ready').map(([id]) => id);
// Hosts a conversation may run on: the owner, plus the hosts allowed in the project's settings.
// null means unrestricted (a project without an owner record).
export function runHosts(project) {
  if (!project?.ownerHostId) return null;
  const extra = Array.isArray(project.allowedHostIds) ? project.allowedHostIds : legacyAllowed(project);
  return [...new Set([project.ownerHostId, ...extra.filter(id => typeof id === 'string')])];
}
// A project from 0.2.4 or earlier with sync on allowed every host that held a ready copy.
const legacyAllowed = project => project?.sync?.enabled === true ? readyHosts(project).filter(id => id !== project.ownerHostId) : [];
// An Artifact belongs to the machine whose copy of the project declares it (its studio.artifacts.json),
// and runs there (start and persistent alike) whichever server the page uses.
// Artifacts from before 0.2.5 carry no machine and belong to the project's owner.
export const artifactHostOf = (project, artifact) => artifact?.hostId || project?.ownerHostId || null;
// The server an Artifact runs on, when that is another server than the one this page came from (`selfId`).
// Its pages open there: a page here cannot frame it, because the preview's sign-in cookie never crosses
// sites (src/artifacts.mjs, SameSite=Strict), and a link there works from any device on the tailnet.
export const artifactHome = (project, hosts, selfId, artifact) => { const id = artifactHostOf(project, artifact); if (!id || id === selfId) return null; const host = hosts?.find(h => h.id === id); return host?.url ? host : null; };
// In-memory defaults for the new fields; a journal write records them only when they change. The
// file-sync fields of earlier releases (sync, head, diverged, replica versions) are dropped.
export function migrateProject(project) {
  if (!Array.isArray(project.allowedHostIds)) project.allowedHostIds = legacyAllowed(project);
  project.replicas = replicasOf(project);
  for (const copy of Object.values(project.replicas)) if (copy && typeof copy === 'object') delete copy.version;
  delete project.sync; delete project.head; delete project.diverged;
  return project;
}
