import { t } from './i18n.js';

// Voice input shared by the chat composer and the Artifact comment composer, mounted when the server reports
// features.voiceInput (a machine has the OpenAI key from Settings → 语音转写; README「语音输入」).
// Hold the button to talk and release to transcribe, or tap once to start and tap again to
// stop (touch friendly). Esc discards the recording. The blob goes to this server's
// /api/transcribe as-is; the text lands at the caret and the draft logic sees an input event.
const HOLD_MS = 400;            // shorter presses are taps: recording continues until the next tap
const MIN_RECORDING_MS = 300;
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
const IDLE_TITLE = '按住说话，松开后转写；也可点一下开始、再点一下结束';
const UNSUPPORTED_TITLE = '麦克风需要 HTTPS 或在本机 127.0.0.1 打开';

// getUserMedia only exists in secure contexts (HTTPS, localhost, 127.0.0.1).
export const dictationSupported = () => Boolean(globalThis.navigator?.mediaDevices?.getUserMedia && typeof globalThis.MediaRecorder !== 'undefined');

export async function transcribeBlob(blob, { durationMs, language } = {}) {
  const params = new URLSearchParams();
  if (Number.isFinite(durationMs)) params.set('duration_ms', String(Math.max(0, Math.round(durationMs))));
  if (language) params.set('language', language);
  const query = [...params.keys()].length ? `?${params}` : '';
  const response = await fetch(`/api/transcribe${query}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return data;
}

// Insert at the caret (replacing any selection), leave the caret after the text and notify
// listeners the way typing would. A space separates adjoining Latin words; CJK needs none.
export function insertAtCursor(textarea, text) {
  const value = textarea.value;
  const start = textarea.selectionStart ?? value.length, end = textarea.selectionEnd ?? start;
  const before = value.slice(0, start);
  const needsSpace = before && /[A-Za-z0-9)\]]$/.test(before) && /^[A-Za-z0-9(\[]/.test(text);
  const insert = (needsSpace ? ' ' : '') + text;
  textarea.focus();
  if (typeof textarea.setRangeText === 'function') textarea.setRangeText(insert, start, end, 'end');
  else { textarea.value = before + insert + value.slice(end); textarea.selectionStart = textarea.selectionEnd = start + insert.length; }
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

const formatTime = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const pickMime = () => MIME_CANDIDATES.find(type => { try { return MediaRecorder.isTypeSupported(type); } catch { return false; } });
function describeMediaError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return t('麦克风权限被拒绝，请在浏览器中允许麦克风后重试');
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return t('没有找到麦克风');
  if (error?.name === 'NotReadableError') return t('麦克风正被其他应用占用');
  return t('无法打开麦克风：{error}', { error: error?.message || String(error) });
}

export function mountDictation({ button, textarea, onError = () => {}, transcribe = transcribeBlob, maxMs = 120000, language }) {
  if (!button || !textarea) return { supported: false, cancel() {}, setEnabled() {}, recording: false };
  const supported = dictationSupported();
  const timeLabel = document.createElement('span'); timeLabel.className = 'dictation-time';
  button.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';
  let enabled = true, state = 'idle', recorder, stream, chunks = [], startedAt = 0, pressStartedAt = 0, stopOnRelease = false, cancelled = false, ticker, limiter;
  const setTitle = key => { button.setAttribute('data-i18n-title', key); button.title = t(key); };
  const sync = () => {
    button.disabled = !supported || !enabled || state === 'transcribing';
    button.classList.toggle('recording', state === 'recording');
    button.classList.toggle('transcribing', state === 'transcribing');
    button.setAttribute('aria-pressed', String(state === 'recording'));
  };
  const clearTimers = () => { clearInterval(ticker); clearTimeout(limiter); ticker = limiter = undefined; };
  const releaseStream = () => { stream?.getTracks().forEach(track => track.stop()); stream = undefined; };
  const reset = () => { clearTimers(); releaseStream(); recorder = undefined; chunks = []; cancelled = false; stopOnRelease = false; state = 'idle'; timeLabel.remove(); setTitle(supported ? IDLE_TITLE : UNSUPPORTED_TITLE); sync(); };
  const tick = () => { timeLabel.textContent = formatTime(Date.now() - startedAt); if (!timeLabel.isConnected) button.append(timeLabel); };

  async function start() {
    if (state !== 'idle' || button.disabled) return;
    state = 'starting'; sync();
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (error) { const message = describeMediaError(error); reset(); onError(new Error(message)); return; }
    if (state !== 'starting') { releaseStream(); return; }                 // cancelled while the permission prompt was open
    const mime = pickMime();
    try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch { try { recorder = new MediaRecorder(stream); } catch { reset(); onError(new Error(t('这个浏览器不支持录音'))); return; } }
    chunks = []; cancelled = false;
    recorder.addEventListener('dataavailable', event => { if (event.data?.size) chunks.push(event.data); });
    recorder.addEventListener('stop', () => { finish(); });
    recorder.addEventListener('error', () => { cancelled = true; try { recorder.stop(); } catch { finish(); } onError(new Error(t('录音失败，请重试'))); });
    try { recorder.start(); } catch { reset(); onError(new Error(t('这个浏览器不支持录音'))); return; }
    startedAt = Date.now(); state = 'recording'; sync(); setTitle('录音中，松开或再点一下结束，Esc 取消');
    tick(); ticker = setInterval(tick, 250); limiter = setTimeout(stop, maxMs);
  }
  function stop() {
    if (state !== 'recording') return;
    state = 'stopping'; clearTimers();
    try { recorder.stop(); } catch { finish(); }
  }
  function cancel() {
    if (state === 'starting') { reset(); return; }
    if (state !== 'recording') return;
    cancelled = true; state = 'stopping'; clearTimers();
    try { recorder.stop(); } catch { finish(); }
  }
  async function finish() {
    if (state === 'idle' || state === 'transcribing') return;
    const elapsed = Date.now() - startedAt;
    const type = recorder?.mimeType || chunks[0]?.type || 'audio/webm';
    const blob = new Blob(chunks, { type });
    releaseStream();
    if (cancelled) { reset(); return; }
    if (elapsed < MIN_RECORDING_MS || !blob.size) { reset(); onError(new Error(t('录音太短'))); return; }
    state = 'transcribing'; sync(); setTitle('正在转写…'); timeLabel.textContent = '…';
    try {
      const result = await transcribe(blob, { durationMs: elapsed, language });
      const text = String(result?.text || '').trim();
      if (text) insertAtCursor(textarea, text); else onError(new Error(t('没有识别到语音')));
    } catch (error) { onError(new Error(t('转写失败：{error}', { error: t(error?.message || String(error)) }))); }
    finally { reset(); }
  }

  button.addEventListener('pointerdown', event => {
    if (button.disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();                                                  // keep focus and the caret in the textarea
    try { button.setPointerCapture(event.pointerId); } catch {}
    pressStartedAt = Date.now();
    if (state === 'recording') { stopOnRelease = true; return; }
    stopOnRelease = false;
    if (state === 'idle') start();
  });
  const release = event => {
    if (event.type === 'pointerup' && event.pointerType === 'mouse' && event.button !== 0) return;
    const held = Date.now() - pressStartedAt;
    if (stopOnRelease) { stopOnRelease = false; stop(); return; }
    if (state === 'recording' && held >= HOLD_MS) stop();                  // hold-to-talk; a short tap keeps recording
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('contextmenu', event => event.preventDefault()); // long-press menus on touch screens
  button.addEventListener('keydown', event => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (state === 'recording') stop(); else if (state === 'idle') start();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && (state === 'recording' || state === 'starting')) cancel(); });
  window.addEventListener('pagehide', () => { if (state === 'recording' || state === 'starting') cancel(); });

  reset();
  return { supported, cancel, setEnabled(value) { enabled = Boolean(value); if (!enabled && (state === 'recording' || state === 'starting')) cancel(); sync(); }, get recording() { return state === 'recording'; } };
}
