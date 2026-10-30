import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_PORT,DEFAULT_PREVIEW_PORT,defaultStateDir,defaultProjectRoot} from '../src/defaults.mjs';

test('the new system defaults to its own state dir, project root and ports, each overridable',t=>{
 const saved={state:process.env.STUDIO_STATE_DIR,root:process.env.STUDIO_PROJECT_ROOT};
 t.after(()=>{for(const [key,value] of [['STUDIO_STATE_DIR',saved.state],['STUDIO_PROJECT_ROOT',saved.root]])if(value===undefined)delete process.env[key];else process.env[key]=value;});
 delete process.env.STUDIO_STATE_DIR;delete process.env.STUDIO_PROJECT_ROOT;
 assert.equal(defaultStateDir(),path.join(os.homedir(),'.studiolo'));
 assert.equal(defaultProjectRoot(),path.resolve(import.meta.dirname,'../projects'));
 assert.deepEqual([DEFAULT_PORT,DEFAULT_PREVIEW_PORT],[4310,4311],'the ports the iOS app and bookmarks use');
 process.env.STUDIO_STATE_DIR=path.join(os.tmpdir(),'state');process.env.STUDIO_PROJECT_ROOT='relative-projects';
 assert.equal(defaultStateDir(),path.join(os.tmpdir(),'state'));
 assert.equal(defaultProjectRoot(),path.resolve('relative-projects'));
});
