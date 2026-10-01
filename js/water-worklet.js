// 水面の1次反射(揺らぎ付き)。Source/PluginProcessor.cpp の processChunk を移植。
// 入力はモノラル、出力はステレオの反射音だけ(dry や IR は含まない)

function wave(p) {
  return 0.5 * (Math.sin(p) + 0.6 * Math.sin(1.37 * p + 1.3) + 0.4 * Math.sin(0.71 * p + 2.1));
}

class Smoothed {
  constructor(seconds) { this.seconds = seconds; this.current = 0; this.target = 0; this.step = 0; this.left = 0; }
  set(v, now) {
    if (now) { this.current = this.target = v; this.left = 0; return; }
    this.target = v;
    this.left = Math.max(1, Math.round(this.seconds * sampleRate));
    this.step = (v - this.current) / this.left;
  }
  next() {
    if (this.left > 0) { this.current += this.step; if (--this.left === 0) this.current = this.target; }
    return this.current;
  }
}

class WaterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    let size = 1;
    while (size < 0.6 * sampleRate) size <<= 1;
    this.line = new Float32Array(size);
    this.mask = size - 1;
    this.write = 0;
    this.phase = 0;
    this.delay = [new Smoothed(0.08), new Smoothed(0.08)];
    this.gain = [new Smoothed(0.08), new Smoothed(0.08)];
    this.pathPerWaveHeight = 0;
    this.waveHeight = 0.02;
    this.waveSpeed = 0.4;
    this.c = 349;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.water) {
        const w = m.water;
        this.pathPerWaveHeight = w.pathPerWaveHeight;
        for (let ch = 0; ch < 2; ++ch) {
          this.delay[ch].set(w.delaySamples[ch], m.now);
          this.gain[ch].set(w.active ? w.gain[ch] : 0, m.now);
        }
      }
      if (m.waveHeight !== undefined) this.waveHeight = m.waveHeight;
      if (m.waveSpeed !== undefined) this.waveSpeed = m.waveSpeed;
      if (m.c !== undefined) this.c = m.c;
    };
  }

  read(pos) {
    const buf = this.line, mask = this.mask;
    const i = Math.floor(pos);
    const f = pos - i;
    const x0 = buf[(i - 1) & mask], x1 = buf[i & mask], x2 = buf[(i + 1) & mask], x3 = buf[(i + 2) & mask];
    const c1 = 0.5 * (x2 - x0);
    const c2 = x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3;
    const c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2);
    return ((c3 * f + c2) * f + c1) * f + x1;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const out = outputs[0];
    const n = out[0].length;
    const inL = input[0], inR = input[1] || input[0];
    const waveHeightM = this.waveHeight;
    const phaseInc = 2 * Math.PI * this.waveSpeed / sampleRate;
    const pathToSamples = sampleRate / this.c;
    const focus = 0.35 * Math.min(1, waveHeightM / 0.1);

    for (let i = 0; i < n; ++i) {
      const mono = inL ? (inR !== inL ? 0.5 * (inL[i] + inR[i]) : inL[i]) : 0;
      this.line[this.write] = mono;
      const writePos = this.write;
      this.write = (this.write + 1) & this.mask;

      const p = this.phase;
      this.phase += phaseInc;
      for (let ch = 0; ch < 2; ++ch) {
        const g = this.gain[ch].next();
        const d = this.delay[ch].next();
        if (g <= 0) { out[ch][i] = 0; continue; }
        const mod = wave(p + 0.9 * ch);
        const delay = Math.max(2, d + waveHeightM * this.pathPerWaveHeight * mod * pathToSamples);
        const amp = g * (1 + focus * wave(0.83 * p + 0.5 + ch));
        out[ch][i] = amp * this.read(writePos - delay);
      }
    }
    if (this.phase > 1e6) this.phase %= 2 * Math.PI * 100;
    return true;
  }
}

registerProcessor('pool-water', WaterProcessor);
