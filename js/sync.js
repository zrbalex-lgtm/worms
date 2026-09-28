// Client-side snapshot buffer: decodes host snapshots and interpolates between them.
import { NET } from './config.js';
import { F_ALIVE, F_RIGHT, F_GROUND, F_WALK, F_GONE, F_KNOCK } from './game.js';

function decode(s, setup) {
  const worms = [];
  const info = setup.wormMap;
  for (let i = 0; i < s.w.length; i += 5) {
    const id = s.w[i];
    const f = s.w[i + 4];
    const meta = info.get(id);
    worms.push({
      id,
      team: meta ? meta.team : 0,
      name: meta ? meta.name : '?',
      x: s.w[i + 1],
      y: s.w[i + 2],
      hp: s.w[i + 3],
      alive: !!(f & F_ALIVE),
      facing: f & F_RIGHT ? 1 : -1,
      onGround: !!(f & F_GROUND),
      walking: !!(f & F_WALK),
      gone: !!(f & F_GONE),
      knocked: !!(f & F_KNOCK),
    });
  }
  const projectiles = [];
  for (let i = 0; i < s.p.length; i += 5) {
    projectiles.push({ id: s.p[i], type: s.p[i + 1], x: s.p[i + 2], y: s.p[i + 3], a: s.p[i + 4] });
  }
  return {
    t: s.tm,
    phase: s.ph,
    turnTeam: s.tt,
    activeWorm: s.aw,
    timeLeft: s.tl,
    wind: s.wd,
    weapon: s.wp,
    elev: s.el,
    power: s.pw,
    shotsLeft: s.sl,
    locked: !!s.lk,
    winner: s.win,
    grenades: s.tg,
    connected: s.tc.map(Boolean),
    worms,
    projectiles,
  };
}

const lerp = (a, b, t) => a + (b - a) * t;

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class ClientSync {
  constructor(setup) {
    this.setup = setup;
    this.buffer = [];
    this.events = [];
    this.offset = null; // local clock minus host clock (seconds)
    this.renderT = 0;
  }

  push(snap, nowSec) {
    const sample = nowSec - snap.tm;
    if (this.offset === null || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.02;
    if (snap.ev) for (const e of snap.ev) this.events.push(e);
    this.buffer.push(decode(snap, this.setup));
    if (this.buffer.length > 40) this.buffer.splice(0, this.buffer.length - 40);
  }

  get ready() { return this.buffer.length > 0; }

  // Interpolated view at the current render time.
  view(nowSec) {
    const buf = this.buffer;
    if (!buf.length) return null;
    const target = nowSec - this.offset - NET.INTERP_DELAY;
    this.renderT = Math.max(this.renderT, Math.min(target, buf[buf.length - 1].t));
    const rt = this.renderT;
    // Drop snapshots that are fully in the past.
    while (buf.length > 2 && buf[1].t <= rt) buf.shift();
    const a = buf[0];
    const b = buf[1];
    if (!b || rt <= a.t) return a;
    const k = Math.max(0, Math.min(1, (rt - a.t) / Math.max(1e-6, b.t - a.t)));
    const prevW = new Map(a.worms.map(w => [w.id, w]));
    const prevP = new Map(a.projectiles.map(p => [p.id, p]));
    const worms = b.worms.map(w => {
      const p = prevW.get(w.id);
      if (!p || p.gone !== w.gone || Math.abs(p.x - w.x) > 200) return w;
      return { ...w, x: lerp(p.x, w.x, k), y: lerp(p.y, w.y, k) };
    });
    const projectiles = b.projectiles.map(pr => {
      const p = prevP.get(pr.id);
      if (!p) return pr;
      return { ...pr, x: lerp(p.x, pr.x, k), y: lerp(p.y, pr.y, k), a: pr.type === 2 ? lerpAngle(p.a, pr.a, k) : pr.a };
    });
    // Discrete fields come from the older snapshot so they line up with the events.
    return { ...a, t: rt, timeLeft: lerp(a.timeLeft, b.timeLeft, k), worms, projectiles };
  }

  // Events whose host time has been reached by the render clock.
  takeEvents() {
    const out = [];
    const rt = this.renderT;
    let i = 0;
    while (i < this.events.length && this.events[i].t <= rt) i++;
    if (i) out.push(...this.events.splice(0, i));
    return out;
  }
}
