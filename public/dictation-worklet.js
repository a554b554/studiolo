// Audio thread of live dictation (dictation.js): the microphone, mixed to mono and resampled to
// 24 kHz, leaves as one PCM16 frame per 100 ms with two waveform levels (one per 50 ms).
import { Resampler, toPcm16, rms, RATE, CHUNK } from './dictation-core.js';

class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.resampler = new Resampler(sampleRate, RATE); this.buffer = new Float32Array(CHUNK); this.filled = 0; }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const mono = channels.length === 1 ? channels[0] : channels[0].map((_, i) => channels.reduce((sum, c) => sum + c[i], 0) / channels.length);
    for (const sample of this.resampler.push(mono)) {
      this.buffer[this.filled++] = sample;
      if (this.filled < CHUNK) continue;
      const pcm = toPcm16(this.buffer), half = CHUNK / 2;
      this.port.postMessage({ pcm: pcm.buffer, levels: [rms(this.buffer.subarray(0, half)), rms(this.buffer.subarray(half))] }, [pcm.buffer]);
      this.filled = 0;
    }
    return true;
  }
}
registerProcessor('studiolo-capture', Capture);
