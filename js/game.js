// Host-authoritative game simulation: turns, worms, weapons, damage, victory.
import { WORLD, PHYS, TURN, TEAM_COLORS, WORM_NAMES } from './config.js';
import { collides, walkWorm, updateWorm } from './physics.js';
import { WEAPONS, W_GRENADE, W_BAZOOKA, W_SHOTGUN, fireWeapon, updateBursts, updateProjectiles } from './weapons.js';

// Worm flags packed into snapshots.
export const F_ALIVE = 1;
export const F_RIGHT = 2;
export const F_GROUND = 4;
export const F_WALK = 8;
export const F_GONE = 16;
export const F_KNOCK = 32;

const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;

// Build the static game setup (teams + worm names) from lobby players. Runs on the host.
export function buildSetup(players, settings) {
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const names = WORM_NAMES.slice();
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  const teams = players.map((p, i) => ({
    playerId: p.id,
    name: p.name,
    color: TEAM_COLORS[p.color ?? i],
  }));
  const worms = [];
  let id = 1;
  teams.forEach((t, ti) => {
    for (let k = 0; k < settings.wormsPerTeam; k++) {
      worms.push({ id: id++, team: ti, name: names[(ti * settings.wormsPerTeam + k) % names.length] });
    }
  });
  return { seed, theme: seed % 4, settings: { ...settings }, teams, worms };
}

export class Game {
  constructor(setup, terrain) {
    this.setup = setup;
    this.terrain = terrain;
    this.settings = setup.settings;
    this.time = 0;
    this.events = [];
    this.nextId = 1000;
    this.projectiles = [];
    this.bursts = [];
    this.wind = 0;
    this.phase = 'turn';
    this.winner = -1;
    this.turnTeam = -1;
    this.active = null;
    this.timeLeft = 0;
    this.retreatLeft = 0;
    this.settleTime = 0;
    this.input = { move: 0 };
    this.showPower = 0;
    this.turn = { acted: false, shotsLeft: 2, weaponLocked: false, noMove: false };

    this.teams = setup.teams.map((t, i) => ({
      idx: i,
      playerId: t.playerId,
      name: t.name,
      color: t.color,
      connected: true,
      grenades: WEAPONS[W_GRENADE].ammo,
      weapon: W_BAZOOKA,
      elev: 0.6,
      lastWorm: -1,
    }));

    this.worms = setup.worms.map(w => ({
      id: w.id,
      team: w.team,
      name: w.name,
      x: 0, y: 0, vx: 0, vy: 0,
      hp: this.settings.hp,
      alive: true,
      gone: false,
      facing: 1,
      onGround: true,
      knocked: false,
      walking: false,
      fallStartY: 0,
      walkAcc: 0,
    }));

    this.spawnWorms();
    this.startTurn(Math.floor(Math.random() * this.teams.length));
  }

  emit(ev) {
    ev.t = r2(this.time);
    this.events.push(ev);
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ---------- Setup ----------

  spawnWorms() {
    const t = this.terrain;
    const R = PHYS.WORM_R;
    // Collect every standable spot (on the ground, islands and cave floors).
    const spots = [];
    for (let x = 20; x < WORLD.W - 20; x += 5) {
      for (let y = 30; y < WORLD.WATER_Y - 40; y++) {
        if (!collides(t, x, y, R) && collides(t, x, y + 1, R) && !collides(t, x, y - 6, R)) {
          spots.push({ x, y });
          y += 12;
        }
      }
    }
    // Interleave teams (round-robin) so no team gets all the good spots first.
    const byTeam = this.teams.map(t => this.worms.filter(w => w.team === t.idx));
    const order = [];
    for (let k = 0; k < this.settings.wormsPerTeam; k++) {
      for (const list of byTeam) if (list[k]) order.push(list[k]);
    }
    const placed = [];
    for (const w of order) {
      let best = null;
      for (let minDist = 110; minDist >= 0 && !best; minDist -= 20) {
        for (let tries = 0; tries < 200; tries++) {
          const s = spots[Math.floor(Math.random() * spots.length)];
          if (!s) break;
          if (placed.every(p => Math.hypot(p.x - s.x, p.y - s.y) > Math.max(minDist, 2 * R + 4))) { best = s; break; }
        }
      }
      if (!best) best = spots[Math.floor(Math.random() * spots.length)] || { x: WORLD.W / 2, y: 100 };
      placed.push(best);
      w.x = best.x;
      w.y = best.y;
      w.facing = best.x < WORLD.W / 2 ? 1 : -1;
      w.fallStartY = w.y;
    }
  }

  // ---------- Queries ----------

  get activeTeam() { return this.teams[this.turnTeam]; }

  wormById(id) { return this.worms.find(w => w.id === id) || null; }

  teamAlive(ti) { return this.worms.some(w => w.team === ti && w.alive); }

  canMove() {
    const w = this.active;
    return !!w && w.alive && (this.phase === 'turn' || this.phase === 'retreat') && !this.turn.noMove && this.bursts.length === 0;
  }

  // ---------- Turn flow ----------

  startTurn(ti) {
    const team = this.teams[ti];
    this.turnTeam = ti;
    this.phase = 'turn';
    this.timeLeft = this.settings.turnTime;
    this.retreatLeft = 0;
    this.wind = Math.round((Math.random() * 2 - 1) * 20) / 20;
    this.turn = { acted: false, shotsLeft: WEAPONS[W_SHOTGUN].shots, weaponLocked: false, noMove: false };
    this.input.move = 0;
    this.showPower = 0;
    if (team.weapon === W_GRENADE && team.grenades <= 0) team.weapon = W_BAZOOKA;
    // Pick the next living worm of this team.
    const own = this.worms.filter(w => w.team === ti);
    let idx = own.findIndex(w => w.id === team.lastWorm);
    let pick = null;
    for (let k = 1; k <= own.length; k++) {
      const w = own[(idx + k + own.length) % own.length];
      if (w.alive) { pick = w; break; }
    }
    this.active = pick;
    if (pick) team.lastWorm = pick.id;
    this.emit({ k: 'turn', team: ti, worm: pick ? pick.id : 0 });
  }

  // Timer ran out, worm died, or retreat finished: wait for everything to settle.
  beginSettle() {
    if (this.phase === 'settle' || this.phase === 'over') return;
    this.phase = 'settle';
    this.settleTime = 0;
    this.input.move = 0;
    this.showPower = 0;
    if (this.active) this.active.walking = false;
  }

  everythingSettled() {
    if (this.projectiles.length || this.bursts.length) return false;
    return this.worms.every(w => !w.alive || w.gone || w.onGround);
  }

  nextTurn() {
    const alive = this.teams.filter(t => this.teamAlive(t.idx));
    if (alive.length <= 1) {
      this.finish(alive.length === 1 ? alive[0].idx : -1);
      return;
    }
    const n = this.teams.length;
    for (let k = 1; k <= n; k++) {
      const ti = (this.turnTeam + k) % n;
      const t = this.teams[ti];
      if (t.connected && this.teamAlive(ti)) { this.startTurn(ti); return; }
    }
    // Nobody left who can play: the team with the most HP wins.
    let best = alive[0];
    for (const t of alive) if (this.teamHp(t.idx) > this.teamHp(best.idx)) best = t;
    this.finish(best.idx);
  }

  finish(winner) {
    this.phase = 'over';
    this.winner = winner;
    this.emit({ k: 'over', win: winner });
  }

  teamHp(ti) {
    let s = 0;
    for (const w of this.worms) if (w.team === ti && w.alive) s += w.hp;
    return s;
  }

  setConnected(playerId, connected) {
    for (const t of this.teams) {
      if (t.playerId !== playerId) continue;
      t.connected = connected;
      if (!connected && t.idx === this.turnTeam && this.phase !== 'settle' && this.phase !== 'over') {
        this.beginSettle();
      }
    }
  }

  // ---------- Damage ----------

  damageWorm(w, amount) {
    if (!w.alive || amount <= 0) return;
    w.hp = Math.max(0, w.hp - amount);
    this.emit({ k: 'dmg', id: w.id, v: amount });
    if (w.hp <= 0) this.killWorm(w, false);
  }

  killWorm(w, drowned) {
    if (!w.alive && !drowned) return;
    const wasAlive = w.alive;
    w.alive = false;
    w.hp = 0;
    w.walking = false;
    if (drowned) {
      w.gone = true;
      this.emit({ k: 'splash', x: Math.round(w.x), s: 1 });
    }
    if (wasAlive) this.emit({ k: 'die', id: w.id, d: drowned ? 1 : 0 });
  }

  knock(w, vx, vy) {
    if (w.gone) return;
    w.onGround = false;
    w.knocked = true;
    w.walking = false;
    w.vx += vx;
    w.vy += vy;
    w.fallStartY = w.y;
  }

  // Explosion with crater, falloff damage and knockback. small = bullet impact (no big boom).
  explode(x, y, r, dmg, kb, small = false) {
    const cx = Math.round(x);
    const cy = Math.round(y);
    const cr = Math.round(r);
    this.terrain.carve(cx, cy, cr);
    this.emit({ k: 'crater', x: cx, y: cy, r: cr });
    this.emit({ k: small ? 'puff' : 'boom', x: cx, y: cy, r: cr });
    if (!dmg && !kb) return;
    for (const w of this.worms) {
      if (w.gone) continue;
      const dx = w.x - x;
      const dy = w.y - y;
      const dist = Math.hypot(dx, dy);
      const d = Math.max(0, dist - PHYS.WORM_R * 0.5);
      if (d >= r) continue;
      const f = 1 - d / r;
      if (w.alive) this.damageWorm(w, Math.max(1, Math.round(dmg * f)));
      const nx = dist > 0.01 ? dx / dist : 0;
      const ny = dist > 0.01 ? dy / dist : -1;
      this.knock(w, nx * kb * f, ny * kb * f - 130 * f);
    }
  }

  // ---------- Input ----------

  handleInput(playerId, a) {
    if (this.phase === 'over' || !a) return;
    const team = this.activeTeam;
    if (!team || team.playerId !== playerId || !team.connected) return;
    const w = this.active;
    switch (a.a) {
      case 'move':
        this.input.move = Math.max(-1, Math.min(1, a.dir | 0));
        break;
      case 'jump':
        if (this.canMove() && w.onGround) {
          w.onGround = false;
          w.knocked = false;
          w.walking = false;
          w.vx = w.facing * PHYS.JUMP_VX;
          w.vy = PHYS.JUMP_VY;
          w.fallStartY = w.y;
          this.turn.acted = true;
          this.emit({ k: 'jump', id: w.id });
        }
        break;
      case 'aim':
        this.applyAim(a);
        this.showPower = typeof a.pw === 'number' ? Math.max(0, Math.min(1, a.pw)) : 0;
        break;
      case 'weapon': {
        const wi = a.w | 0;
        if (this.phase !== 'turn' || this.turn.weaponLocked || wi < 0 || wi >= WEAPONS.length) break;
        if (wi === W_GRENADE && team.grenades <= 0) {
          this.emit({ k: 'msg', text: 'No grenades left!', team: team.idx });
          break;
        }
        team.weapon = wi;
        break;
      }
      case 'switch': {
        if (this.phase !== 'turn' || this.turn.acted) break;
        const own = this.worms.filter(o => o.team === team.idx && o.alive);
        if (!own.length) break;
        let next = null;
        if (a.id) next = own.find(o => o.id === a.id) || null;
        else {
          const i = own.indexOf(w);
          next = own[(i + 1) % own.length];
        }
        if (next && next !== w) {
          if (w) w.walking = false;
          this.active = next;
          team.lastWorm = next.id;
          this.emit({ k: 'select', id: next.id });
        }
        break;
      }
      case 'fire': {
        if (this.phase !== 'turn' || !w || !w.alive || !w.onGround) break;
        this.applyAim(a);
        const weapon = team.weapon;
        if (weapon === W_GRENADE) {
          if (team.grenades <= 0) break;
          team.grenades--;
        }
        this.turn.acted = true;
        this.input.move = 0;
        w.walking = false;
        this.showPower = 0;
        const power = typeof a.pw === 'number' ? a.pw : 0.6;
        const res = fireWeapon(this, w, weapon, team.elev, power);
        if (res === 'continue') {
          this.turn.weaponLocked = true;
          this.turn.noMove = true;
        } else if (res === 'burst') {
          this.phase = 'firing';
        } else {
          this.phase = 'retreat';
          this.retreatLeft = TURN.RETREAT;
          this.turn.noMove = false;
        }
        break;
      }
    }
  }

  applyAim(a) {
    const team = this.activeTeam;
    const w = this.active;
    if (typeof a.elev === 'number' && isFinite(a.elev)) {
      team.elev = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, a.elev));
    }
    if ((a.facing === 1 || a.facing === -1) && w && w.alive && this.phase === 'turn') {
      w.facing = a.facing;
    }
  }

  // ---------- Simulation step ----------

  step(dt) {
    if (this.phase === 'over') {
      this.time += dt;
      this.physics(dt);
      return;
    }
    this.time += dt;
    const w = this.active;

    if (this.phase === 'turn') {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) { this.timeLeft = 0; this.beginSettle(); }
    } else if (this.phase === 'retreat') {
      this.retreatLeft -= dt;
      if (this.retreatLeft <= 0) { this.retreatLeft = 0; this.beginSettle(); }
    }

    // Active worm walking.
    if (w) {
      w.walking = false;
      if (this.canMove() && this.input.move !== 0 && w.onGround) {
        if (walkWorm(this.terrain, w, this.input.move, dt)) {
          w.walking = true;
          this.turn.acted = true;
        }
      }
    }

    // Minigun bursts.
    if (this.phase === 'firing') {
      if (!updateBursts(this, dt)) {
        this.phase = 'retreat';
        this.retreatLeft = TURN.RETREAT;
      }
    } else if (this.bursts.length) {
      updateBursts(this, dt);
    }

    updateProjectiles(this, dt);
    this.physics(dt);

    // Active worm died or vanished during its own turn.
    if (w && !w.alive && (this.phase === 'turn' || this.phase === 'retreat' || this.phase === 'firing')) {
      this.bursts.length = 0;
      this.beginSettle();
    }

    if (this.phase === 'settle') {
      this.settleTime += dt;
      if ((this.settleTime > TURN.SETTLE_MIN && this.everythingSettled()) || this.settleTime > TURN.SETTLE_MAX) {
        this.nextTurn();
      }
    }
  }

  physics(dt) {
    for (const w of this.worms) {
      if (w.gone) continue;
      const fallDmg = updateWorm(this.terrain, w, dt);
      if (fallDmg > 0 && w.alive) this.damageWorm(w, fallDmg);
      if (w.y > WORLD.WATER_Y + 4 || w.x < -PHYS.WORM_R || w.x > WORLD.W + PHYS.WORM_R) {
        if (w.alive) this.killWorm(w, true);
        else if (!w.gone) { w.gone = true; this.emit({ k: 'splash', x: Math.round(w.x), s: 0 }); }
      }
    }
  }

  // ---------- Views / snapshots ----------

  // Compact network snapshot.
  snapshot() {
    const w = [];
    for (const o of this.worms) {
      let f = 0;
      if (o.alive) f |= F_ALIVE;
      if (o.facing > 0) f |= F_RIGHT;
      if (o.onGround) f |= F_GROUND;
      if (o.walking) f |= F_WALK;
      if (o.gone) f |= F_GONE;
      if (o.knocked) f |= F_KNOCK;
      w.push(o.id, r1(o.x), r1(o.y), o.hp, f);
    }
    const p = [];
    for (const pr of this.projectiles) {
      p.push(pr.id, pr.type, r1(pr.x), r1(pr.y), pr.type === 1 ? r1(Math.max(0, pr.fuse)) : r2(Math.atan2(pr.vy, pr.vx)));
    }
    const team = this.activeTeam;
    return {
      t: 's',
      tm: Math.round(this.time * 1000) / 1000,
      ph: this.phase,
      tt: this.turnTeam,
      aw: this.active ? this.active.id : 0,
      tl: r1(this.phase === 'retreat' ? this.retreatLeft : this.timeLeft),
      wd: this.wind,
      wp: team ? team.weapon : 0,
      el: team ? r2(team.elev) : 0,
      pw: r2(this.showPower),
      sl: this.turn.shotsLeft,
      lk: this.turn.acted ? 1 : 0,
      win: this.winner,
      tg: this.teams.map(t => t.grenades),
      tc: this.teams.map(t => (t.connected ? 1 : 0)),
      w,
      p,
    };
  }

  // Direct view for the host's own renderer (same shape as a decoded snapshot).
  view() {
    const team = this.activeTeam;
    return {
      t: this.time,
      phase: this.phase,
      turnTeam: this.turnTeam,
      activeWorm: this.active ? this.active.id : 0,
      timeLeft: this.phase === 'retreat' ? this.retreatLeft : this.timeLeft,
      wind: this.wind,
      weapon: team ? team.weapon : 0,
      elev: team ? team.elev : 0,
      power: this.showPower,
      shotsLeft: this.turn.shotsLeft,
      locked: this.turn.acted,
      winner: this.winner,
      grenades: this.teams.map(t => t.grenades),
      connected: this.teams.map(t => t.connected),
      worms: this.worms,
      projectiles: this.projectiles,
    };
  }
}
