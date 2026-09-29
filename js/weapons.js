// Weapon definitions, firing logic and projectile simulation (host side),
// plus a pure trajectory preview used by the aiming UI.
import { PHYS, WORLD } from './config.js';
import { collides, sweep, surfaceNormal, reflect, segPointDist } from './physics.js';

export const W_FIST = 0;
export const W_MINIGUN = 1;
export const W_SHOTGUN = 2;
export const W_GRENADE = 3;
export const W_BAZOOKA = 4;
export const W_TELEPORT = 5;

export const WEAPONS = [
  { id: 'fist', name: 'Fist', usesPower: false, kind: 'melee' },
  { id: 'minigun', name: 'Minigun', usesPower: false, kind: 'hitscan', range: 900 },
  { id: 'shotgun', name: 'Shotgun', usesPower: false, kind: 'hitscan', range: 420, shots: 2 },
  { id: 'grenade', name: 'Grenade', usesPower: true, kind: 'projectile', ammo: 3 },
  { id: 'bazooka', name: 'Bazooka', usesPower: true, kind: 'projectile', ammo: 2 },
  { id: 'teleport', name: 'Teleport', usesPower: false, kind: 'target', ammo: 1 },
];

const GRENADE = { r: 4, minSpeed: 120, maxSpeed: 680, fuse: 3, blast: 48, dmg: 50, kb: 400, e: 0.5, f: 0.85 };
const BAZOOKA = { r: 3, minSpeed: 120, maxSpeed: 900, blast: 52, dmg: 50, kb: 420, windAcc: 170 };
const MINIGUN = { bullets: 10, interval: 0.06, spread: 0.07, dmg: 5, crater: 5 };
const SHOTGUN = { maxDmg: 35, minDmg: 4, crater: 9 };
const FIST = { reach: 26, dmg: 25, kbx: 330, kby: -300 };

export const PROJ_GRENADE = 1;
export const PROJ_ROCKET = 2;

export function launchSpeed(weapon, power) {
  const p = Math.max(0.05, Math.min(1, power));
  const def = weapon === W_GRENADE ? GRENADE : BAZOOKA;
  return def.minSpeed + (def.maxSpeed - def.minSpeed) * p;
}

// Aim direction from elevation (radians above horizon) and facing (+1 right, -1 left).
export function aimVector(elev, facing) {
  return { x: Math.cos(elev) * facing, y: -Math.sin(elev) };
}

// Muzzle position just outside the worm's body.
function muzzle(w, dir, extra = 4) {
  const d = PHYS.WORM_R + extra;
  return { x: w.x + dir.x * d, y: w.y - 2 + dir.y * d };
}

// Fire a weapon. Returns 'continue' (turn goes on, e.g. first shotgun shot),
// 'burst' (a multi-frame burst started) or 'end' (start the retreat timer).
export function fireWeapon(game, w, weapon, elev, power) {
  const dir = aimVector(elev, w.facing);
  switch (weapon) {
    case W_FIST: {
      let hitAny = false;
      for (const o of game.worms) {
        if (o === w || !o.alive) continue;
        const dx = (o.x - w.x) * w.facing;
        const dy = o.y - w.y;
        if (dx > -4 && dx < FIST.reach && Math.abs(dy) < 20) {
          game.damageWorm(o, FIST.dmg);
          game.knock(o, w.facing * FIST.kbx, FIST.kby);
          hitAny = true;
        }
      }
      game.emit({ k: 'punch', x: Math.round(w.x + w.facing * 14), y: Math.round(w.y - 4), hit: hitAny ? 1 : 0 });
      return 'end';
    }
    case W_MINIGUN: {
      game.bursts.push({ worm: w, left: MINIGUN.bullets, timer: 0, elev, facing: w.facing });
      return 'burst';
    }
    case W_SHOTGUN: {
      const m = muzzle(w, dir, 2);
      game.emit({ k: 'fire', w: W_SHOTGUN, x: Math.round(m.x), y: Math.round(m.y) });
      hitscan(game, w, m.x, m.y, dir.x, dir.y, WEAPONS[W_SHOTGUN].range, (target, dist, hx, hy) => {
        const f = 1 - dist / WEAPONS[W_SHOTGUN].range;
        if (target) {
          const dmg = Math.round(SHOTGUN.minDmg + (SHOTGUN.maxDmg - SHOTGUN.minDmg) * f * f);
          game.damageWorm(target, dmg);
          const kb = 60 + 260 * f;
          game.knock(target, dir.x * kb, dir.y * kb - 80 * f);
        } else {
          game.explode(hx, hy, SHOTGUN.crater, 0, 0, true);
        }
      });
      game.turn.shotsLeft--;
      return game.turn.shotsLeft > 0 ? 'continue' : 'end';
    }
    case W_GRENADE:
    case W_BAZOOKA: {
      const speed = launchSpeed(weapon, power);
      const m = muzzle(w, dir, 5);
      const p = {
        id: game.nextId++,
        type: weapon === W_GRENADE ? PROJ_GRENADE : PROJ_ROCKET,
        x: m.x, y: m.y,
        vx: dir.x * speed, vy: dir.y * speed,
        fuse: GRENADE.fuse,
        age: 0,
        owner: w.id,
        resting: false,
      };
      game.projectiles.push(p);
      game.emit({ k: 'fire', w: weapon, x: Math.round(m.x), y: Math.round(m.y) });
      return 'end';
    }
  }
  return 'end';
}

// Trace a straight ray; calls onHit(worm|null, distance, x, y) for the first worm or terrain hit.
function hitscan(game, shooter, x0, y0, dx, dy, range, onHit) {
  const t = game.terrain;
  const R = PHYS.WORM_R + 1;
  const step = 2;
  let x = x0;
  let y = y0;
  for (let d = 0; d < range; d += step) {
    x = x0 + dx * d;
    y = y0 + dy * d;
    for (const o of game.worms) {
      if (o === shooter || !o.alive) continue;
      if ((o.x - x) * (o.x - x) + (o.y - y) * (o.y - y) < R * R) {
        game.emit({ k: 'tracer', x1: Math.round(x0), y1: Math.round(y0), x2: Math.round(x), y2: Math.round(y) });
        onHit(o, d, x, y);
        return;
      }
    }
    if (t.solid(Math.round(x), Math.round(y))) {
      game.emit({ k: 'tracer', x1: Math.round(x0), y1: Math.round(y0), x2: Math.round(x), y2: Math.round(y) });
      onHit(null, d, x, y);
      return;
    }
    if (y > WORLD.WATER_Y || x < -50 || x > WORLD.W + 50) break;
  }
  game.emit({ k: 'tracer', x1: Math.round(x0), y1: Math.round(y0), x2: Math.round(x), y2: Math.round(y) });
}

// Advance minigun bursts. Returns true while any burst is still running.
export function updateBursts(game, dt) {
  for (let i = game.bursts.length - 1; i >= 0; i--) {
    const b = game.bursts[i];
    const w = b.worm;
    if (!w.alive) { game.bursts.splice(i, 1); continue; }
    b.timer -= dt;
    while (b.timer <= 0 && b.left > 0) {
      b.timer += MINIGUN.interval;
      b.left--;
      const e = b.elev + (Math.random() - 0.5) * 2 * MINIGUN.spread;
      const dir = aimVector(e, b.facing);
      const m = muzzle(w, dir, 2);
      game.emit({ k: 'fire', w: W_MINIGUN, x: Math.round(m.x), y: Math.round(m.y) });
      hitscan(game, w, m.x, m.y, dir.x, dir.y, WEAPONS[W_MINIGUN].range, (target, dist, hx, hy) => {
        if (target) {
          game.damageWorm(target, MINIGUN.dmg);
          game.knock(target, dir.x * 70, -60);
        } else {
          game.explode(hx, hy, MINIGUN.crater, 0, 0, true);
        }
      });
    }
    if (b.left <= 0) game.bursts.splice(i, 1);
  }
  return game.bursts.length > 0;
}

// Advance all projectiles by dt.
export function updateProjectiles(game, dt) {
  const t = game.terrain;
  for (let i = game.projectiles.length - 1; i >= 0; i--) {
    const p = game.projectiles[i];
    p.age += dt;
    let remove = false;

    if (p.type === PROJ_ROCKET) {
      const ox = p.x;
      const oy = p.y;
      const hit = sweep(t, p, dt, BAZOOKA.r, game.wind * BAZOOKA.windAcc, PHYS.GRAVITY);
      // Check worms along the travelled segment (plus the blocked point).
      const ex = hit ? hit.x : p.x;
      const ey = hit ? hit.y : p.y;
      let wormHit = null;
      if (p.age > 0.05) {
        for (const o of game.worms) {
          if (!o.alive) continue;
          const s = segPointDist(ox, oy, ex, ey, o.x, o.y);
          if (s.d < PHYS.WORM_R + BAZOOKA.r) {
            if (!wormHit || s.t < wormHit.t) wormHit = s;
          }
        }
      }
      if (wormHit) {
        game.explode(wormHit.x, wormHit.y, BAZOOKA.blast, BAZOOKA.dmg, BAZOOKA.kb);
        remove = true;
      } else if (hit) {
        game.explode(hit.x, hit.y, BAZOOKA.blast, BAZOOKA.dmg, BAZOOKA.kb);
        remove = true;
      }
    } else if (p.type === PROJ_GRENADE) {
      p.fuse -= dt;
      if (p.resting) {
        if (!collides(t, p.x, p.y + 1, GRENADE.r)) p.resting = false;
      }
      if (!p.resting) {
        const hit = sweep(t, p, dt, GRENADE.r, 0, PHYS.GRAVITY);
        if (hit) {
          const n = surfaceNormal(t, hit.x, hit.y, GRENADE.r);
          const speed = Math.hypot(p.vx, p.vy);
          if (speed > 60) game.emit({ k: 'bounce', x: Math.round(p.x), y: Math.round(p.y) });
          reflect(p, n, GRENADE.e, GRENADE.f);
          if (Math.hypot(p.vx, p.vy) < 25 && n.y < -0.5) {
            p.vx = 0;
            p.vy = 0;
            p.resting = true;
          }
        }
      }
      if (p.fuse <= 0) {
        game.explode(p.x, p.y, GRENADE.blast, GRENADE.dmg, GRENADE.kb);
        remove = true;
      }
    }

    if (!remove && (p.y > WORLD.WATER_Y || p.x < -300 || p.x > WORLD.W + 300)) {
      if (p.y > WORLD.WATER_Y) game.emit({ k: 'splash', x: Math.round(p.x), s: 0 });
      remove = true;
    }
    if (remove) game.projectiles.splice(i, 1);
  }
}

// Predicted flight path (no wind) for the aiming preview. Returns flat [x0, y0, x1, y1, ...].
export function previewTrajectory(terrain, weapon, x, y, elev, facing, power) {
  const dir = aimVector(elev, facing);
  const pts = [];
  if (weapon === W_GRENADE || weapon === W_BAZOOKA) {
    const speed = launchSpeed(weapon, power);
    const d = PHYS.WORM_R + 5;
    let px = x + dir.x * d;
    let py = y - 2 + dir.y * d;
    let vx = dir.x * speed;
    let vy = dir.y * speed;
    const dt = 1 / 60;
    for (let i = 0; i < 200; i++) {
      pts.push(px, py);
      vy += PHYS.GRAVITY * dt;
      px += vx * dt;
      py += vy * dt;
      if (terrain && terrain.solid(Math.round(px), Math.round(py))) { pts.push(px, py); break; }
      if (py > WORLD.WATER_Y || px < -200 || px > WORLD.W + 200) break;
    }
  } else if (weapon === W_MINIGUN || weapon === W_SHOTGUN) {
    const range = WEAPONS[weapon].range;
    const sx = x + dir.x * (PHYS.WORM_R + 2);
    const sy = y - 2 + dir.y * (PHYS.WORM_R + 2);
    let ex = sx;
    let ey = sy;
    for (let d = 0; d < range; d += 3) {
      ex = sx + dir.x * d;
      ey = sy + dir.y * d;
      if (terrain && terrain.solid(Math.round(ex), Math.round(ey))) break;
    }
    pts.push(sx, sy, ex, ey);
  }
  return pts;
}
