import { t } from './i18n.js';
import { RATE, PauseDetector, Transcript, joinText, levelHeight, bytesToBase64, base64ToBytes, wav, downsample } from './dictation-core.js';

// Voice input shared by the chat composer and the Artifact comment composer, mounted when the server reports
// features.voiceInput (a machine has the OpenAI key from Settings → 语音转写; README「语音输入」).
// A tap on the microphone swaps the composer's controls for a bar with a live waveform, ✕ (cancel)
// and ✓ (keep). What is said streams into the textarea at the caret as it is recognised, like an
// input method: the page sends 24 kHz PCM straight to OpenAI's realtime transcription with a
// short-lived secret from /api/transcribe/realtime and commits a turn at each pause.
// Without a realtime connection the audio is kept and transcribed as a
// whole by /api/transcribe on ✓. Esc cancels, Enter keeps; nothing is sent.
const MIN_TURN = RATE * 0.3;          // shorter audio is not committed on its own
const SETTLE_MS = 4000;               // how long ✓ waits for the last turns' final text
const BAR_STEP = 5;                   // px per waveform bar
const IDLE_TITLE = '语音输入（点一下开始）';
const UNSUPPORTED_TITLE = '麦克风需要 HTTPS 或在本机 127.0.0.1 打开';
const MIC = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';

// getUserMedia and AudioWorklet only exist in secure contexts (HTTPS, localhost, 127.0.0.1). Without
// them the desktop client records natively (desktop/src-tauri/src/recorder.rs) and streams the
// same frames over a Tauri channel: this is how the Mac client gets a microphone on a plain-http
// tailnet server. A client older than 0.2.3 can only hand over a WAV file at the end.
const browserRecording = () => Boolean(globalThis.navigator?.mediaDevices?.getUserMedia && globalThis.AudioWorkletNode);
const tauri = () => browserRecording() ? null : globalThis.__TAURI__?.core?.invoke ? globalThis.__TAURI__.core : null;
export const dictationSupported = () => browserRecording() || Boolean(tauri());

const keywordQuery = keywords => { const params = new URLSearchParams(); for (const word of keywords || []) if (word) params.append('keyword', word); return [...params.keys()].length ? `?${params}` : ''; };
export async function transcribeBlob(blob, { keywords } = {}) {
  const response = await fetch(`/api/transcribe${keywordQuery(keywords)}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return data;
}
async function realtimeSecret(keywords) {
  const response = await fetch(`/api/transcribe/realtime${keywordQuery(keywords)}`, { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return data;
}
function describeMediaError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return t('麦克风权限被拒绝，请在浏览器中允许麦克风后重试');
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return t('没有找到麦克风');
  if (error?.name === 'NotReadableError') return t('麦克风正被其他应用占用');
  return t('无法打开麦克风：{error}', { error: error?.message || String(error) });
}
const concat = chunks => { const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; } return out; };
const unknownCommand = error => /not (?:found|allowed)/i.test(String(error));

// Microphone frames (PCM16 at 24 kHz, and levels) from the browser or the desktop client. Resolves
// to {stop}, or {legacy, stop, take} when the client can only hand over a whole recording.
async function openMicrophone(onFrame, context) {
  const core = tauri();
  if (core) {
    const channel = new core.Channel();
    channel.onmessage = frame => onFrame(new Int16Array(base64ToBytes(frame.pcm).buffer), frame.levels);
    try { await core.invoke('start_streaming', { onAudio: channel }); return { stop: () => core.invoke('cancel_recording').catch(() => {}) }; }
    catch (error) {
      if (!unknownCommand(error)) throw new Error(t(String(error)));
      try { await core.invoke('start_recording'); }
      catch (old) { throw new Error(unknownCommand(old) ? t('请更新桌面客户端后使用语音输入') : t(String(old))); }
      return { legacy: true, stop: () => core.invoke('cancel_recording').catch(() => {}), take: async () => new Blob([await core.invoke('stop_recording')], { type: 'audio/wav' }) };
    }
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (error) { context.close().catch(() => {}); throw new Error(describeMediaError(error)); }
  try {
    await context.audioWorklet.addModule(new URL('./dictation-worklet.js', import.meta.url));
    const source = context.createMediaStreamSource(stream), capture = new AudioWorkletNode(context, 'studiolo-capture');
    capture.port.onmessage = ({ data }) => onFrame(new Int16Array(data.pcm), data.levels);
    source.connect(capture); capture.connect(context.destination);
    if (context.state === 'suspended') await context.resume();
    return { stop: () => { capture.port.onmessage = null; source.disconnect(); capture.disconnect(); stream.getTracks().forEach(track => track.stop()); context.close().catch(() => {}); } };
  } catch { stream.getTracks().forEach(track => track.stop()); context.close().catch(() => {}); throw new Error(t('这个浏览器不支持录音')); }
}

export function mountDictation({ button, textarea, controls, onError = () => {}, keywords = () => [], maxMs = 600000 }) {
  if (!button || !textarea) return { supported: false, cancel() {}, settle() {}, confirm() {}, setEnabled() {}, active: false };
  const supported = dictationSupported();
  button.innerHTML = MIC;
  const bar = document.createElement('div'); bar.className = 'dictation-bar'; bar.hidden = true;
  const wave = document.createElement('canvas'); wave.className = 'dictation-wave'; wave.setAttribute('aria-hidden', 'true');
  const note = document.createElement('span'); note.className = 'dictation-note'; note.setAttribute('aria-live', 'polite');
  const cancelButton = document.createElement('button'), confirmButton = document.createElement('button');
  cancelButton.type = confirmButton.type = 'button';
  cancelButton.className = 'dictation-cancel'; cancelButton.innerHTML = CROSS;
  confirmButton.className = 'dictation-confirm'; confirmButton.innerHTML = CHECK;
  const label = (el, key) => { el.title = t(key); el.setAttribute('aria-label', t(key)); el.setAttribute('data-i18n-title', key); el.setAttribute('data-i18n-aria-label', key); };
  label(cancelButton, '取消语音输入（Esc）'); label(confirmButton, '完成语音输入（Enter）');
  bar.append(wave, note, cancelButton, confirmButton);
  (controls || button).after(bar);
  let enabled = true, s = null;
  const setTitle = key => { button.setAttribute('data-i18n-title', key); button.title = t(key); };
  const sync = () => { button.disabled = !supported || !enabled; button.setAttribute('aria-pressed', String(Boolean(s))); };
  const say = text => { note.textContent = text || ''; note.hidden = !text; };

  // Waveform: one bar per 50 ms level, newest on the right; quiet frames are dots.
  let painting = 0;
  const paint = () => {
    painting = 0; if (!s) return;
    const ratio = globalThis.devicePixelRatio || 1, width = wave.clientWidth, height = wave.clientHeight;
    if (wave.width !== Math.round(width * ratio) || wave.height !== Math.round(height * ratio)) { wave.width = Math.round(width * ratio); wave.height = Math.round(height * ratio); }
    const ctx = wave.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = getComputedStyle(wave).color;
    const count = Math.floor(width / BAR_STEP), levels = s.levels.slice(-count), offset = count - levels.length;
    for (let i = 0; i < count; i++) {
      const level = levels[i - offset], x = i * BAR_STEP + BAR_STEP / 2, size = level === undefined ? 0 : levelHeight(level) * (height - 6);
      ctx.globalAlpha = size < 3 ? 0.45 : 0.9;
      if (size < 3) { ctx.beginPath(); ctx.arc(x, height / 2, 1.1, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(x - 1, (height - size) / 2, 2, size);
    }
  };
  const repaint = () => { painting ||= requestAnimationFrame(paint); };

  // The dictated text replaces what was selected when the microphone was tapped and grows there.
  let inputTimer = 0;
  const notify = () => { clearTimeout(inputTimer); inputTimer = 0; textarea.dispatchEvent(new Event('input', { bubbles: true })); };
  const render = () => {
    const text = s.transcript.text(), value = text ? joinText(s.before, text) + text : '';
    if (textarea.value.slice(s.start, s.start + s.length) === value && s.length === value.length) return;
    const follow = textarea.scrollHeight - textarea.scrollTop - textarea.clientHeight < 40;
    textarea.setRangeText(value, s.start, s.start + s.length, 'end'); s.length = value.length;
    if (follow) textarea.scrollTop = textarea.scrollHeight;
    inputTimer ||= setTimeout(notify, 250);
  };

  // Realtime connection: frames queue until it opens; a turn is committed at each pause.
  const open = () => s?.ws?.readyState === 1; // WebSocket.OPEN
  const send = () => { while (open() && s.sent < s.chunks.length) { const chunk = s.chunks[s.sent++]; s.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: bytesToBase64(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)) })); s.sentSamples += chunk.length; } };
  const commit = (min = MIN_TURN) => { if (!open() || s.sentSamples - s.turnStart < min) return; s.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); s.commits.push({ start: s.turnStart, item: null }); s.turnStart = s.sentSamples; };
  const settled = () => s.commits.every(c => c.item && s.done.has(c.item)) && s.transcript.settled;
  // Where the audio without final text starts: it is transcribed as a whole if the connection fails.
  const tailStart = () => s.commits.find(c => !c.item || !s.done.has(c.item))?.start ?? s.turnStart;
  const fail = message => {
    if (!s || s.realtime === 'failed') return;
    s.realtime = 'failed'; try { s.ws?.close(); } catch {}
    s.transcript.dropUnfinished(); render();
    say(message || t('实时转写不可用，结束后整段转写'));
    s.whenSettled?.();
  };
  const onEvent = event => {
    const done = () => { render(); if (settled()) s.whenSettled?.(); };
    switch (event.type) {
      case 'input_audio_buffer.committed': { const pending = s.commits.find(c => !c.item); if (pending) pending.item = event.item_id; s.transcript.committed(event.item_id, event.previous_item_id); return; }
      case 'conversation.item.input_audio_transcription.delta': s.transcript.delta(event.item_id, event.delta); render(); return;
      case 'conversation.item.input_audio_transcription.completed': s.transcript.completed(event.item_id, event.transcript); s.done.add(event.item_id); done(); return;
      case 'conversation.item.input_audio_transcription.failed': s.done.add(event.item_id); s.transcript.completed(event.item_id); done(); return;
      case 'error': if (!/commit_empty|buffer too small/i.test(`${event.error?.code} ${event.error?.message}`)) { console.warn('[dictation]', event.error); fail(t('实时转写出错，结束后整段转写')); } return;
    }
  };
  async function connect(current) {
    let secret;
    try { secret = await realtimeSecret(keywords()); }
    catch (error) { if (s === current) fail(error.status === 404 ? undefined : t('实时转写不可用：{error}', { error: t(error.message) })); return; }
    if (s !== current || s.phase !== 'live') return;
    const ws = new WebSocket(secret.url, ['realtime', `openai-insecure-api-key.${secret.value}`]); s.ws = ws;
    ws.onopen = () => { if (s !== current) return ws.close(); s.realtime = 'open'; send(); };
    ws.onmessage = ({ data }) => { if (s !== current) return; let event; try { event = JSON.parse(data); } catch { return; } onEvent(event); };
    ws.onclose = () => { if (s === current && s.realtime !== 'failed') fail(); };
  }
  const frame = (pcm, levels) => {
    if (!s || s.phase !== 'live') return;
    s.chunks.push(pcm); s.samples += pcm.length; send();
    for (const level of levels || []) { s.levels.push(level); if (s.detector.push(level)) commit(); }
    if (s.levels.length > 2000) s.levels.splice(0, 1000);
    repaint();
  };

  async function start() {
    if (s || button.disabled) return;
    // Created inside the tap, so the audio context may start without another gesture.
    const context = tauri() ? null : new AudioContext();
    const selStart = textarea.selectionStart ?? textarea.value.length, selEnd = textarea.selectionEnd ?? selStart;
    s = { phase: 'starting', original: textarea.value, selStart, selEnd, start: selStart, length: selEnd - selStart, before: textarea.value.slice(0, selStart), transcript: new Transcript(), detector: new PauseDetector(), chunks: [], samples: 0, sent: 0, sentSamples: 0, turnStart: 0, commits: [], done: new Set(), levels: [], realtime: 'connecting', ws: null };
    const current = s;
    if (controls) controls.hidden = true;
    bar.hidden = false; bar.classList.remove('finishing'); say(''); textarea.readOnly = true; textarea.focus(); sync(); repaint();
    let mic;
    try { mic = await openMicrophone(frame, context); }
    catch (error) { if (s === current) finish(false); onError(error); return; }
    if (s !== current) { mic.stop(); return; }
    s.mic = mic; s.phase = 'live'; s.startedAt = Date.now();
    s.limit = setTimeout(confirm, maxMs);
    s.countdown = setInterval(() => { const left = Math.ceil((maxMs - (Date.now() - current.startedAt)) / 1000); if (s === current && left <= 30) say(t('还剩 {seconds} 秒', { seconds: left })); }, 1000);
    if (mic.legacy) { s.realtime = 'failed'; say(t('更新桌面客户端后可实时转写')); return; }
    connect(current);
  }
  // ✓: the last turn is committed and its final text awaited; audio without final text (no
  // connection, or it broke) is transcribed as a whole.
  async function confirm() {
    if (!s || s.phase === 'finishing') return;
    if (s.phase === 'starting') return finish(false);
    const current = s; s.phase = 'finishing'; bar.classList.add('finishing'); clearTimeout(s.limit); clearInterval(s.countdown);
    if (s.mic.legacy) {
      let blob = null; try { blob = await s.mic.take(); } catch {}
      if (s === current && blob?.size) await transcribeTail(() => transcribeBlob(blob, { keywords: keywords() }));
      if (s === current) finish(true);
      return;
    }
    s.mic.stop();
    if (s.realtime === 'open') {
      commit(RATE * 0.1);
      if (!settled()) await new Promise(resolve => { s.whenSettled = () => { if (s !== current || settled() || s.realtime !== 'open') resolve(); }; setTimeout(resolve, SETTLE_MS); });
      if (s !== current) return;
      if (!settled()) s.transcript.dropUnfinished();
    }
    const tail = s.realtime === 'open' && settled() ? null : concat(s.chunks).subarray(tailStart());
    if (tail && tail.length >= MIN_TURN) await transcribeTail(() => transcribeBlob(new Blob([wav(downsample(tail), 16000)], { type: 'audio/wav' }), { keywords: keywords() }));
    if (s === current) finish(true);
  }
  async function transcribeTail(run) {
    const current = s;
    say(t('正在转写…'));
    try { const text = String((await run())?.text || '').trim(); if (s === current && text) s.transcript.add(text); }
    catch (error) { onError(new Error(t('转写失败：{error}', { error: t(error?.message || String(error)) }))); }
    if (s === current) render();
  }
  // Ends the session: `keep` leaves the text in the composer, otherwise the draft is restored.
  function finish(keep) {
    if (!s) return;
    const done = s; s = null;
    clearTimeout(done.limit); clearInterval(done.countdown); done.mic?.stop(); try { done.ws?.close(); } catch {}
    if (!keep) { textarea.value = done.original; textarea.setSelectionRange(done.selStart, done.selEnd); }
    else { const end = done.start + done.length; textarea.setSelectionRange(end, end); }
    textarea.readOnly = false; notify();
    bar.hidden = true; if (controls) controls.hidden = false;
    setTitle(supported ? IDLE_TITLE : UNSUPPORTED_TITLE); sync();
  }
  const cancel = () => finish(false);
  // Leaving the conversation keeps what was said so far, at once.
  const settle = () => finish(true);

  for (const el of [cancelButton, confirmButton]) el.addEventListener('pointerdown', event => event.preventDefault()); // keep the caret in the textarea
  cancelButton.addEventListener('click', cancel);
  confirmButton.addEventListener('click', () => confirm());
  button.addEventListener('click', () => start());
  window.addEventListener('keydown', event => {
    if (!s) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
    else if (event.key === 'Enter' && (event.target === textarea || bar.contains(event.target))) { event.preventDefault(); event.stopImmediatePropagation(); confirm(); }
  }, true);
  window.addEventListener('pagehide', cancel);

  setTitle(supported ? IDLE_TITLE : UNSUPPORTED_TITLE); sync();
  return { supported, cancel, settle, confirm, setEnabled(value) { enabled = Boolean(value); if (!enabled) settle(); sync(); }, get active() { return Boolean(s); } };
}
