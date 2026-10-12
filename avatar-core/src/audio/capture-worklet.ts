/** Batches microphone input into ~20 ms Float32 chunks for the main thread. */
const CHUNK_S = 0.02; // TUNABLE

class CaptureProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(Math.round(sampleRate * CHUNK_S));
  private len = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let off = 0;
    while (off < input.length) {
      const take = Math.min(this.buf.length - this.len, input.length - off);
      this.buf.set(input.subarray(off, off + take), this.len);
      this.len += take;
      off += take;
      if (this.len === this.buf.length) {
        const out = this.buf;
        this.port.postMessage(out, [out.buffer]);
        this.buf = new Float32Array(out.length);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
