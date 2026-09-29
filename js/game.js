// Host-authoritative game simulation: turns, worms, weapons, damage, victory.
import { WORLD, PHYS, TURN, TEAM_COLORS, WORM_NAMES } from './config.js';
import { collides, walkWorm, updateWorm, sweep } from './physics.js';
import { WEAPONS, W_GRENADE, W_BAZOOKA, W_SHOTGUN, W_TELEPORT, fireWeapon, updateBursts, updateProjectiles } from './weapons.js';

// Supply drops.
export const CRATE_R = 8;
export const CRATE_KINDS = ['hp', 'bazooka', 'grenade', 'teleport'];
const CRATE_WEIGHTS = [0.4, 0.25, 0.25, 0.1];
const CRATE_HP = 35;
const DROP_EVERY = 2;          // a plane flies over every N turns
const MAX_CRATES = 4;
const PLANE_SPEED = 420;
const PLANE_Y = 70;
const CHUTE_SPEED = 85;

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
    bot: p.bot || null,
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
    this.crates = [];
    this.plane = null;
    this.turnCount = 0;
    this.waterY = WORLD.WATER_Y;
    this.waterTarget = WORLD.WATER_Y;
    this.suddenDeath = false;

    this.teams = setup.teams.map((t, i) => ({
      idx: i,
      playerId: t.playerId,
      name: t.name,
      color: t.color,
      bot: t.bot || null,
      connected: true,
      ammo: WEAPONS.map(w => (w.ammo === undefined ? -1 : w.ammo)), // -1 = unlimited
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
    if (!this.hasAmmo(team, team.weapon)) team.weapon = this.fallbackWeapon(team);
    this.turnCount++;
    if (this.turnCount > 1 && this.turnCount % DROP_EVERY === 0) this.launchPlane();
    // Sudden death: after a number of rounds the water rises every turn to force an ending.
    if (this.turnCount > TURN.SUDDEN_DEATH_ROUNDS * this.teams.length) {
      if (!this.suddenDeath) {
        this.suddenDeath = true;
        this.emit({ k: 'msg', text: 'Sudden death! The water is rising' });
      }
      this.waterTarget = Math.max(TURN.WATER_MIN_Y, this.waterTarget - TURN.WATER_RISE);
    }
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
    if (this.crates.some(c => !c.landed)) return false;
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

  // ---------- Ammo ----------

  hasAmmo(team, wi) { return team.ammo[wi] !== 0; }

  useAmmo(team, wi) { if (team.ammo[wi] > 0) team.ammo[wi]--; }

  fallbackWeapon(team) {
    for (const wi of [W_BAZOOKA, W_GRENADE, W_SHOTGUN]) if (this.hasAmmo(team, wi)) return wi;
    return W_SHOTGUN;
  }

  // ---------- Supply drops ----------

  launchPlane() {
    if (this.crates.length >= MAX_CRATES) return;
    // Pick a drop column with ground above the water.
    let dropX = null;
    for (let tries = 0; tries < 40 && dropX === null; tries++) {
      const x = 150 + Math.random() * (WORLD.W - 300);
      for (let y = 0; y < this.waterY - 30; y += 4) {
        if (this.terrain.solid(Math.round(x), y)) { dropX = x; break; }
      }
    }
    if (dropX === null) return;
    const dir = Math.random() < 0.5 ? 1 : -1;
    let r = Math.random();
    let kind = 0;
    while (kind < CRATE_WEIGHTS.length - 1 && r > CRATE_WEIGHTS[kind]) { r -= CRATE_WEIGHTS[kind]; kind++; }
    this.plane = { x: dir > 0 ? -200 : WORLD.W + 200, y: PLANE_Y, dir, dropX, kind, dropped: false };
    this.emit({ k: 'plane' });
  }

  updateDrops(dt) {
    const p = this.plane;
    if (p) {
      p.x += p.dir * PLANE_SPEED * dt;
      if (!p.dropped && (p.dir > 0 ? p.x >= p.dropX : p.x <= p.dropX)) {
        p.dropped = true;
        this.crates.push({ id: this.nextId++, x: p.dropX, y: p.y + 24, vx: 0, vy: 30, kind: p.kind, landed: false, chute: true });
        this.emit({ k: 'drop', x: Math.round(p.dropX), y: p.y + 24 });
      }
      if (p.x < -260 || p.x > WORLD.W + 260) this.plane = null;
    }
    const t = this.terrain;
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      if (c.landed) {
        if (!collides(t, c.x, c.y + 1, CRATE_R)) { c.landed = false; c.chute = false; }
      }
      if (!c.landed) {
        c.vy = Math.min(c.vy + PHYS.GRAVITY * dt, c.chute ? CHUTE_SPEED : 500);
        if (sweep(t, c, dt, CRATE_R, 0, 0)) {
          c.landed = true;
          c.chute = false;
          c.vx = 0;
          c.vy = 0;
        }
      }
      if (c.y > this.waterY + 4 || c.x < -20 || c.x > WORLD.W + 20) {
        this.emit({ k: 'splash', x: Math.round(c.x), s: 0 });
        this.crates.splice(i, 1);
        continue;
      }
      // Pick-up by any living worm that touches the crate.
      for (const w of this.worms) {
        if (!w.alive || w.gone) continue;
        if (Math.hypot(w.x - c.x, w.y - c.y) < PHYS.WORM_R + CRATE_R + 3) {
          this.collectCrate(c, w);
          this.crates.splice(i, 1);
          break;
        }
      }
    }
  }

  collectCrate(c, w) {
    const team = this.teams[w.team];
    const kind = CRATE_KINDS[c.kind];
    let text = '';
    if (kind === 'hp') { w.hp += CRATE_HP; text = `+${CRATE_HP} HP`; }
    else if (kind === 'bazooka') { if (team.ammo[W_BAZOOKA] >= 0) team.ammo[W_BAZOOKA]++; text = '+1 Rocket'; }
    else if (kind === 'grenade') { if (team.ammo[W_GRENADE] >= 0) team.ammo[W_GRENADE] += 2; text = '+2 Grenades'; }
    else if (kind === 'teleport') { if (team.ammo[W_TELEPORT] >= 0) team.ammo[W_TELEPORT]++; text = '+1 Teleport'; }
    this.emit({ k: 'pickup', id: w.id, kind: c.kind, x: Math.round(c.x), y: Math.round(c.y), text });
  }

  // Move a worm to a target point, snapping onto ground below if there is any close by.
  teleport(w, tx, ty) {
    if (typeof tx !== 'number' || typeof ty !== 'number' || !isFinite(tx) || !isFinite(ty)) return false;
    const R = PHYS.WORM_R;
    if (tx < R + 2 || tx > WORLD.W - R - 2 || ty < -150 || ty > this.waterY - R - 4) return false;
    let spot = null;
    for (let dy = 0; dy >= -36 && !spot; dy -= 3) {
      for (const dx of [0, -4, 4, -8, 8, -12, 12]) {
        if (!collides(this.terrain, tx + dx, ty + dy, R)) { spot = { x: Math.round(tx + dx), y: Math.round(ty + dy) }; break; }
      }
    }
    if (!spot) return false;
    let drop = 0;
    while (drop < 90 && !collides(this.terrain, spot.x, spot.y + 1, R)) { spot.y++; drop++; }
    if (spot.y > this.waterY - R) return false;
    this.emit({ k: 'tele', x1: Math.round(w.x), y1: Math.round(w.y), x2: spot.x, y2: spot.y });
    w.x = spot.x;
    w.y = spot.y;
    w.vx = 0;
    w.vy = 0;
    w.knocked = false;
    w.onGround = collides(this.terrain, w.x, w.y + 1, R);
    w.fallStartY = w.y;
    return true;
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
    w.jumpVx = 0;
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
    if (!small) {
      for (let i = this.crates.length - 1; i >= 0; i--) {
        const c = this.crates[i];
        if (Math.hypot(c.x - x, c.y - y) < r + CRATE_R) {
          this.crates.splice(i, 1);
          this.emit({ k: 'puff', x: Math.round(c.x), y: Math.round(c.y) });
        }
      }
    }
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
          w.jumpVx = w.vx;
          w.vy = PHYS.JUMP_VY;
          w.fallStartY = w.y;
          w.jumpT = this.time;
          w.flipped = false;
          this.turn.acted = true;
          this.emit({ k: 'jump', id: w.id });
        } else if (this.canMove() && !w.onGround && !w.knocked && !w.flipped && this.time - (w.jumpT ?? -9) < 0.4) {
          // Second press right after a jump: a high backflip to escape pits.
          w.flipped = true;
          w.vx = -w.facing * 70;
          w.jumpVx = w.vx;
          w.vy = PHYS.JUMP_VY * 1.4;
          this.emit({ k: 'jump', id: w.id, flip: 1 });
        }
        break;
      case 'skip':
        // End the turn early (used by bots with nothing useful to do).
        if (this.phase === 'turn' || this.phase === 'retreat') this.beginSettle();
        break;
      case 'aim':
        this.applyAim(a);
        this.showPower = typeof a.pw === 'number' ? Math.max(0, Math.min(1, a.pw)) : 0;
        break;
      case 'weapon': {
        const wi = a.w | 0;
        if (this.phase !== 'turn' || this.turn.weaponLocked || wi < 0 || wi >= WEAPONS.length) break;
        if (!this.hasAmmo(team, wi)) {
          this.emit({ k: 'msg', text: `No ${WEAPONS[wi].name.toLowerCase()} left!`, team: team.idx });
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
        const weapon = team.weapon;
        if (!this.hasAmmo(team, weapon)) break;
        if (weapon === W_TELEPORT) {
          if (!this.teleport(w, a.tx, a.ty)) {
            this.emit({ k: 'msg', text: "Can't teleport there", team: team.idx });
            break;
          }
          this.useAmmo(team, weapon);
          this.turn.acted = true;
          this.phase = 'retreat';
          this.retreatLeft = TURN.RETREAT;
          break;
        }
        this.applyAim(a);
        this.useAmmo(team, weapon);
        this.turn.acted = true;
        this.showPower = 0;
        const power = typeof a.pw === 'number' ? a.pw : 0.6;
        const res = fireWeapon(this, w, weapon, team.elev, power);
        if (res === 'continue') {
          // Between shotgun shots the worm may still walk, but can't change weapons.
          this.turn.weaponLocked = true;
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

    if (this.waterY > this.waterTarget) this.waterY = Math.max(this.waterTarget, this.waterY - 30 * dt);
    updateProjectiles(this, dt);
    this.updateDrops(dt);
    this.physics(dt);

    const acting = this.phase === 'turn' || this.phase === 'retreat' || this.phase === 'firing';
    // Active worm died or vanished during its own turn.
    if (w && !w.alive && acting) {
      this.bursts.length = 0;
      this.beginSettle();
    }
    // Only one team (or nobody) left: stop the turn so the game can end right away.
    if (acting && this.teams.filter(t => this.teamAlive(t.idx)).length <= 1) {
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
      if (w.y > this.waterY + 4 || w.x < -PHYS.WORM_R || w.x > WORLD.W + PHYS.WORM_R) {
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
      ta: this.teams.map(t => t.ammo),
      wy: Math.round(this.waterY),
      c: this.crates.flatMap(c => [c.id, r1(c.x), r1(c.y), c.kind, c.chute ? 1 : 0]),
      pl: this.plane ? [r1(this.plane.x), this.plane.y, this.plane.dir] : 0,
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
      ammo: this.teams.map(t => t.ammo),
      waterY: this.waterY,
      crates: this.crates,
      plane: this.plane,
      connected: this.teams.map(t => t.connected),
      worms: this.worms,
      projectiles: this.projectiles,
    };
  }
}
