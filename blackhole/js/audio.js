// Procedural deep-space ambient pad. WebAudio only, no external assets.
// Chain: 3 detuned oscillators (sine/saw/sine) -> slow-LFO lowpass ->
// feedback delay + generated-impulse convolver -> master gain.
// The AudioContext is created lazily on the first user gesture and never
// created at all when audio is disabled.

export class AudioPad {
  constructor({ enabled = true, volume = 0.5 } = {}) {
    this.enabled = enabled;      // false => hard-off, context never created
    this.volume = volume;
    this.muted = false;
    this.ctx = null;
    this.master = null;
  }

  get created() { return !!this.ctx; }

  start() {
    if (!this.enabled || this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    const ctx = new AC();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : this.volume;
    master.connect(ctx.destination);
    this.master = master;

    // --- voices
    const mix = ctx.createGain();
    mix.gain.value = 0.16;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 0.6;
    mix.connect(lp);

    const voices = [
      { type: 'sine', freq: 55.0, gain: 0.9 },
      { type: 'sawtooth', freq: 55.0 * 1.006, gain: 0.28 },
      { type: 'sine', freq: 82.41 * 0.998, gain: 0.45 },
    ];
    this._osc = [];
    for (const v of voices) {
      const o = ctx.createOscillator();
      o.type = v.type;
      o.frequency.value = v.freq;
      const g = ctx.createGain();
      g.gain.value = v.gain;
      o.connect(g); g.connect(mix);
      o.start();
      this._osc.push(o);
    }
    // slow vibrato on the saw for movement
    const vib = ctx.createOscillator();
    vib.frequency.value = 0.07;
    const vibG = ctx.createGain();
    vibG.gain.value = 1.6;
    vib.connect(vibG); vibG.connect(this._osc[1].detune);
    vib.start();
    this._osc.push(vib);

    // --- slow LFO on the lowpass cutoff
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 260;
    lfo.connect(lfoG); lfoG.connect(lp.frequency);
    lfo.start();
    this._osc.push(lfo);

    // --- space: feedback delay + generated-IR convolver
    const dry = ctx.createGain(); dry.gain.value = 0.75;
    lp.connect(dry); dry.connect(master);

    const delay = ctx.createDelay(2.0);
    delay.delayTime.value = 0.42;
    const fb = ctx.createGain(); fb.gain.value = 0.38;
    const wet = ctx.createGain(); wet.gain.value = 0.30;
    lp.connect(delay); delay.connect(fb); fb.connect(delay);
    delay.connect(wet); wet.connect(master);

    const conv = ctx.createConvolver();
    conv.buffer = this._impulse(ctx, 2.8, 2.4);
    const cwet = ctx.createGain(); cwet.gain.value = 0.35;
    lp.connect(conv); conv.connect(cwet); cwet.connect(master);

    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  _impulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master && !this.muted) this.master.gain.value = this.volume;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  toggleMuted() { this.setMuted(!this.muted); return this.muted; }
}
