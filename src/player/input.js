// Keyboard, mouse, gamepad and touch, normalised into one small state object.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.locked = false;
    this.buttons = [false, false, false];
    this.clicked = [false, false, false];
    this.sensitivity = 0.0022;
    this.invertY = false;
    this.enabled = true;
    this.move = { x: 0, y: 0 }; // analogue movement, -1..1
    this.touch = { active: false, look: null, move: null, moveOrigin: null };
    this._listeners = [];
    this._bind();
  }

  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn]);
  }

  _bind() {
    this._on(window, 'keydown', (e) => {
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      const k = e.code;
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
      if (SWALLOW.has(k)) e.preventDefault();
    });
    this._on(window, 'keyup', (e) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
    });
    this._on(window, 'blur', () => {
      this.keys.clear();
      this.buttons = [false, false, false];
    });

    this._on(this.canvas, 'mousedown', (e) => {
      if (!this.locked) return;
      this.buttons[e.button] = true;
      this.clicked[e.button] = true;
    });
    this._on(window, 'mouseup', (e) => {
      this.buttons[e.button] = false;
    });
    this._on(window, 'mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });
    this._on(this.canvas, 'wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
    this._on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    this._on(document, 'contextmenu', (e) => {
      if (this.locked) e.preventDefault();
    });

    /* ------------------------------------------------------------- touch */
    const touchLook = new Map();
    this._on(this.canvas, 'touchstart', (e) => {
      this.touch.active = true;
      for (const t of e.changedTouches) {
        if (t.clientX < window.innerWidth * 0.45 && !this.touch.move) {
          this.touch.move = t.identifier;
          this.touch.moveOrigin = { x: t.clientX, y: t.clientY };
        } else if (this.touch.look === null) {
          this.touch.look = t.identifier;
          touchLook.set(t.identifier, { x: t.clientX, y: t.clientY, t: performance.now() });
        }
      }
      e.preventDefault();
    }, { passive: false });
    this._on(this.canvas, 'touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.touch.move && this.touch.moveOrigin) {
          const dx = (t.clientX - this.touch.moveOrigin.x) / 62;
          const dy = (t.clientY - this.touch.moveOrigin.y) / 62;
          this.move.x = Math.max(-1, Math.min(1, dx));
          this.move.y = Math.max(-1, Math.min(1, -dy));
        } else if (t.identifier === this.touch.look) {
          const p = touchLook.get(t.identifier);
          if (p) {
            this.mouseDX += (t.clientX - p.x) * 1.5;
            this.mouseDY += (t.clientY - p.y) * 1.5;
            p.x = t.clientX;
            p.y = t.clientY;
          }
        }
      }
      e.preventDefault();
    }, { passive: false });
    this._on(this.canvas, 'touchend', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.touch.move) {
          this.touch.move = null;
          this.move.x = this.move.y = 0;
        } else if (t.identifier === this.touch.look) {
          const p = touchLook.get(t.identifier);
          // A quick tap on the right side counts as "interact".
          if (p && performance.now() - p.t < 260 &&
              Math.abs(t.clientX - p.x) < 12 && Math.abs(t.clientY - p.y) < 12) {
            this.pressed.add('KeyE');
          }
          touchLook.delete(t.identifier);
          this.touch.look = null;
        }
      }
    });
  }

  requestLock() {
    if (this.canvas.requestPointerLock) {
      const r = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (r && r.catch) r.catch(() => this.canvas.requestPointerLock());
    }
  }

  exitLock() {
    if (document.exitPointerLock) document.exitPointerLock();
  }

  down(code) {
    return this.keys.has(code);
  }
  hit(code) {
    return this.pressed.has(code);
  }

  /** Movement intent in local space: x = strafe, y = forward. */
  axes(out = { x: 0, y: 0 }) {
    let x = this.move.x;
    let y = this.move.y;
    if (this.down('KeyW') || this.down('ArrowUp')) y += 1;
    if (this.down('KeyS') || this.down('ArrowDown')) y -= 1;
    if (this.down('KeyD') || this.down('ArrowRight')) x += 1;
    if (this.down('KeyA') || this.down('ArrowLeft')) x -= 1;
    const gp = this._gamepad();
    if (gp) {
      if (Math.abs(gp.axes[0]) > 0.16) x += gp.axes[0];
      if (Math.abs(gp.axes[1]) > 0.16) y -= gp.axes[1];
    }
    const l = Math.hypot(x, y);
    if (l > 1) {
      x /= l;
      y /= l;
    }
    out.x = x;
    out.y = y;
    return out;
  }

  _gamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  /** Called once per frame after all systems have read the state. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.clicked[0] = this.clicked[1] = this.clicked[2] = false;
  }

  dispose() {
    for (const [t, type, fn] of this._listeners) t.removeEventListener(type, fn);
    this._listeners.length = 0;
  }
}

const SWALLOW = new Set([
  'Space', 'Tab', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
]);
