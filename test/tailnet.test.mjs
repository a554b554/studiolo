import test from 'node:test';
import assert from 'node:assert/strict';
import {TailnetForwarder} from '../src/tailnet.mjs';

test('tailnet forwarding is persistent, idempotent and preserves other services',async()=>{
  const config={TCP:{80:{HTTP:true}},Web:{'example:80':{Handlers:{'/':{Proxy:'http://127.0.0.1:3000'}}}}},calls=[];
  const forwarder=new TailnetForwarder({run:async args=>{
    calls.push(args);
    if(args[1]==='status')return JSON.stringify(config);
    assert.equal(args[1],'--bg');assert.ok(!args.includes('reset'));assert.equal(args[0],'serve');
    const port=args[2].slice(6);config.TCP[port]={TCPForward:args[3].slice(6)};return '';
  }});
  await Promise.all([forwarder.expose(4310),forwarder.expose(4310),forwarder.expose(50000)]);
  assert.equal(calls.filter(args=>args[1]==='--bg').length,2);
  assert.deepEqual(config.TCP[80],{HTTP:true});assert.equal(config.Web['example:80'].Handlers['/'].Proxy,'http://127.0.0.1:3000');
  assert.equal(config.TCP[50000].TCPForward,'127.0.0.1:50000');
});
test('conflicting or public forwarding is refused without mutations',async()=>{
  for(const config of [{TCP:{4310:{HTTP:true}}},{TCP:{4310:{TCPForward:'127.0.0.1:9999'}}},{TCP:{4310:{TCPForward:'127.0.0.1:4310'}},AllowFunnel:{'example:4310':true}}]){
    const calls=[];const forwarder=new TailnetForwarder({run:async args=>{calls.push(args);return JSON.stringify(config);}});
    await assert.rejects(forwarder.expose(4310));assert.equal(calls.length,1);
  }
});
test('failed forwarding can retry and successful command output must be verified',async()=>{
  let unavailable=true;const forwarder=new TailnetForwarder({run:async()=>{if(unavailable)throw new Error('offline');return '{}';}});
  await assert.rejects(forwarder.expose(4310),/offline/);unavailable=false;
  await assert.rejects(forwarder.expose(4310),/verification failed/);
  await assert.rejects(forwarder.expose(0),/Invalid/);
});
