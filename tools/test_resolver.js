// Standalone resolver test (no test framework -- run with `node tools/test_resolver.js`).
// Validates against the Regency fixture in TOURNAMENT_DATA_SPEC.md section 10, using the
// real live-sheet data for 16U_GIRLS_D1 (tools/tmp/16u_d1_raw.json).
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', 'src', 'resolver.js'));

const games = JSON.parse(fs.readFileSync(path.join(__dirname, 'tmp', '16u_d1_day1_fixture.json'), 'utf8'));

let failures = 0;
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    failures++;
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`PASS ${label}: ${JSON.stringify(actual)}`);
  }
}

const result = global.Resolver.resolveDivision(games);

// Group B standings: Mission 2-0 (1stB), Regency 1-1 beating Lamorinda A h2h (2ndB), Lamorinda A 0-2 (3rdB)
const groupB = result.standings['B'];
assertEqual(groupB.ranked[0].name, 'MISSION', 'Group B 1st');
assertEqual(groupB.ranked[1].name, 'REGENCY', 'Group B 2nd');
assertEqual(groupB.ranked[2].name, 'LAMORINDA A', 'Group B 3rd');

// Group D standings (per spec: Patriot 1st, Shaq 2nd, Legacy 3rd)
const groupD = result.standings['D'];
assertEqual(groupD.ranked[0].name, 'PATRIOT', 'Group D 1st');

// Playin3 (16GD133): white = 2ndB = Regency, dark = W#Cross1 (not yet final -> placeholder)
const playin3 = result.games.find((g) => g.game_id === '16GD133');
assertEqual(playin3.whiteTeam, 'REGENCY', 'Playin3 white team');
assertEqual(playin3.darkLocked, false, 'Playin3 dark not yet locked (Cross1 unplayed)');
// Cross1 itself is 3rdA vs 1stH -- both already determined from day-1 group results (680,
// Diablo Alliance), so the placeholder should name them instead of just "Winner of Cross1".
assertEqual(playin3.darkLabel, 'Winner of Cross1 (680 vs DIABLO ALLIANCE)', 'Playin3 dark label shows the feeder matchup');

// QF1 (16GD141): white = 1stD = Patriot
const qf1 = result.games.find((g) => g.game_id === '16GD141');
assertEqual(qf1.whiteTeam, 'PATRIOT', 'QF1 white team (1stD)');

// Scenario tree for Regency: next game is Playin3, win -> QF1 vs Patriot, lose -> N-bracket (9-12)
const scenario = global.Resolver.buildScenarios(result.ctx, 'REGENCY');
assertEqual(scenario.tree.gameId, '16GD133', 'Regency next game');
assertEqual(scenario.tree.opponent, 'Winner of Cross1 (680 vs DIABLO ALLIANCE)', 'Regency next opponent shows the feeder matchup');
assertEqual(scenario.tree.onWin.gameId, '16GD141', 'Regency win-branch -> QF1');
assertEqual(scenario.tree.onWin.opponent, 'PATRIOT', 'Regency win-branch opponent');
assertEqual(scenario.floor, 12, 'Regency floor (2ndB top-group runner-up = 1st-12th)');
assertEqual(scenario.ceiling, 1, 'Regency ceiling (2ndB top-group runner-up = 1st-12th)');

// Regression test: a genuine 3-way cyclic tie (A beats B, B beats C, C beats A -- all three
// finish 1-1, not a data error) must NOT be resolved via pairwise head-to-head, which cycles
// and produces a sort-order-dependent (i.e. wrong) result. It should fall through to goal
// differential for the whole tied group instead. This is exactly what happened with
// Meridian/Norco/San Diego Shores in 16U_GIRLS_D1 Group E on 2026-06-21.
const cyclicTieGames = [
  { date: '2026-06-19', time: '8:00 AM', location: 'X', game_id: '99GD901', white: 'E1-MERIDIAN', white_score: 8, dark: 'E3-NORCO', dark_score: 9, round: 'E bracket E1,E3', division: '16U_GIRLS_D1', played: true },
  { date: '2026-06-19', time: '9:00 AM', location: 'X', game_id: '99GD902', white: 'E2-SAN DIEGO SHORES', white_score: 12, dark: 'E3-NORCO', dark_score: 10, round: 'E bracket E2,E3', division: '16U_GIRLS_D1', played: true },
  { date: '2026-06-19', time: '10:00 AM', location: 'X', game_id: '99GD903', white: 'E1-MERIDIAN', white_score: 9, dark: 'E2-SAN DIEGO SHORES', dark_score: 7, round: 'E bracket E1,E2', division: '16U_GIRLS_D1', played: true },
];
const cyclicResult = global.Resolver.resolveDivision(cyclicTieGames);
const groupE = cyclicResult.standings['E'];
assertEqual(groupE.ranked[0].name, 'MERIDIAN', 'Cyclic 3-way tie 1st (best GD, not H2H)');
assertEqual(groupE.ranked[1].name, 'SAN DIEGO SHORES', 'Cyclic 3-way tie 2nd');
assertEqual(groupE.ranked[2].name, 'NORCO', 'Cyclic 3-way tie 3rd (worst GD, despite beating the 1st-place team)');

// Regression test: when a bracket cell already has the official cached "-{TEAM}" resolution
// for a group placement, that must win over our own computed standings, even if they disagree
// -- our tiebreaker order (head-to-head -> goal diff -> goals against) is a documented
// assumption and may not match what a given tournament actually uses. Construct a group where
// our own computation would say "MERIDIAN" is 1st, but the bracket cell referencing 1stF
// already carries an official "-NORCO" resolution -- NORCO must win.
const officialOverrideGames = [
  { date: '2026-06-19', time: '8:00 AM', location: 'X', game_id: '99GD904', white: 'F1-MERIDIAN', white_score: 8, dark: 'F3-NORCO', dark_score: 9, round: 'F bracket F1,F3', division: '16U_GIRLS_D1', played: true },
  { date: '2026-06-19', time: '9:00 AM', location: 'X', game_id: '99GD905', white: 'F2-SAN DIEGO SHORES', white_score: 12, dark: 'F3-NORCO', dark_score: 10, round: 'F bracket F2,F3', division: '16U_GIRLS_D1', played: true },
  { date: '2026-06-19', time: '10:00 AM', location: 'X', game_id: '99GD906', white: 'F1-MERIDIAN', white_score: 9, dark: 'F2-SAN DIEGO SHORES', dark_score: 7, round: 'F bracket F1,F2', division: '16U_GIRLS_D1', played: true },
  { date: '2026-06-19', time: '11:00 AM', location: 'X', game_id: '99GD907', white: '1stF-NORCO', white_score: null, dark: 'TBD', dark_score: null, round: 'SomeCross', division: '16U_GIRLS_D1', played: false },
];
const officialResult = global.Resolver.resolveDivision(officialOverrideGames);
assertEqual(officialResult.standings['F'].ranked[0].name, 'MERIDIAN', 'Our own computed standings (unchanged) still say Meridian 1st');
const overrideGame = officialResult.games.find((g) => g.game_id === '99GD907');
assertEqual(overrideGame.whiteTeam, 'NORCO', 'Official cached "1stF-NORCO" wins over our own computed 1st place');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
