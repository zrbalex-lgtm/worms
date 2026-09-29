// Canvas renderer: camera, terrain bitmap, background, worms, projectiles, particles, aim UI.
import { WORLD, PHYS } from './config.js';
import { noise1 } from './terrain.js';
import { WEAPONS, W_FIST, W_MINIGUN, W_SHOTGUN, W_GRENADE, W_BAZOOKA, W_TELEPORT, aimVector, previewTrajectory } from './weapons.js';

const CRATE_STYLE = [
  { box: '#f4f4f4', mark: '#e02b2b' },  // health
  { box: '#6f7f3a', mark: '#ffd23a' },  // rockets
  { box: '#3f8a2c', mark: '#ffffff' },  // grenades
  { box: '#7b3fe4', mark: '#ffe35a' },  // teleport
];

export const THEMES = [
  { name: 'Meadow', sky: ['#5fb8ff', '#d9f2ff'], hills: ['#9fd3b4', '#76b894'], dirt: [139, 90, 43], dirt2: [118, 74, 34], top: [80, 186, 64], top2: [150, 230, 96], edge: [58, 34, 14], water: ['rgba(40,110,215,0.88)', '#153f8f'] },
  { name: 'Candy', sky: ['#ff8fc8', '#ffe6f3'], hills: ['#eab0de', '#cf8ac4'], dirt: [196, 107, 176], dirt2: [168, 86, 150], top: [255, 244, 252], top2: [255, 196, 232], edge: [88, 28, 78], water: ['rgba(125,80,215,0.88)', '#4a2a96'] },
  { name: 'Desert', sky: ['#ffae5c', '#ffeccb'], hills: ['#e8b77a', '#d19a5a'], dirt: [214, 160, 90], dirt2: [190, 136, 72], top: [246, 218, 146], top2: [255, 240, 185], edge: [108, 66, 26], water: ['rgba(26,150,170,0.88)', '#0f5c6e'] },
  { name: 'Frost', sky: ['#40639a', '#bcd6f2'], hills: ['#b9cbe2', '#9fb4d0'], dirt: [112, 125, 140], dirt2: [92, 103, 118], top: [246, 250, 255], top2: [205, 226, 250], edge: [36, 44, 58], water: ['rgba(30,95,165,0.88)', '#0f3563'] },
];

const PINK = '#ffb0c4';
const PINK_DARK = '#8a2f4f';

// ---------- Terrain bitmap ----------

class TerrainView {
  constructor(terrain, theme) {
    this.t = terrain;
    this.theme = theme;
    this.canvas = document.createElement('canvas');
    this.canvas.width = terrain.w;
    this.canvas.height = terrain.h;
    this.ctx = this.canvas.getContext('2d');
    this.img = this.ctx.createImageData(terrain.w, terrain.h);
    this.px = new Uint32Array(this.img.data.buffer);
    this.dirty = null;
    this.paint();
    this.ctx.putImageData(this.img, 0, 0);
  }

  static pack(r, g, b) {
    return (255 << 24) | (Math.max(0, Math.min(255, b | 0)) << 16) | (Math.max(0, Math.min(255, g | 0)) << 8) | Math.max(0, Math.min(255, r | 0));
  }

  paint() {
    const { w, h, mask } = this.t;
    const th = this.theme;
    const px = this.px;
    const pack = TerrainView.pack;
    // Pre-computed 128x128 mottled texture tile.
    const T = 128;
    const tile = new Float32Array(T * T);
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const n = 0.55 * noise1(x / 9 + noise1(y / 11, 7) * 3, y * 3 + 1) + 0.45 * noise1(y / 7 + x / 13, 99);
        let v = 0.84 + n * 0.26;
        const hsh = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        const r = hsh - Math.floor(hsh);
        if (r < 0.035) v *= 0.72;
        else if (r > 0.985) v *= 1.18;
        tile[y * T + x] = v;
      }
    }
    // Horizontal strata offset per column.
    const strata = new Float32Array(w);
    for (let x = 0; x < w; x++) strata[x] = noise1(x / 160, 4242) * 50;
    const depth = new Uint16Array(w);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (!mask[i]) { depth[x] = 0; px[i] = 0; continue; }
        const d = depth[x] < 60000 ? ++depth[x] : depth[x];
        let r, g, b;
        if (d <= 6) {
          const c = d <= 2 ? th.top2 : th.top;
          const k = tile[(y & (T - 1)) * T + (x & (T - 1))];
          r = c[0] * (0.92 + 0.08 * k); g = c[1] * (0.92 + 0.08 * k); b = c[2] * (0.92 + 0.08 * k);
        } else {
          const band = ((y + strata[x]) / 22) | 0;
          const c = band % 3 === 0 ? th.dirt2 : th.dirt;
          const k = tile[(y & (T - 1)) * T + (x & (T - 1))];
          r = c[0] * k; g = c[1] * k; b = c[2] * k;
          if (d <= 9) { r *= 0.75; g *= 0.75; b *= 0.75; } // shadow under the grass
        }
        // Dark outline where solid meets air on the sides or below.
        const edge = (x > 0 && !mask[i - 1]) || (x < w - 1 && !mask[i + 1]) || (y < h - 1 && !mask[i + w]);
        if (edge && d > 2) {
          r = (r + th.edge[0]) * 0.5; g = (g + th.edge[1]) * 0.5; b = (b + th.edge[2]) * 0.5;
        }
        px[i] = pack(r, g, b);
      }
    }
  }

  crater(cx, cy, r) {
    this.t.carve(cx, cy, r); // idempotent on the host (already carved by the simulation)
    const { w, h, mask } = this.t;
    const px = this.px;
    const rr = r + 3;
    const x0 = Math.max(0, cx - rr), x1 = Math.min(w - 1, cx + rr);
    const y0 = Math.max(0, cy - rr), y1 = Math.min(h - 1, cy + rr);
    const r2 = r * r;
    const rr2 = rr * rr;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        const i = y * w + x;
        if (d2 <= r2) px[i] = 0;
        else if (d2 <= rr2 && mask[i]) {
          const c = px[i];
          const cr = (c & 255) * 0.6, cg = ((c >> 8) & 255) * 0.55, cb = ((c >> 16) & 255) * 0.5;
          px[i] = TerrainView.pack(cr, cg, cb);
        }
      }
    }
    if (x1 < x0 || y1 < y0) return;
    const d = this.dirty;
    if (!d) this.dirty = { x0, y0, x1, y1 };
    else { d.x0 = Math.min(d.x0, x0); d.y0 = Math.min(d.y0, y0); d.x1 = Math.max(d.x1, x1); d.y1 = Math.max(d.y1, y1); }
  }

  // Upload only the changed region to the canvas.
  flush() {
    const d = this.dirty;
    if (!d) return;
    this.ctx.putImageData(this.img, 0, 0, d.x0, d.y0, d.x1 - d.x0 + 1, d.y1 - d.y0 + 1);
    this.dirty = null;
  }
}

// ---------- Renderer ----------

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cssW = 1;
    this.cssH = 1;
    this.dpr = 1;
    this.cam = { x: WORLD.W / 2, y: 600, zoom: 1, follow: true, shake: 0, sx: 0, sy: 0 };
    this.particles = [];
    this.time = 0;
    this.touch = false;
    this.tv = null;
    this.setup = null;
    this.lastProjId = 0;
    this.lastTurnKey = '';
    this.clouds = [];
    this.resize();
  }

  init(setup, terrain) {
    this.setup = setup;
    this.terrain = terrain;
    this.theme = THEMES[setup.theme % THEMES.length];
    this.tv = new TerrainView(terrain, this.theme);
    this.particles.length = 0;
    this.lastProjId = 0;
    this.lastTurnKey = '';
    this.cam.follow = true;
    this.cam.zoom = 1;
    this.clouds = [];
    for (let i = 0; i < 9; i++) {
      this.clouds.push({ x: Math.random() * WORLD.W * 1.4, y: 60 + Math.random() * 380, s: 0.6 + Math.random() * 0.9 });
    }
  }

  resize() {
    const vv = window.visualViewport;
    this.cssW = Math.max(1, Math.round(vv ? vv.width : window.innerWidth));
    this.cssH = Math.max(1, Math.round(vv ? vv.height : window.innerHeight));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = this.cssW + 'px';
    this.canvas.style.height = this.cssH + 'px';
  }

  // About 480 world pixels fit vertically, so worms stay readable on phones in landscape.
  get baseScale() { return Math.max(0.55, Math.min(1.8, this.cssH / 480)); }
  get scale() { return this.baseScale * this.cam.zoom; }

  worldToScreen(x, y) {
    const s = this.scale;
    return { x: (x - this.cam.x) * s + this.cssW / 2, y: (y - this.cam.y) * s + this.cssH / 2 };
  }

  screenToWorld(x, y) {
    const s = this.scale;
    return { x: (x - this.cssW / 2) / s + this.cam.x, y: (y - this.cssH / 2) / s + this.cam.y };
  }

  panBy(dx, dy) {
    const s = this.scale;
    this.cam.x -= dx / s;
    this.cam.y -= dy / s;
    this.cam.follow = false;
    this.clampCamera();
  }

  zoomAt(factor, sx, sy) {
    const before = this.screenToWorld(sx, sy);
    this.cam.zoom = Math.max(0.45, Math.min(2.5, this.cam.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.clampCamera();
  }

  centerOnActive() { this.cam.follow = true; }

  clampCamera() {
    const s = this.scale;
    const hw = this.cssW / 2 / s;
    const hh = this.cssH / 2 / s;
    const minX = hw - 160, maxX = WORLD.W - hw + 160;
    this.cam.x = minX > maxX ? WORLD.W / 2 : Math.max(minX, Math.min(maxX, this.cam.x));
    const minY = -260 + hh, maxY = WORLD.WATER_Y + 110 - hh;
    this.cam.y = minY > maxY ? (WORLD.WATER_Y - 400) : Math.max(minY, Math.min(maxY, this.cam.y));
  }

  // ---------- Events -> effects ----------

  handleEvent(ev) {
    switch (ev.k) {
      case 'crater':
        if (this.tv) this.tv.crater(ev.x, ev.y, ev.r);
        break;
      case 'boom': this.explosionFx(ev.x, ev.y, ev.r); break;
      case 'puff': this.puffFx(ev.x, ev.y); break;
      case 'tracer':
        this.particles.push({ type: 'tracer', x: ev.x1, y: ev.y1, x2: ev.x2, y2: ev.y2, life: 0.12, max: 0.12 });
        break;
      case 'fire':
        this.particles.push({ type: 'flash', x: ev.x, y: ev.y, r: ev.w === W_MINIGUN ? 5 : 9, life: 0.08, max: 0.08, color: '#fff3a0' });
        if (ev.w === W_BAZOOKA || ev.w === W_GRENADE) this.cam.follow = true;
        break;
      case 'punch':
        if (ev.hit) {
          this.particles.push({ type: 'text', x: ev.x, y: ev.y - 10, text: 'POW!', color: '#ffe23a', life: 0.8, max: 0.8, vy: -30, size: 20 });
          for (let i = 0; i < 8; i++) this.spark(ev.x, ev.y, '#fff6a0');
          this.cam.shake = Math.max(this.cam.shake, 4);
        }
        break;
      case 'dmg': {
        const w = this.findWorm(ev.id);
        if (w) {
          const color = this.teamColor(w.team);
          this.particles.push({ type: 'text', x: w.x, y: w.y - 30, text: '-' + ev.v, color, life: 1.4, max: 1.4, vy: -28, size: 16 });
        }
        break;
      }
      case 'splash': this.splashFx(ev.x, ev.s); break;
      case 'die': {
        const w = this.findWorm(ev.id);
        if (w && !ev.d) this.particles.push({ type: 'text', x: w.x, y: w.y - 20, text: 'RIP', color: '#ffffff', life: 1.5, max: 1.5, vy: -20, size: 14 });
        break;
      }
      case 'turn':
      case 'select':
        this.cam.follow = true;
        break;
      case 'pickup':
        this.particles.push({ type: 'text', x: ev.x, y: ev.y - 20, text: ev.text, color: '#ffe35a', life: 1.6, max: 1.6, vy: -26, size: 16 });
        for (let i = 0; i < 10; i++) this.spark(ev.x, ev.y, '#ffe35a');
        break;
      case 'tele':
        for (const [x, y] of [[ev.x1, ev.y1], [ev.x2, ev.y2]]) {
          this.particles.push({ type: 'ring', x, y, r: 4, r2: 30, life: 0.5, max: 0.5, color: '#b98cff' });
          for (let i = 0; i < 12; i++) this.spark(x, y, '#d8bfff');
        }
        this.cam.follow = true;
        break;
    }
  }

  findWorm(id) {
    const v = this.lastView;
    return v ? v.worms.find(w => w.id === id) : null;
  }

  teamColor(ti) {
    const t = this.setup && this.setup.teams[ti];
    return t ? t.color : '#fff';
  }

  terrainRgb() {
    const c = this.theme ? this.theme.dirt : [139, 90, 43];
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  spark(x, y, color) {
    const a = Math.random() * Math.PI * 2;
    const sp = 80 + Math.random() * 220;
    this.particles.push({ type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, life: 0.35, max: 0.35, color, g: 400 });
  }

  explosionFx(x, y, r) {
    const P = this.particles;
    P.push({ type: 'flash', x, y, r: r * 1.15, life: 0.18, max: 0.18, color: '#fff7c2' });
    P.push({ type: 'ring', x, y, r: r * 0.4, r2: r * 1.5, life: 0.35, max: 0.35 });
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * r * 0.6;
      P.push({ type: 'smoke', x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, vx: Math.cos(a) * 20, vy: -20 - Math.random() * 30, r: 6 + Math.random() * r * 0.3, life: 1 + Math.random() * 0.8, max: 1.8, color: i < 5 ? '#ffb347' : '#555' });
    }
    const dirt = this.terrainRgb();
    for (let i = 0; i < 16; i++) {
      const a = -Math.PI * Math.random();
      const sp = 120 + Math.random() * 260;
      P.push({ type: 'debris', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, size: 2 + Math.random() * 3, life: 1.2, max: 1.2, color: dirt, g: 600 });
    }
    for (let i = 0; i < 10; i++) this.spark(x, y, '#ffd24a');
    this.cam.shake = Math.max(this.cam.shake, Math.min(14, r / 4));
    this.trimParticles();
  }

  puffFx(x, y) {
    const dirt = this.terrainRgb();
    for (let i = 0; i < 4; i++) {
      const a = -Math.PI * Math.random();
      this.particles.push({ type: 'debris', x, y, vx: Math.cos(a) * 90, vy: Math.sin(a) * 120, size: 1.5 + Math.random() * 1.5, life: 0.6, max: 0.6, color: dirt, g: 500 });
    }
    this.particles.push({ type: 'smoke', x, y, vx: 0, vy: -15, r: 4, life: 0.5, max: 0.5, color: '#999' });
    this.trimParticles();
  }

  splashFx(x, big) {
    const n = big ? 26 : 12;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.3;
      const sp = (big ? 200 : 130) + Math.random() * 160;
      this.particles.push({ type: 'drop', x: x + (Math.random() - 0.5) * 10, y: WORLD.WATER_Y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, size: 2 + Math.random() * 2, life: 1, max: 1, g: 700 });
    }
  }

  trimParticles() {
    if (this.particles.length > 450) this.particles.splice(0, this.particles.length - 450);
  }

  // ---------- Frame ----------

  // view: game view (host) or interpolated snapshot (client).
  // local: { myTeam, isMyTurn, aim: {elev, facing, power, preview} | null, sling: {x0,y0,x1,y1} | null }
  frame(view, dt, local) {
    this.time += dt;
    this.lastView = view;
    const ctx = this.ctx;
    if (this.tv) this.tv.flush();
    this.updateCamera(view, dt);
    this.updateParticles(view, dt);

    const s = this.scale;
    const dpr = this.dpr;
    const W = this.cssW, H = this.cssH;
    const camX = this.cam.x + this.cam.sx;
    const camY = this.cam.y + this.cam.sy;

    // Sky.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const th = this.theme || THEMES[0];
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, th.sky[0]);
    sky.addColorStop(1, th.sky[1]);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    this.drawBackground(ctx, camX, camY, s, view ? view.wind : 0, dt);

    if (!view || !this.tv) return;

    // World transform.
    const ox = W / 2 - camX * s;
    const oy = H / 2 - camY * s;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);

    // Back water layer.
    this.drawWater(ctx, camX, s, W, 0.55, -6, th.water[1], 0.6);

    // Terrain (only the visible part of the bitmap).
    const vx0 = Math.max(0, Math.floor(camX - W / 2 / s) - 2);
    const vy0 = Math.max(0, Math.floor(camY - H / 2 / s) - 2);
    const vx1 = Math.min(WORLD.W, Math.ceil(camX + W / 2 / s) + 2);
    const vy1 = Math.min(WORLD.H, Math.ceil(camY + H / 2 / s) + 2);
    if (vx1 > vx0 && vy1 > vy0) {
      ctx.drawImage(this.tv.canvas, vx0, vy0, vx1 - vx0, vy1 - vy0, vx0, vy0, vx1 - vx0, vy1 - vy0);
    }

    const active = view.worms.find(w => w.id === view.activeWorm);
    const myTurnPhase = view.phase === 'turn';

    // Own-worm selection hints at the start of my turn.
    if (local.isMyTurn && myTurnPhase && !view.locked) {
      ctx.lineWidth = 1.5;
      for (const w of view.worms) {
        if (w.team !== local.myTeam || !w.alive || w === active) continue;
        ctx.strokeStyle = this.teamColor(w.team);
        ctx.globalAlpha = 0.5 + 0.3 * Math.sin(this.time * 5);
        ctx.beginPath();
        ctx.arc(w.x, w.y - 1, 14, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Worms and gravestones.
    for (const w of view.worms) {
      if (w.gone) continue;
      if (!w.alive) this.drawGrave(ctx, w);
    }
    let aim = null;
    if (active && active.alive && (myTurnPhase || view.phase === 'retreat' || view.phase === 'firing')) {
      const useLocal = local.isMyTurn && local.aim;
      const elev = useLocal ? local.aim.elev : view.elev;
      const facing = useLocal && local.aim.facing ? local.aim.facing : active.facing;
      aim = { elev, facing, power: useLocal ? local.aim.power : view.power, preview: useLocal && local.aim.preview };
    }
    for (const w of view.worms) {
      if (w.gone || !w.alive) continue;
      const isActive = w === active;
      this.drawWorm(ctx, w, isActive && aim ? aim : null, isActive && myTurnPhase ? view.weapon : -1);
    }

    // Projectiles, supply crates and the supply plane.
    for (const p of view.projectiles) this.drawProjectile(ctx, p);
    for (const c of view.crates || []) this.drawCrate(ctx, c);
    if (view.plane) this.drawPlane(ctx, view.plane);

    // Aim helpers.
    if (active && aim && myTurnPhase) this.drawAim(ctx, active, aim, view.weapon, local);

    // Particles (world space).
    this.drawParticles(ctx);

    // Front water.
    this.drawWater(ctx, camX, s, W, 1, 0, th.water[0], 1);

    // Screen-space overlays: labels, arrow, fuse timers, floating text.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawLabels(ctx, view, active, local);
    if (local.sling) this.drawSling(ctx, local.sling);
  }

  updateCamera(view, dt) {
    const cam = this.cam;
    if (view) {
      const turnKey = view.turnTeam + ':' + view.activeWorm;
      if (turnKey !== this.lastTurnKey) { this.lastTurnKey = turnKey; cam.follow = true; }
      let target = null;
      let newest = null;
      for (const p of view.projectiles) if (!newest || p.id > newest.id) newest = p;
      if (newest) {
        if (newest.id > this.lastProjId) { this.lastProjId = newest.id; cam.follow = true; }
        target = newest;
      }
      if (!target && view.phase === 'settle') {
        target = view.worms.find(w => w.alive && !w.gone && !w.onGround) || null;
      }
      if (!target) {
        const a = view.worms.find(w => w.id === view.activeWorm);
        if (a && !a.gone) target = a;
      }
      if (target && cam.follow) {
        const s = this.scale;
        const anchor = this.touch ? 0.4 : 0.5;
        const tx = target.x;
        const ty = target.y + (0.5 - anchor) * this.cssH / s;
        const k = 1 - Math.exp(-dt * (newest ? 7 : 4.5));
        cam.x += (tx - cam.x) * k;
        cam.y += (ty - cam.y) * k;
      }
    }
    this.clampCamera();
    if (cam.shake > 0.1) {
      cam.sx = (Math.random() - 0.5) * cam.shake;
      cam.sy = (Math.random() - 0.5) * cam.shake;
      cam.shake *= Math.exp(-dt * 8);
    } else { cam.sx = 0; cam.sy = 0; cam.shake = 0; }
  }

  updateParticles(view, dt) {
    const P = this.particles;
    // Rocket smoke trails.
    if (view) {
      for (const p of view.projectiles) {
        if (p.type === 2 && Math.random() < 0.85) {
          P.push({ type: 'smoke', x: p.x, y: p.y, vx: (Math.random() - 0.5) * 10, vy: -8, r: 2.5, life: 0.7, max: 0.7, color: '#ddd' });
        }
      }
    }
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.life -= dt;
      if (p.life <= 0) { P.splice(i, 1); continue; }
      if (p.vx !== undefined) { p.x += p.vx * dt; }
      if (p.vy !== undefined) { p.y += p.vy * dt; }
      if (p.g) p.vy += p.g * dt;
      if (p.type === 'smoke') { p.r += dt * 10; p.vx *= 0.98; }
      if (p.type === 'drop' && p.y > WORLD.WATER_Y + 4 && p.vy > 0) p.life = 0;
    }
    this.trimParticles();
  }

  drawBackground(ctx, camX, camY, s, wind, dt) {
    const W = this.cssW, H = this.cssH;
    const th = this.theme || THEMES[0];
    // Clouds drift with the wind.
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (const c of this.clouds) {
      c.x += (wind * 40 + 4) * dt;
      const span = WORLD.W * 1.4;
      if (c.x > span) c.x -= span;
      if (c.x < 0) c.x += span;
      const sx = ((c.x - camX * 0.25) * s * 0.6) % (span * s * 0.6);
      const px = (sx + span * s * 0.6) % (span * s * 0.6) - 100;
      const py = (c.y - camY * 0.15) * s * 0.6 + H * 0.2;
      const r = 22 * c.s * Math.max(0.6, s);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.arc(px + r * 1.1, py - r * 0.4, r * 1.2, 0, Math.PI * 2);
      ctx.arc(px + r * 2.3, py, r * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
    // Two parallax hill layers.
    const layers = [{ p: 0.25, c: th.hills[0], amp: 170, base: 260, seed: 11 }, { p: 0.5, c: th.hills[1], amp: 130, base: 150, seed: 23 }];
    ctx.globalAlpha = 0.8; // let the sky tint distant hills so they never compete with the terrain
    for (const L of layers) {
      ctx.fillStyle = L.c;
      ctx.beginPath();
      const baseY = (WORLD.WATER_Y - camY) * s * L.p + H / 2 + (1 - L.p) * H * 0.25;
      ctx.moveTo(0, H);
      for (let x = 0; x <= W + 16; x += 16) {
        const u = (x - W / 2) / (s * L.p + 1e-6) * L.p + camX * L.p;
        const hgt = L.base + noise1(u / 260, L.seed) * L.amp + noise1(u / 70, L.seed + 1) * L.amp * 0.25;
        ctx.lineTo(x, baseY - hgt * s * Math.max(0.5, L.p * 1.4));
      }
      ctx.lineTo(W + 16, H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawWater(ctx, camX, s, W, alpha, offset, color, amp) {
    const x0 = camX - W / 2 / s - 20;
    const x1 = camX + W / 2 / s + 20;
    const y = WORLD.WATER_Y + offset;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x0, WORLD.H + 2000);
    const t = this.time;
    for (let x = x0; x <= x1; x += 10) {
      ctx.lineTo(x, y + Math.sin(x * 0.03 + t * 2 + offset) * 3 * amp + Math.sin(x * 0.011 - t * 1.3) * 2 * amp);
    }
    ctx.lineTo(x1, WORLD.H + 2000);
    ctx.closePath();
    ctx.fill();
    if (alpha === 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = x0; x <= x1; x += 10) {
        const yy = y + Math.sin(x * 0.03 + t * 2) * 3 + Math.sin(x * 0.011 - t * 1.3) * 2;
        if (x === x0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawWorm(ctx, w, aim, weapon) {
    const t = this.time;
    const f = w.facing;
    const bob = w.walking ? Math.abs(Math.sin(t * 16 + w.id)) * 1.6 : Math.sin(t * 2.5 + w.id) * 0.4;
    const x = w.x;
    const y = w.y;
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = PINK_DARK;
    ctx.fillStyle = PINK;
    // Tail.
    ctx.beginPath();
    ctx.ellipse(x - f * 5, y + 5, 6.2 + (w.walking ? bob * 0.6 : 0), 3.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Body.
    ctx.beginPath();
    ctx.ellipse(x + f * 1, y - 1 - bob * 0.5, 6.2, 8.6 + bob * 0.3, f * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Belly highlight.
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.ellipse(x + f * 3, y + 1 - bob * 0.5, 2, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // Team headband.
    const hy = y - 9.6 - bob * 0.5;
    ctx.strokeStyle = this.teamColor(w.team);
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(x - 4.5 + f * 1, hy + 1);
    ctx.lineTo(x + 5.5 + f * 1, hy + 0.5);
    ctx.stroke();
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x - f * 4, hy + 1);
    ctx.lineTo(x - f * 8, hy + 3 + Math.sin(t * 8 + w.id) * 1.2);
    ctx.stroke();
    // Eyes (looking along the aim direction for the active worm).
    let lx = f, ly = 0;
    if (aim) { const d = aimVector(aim.elev, aim.facing || f); lx = d.x; ly = d.y; }
    const ey = y - 5.5 - bob * 0.5;
    for (const ex of [x + f * 0.2, x + f * 4.2]) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = PINK_DARK;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(ex, ey, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.arc(ex + lx * 1.1, ey + ly * 1.1, 1.15, 0, Math.PI * 2);
      ctx.fill();
    }
    // Smile.
    ctx.strokeStyle = PINK_DARK;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(x + f * 3, y - 1.5 - bob * 0.5, 2, 0.2, Math.PI - 0.2);
    ctx.stroke();

    if (aim && weapon >= 0) this.drawHeldWeapon(ctx, w, aim, weapon, bob);
  }

  drawHeldWeapon(ctx, w, aim, weapon, bob) {
    const f = aim.facing || w.facing;
    const d = aimVector(aim.elev, f);
    const ang = Math.atan2(d.y, d.x);
    ctx.save();
    ctx.translate(w.x + f * 2, w.y - 1 - bob * 0.5);
    ctx.rotate(ang);
    if (f < 0) ctx.scale(1, -1);
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = '#222';
    switch (weapon) {
      case W_BAZOOKA:
        ctx.fillStyle = '#5d7030';
        ctx.fillRect(-4, -2.6, 20, 5.2);
        ctx.strokeRect(-4, -2.6, 20, 5.2);
        ctx.fillStyle = '#3b471c';
        ctx.fillRect(14, -3.2, 3, 6.4);
        break;
      case W_GRENADE:
        ctx.fillStyle = '#3d7a2a';
        ctx.beginPath(); ctx.arc(7, 0, 3.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#bbb';
        ctx.fillRect(6, -5, 2, 2);
        break;
      case W_MINIGUN:
        ctx.fillStyle = '#555';
        ctx.fillRect(0, -2.5, 9, 5);
        ctx.strokeRect(0, -2.5, 9, 5);
        ctx.fillStyle = '#2d2d2d';
        ctx.fillRect(9, -2, 9, 1.4);
        ctx.fillRect(9, 0.6, 9, 1.4);
        break;
      case W_SHOTGUN:
        ctx.fillStyle = '#7a4a22';
        ctx.fillRect(-3, -1.8, 7, 3.6);
        ctx.fillStyle = '#3a3a3a';
        ctx.fillRect(4, -1.4, 13, 2.8);
        ctx.strokeRect(4, -1.4, 13, 2.8);
        break;
      case W_FIST:
        ctx.fillStyle = '#e02b2b';
        ctx.beginPath(); ctx.arc(8, 0, 4.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        break;
      case W_TELEPORT:
        ctx.fillStyle = `rgba(160,100,255,${0.6 + 0.3 * Math.sin(this.time * 8)})`;
        ctx.beginPath(); ctx.arc(8, 0, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        break;
    }
    ctx.restore();
  }

  drawGrave(ctx, w) {
    const x = w.x, y = w.y + 8;
    ctx.fillStyle = '#9aa0a6';
    ctx.strokeStyle = '#3c4046';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x - 6, y);
    ctx.lineTo(x - 6, y - 12);
    ctx.arc(x, y - 12, 6, Math.PI, 0);
    ctx.lineTo(x + 6, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = this.teamColor(w.team);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y - 15); ctx.lineTo(x, y - 5);
    ctx.moveTo(x - 3, y - 12); ctx.lineTo(x + 3, y - 12);
    ctx.stroke();
  }

  drawProjectile(ctx, p) {
    if (p.type === 1) {
      ctx.fillStyle = '#3d7a2a';
      ctx.strokeStyle = '#1b3a12';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath(); ctx.arc(p.x - 1.3, p.y - 1.3, 1.3, 0, Math.PI * 2); ctx.fill();
    } else {
      const a = p.vx !== undefined ? Math.atan2(p.vy, p.vx) : p.a;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(a);
      ctx.fillStyle = Math.random() < 0.5 ? '#ffb000' : '#ff5a00';
      ctx.beginPath(); ctx.moveTo(-6, -2); ctx.lineTo(-11 - Math.random() * 4, 0); ctx.lineTo(-6, 2); ctx.fill();
      ctx.fillStyle = '#c8c8c8';
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-6, -2.2); ctx.lineTo(4, -2.2); ctx.lineTo(7, 0); ctx.lineTo(4, 2.2); ctx.lineTo(-6, 2.2); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#d33';
      ctx.fillRect(-6, -4, 3, 8);
      ctx.restore();
    }
  }

  drawCrate(ctx, c) {
    const st = CRATE_STYLE[c.kind] || CRATE_STYLE[0];
    const x = c.x, y = c.y;
    if (c.chute) {
      // Parachute canopy and lines.
      const sway = Math.sin(this.time * 2 + c.id) * 3;
      ctx.strokeStyle = 'rgba(40,40,40,0.8)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(x - 7, y - 7); ctx.lineTo(x - 16 + sway, y - 30);
      ctx.moveTo(x + 7, y - 7); ctx.lineTo(x + 16 + sway, y - 30);
      ctx.moveTo(x, y - 7); ctx.lineTo(x + sway, y - 34);
      ctx.stroke();
      ctx.fillStyle = '#ff5a3c';
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x - 18 + sway, y - 30);
      ctx.quadraticCurveTo(x + sway, y - 58, x + 18 + sway, y - 30);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(x - 6 + sway, y - 30);
      ctx.quadraticCurveTo(x + sway, y - 52, x + 6 + sway, y - 30);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = st.box;
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1.4;
    ctx.fillRect(x - 8, y - 7, 16, 15);
    ctx.strokeRect(x - 8, y - 7, 16, 15);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.moveTo(x - 8, y - 2); ctx.lineTo(x + 8, y - 2); ctx.stroke();
    ctx.fillStyle = st.mark;
    if (c.kind === 0) {
      ctx.fillRect(x - 1.8, y - 5, 3.6, 11);
      ctx.fillRect(x - 5.5, y - 1.3, 11, 3.6);
    } else if (c.kind === 1) {
      ctx.beginPath(); ctx.moveTo(x - 5, y - 1); ctx.lineTo(x + 3, y - 1); ctx.lineTo(x + 6, y + 0.5); ctx.lineTo(x + 3, y + 2); ctx.lineTo(x - 5, y + 2); ctx.closePath(); ctx.fill();
    } else if (c.kind === 2) {
      ctx.beginPath(); ctx.arc(x, y + 1, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(x - 1.5, y - 5, 3, 3);
    } else {
      ctx.font = '900 11px system-ui, sans-serif';
      ctx.fillText('?', x - 3, y + 5);
    }
  }

  drawPlane(ctx, p) {
    ctx.save();
    ctx.translate(p.x, p.y + Math.sin(this.time * 3) * 2);
    ctx.scale(p.dir, 1);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1.5;
    // Tail and fuselage.
    ctx.fillStyle = '#e8412f';
    ctx.beginPath();
    ctx.moveTo(-34, -4); ctx.lineTo(-40, -16); ctx.lineTo(-30, -16); ctx.lineTo(-22, -5);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 0, 32, 8, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    // Cockpit.
    ctx.fillStyle = '#9fe3ff';
    ctx.beginPath(); ctx.ellipse(8, -6, 7, 4, 0, Math.PI, 0); ctx.fill(); ctx.stroke();
    // Wings.
    ctx.fillStyle = '#ffd23a';
    ctx.fillRect(-10, -3, 22, 5);
    ctx.strokeRect(-10, -3, 22, 5);
    ctx.fillRect(-8, 6, 18, 4);
    ctx.strokeRect(-8, 6, 18, 4);
    // Propeller blur.
    ctx.fillStyle = 'rgba(60,60,60,0.5)';
    ctx.beginPath(); ctx.ellipse(34, 0, 2.5, 12 * Math.abs(Math.sin(this.time * 40)) + 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  drawAim(ctx, w, aim, weapon, local) {
    if (weapon === W_TELEPORT) return;
    const d = aimVector(aim.elev, aim.facing);
    const cx = w.x, cy = w.y - 2;
    // Trajectory preview (my turn, no wind).
    if (aim.preview && local.isMyTurn && weapon !== W_FIST) {
      const pts = previewTrajectory(this.terrain, weapon, w.x, w.y, aim.elev, aim.facing, aim.power);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      if (weapon === W_MINIGUN || weapon === W_SHOTGUN) {
        const [x0, y0, x1, y1] = pts;
        const len = Math.hypot(x1 - x0, y1 - y0);
        for (let k = 0; k < len; k += 9) {
          ctx.beginPath(); ctx.arc(x0 + (x1 - x0) * k / len, y0 + (y1 - y0) * k / len, 1.4, 0, Math.PI * 2); ctx.fill();
        }
      } else {
        for (let i = 0; i < pts.length; i += 6) {
          ctx.beginPath(); ctx.arc(pts[i], pts[i + 1], 1.8, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    // Power wedge.
    if (aim.power > 0.01 && WEAPONS[weapon].usesPower) {
      const n = Math.ceil(aim.power * 14);
      for (let i = 0; i < n; i++) {
        const k = i / 14;
        const r0 = 12 + k * 52;
        const sz = 1.5 + k * 4;
        ctx.fillStyle = `hsl(${55 - k * 55}, 100%, 50%)`;
        ctx.beginPath();
        ctx.arc(cx + d.x * r0, cy + d.y * r0, sz, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Crosshair.
    if (weapon !== W_FIST) {
      const r = 42;
      const hx = cx + d.x * r, hy = cy + d.y * r;
      ctx.strokeStyle = '#ff2b2b';
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(hx, hy, 4.5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(hx - 7, hy); ctx.lineTo(hx - 2.5, hy);
      ctx.moveTo(hx + 2.5, hy); ctx.lineTo(hx + 7, hy);
      ctx.moveTo(hx, hy - 7); ctx.lineTo(hx, hy - 2.5);
      ctx.moveTo(hx, hy + 2.5); ctx.lineTo(hx, hy + 7);
      ctx.stroke();
    }
  }

  drawParticles(ctx) {
    for (const p of this.particles) {
      const k = p.life / p.max;
      switch (p.type) {
        case 'smoke':
          ctx.globalAlpha = 0.5 * k;
          ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
          break;
        case 'flash':
          ctx.globalAlpha = k;
          ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1.2 - k * 0.2), 0, Math.PI * 2); ctx.fill();
          break;
        case 'ring':
          ctx.globalAlpha = k;
          ctx.strokeStyle = p.color || '#ffae3a';
          ctx.lineWidth = 3 * k + 1;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r + (p.r2 - p.r) * (1 - k), 0, Math.PI * 2); ctx.stroke();
          break;
        case 'debris':
          ctx.globalAlpha = Math.min(1, k * 2);
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
          break;
        case 'spark':
          ctx.globalAlpha = k;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke();
          break;
        case 'tracer':
          ctx.globalAlpha = k;
          ctx.strokeStyle = '#fff59a';
          ctx.lineWidth = 1.3;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x2, p.y2); ctx.stroke();
          break;
        case 'drop':
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = '#bfe3ff';
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
          break;
      }
    }
    ctx.globalAlpha = 1;
  }

  label(ctx, text, x, y, color, size) {
    ctx.font = `800 ${size}px "Trebuchet MS", "Arial Rounded MT Bold", system-ui, sans-serif`;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const h = size + 4;
    const rx = x - w / 2 - 4, ry = y - h + 3;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(rx, ry, w + 8, h, 4); ctx.fill(); }
    else ctx.fillRect(rx, ry, w + 8, h);
    ctx.fillStyle = color;
    ctx.fillText(text, x - w / 2, y);
  }

  drawLabels(ctx, view, active, local) {
    const s = this.scale;
    ctx.textBaseline = 'alphabetic';
    for (const w of view.worms) {
      if (!w.alive || w.gone) continue;
      const p = this.worldToScreen(w.x + this.cam.sx, w.y + this.cam.sy);
      if (p.x < -60 || p.x > this.cssW + 60 || p.y < -60 || p.y > this.cssH + 60) continue;
      const color = this.teamColor(w.team);
      const top = p.y - 13 * s - 6;
      this.label(ctx, String(w.hp), p.x, top, color, 12);
      this.label(ctx, w.name, p.x, top - 17, color, 10);
      if (w === active && view.phase === 'turn' && !view.locked) {
        const by = top - 34 + Math.sin(this.time * 6) * 4;
        ctx.fillStyle = color;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p.x - 8, by - 10); ctx.lineTo(p.x + 8, by - 10); ctx.lineTo(p.x, by);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    // Grenade fuse countdown.
    for (const pr of view.projectiles) {
      if (pr.type !== 1) continue;
      const fuse = pr.fuse !== undefined ? pr.fuse : pr.a;
      const p = this.worldToScreen(pr.x, pr.y);
      this.label(ctx, String(Math.max(1, Math.ceil(fuse))), p.x, p.y - 10, '#fff', 12);
    }
    // Floating text particles.
    for (const pt of this.particles) {
      if (pt.type !== 'text') continue;
      const k = pt.life / pt.max;
      const p = this.worldToScreen(pt.x, pt.y);
      ctx.globalAlpha = Math.min(1, k * 2);
      ctx.font = `900 ${pt.size}px "Trebuchet MS", system-ui, sans-serif`;
      const w = ctx.measureText(pt.text).width;
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#000';
      ctx.strokeText(pt.text, p.x - w / 2, p.y);
      ctx.fillStyle = pt.color;
      ctx.fillText(pt.text, p.x - w / 2, p.y);
    }
    ctx.globalAlpha = 1;
  }

  drawSling(ctx, sl) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(sl.x0, sl.y0);
    ctx.lineTo(sl.x1, sl.y1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.arc(sl.x1, sl.y1, 16, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  // Screen position of a worm (CSS px), used by input for slingshot and tap selection.
  wormScreen(w) { return this.worldToScreen(w.x, w.y); }
}
