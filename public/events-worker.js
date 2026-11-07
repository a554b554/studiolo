// One authenticated event stream per browser origin, shared by all workspace/artifact tabs.
// A separate SSE per tab would exhaust HTTP/1's six-connection browser pool.
//
// A server whose process stopped running (Windows paged it out while a game took the memory)
// keeps the connection open and simply says nothing, so the stream never
// errors. The server pings every 5 s; once pings have been seen, 15 s of silence counts as a lost
// connection: the stream is dropped and reopened, and the page's failover can take over.
const clients = new Set();
const STALL = 15000;
let source = null, online = false, beat = 0, pinged = false, watchdog = null;
function broadcast(message) { for (const port of clients) { try { port.postMessage(message); } catch { clients.delete(port); } } }
function connect() {
  if (source) return;
  source = new EventSource('/api/events'); beat = Date.now(); pinged = false;
  source.onopen = () => { beat = Date.now(); online = true; broadcast({type:'connection',online}); broadcast({type:'change',value:{reconnect:true}}); };
  source.onerror = () => { online = false; broadcast({type:'connection',online}); };
  source.addEventListener('ping', () => { beat = Date.now(); pinged = true; });
  source.addEventListener('change', event => { beat = Date.now(); try { broadcast({type:'change',value:JSON.parse(event.data)}); } catch {} });
  watchdog ||= setInterval(() => {
    if (!source || !pinged || !online || Date.now() - beat < STALL) return;
    source.close(); source = null; online = false;
    broadcast({type:'connection',online,stalled:true});
    setTimeout(() => { if (clients.size) connect(); }, 1000);
  }, 3000);
}
self.onconnect = event => {
  const port = event.ports[0]; clients.add(port); port.start();
  port.postMessage({type:'connection',online}); connect();
  port.onmessage = event => { if (event.data?.type === 'close') { clients.delete(port); port.close(); if (!clients.size) { source?.close(); source = null; online = false; clearInterval(watchdog); watchdog = null; } } };
};
