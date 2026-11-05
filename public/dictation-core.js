// The parts of live dictation (dictation.js) that need no DOM: audio conversion, pause detection and
// the transcript that is written into the composer. Also loaded by dictation-worklet.js and the tests.
export const RATE = 24000;          // OpenAI realtime transcription takes 24 kHz PCM16 mono only
export const CHUNK = RATE / 10;     // samples per 100 ms frame sent upstream
export const LEVEL_MS = 50;         // one waveform bar per 50 ms

// Linear resampling of a stream that arrives in blocks: the fractional position carries over, so
// block edges leave no seams.
export class Resampler {
  constructor(from, to = RATE) { this.step = from / to; this.at = 0; this.last = 0; }
  push(input) {
    if (this.step === 1) return Float32Array.from(input);
    const out = [];
    while (this.at < input.length) {
      const index = Math.floor(this.at), fraction = this.at - index;
      const a = index < 0 ? this.last : input[index], b = index + 1 < input.length ? input[index + 1] : null;
      if (b === null && fraction > 0) break;
      out.push(b === null ? a : a + (b - a) * fraction); this.at += this.step;
    }
    this.at -= input.length; if (input.length) this.last = input[input.length - 1];
    return Float32Array.from(out);
  }
}
export const toPcm16 = samples => Int16Array.from(samples, s => Math.max(-1, Math.min(1, s)) * 0x7fff | 0);
export const rms = samples => { let sum = 0; for (const s of samples) sum += s * s; return samples.length ? Math.sqrt(sum / samples.length) : 0; };
export function bytesToBase64(bytes) { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); }
export function base64ToBytes(text) { const raw = atob(text); const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i); return bytes; }

// Waveform bar height (0–1) for an RMS level: −60 dB is silence, −10 dB fills the bar.
export const levelHeight = level => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(level, 1e-6)) + 60) / 50));

// gpt-live-transcribe has no server VAD, so the page commits a turn at each pause: the noise floor
// follows the quietest recent levels, speech is a level well above it, and 700 ms of quiet after
// speech ends a turn. A turn that runs past `maxMs` is cut at its next quiet frame, or 5 s later.
export class PauseDetector {
  constructor({ silenceMs = 700, maxMs = 25000, frameMs = LEVEL_MS } = {}) { Object.assign(this, { quietFrames: silenceMs / frameMs, maxFrames: maxMs / frameMs, hardFrames: (maxMs + 5000) / frameMs }); this.floor = 0.002; this.reset(); }
  reset() { this.spoken = false; this.quiet = 0; this.frames = 0; }
  speech(level) { return level > Math.max(this.floor * 3, 0.006); }
  // Returns true when the turn so far should be committed.
  push(level) {
    this.floor = level < this.floor ? this.floor * 0.7 + level * 0.3 : this.floor * 0.998 + level * 0.002;
    const loud = this.speech(level); this.frames++;
    if (loud) { this.spoken = true; this.quiet = 0; } else this.quiet++;
    const end = this.spoken && (this.quiet >= this.quietFrames || (this.frames >= this.maxFrames && !loud) || this.frames >= this.hardFrames);
    if (end) this.reset();
    return end;
  }
}

// A space joins two runs of Latin text; Chinese needs none (the same rule as typing it in).
export const joinText = (before, text) => before && text && /[A-Za-z0-9)\].,;:!?]$/.test(before) && /^[A-Za-z0-9(\[]/.test(text) ? ' ' : '';

// What has been said so far, in turns (one per committed item). Deltas append to a turn as they
// arrive; a turn's `completed` transcript replaces them, since later deltas may correct earlier
// ones. Turns keep the order they were first seen in; `committed` carries the previous item, which
// settles the order if events crossed.
export class Transcript {
  constructor() { this.turns = []; }
  turn(id) { let turn = this.turns.find(t => t.id === id); if (!turn) { turn = { id, text: '', final: false }; this.turns.push(turn); } return turn; }
  delta(id, text) { const turn = this.turn(id); if (!turn.final) turn.text += text || ''; }
  completed(id, text) { const turn = this.turn(id); turn.text = String(text ?? turn.text).trim(); turn.final = true; }
  committed(id, previous) {
    const turn = this.turn(id), at = this.turns.indexOf(turn), after = previous ? this.turns.findIndex(t => t.id === previous) : -1;
    if (previous && after > at) { this.turns.splice(at, 1); this.turns.splice(this.turns.findIndex(t => t.id === previous) + 1, 0, turn); }
  }
  // Drops turns not finished yet (the connection broke): their audio is transcribed again.
  dropUnfinished() { this.turns = this.turns.filter(t => t.final); }
  add(text) { this.turns.push({ id: `local:${this.turns.length}`, text: String(text).trim(), final: true }); }
  get settled() { return this.turns.every(t => t.final); }
  text() { return this.turns.reduce((all, t) => { const text = t.text.trim(); return text ? all + joinText(all, text) + text : all; }, ''); }
}

// 16-bit mono WAV, for the whole-recording fallback (POST /api/transcribe).
export function wav(samples, rate) {
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}
// 24 kHz PCM16 → 16 kHz PCM16: ten minutes stay under the 25 MB upload limit.
export function downsample(pcm, to = 16000) { const resampler = new Resampler(RATE, to); return toPcm16(resampler.push(Float32Array.from(pcm, s => s / 0x8000))); }
