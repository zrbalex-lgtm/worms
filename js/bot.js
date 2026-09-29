// Computer-controlled teams. Runs on the host only and drives a team through the same
// input actions a human sends, so every client sees normal walking and aiming.
import { WORLD, PHYS } from './config.js';
import { collides } from './physics.js';
import {
  WEAPONS, W_FIST, W_MINIGUN, W_SHOTGUN, W_GRENADE, W_BAZOOKA, W_TELEPORT,
  fireWeapon, updateProjectiles,
} from './weapons.js';

export const BOT_LEVELS = {
  rookie: {
    label: 'Rookie', elevErr: 0.1, powErr: 0.12, useWind: false, eStep: 0.15, pStep: 0.12,
    refine: false, pickFrom: 4, selfWeight: 0.7, retreat: false, think: [1.4, 2.2], hitscan: 0.6, teleport: false,
  },
  pro: {
    label: 'Professional', elevErr: 0.03, powErr: 0.035, useWind: true, eStep: 0.1, pStep: 0.075,
    refine: true, pickFrom: 1, selfWeight: 1.6, retreat: true, think: [0.9, 1.4], hitscan: 1, teleport: true,
  },
  killer: {
    label: 'Killer', elevErr: 0.006, powErr: 0.008, useWind: true, eStep: 0.08, pStep: 0.06,
    refine: true, pickFrom: 1, selfWeight: 2.5, retreat: true, think: [0.6, 1.0], hitscan: 1, teleport: true,
  },
};
export const BOT_LEVEL_KEYS = Object.keys(BOT_LEVELS);

const R = PHYS.WORM_R;
const BLAST = { [W_BAZOOKA]: { r: 52, dmg: 50 }, [W_GRENADE]: { r: 48, dmg: 50 } };
const AMMO_COST = { [W_BAZOOKA]: 9, [W_GRENADE]: 6 };
const WALK_IF_BELOW = 12;   // plan scores below this make the bot walk closer first
const BUDGET_MS = 3;        // planning time per simulation step

const rand = (a, b) => a + Math.random() * (b - a);
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class BotManager {
  constructor(game) {
    this.game = game;
    this.key = null;
    this.s = null;
    // Lightweight stand-in for the game used to simulate shots with the real projectile code.
    this.sim = {
      terrain: game.terrain,
      worms: game.worms,
      wind: 0,
      projectiles: [],
      bursts: [],
      nextId: 1,
      turn: { shotsLeft: 2 },
      result: null,
      get waterY() { return game.waterY; },
      emit() {},
      explode(x, y, r, dmg, kb) { if (!this.result) this.result = { x, y, r, dmg, kb }; },
    };
  }

  // ---------- Per-step driver ----------

  update(dt) {
    const g = this.game;
    const team = g.activeTeam;
    if (!team || !team.bot || g.phase === 'over' || g.phase === 'settle' || !g.active) {
      this.key = null;
      return;
    }
    const key = g.turnCount + ':' + team.idx;
    if (key !== this.key) {
      this.key = key;
      const lv = BOT_LEVELS[team.bot] || BOT_LEVELS.pro;
      this.s = { lv, team, state: 'think', t: rand(lv.think[0], lv.think[1]), walks: 0, plan: null, gen: null, shots: 0,
        startX: g.active ? g.active.x : 0, startY: g.active ? g.active.y : 0 };
    }
    const s = this.s;
    const w = g.active;
    if (!w || !w.alive) return;
    s.t -= dt;
    switch (s.state) {
      case 'think':
        if (s.t <= 0) this.startPlanning();
        break;
      case 'plan': this.stepPlanning(); break;
      case 'walk': this.stepWalk(dt); break;
      case 'aim': this.stepAim(dt); break;
      case 'charge': this.stepCharge(dt); break;
      case 'between': // waiting between shotgun shots
        if (s.t <= 0 && g.phase === 'turn') {
          const next = this.bestHitscan(W_SHOTGUN);
          if (next) { s.plan = next; this.beginAim(); } else { s.state = 'skip'; s.t = 0.6; }
        }
        break;
      case 'retreat': this.stepRetreat(dt); break;
      case 'flip': this.stepFlip(dt); break;
      case 'skip':
        if (s.t <= 0) { this.send({ a: 'skip' }); s.state = 'done'; }
        break;
      case 'done':
        break;
    }
    // Safety net: a bot that has finished but still owns the turn ends it.
    if (s.state === 'done' && g.phase === 'turn') {
      s.idleT = (s.idleT || 0) + dt;
      if (s.idleT > 1.5) { s.idleT = -1e9; this.send({ a: 'skip' }); }
    }
    // Out of time: fire whatever we have.
    if (g.phase === 'turn' && g.timeLeft < 3 && (s.state === 'plan' || s.state === 'walk' || s.state === 'think')) {
      this.send({ a: 'move', dir: 0 });
      if (s.best) { s.plan = s.best; this.fireNow(); }
    }
  }

  send(action) {
    this.game.handleInput(this.s.team.playerId, action);
  }

  // ---------- Planning ----------

  startPlanning() {
    this.s.state = 'plan';
    this.s.gen = this.planGen();
  }

  stepPlanning() {
    const s = this.s;
    const t0 = performance.now();
    while (performance.now() - t0 < BUDGET_MS) {
      const r = s.gen.next();
      if (r.done) { this.onPlanned(r.value); return; }
    }
  }

  onPlanned(cands) {
    const s = this.s;
    const g = this.game;
    cands.sort((a, b) => b.score - a.score);
    const pool = cands.slice(0, Math.max(1, s.lv.pickFrom));
    const pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    s.best = pick;
    const w = g.active;
    const nearest = this.nearestEnemy(w);
    const goal = this.walkGoal(w, nearest);
    const canWalk = s.walks < 4 && g.timeLeft > 10;
    if ((!pick || pick.score < WALK_IF_BELOW) && canWalk && goal) {
      s.walks++;
      s.state = 'walk';
      s.walkDir = Math.sign(goal.x - w.x) || 1;
      s.t = rand(1.6, 2.6);
      s.lastX = w.x;
      s.stuckT = 0;
      s.jumps = 0;
      s.gapJumped = false;
      return;
    }
    const stuck = Math.hypot(w.x - s.startX, w.y - s.startY) < 60;
    if ((!pick || pick.score <= 0) && stuck && s.lv.teleport && s.team.ammo[W_TELEPORT] !== 0) {
      const spot = this.teleportSpot(w, nearest);
      if (spot) {
        this.send({ a: 'weapon', w: W_TELEPORT });
        this.send({ a: 'fire', tx: spot.x, ty: spot.y });
        s.state = 'done';
        return;
      }
    }
    if (!pick) {
      // Nothing useful to do: don't make the other players wait for the timer.
      this.send({ a: 'move', dir: 0 });
      s.state = 'skip';
      s.t = 1.2;
      return;
    }
    s.plan = pick;
    this.beginAim();
  }

  *planGen() {
    const g = this.game;
    const s = this.s;
    const lv = s.lv;
    const w = g.active;
    const team = s.team;
    const cands = [];
    const add = c => { if (c && c.score > -50) cands.push(c); };

    // Melee and straight shots are cheap to evaluate.
    add(this.bestFist());
    if (team.ammo[W_SHOTGUN] !== 0) add(this.bestHitscan(W_SHOTGUN));
    if (team.ammo[W_MINIGUN] !== 0) add(this.bestHitscan(W_MINIGUN));
    yield;

    // Ballistic weapons: coarse grid search over angle and power with the real projectile code.
    const wind = lv.useWind ? g.wind : 0;
    for (const wi of [W_BAZOOKA, W_GRENADE]) {
      if (team.ammo[wi] === 0) continue;
      for (const facing of [1, -1]) {
        for (let elev = -0.45; elev <= 1.45; elev += lv.eStep) {
          for (let pw = 0.22; pw <= 1.0001; pw += lv.pStep) {
            add(this.evalShot(w, wi, elev, facing, pw, wind));
            yield;
          }
        }
      }
    }

    // Refine around the best few ballistic shots.
    if (lv.refine) {
      const top = cands.filter(c => c.weapon === W_BAZOOKA || c.weapon === W_GRENADE)
        .sort((a, b) => b.score - a.score).slice(0, 3);
      for (const c of top) {
        for (let de = -0.05; de <= 0.0501; de += 0.025) {
          for (let dp = -0.04; dp <= 0.0401; dp += 0.02) {
            const pw = Math.max(0.05, Math.min(1, c.power + dp));
            add(this.evalShot(w, c.weapon, c.elev + de, c.facing, pw, wind));
            yield;
          }
        }
      }
    }
    return cands;
  }

  // Simulate a ballistic shot and score where it explodes.
  evalShot(w, weapon, elev, facing, power, wind) {
    const sim = this.sim;
    sim.projectiles.length = 0;
    sim.result = null;
    sim.wind = wind;
    fireWeapon(sim, { id: w.id, x: w.x, y: w.y, facing }, weapon, elev, power);
    for (let i = 0; i < 60 * 6 && !sim.result && sim.projectiles.length; i++) updateProjectiles(sim, 1 / 60);
    if (!sim.result) return null;
    const b = BLAST[weapon];
    const score = this.scoreBlast(sim.result.x, sim.result.y, b.r, b.dmg) - AMMO_COST[weapon];
    return { kind: 'ballistic', weapon, elev, facing, power, score };
  }

  scoreBlast(x, y, r, dmg) {
    const g = this.game;
    const s = this.s;
    let score = 0;
    let closest = Infinity;
    for (const o of g.worms) {
      if (!o.alive) continue;
      const dist = Math.hypot(o.x - x, o.y - y);
      const d = Math.max(0, dist - R * 0.5);
      const mine = o.team === s.team.idx;
      if (d < r) {
        const f = 1 - d / r;
        const dm = Math.max(1, Math.round(dmg * f));
        let v = Math.min(dm, o.hp) + (dm >= o.hp ? 30 : 0);
        if (f > 0.3 && o.y > g.waterY - 140) v += 12; // likely knocked into the water
        score += mine ? -v * s.lv.selfWeight : v;
      } else if (!mine) {
        closest = Math.min(closest, d - r);
      }
    }
    // Small reward for near misses, so the bot still picks the "least bad" shot.
    if (score === 0 && closest < 250) score = 6 * (1 - closest / 250);
    return score;
  }

  // Straight-line weapons: aim directly at each enemy with a clear line of sight.
  bestHitscan(weapon) {
    const g = this.game;
    const s = this.s;
    const w = g.active;
    const range = WEAPONS[weapon].range;
    let best = null;
    for (const e of g.worms) {
      if (!e.alive || e.team === s.team.idx) continue;
      const dx = e.x - w.x;
      const dy = e.y - (w.y - 2);
      const dist = Math.hypot(dx, dy);
      if (dist > range - 10 || dist < 1) continue;
      const hit = this.traceRay(w, dx / dist, dy / dist, range);
      if (!hit || hit.worm !== e) continue;
      let dmg;
      if (weapon === W_SHOTGUN) {
        const f = 1 - hit.d / range;
        dmg = (4 + 31 * f * f) * (g.turn.weaponLocked ? 1 : 1.7);
      } else {
        const p = Math.min(1, (R + 1) / (0.07 * hit.d + 1));
        dmg = 50 * p * 0.85;
      }
      let score = Math.min(dmg, e.hp) + (dmg >= e.hp ? 25 : 0);
      score *= s.lv.hitscan;
      const facing = dx >= 0 ? 1 : -1;
      const elev = Math.atan2(-dy, Math.abs(dx));
      if (!best || score > best.score) best = { kind: 'hitscan', weapon, elev, facing, power: 1, score, target: e.id };
    }
    return best;
  }

  // March a ray from the worm; returns the first worm (and distance) it would hit.
  traceRay(w, ux, uy, range) {
    const g = this.game;
    const x0 = w.x + ux * (R + 2);
    const y0 = w.y - 2 + uy * (R + 2);
    for (let d = 0; d < range; d += 2) {
      const x = x0 + ux * d;
      const y = y0 + uy * d;
      for (const o of g.worms) {
        if (o === w || !o.alive) continue;
        if ((o.x - x) ** 2 + (o.y - y) ** 2 < (R + 1) ** 2) return { worm: o, d };
      }
      if (g.terrain.solid(Math.round(x), Math.round(y))) return null;
    }
    return null;
  }

  bestFist() {
    const g = this.game;
    const w = g.active;
    const s = this.s;
    let best = null;
    for (const facing of [1, -1]) {
      let score = 0;
      for (const o of g.worms) {
        if (o === w || !o.alive) continue;
        const dx = (o.x - w.x) * facing;
        if (dx > -4 && dx < 26 && Math.abs(o.y - w.y) < 20) {
          let v = Math.min(25, o.hp) + (o.hp <= 25 ? 30 : 0);
          if (!this.groundBelow(o.x + facing * 150, o.y - 40, 400)) v += 40; // punched off a cliff
          score += o.team === s.team.idx ? -v * s.lv.selfWeight : v;
        }
      }
      if (score > 0 && (!best || score > best.score)) best = { kind: 'fist', weapon: W_FIST, elev: 0.3, facing, power: 1, score };
    }
    return best;
  }

  // Where to walk: a supply crate when out of explosives, otherwise the nearest enemy.
  walkGoal(w, enemy) {
    const team = this.s.team;
    const noBoom = team.ammo[W_BAZOOKA] === 0 && team.ammo[W_GRENADE] === 0;
    let crate = null;
    let cd = Infinity;
    for (const c of this.game.crates) {
      if (!c.landed) continue;
      const d = Math.hypot(c.x - w.x, c.y - w.y);
      if (d < cd) { cd = d; crate = c; }
    }
    const ed = enemy ? Math.hypot(enemy.x - w.x, enemy.y - w.y) : Infinity;
    if (crate && (noBoom ? cd < 900 : cd < Math.min(250, ed))) return crate;
    return enemy;
  }

  nearestEnemy(w) {
    let best = null;
    let bd = Infinity;
    for (const o of this.game.worms) {
      if (!o.alive || o.team === this.s.team.idx) continue;
      const d = Math.hypot(o.x - w.x, o.y - w.y);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  // Is there ground below (x, y) within maxDrop pixels, above the water?
  groundBelow(x, y, maxDrop) {
    const t = this.game.terrain;
    if (x < R || x > WORLD.W - R) return false;
    for (let yy = Math.max(0, y); yy < Math.min(this.game.waterY - R, y + maxDrop); yy += 2) {
      if (t.solid(Math.round(x), Math.round(yy + R))) return true;
    }
    return false;
  }

  // A standable spot 120–320 px from the nearest enemy (used to escape pits).
  teleportSpot(w, enemy) {
    const t = this.game.terrain;
    const cx = enemy ? enemy.x : WORLD.W / 2;
    for (let tries = 0; tries < 60; tries++) {
      const x = Math.round(cx + (Math.random() < 0.5 ? -1 : 1) * rand(120, 320));
      if (x < 30 || x > WORLD.W - 30) continue;
      for (let y = 40; y < this.game.waterY - 40; y += 2) {
        if (!collides(t, x, y, R) && collides(t, x, y + 1, R) && !collides(t, x, y - 8, R)) return { x, y };
      }
    }
    return null;
  }

  // ---------- Walking ----------

  safeAhead(w, dir) {
    return this.groundBelow(w.x + dir * 14, w.y - 20, 110);
  }

  stepWalk(dt) {
    const s = this.s;
    const w = this.game.active;
    if (!w.onGround) return; // mid-jump: let it land
    // A gap or cliff ahead: jump across when there is ground on the other side.
    if (s.t > 0 && !this.safeAhead(w, s.walkDir) && !s.gapJumped &&
        this.groundBelow(w.x + s.walkDir * 95, w.y - 30, 70)) {
      s.gapJumped = true;
      this.send({ a: 'jump' });
      s.t = Math.max(s.t, 1.0);
      return;
    }
    if (s.t <= 0 || !this.safeAhead(w, s.walkDir)) {
      this.send({ a: 'move', dir: 0 });
      s.state = 'think';
      s.t = 0.4;
      return;
    }
    this.send({ a: 'move', dir: s.walkDir });
    if (w.onGround) {
      if (Math.abs(w.x - s.lastX) < 0.3) s.stuckT += dt; else s.stuckT = 0;
      s.lastX = w.x;
      if (s.stuckT > 0.35) {
        // Blocked by a wall: jump; if that isn't enough, backflip (about twice as high); then give up.
        s.stuckT = 0;
        s.jumps++;
        if (s.jumps === 1) this.send({ a: 'jump' });
        else if (s.jumps <= 3) this.startBackflip(s.walkDir);
        else s.t = 0;
      }
    }
  }

  // A backflip goes backwards, so face away from where we want to go, then double-jump.
  startBackflip(dir) {
    const s = this.s;
    this.send({ a: 'move', dir: 0 });
    this.send({ a: 'aim', facing: -dir });
    s.state = 'flip';
    s.flipStage = 0;
    s.flipT = 0;
    s.flipDir = dir;
  }

  stepFlip(dt) {
    const s = this.s;
    const w = this.game.active;
    s.flipT += dt;
    if (s.flipStage === 0 && s.flipT > 0.1) {
      this.send({ a: 'jump' });
      s.flipStage = 1;
      s.flipT = 0;
    } else if (s.flipStage === 1 && s.flipT > 0.15) {
      this.send({ a: 'jump' }); // second press right after the first = backflip
      s.flipStage = 2;
      s.flipT = 0;
    } else if (s.flipStage === 2 && s.flipT > 0.3 && w.onGround) {
      // Landed: keep walking the same way.
      s.state = 'walk';
      s.walkDir = s.flipDir;
      s.t = Math.max(s.t, 1.2);
      s.lastX = w.x;
      s.stuckT = 0;
    } else if (s.flipT > 3) {
      s.state = 'think';
      s.t = 0.2;
    }
  }

  // ---------- Aiming and firing ----------

  beginAim() {
    const s = this.s;
    const p = s.plan;
    if (this.game.activeTeam.weapon !== p.weapon) this.send({ a: 'weapon', w: p.weapon });
    s.aimFrom = this.game.activeTeam.elev;
    s.aimT = 0;
    s.state = 'aim';
    this.send({ a: 'aim', elev: s.aimFrom, facing: p.facing });
  }

  stepAim(dt) {
    const s = this.s;
    const p = s.plan;
    s.aimT += dt / 0.7;
    const k = Math.min(1, s.aimT);
    const e = s.aimFrom + (p.elev - s.aimFrom) * (k * k * (3 - 2 * k));
    this.send({ a: 'aim', elev: e });
    if (k >= 1) {
      if (WEAPONS[p.weapon].usesPower) { s.state = 'charge'; s.pw = 0; }
      else this.fireNow();
    }
  }

  stepCharge(dt) {
    const s = this.s;
    s.pw = Math.min(s.plan.power, s.pw + dt / 1.5);
    this.send({ a: 'aim', elev: s.plan.elev, pw: s.pw });
    if (s.pw >= s.plan.power) this.fireNow();
  }

  fireNow() {
    const g = this.game;
    const s = this.s;
    const p = s.plan;
    const lv = s.lv;
    const elev = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p.elev + gauss() * lv.elevErr));
    const pw = Math.max(0.05, Math.min(1, p.power + gauss() * lv.powErr));
    if (g.activeTeam.weapon !== p.weapon) this.send({ a: 'weapon', w: p.weapon });
    this.send({ a: 'fire', elev, facing: p.facing, pw });
    s.shots++;
    if (g.phase === 'turn' && p.weapon === W_SHOTGUN) {
      s.state = 'between';
      s.t = 0.8;
    } else if (lv.retreat && p.kind !== 'fist') {
      s.state = 'retreat';
      s.retreatDir = -p.facing;
      s.t = rand(0.8, 1.6);
    } else {
      s.state = 'done';
    }
  }

  stepRetreat() {
    const s = this.s;
    const g = this.game;
    const w = g.active;
    if (g.phase !== 'retreat') {
      if (g.phase !== 'firing') { this.send({ a: 'move', dir: 0 }); s.state = 'done'; }
      return;
    }
    if (s.t <= 0 || !this.safeAhead(w, s.retreatDir)) {
      this.send({ a: 'move', dir: 0 });
      s.state = 'done';
      return;
    }
    this.send({ a: 'move', dir: s.retreatDir });
  }
}
