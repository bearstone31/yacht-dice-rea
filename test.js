// node yacht/test.js
const Y = require('./yacht-core.js');
const none = new Array(12).fill(false);
let fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}
const sc = d => Y.evaluate(d, none).scores;

eq('upper sums', sc([1, 1, 3, 5, 6]).slice(0, 6), [2, 0, 3, 0, 5, 6]);
eq('choice', sc([1, 1, 3, 5, 6])[6], 16);
eq('4 of a kind = sum of all dice', sc([4, 4, 4, 4, 2])[7], 18);
eq('4 of a kind miss', sc([4, 4, 4, 2, 2])[7], 0);
eq('yacht counts as 4 of a kind', sc([6, 6, 6, 6, 6])[7], 30);
eq('full house = 25', sc([3, 3, 5, 5, 5])[8], 25);
eq('yacht is not full house', sc([2, 2, 2, 2, 2])[8], 0);
eq('small straight 30', sc([1, 2, 3, 4, 6])[9], 30);
eq('small straight 3-6', sc([3, 4, 5, 6, 6])[9], 30);
eq('small straight miss', sc([1, 2, 3, 5, 6])[9], 0);
eq('large straight 1-5', sc([5, 4, 3, 2, 1])[10], 40);
eq('large straight 2-6', sc([2, 3, 4, 5, 6])[10], 40);
eq('large straight with dup', sc([2, 3, 4, 5, 5])[10], 0);
eq('1,2,3,4,6 not large', sc([1, 2, 3, 4, 6])[10], 0);
eq('yacht 50', sc([5, 5, 5, 5, 5])[11], 50);
eq('special yacht', Y.evaluate([5, 5, 5, 5, 5], none).specialIndex, 4);
eq('bonus at 63', Y.totals([3, 6, 9, 12, 15, 18, 0, 0, 0, 0, 0, 0]), { upper: 63, bonus: 35, grand: 98 });
eq('no bonus at 62', Y.totals([2, 6, 9, 12, 15, 18, null, null, null, null, null, null]).bonus, 0);
eq('max score 345', Y.totals([5, 10, 15, 20, 25, 30, 30, 30, 25, 30, 40, 50]).grand, 345);
eq('AI takes full house immediately', Y.aiDecide([3, 3, 5, 5, 5], [0,0,0,0,0].map(Boolean), none, 2), { action: 'score', index: 8 });
eq('AI chases yacht with triple', Y.aiDecide([6, 6, 6, 1, 2], [0,0,0,0,0].map(Boolean), none, 2).held, [true, true, true, false, false]);

// Full AI self-play sanity: every game ends with all 12 categories filled.
for (let g = 0; g < 200; g++) {
  const sheet = new Array(12).fill(null);
  for (let r = 0; r < 12; r++) {
    let held = [false, false, false, false, false], dice = [1, 1, 1, 1, 1];
    for (let left = 2; left >= 0; left--) {
      dice = dice.map((d, i) => held[i] ? d : 1 + Math.floor(Math.random() * 6));
      const conf = sheet.map(v => v != null);
      const dec = Y.aiDecide(dice, held, conf, left);
      if (dec.action === 'score' || left === 0) {
        const idx = dec.action === 'score' ? dec.index : null;
        if (idx == null || sheet[idx] != null) { fail++; console.log('FAIL AI illegal pick', idx); break; }
        sheet[idx] = Y.evaluate(dice, conf).scores[idx];
        break;
      }
      held = dec.held;
    }
  }
  if (sheet.some(v => v == null)) { fail++; console.log('FAIL AI left empty category', sheet); break; }
}
// ---- game engine (yacht-game.js): turns, rounds, offline players, auto-score ----
const Game = require('./yacht-game.js');
{
  const g = Game.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]);
  eq('cannot score before rolling', Game.score(g, 0), false);
  Game.roll(g);
  eq('roll uses one of 3 rolls', g.rollsLeft, 2);
  Game.roll(g); Game.roll(g);
  eq('no 4th roll', Game.roll(g), false);
  eq('cannot hold after last roll', Game.toggleHold(g, 0), false);
  Game.score(g, 11);
  eq('turn passes to next player', g.cur, 1);
  eq('dice reset for next player', g.rollsLeft, 3);
  // B disconnects while it is B's turn -> auto-score first empty category, then skip B afterwards
  Game.setOnline(g, 'b', false);
  Game.autoScore(g);
  eq('auto-score fills first empty category', g.players[1].sheet[0] != null, true);
  eq('after auto-score it is C\'s turn', g.cur, 2);
  Game.roll(g); Game.score(g, 3);
  eq('offline B is skipped (back to A, round 2)', [g.cur, g.round], [0, 2]);
  Game.setOnline(g, 'c', false);
  eq('game ends when < 2 players online', g.over, true);

  const h = Game.createGame([{ name: 'X' }, { name: 'Y' }]);
  for (let t = 0; t < 24; t++) { Game.roll(h); Game.score(h, h.players[h.cur].sheet.findIndex(v => v == null)); }
  eq('2-player game ends after 12 rounds', [h.over, h.players.every(p => p.sheet.every(v => v != null))], [true, true]);
}

console.log(fail ? `\n${fail} failure(s)` : '\nall tests passed');
process.exit(fail ? 1 : 0);
