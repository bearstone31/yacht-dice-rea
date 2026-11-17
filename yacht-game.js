// Turn/round state machine shared by local play (browser) and the online server (Node).
// Mirrors YachtSingleSceneManager / YachtNetworkSceneManager.ChangeCurrentPlayer + MirrorRoller.
(function (root) {
  'use strict';
  const Y = (typeof module !== 'undefined' && module.exports) ? require('./yacht-core.js') : root.YachtCore;

  /** players: [{ id?, name, ai? }] */
  function createGame(players) {
    return {
      players: players.map((p, i) => ({
        id: p.id != null ? p.id : String(i), name: p.name, ai: !!p.ai,
        online: true, sheet: new Array(12).fill(null),
      })),
      cur: 0, round: 1,
      dice: [0, 0, 0, 0, 0], held: [false, false, false, false, false],
      rollsLeft: Y.ROLLS_PER_TURN, rollId: 0,
      special: -1, lastScore: null, over: false,
    };
  }

  const hasRolled = g => g.rollsLeft < Y.ROLLS_PER_TURN;
  const current = g => g.players[g.cur];
  const confirmedOf = p => p.sheet.map(v => v != null);

  function roll(g, rng = Math.random) {
    if (g.over || g.rollsLeft <= 0) return false;
    g.dice = g.dice.map((d, i) => g.held[i] ? d : 1 + Math.floor(rng() * 6));
    g.rollsLeft--;
    g.rollId++;
    g.special = Y.evaluate(g.dice, confirmedOf(current(g))).specialIndex;
    return true;
  }

  function toggleHold(g, i) {
    if (g.over || !hasRolled(g) || g.rollsLeft === 0) return false;
    if (!Number.isInteger(i) || i < 0 || i > 4) return false;
    g.held[i] = !g.held[i];
    return true;
  }

  function setHeld(g, held) {
    if (g.over || !hasRolled(g) || g.rollsLeft === 0) return false;
    g.held = held.map(Boolean).slice(0, 5);
    return true;
  }

  function score(g, idx) {
    const p = current(g);
    if (g.over || !hasRolled(g) || !Number.isInteger(idx) || idx < 0 || idx > 11 || p.sheet[idx] != null) return false;
    const val = Y.evaluate(g.dice, confirmedOf(p)).scores[idx];
    p.sheet[idx] = val;
    g.lastScore = { player: g.cur, index: idx, value: val };
    advance(g);
    return true;
  }

  /** MirrorRoller.AutoScore: on timeout / disconnect, fill the first empty category. */
  function autoScore(g, rng) {
    if (g.over) return false;
    if (!hasRolled(g)) roll(g, rng);
    const idx = current(g).sheet.findIndex(v => v == null);
    return idx >= 0 && score(g, idx);
  }

  function onlineCount(g) { return g.players.filter(p => p.online).length; }

  /** Next player; round++ when the order wraps; end after round 12. Offline players are skipped. */
  function advance(g) {
    const n = g.players.length;
    for (let step = 0; step < n; step++) {
      g.cur = (g.cur + 1) % n;
      if (g.cur === 0) g.round++;
      if (g.round > Y.ROUNDS) return finish(g);
      if (g.players[g.cur].online) break;
    }
    g.dice = [0, 0, 0, 0, 0];
    g.held = [false, false, false, false, false];
    g.rollsLeft = Y.ROLLS_PER_TURN;
    g.special = -1;
  }

  function finish(g) {
    g.over = true;
    g.round = Y.ROUNDS;
  }

  /** Mark a player offline. Ends the game when fewer than two remain (original: Members==1 -> End). */
  function setOnline(g, id, online) {
    const p = g.players.find(q => q.id === id);
    if (!p) return;
    p.online = online;
    if (!g.over && g.players.length > 1 && onlineCount(g) < 2) finish(g);
  }

  function ranking(g) {
    return g.players
      .map((p, i) => ({ i, name: p.name, online: p.online, total: Y.totals(p.sheet).grand }))
      .sort((a, b) => b.total - a.total);
  }

  const api = { createGame, roll, toggleHold, setHeld, score, autoScore, advance, setOnline,
    ranking, hasRolled, current, confirmedOf, onlineCount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YachtGame = api;
})(typeof window !== 'undefined' ? window : globalThis);
