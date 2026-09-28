// Unified input: keyboard, mouse and touch (Pointer Events) mapped to game actions.
// Actions sent to the game: move {dir}, jump, aim {elev, facing?, pw?}, fire {elev, facing?, pw},
// weapon {w}, switch {id?}. Camera panning/zooming is local only.
import { WEAPONS } from './weapons.js';

const AIM_SPEED = 1.3;        // radians per second for keyboard aiming
const CHARGE_TIME = 1.5;      // seconds to reach full power
const SLING_MAX = 150;        // CSS px drag length for full power
const SLING_MIN = 18;         // shorter drags count as a tap
const SLING_GRAB = 60;        // CSS px radius around the worm that starts a slingshot
const SEND_EVERY = 0.08;      // seconds between aim updates

export class Input {
  constructor({ canvas, renderer, ui, hooks }) {
    this.canvas = canvas;
    this.r = renderer;
    this.ui = ui;
    this.h = hooks;
    this.keys = new Set();
    this.btnLeft = false;
    this.btnRight = false;
    this.lastMove = 0;
    this.elev = 0.6;
    this.power = 0.65;       // last used power (fire button reuses it)
    this.charging = false;
    this.chargePower = 0;
    this.aimDirty = false;
    this.sendTimer = 0;
    this.sling = null;       // { id, x0, y0, x1, y1, elev, facing, power }
    this.pointers = new Map();
    this.pinch = null;
    this.mouse = { x: 0, y: 0, inside: false };
    this.touchSeen = false;
    this.bind();
  }

  // Called when a new turn of mine starts.
  // The aim elevation is kept locally between turns (the host stores the same value).
  resetTurn() {
    this.charging = false;
    this.sling = null;
    this.lastMove = 0;
  }

  get enabled() { return this.h.inGame(); }

  canAct() {
    const v = this.h.getView();
    return !!v && this.h.isMyTurn() && v.phase === 'turn';
  }

  canMove() {
    const v = this.h.getView();
    return !!v && this.h.isMyTurn() && (v.phase === 'turn' || v.phase === 'retreat');
  }

  currentWeapon() {
    const v = this.h.getView();
    return v ? v.weapon : 0;
  }

  // Aim info for the renderer (only used during my own turn).
  localAim() {
    if (this.sling && this.sling.active) {
      return { elev: this.sling.elev, facing: this.sling.facing, power: this.sling.power, preview: true };
    }
    return { elev: this.elev, facing: 0, power: this.charging ? this.chargePower : 0, preview: false };
  }

  slingOverlay() {
    const s = this.sling;
    if (!s || !s.active) return null;
    return { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 };
  }

  fire(power, facing) {
    if (!this.canAct()) return;
    const a = { a: 'fire', elev: this.elev, pw: power };
    if (facing) a.facing = facing;
    if (WEAPONS[this.currentWeapon()].usesPower) this.power = power;
    this.h.send(a);
  }

  // ---------- Event binding ----------

  bind() {
    addEventListener('keydown', e => this.onKey(e, true));
    addEventListener('keyup', e => this.onKey(e, false));
    addEventListener('blur', () => { this.keys.clear(); this.btnLeft = this.btnRight = false; this.charging = false; });

    const c = this.canvas;
    c.addEventListener('pointerdown', e => this.onPointerDown(e));
    c.addEventListener('pointermove', e => this.onPointerMove(e));
    c.addEventListener('pointerup', e => this.onPointerUp(e, false));
    c.addEventListener('pointercancel', e => this.onPointerUp(e, true));
    c.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') this.mouse.inside = false; });
    c.addEventListener('wheel', e => {
      if (!this.enabled) return;
      e.preventDefault();
      this.r.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    }, { passive: false });
    c.addEventListener('contextmenu', e => e.preventDefault());

    // Touch buttons.
    this.hold('btn-left', () => { this.btnLeft = true; }, () => { this.btnLeft = false; });
    this.hold('btn-right', () => { this.btnRight = true; }, () => { this.btnRight = false; });
    this.hold('btn-jump', () => { if (this.canMove()) this.h.send({ a: 'jump' }); });
    this.hold('btn-fire', () => {
      if (!this.canAct()) return;
      const w = this.currentWeapon();
      this.fire(WEAPONS[w].usesPower ? this.power : 1);
    });
    this.hold('btn-weapon', () => { if (this.canAct()) this.ui.openPicker(); });
    this.hold('btn-center', () => this.r.centerOnActive());
    document.getElementById('weapon-chip').addEventListener('click', () => {
      if (this.canAct()) this.ui.openPicker();
    });
    const picker = document.getElementById('weapon-picker');
    picker.addEventListener('pointerdown', e => {
      const item = e.target.closest('.picker-item');
      e.preventDefault();
      if (item) {
        this.h.send({ a: 'weapon', w: Number(item.dataset.weapon) });
        this.h.sfx('select');
      }
      this.ui.closePicker();
    });
  }

  // Press-and-hold button helper with per-pointer tracking (multi-touch safe).
  hold(id, down, up) {
    const el = document.getElementById(id);
    if (!el) return;
    const active = new Set();
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      if (e.pointerType === 'touch') this.markTouch();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
      active.add(e.pointerId);
      el.classList.add('pressed');
      if (active.size === 1) down();
    });
    const end = e => {
      if (!active.delete(e.pointerId)) return;
      if (active.size === 0) {
        el.classList.remove('pressed');
        if (up) up();
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('contextmenu', e => e.preventDefault());
  }

  markTouch() {
    if (this.touchSeen) return;
    this.touchSeen = true;
    document.body.classList.add('touch');
    this.r.touch = true;
  }

  onKey(e, down) {
    if (!this.enabled) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const k = e.key;
    const code = e.code;
    const handled = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Tab', 'Enter'].includes(k);
    if (handled) e.preventDefault();
    if (down) {
      if (e.repeat && !['ArrowUp', 'ArrowDown'].includes(k)) {
        // Held keys are tracked through the key set; ignore auto-repeat.
      }
      this.keys.add(code);
      if (e.repeat) return;
      if (code === 'KeyW' || k === 'Enter') { if (this.canMove()) this.h.send({ a: 'jump' }); }
      else if (k === 'Tab') { if (this.canAct()) this.h.send({ a: 'switch' }); }
      else if (/^Digit[1-5]$/.test(code) || /^Numpad[1-5]$/.test(code)) {
        if (this.canAct()) { this.h.send({ a: 'weapon', w: Number(code.slice(-1)) - 1 }); this.h.sfx('select'); }
      } else if (k === ' ') {
        if (!this.canAct()) return;
        const w = this.currentWeapon();
        if (WEAPONS[w].usesPower) { this.charging = true; this.chargePower = 0; }
        else this.fire(1);
      } else if (code === 'KeyC' || k === 'Home') this.r.centerOnActive();
      else if (k === 'Escape') this.ui.closePicker();
      else if (k === '+' || k === '=') this.r.zoomAt(1.15, this.r.cssW / 2, this.r.cssH / 2);
      else if (k === '-') this.r.zoomAt(1 / 1.15, this.r.cssW / 2, this.r.cssH / 2);
    } else {
      this.keys.delete(code);
      if (k === ' ' && this.charging) {
        this.charging = false;
        this.fire(Math.max(0.05, this.chargePower));
      }
      if (code === 'ArrowUp' || code === 'ArrowDown') this.aimDirty = true;
    }
  }

  // ---------- Pointer (mouse + touch) on the canvas ----------

  onPointerDown(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this.h.unlockAudio();
    if (e.pointerType === 'touch') this.markTouch();
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const p = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), mode: 'pending', type: e.pointerType };
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 2) {
      // Second finger: switch to pinch zoom, cancel any slingshot.
      this.sling = null;
      const [a, b] = [...this.pointers.values()];
      a.mode = b.mode = 'pinch';
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      return;
    }
    if (this.pointers.size > 2) { p.mode = 'ignore'; return; }

    // Start a slingshot when grabbing near the active worm during my turn.
    if (this.canAct()) {
      const w = this.h.activeWorm();
      if (w) {
        const s = this.r.wormScreen(w);
        if (Math.hypot(e.clientX - s.x, e.clientY - (s.y - 2)) < SLING_GRAB) {
          p.mode = 'sling';
          this.sling = { id: e.pointerId, active: false, x0: s.x, y0: s.y - 2, x1: e.clientX, y1: e.clientY, elev: this.elev, facing: w.facing, power: this.power };
        }
      }
    }
  }

  onPointerMove(e) {
    if (e.pointerType === 'mouse') {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.inside = true;
    }
    if (!this.enabled) return;
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;

    if (p.mode === 'pinch' && this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (this.pinch.d > 10) this.r.zoomAt(d / this.pinch.d, mx, my);
      this.r.panBy(mx - this.pinch.mx, my - this.pinch.my);
      this.pinch = { d, mx, my };
      return;
    }
    if (p.mode === 'sling' && this.sling && this.sling.id === p.id) {
      const s = this.sling;
      s.x1 = e.clientX;
      s.y1 = e.clientY;
      const vx = s.x0 - s.x1;
      const vy = s.y0 - s.y1;
      const len = Math.hypot(vx, vy);
      if (len >= SLING_MIN) {
        s.active = true;
        s.facing = vx >= 0 ? 1 : -1;
        s.elev = Math.atan2(-vy, Math.abs(vx));
        s.power = Math.max(0.05, Math.min(1, (len - SLING_MIN) / (SLING_MAX - SLING_MIN)));
        this.elev = s.elev;
        this.aimDirty = true;
      } else {
        s.active = false;
      }
      return;
    }
    if (p.mode === 'pending' && Math.hypot(p.x - p.x0, p.y - p.y0) > 8) {
      p.mode = 'pan';
      this.r.panBy(p.x - p.x0, p.y - p.y0);
      return;
    }
    if (p.mode === 'pan') this.r.panBy(dx, dy);
  }

  onPointerUp(e, cancelled) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!this.enabled) return;
    // Remaining finger after a pinch keeps panning.
    for (const q of this.pointers.values()) if (q.mode === 'pinch') { q.mode = 'pan'; }

    if (p.mode === 'sling' && this.sling && this.sling.id === p.id) {
      const s = this.sling;
      this.sling = null;
      if (!cancelled && s.active && this.canAct()) {
        const w = this.currentWeapon();
        this.elev = s.elev;
        this.fire(WEAPONS[w].usesPower ? s.power : 1, s.facing);
      }
      // A short press on the active worm without dragging does nothing.
      return;
    }
    if (p.mode === 'pending' && !cancelled && performance.now() - p.t0 < 500) this.onTap(p.x, p.y);
  }

  onTap(x, y) {
    if (!this.canAct()) return;
    const v = this.h.getView();
    if (!v || v.locked) return;
    let best = null;
    let bestD = 30;
    for (const w of v.worms) {
      if (!w.alive || w.team !== this.h.myTeam()) continue;
      const s = this.r.wormScreen(w);
      const d = Math.hypot(s.x - x, s.y - 2 - y);
      if (d < bestD) { best = w; bestD = d; }
    }
    if (best && best.id !== v.activeWorm) {
      this.h.send({ a: 'switch', id: best.id });
      this.h.sfx('select');
    }
  }

  // ---------- Per-frame update ----------

  update(dt) {
    if (!this.enabled) return;
    const myTurn = this.canMove();

    // Walking (keyboard + touch buttons).
    const left = this.keys.has('ArrowLeft') || this.keys.has('KeyA') || this.btnLeft;
    const right = this.keys.has('ArrowRight') || this.keys.has('KeyD') || this.btnRight;
    const dir = myTurn && !(this.sling && this.sling.active) ? (right ? 1 : 0) - (left ? 1 : 0) : 0;
    if (dir !== this.lastMove) {
      if (myTurn || this.lastMove !== 0) this.h.send({ a: 'move', dir });
      this.lastMove = dir;
    }

    // Keyboard aiming.
    if (this.canAct()) {
      const aimDir = (this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('ArrowDown') ? 1 : 0);
      if (aimDir) {
        this.elev = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.elev + aimDir * AIM_SPEED * dt));
        this.aimDirty = true;
      }
      if (this.charging) {
        this.chargePower = Math.min(1, this.chargePower + dt / CHARGE_TIME);
        this.aimDirty = true;
        if (this.chargePower >= 1) {
          this.charging = false;
          this.fire(1);
        }
      }
    } else {
      this.charging = false;
      if (this.sling && !this.canAct()) this.sling = null;
    }

    // Throttled aim updates so the host (and spectators) see the aim.
    this.sendTimer -= dt;
    if (this.aimDirty && this.sendTimer <= 0 && this.canAct()) {
      this.aimDirty = false;
      this.sendTimer = SEND_EVERY;
      const a = { a: 'aim', elev: Math.round(this.elev * 1000) / 1000 };
      if (this.sling && this.sling.active) { a.facing = this.sling.facing; a.pw = Math.round(this.sling.power * 100) / 100; }
      else if (this.charging) a.pw = Math.round(this.chargePower * 100) / 100;
      this.h.send(a);
    }

    // Mouse edge scrolling.
    const m = this.mouse;
    if (m.inside && !this.touchSeen && this.pointers.size === 0 && document.hasFocus()) {
      const edge = 14;
      const speed = 700 * dt;
      let px = 0, py = 0;
      if (m.x < edge) px = speed; else if (m.x > this.r.cssW - edge) px = -speed;
      if (m.y < edge) py = speed; else if (m.y > this.r.cssH - edge) py = -speed;
      if (px || py) this.r.panBy(px, py);
    }
  }
}
