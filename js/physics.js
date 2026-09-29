// Bitmap-based collision and movement for worms and projectiles.
import { PHYS } from './config.js';

// Cache of integer perimeter offsets per radius.
const ringCache = new Map();
function ring(r) {
  let pts = ringCache.get(r);
  if (pts) return pts;
  const seen = new Set();
  pts = [];
  const n = Math.max(12, Math.ceil(2 * Math.PI * r * 1.5));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ox = Math.round(Math.cos(a) * r);
    const oy = Math.round(Math.sin(a) * r);
    const key = ox * 1000 + oy;
    if (!seen.has(key)) { seen.add(key); pts.push(ox, oy); }
  }
  pts.push(0, 0); // center point too
  ringCache.set(r, pts);
  return pts;
}

// True if a circle of radius r at (x, y) overlaps solid terrain.
export function collides(terrain, x, y, r) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  const pts = ring(r);
  for (let i = 0; i < pts.length; i += 2) {
    if (terrain.solid(ix + pts[i], iy + pts[i + 1])) return true;
  }
  return false;
}

// Approximate surface normal pointing away from nearby solid pixels.
export function surfaceNormal(terrain, x, y, r) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  const rr = r + 3;
  let sx = 0;
  let sy = 0;
  for (let dy = -rr; dy <= rr; dy++) {
    for (let dx = -rr; dx <= rr; dx++) {
      if (dx * dx + dy * dy > rr * rr) continue;
      if (terrain.solid(ix + dx, iy + dy)) { sx += dx; sy += dy; }
    }
  }
  const len = Math.hypot(sx, sy);
  if (len < 1e-6) return { x: 0, y: -1 };
  return { x: -sx / len, y: -sy / len };
}

// Advance a body until it would touch terrain. The body stays at the last free
// position; returns the blocked position or null when no collision happened.
export function sweep(terrain, b, dt, r, ax, ay) {
  b.vx += ax * dt;
  b.vy += ay * dt;
  const dist = Math.max(Math.abs(b.vx), Math.abs(b.vy)) * dt;
  const n = Math.min(80, Math.max(1, Math.ceil(dist / 1.5)));
  const sx = (b.vx * dt) / n;
  const sy = (b.vy * dt) / n;
  for (let i = 0; i < n; i++) {
    const nx = b.x + sx;
    const ny = b.y + sy;
    if (collides(terrain, nx, ny, r)) return { x: nx, y: ny };
    b.x = nx;
    b.y = ny;
  }
  return null;
}

// Reflect velocity about a normal with restitution e and tangential friction f.
export function reflect(b, n, e, f) {
  const vn = b.vx * n.x + b.vy * n.y;
  if (vn >= 0) return;
  const tx = b.vx - vn * n.x;
  const ty = b.vy - vn * n.y;
  b.vx = tx * f - vn * e * n.x;
  b.vy = ty * f - vn * e * n.y;
}

// Distance from point (px, py) to segment (ax, ay)-(bx, by); also returns the closest point.
export function segPointDist(ax, ay, bx, by, px, py) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return { d: Math.hypot(px - cx, py - cy), x: cx, y: cy, t };
}

// Snap a worm to integer coords and settle it onto the ground below.
function settleOnGround(terrain, w) {
  const R = PHYS.WORM_R;
  w.x = Math.round(w.x);
  w.y = Math.round(w.y);
  let up = 0;
  while (collides(terrain, w.x, w.y, R) && up < 6) { w.y--; up++; }
  let down = 0;
  while (!collides(terrain, w.x, w.y + 1, R) && down < 3) { w.y++; down++; }
}

// Walk one frame in direction dir (-1 or 1). Returns true if the worm moved.
export function walkWorm(terrain, w, dir, dt) {
  const R = PHYS.WORM_R;
  w.facing = dir;
  w.walkAcc = (w.walkAcc || 0) + PHYS.WALK_SPEED * dt;
  let moved = false;
  while (w.walkAcc >= 1) {
    w.walkAcc -= 1;
    const nx = w.x + dir;
    let ny = null;
    for (let dy = 0; dy >= -PHYS.MAX_CLIMB; dy--) {
      if (!collides(terrain, nx, w.y + dy, R)) { ny = w.y + dy; break; }
    }
    if (ny === null) { w.walkAcc = 0; break; } // blocked by a wall
    w.x = nx;
    w.y = ny;
    moved = true;
    let dropped = 0;
    while (dropped < PHYS.MAX_STEP_DOWN && !collides(terrain, w.x, w.y + 1, R)) { w.y++; dropped++; }
    if (!collides(terrain, w.x, w.y + 1, R)) {
      // Walked off a ledge.
      w.onGround = false;
      w.jumpVx = 0;
      w.fallStartY = w.y;
      w.vx = dir * PHYS.WALK_SPEED * 0.7;
      w.vy = 0;
      w.walkAcc = 0;
      break;
    }
  }
  return moved;
}

// Per-step physics for a worm (alive or a gravestone). Returns fall damage to apply (0 if none).
export function updateWorm(terrain, w, dt) {
  if (w.gone) return 0;
  const R = PHYS.WORM_R;
  if (w.onGround) {
    if (collides(terrain, w.x, w.y + 1, R)) return 0;
    // Wedged in a narrow gap: stay put while still touching terrain.
    if (w.wedged && collides(terrain, w.x, w.y, R + 1)) return 0;
    // Ground vanished beneath us.
    w.wedged = false;
    w.onGround = false;
    w.fallStartY = w.y;
    w.vx = 0;
    w.vy = 0;
  }
  w.fallStartY = Math.min(w.fallStartY, w.y);
  // A jump that slid up a wall resumes its sideways motion once it clears the edge.
  if (!w.knocked && w.jumpVx && Math.abs(w.vx) < Math.abs(w.jumpVx) * 0.5 &&
      !collides(terrain, w.x + Math.sign(w.jumpVx) * 2, w.y, R)) {
    w.vx = w.jumpVx;
  }
  const ox = w.x;
  const oy = w.y;
  const hit = sweep(terrain, w, dt, R, 0, PHYS.GRAVITY);
  if (!hit) { w.stallT = 0; return 0; }
  // Detect a body jittering in place against terrain (e.g. wedged between walls) and let it rest.
  if (Math.abs(w.x - ox) + Math.abs(w.y - oy) < 0.6) w.stallT = (w.stallT || 0) + dt;
  else w.stallT = 0;
  if (w.stallT > 0.35) {
    w.stallT = 0;
    w.onGround = true;
    w.wedged = !collides(terrain, w.x, w.y + 1, R);
    w.vx = 0;
    w.vy = 0;
    w.knocked = false;
    return 0;
  }
  const n = surfaceNormal(terrain, hit.x, hit.y, R);
  const speed = Math.hypot(w.vx, w.vy);
  if (n.y < -0.5 && (!w.knocked || speed < PHYS.LAND_SPEED)) {
    // Land.
    const fall = w.y - w.fallStartY;
    w.onGround = true;
    w.vx = 0;
    w.vy = 0;
    w.knocked = false;
    w.jumpVx = 0;
    settleOnGround(terrain, w);
    if (fall > PHYS.FALL_SAFE) {
      return Math.min(PHYS.FALL_DMG_MAX, Math.round((fall - PHYS.FALL_SAFE) * PHYS.FALL_DMG_PER_PX));
    }
    return 0;
  }
  const vn = w.vx * n.x + w.vy * n.y;
  if (vn < 0) {
    // Knocked worms bounce; jumping worms slide along walls without losing their upward speed.
    reflect(w, n, w.knocked ? PHYS.BOUNCE : 0, w.knocked ? 0.8 : 1);
  } else {
    // Stuck inside a surface while moving away: nudge out.
    w.x += n.x;
    w.y += n.y;
  }
  // Nearly stopped against a slope-ish surface: just land to avoid jitter.
  if (Math.hypot(w.vx, w.vy) < 12 && n.y < -0.2) {
    w.onGround = true;
    w.vx = 0;
    w.vy = 0;
    w.knocked = false;
    settleOnGround(terrain, w);
  }
  return 0;
}
