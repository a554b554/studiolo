import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// This installation's locations and ports, in one place; each has an env override.
const here=path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT=4310, DEFAULT_PREVIEW_PORT=4311;
export const defaultStateDir=()=>process.env.STUDIO_STATE_DIR||path.join(os.homedir(),'.studiolo');
// The platform (this installation) and the projects it manages live apart: the projects folder sits next
// to the installation, C:\src\studiolo → C:\src\studiolo-projects, ~/Studiolo → ~/studiolo-projects. Before
// 0.2.0 it was the installation's own projects/ folder; server startup moves it (src/move-projects.mjs).
export const installRoot=path.resolve(here,'..');
export const legacyProjectRoot=()=>path.join(installRoot,'projects');
export const defaultProjectRoot=()=>path.resolve(process.env.STUDIO_PROJECT_ROOT||path.join(path.dirname(installRoot),'studiolo-projects'));
