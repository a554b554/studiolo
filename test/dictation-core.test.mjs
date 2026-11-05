import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Resampler,toPcm16,rms,bytesToBase64,base64ToBytes,levelHeight,PauseDetector,Transcript,joinText,wav,downsample,RATE} from '../public/dictation-core.js';

test('resampling a stream in blocks matches resampling it whole',()=>{
 const input=Float32Array.from({length:4800},(_,i)=>Math.sin(i/7));
 const whole=new Resampler(48000).push(input);
 const blocks=new Resampler(48000),parts=[];for(let i=0;i<input.length;i+=128)parts.push(...blocks.push(input.subarray(i,i+128)));
 assert.equal(whole.length,2400);assert.ok(Math.abs(parts.length-whole.length)<=1);
 for(let i=0;i<Math.min(parts.length,whole.length);i++)assert.ok(Math.abs(parts[i]-whole[i])<1e-6,`sample ${i}`);
 const up=new Resampler(16000).push(Float32Array.from([0,1,0,-1]));assert.deepEqual([...up].map(v=>Math.round(v*100)/100),[0,0.67,0.67,0,-0.67]);
 assert.deepEqual([...new Resampler(24000).push(Float32Array.from([0.5]))],[0.5]);
});

test('PCM16, levels and base64 round trips',()=>{
 assert.deepEqual([...toPcm16(Float32Array.from([0,1,-1,2]))],[0,32767,-32767,32767]);
 assert.ok(Math.abs(rms(Float32Array.from([0.5,-0.5]))-0.5)<1e-9);assert.equal(rms(new Float32Array()),0);
 const bytes=new Uint8Array(70000).map((_,i)=>i*7);assert.deepEqual(base64ToBytes(bytesToBase64(bytes)),bytes);
 assert.equal(levelHeight(0),0);assert.equal(levelHeight(1),1);assert.ok(levelHeight(0.01)>0.3&&levelHeight(0.01)<0.5);
});

test('a pause after speech ends a turn; silence alone never does; long turns are cut',()=>{
 const run=(detector,levels)=>levels.map(l=>detector.push(l));
 const quiet=Array(40).fill(0.001),voice=Array(20).fill(0.05);
 assert.ok(!run(new PauseDetector(),quiet).some(Boolean),'no speech, no commit');
 const d=new PauseDetector(),out=run(d,[...quiet,...voice,...Array(13).fill(0.001)]);assert.ok(!out.some(Boolean),'650 ms is not a pause yet');
 assert.equal(d.push(0.001),true,'the 14th quiet frame (700 ms) ends the turn');assert.equal(d.push(0.001),false);
 const long=new PauseDetector({maxMs:1000}),cuts=run(long,[...Array(30).fill(0.05),0.001]);assert.equal(cuts.at(-1),true,'cut at the first quiet frame past maxMs');
 const nonstop=new PauseDetector({maxMs:1000}),hard=run(nonstop,Array(130).fill(0.05));assert.equal(hard.indexOf(true),119,'cut 5 s later without any quiet frame');
});

test('the transcript grows by deltas, settles by completed text and keeps turn order',()=>{
 const tr=new Transcript();
 tr.delta('a','我想');tr.delta('a','测试');assert.equal(tr.text(),'我想测试');assert.equal(tr.settled,false);
 tr.delta('b','the composer');assert.equal(tr.text(),'我想测试the composer','no space after Chinese');
 tr.completed('a','我想测试一下，');tr.delta('a','ignored after completion');assert.equal(tr.text(),'我想测试一下，the composer');
 tr.committed('c','b');tr.committed('b','a');tr.delta('c','works');assert.equal(tr.text(),'我想测试一下，the composer works','space between Latin turns');
 const crossed=new Transcript();crossed.delta('y','后');crossed.delta('x','前');crossed.committed('x',null);crossed.committed('y','x');assert.equal(crossed.text(),'前后','previous_item_id fixes crossed events');
 tr.completed('b','the composer');tr.dropUnfinished();assert.equal(tr.text(),'我想测试一下，the composer');assert.equal(tr.settled,true);
 tr.add(' 剩下的 ');assert.equal(tr.text(),'我想测试一下，the composer剩下的');
 assert.equal(joinText('hello','world'),' ');assert.equal(joinText('你好','world'),'');assert.equal(joinText('',"x"),'');assert.equal(joinText('done.','Next'),' ');
});

test('the fallback WAV is 16 kHz PCM16 mono',()=>{
 const pcm=Int16Array.from({length:RATE},(_,i)=>Math.round(Math.sin(i/5)*10000));
 const small=downsample(pcm);assert.ok(Math.abs(small.length-16000)<=1);
 const file=wav(small,16000),view=new DataView(file.buffer);
 assert.equal(String.fromCharCode(...file.subarray(0,4)),'RIFF');assert.equal(String.fromCharCode(...file.subarray(8,16)),'WAVEfmt ');
 assert.equal(view.getUint16(22,true),1);assert.equal(view.getUint32(24,true),16000);assert.equal(view.getUint32(40,true),small.length*2);assert.equal(file.length,44+small.length*2);
 assert.equal(view.getInt16(44+20,true),small[10]);
});
