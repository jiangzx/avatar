// Records filler clips in a style's voice (spec assumption 4, option "realtime model + text").
// Usage (from gateway/): node --env-file-if-exists=.env --import tsx scripts/make-filler-clips.ts \
//   --config ../app/assets/config/thinking.json --style grandchild --out ../app/assets/filler/grandchild [--voice <v>] [--tone 亲切活泼] [--attempts 3]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { baseSession, probeEnv, QwenRaw, userText, writeWav } from './lib/qwen-raw.ts';
import { normalizePeak, sameText, trimSilence } from './lib/pcm-tools.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const configPath = flag('config');
const style = flag('style');
const outDir = flag('out');
if (!configPath || !style || !outDir) throw new Error('--config, --style and --out are required');

const Clip = z.object({ id: z.string().regex(/^[a-z0-9-]{1,32}$/), text: z.string().min(1).max(20) });
const cfg = z.object({ clips: z.object({ thinking: z.array(Clip).min(1), longWait: z.array(Clip).min(1) }) }).parse(JSON.parse(readFileSync(configPath, 'utf8')));
const env = probeEnv();
const voice = flag('voice') ?? env.voice;
const tone = flag('tone') ?? '亲切温和';
const attempts = Number(flag('attempts') ?? 3);
const instructions = `你是录音员。用户让你说哪句话，你就用${tone}的语气把那一句原样说出来，一个字也不加，不要回答别的。`;
mkdirSync(outDir, { recursive: true });

let failures = 0;
for (const clip of [...cfg.clips.thinking, ...cfg.clips.longWait]) {
  let best: Int16Array | null = null;
  let matched = false;
  for (let i = 1; i <= attempts && !matched; i++) {
    const c = await QwenRaw.open({ apiKey: env.apiKey, endpoint: env.endpoint, model: env.model, session: baseSession(instructions, voice) });
    const r = await c.collect(() => { c.send(userText(`请原样说：${clip.text}`)); c.send({ type: 'response.create' }); });
    c.close();
    const pcm = normalizePeak(trimSilence(r.audio, 300, 480, 720), Math.round(0.7 * 32767));
    matched = r.error === null && pcm.length > 0 && sameText(r.transcript, clip.text);
    if (pcm.length > 0) best = pcm;
    process.stdout.write(`${JSON.stringify({ style, id: clip.id, attempt: i, status: r.status, matched, ms: Math.round(pcm.length / 24) })}\n`);
  }
  if (!best) { failures++; continue; }
  writeFileSync(`${outDir}/${clip.id}.pcm`, Buffer.from(best.buffer, best.byteOffset, best.byteLength));
  writeWav(`/tmp/filler-${style}-${clip.id}.wav`, best, 24000);
  if (!matched) failures++;
}
process.exit(failures === 0 ? 0 : 2);
