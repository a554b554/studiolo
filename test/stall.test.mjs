// A server that stops running keeps its event streams open and says nothing.
// Pages and the shared worker tell that from a quiet server by the server's pings.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import vm from 'node:vm';
import {residentFloor,keepResident} from '../src/keep-resident.mjs';

class Source {
  constructor(list){this.listeners={};list.push(this);}
  addEventListener(name,fn){this.listeners[name]=fn;}
  emit(name,data='1'){this.listeners[name]?.({data});}
  close(){this.closed=true;}
}
function clock(){
  let now=1000,sequence=0;const timeouts=new Map(),intervals=new Map();
  return {now:()=>now,advance(ms){now+=ms;},timeouts,intervals,
    setTimeout:fn=>{const id=++sequence;timeouts.set(id,fn);return id;},clearTimeout:id=>timeouts.delete(id),
    setInterval:fn=>{const id=++sequence;intervals.set(id,fn);return id;},clearInterval:id=>intervals.delete(id),
    runIntervals(){for(const fn of [...intervals.values()])fn();},runTimeouts(){const list=[...timeouts.values()];timeouts.clear();for(const fn of list)fn();}};
}

test('the shared worker drops a stream that went silent after pings, and reconnects; a server that never pinged is left alone',async()=>{
  const code=await readFile(new URL('../public/events-worker.js',import.meta.url),'utf8');
  const run=()=>{
    const sources=[],messages=[],c=clock();
    const context={EventSource:class extends Source{constructor(){super(sources);}},Date:{now:c.now},setTimeout:c.setTimeout,clearTimeout:c.clearTimeout,setInterval:c.setInterval,clearInterval:c.clearInterval,self:{}};
    vm.createContext(context);vm.runInContext(code,context);
    context.self.onconnect({ports:[{start(){},postMessage:m=>messages.push(m)}]});
    return {sources,messages,c};
  };
  const {sources,messages,c}=run();
  sources[0].onopen();sources[0].emit('ping');
  c.advance(10000);c.runIntervals();assert.equal(sources.length,1);assert.equal(sources[0].closed,undefined);
  sources[0].emit('ping');c.advance(16000);c.runIntervals();
  assert.equal(sources[0].closed,true);assert.deepEqual({...messages.at(-1)},{type:'connection',online:false,stalled:true});
  c.runTimeouts();assert.equal(sources.length,2);
  // The new stream is not judged until it has pinged itself.
  c.advance(60000);c.runIntervals();assert.equal(sources[1].closed,undefined);

  const quiet=run();quiet.sources[0].onopen();quiet.c.advance(60000);quiet.c.runIntervals();
  assert.equal(quiet.sources[0].closed,undefined);
});

test('a page leaves a stalled stream to the worker, and its own direct stream falls back to polling when it goes silent',async()=>{
  const ui=await readFile(new URL('../public/ui.js',import.meta.url),'utf8');
  const listener=ui.slice(ui.indexOf('export function listenChanges('),ui.indexOf('const approvalDrafts=')).replace('export function','function');
  const page=shared=>{
    const sources=[],workers=[],c=clock(),status={textContent:'',dataset:{}};
    class Worker{constructor(){workers.push(this);this.port={postMessage(){},close(){},start(){}};}}
    const context={window:{SharedWorker:shared?Worker:undefined,addEventListener(){}},document:{hidden:false,addEventListener(){}},SharedWorker:Worker,EventSource:class extends Source{constructor(){super(sources);}},
      $:()=>status,t:x=>x,onLanguageChange:()=>{},AbortSignal,api:async()=>{throw Error('offline');},Date:{now:c.now},
      setTimeout:c.setTimeout,clearTimeout:c.clearTimeout,setInterval:c.setInterval,clearInterval:c.clearInterval};
    vm.createContext(context);vm.runInContext(listener+'; this.listenChanges=listenChanges;',context);
    context.listenChanges(()=>{});return {sources,workers,c,status};
  };
  const a=page(true),port=a.workers[0].port;
  port.onmessage({data:{type:'connection',online:true}});a.c.timeouts.clear();
  port.onmessage({data:{type:'connection',online:false,stalled:true}});
  assert.equal(a.status.dataset.online,'false');assert.equal(a.c.timeouts.size,0,'no switch to a stream of its own');

  const b=page(false);b.sources[0].onopen();b.sources[0].emit('ping');
  b.c.advance(16000);b.c.runIntervals();
  assert.equal(b.sources[0].closed,true);assert.equal(b.status.dataset.online,'false');
});

test('failover hands the open conversation and its draft over in the URL fragment, and the arriving page clears it',async()=>{
  const code=(await readFile(new URL('../public/failover.js',import.meta.url),'utf8')).replace(/^import .*$/m,'').replace(/export function/g,'function');
  let replaced=null;
  const context={location:{hash:'#from=desktop&why=failover&name=Desktop&url=http%3A%2F%2Fdesktop%3A4310&project=p1&session=s1&draft=half+a+thought',pathname:'/',search:''},history:{replaceState:(a,b,url)=>{replaced=url;}},URLSearchParams};
  vm.createContext(context);vm.runInContext(code+'; this.takeArrival=takeArrival;',context);
  assert.deepEqual({...context.takeArrival()},{from:'desktop',name:'Desktop',url:'http://desktop:4310',back:false,projectId:'p1',sessionId:'s1',draft:'half a thought'});
  assert.equal(replaced,'/');
  context.location.hash='#from=mini&why=back';assert.equal(context.takeArrival().back,true);
  context.location.hash='#something-else';assert.equal(context.takeArrival(),null);
});

test('the working-set floor is read from STUDIO_RESIDENT_MB and applied only on Windows',async()=>{
  assert.equal(residentFloor({}),1024);assert.equal(residentFloor({STUDIO_RESIDENT_MB:'off'}),0);
  assert.equal(residentFloor({STUDIO_RESIDENT_MB:'0'}),0);assert.equal(residentFloor({STUDIO_RESIDENT_MB:'768'}),768);
  assert.equal(residentFloor({STUDIO_RESIDENT_MB:'12'}),1024,'too small to mean anything');
  assert.deepEqual(await keepResident({platform:'darwin',run:()=>assert.fail('no call')}),{applied:false,reason:'not windows'});
  assert.deepEqual(await keepResident({platform:'win32',minMB:0,run:()=>assert.fail('no call')}),{applied:false,reason:'off'});
  let call;const result=await keepResident({platform:'win32',pid:4242,minMB:512,priority:false,run:(file,args,options,done)=>{call={file,args,options};done(null,'ok\r\n','');}});
  assert.equal(result.applied,true);assert.equal(call.file,'powershell.exe');
  assert.equal(call.options.env.STUDIOLO_PID,'4242');assert.equal(call.options.env.STUDIOLO_MIN,String(512*1024*1024));
  assert.match(call.args.at(-1),/SetProcessWorkingSetSizeEx/);
});

test('on Windows the floor really is set on a running process',{skip:process.platform!=='win32'},async t=>{
  const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});t.after(()=>child.kill());
  const result=await keepResident({pid:child.pid,minMB:128});
  assert.equal(result.applied,true,result.detail);assert.equal(result.cpu,'above normal');
});
