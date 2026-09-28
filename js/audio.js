// Tiny synthesized sound effects via the Web Audio API (no audio files).

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.muted = false;
  }

  // Must be called from a user gesture (iOS requirement).
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(this.ctx.destination);
        const len = this.ctx.sampleRate * 2;
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        // Play a silent buffer to fully unlock iOS audio.
        const s = this.ctx.createBufferSource();
        s.buffer = this.ctx.createBuffer(1, 1, 22050);
        s.connect(this.master);
        s.start(0);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) { /* audio is optional */ }
  }

  get ok() { return !!this.ctx && this.ctx.state === 'running' && !this.muted; }

  noise(dur, { type = 'lowpass', f0 = 2000, f1 = 200, q = 1, vol = 0.8, attack = 0.005, delay = 0 } = {}) {
    const c = this.ctx;
    const t = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const filt = c.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(f0, t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  tone(dur, { wave = 'square', f0 = 440, f1 = f0, vol = 0.25, delay = 0, attack = 0.005 } = {}) {
    const c = this.ctx;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = wave;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // vol: 0..1 distance attenuation from the caller.
  play(name, vol = 1) {
    if (!this.ok || vol <= 0.02) return;
    const v = Math.min(1, vol);
    switch (name) {
      case 'boom':
        this.noise(0.9, { f0: 1800, f1: 60, vol: 0.9 * v });
        this.tone(0.5, { wave: 'sine', f0: 120, f1: 35, vol: 0.6 * v });
        break;
      case 'puff':
        this.noise(0.12, { type: 'bandpass', f0: 1800, f1: 600, q: 2, vol: 0.25 * v });
        break;
      case 'bazooka':
        this.noise(0.45, { type: 'bandpass', f0: 400, f1: 2500, q: 1.5, vol: 0.5 * v, attack: 0.03 });
        break;
      case 'throw':
        this.tone(0.15, { wave: 'triangle', f0: 300, f1: 700, vol: 0.25 * v });
        break;
      case 'minigun':
        this.noise(0.06, { type: 'highpass', f0: 3000, f1: 1200, vol: 0.35 * v });
        this.tone(0.04, { wave: 'square', f0: 180, f1: 90, vol: 0.12 * v });
        break;
      case 'shotgun':
        this.noise(0.35, { f0: 5000, f1: 300, vol: 0.8 * v });
        this.tone(0.15, { wave: 'sine', f0: 160, f1: 50, vol: 0.4 * v });
        break;
      case 'punch':
        this.tone(0.14, { wave: 'sine', f0: 220, f1: 60, vol: 0.6 * v });
        this.noise(0.08, { f0: 1500, f1: 300, vol: 0.4 * v });
        break;
      case 'whiff':
        this.noise(0.18, { type: 'bandpass', f0: 800, f1: 2000, q: 3, vol: 0.2 * v });
        break;
      case 'bounce':
        this.tone(0.06, { wave: 'triangle', f0: 900, f1: 500, vol: 0.18 * v });
        break;
      case 'splash':
        this.noise(0.6, { type: 'bandpass', f0: 1200, f1: 300, q: 0.8, vol: 0.6 * v, attack: 0.02 });
        this.tone(0.25, { wave: 'sine', f0: 600, f1: 150, vol: 0.15 * v, delay: 0.05 });
        break;
      case 'jump':
        this.tone(0.18, { wave: 'square', f0: 220, f1: 660, vol: 0.12 * v });
        break;
      case 'ouch':
        this.tone(0.2, { wave: 'sawtooth', f0: 520, f1: 260, vol: 0.12 * v });
        break;
      case 'die':
        this.tone(0.6, { wave: 'triangle', f0: 500, f1: 90, vol: 0.25 * v });
        break;
      case 'turn':
        this.tone(0.12, { wave: 'square', f0: 660, vol: 0.12 });
        this.tone(0.2, { wave: 'square', f0: 990, vol: 0.12, delay: 0.12 });
        break;
      case 'myturn':
        this.tone(0.1, { wave: 'square', f0: 523, vol: 0.14 });
        this.tone(0.1, { wave: 'square', f0: 659, vol: 0.14, delay: 0.1 });
        this.tone(0.25, { wave: 'square', f0: 784, vol: 0.14, delay: 0.2 });
        break;
      case 'tick':
        this.tone(0.05, { wave: 'square', f0: 1200, vol: 0.1 });
        break;
      case 'select':
        this.tone(0.07, { wave: 'triangle', f0: 800, f1: 1100, vol: 0.15 });
        break;
      case 'click':
        this.tone(0.04, { wave: 'triangle', f0: 700, vol: 0.12 });
        break;
      case 'win': {
        const notes = [523, 659, 784, 1047, 784, 1047];
        notes.forEach((f, i) => this.tone(i === notes.length - 1 ? 0.6 : 0.15, { wave: 'square', f0: f, vol: 0.14, delay: i * 0.14 }));
        break;
      }
    }
  }
}
