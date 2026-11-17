// Yacht game rules + AI, reconstructed from the IL of YachtPlayerScoreBoard / AIPlayer / LocalRoller.
// Pure logic (no DOM) so it runs in the browser and in Node (tests).
(function (root) {
  'use strict';

  // Category indices match allScoreButtons[] in the original (0..11).
  const CATEGORIES = [
    { id: 0, key: 'ones', ko: '1 (에이스)' },
    { id: 1, key: 'twos', ko: '2 (듀스)' },
    { id: 2, key: 'threes', ko: '3 (트레이)' },
    { id: 3, key: 'fours', ko: '4 (포)' },
    { id: 4, key: 'fives', ko: '5 (파이브)' },
    { id: 5, key: 'sixes', ko: '6 (식스)' },
    { id: 6, key: 'choice', ko: '초이스' },
    { id: 7, key: 'fourKind', ko: '포 카인드' },
    { id: 8, key: 'fullHouse', ko: '풀 하우스' },
    { id: 9, key: 'smallStraight', ko: '스몰 스트레이트' },
    { id: 10, key: 'largeStraight', ko: '라지 스트레이트' },
    { id: 11, key: 'yacht', ko: '요트' },
  ];
  const ROUNDS = 12;          // "{0}/12", LocalRoller.ConfirmScore: Round > 12 -> end
  const ROLLS_PER_TURN = 3;   // LocalRoller.ResetRoller: set_RemainRollTime(3)
  const BONUS_THRESHOLD = 63; // CalculateGroundTotal
  const BONUS = 35;
  // specialIndex -> banner (YachtPlayerScoreBoard..cctor PanelNameMap)
  const SPECIALS = ['4 OF A KIND', 'FULL HOUSE', 'SM STRAIGHT', 'LG STRAIGHT', 'YACHT!'];

  // Enumerable.GroupBy keeps first-occurrence order; the original relies on that order.
  function groupBy(dice) {
    const order = [], counts = new Map();
    for (const d of dice) {
      if (!counts.has(d)) { counts.set(d, 0); order.push(d); }
      counts.set(d, counts.get(d) + 1);
    }
    return order.map(k => ({ key: k, count: counts.get(k) }));
  }
  const sum = a => a.reduce((s, x) => s + x, 0);
  const hasAll = (dice, vals) => vals.every(v => dice.includes(v));

  /**
   * Equivalent of YachtPlayerScoreBoard.CalculateScore(int[] dice).
   * confirmed: boolean[12]. Returns:
   *   scores[12]    preview score per category (null when already confirmed)
   *   prePoints[12] AI heuristic "AllScorePrePoints"
   *   noMoveDices   { index: faces[] } dice the AI wants to keep for that target
   *   specialIndex  -1 | 0..4 (4K, FH, SS, LS, Yacht)
   */
  function evaluate(dice, confirmed) {
    const scores = new Array(12).fill(null);
    const prePoints = new Array(12).fill(0);
    const noMoveDices = {};
    let specialIndex = -1;
    const groups = groupBy(dice);
    const total = sum(dice);

    // NumberScore: index 0..5 -> sum of dice equal to (i+1)
    for (let i = 0; i < 6; i++) {
      if (confirmed[i]) continue;
      const s = sum(dice.filter(d => d === i + 1));
      scores[i] = s;
      prePoints[i] = s;
    }

    // ChanceRes: sum of all dice; AI prepoint = (int)(sum * 0.2)
    if (!confirmed[6]) {
      scores[6] = total;
      prePoints[6] = Math.trunc(total * 0.2);
    }

    // FourSameRes: a group of >=4 -> sum of ALL dice; otherwise 0
    if (!confirmed[7]) {
      let bestCount = 0, bestKey = 0, hit = false;
      for (const g of groups) {
        if (g.count >= 4) { scores[7] = total; specialIndex = 0; hit = true; break; }
        if (g.count > bestCount) { bestCount = g.count; bestKey = g.key; }
        else if (g.count === bestCount && g.key > bestKey) { bestKey = g.key; }
      }
      if (!hit) {
        prePoints[7] = Math.trunc(bestCount * bestKey * 2 * bestCount / 3);
        noMoveDices[7] = [bestKey];
        scores[7] = 0;
      }
    }

    // FullHouseRes: every group must be size 3 or 2 -> fixed 25 (5-of-a-kind is NOT a full house)
    if (!confirmed[8]) {
      let ok = true;
      for (const g of groups) {
        if (g.count !== 3 && g.count !== 2) { ok = false; break; }
        if (g.count === 3) { prePoints[8] = 20; noMoveDices[8] = [g.key]; }
      }
      if (ok) { scores[8] = 25; specialIndex = 1; } else scores[8] = 0;
    }

    // SmStraightRes: 1-2-3-4 / 2-3-4-5 / 3-4-5-6 -> 30
    if (!confirmed[9]) {
      let hit = false;
      for (let s = 1; s < 4; s++) {
        if (hasAll(dice, [s, s + 1, s + 2, s + 3])) { scores[9] = 30; specialIndex = 2; hit = true; break; }
      }
      if (!hit) {
        for (let s = 1; s < 4; s++) {
          if (hasAll(dice, [s, s + 1, s + 2])) { prePoints[9] = 11; noMoveDices[9] = [s, s + 1, s + 2]; break; }
        }
        scores[9] = 0;
      }
    }

    // LgStraightRes: five distinct faces without both 1 and 6 (1-5 or 2-6) -> 40
    if (!confirmed[10]) {
      for (let s = 1; s < 4; s++) {
        if (hasAll(dice, [s, s + 1, s + 2])) { prePoints[10] = 10; noMoveDices[10] = [s, s + 1, s + 2]; break; }
      }
      for (let s = 1; s < 4; s++) {
        if (hasAll(dice, [s, s + 1, s + 2, s + 3])) { prePoints[10] = 30; noMoveDices[10] = [s, s + 1, s + 2, s + 3]; break; }
      }
      if (groups.some(g => g.count > 1)) scores[10] = 0;
      else if (!(dice.includes(1) && dice.includes(6))) { scores[10] = 40; specialIndex = 3; }
      else scores[10] = 0;
    }

    // Yacht: all five equal -> 50; AI prepoint = (count>2 ? 3 : 2) ^ count
    if (!confirmed[11]) {
      let maxCount = 0, maxKey = 0;
      for (const g of groups) if (g.count > maxCount) { maxCount = g.count; maxKey = g.key; }
      noMoveDices[11] = [maxKey];
      prePoints[11] = Math.trunc(Math.pow(maxCount > 2 ? 3 : 2, maxCount));
      if (dice.every(d => d === dice[0])) { scores[11] = 50; specialIndex = 4; } else scores[11] = 0;
    }

    return { scores, prePoints, noMoveDices, specialIndex };
  }

  /** CalculateGroundTotal: upper subtotal, bonus (+35 at >=63), grand total. */
  function totals(sheet) {
    let upper = 0, grand = 0;
    sheet.forEach((v, i) => {
      if (v == null) return;
      if (i < 6) upper += v;
      grand += v;
    });
    const bonus = upper >= BONUS_THRESHOLD ? BONUS : 0;
    return { upper, bonus, grand: grand + bonus };
  }

  // ---------------- AI (AIPlayer + <StartSelectDices>d__18) ----------------
  // Final-roll weights for categories, verbatim from the IL.
  const LEFTOVER_WEIGHTS = [0.1, 0.09, 0.08, 0.07, 0.02, 0.01, 0.01, 0.05, 0.04, 0.02, 0.03, 0.03];
  // qian6Add / qian6Mul are Unity-serialized (set in the prefab inspector), not in the IL.
  // These defaults are a design choice: weight = count * face value.
  const DEFAULT_QIAN6_ADD = [0, 0, 0, 0, 0, 0];
  const DEFAULT_QIAN6_MUL = [1, 2, 3, 4, 5, 6];
  const IMMEDIATE_SPECIALS = [1, 3, 4]; // static int[3] {1,3,4}: FH, LS, Yacht -> score at once

  /**
   * One AI decision after a roll.
   * dice: number[5], held: boolean[5], confirmed: boolean[12], rollsLeft: number
   * Returns { action: 'score', index } or { action: 'reroll', held: boolean[5] }.
   */
  function aiDecide(dice, held, confirmed, rollsLeft, opts = {}) {
    const add = opts.qian6Add || DEFAULT_QIAN6_ADD;
    const mul = opts.qian6Mul || DEFAULT_QIAN6_MUL;
    const ev = evaluate(dice, confirmed);
    const s = ev.specialIndex;

    if (IMMEDIATE_SPECIALS.includes(s)) return { action: 'score', index: s + 7 };
    if (rollsLeft > 0 && s === 2 && confirmed[10]) return { action: 'score', index: 9 };

    if (rollsLeft === 0) {
      if (s === 2) return { action: 'score', index: 9 };
      const all = new Array(12).fill(0);
      if (s === 0) all[7] = ev.scores[7] * 0.47;
      const counts = [0, 0, 0, 0, 0, 0];
      dice.forEach(d => counts[d - 1]++);
      for (let i = 0; i < 6; i++) all[i] = (add[i] + counts[i] * mul[i]) * (confirmed[i] ? 0 : 1);
      all[6] = confirmed[6] ? 0 : ev.scores[6] * 0.23;
      for (let i = 0; i < 12; i++) all[i] += LEFTOVER_WEIGHTS[i] * (confirmed[i] ? 0 : 1);
      let best = -1, bestI = 0;
      for (let i = 0; i < 12; i++) if (all[i] > best) { best = all[i]; bestI = i; }
      return { action: 'score', index: bestI };
    }

    // Rolls remain: chase the target with the largest prePoint (ties -> later index, as in IL '>=')
    let maxPts = 0, maxIndex = 0;
    ev.prePoints.forEach((p, i) => { if (p >= maxPts) { maxPts = p; maxIndex = i; } });
    let keep = [];
    if (maxIndex > 6) { if (ev.noMoveDices[maxIndex]) keep = ev.noMoveDices[maxIndex].slice(); }
    else if (maxIndex < 6) keep = [maxIndex + 1];

    const same = keep.length ? dice.filter(d => d === keep[0]).length : 0;
    if (same < 5) {
      if (maxIndex === 6) return { action: 'reroll', held: held.slice() };
      return { action: 'reroll', held: selectHeld(dice, keep, maxIndex) };
    }
    if (maxPts === 0) return { action: 'reroll', held: held.slice() };
    return { action: 'score', index: maxIndex };
  }

  /** StartMoveDices: straights keep one die per wanted face; others keep every matching die. */
  function selectHeld(dice, keep, index) {
    if (index === 9 || index === 10) {
      const taken = new Set();
      return dice.map(d => {
        if (keep.includes(d) && !taken.has(d)) { taken.add(d); return true; }
        return false;
      });
    }
    return dice.map(d => keep.includes(d));
  }

  const api = { CATEGORIES, ROUNDS, ROLLS_PER_TURN, BONUS_THRESHOLD, BONUS, SPECIALS,
    evaluate, totals, aiDecide, selectHeld };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YachtCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
