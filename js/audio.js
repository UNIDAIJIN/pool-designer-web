// Web Audio のグラフ。Source/PluginProcessor.cpp の信号の流れをブラウザで組み直したもの。
//
//  入力 ─┬─ 遅延(直接音の位置) ── dry ─────────────────┐
//        ├─ 畳み込み A / B(クロスフェード)─┐            ├─ 出力 ─ スピーカー
//        └─ 水面の1次反射(worklet) ─────────┴─ ローカット ─ wet ┘

import { directOffsetSamples, speedOfSound } from './model.js';

const kCrossfadeSeconds = 0.25;

export class PoolAudio {
  constructor() {
    this.ctx = null;
    this.source = null;      // 現在の入力ノード
    this.stopSource = null;  // 入力を止める関数
    this.pendingIr = null;   // AudioContext の準備前に届いた IR
    this.active = 0;         // 鳴っている畳み込み(0 / 1)
    this.onSourceEnded = null;
  }

  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'playback' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL('./water-worklet.js', import.meta.url));

    this.input = ctx.createGain();

    const offset = directOffsetSamples(ctx.sampleRate);
    this.dryDelay = ctx.createDelay(0.1);
    this.dryDelay.delayTime.value = offset / ctx.sampleRate;
    this.dryGain = ctx.createGain();

    // 畳み込みはモノラルにまとめた入力にステレオの IR をかける
    this.convs = [0, 1].map(() => {
      const conv = ctx.createConvolver();
      conv.normalize = false;
      conv.channelCount = 1;
      conv.channelCountMode = 'explicit';
      conv.channelInterpretation = 'speakers';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      this.input.connect(conv).connect(gain);
      return { conv, gain };
    });

    this.water = new AudioWorkletNode(ctx, 'pool-water', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit',
    });

    this.wetSum = ctx.createGain();
    this.lowCut = ctx.createBiquadFilter();
    this.lowCut.type = 'highpass';
    this.lowCut.Q.value = -3.0103; // Web Audio のハイパスの Q は dB。Butterworth (0.707)
    this.lowCut.frequency.value = 5;
    this.wetGain = ctx.createGain();
    this.outGain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.75;

    this.input.connect(this.dryDelay).connect(this.dryGain).connect(this.outGain);
    for (const c of this.convs) c.gain.connect(this.wetSum);
    this.input.connect(this.water).connect(this.wetSum);
    this.wetSum.connect(this.lowCut).connect(this.wetGain).connect(this.outGain);
    this.outGain.connect(this.analyser);
    this.outGain.connect(ctx.destination);

    if (this.lastParams) this.setParams(this.lastParams, true);
    if (this.pendingIr) {
      const r = this.pendingIr;
      this.pendingIr = null;
      this.setResult(r, true);
    }
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

  // 計算済みの IR を差し替える。直前の畳み込みからクロスフェードする
  setResult(result, now = false) {
    if (!this.ctx) { this.pendingIr = result; return; }
    const ctx = this.ctx;
    const [l, r] = result.ir;
    const buffer = ctx.createBuffer(2, l.length, ctx.sampleRate);
    buffer.copyToChannel(l, 0);
    buffer.copyToChannel(r, 1);

    const first = !this.convs.some((c) => c.conv.buffer);
    const next = first ? 0 : 1 - this.active;
    const t = ctx.currentTime;
    const fade = now || first ? 0.01 : kCrossfadeSeconds;
    const incoming = this.convs[next], outgoing = this.convs[this.active];

    incoming.conv.buffer = buffer;
    incoming.gain.gain.cancelScheduledValues(t);
    incoming.gain.gain.setValueAtTime(incoming.gain.gain.value, t);
    incoming.gain.gain.linearRampToValueAtTime(1, t + fade);
    if (outgoing !== incoming) {
      outgoing.gain.gain.cancelScheduledValues(t);
      outgoing.gain.gain.setValueAtTime(outgoing.gain.gain.value, t);
      outgoing.gain.gain.linearRampToValueAtTime(0, t + fade);
    }
    this.active = next;
    this.water.port.postMessage({ water: result.water, now: now || first });
  }

  // リアルタイムに効くパラメータ
  setParams(p, now = false) {
    this.lastParams = { ...p };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const tc = now ? 0.001 : 0.02;
    const mix = p.bypass ? 0 : p.mix;
    this.dryGain.gain.setTargetAtTime(1 - mix, t, tc);
    this.wetGain.gain.setTargetAtTime(mix, t, tc);
    this.outGain.gain.setTargetAtTime(Math.pow(10, p.output / 20), t, tc);
    this.lowCut.frequency.setTargetAtTime(p.lowCut <= 20.5 ? 5 : p.lowCut, t, tc);
    this.water.port.postMessage({
      waveHeight: p.waveHeight * 0.01, waveSpeed: p.waveSpeed, c: speedOfSound(p.temperatureC),
    });
  }

  // 入力 ---------------------------------------------------------------

  disconnectSource() {
    if (this.stopSource) this.stopSource();
    this.stopSource = null;
    if (this.source) this.source.disconnect();
    this.source = null;
  }

  connect(node, stop) {
    this.disconnectSource();
    this.source = node;
    this.stopSource = stop;
    node.connect(this.input);
  }

  // 隣のタブ(YouTube など)の音。共有ダイアログで「タブの音声を共有」をオンにしてもらう
  async useTab() {
    await this.init();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        suppressLocalAudioPlayback: true, // 元のタブからは鳴らさない
      },
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'exclude',
    });
    const audio = stream.getAudioTracks();
    if (audio.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('no-audio');
    }
    // 映像は使わない(止めると音も切れるブラウザがあるので、止めずに無効にするだけ)
    stream.getVideoTracks().forEach((t) => { t.enabled = false; });
    const node = this.ctx.createMediaStreamSource(stream);
    const label = audio[0].label || stream.getVideoTracks()[0]?.label || '';
    audio[0].addEventListener('ended', () => {
      if (this.source === node) {
        this.disconnectSource();
        this.onSourceEnded?.();
      }
    });
    this.connect(node, () => stream.getTracks().forEach((t) => t.stop()));
    return label;
  }

  async useMic() {
    await this.init();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const node = this.ctx.createMediaStreamSource(stream);
    this.connect(node, () => stream.getTracks().forEach((t) => t.stop()));
    return stream.getAudioTracks()[0]?.label || '';
  }

  async useFile(file) {
    await this.init();
    const el = new Audio();
    el.src = URL.createObjectURL(file);
    el.loop = true;
    el.crossOrigin = 'anonymous';
    const node = this.ctx.createMediaElementSource(el);
    this.connect(node, () => { el.pause(); URL.revokeObjectURL(el.src); });
    await el.play();
    return el;
  }

  // 響きがわかりやすい短い音のループ(手拍子 + 声っぽい音)
  async useDemo() {
    await this.init();
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0.8;
    const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; ++i) nd[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.018));

    const beat = 60 / 96;
    let nextTime = ctx.currentTime + 0.1, step = 0, stopped = false;
    const melody = [0, 3, 7, 10, 7, 3, 5, -2];
    const clap = (t) => {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = 0.8;
      const g = ctx.createGain(); g.gain.value = 1.4;
      s.connect(f).connect(g).connect(bus);
      s.start(t);
    };
    const note = (t, semi) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 220 * Math.pow(2, semi / 12);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 1800;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.22, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + beat * 0.45);
      o.connect(f).connect(g).connect(bus);
      o.start(t);
      o.stop(t + beat * 0.5);
    };
    const tick = () => {
      if (stopped) return;
      while (nextTime < ctx.currentTime + 0.3) {
        const bar = step % 16;
        if (bar === 4 || bar === 12) clap(nextTime);
        if (bar < 8 && step % 32 < 16) note(nextTime, melody[bar]);
        nextTime += beat / 2;
        ++step;
      }
    };
    const timer = setInterval(tick, 50);
    tick();
    this.connect(bus, () => { stopped = true; clearInterval(timer); });
  }

  // 出力レベル(dBFS, ピーク)
  level() {
    if (!this.analyser) return -Infinity;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    return 20 * Math.log10(peak || 1e-9);
  }
}
