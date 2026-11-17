// Integration test: real server + WebSocket clients play a full online game.
// node test-server.js
'use strict';
process.env.YACHT_SECOND_MS = '10'; // 30s turn timer -> 300ms
const WebSocket = require('ws');
const { server } = require('./server.js');

let fail = 0;
const ok = (name, cond, extra = '') => { if (!cond) fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' ' + extra}`); };

function client(url, name, token, userKey) {
  const ws = new WebSocket(url);
  const c = { ws, name, msgs: [], waiters: [], room: null, id: null, token: null, errors: [] };
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.t === 'room') c.room = m.room;
    if (m.t === 'welcome') { c.id = m.id; c.token = m.token; c.rejoined = !!m.rejoined; c.friendCode = m.friendCode; }
    if (m.t === 'error') c.errors.push(m.code);
    c.msgs.push(m);
    c.waiters = c.waiters.filter(w => !(w.pred(m) && (w.res(m), true)));
  });
  c.send = m => ws.send(JSON.stringify(m));
  c.wait = (pred, ms = 3000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${name}: timeout`)), ms);
    c.waiters.push({ pred, res: m => { clearTimeout(t); res(m); } });
  });
  c.open = new Promise(r => ws.on('open', () => { c.send({ t: 'hello', name, token, userKey }); r(); }));
  return c;
}
const roomWhere = (c, pred) => c.room && pred(c.room) ? Promise.resolve(c.room) : c.wait(m => m.t === 'room' && pred(m.room)).then(m => m.room);

server.listen(0, '127.0.0.1', async () => {
  const url = `ws://127.0.0.1:${server.address().port}`;
  try {
    const a = client(url, '앨리스'), b = client(url, '밥');
    await Promise.all([a.open, b.open]);
    await Promise.all([a.wait(m => m.t === 'welcome'), b.wait(m => m.t === 'welcome')]);

    a.send({ t: 'create', name: '테스트방', timer: 0 });
    const r0 = await roomWhere(a, r => r.members.length === 1);
    ok('room created with 4-char code', /^[A-Z0-9]{4}$/.test(r0.code));
    ok('creator is host', r0.hostId === a.id);

    b.send({ t: 'list' });
    const list = await b.wait(m => m.t === 'rooms' && m.rooms.length > 0);
    ok('room appears in lobby list', list.rooms.some(r => r.code === r0.code));

    b.send({ t: 'join', code: r0.code.toLowerCase() });
    await roomWhere(a, r => r.members.length === 2);

    a.send({ t: 'start' });
    await a.wait(m => m.t === 'error');
    ok('cannot start before everyone is ready', a.errors.includes('notready'));

    b.send({ t: 'ready', ready: true });
    await roomWhere(a, r => r.members.every(m => m.id === r.hostId || m.ready));
    b.send({ t: 'start' });
    await new Promise(r => setTimeout(r, 100));
    ok('non-host cannot start', a.room.phase === 'lobby');

    a.send({ t: 'start' });
    await roomWhere(b, r => r.phase === 'game');
    ok('game started for both', a.room && b.room.phase === 'game');

    // turn enforcement
    b.send({ t: 'roll' });
    await b.wait(m => m.t === 'error');
    ok('out-of-turn roll rejected', b.errors.includes('notyourturn'));

    // hold before rolling is ignored
    a.send({ t: 'hold', i: 0 });
    a.send({ t: 'roll' });
    let r = await roomWhere(a, x => x.game.rollsLeft === 2);
    ok('dice rolled by server (1..6)', r.game.dice.every(d => d >= 1 && d <= 6));
    ok('hold before roll ignored', r.game.held.every(h => !h));
    a.send({ t: 'hold', i: 2 });
    r = await roomWhere(a, x => x.game.held[2]);
    const keep = r.game.dice[2];
    a.send({ t: 'roll' });
    r = await roomWhere(a, x => x.game.rollsLeft === 1);
    ok('held die kept its value', r.game.dice[2] === keep);
    a.send({ t: 'score', index: 1.5 });
    a.send({ t: 'score', index: 99 });
    await new Promise(r2 => setTimeout(r2, 80));
    ok('invalid score index ignored', a.room.game.cur === 0);

    // play the rest: each player rolls once and takes the first empty category
    const byId = { [a.id]: a, [b.id]: b };
    for (let guard = 0; guard < 100; guard++) {
      const g = a.room.game;
      if (g.over) break;
      const p = byId[g.players[g.cur].id];
      const before = `${g.round}:${g.cur}`;
      if (g.rollsLeft === 3) { p.send({ t: 'roll' }); await roomWhere(p, x => x.game.rollsLeft < 3 || x.game.over); }
      const idx = p.room.game.players[p.room.game.cur].sheet.findIndex(v => v == null);
      p.send({ t: 'score', index: idx });
      await roomWhere(a, x => x.game.over || `${x.game.round}:${x.game.cur}` !== before);
    }
    const end = await roomWhere(b, x => x.phase === 'over');
    ok('game ends after 12 rounds', end.game.over && end.game.players.every(p => p.sheet.every(v => v != null)));

    // back to lobby, start again, then test disconnect + reconnect
    a.send({ t: 'again' });
    await roomWhere(b, x => x.phase === 'lobby');
    ok('host returns room to lobby', true);
    b.send({ t: 'ready', ready: true });
    await roomWhere(a, x => x.members.every(m => m.id === x.hostId || m.ready));
    a.send({ t: 'start' });
    await roomWhere(b, x => x.phase === 'game');

    a.send({ t: 'roll' }); await roomWhere(a, x => x.game.rollsLeft === 2);
    a.send({ t: 'score', index: 0 }); await roomWhere(b, x => x.game.cur === 1);

    // B (current player) drops -> server auto-scores B's turn (MirrorRoller.AutoScore)
    // but with only one player left online, the game ends (Members == 1 -> End)
    const bToken = b.token;
    b.ws.terminate();
    const afterDrop = await roomWhere(a, x => x.members.some(m => !m.online));
    ok('dropped player shown offline', afterDrop.members.find(m => m.name === '밥').online === false);
    ok('game ends when < 2 players online', afterDrop.phase === 'over');
    ok('no auto-score once the game has ended', afterDrop.game.players[1].sheet.every(v => v == null));

    // reconnection with the saved token restores the seat
    const b2 = client(url, '밥', bToken);
    await b2.open;
    await b2.wait(m => m.t === 'welcome');
    ok('reconnect with token restores seat', b2.rejoined && b2.id === b.id);
    await roomWhere(b2, x => !!x);
    ok('rejoined player receives room state', b2.room.code === r0.code);

    // full room / unknown code
    const c3 = client(url, 'C'), c4 = client(url, 'D'), c5 = client(url, 'E');
    await Promise.all([c3.open, c4.open, c5.open]);
    c3.send({ t: 'join', code: 'ZZZZ' });
    await c3.wait(m => m.t === 'error');
    ok('unknown room code rejected', c3.errors.includes('noroom'));
    c3.send({ t: 'create', timer: 30 });
    const r3 = await roomWhere(c3, x => x.members.length === 1);
    ok('timer setting stored', r3.settings.timer === 30);
    for (const c of [c4, c5]) { c.send({ t: 'join', code: r3.code }); await roomWhere(c3, x => x.members.some(m => m.name === c.name)); }
    const c6 = client(url, 'F'), c7 = client(url, 'G');
    await Promise.all([c6.open, c7.open]);
    c6.send({ t: 'join', code: r3.code }); await roomWhere(c3, x => x.members.length === 4);
    c7.send({ t: 'join', code: r3.code }); await c7.wait(m => m.t === 'error');
    ok('5th player rejected (max 4)', c7.errors.includes('full'));

    // host leaves in lobby -> host transfers
    c3.send({ t: 'leave' });
    const r4 = await roomWhere(c4, x => x.members.length === 3);
    ok('host transfers when host leaves lobby', r4.hostId !== c3.id && r4.members.some(m => m.id === r4.hostId));

    // turn timer (30s, scaled): nobody acts -> server auto-scores and moves on
    const host = [c4, c5, c6].find(c => c.id === r4.hostId);
    for (const c of [c4, c5, c6]) if (c !== host) c.send({ t: 'ready', ready: true });
    await roomWhere(host, x => x.members.every(m => m.id === x.hostId || m.ready));
    host.send({ t: 'start' });
    const g0 = await roomWhere(c5, x => x.phase === 'game');
    ok('timer deadline sent to clients', g0.remainingMs > 0 && g0.remainingMs <= 300);
    const g1 = await roomWhere(c5, x => x.game.cur === 1, 2000);
    ok('turn timer auto-scores the idle player', g1.game.players[0].sheet[0] != null);

    // 3 online players: current player drops -> auto-score, game continues
    const cur = [c4, c5, c6].find(c => c.id === g1.game.players[1].id);
    const watcher = [c4, c5, c6].find(c => c !== cur);
    cur.ws.terminate();
    const g2 = await roomWhere(watcher, x => x.game.cur === 2);
    ok('dropped current player auto-scored, game continues', g2.phase === 'game' && g2.game.players[1].sheet[0] != null);

    [a, b2, c3, c4, c5, c6, c7].forEach(c => c.ws.close());

    // ---- friends: codes, presence, users list, invite, join, quick match ----
    const KEY_P = 'a'.repeat(32), KEY_Q = 'b'.repeat(32);
    const p = client(url, '피터', null, KEY_P), q = client(url, '퀸', null, KEY_Q);
    await Promise.all([p.open, q.open]);
    await Promise.all([p.wait(m => m.t === 'welcome'), q.wait(m => m.t === 'welcome')]);
    const { friendCodeOf } = require('./server.js');
    ok('friend code is 6 chars and stable per user key', /^[A-Z2-9]{6}$/.test(p.friendCode) && p.friendCode === friendCodeOf(KEY_P));
    ok('different users get different codes', p.friendCode !== q.friendCode);

    p.send({ t: 'presence', codes: [q.friendCode, 'ZZZZZZ'] });
    let pr = await p.wait(m => m.t === 'presence');
    ok('presence: online friend', pr.list[0].status === 'online' && pr.list[0].name === '퀸');
    ok('presence: unknown code offline', pr.list[1].status === 'offline');

    p.send({ t: 'users' });
    const us = await p.wait(m => m.t === 'users');
    ok('users list includes others but not me', us.list.some(u => u.code === q.friendCode) && !us.list.some(u => u.code === p.friendCode));

    p.send({ t: 'invite', code: q.friendCode });
    await p.wait(m => m.t === 'error');
    ok('cannot invite outside a lobby', p.errors.includes('invite_noroom'));

    p.send({ t: 'create', name: '피터방', timer: 0 });
    const pr0 = await roomWhere(p, x => x.members.length === 1);
    ok('room view carries member friend codes', pr0.members[0].friendCode === p.friendCode);
    q.send({ t: 'presence', codes: [p.friendCode] });
    pr = await q.wait(m => m.t === 'presence');
    ok('presence: friend in lobby with joinable room', pr.list[0].status === 'lobby' && pr.list[0].room === pr0.code && pr.list[0].joinable);

    await new Promise(r2 => setTimeout(r2, 1600)); // invite rate limit
    p.send({ t: 'invite', code: q.friendCode });
    const inv = await q.wait(m => m.t === 'invite');
    ok('invite delivered with room code', inv.room === pr0.code && inv.from === '피터' && inv.fromCode === p.friendCode);
    q.send({ t: 'join', code: inv.room });
    await roomWhere(p, x => x.members.length === 2);
    ok('invitee joined via invite', true);

    q.send({ t: 'ready', ready: true });
    await roomWhere(p, x => x.members.every(m => m.id === x.hostId || m.ready));
    p.send({ t: 'start' });
    await roomWhere(q, x => x.phase === 'game');
    p.send({ t: 'presence', codes: [q.friendCode] });
    pr = await p.wait(m => m.t === 'presence');
    ok('presence: friend in game', pr.list[0].status === 'game');
    ok('gameNo increments per game', p.room.gameNo === 1);

    // release-all command (original Reselect)
    p.send({ t: 'roll' }); await roomWhere(p, x => x.game.rollsLeft === 2);
    p.send({ t: 'hold', i: 0 }); p.send({ t: 'hold', i: 3 });
    await roomWhere(p, x => x.game.held[0] && x.game.held[3]);
    p.send({ t: 'release' });
    const rel = await roomWhere(p, x => x.game.held.every(h => !h));
    ok('release clears all holds', rel.game.held.every(h => !h));

    // quick match: joins the open room if any, otherwise creates one
    const r1 = client(url, 'R1'), r2 = client(url, 'R2');
    await Promise.all([r1.open, r2.open]);
    await Promise.all([r1.wait(m => m.t === 'welcome'), r2.wait(m => m.t === 'welcome')]);
    r1.send({ t: 'quick' });
    const qr = await roomWhere(r1, x => x.members.length === 1);
    r2.send({ t: 'quick' });
    const qr2 = await roomWhere(r2, x => x.members.length === 2);
    ok('quick match creates then joins the same room', qr.code === qr2.code);

    [p, q, r1, r2].forEach(c => c.ws.close());
  } catch (e) {
    fail++; console.log('FAIL exception', e.message);
  }
  console.log(fail ? `\n${fail} failure(s)` : '\nall server tests passed');
  server.close(); process.exit(fail ? 1 : 0);
});
