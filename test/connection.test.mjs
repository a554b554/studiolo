import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const ui=await readFile(new URL('../public/ui.js',import.meta.url),'utf8');
const listener=ui.slice(ui.indexOf('export function listenChanges('),ui.indexOf('const approvalDrafts=')).replace('export function','function');
function browser(shared=false){
  const timeouts=new Map(),intervals=new Map(),events={},changes=[],sources=[],workers=[];
  const status={textContent:'',dataset:{}}; let sequence=0,offline=false;
  class Source {constructor(){sources.push(this);}addEventListener(){} close(){this.closed=true;}}
  class Worker {constructor(){workers.push(this);this.port={postMessage(){},close(){},start(){}};}}
  const context={window:{SharedWorker:shared?Worker:undefined,addEventListener:(name,fn)=>events[name]=fn},document:{hidden:false,addEventListener:(name,fn)=>events[name]=fn},SharedWorker:Worker,EventSource:Source,
    $:()=>status,t:x=>x,onLanguageChange:()=>{},AbortSignal,
    api:async()=>{if(offline)throw Error('offline');return [];},
    setTimeout:fn=>{const id=++sequence;timeouts.set(id,fn);return id;},clearTimeout:id=>timeouts.delete(id),
    setInterval:fn=>{const id=++sequence;intervals.set(id,fn);return id;},clearInterval:id=>intervals.delete(id)};
  vm.createContext(context);vm.runInContext(listener+'; this.listenChanges=listenChanges;',context);
  const control=context.listenChanges(x=>changes.push(x));
  return {sources,workers,status,events,changes,control,context,intervals,timeouts,setOffline:value=>offline=value,
    async tick(){const pending=[...timeouts.values()];timeouts.clear();for(const fn of pending)fn();await new Promise(r=>setImmediate(r));}};
}
test('an established shared stream failing switches to direct stream and catches up',async()=>{
  const b=browser(true),port=b.workers[0].port;
  port.onmessage({data:{type:'connection',online:true}});
  port.onmessage({data:{type:'connection',online:false}});
  await b.tick();assert.equal(b.sources.length,1);
  b.sources[0].onopen();assert.equal(b.status.dataset.online,'true');assert.ok(b.changes.at(-1).reconnect);
  b.control.close();assert.equal(b.timeouts.size,0);
});
test('a previously connected direct stream falling closed switches to truthful polling',async()=>{
  const b=browser();b.sources[0].onopen();b.setOffline(true);b.sources[0].onerror();
  await b.tick();assert.equal(b.intervals.size,1);assert.equal(b.sources[0].closed,true);
  assert.equal(b.status.dataset.online,'false');
  b.setOffline(false);await [...b.intervals.values()][0]();
  assert.equal(b.status.textContent,'定时同步');assert.ok(b.changes.at(-1).reconnect);
  b.control.close();assert.equal(b.intervals.size,0);
});
test('silent worker and silent direct connection have bounded fallback',async()=>{
  const b=browser(true);await b.tick();assert.equal(b.sources.length,1);
  await b.tick();assert.equal(b.intervals.size,1);assert.equal(b.status.dataset.online,'true');b.control.close();
});
test('returning to a visible tab catches up without submitting or replaying messages',()=>{
  const b=browser(true),before=b.changes.length;
  b.context.document.hidden=true;b.events.visibilitychange();assert.equal(b.changes.length,before);
  b.context.document.hidden=false;b.events.visibilitychange();assert.equal(b.changes.length,before+1);
  b.control.close();b.events.online();assert.equal(b.changes.length,before+1);
});
