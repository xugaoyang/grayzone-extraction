const TOGGLE_ACTIONS = new Set(['aim', 'sprint', 'crouch']);
const TOUCH_TYPES = new Set(['touch', 'pen']);

/** A circular stick, with a radial dead zone and no faster diagonal movement. */
export function stickVector(dx, dy, radius = 40, deadZone = .1) {
  if (![dx, dy, radius].every(Number.isFinite) || radius <= 0) return { x: 0, y: 0 };
  const distance = Math.hypot(dx, dy);
  const dead = Number.isFinite(deadZone) ? Math.min(.95, Math.max(0, deadZone)) : .1;
  const strength = Math.min(1, distance / radius);
  if (!distance || strength <= dead) return { x: 0, y: 0 };
  const scaled = (strength - dead) / (1 - dead);
  return { x: dx / distance * scaled, y: dy / distance * scaled };
}

/** Multi-pointer input. It never requests pointer lock or synthesizes mouse clicks. */
export class TouchControls {
  constructor({ root, joystick, knob, look, onLook = () => {}, onPress = () => {}, onRelease = () => {}, onMode = () => {} }) {
    this.root = root;
    this.joystick = joystick;
    this.knob = knob;
    this.look = look;
    this.onLook = onLook;
    this.onPress = onPress;
    this.onRelease = onRelease;
    this.onMode = onMode;
    this.window = root?.ownerDocument?.defaultView ?? globalThis.window;
    const matches = query => !!this.window?.matchMedia?.(query)?.matches;
    const hasTouch = (this.window?.navigator?.maxTouchPoints ?? 0) > 0;
    this.enabled = matches('(pointer: coarse)') || (hasTouch && matches('(hover: none)'));
    this.active = false;
    this._movement = { x: 0, y: 0 };
    this.pointers = new Map();
    this.actions = new Map();
    this.stickPointer = null;
    this.lookPointer = null;
    this.suppressMouseUntil = 0;
    this.listeners = [];
    this.buttons = [...(root?.querySelectorAll('[data-touch-action]') ?? [])];
    this.destroyed = false;

    this.listen(this.window, 'pointerdown', event => this.detectTouch(event), { capture: true, passive: true });
    this.listen(root, 'pointerdown', event => this.pointerDown(event), { passive: false });
    // Captured pointers normally stay over the control; window listeners also cover
    // browsers that lose capture when their address bar or an overlay appears.
    const motionTarget = this.window ?? root;
    this.listen(motionTarget, 'pointermove', event => this.pointerMove(event), { capture: true, passive: false });
    this.listen(motionTarget, 'pointerup', event => this.pointerEnd(event), { capture: true, passive: false });
    this.listen(motionTarget, 'pointercancel', event => this.pointerEnd(event), { capture: true, passive: false });
    this.listen(root, 'lostpointercapture', event => this.pointerEnd(event), { passive: false });
    this.listen(this.window, 'blur', () => this.reset());
    this.listen(this.window, 'resize', () => this.reset());
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      this.listen(root, type, event => {
        if (Date.now() < this.suppressMouseUntil) {
          event.preventDefault();
          event.stopImmediatePropagation?.();
          event.stopPropagation();
        }
      }, { capture: true, passive: false });
    }
  }

  get movement() { return { ...this._movement }; }

  listen(target, type, handler, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    this.listeners.push(() => target.removeEventListener(type, handler, options));
  }

  detectTouch(event) {
    if (this.destroyed || !TOUCH_TYPES.has(event.pointerType)) return;
    this.suppressMouseUntil = Date.now() + 900;
    if (!this.enabled) {
      this.enabled = true;
      this.onMode(true);
    }
  }

  consume(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  pointerDown(event) {
    if (this.destroyed || !TOUCH_TYPES.has(event.pointerType)) return;
    this.detectTouch(event);
    if (!this.active) return;
    this.consume(event);
    if (this.pointers.has(event.pointerId)) return;
    const button = event.target?.closest?.('[data-touch-action]');
    let pointer;
    if (button && this.root.contains(button) && !button.disabled && !button.hidden) {
      const action = button.dataset.touchAction;
      if (!action) return;
      pointer = { kind: 'button', action, capture: button };
    } else if (this.joystick?.contains(event.target)) {
      if (this.stickPointer !== null) return;
      const bounds = this.joystick.getBoundingClientRect();
      pointer = {
        kind: 'stick', capture: this.joystick,
        centerX: bounds.left + bounds.width / 2, centerY: bounds.top + bounds.height / 2,
        radius: Math.max(24, Math.min(56, Math.min(bounds.width, bounds.height) * .38)),
      };
      this.stickPointer = event.pointerId;
    } else if (this.look?.contains(event.target)) {
      if (this.lookPointer !== null) return;
      pointer = { kind: 'look', capture: this.look, x: event.clientX, y: event.clientY };
      this.lookPointer = event.pointerId;
    } else return;

    this.pointers.set(event.pointerId, pointer);
    try { pointer.capture.setPointerCapture?.(event.pointerId); } catch { /* Safari may already have cancelled the touch. */ }
    if (pointer.kind === 'stick') this.moveStick(pointer, event.clientX, event.clientY);
    if (pointer.kind === 'button') {
      let held = this.actions.get(pointer.action);
      if (!held) this.actions.set(pointer.action, held = new Set());
      held.add(event.pointerId);
      if (held.size === 1) {
        if (!TOGGLE_ACTIONS.has(pointer.action)) this.setPressed(pointer.action, true);
        // The callback can open an overlay and synchronously reset this instance.
        this.onPress(pointer.action);
      }
    }
  }

  moveStick(pointer, x, y) {
    const dx = x - pointer.centerX, dy = y - pointer.centerY;
    this._movement = stickVector(dx, dy, pointer.radius);
    const distance = Math.hypot(dx, dy);
    const scale = distance > pointer.radius ? pointer.radius / distance : 1;
    this.positionKnob(dx * scale, dy * scale);
  }

  positionKnob(x = 0, y = 0) {
    if (this.knob) this.knob.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
  }

  pointerMove(event) {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    this.consume(event);
    this.suppressMouseUntil = Date.now() + 900;
    if (pointer.kind === 'stick') this.moveStick(pointer, event.clientX, event.clientY);
    if (pointer.kind === 'look') {
      const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
      pointer.x = event.clientX; pointer.y = event.clientY;
      if (dx || dy) this.onLook(dx, dy);
    }
  }

  pointerEnd(event) {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    this.consume(event);
    this.suppressMouseUntil = Date.now() + 900;
    this.pointers.delete(event.pointerId);
    if (pointer.kind === 'stick') {
      this.stickPointer = null;
      this._movement = { x: 0, y: 0 };
      this.positionKnob();
    }
    if (pointer.kind === 'look') this.lookPointer = null;
    if (pointer.kind === 'button') {
      const held = this.actions.get(pointer.action);
      held?.delete(event.pointerId);
      if (!held?.size) {
        this.actions.delete(pointer.action);
        if (!TOGGLE_ACTIONS.has(pointer.action)) this.setPressed(pointer.action, false);
        this.onRelease(pointer.action);
      }
    }
    this.releaseCapture(pointer, event.pointerId);
  }

  releaseCapture(pointer, pointerId) {
    try {
      if (pointer.capture.hasPointerCapture?.(pointerId)) pointer.capture.releasePointerCapture(pointerId);
    } catch { /* Capture can disappear while the browser changes visibility. */ }
  }

  setPressed(action, pressed) {
    for (const button of this.buttons) {
      if (button.dataset.touchAction !== action) continue;
      button.classList.toggle('active', !!pressed);
      button.setAttribute('aria-pressed', String(!!pressed));
    }
  }

  setActive(active) {
    this.active = !!active && !this.destroyed;
    if (!this.active) this.reset();
  }

  reset() {
    const pointers = [...this.pointers];
    const actions = [...this.actions.keys()];
    // Delete state before releasing capture or invoking callbacks: both may emit
    // more events/reset calls during an overlay transition.
    this.pointers.clear(); this.actions.clear();
    this.stickPointer = null; this.lookPointer = null;
    this._movement = { x: 0, y: 0 };
    this.positionKnob();
    for (const button of this.buttons) this.setPressed(button.dataset.touchAction, false);
    for (const [pointerId, pointer] of pointers) this.releaseCapture(pointer, pointerId);
    for (const action of actions) this.onRelease(action);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.active = false;
    this.reset();
    for (const remove of this.listeners) remove();
    this.listeners.length = 0;
  }
}
