import test from 'node:test';
import assert from 'node:assert/strict';
import { GameAudio } from '../src/audio.js';

// These tests exercise autoplay, scheduling and lifecycle, not synthesized timbre.
// work/audio-check.mjs additionally renders the graph with real browser Web Audio.
class Param {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(value, time) { this.value = value; this.events.push({ type: 'set', value, time }); }
  linearRampToValueAtTime(value, time) { this.events.push({ type: 'linear', value, time }); }
  exponentialRampToValueAtTime(value, time) { this.events.push({ type: 'exponential', value, time }); }
  setTargetAtTime(value, time, duration) { this.events.push({ type: 'target', value, time, duration }); }
  cancelScheduledValues(time) { this.events.push({ type: 'cancel', time }); }
  cancelAndHoldAtTime(time) { this.events.push({ type: 'hold', time }); }
}
class Node {
  constructor() {
    this.gain = new Param(1); this.frequency = new Param(); this.detune = new Param();
    this.Q = new Param(); this.pan = new Param(); this.connections = [];
  }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.connections = []; }
  start(time = 0) { this.startTime = time; }
  stop(time = 0) { this.stopTime = time; }
}
class AudioContextStub {
  constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 200; this.destination = new Node(); }
  createGain() { return new Node(); }
  createOscillator() { return new Node(); }
  createBufferSource() { return new Node(); }
  createBiquadFilter() { return new Node(); }
  createConvolver() { return new Node(); }
  createStereoPanner() { return new Node(); }
  createBuffer(channels, length) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { getChannelData: (channel) => data[channel] }; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
globalThis.AudioContext = AudioContextStub;

test('a new game never creates Web Audio or schedules notes before a gesture', () => {
  const audio = new GameAudio();
  audio.setMood('raid'); audio.update(10, { threat: 1 }); audio.play('shot');
  assert.equal(audio.context, null);
  assert.equal(audio.getDiagnostics().scheduledVoices, 0);
  assert.equal(audio.getDiagnostics().contextState, 'locked');
});

test('one master volume bus governs already playing music and effects', () => {
  const audio = new GameAudio(); audio.unlock(); audio.play('shot');
  assert.equal(audio._musicGain.connections[0], audio._master);
  assert.equal(audio._effects.connections[0], audio._master);
  audio.volume = 0;
  assert.equal(audio._master.gain.events.at(-1).value, 0);
  assert.equal(audio.getDiagnostics().musicRunning, false);
  const effects = audio.getDiagnostics().effectVoices;
  audio.play('shot');
  assert.equal(audio.getDiagnostics().effectVoices, effects);
  audio.volume = 1; audio.update(.016);
  assert.equal(audio.getDiagnostics().musicRunning, true);
  assert.equal(audio._master.gain.events.at(-1).value, 1);
});

test('music mute stops transport while weapon effects remain usable', () => {
  const audio = new GameAudio(); audio.unlock(); audio.musicVolume = 0;
  const notes = audio.getDiagnostics().scheduledNotes;
  audio.context.currentTime += 20; audio.update(20);
  assert.equal(audio.getDiagnostics().scheduledNotes, notes);
  assert.equal(audio.getDiagnostics().musicRunning, false);
  audio.play('shot');
  assert.equal(audio.getDiagnostics().effectVoices, 2);
  audio.musicVolume = .6; audio.update(.016);
  assert.equal(audio.getDiagnostics().musicRunning, true);
});

test('combat and extraction adapt music layers without recreating the transport', () => {
  const audio = new GameAudio(); audio.setMood('raid'); audio.unlock();
  const ambient = [...audio._musicVoices][0];
  audio.update(.5, { threat: 1 });
  assert.equal(audio.getDiagnostics().mood, 'combat');
  assert.equal(audio._layers.rhythm.gain.events.at(-1).value, .90);
  audio.update(.5, { threat: 1, extracting: true });
  assert.equal(audio.getDiagnostics().mood, 'extract');
  assert.equal(audio._layers.melody.gain.events.at(-1).value, .90);
  assert.ok(audio._musicVoices.has(ambient));
  audio.setMood('result'); audio.update(.5, { threat: 1 });
  assert.equal(audio.getDiagnostics().mood, 'result');
  audio.setMood('combat'); audio.update(.5);
  assert.equal(audio.getDiagnostics().mood, 'combat', 'explicit states persist until another setMood call');
});

test('pause cancels all voices and resuming does not replay delayed notes', () => {
  const audio = new GameAudio(); audio.unlock(); audio.update(.016, { paused: true });
  assert.equal(audio.getDiagnostics().musicRunning, false);
  for (const voice of audio._musicVoices) for (const source of voice.sources) assert.ok(source.stopTime <= .3);
  const notes = audio.getDiagnostics().scheduledNotes;
  audio.context.currentTime = 600; audio.update(600, { paused: true });
  assert.equal(audio.getDiagnostics().scheduledNotes, notes);
  audio.update(.016, { paused: false });
  assert.equal(audio.getDiagnostics().musicRunning, true);
  assert.ok(audio.getDiagnostics().scheduledNotes - notes <= 5);
  assert.ok(audio._nextStepTime > 600);
});

test('a stalled frame uses bounded look-ahead instead of scheduling a backlog', () => {
  const audio = new GameAudio(); audio.unlock();
  const notes = audio.getDiagnostics().scheduledNotes;
  audio.context.currentTime = 6000; audio.update(6000);
  assert.ok(audio.getDiagnostics().scheduledNotes - notes <= 5);
  for (let index = 0; index < 10000; index++) {
    audio.context.currentTime += .1; audio.update(.1);
    assert.ok(audio.getDiagnostics().scheduledVoices <= 48);
  }
  assert.ok(audio.getDiagnostics().scoreStep > 2000);
});
