(() => {
  'use strict';
  const Y = window.YachtCore, Game = window.YachtGame, I = window.YachtI18n, S = window.YachtSound;
  const { Settings, Stats, Friends, userKey } = window.YachtPrefs;
  const $ = id => document.getElementById(id);
  const t = (k, v) => I.t(k, v);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  };
  const PIPS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  const EMOJI = ['👍', '😂', '😮', '😭', '🔥', '🙏'];
  const catName = i => t('cat' + i);

  // ======================================================================
  // Settings application (UISetting)
  // ======================================================================
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const c = [n >> 16, (n >> 8) & 255, n & 255].map(x => Math.max(0, Math.min(255, Math.round(x * f))));
    return '#' + c.map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function applySettings() {
    const d = Settings.data, rootEl = document.documentElement;
    I.setLang(d.lang);
    if (d.theme === 'system') rootEl.removeAttribute('data-theme'); else rootEl.setAttribute('data-theme', d.theme);
    document.body.classList.toggle('reduce-motion', d.reduceMotion);
    rootEl.style.setProperty('--felt', d.colors.table);
    rootEl.style.setProperty('--felt2', shade(d.colors.table, 0.78));
    rootEl.style.setProperty('--die', d.colors.dice);
    rootEl.style.setProperty('--pip', d.colors.pip);
    rootEl.style.setProperty('--pip-red', d.colors.pipRed);
    const { brightness, saturation, contrast } = d.display;
    $('app').style.filter = (brightness === 100 && saturation === 100 && contrast === 100) ? ''
      : `brightness(${brightness}%) saturate(${saturation}%) contrast(${contrast}%)`;
    S.setVolumes(d.vol, d.mute);
    $('hint').hidden = !d.tips;
    applyI18n();
  }
  function applyI18n() {
    document.documentElement.lang = I.lang;
    document.title = t('title');
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
    $('rollBtn').textContent = `${t('roll')} (${keyLabel(Settings.data.keys.roll)})`;
    $('releaseBtn').textContent = `${t('releaseAll')} (${keyLabel(Settings.data.keys.release)})`;
    renderSeats();
    if (G) render(); else idleView();
    if (O.room && O.room.phase === 'lobby') renderLobby(O.room);
    if (lastRooms) renderRoomList(lastRooms);
    if ($('friendsModal').classList.contains('show')) renderFriends();
    if ($('statsModal').classList.contains('show')) renderStats();
    renderHelp(); renderKeyRows();
  }

  // ======================================================================
  // Controller: "local" runs the engine here; "online" mirrors server state.
  // ======================================================================
  let mode = null;   // 'local' | 'online' | null
  let G = null;      // current game state
  let lastRollId = -1, lastScoreKey = '', lastCur = -1, lastHeld = '', lastTick = -1;
  let primed = false; // false until the first render of a game (no sounds for state we just joined into)
  let localGameId = 0;

  // ---------------- local ----------------
  const L = { speed: 550, timers: [] };
  function localStart() {
    const seats = readSeats();
    if (!seats.length) return;
    L.speed = +$('speedIn').value;
    Settings.data.aiSpeed = L.speed; Settings.save();
    clearLocalTimers();
    mode = 'local';
    G = Game.createGame(seats);
    localGameId = Date.now();
    enterGame();
    localTick();
  }
  function clearLocalTimers() { L.timers.forEach(clearTimeout); L.timers = []; }
  const later = (fn, ms) => L.timers.push(setTimeout(fn, ms));
  function localTick() {
    render();
    if (G.over) return onGameOver();
    if (Game.current(G).ai) later(aiStep, L.speed);
  }
  function aiStep() {
    if (mode !== 'local' || G.over || !Game.current(G).ai) return;
    if (!Game.hasRolled(G)) { Game.roll(G); render(); return later(aiStep, L.speed + 250); }
    const p = Game.current(G);
    const d = Y.aiDecide(G.dice, G.held, Game.confirmedOf(p), G.rollsLeft);
    if (d.action === 'score') return later(() => { Game.score(G, d.index); localTick(); }, L.speed);
    Game.setHeld(G, d.held); render();
    later(() => { Game.roll(G); render(); later(aiStep, L.speed + 250); }, L.speed);
  }
  const local = {
    canAct: () => G && !G.over && !Game.current(G).ai,
    roll() { if (local.canAct() && Game.roll(G)) render(); },
    hold(i) { if (local.canAct() && Game.toggleHold(G, i)) render(); },
    release() { if (local.canAct() && Game.setHeld(G, [false, false, false, false, false])) render(); },
    score(i) { if (local.canAct() && Game.score(G, i)) localTick(); },
  };

  // ---------------- online ----------------
  const O = { ws: null, me: null, token: null, server: '', name: '', room: null, timerEnd: null, retry: 0,
    manualClose: false, friendCode: null, presence: {}, users: [], invites: [] };
  let lastRooms = null;
  function wsUrl(addr) {
    addr = addr.trim().replace(/\/+$/, '');
    if (/^wss?:\/\//i.test(addr)) return addr;
    if (/^https?:\/\//i.test(addr)) return addr.replace(/^http/i, 'ws');
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + addr;
  }
  function connect() {
    const addr = $('serverIn').value.trim();
    const name = $('onlineName').value.trim();
    if (!addr) return showErr(t('err_noaddr'));
    O.server = addr; O.name = name || t('player') + Math.floor(Math.random() * 90 + 10);
    ss.set('yacht.server', addr);
    try { localStorage.setItem('yacht.name', O.name); } catch {}
    O.token = ss.get('yacht.token:' + addr);
    O.manualClose = false;
    openSocket();
  }
  function openSocket() {
    let ws;
    try { ws = new WebSocket(wsUrl(O.server)); } catch { return showErr(t('err_badaddr')); }
    O.ws = ws;
    $('connectBtn').disabled = true; showErr('');
    ws.onopen = () => { O.retry = 0; sendMsg({ t: 'hello', name: O.name, token: O.token, userKey: userKey() }); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } onServer(m); };
    ws.onclose = () => {
      $('connectBtn').disabled = false;
      if (O.ws !== ws) return;
      O.ws = null;
      if (O.manualClose) return;
      if (O.me && O.retry < 10) {
        O.retry++;
        showErr(t('reconnecting', { n: O.retry }));
        setTimeout(() => { if (!O.manualClose && !O.ws) openSocket(); }, 1500);
      } else {
        showErr(O.me ? t('err_lost') : t('err_cannotconnect'));
        resetOnline();
      }
    };
  }
  function sendMsg(m) { if (O.ws && O.ws.readyState === 1) O.ws.send(JSON.stringify(m)); }
  function disconnect() { O.manualClose = true; if (O.ws) O.ws.close(); resetOnline(); }
  function resetOnline() {
    O.ws = null; O.me = null; O.room = null; O.timerEnd = null; O.friendCode = null; O.invites = [];
    renderInvites();
    if (mode === 'online') { mode = null; G = null; leaveGameView(); }
    showOnlinePane();
    if ($('friendsModal').classList.contains('show')) renderFriends();
  }
  function onServer(m) {
    switch (m.t) {
      case 'welcome':
        O.me = m.id; O.token = m.token; O.friendCode = m.friendCode;
        ss.set('yacht.token:' + O.server, m.token);
        O.name = m.name;
        $('connInfo').textContent = t('connectedAs', { name: m.name, server: O.server });
        showErr(m.rejoined ? t('rejoined') : '');
        if (!m.rejoined && O.room) {
          O.room = null;
          if (mode === 'online') { mode = null; G = null; leaveGameView(); }
        }
        showOnlinePane();
        if ($('friendsModal').classList.contains('show')) { renderFriends(); refreshPresence(); }
        break;
      case 'rooms': lastRooms = m.rooms; renderRoomList(m.rooms); break;
      case 'room': onRoom(m.room); break;
      case 'error': showErr(t('err_' + m.code)); frErr(t('err_' + m.code)); break;
      case 'emoji': floatEmoji(m.i, m.from); break;
      case 'presence':
        for (const p of m.list) O.presence[p.code] = p;
        for (const p of m.list) if (p.name) { const f = Friends.list.find(x => x.code === p.code); if (f && !f.name) Friends.rename(p.code, p.name); }
        if ($('friendsModal').classList.contains('show')) renderFriendList();
        break;
      case 'users': O.users = m.list; renderUsers(); break;
      case 'invite': onInvite(m); break;
      case 'invited': toast(t('inviteSent'), 2500); break;
    }
  }
  function onRoom(room) {
    const wasLobby = !O.room || O.room.phase === 'lobby';
    O.room = room;
    O.timerEnd = room.remainingMs != null ? performance.now() + room.remainingMs : null;
    if (room.phase === 'lobby') {
      if (mode === 'online') { mode = null; G = null; leaveGameView(); }
      $('over').classList.remove('show');
      showOnlinePane(); renderLobby(room);
      // drop invites for the room we are now in
      O.invites = O.invites.filter(i => i.room !== room.code); renderInvites();
      return;
    }
    const first = mode !== 'online';
    mode = 'online'; G = room.game;
    if (first) enterGame();
    if (wasLobby && room.phase === 'game') S.play('turn');
    render();
    if (room.phase === 'over') onGameOver();
  }
  const online = {
    canAct: () => G && !G.over && O.room && O.room.phase === 'game' && Game.current(G).id === O.me,
    roll() { if (online.canAct() && G.rollsLeft > 0) sendMsg({ t: 'roll' }); },
    hold(i) { if (online.canAct()) sendMsg({ t: 'hold', i }); },
    release() { if (online.canAct()) sendMsg({ t: 'release' }); },
    score(i) { if (online.canAct()) sendMsg({ t: 'score', index: i }); },
  };
  const ctl = () => mode === 'online' ? online : local;

  // ======================================================================
  // Setup panel (MainUIHomeManager: single / local / online / quick match)
  // ======================================================================
  let seats = [{ name: '', ai: false }, { name: '', ai: true }];
  function renderSeats() {
    let aiN = 0, hN = 0;
    $('seats').innerHTML = seats.map((s, i) => {
      const ph = s.ai ? `AI ${++aiN}` : (i === 0 ? t('me') : `${t('player')} ${++hN + (seats[0].ai ? 0 : 1)}`);
      return `
      <div class="seat">
        <span class="num">${i + 1}</span>
        <input data-i="${i}" data-k="name" value="${esc(s.name)}" placeholder="${esc(ph)}" maxlength="12" aria-label="${i + 1}">
        <select data-i="${i}" data-k="ai" aria-label="${i + 1}">
          <option value="0" ${s.ai ? '' : 'selected'}>${t('human')}</option><option value="1" ${s.ai ? 'selected' : ''}>AI</option>
        </select>
        <button class="x" data-del="${i}" ${seats.length <= 1 ? 'disabled' : ''} aria-label="${t('remove')} ${i + 1}">✕</button>
      </div>`;
    }).join('');
    $('addSeat').disabled = seats.length >= 4;
  }
  $('seats').addEventListener('input', e => {
    const i = +e.target.dataset.i, k = e.target.dataset.k;
    if (k === 'name') seats[i].name = e.target.value;
    if (k === 'ai') { seats[i].ai = e.target.value === '1'; renderSeats(); }
  });
  $('seats').addEventListener('change', e => { if (e.target.dataset.k === 'ai') { seats[+e.target.dataset.i].ai = e.target.value === '1'; renderSeats(); } });
  $('seats').addEventListener('click', e => {
    const d = e.target.closest('[data-del]'); if (!d) return;
    seats.splice(+d.dataset.del, 1); renderSeats();
  });
  $('addSeat').onclick = () => { if (seats.length < 4) { seats.push({ name: '', ai: false }); renderSeats(); } };
  function readSeats() {
    const inputs = $('seats').querySelectorAll('input[data-k="name"]');
    return seats.map((s, i) => ({ name: (s.name || '').trim() || inputs[i].placeholder, ai: s.ai }));
  }
  $('startLocal').onclick = localStart;

  function setTab(isOnline) {
    $('tabLocal').classList.toggle('on', !isOnline); $('tabOnline').classList.toggle('on', isOnline);
    $('localPane').hidden = isOnline; $('onlinePane').hidden = !isOnline;
  }
  $('tabLocal').onclick = () => setTab(false);
  $('tabOnline').onclick = () => setTab(true);

  function showOnlinePane() {
    const connected = !!O.me, inRoom = connected && O.room && O.room.phase === 'lobby';
    $('connectBox').hidden = connected;
    $('browseBox').hidden = !connected || inRoom;
    $('lobbyBox').hidden = !inRoom;
  }
  function renderRoomList(list) {
    $('roomList').innerHTML = list.length ? list.map(r => `
      <li><span><b>${esc(r.name)}</b> <span class="muted">${esc(r.code)} · ${r.players}/${r.max} · ${r.timer ? r.timer + 's' : t('noLimit')}</span></span>
      <button class="btn small" data-code="${esc(r.code)}">${t('join')}</button></li>`).join('')
      : `<li class="empty">${t('noRooms')}</li>`;
  }
  $('roomList').onclick = e => { const b = e.target.closest('[data-code]'); if (b) sendMsg({ t: 'join', code: b.dataset.code }); };
  function renderLobby(r) {
    const me = r.members.find(m => m.id === O.me);
    const isHost = r.hostId === O.me;
    $('lobbyCode').textContent = r.code;
    $('lobbyName').textContent = r.name;
    $('memberList').innerHTML = r.members.map(m => `
      <li><span>${esc(m.name)}${m.id === O.me ? ` <span class="muted">(${t('me')})</span>` : ''}${m.friendCode && Friends.has(m.friendCode) ? ' 🤝' : ''}</span>
      <span>${m.id === r.hostId ? `<span class="tag host">${t('host')}</span>` : m.ready ? `<span class="tag ok">${t('ready')}</span>` : `<span class="tag">${t('waiting')}</span>`}</span></li>`).join('')
      + (r.members.length < 4 ? `<li class="empty">${t('seatsLeft', { n: 4 - r.members.length })}</li>` : '');
    $('lobbyTimer').value = String(r.settings.timer);
    $('lobbyTimer').disabled = !isHost;
    $('readyBtn').hidden = isHost;
    $('readyBtn').textContent = me && me.ready ? t('unready') : t('readyBtn');
    $('startOnline').hidden = !isHost;
    const notReady = r.members.filter(m => m.id !== r.hostId && !m.ready).length;
    $('startOnline').disabled = r.members.length < 2 || notReady > 0;
    $('lobbyHint').textContent = r.members.length < 2 ? t('lobbyNeedMore')
      : notReady ? t('lobbyNotReady', { n: notReady }) : isHost ? t('lobbyAllReady') : t('lobbyWaitHost');
  }
  $('connectBtn').onclick = connect;
  $('onlineName').onkeydown = e => { if (e.key === 'Enter') connect(); };
  $('disconnectBtn').onclick = disconnect;
  $('quickBtn').onclick = () => sendMsg({ t: 'quick' });
  $('createBtn').onclick = () => sendMsg({ t: 'create', name: $('roomName').value, timer: +$('createTimer').value });
  $('joinBtn').onclick = () => sendMsg({ t: 'join', code: $('codeIn').value });
  $('codeIn').onkeydown = e => { if (e.key === 'Enter') $('joinBtn').click(); };
  $('refreshBtn').onclick = () => sendMsg({ t: 'list' });
  $('leaveBtn').onclick = () => { sendMsg({ t: 'leave' }); O.room = null; showOnlinePane(); };
  $('inviteFromLobby').onclick = () => openModal('friendsModal');
  $('readyBtn').onclick = () => { const me = O.room.members.find(m => m.id === O.me); sendMsg({ t: 'ready', ready: !(me && me.ready) }); };
  $('lobbyTimer').onchange = () => sendMsg({ t: 'settings', timer: +$('lobbyTimer').value });
  $('startOnline').onclick = () => sendMsg({ t: 'start' });
  function showErr(x) { $('err').textContent = x || ''; }

  // ======================================================================
  // Game view
  // ======================================================================
  function enterGame() {
    lastRollId = -1; lastScoreKey = ''; lastCur = -1; lastHeld = ''; lastTick = -1; primed = false;
    $('setup').hidden = true; $('board').hidden = false; $('quitBtn').hidden = false; $('releaseBtn').hidden = false;
    $('emojis').hidden = mode !== 'online';
    $('over').classList.remove('show');
    $('log').innerHTML = '';
    S.bgm('yacht');
  }
  function idleView() {
    $('turn').textContent = t('setupTitle'); $('hint').textContent = t('hintSetup');
    $('round').textContent = t('roundN', { n: 0, total: Y.ROUNDS }); $('rolls').textContent = t('rollsLeft', { n: Y.ROLLS_PER_TURN });
  }
  function leaveGameView() {
    clearLocalTimers();
    $('setup').hidden = false; $('board').hidden = true; $('quitBtn').hidden = true; $('releaseBtn').hidden = true; $('emojis').hidden = true;
    $('over').classList.remove('show'); $('timer').hidden = true;
    $('dice').innerHTML = ''; $('rollBtn').disabled = true;
    idleView();
    S.bgm('main');
  }
  $('quitBtn').onclick = () => {
    if (mode === 'online') {
      if (!G.over && !confirm(t('confirmLeaveOnline'))) return;
      sendMsg({ t: 'leave' }); mode = null; G = null; O.room = null; leaveGameView(); showOnlinePane(); return;
    }
    if (G && !G.over && !confirm(t('confirmQuit'))) return;
    mode = null; G = null; leaveGameView();
  };

  const humanCount = () => G.players.filter(p => !p.ai).length;
  function render() {
    if (!G) return;
    const c = ctl(), p = Game.current(G), act = c.canAct();
    const rolled = Game.hasRolled(G);

    // effects + sounds
    const newRoll = G.rollId !== lastRollId && lastRollId !== -1 && rolled;
    if (G.rollId !== lastRollId) {
      if (newRoll) { S.play('roll'); if (G.special >= 0) { showBanner(Y.SPECIALS[G.special]); setTimeout(() => S.play('special'), 350); } }
      lastRollId = G.rollId;
    }
    const heldKey = G.held.join();
    if (heldKey !== lastHeld && rolled && !newRoll && lastHeld) S.play('hold');
    lastHeld = heldKey;
    const sk = G.lastScore ? JSON.stringify(G.lastScore) + G.round : '';
    if (sk && sk !== lastScoreKey) {
      const s = G.lastScore;
      log(t('logScore', { name: G.players[s.player].name, cat: catName(s.index), n: s.value }));
      if (primed) S.play(s.value ? 'score' : 'zero');
    }
    lastScoreKey = sk;
    const turnChanged = G.cur !== lastCur;
    const handoff = turnChanged && mode === 'local' && !p.ai && humanCount() > 1;
    if (turnChanged && lastCur !== -1 && !G.over && ((mode === 'online' && p.id === O.me) || handoff)) S.play('turn');
    lastCur = G.cur;

    const youTag = mode === 'online' && p.id === O.me ? ` (${t('me')})` : '';
    $('turn').textContent = G.over ? t('gameOver') : t('turnOf', { name: p.name + youTag });
    $('round').textContent = t('roundN', { n: Math.min(G.round, Y.ROUNDS), total: Y.ROUNDS });
    $('rolls').textContent = t('rollsLeft', { n: G.rollsLeft });
    $('rollBtn').disabled = !act || G.rollsLeft <= 0;
    $('releaseBtn').disabled = !act || !rolled || G.rollsLeft === 0 || !G.held.some(Boolean);
    $('hint').textContent = G.over ? ''
      : !act ? (mode === 'online' ? t('hintOtherPlaying', { name: p.name }) : t('hintAiThinking'))
      : handoff ? t('hintHandoff', { name: p.name })
      : !rolled ? t('hintRoll', { key: keyLabel(Settings.data.keys.roll) })
      : G.rollsLeft > 0 ? t('hintHoldOrScore')
      : t('hintScore');

    $('dice').innerHTML = G.dice.map((v, i) => {
      const pips = Array.from({ length: 9 }, (_, k) => `<span class="pip ${v && PIPS[v].includes(k) ? 'on' : ''}"></span>`).join('');
      const cls = ['die', G.held[i] ? 'held' : '', v ? '' : 'blank', newRoll && !G.held[i] ? 'rolling' : ''].join(' ');
      const dis = !act || !rolled || G.rollsLeft === 0 ? 'disabled' : '';
      return `<button class="${cls}" data-i="${i}" data-v="${v}" ${dis} aria-label="${t('die')} ${v || '-'}${G.held[i] ? ' ' + t('held') : ''}">${pips}</button>`;
    }).join('');

    const ev = rolled && act ? Y.evaluate(G.dice, Game.confirmedOf(p)) : null;
    const last = G.lastScore;
    const head = `<thead><tr><th>${t('category')}</th>${G.players.map((q, i) => {
      const cls = [i === G.cur && !G.over ? 'active' : '', q.online ? '' : 'off'].join(' ');
      const me = mode === 'online' && q.id === O.me ? ` (${t('me')})` : '';
      return `<th class="${cls}" title="${esc(q.name)}">${esc(q.name)}${me}${q.ai ? ' 🤖' : ''}</th>`;
    }).join('')}</tr></thead>`;
    const row = idx => `<tr><td>${catName(idx)}</td>${G.players.map((q, pi) => {
      const v = q.sheet[idx];
      if (v != null) return `<td class="cell ${last && last.player === pi && last.index === idx ? 'fresh' : ''}">${v}</td>`;
      if (pi === G.cur && ev) {
        const s = ev.scores[idx];
        return `<td class="cell preview ${s ? 'nz' : ''}" tabindex="0" data-score="${idx}">${s}</td>`;
      }
      return '<td class="cell"></td>';
    }).join('')}</tr>`;
    const tot = G.players.map(q => Y.totals(q.sheet));
    let body = '<tbody>';
    for (let i = 0; i < 6; i++) body += row(i);
    body += `<tr class="sum"><td>${t('bonusRow')}</td>${tot.map(x => `<td>${x.bonus ? '+35' : `${x.upper}/63`}</td>`).join('')}</tr>`;
    for (let i = 6; i < 12; i++) body += row(i);
    body += `<tr class="grand"><td>${t('total')}</td>${tot.map(x => `<td>${x.grand}</td>`).join('')}</tr></tbody>`;
    $('sheet').innerHTML = head + body;
    renderTimer();
    primed = true;
  }

  function renderTimer() {
    const el = $('timer');
    if (mode !== 'online' || !O.timerEnd || !G || G.over) { el.hidden = true; return; }
    const s = Math.max(0, Math.ceil((O.timerEnd - performance.now()) / 1000));
    el.hidden = false; el.textContent = `⏱ ${s}s`; el.classList.toggle('warn', s <= 10);
    // AudioManager.PlayTimerTickClip: tick during the last seconds of my turn
    if (s <= 5 && s > 0 && s !== lastTick && online.canAct()) S.play('tick');
    lastTick = s;
  }
  setInterval(renderTimer, 250);

  function scoreAt(i) {
    if (Settings.data.confirmZero && G && Game.hasRolled(G)) {
      const v = Y.evaluate(G.dice, Game.confirmedOf(Game.current(G))).scores[i];
      if (v === 0 && !confirm(t('confirmZeroQ', { cat: catName(i) }))) return;
    }
    ctl().score(i);
  }

  // ---------------- game over + stats (MySteamAchievement.StoreWin / StoreYacht / ...) ----------------
  function onGameOver() {
    const ranked = Game.ranking(G);
    $('overTitle').textContent = ranked.length > 1 ? t('winner', { name: ranked[0].name }) : t('finalScore', { n: ranked[0].total });
    $('rank').innerHTML = ranked.map(r => `<li><span>${esc(r.name)}${r.online ? '' : ` <span class="muted">(${t('left')})</span>`}</span><span>${t('pts', { n: r.total })}</span></li>`).join('');
    const isHost = mode === 'online' && O.room && O.room.hostId === O.me;
    $('againBtn').hidden = mode === 'online' && !isHost;
    $('overHint').textContent = mode === 'online' && !isHost ? t('waitHostAgain') : '';
    const wasShown = $('over').classList.contains('show');
    $('over').classList.add('show');
    if (wasShown) return;

    // whose stats? online: me. local: only when exactly one human plays (vs AI).
    let meIdx = -1, key = null, withFriend = false;
    if (mode === 'online') {
      meIdx = G.players.findIndex(p => p.id === O.me);
      key = `online:${O.server}:${O.room.code}:${O.room.gameNo}`;
      withFriend = O.room.members.some(m => m.id !== O.me && m.friendCode && Friends.has(m.friendCode));
    } else if (humanCount() === 1) {
      meIdx = G.players.findIndex(p => !p.ai);
      key = `local:${localGameId}`;
    }
    if (meIdx < 0) { S.play('win'); return; }
    const mine = Y.totals(G.players[meIdx].sheet).grand;
    const won = G.players.length > 1 ? ranked[0].total === mine : true;
    S.play(won ? 'win' : 'lose');
    const fresh = Stats.record(key, { score: mine, won, yachts: G.players[meIdx].sheet[11] === 50 ? 1 : 0, withFriend });
    fresh.forEach((id, i) => setTimeout(() => {
      S.play('achievement');
      toast(`🏆 ${t('achUnlocked')}: <b>${esc(t('ach_' + id))}</b>`, 5000);
    }, 800 + i * 900));
  }
  $('againBtn').onclick = () => {
    $('over').classList.remove('show');
    if (mode === 'online') return sendMsg({ t: 'again' });
    localStart();
  };
  $('closeOver').onclick = () => $('over').classList.remove('show');

  function showBanner(x) {
    const b = $('banner'); b.textContent = x; b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
    clearTimeout(showBanner.t); showBanner.t = setTimeout(() => { b.textContent = ''; }, 1600);
  }
  function log(x) { const d = document.createElement('div'); d.textContent = x; $('log').prepend(d); }

  $('emojis').innerHTML = EMOJI.map((e, i) => `<button data-e="${i}" aria-label="emoji ${e}">${e}</button>`).join('');
  $('emojis').onclick = e => { const b = e.target.closest('[data-e]'); if (b) sendMsg({ t: 'emoji', i: +b.dataset.e }); };
  function floatEmoji(i, from) {
    if (!EMOJI[i] || !G) return;
    const idx = G.players.findIndex(p => p.id === from);
    const th = $('sheet').querySelectorAll('thead th')[idx + 1];
    const r = th ? th.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0 };
    const el = document.createElement('div');
    el.className = 'float-emoji'; el.textContent = EMOJI[i];
    el.style.left = (r.left + r.width / 2 - 21) + 'px'; el.style.top = (r.top + 20) + 'px';
    document.body.appendChild(el); setTimeout(() => el.remove(), 1700);
  }

  // ======================================================================
  // Modals
  // ======================================================================
  function openModal(id) {
    $(id).classList.add('show');
    if (id === 'friendsModal') { renderFriends(); refreshPresence(); }
    if (id === 'statsModal') renderStats();
    if (id === 'helpModal') renderHelp();
    if (id === 'settingsModal') loadSettingsForm();
    const f = $(id).querySelector('.close'); if (f) f.focus();
  }
  function closeModal(el) { el.classList.remove('show'); stopRebind(); }
  document.querySelectorAll('.overlay').forEach(ov => {
    ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-close]')) closeModal(ov); });
  });
  $('btnSettings').onclick = () => openModal('settingsModal');
  $('btnFriends').onclick = () => openModal('friendsModal');
  $('btnStats').onclick = () => openModal('statsModal');
  $('btnHelp').onclick = () => openModal('helpModal');
  function bindTabs(tabsId, modalId, onSwitch) {
    $(tabsId).addEventListener('click', e => {
      const b = e.target.closest('[data-tab]'); if (!b) return;
      $(tabsId).querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
      $(modalId).querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.tab; });
      if (onSwitch) onSwitch(b.dataset.tab);
    });
  }

  // ---------------- settings (UISetting) ----------------
  bindTabs('setTabs', 'settingsModal');
  const RANGES = [
    ['volMaster', d => d.vol, 'master', ''], ['volMusic', d => d.vol, 'music', ''],
    ['volUi', d => d.vol, 'ui', ''], ['volSfx', d => d.vol, 'sfx', ''],
    ['dispBright', d => d.display, 'brightness', '%'], ['dispSat', d => d.display, 'saturation', '%'], ['dispContrast', d => d.display, 'contrast', '%'],
  ];
  const COLORS = [['colTable', 'table'], ['colDice', 'dice'], ['colPip', 'pip'], ['colPipRed', 'pipRed']];
  function loadSettingsForm() {
    const d = Settings.data;
    $('setLang').value = d.lang; $('setTheme').value = d.theme;
    $('setTips').checked = d.tips; $('setMotion').checked = d.reduceMotion; $('setConfirm').checked = d.confirmZero;
    $('setMute').checked = d.mute;
    for (const [id, get, k, unit] of RANGES) { $(id).value = get(d)[k]; $(id + 'V').textContent = get(d)[k] + unit; }
    for (const [id, k] of COLORS) $(id).value = d.colors[k];
    renderKeyRows();
  }
  for (const [id, get, k, unit] of RANGES) {
    $(id).addEventListener('input', () => {
      get(Settings.data)[k] = +$(id).value; $(id + 'V').textContent = $(id).value + unit;
      Settings.save();
    });
  }
  for (const [id, k] of COLORS) $(id).addEventListener('input', () => { Settings.data.colors[k] = $(id).value; Settings.save(); });
  $('setLang').onchange = () => { Settings.data.lang = $('setLang').value; Settings.save(); };
  $('setTheme').onchange = () => { Settings.data.theme = $('setTheme').value; Settings.save(); };
  $('setTips').onchange = () => { Settings.data.tips = $('setTips').checked; Settings.save(); };
  $('setMotion').onchange = () => { Settings.data.reduceMotion = $('setMotion').checked; Settings.save(); };
  $('setConfirm').onchange = () => { Settings.data.confirmZero = $('setConfirm').checked; Settings.save(); };
  $('setMute').onchange = () => { Settings.data.mute = $('setMute').checked; Settings.save(); };
  $('testSound').onclick = () => { S.unlock(); S.play('roll'); setTimeout(() => S.play('special'), 500); };
  $('resetColors').onclick = () => { Settings.data.colors = { ...Settings.DEFAULT_COLORS }; Settings.save(); loadSettingsForm(); };
  $('resetAll').onclick = () => { if (confirm(t('confirmResetSettings'))) { Settings.reset(); loadSettingsForm(); } };
  Settings.onChange(applySettings);

  // key bindings (KeyBindingManager / Key_RollDice, Key_Reselect ...)
  const KEY_ACTIONS = ['roll', 'release', 'hold1', 'hold2', 'hold3', 'hold4', 'hold5'];
  let rebinding = null;
  function keyLabel(code) {
    if (!code) return '-';
    if (code === 'Space') return 'Space';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad\d$/.test(code)) return 'Num ' + code.slice(6);
    if (/^Arrow/.test(code)) return { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }[code];
    return code;
  }
  function renderKeyRows() {
    $('keyRows').innerHTML = KEY_ACTIONS.map(a => `
      <div class="setrow two"><span>${t('key_' + a)}</span>
      <span class="row"><button class="keybtn ${rebinding === a ? 'wait' : ''}" data-key="${a}">${rebinding === a ? t('pressKey') : esc(keyLabel(Settings.data.keys[a]))}</button></span></div>`).join('')
      + `<div class="row"><button class="btn sec small" id="resetKeys">${t('resetKeys')}</button></div>`;
    $('resetKeys').onclick = () => { Settings.data.keys = { ...Settings.DEFAULT_KEYS }; stopRebind(); Settings.save(); };
  }
  $('keyRows').addEventListener('click', e => {
    const b = e.target.closest('[data-key]'); if (!b) return;
    rebinding = rebinding === b.dataset.key ? null : b.dataset.key; renderKeyRows();
  });
  function stopRebind() { if (rebinding) { rebinding = null; renderKeyRows(); } }
  function captureRebind(e) {
    if (!rebinding) return false;
    e.preventDefault(); e.stopPropagation();
    if (e.code !== 'Escape' && e.code) {
      const keys = Settings.data.keys;
      const other = KEY_ACTIONS.find(a => a !== rebinding && keys[a] === e.code);
      if (other) keys[other] = keys[rebinding]; // swap on conflict
      keys[rebinding] = e.code;
    }
    rebinding = null; Settings.save(); renderKeyRows();
    return true;
  }

  // ---------------- friends (MainUIFriendsManager) ----------------
  const FRIENDS_PER_PAGE = 8;
  let frPage = 0, frTab = 'list', presenceTimer = null;
  bindTabs('frTabs', 'friendsModal', tab => { frTab = tab; if (tab === 'users') sendMsg({ t: 'users' }); });
  function frErr(x) { $('frErr').textContent = x || ''; }
  function refreshPresence() {
    clearInterval(presenceTimer);
    if (!O.me) return;
    const ask = () => {
      if (!$('friendsModal').classList.contains('show') || !O.me) return clearInterval(presenceTimer);
      sendMsg({ t: 'presence', codes: Friends.list.map(f => f.code) });
      if (frTab === 'users') sendMsg({ t: 'users' });
    };
    ask(); presenceTimer = setInterval(ask, 4000);
  }
  function renderFriends() {
    const on = !!O.me;
    $('frOffline').hidden = on; $('frMine').hidden = !on;
    if (on) $('myCode').textContent = O.friendCode || '';
    frErr('');
    renderFriendList(); renderUsers();
  }
  const statusOf = f => (O.me && O.presence[f.code]) ? O.presence[f.code] : { status: 'offline' };
  function statusText(p) {
    if (p.status === 'lobby') return t('st_lobby', { room: p.roomName || p.room });
    if (p.status === 'game') return t('st_game');
    return t('st_' + p.status);
  }
  function renderFriendList() {
    const q = $('frSearch').value.trim().toLowerCase();
    const rank = { game: 0, lobby: 0, online: 0, offline: 1 };
    // SortFriendsData: friends who are online first
    const list = Friends.list
      .map(f => ({ ...f, p: statusOf(f), shown: f.name || (O.presence[f.code] && O.presence[f.code].name) || f.code }))
      .filter(f => !q || f.shown.toLowerCase().includes(q) || f.code.toLowerCase().includes(q))
      .sort((a, b) => rank[a.p.status] - rank[b.p.status] || a.shown.localeCompare(b.shown));
    const pages = Math.max(1, Math.ceil(list.length / FRIENDS_PER_PAGE));
    frPage = Math.min(frPage, pages - 1);
    $('frPage').textContent = `${frPage + 1}/${pages}`;
    $('frPrev').disabled = frPage === 0; $('frNext').disabled = frPage >= pages - 1;
    const inMyLobby = O.room && O.room.phase === 'lobby';
    const inGame = mode === 'online' && O.room && O.room.phase !== 'lobby';
    const rows = list.slice(frPage * FRIENDS_PER_PAGE, (frPage + 1) * FRIENDS_PER_PAGE).map(f => {
      const p = f.p;
      const canInvite = inMyLobby && p.status !== 'offline' && p.room !== O.room.code;
      const canJoin = O.me && !inGame && p.status === 'lobby' && p.joinable && (!O.room || p.room !== O.room.code);
      return `<li class="friend">
        <span class="grow"><span class="name">${esc(f.shown)}</span> <span class="muted mono">${esc(f.code)}</span><br>
        <span class="st st-${p.status}">● ${esc(statusText(p))}</span></span>
        <span class="row">
          <button class="btn tiny" data-invite="${esc(f.code)}" ${canInvite ? '' : 'hidden'}>${t('invite')}</button>
          <button class="btn tiny" data-joinroom="${esc(p.room || '')}" ${canJoin ? '' : 'hidden'}>${t('join')}</button>
          <button class="btn sec tiny" data-remove="${esc(f.code)}" aria-label="${t('remove')}">✕</button>
        </span></li>`;
    });
    $('frList').innerHTML = rows.join('') || `<li class="empty">${Friends.list.length ? t('noMatch') : t('noFriends')}</li>`;
  }
  function renderUsers() {
    if (!$('userList')) return;
    if (!O.me) { $('userList').innerHTML = `<li class="empty">${t('friendsNeedServer')}</li>`; return; }
    $('userList').innerHTML = O.users.map(u => `<li class="friend">
      <span class="grow"><span class="name">${esc(u.name)}</span> <span class="muted mono">${esc(u.code)}</span><br>
      <span class="st st-${u.status}">● ${esc(statusText(u))}</span></span>
      ${Friends.has(u.code) ? `<span class="tag ok">${t('isFriend')}</span>`
        : `<button class="btn tiny" data-adduser="${esc(u.code)}" data-name="${esc(u.name)}">${t('addFriend')}</button>`}</li>`).join('')
      || `<li class="empty">${t('noUsers')}</li>`;
  }
  $('frSearch').addEventListener('input', () => { frPage = 0; renderFriendList(); });
  $('frPrev').onclick = () => { frPage--; renderFriendList(); };
  $('frNext').onclick = () => { frPage++; renderFriendList(); };
  $('frAdd').onclick = () => {
    const code = $('frAddCode').value.toUpperCase().trim();
    if (code === O.friendCode) return frErr(t('err_self'));
    if (Friends.has(code)) return frErr(t('err_already'));
    if (!Friends.add(code, $('frAddName').value)) return frErr(t('err_badcode'));
    $('frAddCode').value = ''; $('frAddName').value = ''; frErr('');
    sendMsg({ t: 'presence', codes: [code] });
    renderFriendList();
  };
  $('frList').addEventListener('click', e => {
    const inv = e.target.closest('[data-invite]'), jn = e.target.closest('[data-joinroom]'), rm = e.target.closest('[data-remove]');
    if (inv) sendMsg({ t: 'invite', code: inv.dataset.invite });
    if (jn) { sendMsg({ t: 'join', code: jn.dataset.joinroom }); closeModal($('friendsModal')); setTab(true); }
    if (rm && confirm(t('confirmRemoveFriend'))) { Friends.remove(rm.dataset.remove); renderFriendList(); renderUsers(); }
  });
  $('userList').addEventListener('click', e => {
    const b = e.target.closest('[data-adduser]'); if (!b) return;
    Friends.add(b.dataset.adduser, b.dataset.name); renderUsers(); renderFriendList();
    sendMsg({ t: 'presence', codes: [b.dataset.adduser] });
  });
  $('copyCode').onclick = async () => {
    try { await navigator.clipboard.writeText(O.friendCode); toast(t('copied'), 1500); }
    catch { prompt(t('myFriendCode'), O.friendCode); }
  };

  // invites (Btn_Invite -> lobby invite)
  function onInvite(m) {
    if (O.invites.some(i => i.room === m.room && i.fromCode === m.fromCode)) return;
    O.invites.push(m);
    S.play('invite');
    renderInvites();
  }
  function renderInvites() {
    const dot = $('inviteDot');
    dot.hidden = !O.invites.length; dot.textContent = O.invites.length;
    $('toasts').querySelectorAll('[data-invite-card]').forEach(x => x.remove());
    O.invites.forEach((m, i) => {
      const fr = Friends.has(m.fromCode) ? ' 🤝' : '';
      const el = document.createElement('div');
      el.className = 'card'; el.dataset.inviteCard = i;
      el.innerHTML = `<div>${t('invitedBy', { name: `<b>${esc(m.from)}</b>${fr}`, room: `<b>${esc(m.roomName)}</b> (${esc(m.room)})` })}</div>
        <div class="row" style="margin-top:8px"><button class="btn small" data-accept>${t('join')}</button><button class="btn sec small" data-decline>${t('decline')}</button></div>`;
      el.querySelector('[data-accept]').onclick = () => {
        if (mode === 'online' && O.room && O.room.phase === 'game') return toast(t('err_ingame'), 2500);
        sendMsg({ t: 'join', code: m.room }); setTab(true);
        O.invites = O.invites.filter(x => x !== m); renderInvites();
      };
      el.querySelector('[data-decline]').onclick = () => { O.invites = O.invites.filter(x => x !== m); renderInvites(); };
      $('toasts').appendChild(el);
    });
  }
  function toast(html, ms) {
    const el = document.createElement('div');
    el.className = 'card'; el.innerHTML = html;
    $('toasts').prepend(el);
    setTimeout(() => el.remove(), ms || 3000);
  }

  // ---------------- stats (MainUIState) ----------------
  function renderStats() {
    const s = Stats.data;
    const rate = s.games ? Math.round(s.wins / s.games * 100) : 0;
    const avg = s.games ? Math.round(s.totalScore / s.games) : 0;
    const items = [['statGames', s.games], ['statWins', s.wins], ['statRate', rate + '%'], ['statBest', s.best],
      ['statAvg', avg], ['statYachts', s.yachts], ['statFriendGames', s.friendGames],
      ['statAch', `${Object.keys(s.unlocked).length}/${Stats.ACHIEVEMENTS.length}`]];
    $('statGrid').innerHTML = items.map(([k, v]) => `<div class="stat"><b>${v}</b><span class="muted">${t(k)}</span></div>`).join('');
    // ShowState: bars capped at 100
    $('winBar').style.width = Math.min(100, s.wins) + '%'; $('winBarV').textContent = `${Math.min(100, s.wins)}/100`;
    $('yachtBar').style.width = Math.min(100, s.yachts) + '%'; $('yachtBarV').textContent = `${Math.min(100, s.yachts)}/100`;
    $('achList').innerHTML = Stats.ACHIEVEMENTS.map(a => {
      const on = !!s.unlocked[a.id];
      return `<div class="ach ${on ? 'on' : ''}"><span class="ic">${a.icon}</span>
        <span class="grow"><span class="t">${esc(t('ach_' + a.id))}</span><br><span class="muted">${esc(t('achd_' + a.id))}</span></span>
        <span class="muted">${on ? new Date(s.unlocked[a.id]).toLocaleDateString(I.lang) : '🔒'}</span></div>`;
    }).join('');
  }
  $('resetStats').onclick = () => { if (confirm(t('confirmResetStats'))) { Stats.reset(); renderStats(); } };

  // ---------------- help ----------------
  function renderHelp() {
    const k = Settings.data.keys;
    const rules = [0, 6, 7, 8, 9, 10, 11].map(i => `<tr><td>${i === 0 ? t('upperCats') : catName(i)}</td><td>${t('rule' + i)}</td></tr>`).join('');
    $('helpBody').innerHTML = `
      <p>${t('helpIntro')}</p>
      <h3>${t('scoring')}</h3>
      <table>${rules}<tr><td>${t('bonusRow')}</td><td>${t('ruleBonus')}</td></tr></table>
      <h3>${t('controls')}</h3>
      <table>
        <tr><td><kbd>${esc(keyLabel(k.roll))}</kbd></td><td>${t('key_roll')}</td></tr>
        <tr><td><kbd>${esc(keyLabel(k.hold1))}</kbd>~<kbd>${esc(keyLabel(k.hold5))}</kbd> / ${t('click')}</td><td>${t('helpHold')}</td></tr>
        <tr><td><kbd>${esc(keyLabel(k.release))}</kbd></td><td>${t('key_release')}</td></tr>
        <tr><td>${t('click')}</td><td>${t('helpScore')}</td></tr>
      </table>
      <h3>${t('online')}</h3>
      <p>${t('helpOnline')}</p>`;
  }

  // ======================================================================
  // Input
  // ======================================================================
  $('rollBtn').onclick = () => ctl().roll();
  $('releaseBtn').onclick = () => ctl().release();
  $('dice').onclick = e => { const b = e.target.closest('.die'); if (b && !b.disabled) ctl().hold(+b.dataset.i); };
  $('sheet').onclick = e => { const c = e.target.closest('[data-score]'); if (c) scoreAt(+c.dataset.score); };
  $('sheet').onkeydown = e => {
    const c = e.target.closest('[data-score]');
    if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); scoreAt(+c.dataset.score); }
  };
  document.addEventListener('keydown', e => {
    if (captureRebind(e)) return;
    if (e.key === 'Escape') { const open = document.querySelector('.overlay.show'); if (open) return closeModal(open); }
    if (document.querySelector('.overlay.show')) return;
    const tg = e.target;
    if (!G || G.over || !ctl().canAct() || (tg && tg.matches && tg.matches('input,select,button,[data-score]'))) return;
    const k = Settings.data.keys;
    if (e.code === k.roll) { e.preventDefault(); ctl().roll(); return; }
    if (e.code === k.release) { e.preventDefault(); ctl().release(); return; }
    const n = ['hold1', 'hold2', 'hold3', 'hold4', 'hold5'].findIndex(a => k[a] === e.code);
    if (n >= 0 && Game.hasRolled(G) && G.rollsLeft > 0) { e.preventDefault(); ctl().hold(n); }
  }, true);
  // audio needs a user gesture; UI click sound for ordinary buttons (Interface mixer group)
  const unlock = () => { S.unlock(); S.bgm(G ? 'yacht' : 'main'); };
  document.addEventListener('pointerdown', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });
  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b && !b.classList.contains('die') && !b.disabled && b.id !== 'rollBtn') S.play('click');
  });

  // ======================================================================
  // Boot
  // ======================================================================
  $('speedIn').value = String(Settings.data.aiSpeed);
  $('serverIn').value = ss.get('yacht.server') || (location.protocol.startsWith('http') ? location.host : 'localhost:3000');
  try { $('onlineName').value = localStorage.getItem('yacht.name') || ''; } catch {}
  if (location.protocol.startsWith('http') && ss.get('yacht.token:' + $('serverIn').value)) setTab(true);
  applySettings();
  S.bgm('main');
})();
