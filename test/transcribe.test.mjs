import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {OpenAITranscriber,OPENAI_TRANSCRIBE_URL,DEFAULT_KEYWORDS,mask,audioFormat,transcribeOptions} from '../src/transcribe.mjs';
import {createStudio} from '../src/server.mjs';

const b64=obj=>Buffer.from(JSON.stringify(obj)).toString('base64url');
const FAKE_TOKEN=`eyJhbGciOiJSUzI1NiJ9.${b64({sub:'user',exp:4102444800})}.sigsigsig`;

const reply=(status,body)=>new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
// Scripted fetch: each entry is a Response, or an Error to throw (network failure).
function fakeFetch(script){
  const calls=[];
  const fetch=async(url,init)=>{calls.push({url,init,headers:init.headers,form:init.body});const next=script.shift();if(next===undefined)throw new Error('unexpected fetch call');if(next instanceof Error)throw next;return next;};
  return {fetch,calls};
}

const audio={bytes:Buffer.from('RIFF....WAVEfake'),mime:'audio/webm',fileName:'audio.webm'};

test('audio formats map to upload file names and unknown types are refused',()=>{
 assert.deepEqual(audioFormat('audio/webm;codecs=opus'),{mime:'audio/webm',fileName:'audio.webm'});
 assert.deepEqual(audioFormat('audio/mp4'),{mime:'audio/mp4',fileName:'audio.m4a'});
 assert.deepEqual(audioFormat('audio/x-wav'),{mime:'audio/wav',fileName:'audio.wav'});
 assert.deepEqual(audioFormat('audio/ogg; codecs=opus'),{mime:'audio/ogg',fileName:'audio.ogg'});
 for(const bad of ['','text/plain','application/octet-stream','audio/',undefined])assert.throws(()=>audioFormat(bad),e=>e.status===415,String(bad));
 assert.deepEqual(transcribeOptions(new URL('http://x/api/transcribe?duration_ms=1234&language=zh')),{durationMs:1234,language:'zh'});
 assert.deepEqual(transcribeOptions(new URL('http://x/api/transcribe?duration_ms=-1&language=<script>')),{durationMs:undefined,language:undefined});
 assert.deepEqual(transcribeOptions(new URL('http://x/api/transcribe'),{'x-studio-duration-ms':'50','x-studio-language':'en-US'}),{durationMs:50,language:'en-US'});
 assert.equal(mask(`Authorization: Bearer ${FAKE_TOKEN} and ${FAKE_TOKEN}`),'Authorization: Bearer […] and eyJ…');
});

const runner={profiles:async()=>[{id:'fake',label:'test',available:true,models:[{id:'test',label:'Test'}]}],execute:async()=>({text:'x'})};
test('POST /api/transcribe enforces origin, size and content type and returns only the text',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-transcribe-'));
 const f=fakeFetch([reply(200,{text:' typed by voice '}),reply(400,{error:{message:'Audio file is too short'}})]);
 const keyFile=path.join(dir,'openai-api-key.txt');await fs.writeFile(keyFile,'sk-test-abcdefghijklmnop\n');
 const app=await createStudio({stateDir:path.join(dir,'state'),projectRoot:path.join(dir,'projects'),port:0,previewPort:0,runner,openaiTranscriber:new OpenAITranscriber({keyFile,fetch:f.fetch,sleep:async()=>{}}),transcribeLimit:64});
 t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.port}`;
 const send=(body,headers={},query='')=>fetch(`${base}/api/transcribe${query}`,{method:'POST',headers:{'Content-Type':'audio/webm;codecs=opus',...headers},body});
 const ok=await send('x'.repeat(40),{},'?duration_ms=800');
 assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{text:'typed by voice'});
 assert.equal(f.calls[0].form.get('file').name,'audio.webm');
 const short=await send('x'.repeat(5));assert.equal(short.status,422);assert.equal((await short.json()).error,'录音太短');
 assert.equal((await send('x'.repeat(65))).status,413);
 const declared=await new Promise((resolve,reject)=>{const req=http.request(`${base}/api/transcribe`,{method:'POST',headers:{'Content-Type':'audio/webm','Content-Length':'9999'}},res=>{resolve(res.statusCode);req.destroy();});req.on('error',reject);req.write('x');});
 assert.equal(declared,413);
 assert.equal((await send('x'.repeat(10),{'Content-Type':'text/plain'})).status,415);
 assert.equal((await send('')).status,400);
 assert.equal((await send('x'.repeat(10),{Origin:'https://evil.example'})).status,403);
 assert.equal((await fetch(`${base}/api/transcribe`)).status,404);
 assert.equal(f.calls.length,2,'rejected requests never reach the transcription service');
});

test('without a transcription key the route says how to set one up, and bootstrap hides the microphone',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-transcribe-off-'));
 const off=await createStudio({stateDir:path.join(dir,'state'),projectRoot:path.join(dir,'projects'),port:0,previewPort:0,runner});
 t.after(async()=>{await off.close();await fs.rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${off.port}`;
 const gone=await fetch(`${base}/api/transcribe`,{method:'POST',headers:{'Content-Type':'audio/webm'},body:'x'.repeat(40)});
 assert.equal(gone.status,503);assert.match((await gone.json()).error,/语音转写/);
 assert.equal((await (await fetch(`${base}/api/bootstrap`)).json()).features.voiceInput,false);
});

const OPENAI_KEY='sk-test-abcdefghijklmnop';
async function keyFile(t,content=OPENAI_KEY+'\n'){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-openai-key-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'openai-api-key.txt');
  if(content!==null)await fs.writeFile(file,content);
  return file;
}
const makeOpenAI=async(t,script,{content,...extra}={})=>{const f=fakeFetch(script);const delays=[];const transcriber=new OpenAITranscriber({keyFile:await keyFile(t,content),fetch:f.fetch,sleep:async ms=>{delays.push(ms);},...extra});return {transcriber,calls:f.calls,delays};};

test('OpenAI transcription sends the public API request with both language hints and keywords',async t=>{
 const {transcriber,calls}=await makeOpenAI(t,[reply(200,{text:' 把 Studiolo 的 artifact 预览改一下 ',languages:[{code:'zh'}],usage:{type:'duration',seconds:3}})]);
 assert.equal(await transcriber.available(),true);
 assert.deepEqual(await transcriber.transcribe({bytes:Buffer.from('m4a'),mime:'audio/mp4',fileName:'audio.m4a',durationMs:900,keywords:['我的项目','Studiolo']}),{text:'把 Studiolo 的 artifact 预览改一下'});
 const {url,init,headers,form}=calls[0];
 assert.equal(url,OPENAI_TRANSCRIBE_URL);assert.equal(init.method,'POST');assert.ok(init.signal instanceof AbortSignal);
 assert.equal(headers.Authorization,`Bearer ${OPENAI_KEY}`,'key file is trimmed');
 assert.equal(form.get('model'),'gpt-transcribe');assert.equal(form.get('response_format'),'json');assert.match(form.get('prompt'),/中英夹杂/);
 const file=form.get('file');assert.equal(file.name,'audio.m4a');assert.equal(file.type,'audio/mp4');
 assert.deepEqual(form.getAll('languages[]'),['zh','en']);
 assert.deepEqual(form.getAll('keywords[]'),[...DEFAULT_KEYWORDS,'我的项目'],'client keywords are appended once');
 assert.equal(form.get('duration_ms'),null,'duration is not sent to OpenAI');
 const english=await makeOpenAI(t,[reply(200,{text:'hi'})],{model:'gpt-other'});
 await english.transcriber.transcribe({...audio,language:'en'});
 assert.deepEqual(english.calls[0].form.getAll('languages[]'),['en']);assert.equal(english.calls[0].form.get('model'),'gpt-other');assert.equal(english.calls[0].form.get('file').name,'audio.webm');
});

test('OpenAI errors map to client-safe statuses and never echo the key',async t=>{
 const missing=await makeOpenAI(t,[],{content:null});
 assert.equal(await missing.transcriber.available(),false);
 await assert.rejects(missing.transcriber.transcribe(audio),e=>e.status===503);
 const blank=await makeOpenAI(t,[],{content:'  \n'});assert.equal(await blank.transcriber.available(),false);
 assert.equal(missing.calls.length+blank.calls.length,0);
 const short=await makeOpenAI(t,[reply(400,{error:{message:'Audio file is too short. Minimum audio length is 0.1 seconds.',code:'audio_too_short'}})]);
 await assert.rejects(short.transcriber.transcribe(audio),e=>e.status===422&&e.message==='录音太短');
 const bad=await makeOpenAI(t,[reply(401,{error:{message:`Incorrect API key provided: ${OPENAI_KEY}`}})]);
 await assert.rejects(bad.transcriber.transcribe(audio),e=>e.status===502&&/openai-api-key/.test(e.message)&&!e.message.includes(OPENAI_KEY));
 assert.equal(bad.calls.length,1,'a rejected key is not retried');
 const quota=await makeOpenAI(t,[reply(429,{error:{code:'insufficient_quota'}})]);
 await assert.rejects(quota.transcriber.transcribe(audio),e=>e.status===429&&/额度/.test(e.message));
 const flaky=await makeOpenAI(t,[reply(503,''),new TypeError('fetch failed'),reply(200,{text:'ok'})]);
 assert.deepEqual(await flaky.transcriber.transcribe(audio),{text:'ok'});assert.deepEqual(flaky.delays,[500,1000]);
 assert.equal(mask(`key ${OPENAI_KEY}`),'key sk-…');
 assert.deepEqual(transcribeOptions(new URL('http://x/api/transcribe?keyword=%E9%A1%B9%E7%9B%AE&keyword=a%3Cb&keyword=+&keyword=x')).keywords,['项目','x']);
 assert.equal(transcribeOptions(new URL('http://x/api/transcribe')).keywords,undefined);
});

test('the OpenAI key file turns the route, the microphone and features.transcribe on',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-transcribe-openai-'));
 const state=path.join(dir,'state');
 const f=fakeFetch([reply(200,{text:'语音'})]);
 const app=await createStudio({stateDir:state,projectRoot:path.join(dir,'projects'),port:0,previewPort:0,runner,openaiTranscriber:new OpenAITranscriber({keyFile:path.join(state,'openai-api-key.txt'),fetch:f.fetch})});
 t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.port}`;
 const features=async()=>(await (await fetch(`${base}/api/bootstrap`)).json()).features;
 const post=()=>fetch(`${base}/api/transcribe?keyword=Demo`,{method:'POST',headers:{'Content-Type':'audio/mp4'},body:'x'.repeat(40)});
 assert.deepEqual(await features(),{voiceInput:false,transcribe:false,deviceAllowlist:false});
 assert.equal((await post()).status,503);
 await fs.writeFile(path.join(state,'openai-api-key.txt'),OPENAI_KEY);
 assert.deepEqual(await features(),{voiceInput:true,transcribe:true,deviceAllowlist:false},'picked up without a restart');
 const ok=await post();assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{text:'语音'});
 assert.ok(f.calls[0].form.getAll('keywords[]').includes('Demo'));
});

test('Settings → 语音转写 keeps one key on one machine, and every other server forwards recordings there',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-transcribe-hosts-'));const apps=[];
 t.after(async()=>{for(const app of apps)await app.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
 const openai=async url=>String(url).endsWith('/v1/models')?reply(200,{data:[]}):reply(200,{text:'从另一台机器转写'});
 const make=async label=>{const state=path.join(root,label,'state');const app=await createStudio({stateDir:state,projectRoot:path.join(root,label,'projects'),port:0,previewPort:0,runner,openaiTranscriber:new OpenAITranscriber({keyFile:path.join(state,'openai-api-key.txt'),fetch:openai})});apps.push(app);const base=`http://127.0.0.1:${app.port}`;const api=async(url,method='GET',data)=>{const res=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const out=await res.json();if(!res.ok)throw Object.assign(Error(out.error),{status:res.status});return out;};return {app,base,api,state};};
 const a=await make('A'),b=await make('B');await a.api('/api/hosts','POST',{url:b.base});
 const key='sk-test-'+'k'.repeat(30);
 await assert.rejects(a.api('/api/settings/transcription','PUT',{hostId:b.app.hostId,apiKey:'nonsense'}),/sk-/);
 const saved=await a.api('/api/settings/transcription','PUT',{hostId:b.app.hostId,apiKey:key});
 assert.deepEqual([saved.hostId,saved.hint],[b.app.hostId,'…kkkk']);
 assert.equal((await fs.readFile(path.join(b.state,'openai-api-key.txt'),'utf8')).trim(),key,'the key lives on the chosen machine');
 await assert.rejects(fs.access(path.join(a.state,'openai-api-key.txt')),'and nowhere else');
 assert.equal((await a.api('/api/bootstrap')).features.voiceInput,true);
 const response=await fetch(`${a.base}/api/transcribe?keyword=Demo`,{method:'POST',headers:{'Content-Type':'audio/mp4'},body:'x'.repeat(40)});
 assert.deepEqual(await response.json(),{text:'从另一台机器转写'},'forwarded to B');
 await a.api('/api/settings/transcription','PUT',{hostId:a.app.hostId,apiKey:key});
 await assert.rejects(fs.access(path.join(b.state,'openai-api-key.txt')),'moving it removes the old copy');
 assert.equal((await b.api('/api/settings/transcription')).hostId,a.app.hostId,'B now sends recordings to A');
 await b.api('/api/settings/transcription','DELETE');
 assert.equal((await a.api('/api/settings/transcription')).hostId,null);
});
