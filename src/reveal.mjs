import {spawn as nodeSpawn} from 'node:child_process';
import path from 'node:path';

// "Show in File Explorer" (0.2.4): the server opens the operating system's file manager on its own
// desktop, so it only makes sense when the page asking is on this same machine (server.mjs checks
// that and that the project's files are here). A file is selected in its folder; a folder is opened.
export function revealCommand(target,{directory=false,platform=process.platform}={}){
  if(platform==='win32')return {command:'explorer.exe',args:[directory?`"${target}"`:`/select,"${target}"`],options:{windowsVerbatimArguments:true}};
  if(platform==='darwin')return {command:'open',args:directory?[target]:['-R',target],options:{}};
  return {command:'xdg-open',args:[directory?target:path.dirname(target)],options:{}};
}
export function reveal(target,{directory=false,platform=process.platform,spawn=nodeSpawn}={}){
  const {command,args,options}=revealCommand(target,{directory,platform});
  return new Promise((resolve,reject)=>{
    // explorer.exe exits 1 even when it worked, so only a failure to start counts.
    const child=spawn(command,args,{...options,detached:true,stdio:'ignore',windowsHide:false});
    child.once('error',error=>reject(Object.assign(new Error(`无法打开文件管理器：${error.message}`),{status:500})));
    child.once('spawn',()=>{child.unref();resolve();});
  });
}
// The name the menu uses on this machine.
export const fileManager=(platform=process.platform)=>platform==='win32'?'explorer':platform==='darwin'?'finder':'files';
