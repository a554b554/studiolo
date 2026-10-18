// One authenticated event stream per browser origin, shared by all workspace/artifact tabs.
// A separate SSE per tab would exhaust HTTP/1's six-connection browser pool.
const clients = new Set();
let source = null, online = false;
function broadcast(message) { for (const port of clients) { try { port.postMessage(message); } catch { clients.delete(port); } } }
function connect() {
  if (source) return;
  source = new EventSource('/api/events');
  source.onopen = () => { online = true; broadcast({type:'connection',online}); broadcast({type:'change',value:{reconnect:true}}); };
  source.onerror = () => { online = false; broadcast({type:'connection',online}); };
  source.addEventListener('change', event => { try { broadcast({type:'change',value:JSON.parse(event.data)}); } catch {} });
}
self.onconnect = event => {
  const port = event.ports[0]; clients.add(port); port.start();
  port.postMessage({type:'connection',online}); connect();
  port.onmessage = event => { if (event.data?.type === 'close') { clients.delete(port); port.close(); if (!clients.size) { source?.close(); source = null; online = false; } } };
};
