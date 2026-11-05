// Native microphone recording for voice input (public/dictation.js). WKWebView offers no
// getUserMedia to a server opened over plain http on the tailnet, so the client records here and
// hands the page a WAV file, which the page posts to /api/transcribe like a browser recording.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;

// Speech needs no more; a two-minute clip stays under 4 MB.
const RATE: u32 = 16_000;

type Captured = Result<(Vec<f32>, u32, u16), String>;

struct Recording {
    stop: mpsc::Sender<()>,
    thread: JoinHandle<Captured>,
}

#[derive(Default)]
pub struct Recorder(Mutex<Option<Recording>>);

fn report(error: cpal::StreamError) {
    eprintln!("recording error: {error}");
}

// Opens the default input device and starts capturing into `samples`.
fn open(samples: Arc<Mutex<Vec<f32>>>) -> Result<(cpal::Stream, u32, u16), String> {
    let device = cpal::default_host().default_input_device().ok_or_else(|| "没有找到麦克风".to_string())?;
    let supported = device.default_input_config().map_err(|e| format!("无法打开麦克风：{e}"))?;
    let (rate, channels, format) = (supported.sample_rate().0, supported.channels(), supported.sample_format());
    let config: cpal::StreamConfig = supported.into();
    let stream = match format {
        SampleFormat::F32 => device.build_input_stream(&config, move |data: &[f32], _: &_| samples.lock().unwrap().extend_from_slice(data), report, None),
        SampleFormat::I16 => device.build_input_stream(&config, move |data: &[i16], _: &_| samples.lock().unwrap().extend(data.iter().map(|&s| s as f32 / 32768.0)), report, None),
        SampleFormat::U16 => device.build_input_stream(&config, move |data: &[u16], _: &_| samples.lock().unwrap().extend(data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0)), report, None),
        other => return Err(format!("不支持的麦克风格式 {other:?}")),
    }
    .map_err(|e| format!("无法打开麦克风：{e}"))?;
    stream.play().map_err(|e| format!("无法打开麦克风：{e}"))?;
    Ok((stream, rate, channels))
}

impl Recorder {
    pub fn start(&self) -> Result<(), String> {
        let mut slot = self.0.lock().unwrap();
        if slot.is_some() {
            return Err("已经在录音".into());
        }
        let (stop, stopped) = mpsc::channel();
        let (ready, started) = mpsc::channel();
        // cpal streams are not Send on macOS, so the stream lives and ends on this thread.
        let thread = std::thread::spawn(move || -> Captured {
            let samples = Arc::new(Mutex::new(Vec::new()));
            match open(samples.clone()) {
                Err(error) => {
                    let _ = ready.send(Err(error.clone()));
                    Err(error)
                }
                Ok((stream, rate, channels)) => {
                    let _ = ready.send(Ok(()));
                    let _ = stopped.recv();
                    drop(stream);
                    let captured = std::mem::take(&mut *samples.lock().unwrap());
                    Ok((captured, rate, channels))
                }
            }
        });
        started.recv().map_err(|_| "麦克风无法启动".to_string())??;
        *slot = Some(Recording { stop, thread });
        Ok(())
    }

    // Live dictation (public/dictation.js): every 100 ms the page gets the new audio as base64 PCM16 at
    // 24 kHz mono, with two waveform levels (RMS per 50 ms). Stopped by `cancel`.
    pub fn stream(&self, on_frame: impl Fn(String, [f32; 2]) + Send + 'static) -> Result<(), String> {
        let mut slot = self.0.lock().unwrap();
        if slot.is_some() {
            return Err("已经在录音".into());
        }
        let (stop, stopped) = mpsc::channel();
        let (ready, started) = mpsc::channel();
        let thread = std::thread::spawn(move || -> Captured {
            let samples = Arc::new(Mutex::new(Vec::new()));
            let (stream, rate, channels) = match open(samples.clone()) {
                Err(error) => {
                    let _ = ready.send(Err(error.clone()));
                    return Err(error);
                }
                Ok(opened) => opened,
            };
            let _ = ready.send(Ok(()));
            let mut resampler = Resampler::new(rate, STREAM_RATE);
            let mut pending: Vec<f32> = Vec::new();
            let frame = (STREAM_RATE / 10) as usize;
            while let Err(mpsc::RecvTimeoutError::Timeout) = stopped.recv_timeout(std::time::Duration::from_millis(100)) {
                let captured = std::mem::take(&mut *samples.lock().unwrap());
                pending.extend(resampler.push(&mono(&captured, channels)));
                while pending.len() >= frame {
                    let chunk: Vec<f32> = pending.drain(..frame).collect();
                    let half = frame / 2;
                    on_frame(base64(&pcm16(&chunk)), [rms(&chunk[..half]), rms(&chunk[half..])]);
                }
            }
            drop(stream);
            Ok((Vec::new(), rate, channels))
        });
        started.recv().map_err(|_| "麦克风无法启动".to_string())??;
        *slot = Some(Recording { stop, thread });
        Ok(())
    }

    pub fn stop(&self) -> Result<Vec<u8>, String> {
        let recording = self.0.lock().unwrap().take().ok_or_else(|| "没有在录音".to_string())?;
        let _ = recording.stop.send(());
        let (samples, rate, channels) = recording.thread.join().map_err(|_| "录音失败".to_string())??;
        Ok(wav(&resample(&mono(&samples, channels), rate)))
    }

    pub fn cancel(&self) {
        if let Some(recording) = self.0.lock().unwrap().take() {
            let _ = recording.stop.send(());
            let _ = recording.thread.join();
        }
    }
}

fn mono(samples: &[f32], channels: u16) -> Vec<f32> {
    let channels = channels.max(1) as usize;
    samples.chunks(channels).map(|frame| frame.iter().sum::<f32>() / frame.len() as f32).collect()
}

// Linear interpolation to RATE.
fn resample(samples: &[f32], rate: u32) -> Vec<f32> {
    if rate == RATE || samples.is_empty() {
        return samples.to_vec();
    }
    let step = rate as f64 / RATE as f64;
    let count = (samples.len() as f64 / step) as usize;
    (0..count)
        .map(|i| {
            let at = i as f64 * step;
            let (index, fraction) = (at as usize, (at - at.floor()) as f32);
            let next = samples.get(index + 1).copied().unwrap_or(samples[index]);
            samples[index] + (next - samples[index]) * fraction
        })
        .collect()
}

// The rate OpenAI's realtime transcription takes.
const STREAM_RATE: u32 = 24_000;

// Linear resampling of a stream that arrives in blocks; the fractional position carries over, so
// block edges leave no seams (public/dictation-core.js has the same).
struct Resampler {
    step: f64,
    at: f64,
    last: f32,
}

impl Resampler {
    fn new(from: u32, to: u32) -> Self {
        Resampler { step: from as f64 / to as f64, at: 0.0, last: 0.0 }
    }

    fn push(&mut self, input: &[f32]) -> Vec<f32> {
        let mut out = Vec::with_capacity((input.len() as f64 / self.step) as usize + 1);
        let len = input.len() as f64;
        while self.at < len {
            let index = self.at.floor();
            let fraction = (self.at - index) as f32;
            let a = if index < 0.0 { self.last } else { input[index as usize] };
            let next = (index + 1.0) as usize;
            if next >= input.len() && fraction > 0.0 {
                break;
            }
            let b = input.get(next).copied().unwrap_or(a);
            out.push(a + (b - a) * fraction);
            self.at += self.step;
        }
        self.at -= len;
        if let Some(&last) = input.last() {
            self.last = last;
        }
        out
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

fn pcm16(samples: &[f32]) -> Vec<u8> {
    samples.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect()
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= chunk.len() { TABLE[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

// 16-bit PCM mono WAV.
fn wav(samples: &[f32]) -> Vec<u8> {
    let data = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&((sample.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_resampler_has_no_seams() {
        let input: Vec<f32> = (0..4800).map(|i| (i as f32 / 7.0).sin()).collect();
        let whole = Resampler::new(48_000, 24_000).push(&input);
        let mut blocks = Resampler::new(48_000, 24_000);
        let parts: Vec<f32> = input.chunks(441).flat_map(|c| blocks.push(c)).collect();
        assert_eq!(whole.len(), 2400);
        assert!(parts.len().abs_diff(whole.len()) <= 1);
        assert!(parts.iter().zip(&whole).all(|(a, b)| (a - b).abs() < 1e-5));
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[255, 254, 253]), "//79");
    }
}
