// Minimal AudioWorklet used by the WebView probe.
class ProbeProcessor extends AudioWorkletProcessor {
  process() {
    return true;
  }
}
registerProcessor('probe', ProbeProcessor);
