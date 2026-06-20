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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
