type InMsg =
  | { type: 'push'; seq: number; samples: Float32Array }
  | { type: 'end'; seq: number }
  | { type: 'stop'; fadeMs: number };

class PlayerProcessor extends AudioWorkletProcessor {
  private queue: Float32Array[] = [];
  private offset = 0;
  private seq = -1;
  private played = 0;
  private startedSent = false;
  private ended = false;
  private stopping = false;
  private gain = 1;
  private gainStep = 0;
  private prevSample = 0;
  private accSq = 0;
  private accZc = 0;
  private accN = 0;
  private sinceProgress = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<InMsg>) => this.onMessage(e.data);
  }

  private onMessage(m: InMsg): void {
    if (m.type === 'push') {
      if (m.seq !== this.seq) this.reset(m.seq);
      this.queue.push(m.samples);
    } else if (m.type === 'end') {
      if (m.seq === this.seq) this.ended = true;
      else this.port.postMessage({ type: 'drained', seq: m.seq, playedSamples: 0 }); // a response without any audio
    } else if (this.seq >= 0 && !this.stopping) {
      this.stopping = true;
      this.gain = 1;
      this.gainStep = 1 / Math.max(1, (m.fadeMs / 1000) * sampleRate);
    }
  }

  private reset(seq: number): void {
    this.queue = [];
    this.offset = 0;
    this.seq = seq;
    this.played = 0;
    this.startedSent = false;
    this.ended = false;
    this.stopping = false;
    this.gain = 1;
  }

  private finishStop(): void {
    this.port.postMessage({ type: 'stopped', seq: this.seq, playedSamples: this.played });
    this.queue = [];
    this.offset = 0;
    this.seq = -1;
    this.stopping = false;
    this.ended = false;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const out = channels?.[0];
    if (!out) return true;
    let sumSq = 0;
    let zc = 0;
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      const head = this.queue[0];
      if (head) {
        s = head[this.offset++];
        if (this.offset >= head.length) {
          this.queue.shift();
          this.offset = 0;
        }
        this.played++;
        if (!this.startedSent) {
          this.startedSent = true;
          this.port.postMessage({ type: 'started', seq: this.seq });
        }
      }
      if (this.stopping) {
        s *= Math.max(0, this.gain);
        this.gain -= this.gainStep;
        if (this.gain <= 0) {
          this.finishStop();
          s = 0;
        }
      }
      out[i] = s;
      sumSq += s * s;
      if (s >= 0 !== this.prevSample >= 0) zc++;
      this.prevSample = s;
    }
    for (let c = 1; c < channels.length; c++) channels[c].set(out);

    this.accSq += sumSq;
    this.accZc += zc;
    this.accN += out.length;
    if (this.accN >= sampleRate * 0.016) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.accSq / this.accN), zcr: this.accZc / this.accN, samples: this.accN });
      this.accSq = 0;
      this.accZc = 0;
      this.accN = 0;
    }
    if (this.seq >= 0) {
      this.sinceProgress += out.length;
      if (this.sinceProgress >= sampleRate * 0.1) {
        this.sinceProgress = 0;
        this.port.postMessage({ type: 'progress', seq: this.seq, playedSamples: this.played });
      }
      if (this.ended && this.queue.length === 0 && !this.stopping) {
        this.port.postMessage({ type: 'drained', seq: this.seq, playedSamples: this.played });
        this.seq = -1;
        this.ended = false;
      }
    }
    return true;
  }
}

registerProcessor('player', PlayerProcessor);
