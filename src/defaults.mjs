import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// This installation's locations and ports, in one place; each has an env override.
const here=path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT=4310, DEFAULT_PREVIEW_PORT=4311;
export const defaultStateDir=()=>process.env.STUDIO_STATE_DIR||path.join(os.homedir(),'.studiolo');
export const defaultProjectRoot=()=>path.resolve(process.env.STUDIO_PROJECT_ROOT||path.join(here,'../projects'));
