import test from 'node:test';
import assert from 'node:assert/strict';
import { stickVector, TouchControls } from '../src/touch-controls.js';

class Target {
  constructor(parent = null, action = null) {
    this.parent = parent; this.listeners = new Map(); this.style = {}; this.attributes = {};
    this.dataset = action ? { touchAction: action } : {};
    this.classes = new Set(); this.captured = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type, values = {}) {
    const event = {
      type, target: this, pointerType: 'touch', pointerId: 1, clientX: 150, clientY: 150,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...values,
    };
    for (const callback of [...(this.listeners.get(type) ?? [])]) callback(event);
    return event;
  }
  closest() { return this.dataset.touchAction ? this : this.parent?.closest(); }
  contains(target) { return target === this || (target?.parent ? this.contains(target.parent) : false); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getBoundingClientRect() { return { left: 100, top: 100, width: 100, height: 100 }; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
}

function fixture(coarse = true) {
  const window = new Target();
  window.matchMedia = () => ({ matches: coarse });
  window.navigator = { maxTouchPoints: coarse ? 5 : 0 };
  const root = new Target(), joystick = new Target(root), knob = new Target(joystick), look = new Target(root);
  root.ownerDocument = { defaultView: window };
  const buttons = Object.fromEntries(['fire', 'aim', 'reload', 'interact', 'sprint', 'pause'].map(action => [action, new Target(root, action)]));
  root.querySelectorAll = () => Object.values(buttons);
  const presses = [], releases = [], looks = [], modes = [];
  const controls = new TouchControls({ root, joystick, knob, look, onPress: action => presses.push(action), onRelease: action => releases.push(action), onLook: (x, y) => looks.push([x, y]), onMode: enabled => modes.push(enabled) });
  controls.setActive(true);
  return { controls, window, root, joystick, knob, look, buttons, presses, releases, looks, modes };
}

test('stick limits diagonals radially, remaps the dead zone, and rejects invalid bounds', () => {
  assert.deepEqual(stickVector(0, 0), { x: 0, y: 0 });
  assert.deepEqual(stickVector(3, 0, 40), { x: 0, y: 0 });
  assert.deepEqual(stickVector(400, 0, 40), { x: 1, y: 0 });
  assert.deepEqual(stickVector(0, -400, 40), { x: 0, y: -1 });
  const diagonal = stickVector(100, 100, 40);
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.y) - 1) < 1e-12);
  assert.equal(diagonal.x, diagonal.y);
  assert.ok(Math.abs(stickVector(22, 0, 40).x - .5) < 1e-12);
  for (const args of [[NaN, 0], [0, Infinity], [1, 1, 0], [1, 1, -5]]) assert.deepEqual(stickVector(...args), { x: 0, y: 0 });
});

test('movement, look and firing use independent pointers and cancel without sticky input', () => {
  const f = fixture();
  f.root.emit('pointerdown', { target: f.joystick, pointerId: 1, clientX: 150, clientY: 110 });
  f.root.emit('pointerdown', { target: f.look, pointerId: 2, clientX: 450, clientY: 150 });
  f.root.emit('pointerdown', { target: f.buttons.fire, pointerId: 3 });
  assert.equal(f.controls.movement.y, -1);
  assert.deepEqual(f.presses, ['fire']);
  f.window.emit('pointermove', { pointerId: 2, clientX: 470, clientY: 160 });
  assert.deepEqual(f.looks, [[20, 10]]);
  f.window.emit('pointercancel', { pointerId: 3 });
  assert.deepEqual(f.releases, ['fire']);
  assert.equal(f.controls.movement.y, -1);
  assert.equal(f.buttons.fire.attributes['aria-pressed'], 'false');
  f.window.emit('pointerup', { pointerId: 1 });
  assert.deepEqual(f.controls.movement, { x: 0, y: 0 });
  f.window.emit('pointermove', { pointerId: 2, clientX: 475, clientY: 170 });
  assert.deepEqual(f.looks, [[20, 10], [5, 10]]);
  f.controls.destroy();
});

test('duplicate fingers on a held action release only after the final finger leaves', () => {
  const f = fixture();
  f.root.emit('pointerdown', { target: f.buttons.fire, pointerId: 10 });
  f.root.emit('pointerdown', { target: f.buttons.fire, pointerId: 11 });
  f.window.emit('pointerup', { pointerId: 10 });
  assert.deepEqual(f.presses, ['fire']); assert.deepEqual(f.releases, []);
  f.root.emit('lostpointercapture', { pointerId: 11 });
  assert.deepEqual(f.releases, ['fire']);
  f.window.emit('pointerup', { pointerId: 11 });
  assert.deepEqual(f.releases, ['fire']);
  f.controls.destroy();
});

test('toggle feedback is controlled by the game and survives pointer release', () => {
  const f = fixture();
  f.root.emit('pointerdown', { target: f.buttons.aim });
  f.controls.setPressed('aim', true);
  f.window.emit('pointerup');
  assert.equal(f.buttons.aim.attributes['aria-pressed'], 'true');
  assert.equal(f.buttons.aim.classes.has('active'), true);
  f.controls.reset();
  assert.equal(f.buttons.aim.attributes['aria-pressed'], 'false');
  f.controls.destroy();
});

test('an overlay can synchronously disable controls from an action callback', () => {
  const f = fixture();
  f.controls.onPress = action => { f.presses.push(action); f.controls.setActive(false); };
  f.controls.onRelease = action => { f.releases.push(action); f.controls.reset(); };
  f.root.emit('pointerdown', { target: f.buttons.pause, pointerId: 25 });
  assert.deepEqual(f.presses, ['pause']); assert.deepEqual(f.releases, ['pause']);
  assert.equal(f.controls.pointers.size, 0); assert.equal(f.buttons.pause.captured.size, 0);
  f.window.emit('pointerup', { pointerId: 25 });
  f.root.emit('pointerdown', { target: f.buttons.fire, pointerId: 26 });
  assert.deepEqual(f.presses, ['pause']);
  f.controls.destroy();
});

test('blur and destroy release held actions, and destruction detaches all listeners', () => {
  const f = fixture();
  f.root.emit('pointerdown', { target: f.buttons.interact, pointerId: 32 });
  f.window.emit('blur');
  assert.deepEqual(f.releases, ['interact']);
  f.root.emit('pointerdown', { target: f.buttons.fire, pointerId: 33 });
  f.controls.destroy(); f.controls.destroy();
  assert.deepEqual(f.releases, ['interact', 'fire']);
  assert.ok([...f.root.listeners.values(), ...f.window.listeners.values()].every(listeners => !listeners.size));
  f.root.emit('pointerdown', { target: f.buttons.fire, pointerId: 34 });
  assert.deepEqual(f.presses, ['interact', 'fire']);
});

test('touch enables controls on a desktop detection and consumes compatibility mouse events', () => {
  const f = fixture(false);
  assert.equal(f.controls.enabled, false);
  f.window.emit('pointerdown', { pointerType: 'mouse' });
  assert.deepEqual(f.modes, []);
  f.window.emit('pointerdown', { pointerType: 'touch' });
  assert.equal(f.controls.enabled, true); assert.deepEqual(f.modes, [true]);
  const down = f.root.emit('pointerdown', { target: f.buttons.fire });
  assert.equal(down.prevented, true);
  const mouse = f.root.emit('mousedown', { pointerType: 'mouse' });
  assert.equal(mouse.prevented, true); assert.equal(mouse.stopped, true);
  f.window.emit('pointerdown', { pointerType: 'touch' });
  assert.deepEqual(f.modes, [true]);
  f.controls.destroy();
});

test('only one finger drives each stick/look surface and snapshots cannot mutate movement', () => {
  const f = fixture();
  f.root.emit('pointerdown', { target: f.joystick, pointerId: 1, clientX: 190 });
  f.root.emit('pointerdown', { target: f.joystick, pointerId: 2, clientX: 110 });
  assert.equal(f.controls.movement.x, 1);
  f.controls.movement.x = 0;
  assert.equal(f.controls.movement.x, 1);
  f.root.emit('pointerdown', { target: f.look, pointerId: 3 });
  f.root.emit('pointerdown', { target: f.look, pointerId: 4 });
  f.window.emit('pointermove', { pointerId: 4, clientX: 200 });
  assert.deepEqual(f.looks, []);
  f.window.emit('resize');
  assert.deepEqual(f.controls.movement, { x: 0, y: 0 });
  assert.equal(f.controls.pointers.size, 0);
  f.controls.destroy();
});
