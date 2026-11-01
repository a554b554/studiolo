// Speech-to-text for the chat and comment composers (README「语音输入」). The browser records with
// MediaRecorder and posts the raw blob to POST /api/transcribe. One machine keeps an OpenAI API key
// (<stateDir>/openai-api-key.txt, set in Settings → 语音转写) and transcribes for every server; the
// others forward their recordings to it. Audio is never written to disk and the key stays in memory.
import fs from 'node:fs/promises';
import path from 'node:path';
import {httpError} from './paths.mjs';

export const DEFAULT_LIMIT=25*1024*1024;
const RETRYABLE=new Set([0,408,500,502,503,504]);
const MAX_RETRIES=3;
const FILE_NAMES={webm:'audio.webm',mp4:'audio.m4a',wav:'audio.wav',ogg:'audio.ogg',mpeg:'audio.mp3',aac:'audio.aac'};
const SUBTYPES={webm:'webm','x-matroska':'webm',mp4:'mp4','x-m4a':'mp4',m4a:'mp4',aac:'aac',wav:'wav','x-wav':'wav',wave:'wav','vnd.wave':'wav',ogg:'ogg',mpeg:'mpeg',mp3:'mpeg'};
const sleepMs=ms=>new Promise(r=>setTimeout(r,ms));

// JWTs, API keys and bearer values must never reach logs, error messages or response bodies.
export const mask=text=>String(text??'').replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi,'Bearer […]').replace(/eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){0,2}/g,'eyJ…').replace(/sk-[A-Za-z0-9_-]{6,}/g,'sk-…');

// "audio/webm;codecs=opus" → {mime:'audio/webm', fileName:'audio.webm'}; unknown types are refused.
export function audioFormat(contentType){
  const base=String(contentType||'').split(';')[0].trim().toLowerCase();
  const match=/^(?:audio|video)\/([\w.+-]+)$/.exec(base);
  const kind=match&&SUBTYPES[match[1]];
  if(!kind)throw httpError('不支持的音频格式',415);
  return {mime:`audio/${kind}`,fileName:FILE_NAMES[kind]};
}

// Read a raw audio request body, bounded like uploads: refuse a declared oversize early and
// stop reading as soon as the stream passes the limit.
export async function readAudio(req,{limit=DEFAULT_LIMIT}={}){
  const format=audioFormat(req.headers['content-type']);
  const mb=Math.round(limit/1024/1024);
  const declared=Number(req.headers['content-length']);
  if(Number.isFinite(declared)&&declared>limit)throw httpError(`录音超过 ${mb} MB 上限`,413);
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw httpError(`录音超过 ${mb} MB 上限`,413);chunks.push(chunk);}
  if(!size)throw httpError('没有收到录音');
  return {...format,bytes:Buffer.concat(chunks)};
}

// The public OpenAI transcription API. Speech is mostly Chinese with English technical terms,
// so both languages are hinted and the usual vocabulary goes in as keywords; the client may add
// a few of its own (project and session names). The key is re-read for every recording, so
// replacing openai-api-key.txt needs no restart; it never leaves this process.
export const OPENAI_TRANSCRIBE_URL='https://api.openai.com/v1/audio/transcriptions';
export const OPENAI_MODEL='gpt-transcribe';
const OPENAI_PROMPT='一段中英夹杂的口述，多为软件开发和 AI agent 相关内容。英文术语保留原样，中文用简体，加上标点。';
export const DEFAULT_KEYWORDS=['Studiolo','Artifact','Claude','Claude Code','Codex','SwiftUI','Xcode','Tailscale','iPhone','iPad','agent','session','prompt','commit'];

export class OpenAITranscriber{
  constructor({keyFile,fetch=globalThis.fetch,model=OPENAI_MODEL,timeoutMs=30000,sleep=sleepMs}={}){
    Object.assign(this,{keyFile,fetch,model,timeoutMs,sleep});
  }
  async readKey(){
    try{return (await fs.readFile(this.keyFile,'utf8')).trim()||null;}
    catch(error){if(error.code==='ENOENT')return null;throw httpError('OpenAI API key 文件无法读取',500);}
  }
  async available(){try{return Boolean(await this.readKey());}catch{return false;}}
  async hint(){const key=await this.readKey().catch(()=>null);return key?'…'+key.slice(-4):null;}
  // Settings → 语音转写: the key is checked against OpenAI before it is kept, and only on this machine.
  async saveKey(key){
    key=String(key??'').trim();if(!/^sk-[A-Za-z0-9_-]{16,}$/.test(key))throw httpError('OpenAI API key 格式不对，应以 sk- 开头');
    let response;try{response=await this.fetch('https://api.openai.com/v1/models',{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(15000)});}catch{throw httpError('无法连接 OpenAI，请检查网络后重试',502);}
    if(response.status===401||response.status===403)throw httpError('OpenAI 不接受这个 API key',422);
    if(!response.ok)throw httpError(`OpenAI 验证失败（HTTP ${response.status}）`,502);
    await fs.mkdir(path.dirname(this.keyFile),{recursive:true});await fs.writeFile(this.keyFile,key+'\n',{mode:0o600});
  }
  async removeKey(){await fs.rm(this.keyFile,{force:true});}
  async transcribe({bytes,mime,fileName,language,keywords=[]}){
    if(!bytes?.length)throw httpError('没有收到录音');
    const key=await this.readKey();
    if(!key)throw httpError('此服务器没有配置 OpenAI API key',503);
    const words=[...new Set([...DEFAULT_KEYWORDS,...keywords])];
    let retries=0;
    while(true){
      const form=new FormData();
      form.append('file',new Blob([bytes],{type:mime}),fileName);
      form.append('model',this.model);
      form.append('response_format','json');
      form.append('prompt',OPENAI_PROMPT);
      for(const code of language?[language]:['zh','en'])form.append('languages[]',code);
      for(const word of words)form.append('keywords[]',word);
      let response;
      try{response=await this.fetch(OPENAI_TRANSCRIBE_URL,{method:'POST',headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},body:form,signal:AbortSignal.timeout(this.timeoutMs)});}
      catch(error){
        if(retries<MAX_RETRIES){await this.sleep(500*2**retries++);continue;}
        console.error('[transcribe] network error: '+mask(error?.message));
        throw httpError('转写服务无法连接，请检查网络后重试',502);
      }
      if(response.ok){
        let data;try{data=await response.json();}catch{throw httpError('转写服务返回了无法解析的结果',502);}
        return {text:String(data?.text??'').trim()};
      }
      const detail=mask(await response.text().catch(()=>'')).slice(0,300);
      if(response.status===400&&/too short|audio_too_short/i.test(detail))throw httpError('录音太短',422);
      if(RETRYABLE.has(response.status)&&retries<MAX_RETRIES){await this.sleep(500*2**retries++);continue;}
      console.error(`[transcribe] OpenAI HTTP ${response.status} ${detail}`);
      // Upstream 401/403 are reported as 502 so clients never mistake them for a Studiolo sign-in problem.
      if(response.status===401)throw httpError('OpenAI API key 无效，请检查服务器上的 openai-api-key.txt',502);
      if(response.status===403)throw httpError('OpenAI 拒绝了这个 API key 的请求',502);
      if(response.status===429)throw httpError(/insufficient_quota/.test(detail)?'OpenAI API 额度不足':'转写请求过于频繁，请稍后再试',429);
      throw httpError('转写服务暂时不可用，请稍后再试',502);
    }
  }
}

// Optional request metadata: an integer millisecond duration, a short language tag and up to
// ten extra keywords (repeated ?keyword=…; OpenAI refuses <, > and line breaks in them).
export function transcribeOptions(url,headers={}){
  const duration=Number(url.searchParams.get('duration_ms')??headers['x-studio-duration-ms']);
  const language=String(url.searchParams.get('language')??headers['x-studio-language']??'').trim();
  const keywords=url.searchParams.getAll('keyword').map(k=>k.trim()).filter(k=>k&&k.length<=60&&!/[<>\r\n]/.test(k)).slice(0,10);
  return {durationMs:Number.isInteger(duration)&&duration>=0&&duration<=3600000?duration:undefined,language:/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)?language:undefined,...(keywords.length?{keywords}:{})};
}
