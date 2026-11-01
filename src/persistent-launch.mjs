// Started by Studiolo for "play persistent" (src/persistent-artifacts.mjs). Starts the Artifact's process
// outside Studiolo's process tree — detached, its own process group, output to a log file, no pipes back —
// prints its pid and exits. With this process gone, nothing links the Artifact to Studiolo: restarting
// Studiolo (taskkill /T on Windows, launchd on macOS) or closing it leaves the Artifact running.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
const spec=JSON.parse(process.argv[2]);
const out=fs.openSync(spec.log,'a');
const child=spawn(spec.command[0],spec.command.slice(1),{cwd:spec.cwd,env:process.env,stdio:['ignore',out,out],detached:true,windowsHide:true});
child.once('error',error=>{process.stdout.write(JSON.stringify({error:error.message}));process.exitCode=1;});
child.once('spawn',()=>{process.stdout.write(JSON.stringify({pid:child.pid}));child.unref();fs.closeSync(out);});
