// Original procedural score and sound effects. All sound is generated locally;
// Web Audio is created only by unlock(), called from a player gesture.
const clamp = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.min(1, Math.max(0, Number(value))) : fallback;
const midi = (note) => 440 * 2 ** ((note - 69) / 12);
const CHORDS = [[50, 57, 65, 69, 76], [46, 53, 62, 65, 69], [41, 53, 60, 65, 69], [48, 55, 62, 67, 74]];
const MOTIF = [3, 4, 2, null, 3, 1, 2, null];
const MIX = {
  lobby: { pad: .85, melody: .85, rhythm: .09, ambient: .55 },
  raid: { pad: .65, melody: .47, rhythm: .30, ambient: .90 },
  combat: { pad: .45, melody: .23, rhythm: .90, ambient: .50 },
  extract: { pad: .80, melody: .90, rhythm: .62, ambient: .70 },
  result: { pad: .90, melody: 1, rhythm: .10, ambient: .45 },
};

export class GameAudio {
  constructor() {
    this.context = null;
    this._volume = .5; this._musicVolume = .4;
    this._baseMood = 'lobby'; this._mood = 'lobby';
    this._paused = false; this._hidden = false; this._threat = 0;
    this._musicRunning = false; this._scoreStep = 0; this._nextStepTime = 0;
    this._stepDuration = 60 / 78 / 2;
    this._musicVoices = new Set(); this._effectVoices = new Set();
    this._scheduledNotes = 0; this._visibilityListener = null;
    this._shotEvents = 0; this._lastShotKind = null; this._lastReloadStage = null;
  }
  get volume() { return this._volume; }
  set volume(value) {
    this._volume = clamp(value, this._volume);
    if (this._master) this._smooth(this._master.gain, this._hidden ? 0 : this._volume, .025);
    if (this._volume <= 0) this._stopMusic(.08);
  }
  get musicVolume() { return this._musicVolume; }
  set musicVolume(value) {
    this._musicVolume = clamp(value, this._musicVolume);
    if (this._musicGain) this._smooth(this._musicGain.gain, this._musicVolume, .06);
    if (this._musicVolume <= 0) this._stopMusic(.12);
  }
  setVolume(value) { this.volume = value; }
  unlock() {
    try {
      if (!this.context) {
        const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AudioContextClass) return;
        this.context = new AudioContextClass(); this._buildGraph();
      }
      if (this.context.state === 'suspended') return this.context.resume().then(() => this._ensureMusic()).catch(() => {});
      this._ensureMusic();
    } catch { /* Browsers without Web Audio can still play the game. */ }
  }
  _smooth(param, value, seconds = .6) {
    if (!this.context) return;
    const now = this.context.currentTime;
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
    else { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); }
    param.setTargetAtTime(value, now, seconds);
  }
  _buildGraph() {
    const c = this.context;
    this._master = c.createGain(); this._master.gain.value = this._volume; this._master.connect(c.destination);
    this._effects = c.createGain();
    // Restrained bus compression keeps overlapping automatic fire comfortable.
    // This is exclusively on effects; the music graph and mix are unchanged.
    if (c.createDynamicsCompressor) {
      this._effectsCompressor = c.createDynamicsCompressor();
      this._effectsCompressor.threshold.value = -9; this._effectsCompressor.knee.value = 5;
      this._effectsCompressor.ratio.value = 6; this._effectsCompressor.attack.value = .002;
      this._effectsCompressor.release.value = .13;
      this._effects.connect(this._effectsCompressor).connect(this._master);
    } else this._effects.connect(this._master);
    this._musicGain = c.createGain(); this._musicGain.gain.value = this._musicVolume; this._musicGain.connect(this._master);
    this._transport = c.createGain(); this._transport.gain.value = 0; this._transport.connect(this._musicGain);
    this._layers = {};
    // A deterministic stereo room impulse gives pads and bells space without
    // requesting recordings. Dry percussion keeps weapon transients clear.
    const reverb = c.createConvolver(), room = c.createBuffer(2, Math.ceil(c.sampleRate * 2.8), c.sampleRate);
    let seed = 0x5f3759df;
    for (let channel = 0; channel < 2; channel++) {
      const data = room.getChannelData(channel); let smoothed = 0;
      for (let i = 0; i < data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        smoothed = smoothed * .28 + (seed / 0x100000000 * 2 - 1) * .72;
        data[i] = smoothed * (1 - i / data.length) ** 3 * .38;
      }
    }
    reverb.buffer = room;
    const roomHighpass = c.createBiquadFilter(); roomHighpass.type = 'highpass'; roomHighpass.frequency.value = 180;
    reverb.connect(roomHighpass).connect(this._transport);
    for (const [name, send] of Object.entries({ pad: .38, melody: .52, rhythm: .10, ambient: .12 })) {
      const bus = c.createGain(), wet = c.createGain();
      bus.gain.value = MIX[this._mood]?.[name] ?? 0; wet.gain.value = send;
      bus.connect(this._transport); bus.connect(wet).connect(reverb); this._layers[name] = bus;
    }
    this._noise = c.createBuffer(2, Math.ceil(c.sampleRate * 8), c.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = this._noise.getChannelData(channel);
      for (let i = 0; i < data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        data[i] = seed / 0x100000000 * 2 - 1;
      }
    }
    if (typeof document !== 'undefined') {
      this._hidden = document.hidden;
      this._visibilityListener = () => {
        this._hidden = document.hidden;
        this._smooth(this._master.gain, this._hidden ? 0 : this._volume, .08);
        if (this._hidden) this._stopMusic(.18); else this._ensureMusic();
      };
      document.addEventListener('visibilitychange', this._visibilityListener);
      if (this._hidden) this._master.gain.value = 0;
    }
  }
  setMood(mode) {
    if (mode === 'pause') { this._paused = true; this._stopMusic(.22); return; }
    if (!MIX[mode]) return;
    this._baseMood = mode; this._paused = false; this._setEffectiveMood(mode); this._ensureMusic();
  }
  _setEffectiveMood(mode) {
    if (this._mood === mode) return;
    this._mood = mode;
    if (this._layers) for (const [name, value] of Object.entries(MIX[mode])) this._smooth(this._layers[name].gain, value, mode === 'combat' ? .55 : 1.15);
  }
  update(dt, { threat = 0, extracting = false, paused = false } = {}) {
    this._threat += (clamp(threat) - this._threat) * Math.min(1, Math.max(0, dt || 0) * 2.5);
    const wasPaused = this._paused; this._paused = Boolean(paused);
    if (this._baseMood === 'raid') this._setEffectiveMood(extracting ? 'extract' : this._threat > .20 ? 'combat' : 'raid');
    if (this._paused || this._hidden) {
      if (!wasPaused || this._musicRunning) this._stopMusic(.22);
      this._collectEnded(this._musicVoices); this._collectEnded(this._effectVoices);
      return;
    }
    this._ensureMusic();
    if (!this._musicRunning || this.context?.state !== 'running') return;
    this._scheduleScore(); this._collectEnded(this._musicVoices); this._collectEnded(this._effectVoices);
  }
  _ensureMusic() {
    if (!this.context || this.context.state !== 'running' || this._musicRunning || this._paused || this._hidden || this._volume <= 0 || this._musicVolume <= 0) return;
    this._musicRunning = true; this._nextStepTime = this.context.currentTime + .035;
    // Resume on a phrase boundary so a fresh pad always enters.
    this._scoreStep = Math.ceil(this._scoreStep / 32) * 32;
    this._smooth(this._transport.gain, 1, .55); this._wind(this._nextStepTime); this._scheduleScore();
  }
  _scheduleScore() {
    const now = this.context.currentTime;
    // A backgrounded tab or long frame cannot replay a backlog of notes.
    if (this._nextStepTime < now - .4) { this._scoreStep = Math.ceil(this._scoreStep / 32) * 32; this._nextStepTime = now + .035; }
    let scheduled = 0;
    while (this._nextStepTime < now + .20 && scheduled++ < 4) {
      this._score(this._scoreStep++, this._nextStepTime); this._nextStepTime += this._stepDuration;
    }
  }
  _score(step, time) {
    const chord = CHORDS[Math.floor(step / 32) % CHORDS.length], phraseStep = step % 32;
    if (phraseStep === 0) this._pad(chord, time, this._stepDuration * 34);
    if (step % 4 === 0) {
      const note = MOTIF[Math.floor(phraseStep / 4)];
      if (note !== null) {
        this._bell(midi(chord[note] + (note === 1 ? 12 : 0)), time, this._stepDuration * 5, step % 8 === 0 ? -.32 : .32);
        if (phraseStep === 24) this._bell(midi(chord[2] + 12), time + this._stepDuration * 1.5, this._stepDuration * 4, -.45, .035);
      }
    }
    if (step % 4 === 0 || (this._mood === 'combat' && step % 2 === 0)) this._pulse(midi(chord[0] - 12), time, step % 8 === 0 ? .17 : .095);
    if (step % 8 === 4) this._percussion(time, .044, 920, .20, -.18);
    if (step % 2 === 1) this._percussion(time, this._mood === 'combat' ? .033 : .014, 5400, .055, step % 4 === 1 ? -.5 : .5);
  }
  _voice(layer, sources, gain, nodes, endTime, effects = false) {
    const collection = effects ? this._effectVoices : this._musicVoices;
    const voice = { sources, gain, nodes: [...new Set([...sources, gain, ...nodes])], endTime, ended: 0 };
    collection.add(voice); if (!effects) this._scheduledNotes++;
    const cleanup = () => {
      if (++voice.ended < sources.length) return;
      collection.delete(voice);
      for (const node of voice.nodes) { try { node.disconnect(); } catch {} }
    };
    for (const source of sources) source.onended = cleanup;
    gain.connect(effects ? this._effects : this._layers[layer]);
    if (collection.size > (effects ? 32 : 48)) {
      const oldest = collection.values().next().value; this._stopVoice(oldest, .025); collection.delete(oldest);
    }
    return voice;
  }
  _collectEnded(collection) {
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const voice of collection) if (Number.isFinite(voice.endTime) && voice.endTime + .3 < now) {
      for (const node of voice.nodes) { try { node.disconnect(); } catch {} }
      collection.delete(voice);
    }
  }
  _stopVoice(voice, fade) {
    const now = this.context.currentTime, param = voice.gain.gain;
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
    else { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); }
    param.linearRampToValueAtTime(0, now + fade); voice.endTime = now + fade + .04;
    for (const source of voice.sources) { try { source.stop(voice.endTime); } catch {} }
  }
  _stopMusic(fade = .22) {
    if (!this.context || !this._musicRunning) return;
    this._musicRunning = false; this._smooth(this._transport.gain, 0, Math.max(.01, fade / 3));
    for (const voice of this._musicVoices) this._stopVoice(voice, fade);
  }
  _pan(source, amount, nodes) {
    if (!this.context.createStereoPanner) return source;
    const pan = this.context.createStereoPanner(); pan.pan.value = amount;
    source.connect(pan); nodes.push(pan); return pan;
  }
  _pad(chord, time, duration) {
    const c = this.context, gain = c.createGain(), filter = c.createBiquadFilter();
    filter.type = 'lowpass'; filter.Q.value = .35;
    filter.frequency.setValueAtTime(380, time);
    filter.frequency.linearRampToValueAtTime(this._mood === 'combat' ? 740 : 1600, time + duration * .42);
    filter.frequency.linearRampToValueAtTime(440, time + duration);
    gain.gain.setValueAtTime(0, time); gain.gain.linearRampToValueAtTime(.062, time + 2.1);
    gain.gain.setValueAtTime(.062, time + Math.max(2.2, duration - 2.8)); gain.gain.linearRampToValueAtTime(0, time + duration);
    const nodes = [filter], sources = [];
    for (let i = 0; i < 5; i++) {
      const oscillator = c.createOscillator(); oscillator.type = i === 0 ? 'sine' : 'triangle';
      oscillator.frequency.value = midi(chord[i]); oscillator.detune.value = [-4, 4, -2, 3, 0][i];
      oscillator.connect(filter); sources.push(oscillator); oscillator.start(time); oscillator.stop(time + duration + .02);
    }
    this._pan(filter, Math.floor(this._scoreStep / 32) % 2 ? -.15 : .15, nodes).connect(gain);
    this._voice('pad', sources, gain, nodes, time + duration + .02);
  }
  _bell(frequency, time, duration, position, level = .105) {
    const c = this.context, gain = c.createGain(), body = c.createOscillator(), overtone = c.createOscillator(), partial = c.createGain();
    body.type = 'sine'; body.frequency.value = frequency; overtone.type = 'sine'; overtone.frequency.value = frequency * 2.002; partial.gain.value = .20;
    gain.gain.setValueAtTime(0, time); gain.gain.linearRampToValueAtTime(level, time + .018); gain.gain.exponentialRampToValueAtTime(.0001, time + duration);
    const nodes = [partial], mix = c.createGain(); nodes.push(mix);
    body.connect(mix); overtone.connect(partial).connect(mix); this._pan(mix, position, nodes).connect(gain);
    this._voice('melody', [body, overtone], gain, nodes, time + duration + .025);
    body.start(time); overtone.start(time); body.stop(time + duration + .025); overtone.stop(time + duration + .025);
  }
  _pulse(frequency, time, level) {
    const c = this.context, oscillator = c.createOscillator(), gain = c.createGain(); oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency * 1.7, time); oscillator.frequency.exponentialRampToValueAtTime(frequency, time + .10);
    gain.gain.setValueAtTime(0, time); gain.gain.linearRampToValueAtTime(level, time + .015); gain.gain.exponentialRampToValueAtTime(.0001, time + .33);
    oscillator.connect(gain); this._voice('rhythm', [oscillator], gain, [], time + .36); oscillator.start(time); oscillator.stop(time + .36);
  }
  _percussion(time, level, cutoff, duration, position) {
    const c = this.context, source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain(); source.buffer = this._noise;
    filter.type = cutoff > 3000 ? 'highpass' : 'bandpass'; filter.frequency.value = cutoff; filter.Q.value = .65;
    gain.gain.setValueAtTime(0, time); gain.gain.linearRampToValueAtTime(level, time + .006); gain.gain.exponentialRampToValueAtTime(.0001, time + duration);
    source.connect(filter); const nodes = [filter]; this._pan(filter, position, nodes).connect(gain);
    this._voice('rhythm', [source], gain, nodes, time + duration + .01);
    source.start(time, (this._scoreStep * .137) % 6, duration + .01); source.stop(time + duration + .01);
  }
  _wind(time) {
    const c = this.context, source = c.createBufferSource(), gain = c.createGain(), filter = c.createBiquadFilter(), low = c.createBiquadFilter();
    source.buffer = this._noise; source.loop = true; filter.type = 'lowpass'; filter.frequency.value = 640; filter.Q.value = .35; low.type = 'highpass'; low.frequency.value = 100;
    const tide = c.createOscillator(), tideDepth = c.createGain(), gust = c.createOscillator(), gustDepth = c.createGain();
    tide.frequency.value = .085; tideDepth.gain.value = .025; gust.frequency.value = .043; gustDepth.gain.value = 190; gain.gain.value = .095;
    tide.connect(tideDepth).connect(gain.gain); gust.connect(gustDepth).connect(filter.frequency); source.connect(filter).connect(low).connect(gain);
    this._voice('ambient', [source, tide, gust], gain, [filter, low, tideDepth, gustDepth], Infinity);
    source.start(time); tide.start(time); gust.start(time);
  }
  tone(frequency, duration, type = 'sine', level = .1, end = frequency) {
    if (!this.context || this.context.state !== 'running' || this.volume <= 0 || this._hidden) return;
    const c = this.context, oscillator = c.createOscillator(), gain = c.createGain(), now = c.currentTime; oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now); oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, end), now + duration);
    gain.gain.setValueAtTime(level, now); gain.gain.exponentialRampToValueAtTime(.001, now + duration); oscillator.connect(gain);
    this._voice(null, [oscillator], gain, [], now + duration, true); oscillator.start(); oscillator.stop(now + duration);
  }
  noise(duration, level, lowpass = 1400) {
    if (!this.context || this.context.state !== 'running' || this.volume <= 0 || this._hidden) return;
    const c = this.context, source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain(), now = c.currentTime; source.buffer = this._noise;
    filter.type = 'lowpass'; filter.frequency.value = lowpass; gain.gain.setValueAtTime(level, now); gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
    source.connect(filter).connect(gain); this._voice(null, [source], gain, [filter], now + duration + .01, true);
    source.start(now, Math.random() * 6, duration + .01); source.stop(now + duration + .01);
  }
  _composite(parts, level = 1, pitch = 1, position = 0) {
    if (!this.context || this.context.state !== 'running' || this.volume <= 0 || this._hidden || level <= 0) return null;
    const c = this.context, now = c.currentTime, gain = c.createGain(), mix = c.createGain(), sources = [], nodes = [mix];
    gain.gain.value = level;
    this._pan(mix, position, nodes).connect(gain);
    let endTime = now;
    for (const part of parts) {
      const start = now + (part.delay || 0), duration = part.duration, end = start + duration;
      const envelope = c.createGain(); nodes.push(envelope);
      envelope.gain.setValueAtTime(.00001, start);
      envelope.gain.linearRampToValueAtTime(part.level, start + Math.min(duration / 3, part.attack || .002));
      envelope.gain.exponentialRampToValueAtTime(.00001, end);
      let source, output;
      if (part.type === 'noise') {
        source = c.createBufferSource(); source.buffer = this._noise; output = source;
        const filter = c.createBiquadFilter(); filter.type = part.filter || 'lowpass';
        filter.frequency.value = part.frequency * pitch; filter.Q.value = part.Q || .7;
        output.connect(filter); output = filter; nodes.push(filter);
        if (part.highpass) {
          const high = c.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = part.highpass * pitch;
          output.connect(high); output = high; nodes.push(high);
        }
      } else {
        source = c.createOscillator(); source.type = part.type || 'sine'; output = source;
        source.frequency.setValueAtTime(part.frequency * pitch, start);
        source.frequency.exponentialRampToValueAtTime(Math.max(20, (part.endFrequency || part.frequency) * pitch), end);
      }
      output.connect(envelope).connect(mix); sources.push(source);
      if (part.type === 'noise') source.start(start, Math.random() * 5.5, duration + .015);
      else source.start(start);
      source.stop(end + .015); endTime = Math.max(endTime, end + .015);
    }
    return this._voice(null, sources, gain, nodes, endTime, true);
  }
  _shotParts(kind, muffle = 1) {
    if (kind === 'heavy') return [
      { type: 'noise', duration: .145, level: .43, frequency: 2800 * muffle, highpass: 80 },
      { type: 'sine', duration: .36, level: .28, frequency: 100, endFrequency: 31, attack: .004 },
      { type: 'noise', duration: .32, level: .13, frequency: 550 * muffle, attack: .01 },
      { type: 'noise', duration: .40, level: .09, frequency: 820 * muffle, delay: .13, attack: .022 },
      { type: 'noise', duration: .09, level: .075, frequency: 1100 * muffle, filter: 'bandpass', delay: .11 },
    ];
    if (kind === 'tactical') return [
      { type: 'noise', duration: .095, level: .34, frequency: 6800 * muffle, highpass: 750 },
      { type: 'triangle', duration: .16, level: .19, frequency: 185, endFrequency: 58 },
      { type: 'noise', duration: .065, level: .10, frequency: 2300 * muffle, filter: 'bandpass', Q: 1.2, delay: .095 },
      { type: 'noise', duration: .24, level: .068, frequency: 1600 * muffle, highpass: 220, delay: .07, attack: .008 },
    ];
    return [
      { type: 'noise', duration: .07, level: .38, frequency: 4500 * muffle, highpass: 420 },
      { type: 'sine', duration: .115, level: .16, frequency: 145, endFrequency: 62 },
      { type: 'noise', duration: .055, level: .06, frequency: 1800 * muffle, delay: .045 },
    ];
  }
  shot(kind = 'basic') {
    kind = ['basic', 'tactical', 'heavy'].includes(kind) ? kind : 'basic';
    const voice = this._composite(this._shotParts(kind), 1, .97 + Math.random() * .06);
    if (voice) { this._shotEvents++; this._lastShotKind = kind; }
    return voice;
  }
  enemyShot(kind = 'tactical', distance = 12) {
    const separation = Number.isFinite(distance) ? Math.max(0, distance) : 12;
    const falloff = .28 / (1 + separation * .025), muffle = 1 / (1 + separation * .018);
    return this._composite(this._shotParts(kind, muffle), falloff, .96 + Math.random() * .08, (Math.random() - .5) * .8);
  }
  reload(kind = 'basic', stage = 'start') {
    const weight = kind === 'heavy' ? { pitch: .76, level: 1.12 } : kind === 'tactical' ? { pitch: 1, level: 1 } : { pitch: 1.18, level: .82 };
    const stages = {
      start: [
        { type: 'noise', duration: .045, level: .11, frequency: 2600, filter: 'bandpass' },
        { type: 'noise', duration: .16, level: .07, frequency: 1200, highpass: 350, delay: .018, attack: .025 },
        { type: 'sine', duration: .055, level: .025, frequency: 115, endFrequency: 60, delay: .025 },
      ],
      magazine: [
        { type: 'noise', duration: .17, level: .09, frequency: 800, highpass: 160, attack: .022 },
        { type: 'noise', duration: .055, level: .14, frequency: 2100, filter: 'bandpass', delay: .12 },
        { type: 'sine', duration: .075, level: .05, frequency: 92, endFrequency: 45, delay: .12 },
      ],
      bolt: [
        { type: 'noise', duration: .08, level: .11, frequency: 3400, highpass: 900, attack: .008 },
        { type: 'noise', duration: .055, level: .12, frequency: 2300, filter: 'bandpass', Q: 1.4, delay: .07 },
        { type: 'noise', duration: .07, level: .055, frequency: 1400, filter: 'bandpass', delay: .028 },
      ],
    };
    const voice = this._composite(stages[stage] || stages.start, weight.level, weight.pitch * (.98 + Math.random() * .04));
    if (voice) this._lastReloadStage = stages[stage] ? stage : 'start';
    return voice;
  }
  foley(name, level = 1) {
    const walk = name === 'sprint' ? 1.35 : 1;
    const parts = name === 'walk' || name === 'sprint' ? [
      { type: 'noise', duration: .075, level: .08 * walk, frequency: name === 'sprint' ? 620 : 440, attack: .006 },
      { type: 'sine', duration: .055, level: .028 * walk, frequency: 86, endFrequency: 40, delay: .003 },
      { type: 'noise', duration: .065, level: .022 * walk, frequency: 1100, filter: 'bandpass', delay: .026, attack: .008 },
    ] : name === 'gear' ? [
      { type: 'noise', duration: .16, level: .055, frequency: 1700, highpass: 520, attack: .028 },
    ] : name === 'pain' ? [
      { type: 'noise', duration: .32, level: .09, frequency: 500, filter: 'bandpass', Q: .7, attack: .032 },
      { type: 'noise', duration: .23, level: .035, frequency: 1550, filter: 'bandpass', Q: 1.1, delay: .08, attack: .044 },
    ] : name === 'breath' ? [
      { type: 'noise', duration: .38, level: .045, frequency: 1100, filter: 'bandpass', Q: .5, attack: .09 },
    ] : null;
    if (!parts) return null;
    return this._composite(parts, clamp(level), .94 + Math.random() * .12);
  }
  play(name) {
    if (name === 'shot') this.shot('basic');
    if (name === 'enemy') this.enemyShot('tactical');
    if (name === 'hit') this.tone(760, .06, 'triangle', .12, 400);
    if (name === 'kill') { this.tone(550, .13, 'sine', .15, 1100); this.tone(1100, .2, 'sine', .06); }
    if (name === 'loot') { this.tone(720, .15, 'sine', .12, 960); this.tone(1440, .28, 'sine', .05); }
    if (name === 'reload') this.reload('basic');
    if (name === 'step') this.foley('walk');
    if (name === 'hurt') { this.noise(.15, .14, 400); this.foley('pain'); }
    if (name === 'empty') this.tone(210, .04, 'square', .035);
    if (name === 'success') { this.tone(440, .5, 'sine', .1, 880); this.tone(660, .7, 'sine', .07); }
    if (name === 'fail') this.tone(160, .8, 'triangle', .12, 40);
    if (name === 'heal') this.tone(420, .4, 'sine', .07, 800);
  }
  getDiagnostics() {
    return { contextState: this.context?.state ?? 'locked', masterVolume: this.volume, musicVolume: this.musicVolume, mood: this._paused ? 'pause' : this._mood, musicRunning: this._musicRunning, scheduledVoices: this._musicVoices.size, effectVoices: this._effectVoices.size, scheduledNotes: this._scheduledNotes, scoreStep: this._scoreStep, hidden: this._hidden, shotEvents: this._shotEvents, lastShotKind: this._lastShotKind, lastReloadStage: this._lastReloadStage };
  }
  dispose() {
    if (this._visibilityListener) document.removeEventListener('visibilitychange', this._visibilityListener);
    if (this.context) { this._stopMusic(.03); for (const voice of this._effectVoices) this._stopVoice(voice, .03); this.context.close().catch(() => {}); }
  }
}
