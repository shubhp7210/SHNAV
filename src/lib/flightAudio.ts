/**
 * FlightAudio — Web Audio API engine for Altos flight simulation.
 * All sounds are generated procedurally; no audio files required.
 */

// ── Haptics (Web Vibration API) ───────────────────────────────────────────────
export function haptic(pattern: number | number[]) {
  try {
    if ("vibrate" in navigator) navigator.vibrate(pattern);
  } catch { /* not supported */ }
}

// ── Audio engine ──────────────────────────────────────────────────────────────
export class FlightAudio {
  private ctx:    AudioContext | null = null;
  private master: GainNode    | null = null;
  private muted = false;

  // Ambient nodes (keep refs for stopping)
  private droneOsc1: OscillatorNode | null = null;
  private droneOsc2: OscillatorNode | null = null;
  private droneOsc3: OscillatorNode | null = null;
  private droneLfo:  OscillatorNode | null = null;
  private droneGain: GainNode       | null = null;
  private windSrc:   AudioBufferSourceNode | null = null;
  private windGain:  GainNode       | null = null;

  // ── Init (must be called from a user-gesture handler) ──────────────────────
  init() {
    if (this.ctx) return;
    this.ctx    = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
  }

  get ready() { return !!this.ctx; }

  setMuted(m: boolean) {
    this.muted = m;
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.15);
  }

  // ── Ambient sounds ──────────────────────────────────────────────────────────
  startAmbient() {
    if (!this.ctx || !this.master) return;
    this._startDrone();
    this._startWind();
  }

  private _startDrone() {
    const ctx = this.ctx!;
    const now = ctx.currentTime;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.055, now + 3.5);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 280;
    filter.Q.value = 1.2;

    // LFO — slow pitch wobble for engine feel
    const lfo     = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.12;
    lfoGain.gain.value  = 2.5;
    lfo.connect(lfoGain);

    // Three detuned oscillators for rich beating/chorus effect
    const osc1 = ctx.createOscillator(); osc1.type = "sawtooth"; osc1.frequency.value = 55;
    const osc2 = ctx.createOscillator(); osc2.type = "sawtooth"; osc2.frequency.value = 55.4; // slight detune
    const osc3 = ctx.createOscillator(); osc3.type = "sine";     osc3.frequency.value = 110;  // octave harmonic

    lfoGain.connect(osc1.frequency);
    lfoGain.connect(osc2.frequency);

    const g3 = ctx.createGain(); g3.gain.value = 0.4;
    osc3.connect(g3); g3.connect(filter);
    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);

    [osc1, osc2, osc3, lfo].forEach(o => o.start(now));

    this.droneOsc1 = osc1;
    this.droneOsc2 = osc2;
    this.droneOsc3 = osc3;
    this.droneLfo  = lfo;
    this.droneGain = gain;
  }

  private _startWind() {
    const ctx = this.ctx!;
    const now = ctx.currentTime;

    // White noise buffer (2 s looped)
    const bufLen = ctx.sampleRate * 2;
    const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop   = true;

    // Shape with bandpass — airy rushing sound
    const bp = ctx.createBiquadFilter();
    bp.type            = "bandpass";
    bp.frequency.value = 950;
    bp.Q.value         = 0.55;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.028, now + 4);

    src.connect(bp);
    bp.connect(gain);
    gain.connect(this.master!);
    src.start(now);

    this.windSrc  = src;
    this.windGain = gain;
  }

  stopAmbient(fadeDuration = 2) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    [this.droneGain, this.windGain].forEach(g => {
      if (!g) return;
      g.gain.setTargetAtTime(0, now, fadeDuration / 5);
    });
    const stop = (n: AudioNode | null) => {
      try { (n as any)?.stop?.(now + fadeDuration + 0.1); } catch {}
    };
    setTimeout(() => {
      [this.droneOsc1, this.droneOsc2, this.droneOsc3, this.droneLfo, this.windSrc].forEach(stop);
    }, (fadeDuration + 0.2) * 1000);
  }

  // ── One-shot sounds ─────────────────────────────────────────────────────────

  /** Rising sweep played on simulation launch */
  playTakeoff() {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Noise sweep
    const bufLen = ctx.sampleRate;
    const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const sweep = ctx.createBiquadFilter();
    sweep.type            = "bandpass";
    sweep.frequency.setValueAtTime(120, now);
    sweep.frequency.exponentialRampToValueAtTime(2400, now + 1.6);
    sweep.Q.value = 1.5;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.2);
    gain.gain.linearRampToValueAtTime(0, now + 1.7);

    src.connect(sweep);
    sweep.connect(gain);
    gain.connect(this.master);
    src.start(now);
    src.stop(now + 1.8);

    // Low rumble accompaniment
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(60, now);
    osc.frequency.exponentialRampToValueAtTime(180, now + 1.5);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, now);
    og.gain.linearRampToValueAtTime(0.12, now + 0.15);
    og.gain.linearRampToValueAtTime(0, now + 1.6);
    osc.connect(og); og.connect(this.master);
    osc.start(now); osc.stop(now + 1.7);
  }

  /** Double beep — status alert */
  playAlert() {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    [0, 0.22, 0.44].forEach((delay) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type            = "sine";
      osc.frequency.value = 880;
      const t = ctx.currentTime + delay;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.28, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      osc.connect(gain);
      gain.connect(this.master!);
      osc.start(t);
      osc.stop(t + 0.2);
    });

    // Short static burst (ATC radio feel)
    const bufLen = ctx.sampleRate * 0.08;
    const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const src  = ctx.createBufferSource(); src.buffer = buf;
    const bp   = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 3000; bp.Q.value = 2;
    const sg   = ctx.createGain(); sg.gain.value = 0.15;
    src.connect(bp); bp.connect(sg); sg.connect(this.master!);
    src.start(ctx.currentTime + 0.6);
  }

  /** Soft descending tone — alert cleared */
  playAlertClear() {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    [880, 660].forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.15;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.connect(gain); gain.connect(this.master!);
      osc.start(t); osc.stop(t + 0.3);
    });
  }

  /** Subtle high ping — waypoint passed */
  playWaypoint() {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine"; osc.frequency.value = 1320;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    osc.connect(gain); gain.connect(this.master!);
    osc.start(now); osc.stop(now + 0.2);
  }

  /** C-major arpeggio chime — arrival */
  playArrival() {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    // C5, E5, G5, C6
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.22;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.22, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
      osc.connect(gain); gain.connect(this.master!);
      osc.start(t); osc.stop(t + 0.95);
    });
  }

  destroy() {
    this.stopAmbient(0.3);
    setTimeout(() => {
      try { this.ctx?.close(); } catch {}
      this.ctx = null; this.master = null;
    }, 500);
  }
}
