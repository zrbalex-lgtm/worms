// App entry point: menus, lobby, host/client game loops and glue between modules.
import { NET, SIM_STEP, DEFAULT_SETTINGS, WORLD } from './config.js';
import { Terrain, generateTerrain } from './terrain.js';
import { Game, buildSetup } from './game.js';
import { ClientSync } from './sync.js';
import { HostNet, ClientNet, normalizeCode, loadPeerJS } from './net.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { Sfx } from './audio.js';
import { W_MINIGUN, W_SHOTGUN, W_GRENADE, W_BAZOOKA } from './weapons.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const LOCAL = params.get('net') === 'local';

const ui = new UI();
const sfx = new Sfx();
const canvas = $('game');
const renderer = new Renderer(canvas);

// ---------- App state ----------

const S = {
  mode: 'menu',          // 'menu' | 'host' | 'client'
  net: null,
  myId: 0,
  code: '',
  players: [],           // lobby players [{ id, name, color }]
  settings: { ...DEFAULT_SETTINGS },
  inGame: false,
  setup: null,
  terrain: null,
  game: null,            // host only
  sync: null,            // client only
  view: null,
  hostFx: [],            // host: visual events waiting for the next frame
  netEvents: [],         // host: events waiting for the next snapshot
  stepCount: 0,
  simAcc: 0,
  simLast: 0,
  terrainChunks: null,
  overShownFor: null,
  lastTick: -1,
  leaving: false,
  wakeLock: null,
};

const input = new Input({
  canvas,
  renderer,
  ui,
  hooks: {
    inGame: () => S.inGame,
    getView: () => S.view,
    isMyTurn: () => isMyTurn(),
    myTeam: () => myTeam(),
    activeWorm: () => {
      const v = S.view;
      return v ? v.worms.find(w => w.id === v.activeWorm && w.alive) || null : null;
    },
    send: action => sendAction(action),
    sfx: name => sfx.play(name),
    unlockAudio: () => sfx.unlock(),
  },
});

function myTeam() {
  return S.setup ? S.setup.teams.findIndex(t => t.playerId === S.myId) : -1;
}

function isMyTurn() {
  const v = S.view;
  if (!v || !S.setup || v.phase === 'over' || v.phase === 'settle') return false;
  const t = S.setup.teams[v.turnTeam];
  return !!t && t.playerId === S.myId;
}

function sendAction(action) {
  if (S.mode === 'host' && S.game) S.game.handleInput(S.myId, action);
  else if (S.mode === 'client' && S.net) S.net.send({ t: 'in', a: action });
}

// ---------- Name / link helpers ----------

function loadName() {
  try { return localStorage.getItem('ww-name') || ''; } catch (e) { return ''; }
}
function saveName(n) {
  try { localStorage.setItem('ww-name', n); } catch (e) { /* storage unavailable */ }
}
function cleanName(n) {
  return String(n || '').trim().slice(0, 14) || 'Player';
}
function shareLink(code) {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('room', code);
  if (LOCAL) u.searchParams.set('net', 'local');
  return u.toString();
}

// ---------- Menu wiring ----------

function initMenus() {
  const name = loadName();
  $('host-name').value = name;
  $('join-name').value = name;

  document.addEventListener('pointerdown', () => sfx.unlock(), { capture: true });
  document.addEventListener('keydown', () => sfx.unlock(), { capture: true });

  $('btn-create').onclick = () => { ui.error('create-error', ''); ui.show('create'); };
  $('btn-join').onclick = () => { ui.error('join-error', ''); ui.show('join'); };
  $('btn-create-back').onclick = () => ui.show('menu');
  $('btn-join-back').onclick = () => ui.show('menu');

  // Segmented control for turn time.
  for (const b of document.querySelectorAll('#opt-time button')) {
    b.onclick = () => {
      for (const o of document.querySelectorAll('#opt-time button')) o.classList.toggle('on', o === b);
    };
  }

  $('btn-create-go').onclick = () => createGame();
  $('btn-join-go').onclick = () => joinGame();
  $('join-code').addEventListener('input', e => { e.target.value = normalizeCode(e.target.value); });
  $('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(); });
  $('join-name').addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(); });

  $('btn-start').onclick = () => { if (S.mode === 'host' && S.players.length >= 2) hostStartGame(); };
  $('btn-leave').onclick = () => leaveToMenu();
  $('btn-share').onclick = async () => {
    const link = shareLink(S.code);
    try {
      if (navigator.share) { await navigator.share({ title: 'Wiggle Wars', text: `Join my Wiggle Wars game! Room ${S.code}`, url: link }); return; }
    } catch (e) { /* share cancelled */ }
    try { await navigator.clipboard.writeText(link); ui.toast('Link copied!'); } catch (e) { ui.toast(link, 5000); }
  };
  $('btn-again').onclick = () => {
    if (S.mode !== 'host') return;
    if (S.players.length >= 2) { hostStartGame(); return; }
    // Everybody else left: go back to the lobby and wait for new players.
    exitGameView();
    S.net.broadcast({ t: 'lobby', players: S.players, settings: S.settings, code: S.code });
    renderLobby({ code: S.code, players: S.players, settings: S.settings });
    ui.show('lobby');
  };
  $('btn-menu').onclick = () => leaveToMenu();
  $('btn-message-ok').onclick = () => leaveToMenu();
  $('btn-connecting-cancel').onclick = () => leaveToMenu();
  $('btn-help').onclick = () => $('help-overlay').classList.toggle('hidden');
  $('help-overlay').onclick = () => $('help-overlay').classList.add('hidden');
  $('btn-quit').onclick = () => {
    if (confirmQuit()) leaveToMenu();
  };

  const room = normalizeCode(params.get('room'));
  if (room) {
    $('join-code').value = room;
    ui.show('join');
    if (!name) setTimeout(() => $('join-name').focus(), 50);
  } else {
    ui.show('menu');
  }
  if (LOCAL) $('local-badge').classList.remove('hidden');
}

let quitArmed = 0;
function confirmQuit() {
  // Two taps within 2 seconds quit, avoiding a blocking confirm() dialog.
  const now = Date.now();
  if (now - quitArmed < 2000) return true;
  quitArmed = now;
  ui.toast('Tap again to leave the game');
  return false;
}

// ---------- Host ----------

async function createGame() {
  const name = cleanName($('host-name').value);
  saveName(name);
  $('join-name').value = name;
  const onBtn = document.querySelector('#opt-time button.on');
  S.settings = {
    wormsPerTeam: Math.max(1, Math.min(6, Number($('opt-worms').value) || 4)),
    turnTime: Number(onBtn ? onBtn.dataset.time : 45) || 45,
    hp: Math.max(10, Math.min(300, Number($('opt-hp').value) || 100)),
  };
  ui.show('connecting');
  $('connecting-text').textContent = 'Creating room…';
  const net = new HostNet(LOCAL);
  S.net = net;
  S.mode = 'host';
  S.myId = 0;
  S.players = [{ id: 0, name, color: 0 }];
  net.acceptJoin = () => {
    if (S.inGame) return { ok: false, reason: 'This game has already started.' };
    if (S.players.length >= NET.MAX_PLAYERS) return { ok: false, reason: 'This room is full (4 players).' };
    return { ok: true };
  };
  net.on('join', (pid, pname) => {
    const used = new Set(S.players.map(p => p.color));
    let color = 0;
    while (used.has(color)) color++;
    S.players.push({ id: pid, name: pname, color });
    broadcastLobby();
    sfx.play('select');
  });
  net.on('leave', pid => {
    const p = S.players.find(q => q.id === pid);
    S.players = S.players.filter(q => q.id !== pid);
    if (S.inGame && S.game) {
      S.game.setConnected(pid, false);
      if (p) S.game.emit({ k: 'msg', text: `${p.name} left the game` });
    } else {
      broadcastLobby();
      if (p) ui.toast(`${p.name} left`);
    }
  });
  net.on('message', (pid, msg) => {
    if (msg.t === 'in' && S.game && S.inGame) S.game.handleInput(pid, msg.a);
  });
  try {
    S.code = await net.start();
  } catch (e) {
    net.destroy();
    if (S.net !== net) return; // cancelled meanwhile
    S.net = null;
    S.mode = 'menu';
    ui.show('create');
    ui.error('create-error', e.message);
    return;
  }
  if (S.net !== net) { net.destroy(); return; } // cancelled meanwhile
  broadcastLobby();
  ui.show('lobby');
}

function broadcastLobby() {
  if (S.mode !== 'host') return;
  const lobby = { t: 'lobby', players: S.players, settings: S.settings, code: S.code };
  S.net.broadcast(lobby);
  if (!S.inGame) renderLobby(lobby);
}

function renderLobby(l) {
  ui.renderLobby({ code: l.code, players: l.players, isHost: S.mode === 'host', settings: l.settings, link: shareLink(l.code), myId: S.myId });
}

function hostStartGame() {
  const setup = buildSetup(S.players, S.settings);
  const terrain = generateTerrain(setup.seed);
  S.game = new Game(setup, terrain);
  S.netEvents = [];
  S.hostFx = [];
  S.stepCount = 0;
  S.simAcc = 0;
  S.simLast = performance.now() / 1000;
  S.net.broadcast({ t: 'start', setup });
  const enc = terrain.encode();
  const n = Math.ceil(enc.length / NET.TERRAIN_CHUNK);
  for (let i = 0; i < n; i++) {
    S.net.broadcast({ t: 'tr', i, n, d: enc.slice(i * NET.TERRAIN_CHUNK, (i + 1) * NET.TERRAIN_CHUNK) });
  }
  enterGame(setup, terrain);
}

// Fixed-step simulation; called from the ticker worker and every animation frame.
function hostTick() {
  if (S.mode !== 'host' || !S.game || !S.inGame) return;
  const now = performance.now() / 1000;
  S.simAcc += Math.min(0.25, now - S.simLast);
  S.simLast = now;
  const g = S.game;
  while (S.simAcc >= SIM_STEP) {
    S.simAcc -= SIM_STEP;
    g.step(SIM_STEP);
    S.stepCount++;
    for (const ev of g.drainEvents()) {
      if (ev.k === 'crater') renderer.handleEvent(ev); // keep the host's terrain picture in sync immediately
      else { S.hostFx.push(ev); if (S.hostFx.length > 400) S.hostFx.shift(); }
      S.netEvents.push(ev);
    }
    if (S.stepCount % NET.SNAPSHOT_EVERY === 0) {
      const snap = g.snapshot();
      snap.ev = S.netEvents;
      S.netEvents = [];
      S.net.broadcast(snap);
    }
  }
}

// Background-proof ticker: timers in a worker are not throttled like the main thread when the tab is hidden.
function startTicker() {
  try {
    const src = 'setInterval(function(){postMessage(0)}, 16);';
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = () => hostTick();
  } catch (e) {
    setInterval(hostTick, 16);
  }
}

// ---------- Client ----------

async function joinGame() {
  const name = cleanName($('join-name').value);
  const code = normalizeCode($('join-code').value);
  saveName(name);
  $('host-name').value = name;
  if (code.length !== 6) { ui.error('join-error', 'Room codes have 6 characters.'); return; }
  ui.error('join-error', '');
  ui.show('connecting');
  $('connecting-text').textContent = `Joining room ${code}…`;
  const net = new ClientNet(LOCAL);
  S.net = net;
  S.mode = 'client';
  S.code = code;
  net.on('message', msg => onClientMessage(msg));
  net.on('close', () => {
    if (S.leaving || S.net !== net) return;
    exitGameView();
    ui.showMessage('Host left the game', 'The connection to the host was lost.');
    S.net = null;
    S.mode = 'menu';
    net.destroy();
  });
  try {
    const res = await net.join(code, name);
    if (S.net !== net) return;
    S.myId = res.id;
    // Clean the ?room= parameter so a reload doesn't auto-join again.
    if (params.get('room')) history.replaceState(null, '', LOCAL ? '?net=local' : location.pathname);
    ui.show('lobby');
    $('lobby-code').textContent = code;
  } catch (e) {
    if (S.net !== net) return;
    S.net = null;
    S.mode = 'menu';
    ui.show('join');
    ui.error('join-error', e.message);
  }
}

function onClientMessage(msg) {
  switch (msg.t) {
    case 'lobby':
      S.players = msg.players;
      S.settings = msg.settings;
      if (S.inGame) { exitGameView(); ui.show('lobby'); } // host returned to the lobby
      renderLobby(msg);
      break;
    case 'start':
      S.setup = msg.setup;
      S.terrainChunks = [];
      S.sync = new ClientSync(prepSetup(msg.setup));
      ui.show('connecting');
      $('connecting-text').textContent = 'Loading map…';
      break;
    case 'tr':
      if (!S.terrainChunks) break;
      S.terrainChunks[msg.i] = msg.d;
      if (S.terrainChunks.filter(x => x !== undefined).length === msg.n) {
        const t = new Terrain(WORLD.W, WORLD.H);
        t.decode(S.terrainChunks.join(''));
        S.terrainChunks = null;
        enterGame(S.setup, t);
      }
      break;
    case 's':
      if (S.sync) S.sync.push(msg, performance.now() / 1000);
      break;
  }
}

// ---------- Shared game view ----------

function prepSetup(setup) {
  setup.wormMap = new Map(setup.worms.map(w => [w.id, w]));
  return setup;
}

function enterGame(setup, terrain) {
  S.setup = prepSetup(setup);
  S.terrain = terrain;
  S.inGame = true;
  S.view = null;
  S.overShownFor = null;
  S.lastTick = -1;
  renderer.resize();
  renderer.init(setup, terrain);
  // Start roughly above the map center.
  renderer.cam.x = WORLD.W / 2;
  renderer.cam.y = WORLD.WATER_Y - 400;
  ui.hideScreens();
  ui.setInGame(true);
  requestWakeLock();
}

function exitGameView() {
  S.inGame = false;
  S.game = null;
  S.sync = null;
  S.view = null;
  ui.setInGame(false);
  document.body.classList.remove('my-turn');
  releaseWakeLock();
}

function leaveToMenu() {
  S.leaving = true;
  exitGameView();
  if (S.net) { try { S.net.destroy(); } catch (e) { /* ignore */ } }
  S.net = null;
  S.mode = 'menu';
  S.players = [];
  S.setup = null;
  S.leaving = false;
  if (params.get('room')) history.replaceState(null, '', LOCAL ? '?net=local' : location.pathname);
  ui.show('menu');
}

async function requestWakeLock() {
  try { if (navigator.wakeLock && !S.wakeLock) S.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
}
function releaseWakeLock() {
  try { if (S.wakeLock) S.wakeLock.release(); } catch (e) { /* ignore */ }
  S.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.inGame) { S.wakeLock = null; requestWakeLock(); }
});

// ---------- Events -> sound, messages ----------

let lastOuch = 0;
function processEvent(ev, fresh) {
  if (ev.k !== 'crater' || S.mode !== 'host') renderer.handleEvent(ev);
  if (!fresh) return;
  const vol = eventVolume(ev);
  switch (ev.k) {
    case 'boom': sfx.play('boom', vol); break;
    case 'puff': sfx.play('puff', vol); break;
    case 'fire':
      if (ev.w === W_MINIGUN) sfx.play('minigun', vol);
      else if (ev.w === W_SHOTGUN) sfx.play('shotgun', vol);
      else if (ev.w === W_BAZOOKA) sfx.play('bazooka', vol);
      else if (ev.w === W_GRENADE) sfx.play('throw', vol);
      break;
    case 'punch': sfx.play(ev.hit ? 'punch' : 'whiff', vol); break;
    case 'bounce': sfx.play('bounce', vol); break;
    case 'splash': sfx.play('splash', vol); break;
    case 'jump': sfx.play('jump', vol); break;
    case 'dmg': {
      const now = performance.now();
      if (now - lastOuch > 250) { lastOuch = now; sfx.play('ouch', vol); }
      break;
    }
    case 'die': sfx.play('die'); break;
    case 'select': sfx.play('select'); break;
    case 'turn': {
      const team = S.setup.teams[ev.team];
      if (!team) break;
      if (team.playerId === S.myId) {
        sfx.play('myturn');
        ui.banner('Your turn!', team.color);
        input.resetTurn();
      } else {
        sfx.play('turn');
        ui.banner(`${team.name}'s turn`, team.color);
      }
      break;
    }
    case 'msg':
      if (ev.team === undefined || ev.team === myTeam()) ui.toast(ev.text);
      break;
  }
}

function eventVolume(ev) {
  if (ev.x === undefined) return 1;
  const c = renderer.cam;
  const d = Math.hypot(ev.x - c.x, (ev.y ?? c.y) - c.y);
  return Math.max(0.25, Math.min(1, 1.2 - d / 1400));
}

// ---------- Main loop ----------

let lastFrame = performance.now() / 1000;
function frame(ts) {
  requestAnimationFrame(frame);
  const now = ts / 1000;
  const dt = Math.min(0.05, Math.max(0, now - lastFrame));
  lastFrame = now;
  if (!S.inGame) return;

  let events = [];
  if (S.mode === 'host' && S.game) {
    hostTick();
    S.view = S.game.view();
    events = S.hostFx;
    S.hostFx = [];
    const t = S.game.time;
    for (const ev of events) processEvent(ev, t - ev.t < 1);
  } else if (S.mode === 'client' && S.sync) {
    const v = S.sync.view(performance.now() / 1000);
    if (v) S.view = v;
    events = S.sync.takeEvents();
    const rt = S.sync.renderT;
    for (const ev of events) processEvent(ev, rt - ev.t < 1);
  }
  const view = S.view;
  if (!view) return;

  input.update(dt);
  const mine = isMyTurn();
  renderer.frame(view, dt, {
    myTeam: myTeam(),
    isMyTurn: mine,
    aim: mine ? input.localAim() : null,
    sling: mine ? input.slingOverlay() : null,
  });
  ui.updateHud({ view, setup: S.setup, myTeam: myTeam(), isMyTurn: mine });

  // Countdown ticks for the last 5 seconds of a turn.
  if (view.phase === 'turn') {
    const sec = Math.ceil(view.timeLeft);
    if (sec !== S.lastTick) {
      S.lastTick = sec;
      if (sec <= 5 && sec > 0) sfx.play('tick');
    }
  }

  // Victory screen (after a short pause so the last explosion can be seen).
  if (view.phase === 'over') {
    const key = S.setup.seed;
    if (S.overShownFor === null) S.overShownFor = { key, at: now };
    if (S.overShownFor.key === key && S.overShownFor.at > 0 && now - S.overShownFor.at > 1.8) {
      S.overShownFor.at = -1;
      const win = S.setup.teams[view.winner];
      ui.showVictory({
        winnerName: win ? win.name : null,
        winnerColor: win ? win.color : '#fff',
        isHost: S.mode === 'host',
        youWon: !!win && win.playerId === S.myId,
      });
      if (win && win.playerId === S.myId) sfx.play('win');
      else sfx.play('die');
    }
  }
}

// ---------- Resize / mobile plumbing ----------

function onResize() { renderer.resize(); }
addEventListener('resize', onResize);
addEventListener('orientationchange', () => setTimeout(onResize, 250));
if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
// Block iOS pinch-zoom of the page and double-tap zoom.
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('gesturechange', e => e.preventDefault());
document.addEventListener('dblclick', e => e.preventDefault());
if (matchMedia('(pointer: coarse)').matches) {
  document.body.classList.add('touch');
  renderer.touch = true;
  input.touchSeen = true;
}

initMenus();
startTicker();
// Warm up the PeerJS download in the background (the menus don't wait for it).
if (!LOCAL) loadPeerJS().catch(() => { /* reported when creating/joining */ });
requestAnimationFrame(frame);

// Expose a tiny debug handle for local testing.
window.__ww = S;
window.__wwScreen = () => {
  const v = S.view;
  const w = v && v.worms.find(o => o.id === v.activeWorm);
  return w ? renderer.wormScreen(w) : null;
};
