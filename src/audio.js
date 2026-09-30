// Procedural audio: no external assets, works offline after the first gesture.
export class GameAudio {
  constructor() { this.context = null; this.volume = .5; }
  unlock() {
    try {
      this.context ??= new (window.AudioContext || window.webkitAudioContext)();
      if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    } catch { /* Sound is optional on browsers without Web Audio. */ }
  }
  tone(frequency, duration, type = 'sine', level = .1, end = frequency) {
    if (!this.context || this.volume <= 0) return;
    const c = this.context, oscillator = c.createOscillator(), gain = c.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, c.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, end), c.currentTime + duration);
    gain.gain.setValueAtTime(level * this.volume, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, c.currentTime + duration);
    oscillator.connect(gain).connect(c.destination);
    oscillator.start(); oscillator.stop(c.currentTime + duration);
  }
  noise(duration, level, lowpass = 1400) {
    if (!this.context || this.volume <= 0) return;
    const c = this.context, buffer = c.createBuffer(1, Math.floor(c.sampleRate * duration), c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
    const source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
    source.buffer = buffer; filter.type = 'lowpass'; filter.frequency.value = lowpass;
    gain.gain.value = level * this.volume;
    source.connect(filter).connect(gain).connect(c.destination); source.start();
  }
  play(name) {
    if (name === 'shot') { this.noise(.15, .42, 4400); this.tone(120, .13, 'triangle', .18, 35); }
    if (name === 'enemy') this.noise(.13, .10, 1800);
    if (name === 'hit') this.tone(760, .06, 'triangle', .12, 400);
    if (name === 'kill') { this.tone(550, .13, 'sine', .15, 1100); this.tone(1100, .2, 'sine', .06); }
    if (name === 'loot') { this.tone(720, .15, 'sine', .12, 960); this.tone(1440, .28, 'sine', .05); }
    if (name === 'reload') this.noise(.16, .12, 2400);
    if (name === 'step') this.noise(.07, .04, 700);
    if (name === 'hurt') { this.noise(.18, .18, 450); this.tone(80, .18, 'sine', .13, 35); }
    if (name === 'empty') this.tone(210, .04, 'square', .035);
    if (name === 'success') { this.tone(440, .5, 'sine', .1, 880); this.tone(660, .7, 'sine', .07); }
    if (name === 'fail') this.tone(160, .8, 'triangle', .12, 40);
    if (name === 'heal') this.tone(420, .4, 'sine', .07, 800);
  }
}
