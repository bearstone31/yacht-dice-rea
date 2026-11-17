// Yacht online server: serves the web client and runs authoritative rooms over WebSocket.
// Structure follows the original Mirror design (see ANALYSIS.md): clients send commands,
// the server validates "is it your turn", rolls the dice and broadcasts the state.
// It also replaces the Steam features the original relied on: friend codes + presence
// (MainUIFriendsManager / RichPresenceClass), invites, and quick match (QuickMatch).
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Game = require('./yacht-game.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const TIMER_CHOICES = [0, 30, 60, 90]; // seconds; 0 = off. Original default TimePerTurn = 60
const EMPTY_ROOM_TTL_MS = 2 * 60 * 1000;
const EMOJIS = 6;
const SECOND_MS = Number(process.env.YACHT_SECOND_MS) || 1000; // tests shrink this to check the turn timer quickly
const MAX_PRESENCE_QUERY = 200;

// ---------------- static files (whitelist only) ----------------
const JS = 'text/javascript; charset=utf-8';
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', JS],
  '/i18n.js': ['i18n.js', JS],
  '/sound.js': ['sound.js', JS],
  '/prefs.js': ['prefs.js', JS],
  '/yacht-core.js': ['yacht-core.js', JS],
  '/yacht-game.js': ['yacht-game.js', JS],
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const f = STATIC[url.pathname];
  if (!f || req.method !== 'GET') { res.writeHead(404); return res.end('not found'); }
  fs.readFile(path.join(__dirname, f[0]), (err, data) => {
    if (err) { res.writeHead(500); return res.end('error'); }
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------------- state ----------------
const rooms = new Map();   // code -> room
const clients = new Set(); // connection records

const newId = () => crypto.randomBytes(6).toString('hex');
const newToken = () => crypto.randomBytes(16).toString('hex');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join(''); } while (rooms.has(c));
  return c;
}
/** Public friend code derived from the client's private, locally stored user key. */
function friendCodeOf(userKey) {
  const h = crypto.createHash('sha256').update('yacht-friend:' + userKey).digest();
  return Array.from(h.subarray(0, 6), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
const cleanName = s => (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
const rng = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;

function send(c, msg) { if (c && c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); }
function err(c, code) { send(c, { t: 'error', code }); }

function roomView(room) {
  const g = room.game;
  return {
    code: room.code, name: room.name, hostId: room.hostId, phase: room.phase,
    settings: room.settings, gameNo: room.gameNo,
    members: room.members.map(m => ({ id: m.id, name: m.name, ready: m.ready, online: !!m.conn, friendCode: m.friendCode })),
    game: g, remainingMs: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
  };
}
function broadcastRoom(room) {
  const view = roomView(room);
  for (const m of room.members) if (m.conn) send(m.conn, { t: 'room', room: view, you: m.id });
}
const isOpen = r => r.phase === 'lobby' && r.members.length < MAX_PLAYERS;
function lobbyList() {
  return [...rooms.values()].filter(isOpen)
    .map(r => ({ code: r.code, name: r.name, players: r.members.length, max: MAX_PLAYERS, timer: r.settings.timer }));
}
function broadcastList() {
  const list = lobbyList();
  for (const c of clients) if (!c.room && c.name) send(c, { t: 'rooms', rooms: list });
}

// ---------------- presence (RichPresenceClass: Not In Game / In The Lobby / In The Game) ----------------
function presenceOf(c) {
  const r = c.room;
  if (!r) return { status: 'online' };
  if (r.phase === 'lobby') return { status: 'lobby', room: r.code, roomName: r.name, joinable: isOpen(r) };
  return { status: 'game', room: r.code, roomName: r.name };
}
function clientsByFriendCode(code) { return [...clients].filter(c => c.friendCode === code && c.name); }

// ---------------- turn timer (MirrorRoller.remainControllTime + AutoScore) ----------------
function armTimer(room) {
  clearTimeout(room.timerHandle);
  room.deadline = null;
  const g = room.game;
  if (room.phase !== 'game' || !g || g.over || !room.settings.timer) return;
  const ms = room.settings.timer * SECOND_MS;
  room.deadline = Date.now() + ms;
  room.timerHandle = setTimeout(() => {
    const prev = turnKey(room.game);
    Game.autoScore(room.game, rng);
    afterAction(room, prev);
  }, ms);
}
function turnKey(g) { return g ? `${g.round}:${g.cur}:${g.over}` : ''; }

function afterAction(room, prevKey) {
  const g = room.game;
  if (g && g.over && room.phase === 'game') {
    room.phase = 'over';
    clearTimeout(room.timerHandle);
    room.deadline = null;
  } else if (g && prevKey !== turnKey(g)) {
    armTimer(room);
  }
  broadcastRoom(room);
}

// ---------------- room membership ----------------
function leaveRoom(c, voluntary) {
  const room = c.room;
  if (!room) return;
  const m = room.members.find(x => x.id === c.id);
  c.room = null;
  if (!m) return;
  if (room.phase !== 'game') {
    room.members = room.members.filter(x => x !== m);
  } else {
    // in game: keep the seat for reconnection, mark offline
    m.conn = null;
    if (voluntary) m.token = null; // left on purpose: no rejoin
    const prev = turnKey(room.game);
    const wasCurrent = Game.current(room.game).id === m.id;
    Game.setOnline(room.game, m.id, false);
    if (wasCurrent && !room.game.over) Game.autoScore(room.game, rng); // original: AutoScore when the controller leaves
    afterAction(room, prev);
  }
  if (room.hostId === m.id || !room.members.some(x => x.id === room.hostId && x.conn)) {
    const next = room.members.find(x => x.conn);
    if (next) room.hostId = next.id;
  }
  if (!room.members.some(x => x.conn)) scheduleCleanup(room);
  else broadcastRoom(room);
  broadcastList();
}
function scheduleCleanup(room) {
  clearTimeout(room.cleanupHandle);
  room.cleanupHandle = setTimeout(() => {
    if (!room.members.some(x => x.conn)) {
      clearTimeout(room.timerHandle);
      rooms.delete(room.code);
      broadcastList();
    }
  }, room.members.length ? EMPTY_ROOM_TTL_MS : 0);
}
function joinRoom(c, room) {
  if (room.phase !== 'lobby') return err(c, 'started');
  if (room.members.length >= MAX_PLAYERS) return err(c, 'full');
  if (c.room === room) return broadcastRoom(room);
  if (c.room) leaveRoom(c, true);
  room.members.push({ id: c.id, name: c.name, ready: false, token: c.token, conn: c, friendCode: c.friendCode });
  c.room = room;
  clearTimeout(room.cleanupHandle);
  if (!room.members.some(x => x.id === room.hostId)) room.hostId = c.id;
  broadcastRoom(room);
  broadcastList();
}
function createRoom(c, name, timer) {
  const r = {
    code: newCode(), name: cleanName(name) || `${c.name}`, hostId: c.id, phase: 'lobby',
    settings: { timer: TIMER_CHOICES.includes(timer) ? timer : 60 },
    members: [], game: null, deadline: null, gameNo: 0,
  };
  rooms.set(r.code, r);
  joinRoom(c, r);
}

// ---------------- message handling ----------------
function handle(c, msg) {
  if (!msg || typeof msg.t !== 'string') return;
  if (msg.t !== 'hello' && !c.name) return; // must say hello first
  const room = c.room;
  const me = room && room.members.find(m => m.id === c.id);
  const isHost = room && room.hostId === c.id;

  switch (msg.t) {
    case 'hello': {
      c.name = cleanName(msg.name) || `Player${Math.floor(Math.random() * 90 + 10)}`;
      const key = typeof msg.userKey === 'string' && /^[0-9a-f]{32}$/.test(msg.userKey) ? msg.userKey : newToken();
      c.friendCode = friendCodeOf(key);
      // reconnection: same token -> take back the seat
      if (typeof msg.token === 'string' && msg.token.length === 32) {
        for (const r of rooms.values()) {
          const m = r.members.find(x => x.token === msg.token && !x.conn);
          if (m) {
            c.id = m.id; c.token = m.token; c.room = r; m.conn = c; m.friendCode = c.friendCode;
            clearTimeout(r.cleanupHandle);
            if (r.game) Game.setOnline(r.game, m.id, true);
            send(c, { t: 'welcome', id: c.id, token: c.token, name: m.name, friendCode: c.friendCode, rejoined: true });
            return broadcastRoom(r);
          }
        }
      }
      send(c, { t: 'welcome', id: c.id, token: c.token, name: c.name, friendCode: c.friendCode });
      return send(c, { t: 'rooms', rooms: lobbyList() });
    }
    case 'list': return send(c, { t: 'rooms', rooms: lobbyList() });
    case 'create': return createRoom(c, msg.name, msg.timer);
    case 'join': {
      const r = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!r) return err(c, 'noroom');
      return joinRoom(c, r);
    }
    case 'quick': { // MainUILobbyManager.QuickMatch: join an open room, otherwise create one
      if (c.room) return;
      const open = [...rooms.values()].filter(isOpen).sort((a, b) => b.members.length - a.members.length)[0];
      return open ? joinRoom(c, open) : createRoom(c, '', 60);
    }
    case 'leave': leaveRoom(c, true); return send(c, { t: 'rooms', rooms: lobbyList() });

    // ---- friends ----
    case 'presence': { // status of the friend codes the client keeps locally
      const codes = Array.isArray(msg.codes) ? msg.codes.filter(x => typeof x === 'string').slice(0, MAX_PRESENCE_QUERY) : [];
      const list = codes.map(code => {
        const cs = clientsByFriendCode(code);
        if (!cs.length) return { code, status: 'offline' };
        const best = cs.find(x => x.room && x.room.phase !== 'lobby') || cs.find(x => x.room) || cs[0];
        return { code, name: best.name, ...presenceOf(best) };
      });
      return send(c, { t: 'presence', list });
    }
    case 'users': { // everyone connected to this server (to add as friends)
      const seen = new Set(), list = [];
      for (const x of clients) {
        if (!x.name || x.friendCode === c.friendCode || seen.has(x.friendCode)) continue;
        seen.add(x.friendCode);
        list.push({ code: x.friendCode, name: x.name, ...presenceOf(x) });
        if (list.length >= 100) break;
      }
      return send(c, { t: 'users', list });
    }
    case 'invite': {
      const now = Date.now();
      if (!room || room.phase !== 'lobby') return err(c, 'invite_noroom');
      if (now - (c.lastInvite || 0) < 1500) return;
      c.lastInvite = now;
      const targets = clientsByFriendCode(String(msg.code || ''));
      if (!targets.length) return err(c, 'invite_offline');
      for (const x of targets) {
        send(x, { t: 'invite', from: c.name, fromCode: c.friendCode, room: room.code, roomName: room.name });
      }
      return send(c, { t: 'invited', code: msg.code });
    }
  }

  if (!room || !me) return err(c, 'notinroom');

  switch (msg.t) {
    case 'ready':
      if (room.phase !== 'lobby') return;
      me.ready = !!msg.ready;
      return broadcastRoom(room);
    case 'settings':
      if (!isHost || room.phase !== 'lobby') return;
      if (TIMER_CHOICES.includes(msg.timer)) room.settings.timer = msg.timer;
      broadcastRoom(room); return broadcastList();
    case 'start': {
      // MainUILobbyManager.LobbyStartGame: owner only, everyone ready, at least 2 players
      if (!isHost || room.phase !== 'lobby') return;
      if (room.members.length < MIN_PLAYERS) return err(c, 'need2');
      if (room.members.some(m => m.id !== room.hostId && !m.ready)) return err(c, 'notready');
      room.game = Game.createGame(room.members.map(m => ({ id: m.id, name: m.name })));
      room.phase = 'game';
      room.gameNo++;
      armTimer(room);
      broadcastRoom(room); return broadcastList();
    }
    case 'again': {
      if (!isHost || room.phase !== 'over') return;
      room.members = room.members.filter(m => m.conn);
      room.members.forEach(m => { m.ready = false; });
      room.phase = 'lobby'; room.game = null;
      broadcastRoom(room); return broadcastList();
    }
    case 'emoji': {
      const now = Date.now();
      if (!Number.isInteger(msg.i) || msg.i < 0 || msg.i >= EMOJIS || now - (c.lastEmoji || 0) < 800) return;
      c.lastEmoji = now;
      for (const m of room.members) if (m.conn) send(m.conn, { t: 'emoji', from: me.id, i: msg.i });
      return;
    }
  }

  // ---- in-game commands: only the current player (MirrorRoller.RollDice: controllerId == sender) ----
  const g = room.game;
  if (room.phase !== 'game' || !g || g.over) return;
  if (Game.current(g).id !== me.id) return err(c, 'notyourturn');
  const prev = turnKey(g);
  let ok = false;
  if (msg.t === 'roll') ok = Game.roll(g, rng);
  else if (msg.t === 'hold') ok = Game.toggleHold(g, msg.i);
  else if (msg.t === 'release') ok = Game.setHeld(g, [false, false, false, false, false]);
  else if (msg.t === 'score') ok = Game.score(g, msg.index);
  if (ok) afterAction(room, prev);
}

// ---------------- websocket ----------------
const wss = new WebSocketServer({ server, maxPayload: 8192 });
wss.on('connection', ws => {
  const c = { ws, id: newId(), token: newToken(), name: '', friendCode: null, room: null, alive: true };
  clients.add(c);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', data => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    try { handle(c, msg); } catch (e) { console.error('handler error', e); }
  });
  ws.on('close', () => { clients.delete(c); leaveRoom(c, false); });
});
// drop dead connections (closed laptop lids, Wi-Fi changes)
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false; c.ws.ping();
  }
}, 15000).unref();

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Yacht 서버 실행 중 (포트 ${PORT})`);
    console.log(`  이 PC:      http://localhost:${PORT}`);
    for (const ip of lanAddresses()) console.log(`  같은 네트워크: http://${ip}:${PORT}`);
    console.log('종료: Ctrl+C');
  });
}
module.exports = { server, rooms, friendCodeOf };
