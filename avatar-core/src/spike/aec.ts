import { AI_SAMPLE_RATE } from '@anyidea/protocol';
import { MicCapture, type EchoMode } from '../audio/capture.ts';
import { EnergyTrigger } from '../audio/energy.ts';
import { PlaybackController } from '../audio/player.ts';
import { DEFAULT_DETECTOR, LocalVad, SpeechDetector } from '../audio/vad.ts';

export const FEED_CHUNK_MS = 100; // TUNABLE: playback feed interval and chunk length
export const PREBUFFER_CHUNKS = 3; // TUNABLE: ~300 ms head start before real-time feeding
export const RENDER_INTERVAL_MS = 1000; // TUNABLE: stats refresh period

// Posts straight to the Flutter channel so this page does not depend on Task 14's bridge.ts.
const postDiag = (value: string) =>
  (window as unknown as { FlutterBridge?: { postMessage(m: string): void } }).FlutterBridge?.postMessage(
    JSON.stringify({ type: 'diag', key: 'spike_a', value }),
  );
const out = document.getElementById('out')!;
const CHUNK = (AI_SAMPLE_RATE * FEED_CHUNK_MS) / 1000; // 2400 samples
let running: { stop(): Promise<void> } | null = null;

async function loadSpeech(): Promise<Int16Array> {
  const buf = await (await fetch('./spike/speech-24k.pcm')).arrayBuffer();
  return new Int16Array(buf.slice(0, buf.byteLength - (buf.byteLength % 2)));
}

async function run(echo: EchoMode): Promise<void> {
  if (running) await running.stop();
  const speech = await loadSpeech();
  const energy = new EnergyTrigger();
  const normal = new SpeechDetector(DEFAULT_DETECTOR);
  let sileroBargeIn = 0;
  let sileroNormal = 0;
  const player = new PlaybackController({ onFirstAudio() {}, onEnded() {}, onStopped() {}, onProgress() {}, onLevel() {} });
  await player.init();
  await player.resume();
  player.onResponseStart(1);
  let offset = 0;
  const pushNext = () => {
    const chunk = new Int16Array(CHUNK);
    for (let i = 0; i < CHUNK; i++) chunk[i] = speech[(offset + i) % speech.length];
    offset = (offset + CHUNK) % speech.length;
    player.push(1, chunk);
  };
  for (let i = 0; i < PREBUFFER_CHUNKS; i++) pushNext();
  const feeder = setInterval(pushNext, FEED_CHUNK_MS); // then real-time, looping the sample forever

  const capture = new MicCapture();
  const stream = await capture.start({ echo, onFrame: (pcm) => energy.push(pcm) });
  const vad = new LocalVad();
  vad.aiPlaying = true; // the product raises the threshold while the AI speaks
  await vad.start(stream, {
    onStart: () => sileroBargeIn++,
    onEnd: () => {},
    onProbability: (p) => {
      if (normal.push(p, performance.now()) === 'start') sileroNormal++;
    },
  });

  const t0 = performance.now();
  const settings = JSON.stringify(capture.settings());
  const render = () => {
    const min = (performance.now() - t0) / 60000;
    const per10 = (n: number) => (min > 0 ? ((n / min) * 10).toFixed(1) : '0');
    const text =
      `方案 A  echo=${echo}  已运行 ${min.toFixed(1)} 分钟\n` +
      `能量触发 ${energy.count} 次（${per10(energy.count)}/10min）\n` +
      `Silero 打断阈值触发 ${sileroBargeIn} 次（${per10(sileroBargeIn)}/10min）\n` +
      `Silero 普通阈值触发 ${sileroNormal} 次（${per10(sileroNormal)}/10min）\n` +
      `mic=${settings}`;
    out.textContent = text;
    postDiag(text);
  };
  const ticker = setInterval(render, RENDER_INTERVAL_MS);
  running = {
    async stop() {
      clearInterval(feeder);
      clearInterval(ticker);
      render();
      player.interrupt();
      await vad.destroy();
      await capture.stop();
      running = null;
    },
  };
}

document.getElementById('start-true')!.addEventListener('click', () => void run('true'));
document.getElementById('start-all')!.addEventListener('click', () => void run('all'));
document.getElementById('stop')!.addEventListener('click', () => void running?.stop());
