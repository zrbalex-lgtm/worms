// DOM user interface: screens, lobby, HUD, weapon picker, toasts and overlays.
import { WEAPONS, W_TELEPORT } from './weapons.js';
import { TEAM_COLORS } from './config.js';

const $ = id => document.getElementById(id);

// Simple inline SVG icons for the weapons (no external assets).
export const WEAPON_ICONS = [
  // Fist (boxing glove)
  `<svg viewBox="0 0 48 48"><rect x="6" y="22" width="12" height="12" rx="2" fill="#f1f1f1" stroke="#222" stroke-width="2"/><path d="M16 14h16a10 10 0 0 1 10 10v4a10 10 0 0 1-10 10H16z" fill="#e53030" stroke="#222" stroke-width="2"/><path d="M22 20c4 0 8 1 8 5" stroke="#ff9b9b" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
  // Minigun
  `<svg viewBox="0 0 48 48"><rect x="4" y="18" width="16" height="14" rx="3" fill="#666" stroke="#222" stroke-width="2"/><rect x="20" y="17" width="24" height="4" fill="#333" stroke="#222"/><rect x="20" y="23" width="24" height="4" fill="#333" stroke="#222"/><rect x="20" y="29" width="24" height="4" fill="#333" stroke="#222"/><rect x="8" y="32" width="6" height="8" fill="#444" stroke="#222" stroke-width="2"/></svg>`,
  // Shotgun
  `<svg viewBox="0 0 48 48"><path d="M3 26l12-4h4v8h-6l-8 6z" fill="#8a5325" stroke="#222" stroke-width="2"/><rect x="18" y="20" width="27" height="5" fill="#444" stroke="#222" stroke-width="2"/><rect x="22" y="26" width="10" height="4" rx="1" fill="#6d4a2a" stroke="#222" stroke-width="1.5"/></svg>`,
  // Grenade
  `<svg viewBox="0 0 48 48"><circle cx="22" cy="28" r="14" fill="#3f8a2c" stroke="#222" stroke-width="2"/><path d="M12 24h20M12 32h20M22 14v28" stroke="#2b5e1e" stroke-width="2"/><rect x="18" y="8" width="10" height="7" fill="#aaa" stroke="#222" stroke-width="2"/><circle cx="34" cy="10" r="4" fill="none" stroke="#ccc" stroke-width="2"/></svg>`,
  // Bazooka
  `<svg viewBox="0 0 48 48"><rect x="4" y="19" width="36" height="10" rx="2" fill="#5d7030" stroke="#222" stroke-width="2"/><rect x="38" y="17" width="7" height="14" fill="#3b471c" stroke="#222" stroke-width="2"/><rect x="14" y="29" width="5" height="9" fill="#444" stroke="#222" stroke-width="2"/><rect x="8" y="16" width="8" height="4" fill="#3b471c"/></svg>`,
  // Teleport (swirl portal)
  `<svg viewBox="0 0 48 48"><ellipse cx="24" cy="26" rx="18" ry="16" fill="#7b3fe4" stroke="#222" stroke-width="2"/><path d="M24 26m-11 0a11 10 0 1 1 11 10a7 6 0 1 1 -5-8a3 3 0 1 1 5 2" fill="none" stroke="#e7d4ff" stroke-width="3" stroke-linecap="round"/><path d="M40 6l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#ffe35a" stroke="#222" stroke-width="1"/></svg>`,
];

export class UI {
  constructor() {
    this.screens = ['menu', 'create', 'join', 'lobby', 'over', 'message', 'connecting'];
    this.hudCache = {};
    this.toastTimer = null;
    this.bannerTimer = null;
    this.buildWeaponPicker();
  }

  show(name) {
    for (const s of this.screens) {
      const el = $('screen-' + s);
      if (el) el.classList.toggle('hidden', s !== name);
    }
  }

  hideScreens() {
    for (const s of this.screens) {
      const el = $('screen-' + s);
      if (el) el.classList.add('hidden');
    }
  }

  setInGame(on) {
    document.body.classList.toggle('in-game', on);
    $('hud').classList.toggle('hidden', !on);
    if (!on) this.closePicker();
    this.hudCache = {};
  }

  error(id, text) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
  }

  // ---------- Lobby ----------

  renderLobby({ code, players, isHost, settings, link, myId }) {
    $('lobby-code').textContent = code;
    $('lobby-link').textContent = link;
    const list = $('lobby-players');
    list.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = TEAM_COLORS[p.color];
      li.appendChild(dot);
      const name = document.createElement('span');
      name.textContent = p.name + (p.id === 0 ? ' (host)' : '') + (p.id === myId ? ' — you' : '');
      li.appendChild(name);
      list.appendChild(li);
    }
    for (let i = players.length; i < 4; i++) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Waiting for player…';
      list.appendChild(li);
    }
    $('lobby-settings').textContent =
      `${settings.wormsPerTeam} worm${settings.wormsPerTeam > 1 ? 's' : ''} per team · ${settings.turnTime}s turns · ${settings.hp} HP`;
    const start = $('btn-start');
    start.classList.toggle('hidden', !isHost);
    start.disabled = players.length < 2;
    $('lobby-status').textContent = isHost
      ? (players.length < 2 ? 'Share the code or link. You need at least 2 players.' : 'Ready when you are!')
      : 'Waiting for the host to start…';
  }

  // ---------- HUD ----------

  // info: { view, setup, myTeam, isMyTurn, touch }
  updateHud(info) {
    const { view, setup, isMyTurn } = info;
    const c = this.hudCache;
    if (!view) return;

    // Team HP bars.
    const totals = setup.teams.map(() => 0);
    for (const w of view.worms) if (w.alive) totals[w.team] += w.hp;
    const maxHp = setup.settings.hp * setup.settings.wormsPerTeam;
    const barsKey = totals.join(',') + '|' + view.connected.join(',') + '|' + view.turnTeam;
    if (c.bars !== barsKey) {
      c.bars = barsKey;
      const el = $('team-bars');
      el.innerHTML = '';
      setup.teams.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'team-row' + (i === view.turnTeam ? ' current' : '') + (view.connected[i] ? '' : ' offline');
        const name = document.createElement('span');
        name.className = 'team-name';
        name.textContent = t.name;
        name.style.color = t.color;
        const bar = document.createElement('div');
        bar.className = 'team-bar';
        const fill = document.createElement('div');
        fill.className = 'team-fill';
        fill.style.width = Math.max(0, Math.min(100, (totals[i] / maxHp) * 100)) + '%';
        fill.style.background = t.color;
        bar.appendChild(fill);
        row.appendChild(name);
        row.appendChild(bar);
        el.appendChild(row);
      });
    }

    // Turn banner.
    const team = setup.teams[view.turnTeam];
    let turnText = '';
    if (view.phase === 'over') turnText = 'Game over';
    else if (team) {
      const aw = view.worms.find(w => w.id === view.activeWorm);
      turnText = (isMyTurn ? 'Your turn' : `${team.name}'s turn`) + (aw ? ` · ${aw.name}` : '');
      if (view.phase === 'settle') turnText = 'Waiting…';
    }
    if (c.turn !== turnText) {
      c.turn = turnText;
      const el = $('turn-name');
      el.textContent = turnText;
      el.style.color = team && view.phase !== 'settle' ? team.color : '#fff';
    }

    // Timer.
    const retreat = view.phase === 'retreat';
    const tl = view.phase === 'turn' || retreat ? Math.max(0, Math.ceil(view.timeLeft)) : '';
    const timerKey = tl + '|' + retreat;
    if (c.timer !== timerKey) {
      c.timer = timerKey;
      const el = $('timer');
      el.textContent = tl === '' ? '–' : String(tl);
      el.classList.toggle('low', !retreat && tl !== '' && tl <= 5);
      el.classList.toggle('retreat', retreat);
    }

    // Wind indicator (-1..1).
    const wind = Math.round(view.wind * 20);
    if (c.wind !== wind) {
      c.wind = wind;
      const fill = $('wind-fill');
      const pct = Math.abs(view.wind) * 50;
      fill.style.width = pct + '%';
      fill.style.left = view.wind < 0 ? (50 - pct) + '%' : '50%';
      fill.classList.toggle('left', view.wind < 0);
      $('wind-label').textContent = wind === 0 ? 'NO WIND' : (view.wind < 0 ? '◀ WIND' : 'WIND ▶');
    }

    // Weapon chip.
    const ammo = (view.ammo && view.ammo[view.turnTeam]) || [];
    const hint = isMyTurn && view.weapon === W_TELEPORT && view.phase === 'turn';
    const wKey = view.weapon + '|' + ammo.join(',') + '|' + view.shotsLeft + '|' + isMyTurn + '|' + hint;
    if (c.weapon !== wKey) {
      c.weapon = wKey;
      const wd = WEAPONS[view.weapon];
      $('weapon-chip-icon').innerHTML = WEAPON_ICONS[view.weapon];
      let extra = '';
      if (ammo[view.weapon] >= 0) extra = ` ×${ammo[view.weapon]}`;
      if (wd.shots) extra = ` (${view.shotsLeft} shot${view.shotsLeft === 1 ? '' : 's'})`;
      if (hint) extra += ' — tap a spot';
      $('weapon-chip-name').textContent = wd.name + extra;
      $('weapon-chip').classList.toggle('mine', isMyTurn);
      $('btn-weapon').innerHTML = WEAPON_ICONS[view.weapon];
      this.updatePickerAmmo(ammo);
    }

    // Touch controls visible only during my turn.
    const controls = isMyTurn && (view.phase === 'turn' || view.phase === 'retreat' || view.phase === 'firing');
    if (c.controls !== controls) {
      c.controls = controls;
      document.body.classList.toggle('my-turn', controls);
      if (!controls) this.closePicker();
    }
    const canFire = isMyTurn && view.phase === 'turn';
    if (c.canFire !== canFire) {
      c.canFire = canFire;
      $('btn-fire').disabled = !canFire;
      $('btn-weapon').disabled = !canFire;
    }
  }

  // ---------- Weapon picker ----------

  buildWeaponPicker() {
    const grid = $('picker-grid');
    grid.innerHTML = '';
    WEAPONS.forEach((w, i) => {
      const b = document.createElement('button');
      b.className = 'picker-item';
      b.dataset.weapon = String(i);
      b.innerHTML = `${WEAPON_ICONS[i]}<span class="pname">${w.name}</span><span class="pkey">${i + 1}</span><span class="pammo"></span>`;
      grid.appendChild(b);
    });
  }

  updatePickerAmmo(ammo) {
    WEAPONS.forEach((w, i) => {
      const el = document.querySelector(`.picker-item[data-weapon="${i}"]`);
      if (!el) return;
      const n = ammo[i];
      el.querySelector('.pammo').textContent = n >= 0 ? '×' + n : '';
      el.classList.toggle('empty', n === 0);
    });
  }

  openPicker() { $('weapon-picker').classList.remove('hidden'); }
  closePicker() { $('weapon-picker').classList.add('hidden'); }
  get pickerOpen() { return !$('weapon-picker').classList.contains('hidden'); }

  // ---------- Messages ----------

  toast(text, ms = 2200) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  banner(text, color) {
    const el = $('banner');
    el.textContent = text;
    el.style.color = color || '#fff';
    el.classList.remove('show');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => el.classList.remove('show'), 1600);
  }

  showVictory({ winnerName, winnerColor, isHost, youWon }) {
    const title = $('over-title');
    if (winnerName) {
      title.textContent = youWon ? 'You win!' : `${winnerName} wins!`;
      title.style.color = winnerColor;
    } else {
      title.textContent = 'Draw!';
      title.style.color = '#fff';
    }
    $('over-sub').textContent = youWon ? 'Your worms rule the dirt.' : (winnerName ? 'Better luck next round.' : 'Everybody is worm food.');
    $('btn-again').classList.toggle('hidden', !isHost);
    $('over-wait').classList.toggle('hidden', isHost);
    this.show('over');
  }

  showMessage(title, text) {
    $('message-title').textContent = title;
    $('message-text').textContent = text;
    this.show('message');
  }
}
