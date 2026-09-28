// Peer-to-peer networking. Uses PeerJS (WebRTC) by default; a BroadcastChannel
// transport (?net=local) allows offline testing with two tabs of the same browser.
import { NET } from './config.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeRoomCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

export function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] ||= []).push(fn); return this; }
  off(ev) { delete this._h[ev]; }
  emit(ev, ...args) { for (const fn of this._h[ev] || []) fn(...args); }
}

// ---------- Local (BroadcastChannel) transport with a PeerJS-like surface ----------

class LocalConn extends Emitter {
  constructor(owner, peer, metadata) {
    super();
    this.owner = owner;
    this.peer = peer;
    this.metadata = metadata;
    this.open = false;
  }
  send(data) {
    if (!this.open) return;
    this.owner._post({ type: 'data', to: this.peer, data });
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.owner._post({ type: 'close', to: this.peer });
    this.owner.conns.delete(this.peer);
    this.emit('close');
  }
}

class LocalPeer extends Emitter {
  constructor(id) {
    super();
    this.id = id || 'local-' + Math.random().toString(36).slice(2, 10);
    this.conns = new Map();
    this.ch = new BroadcastChannel('wiggle-wars-local');
    this.ch.onmessage = e => this._onMsg(e.data);
    this._pendingConnect = null;
    addEventListener('pagehide', () => this.destroy());
    setTimeout(() => this.emit('open', this.id), 0);
  }
  _post(msg) { msg.from = this.id; this.ch.postMessage(msg); }
  _onMsg(m) {
    if (m.to !== this.id) return;
    if (m.type === 'connect') {
      const c = new LocalConn(this, m.from, m.metadata);
      this.conns.set(m.from, c);
      // Mark open before replying so the peer's first message can never be dropped.
      c.open = true;
      this.emit('connection', c);
      this._post({ type: 'accept', to: m.from });
      setTimeout(() => c.emit('open'), 0);
    } else if (m.type === 'accept') {
      const c = this.conns.get(m.from);
      if (c && !c.open) {
        clearTimeout(this._pendingConnect);
        c.open = true;
        c.emit('open');
      }
    } else if (m.type === 'data') {
      const c = this.conns.get(m.from);
      if (c && c.open) c.emit('data', m.data);
    } else if (m.type === 'close') {
      const c = this.conns.get(m.from);
      if (c) { c.open = false; this.conns.delete(m.from); c.emit('close'); }
    }
  }
  connect(target, opts = {}) {
    const c = new LocalConn(this, target, opts.metadata);
    this.conns.set(target, c);
    this._post({ type: 'connect', to: target, metadata: opts.metadata });
    this._pendingConnect = setTimeout(() => {
      if (!c.open) this.emit('error', { type: 'peer-unavailable' });
    }, 2500);
    return c;
  }
  destroy() {
    for (const c of [...this.conns.values()]) c.close();
    try { this.ch.close(); } catch (e) { /* already closed */ }
  }
}

const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js';
let peerJsPromise = null;

// Load PeerJS on demand so the menus never wait for the CDN.
export function loadPeerJS() {
  if (window.Peer) return Promise.resolve();
  if (peerJsPromise) return peerJsPromise;
  peerJsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PEERJS_URL;
    s.async = true;
    const timer = setTimeout(() => fail(), 20000);
    function fail() {
      clearTimeout(timer);
      peerJsPromise = null;
      s.remove();
      reject(new Error('Could not load PeerJS. Check your internet connection.'));
    }
    s.onload = () => { clearTimeout(timer); window.Peer ? resolve() : fail(); };
    s.onerror = fail;
    document.head.appendChild(s);
  });
  return peerJsPromise;
}

function createPeer(local, id) {
  if (local) return new LocalPeer(id);
  if (typeof window.Peer !== 'function') throw new Error('PeerJS failed to load (check your internet connection).');
  return id ? new window.Peer(id, { debug: 1 }) : new window.Peer({ debug: 1 });
}

// ---------- Host ----------

export class HostNet extends Emitter {
  constructor(local) {
    super();
    this.local = local;
    this.peer = null;
    this.code = null;
    this.clients = new Map(); // playerId -> { conn, lastSeen, name }
    this.nextPlayerId = 1;
    this.acceptJoin = () => ({ ok: true });
    this._ping = null;
  }

  // Resolves with the room code once registered with the broker.
  async start() {
    if (!this.local) await loadPeerJS();
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const tryOpen = () => {
        attempts++;
        const code = makeRoomCode();
        let peer;
        try { peer = createPeer(this.local, NET.PEER_PREFIX + code); } catch (e) { reject(e); return; }
        let opened = false;
        peer.on('open', () => {
          opened = true;
          this.peer = peer;
          this.code = code;
          peer.on('connection', conn => this._onConnection(conn));
          this._ping = setInterval(() => this._heartbeat(), NET.PING_EVERY);
          resolve(code);
        });
        peer.on('error', err => {
          if (!opened && err && err.type === 'unavailable-id' && attempts < 5) {
            peer.destroy();
            tryOpen();
          } else if (!opened) {
            reject(new Error(describePeerError(err)));
          } else {
            console.warn('Peer error', err);
          }
        });
        peer.on('disconnected', () => {
          // Lost the broker connection; existing peer links keep working. Try to re-register.
          try { if (!peer.destroyed) peer.reconnect(); } catch (e) { /* ignore */ }
        });
      };
      tryOpen();
    });
  }

  _onConnection(conn) {
    let playerId = null;
    const onOpen = () => {
      // Wait for 'hello' before admitting.
    };
    if (conn.open) onOpen(); else conn.on('open', onOpen);
    conn.on('data', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (playerId === null) {
        if (msg.t !== 'hello') return;
        const verdict = this.acceptJoin(msg);
        if (!verdict.ok) {
          conn.send({ t: 'reject', reason: verdict.reason });
          setTimeout(() => conn.close(), 500);
          return;
        }
        playerId = this.nextPlayerId++;
        const name = String(msg.name || 'Player').slice(0, 16);
        this.clients.set(playerId, { conn, lastSeen: Date.now(), name });
        conn.send({ t: 'welcome', id: playerId, code: this.code });
        this.emit('join', playerId, name);
        return;
      }
      const c = this.clients.get(playerId);
      if (c) c.lastSeen = Date.now();
      if (msg.t === 'p') return;
      this.emit('message', playerId, msg);
    });
    const onClose = () => {
      if (playerId !== null && this.clients.has(playerId)) {
        this.clients.delete(playerId);
        this.emit('leave', playerId);
      }
    };
    conn.on('close', onClose);
    conn.on('error', onClose);
  }

  _heartbeat() {
    const now = Date.now();
    for (const [pid, c] of this.clients) {
      if (now - c.lastSeen > NET.TIMEOUT) {
        this.clients.delete(pid);
        try { c.conn.close(); } catch (e) { /* ignore */ }
        this.emit('leave', pid);
        continue;
      }
      this._send(c.conn, { t: 'p' });
    }
  }

  _send(conn, msg) {
    try { if (conn.open) conn.send(msg); } catch (e) { console.warn('send failed', e); }
  }

  sendTo(pid, msg) {
    const c = this.clients.get(pid);
    if (c) this._send(c.conn, msg);
  }

  broadcast(msg) {
    for (const c of this.clients.values()) this._send(c.conn, msg);
  }

  kick(pid) {
    const c = this.clients.get(pid);
    if (!c) return;
    this.clients.delete(pid);
    try { c.conn.close(); } catch (e) { /* ignore */ }
  }

  destroy() {
    clearInterval(this._ping);
    for (const c of this.clients.values()) { try { c.conn.close(); } catch (e) { /* ignore */ } }
    this.clients.clear();
    try { this.peer && this.peer.destroy(); } catch (e) { /* ignore */ }
    this.peer = null;
  }
}

// ---------- Client ----------

export class ClientNet extends Emitter {
  constructor(local) {
    super();
    this.local = local;
    this.peer = null;
    this.conn = null;
    this.lastSeen = 0;
    this.closed = false;
    this._ping = null;
  }

  // Resolves with { id } after the host welcomes us; rejects on failure.
  async join(code, name) {
    if (!this.local) await loadPeerJS();
    if (this.closed) throw new Error('Cancelled.');
    return new Promise((resolve, reject) => {
      let peer;
      try { peer = createPeer(this.local); } catch (e) { reject(e); return; }
      this.peer = peer;
      let settled = false;
      const fail = msg => {
        if (settled) return;
        settled = true;
        this.destroy();
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail('Could not reach the host. Check the room code.'), 15000);
      peer.on('error', err => {
        if (!settled) { clearTimeout(timer); fail(describePeerError(err)); }
        else console.warn('Peer error', err);
      });
      peer.on('open', () => {
        const conn = peer.connect(NET.PEER_PREFIX + code, { reliable: true, serialization: 'json', metadata: { name } });
        this.conn = conn;
        conn.on('open', () => {
          conn.send({ t: 'hello', name });
          this.lastSeen = Date.now();
        });
        conn.on('data', msg => {
          if (!msg || typeof msg !== 'object') return;
          this.lastSeen = Date.now();
          if (!settled) {
            if (msg.t === 'welcome') {
              settled = true;
              clearTimeout(timer);
              this._ping = setInterval(() => this._heartbeat(), NET.PING_EVERY);
              resolve({ id: msg.id });
            } else if (msg.t === 'reject') {
              clearTimeout(timer);
              fail(msg.reason || 'The host refused the connection.');
            }
            return;
          }
          if (msg.t === 'p') return;
          this.emit('message', msg);
        });
        conn.on('close', () => this._lost());
        conn.on('error', () => this._lost());
      });
    });
  }

  _heartbeat() {
    if (Date.now() - this.lastSeen > NET.TIMEOUT) { this._lost(); return; }
    this.send({ t: 'p' });
  }

  _lost() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._ping);
    this.emit('close');
  }

  send(msg) {
    try { if (this.conn && this.conn.open) this.conn.send(msg); } catch (e) { console.warn('send failed', e); }
  }

  destroy() {
    this.closed = true;
    clearInterval(this._ping);
    try { this.conn && this.conn.close(); } catch (e) { /* ignore */ }
    try { this.peer && this.peer.destroy(); } catch (e) { /* ignore */ }
  }
}

function describePeerError(err) {
  const type = err && err.type;
  switch (type) {
    case 'peer-unavailable': return 'Room not found. Check the code (the host must keep the game open).';
    case 'network': return 'Network error: cannot reach the matchmaking server.';
    case 'server-error': return 'The matchmaking server is unavailable. Try again in a moment.';
    case 'browser-incompatible': return 'This browser does not support WebRTC.';
    case 'unavailable-id': return 'Could not create a room code. Try again.';
    default: return (err && err.message) || 'Connection error.';
  }
}
