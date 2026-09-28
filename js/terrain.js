// Destructible terrain stored as a 1-byte-per-pixel mask (1 = solid, 0 = air).
import { WORLD } from './config.js';

// Small seeded PRNG (mulberry32).
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer hash -> [0, 1). Used for lattice noise.
function hash1(i, seed) {
  let h = Math.imul(i ^ seed, 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// Smooth 1D value noise in [0, 1).
export function noise1(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i, seed);
  const b = hash1(i + 1, seed);
  return a + (b - a) * u;
}

export class Terrain {
  constructor(w = WORLD.W, h = WORLD.H) {
    this.w = w;
    this.h = h;
    this.mask = new Uint8Array(w * h);
  }

  solid(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.mask[y * this.w + x] === 1;
  }

  // Remove a filled circle of terrain. Returns the affected bounding box.
  carve(cx, cy, r) {
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    const r2 = r * r;
    const m = this.mask;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const row = y * this.w;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) m[row + x] = 0;
      }
    }
    return { x0, y0, x1, y1 };
  }

  // Run-length encode the mask as a compact base36 string (alternating air/solid runs, starting with air).
  encode() {
    const m = this.mask;
    const runs = [];
    let cur = 0;
    let len = 0;
    for (let i = 0; i < m.length; i++) {
      if (m[i] === cur) len++;
      else { runs.push(len.toString(36)); cur = m[i]; len = 1; }
    }
    runs.push(len.toString(36));
    return runs.join(',');
  }

  decode(str) {
    const m = this.mask;
    let i = 0;
    let cur = 0;
    for (const part of str.split(',')) {
      const len = parseInt(part, 36);
      if (cur) m.fill(1, i, i + len);
      else m.fill(0, i, i + len);
      i += len;
      cur ^= 1;
    }
  }
}

// Procedurally generate a map: rolling hills, water pits, pillars, floating islands and caves/overhangs.
export function generateTerrain(seed, w = WORLD.W, h = WORLD.H) {
  const t = new Terrain(w, h);
  const rng = makeRng(seed);
  const water = WORLD.WATER_Y;
  const s1 = (seed * 7 + 11) | 0;
  const s2 = (seed * 13 + 5) | 0;
  const s3 = (seed * 31 + 3) | 0;

  // Base surface height per column.
  const surf = new Float32Array(w);
  const base = h * (0.5 + rng() * 0.1);
  for (let x = 0; x < w; x++) {
    let y = base;
    y += (noise1(x / 520, s1) - 0.5) * 2 * 190;
    y += (noise1(x / 190, s2) - 0.5) * 2 * 80;
    y += (noise1(x / 55, s3) - 0.5) * 2 * 14;
    surf[x] = Math.max(220, Math.min(water - 40, y));
  }

  // Water pits (gaps you must jump or avoid).
  const pits = [];
  const pitCount = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < pitCount; i++) {
    const cx = w * (0.2 + 0.6 * ((i + rng() * 0.8 + 0.1) / pitCount));
    const pw = 55 + rng() * 60;
    pits.push({ cx, pw });
    for (let x = Math.floor(cx - pw / 2); x < cx + pw / 2; x++) {
      if (x >= 0 && x < w) surf[x] = h + 10;
    }
  }

  // Tall pillars / walls.
  const wallCount = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < wallCount; i++) {
    const cx = Math.floor(w * (0.1 + rng() * 0.8));
    if (pits.some(p => Math.abs(p.cx - cx) < p.pw + 60)) continue;
    const ww = 22 + rng() * 22;
    const hgt = 70 + rng() * 80;
    const top = surf[cx] - hgt;
    for (let x = Math.floor(cx - ww / 2); x < cx + ww / 2; x++) {
      if (x < 0 || x >= w) continue;
      // Slightly rounded top.
      const k = (x - cx) / (ww / 2);
      const y = top + k * k * 10;
      surf[x] = Math.min(surf[x], y);
    }
  }

  // Fill the main landmass.
  const m = t.mask;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (y >= surf[x]) m[row + x] = 1;
    }
  }

  // Floating islands in the sky.
  const islandCount = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < islandCount; i++) {
    const cx = w * ((i + 0.2 + rng() * 0.6) / islandCount);
    const rx = 55 + rng() * 85;
    const ry = 16 + rng() * 14;
    const ground = surf[Math.max(0, Math.min(w - 1, Math.floor(cx)))];
    const maxY = Math.min(ground, water) - 150;
    if (maxY < 170) continue;
    const cy = 150 + rng() * (maxY - 150);
    const ns = (seed + i * 97) | 0;
    for (let y = Math.floor(cy - ry); y < cy + ry * 2.2; y++) {
      if (y < 0 || y >= h) continue;
      for (let x = Math.floor(cx - rx); x < cx + rx; x++) {
        if (x < 0 || x >= w) continue;
        const nx = (x - cx) / rx;
        const dy = y - cy;
        // Flat-ish top, deeper jagged bottom.
        const ny = dy < 0 ? dy / ry : dy / (ry * 2.2);
        const wobble = (noise1(x / 14, ns) - 0.5) * 0.35;
        if (nx * nx + ny * ny < 1 + wobble) m[y * w + x] = 1;
      }
    }
  }

  // Caves just below the surface create overhangs and tunnels.
  const caveCount = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < caveCount; i++) {
    const cx = w * (0.05 + rng() * 0.9);
    const sx = Math.floor(cx);
    if (surf[sx] > water - 60) continue;
    const rx = 35 + rng() * 55;
    const ry = 18 + rng() * 20;
    const cy = surf[sx] + ry * 0.6 + rng() * 70;
    const ns = (seed + i * 131) | 0;
    for (let y = Math.floor(cy - ry); y < cy + ry; y++) {
      if (y < 0 || y >= water - 20) continue;
      for (let x = Math.floor(cx - rx); x < cx + rx; x++) {
        if (x < 0 || x >= w) continue;
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        const wobble = (noise1((x + y) / 18, ns) - 0.5) * 0.3;
        if (nx * nx + ny * ny < 1 + wobble) m[y * w + x] = 0;
      }
    }
  }

  // Remove thin one-pixel slivers so worms don't snag on noise.
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      if (m[i] && !m[i - w] && !m[i + w]) m[i] = 0;
    }
  }

  t.theme = seed % 4;
  return t;
}
