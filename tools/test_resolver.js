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

// Regression test: a real bug seen on the live sheet -- a "{ord}{group}" cell's cached
// suffix can drop a club's squad-letter (e.g. "1stA-SANTA BARBARA" instead of the real team
// "SANTA BARBARA A"). That cached name doesn't match anyone in Group A's roster but IS an
// unambiguous prefix of exactly one real team, so it should be repaired rather than trusted
// verbatim (which would otherwise invent a phantom "SANTA BARBARA" team distinct from the
// actual "SANTA BARBARA A"/"SANTA BARBARA B" squads).
const truncatedNameGames = [
  { date: '2026-06-19', time: '8:00 AM', location: 'X', game_id: '99GD908', white: 'A1-SANTA BARBARA A', white_score: 13, dark: 'A3-LB VIKING A', dark_score: 8, round: 'A bracket A1,A3', division: '18U_GIRLS_D1', played: true },
  { date: '2026-06-19', time: '9:00 AM', location: 'X', game_id: '99GD909', white: 'A1-SANTA BARBARA A', white_score: 12, dark: 'A2-STANFORD', dark_score: 6, round: 'A bracket A1,A2', division: '18U_GIRLS_D1', played: true },
  { date: '2026-06-19', time: '10:00 AM', location: 'X', game_id: '99GD910', white: 'A2-STANFORD', white_score: 10, dark: 'A3-LB VIKING A', dark_score: 4, round: 'A bracket A2,A3', division: '18U_GIRLS_D1', played: true },
  { date: '2026-06-19', time: '11:00 AM', location: 'X', game_id: '99GD911', white: '1stA-SANTA BARBARA', white_score: null, dark: 'TBD', dark_score: null, round: 'QF2', division: '18U_GIRLS_D1', played: false },
];
const truncatedResult = global.Resolver.resolveDivision(truncatedNameGames);
const qf2Repro = truncatedResult.games.find((g) => g.game_id === '99GD911');
assertEqual(qf2Repro.whiteTeam, 'SANTA BARBARA A', 'Truncated cached "1stA-SANTA BARBARA" repaired to the real team "SANTA BARBARA A"');

// Regression test: a shootout-decided tie is recorded as e.g. "5.3" vs "5.1" (5 goals each in
// regulation, decided 3-1 in the shootout). The decimal must still decide the winner, but
// shootout goals are not real goals -- goal differential should be 0, not +0.2.
const shootoutGames = [
  { date: '2026-06-19', time: '8:00 AM', location: 'X', game_id: '99GD912', white: 'Y1-TEAM ONE', white_score: 5.3, dark: 'Y2-TEAM TWO', dark_score: 5.1, round: 'Y bracket Y1,Y2', division: '16U_GIRLS_D1', played: true },
];
const shootoutResult = global.Resolver.resolveDivision(shootoutGames);
const groupY = shootoutResult.standings['Y'];
const teamOne = groupY.ranked.find((r) => r.name === 'TEAM ONE');
const teamTwo = groupY.ranked.find((r) => r.name === 'TEAM TWO');
assertEqual(teamOne.w, 1, 'Shootout winner (5.3 over 5.1) still credited the win');
assertEqual(teamOne.gf - teamOne.ga, 0, 'Shootout goals excluded from goal differential (5-5, not 5.3-5.1)');
assertEqual(teamTwo.l, 1, 'Shootout loser (5.1) credited the loss');
assertEqual(teamTwo.gf - teamTwo.ga, 0, 'Shootout loser also shows 0 goal differential, not -0.2');

// Regression tests for the Club Championships ingestion's text-rewrite normalization
// (tools/refresh_data.py's normalize_clubchamps_token / worker/index.js's
// normalizeClubChampsToken). Those rewrites happen *before* tokens reach this file -- these
// fixtures feed the resolver the already-rewritten canonical forms directly, proving the
// shared, generic resolver needs no club-championships-specific awareness at all.
const clubChampsGames = [
  // Bare numeric progress refs ("WINNER #11"/"LOSER #11" -> "W#11"/"L#11"): the resolver
  // already supports this exact shape (it was built for 12U/14U D2's numeric W#/L# refs).
  { date: '2026-06-26', time: '8:00 AM', location: 'X', game_id: '12U_GIRLS-011', white: 'A1-TEAM A', white_score: 10, dark: 'A2-TEAM B', dark_score: 8, round: 'A bracket', division: '12U_GIRLS', played: true },
  { date: '2026-06-26', time: '9:00 AM', location: 'X', game_id: '12U_GIRLS-100', white: 'W#11', white_score: null, dark: 'TBD', dark_score: null, round: '', division: '12U_GIRLS', played: false },
  // No-parens placement-seed form ("E1 -1st A - TEAM" -> "E1(1stA)-TEAM"): only the 12U
  // sheet omits parens around the source; the resolver's `seed` token type expects them.
  { date: '2026-06-26', time: '10:00 AM', location: 'X', game_id: '12U_GIRLS-101', white: 'E1(1stA)-TEAM A', white_score: null, dark: 'E3(2ndB)-', dark_score: null, round: '', division: '12U_GIRLS', played: false },
];
const clubChampsResult = global.Resolver.resolveDivision(clubChampsGames);
const progressGame = clubChampsResult.games.find((g) => g.game_id === '12U_GIRLS-100');
assertEqual(progressGame.whiteTeam, 'TEAM A', 'Rewritten "WINNER #11" (-> W#11) resolves against the game stamped #11');
const seedGame = clubChampsResult.games.find((g) => g.game_id === '12U_GIRLS-101');
assertEqual(seedGame.whiteTeam, 'TEAM A', 'Rewritten no-parens seed ("E1 -1st A - TEAM A" -> "E1(1stA)-TEAM A") trusts its own cached team');
assertEqual(seedGame.darkLocked, false, 'Rewritten no-parens seed with no cached team ("E3(2ndB)-") stays unresolved, not a literal team named "2ndB"');

// Regression test: localNumber() must keep matching the old "{n}GD{d}{num}" shape first
// (unaffected by this addition) but also support other game_id schemes via a generic
// trailing-digits fallback, e.g. the Club Championships ingestion's "{DIVISION}-{NNN}" ids.
assertEqual(global.Resolver.localNumber('16GD133'), 33, 'localNumber still parses the old format exactly as before');
assertEqual(global.Resolver.localNumber('12U_GIRLS-011'), 11, 'localNumber falls back to trailing digits for non-GD-shaped ids');
assertEqual(global.Resolver.localNumber('not-a-game-id'), null, 'localNumber returns null when there are no trailing digits at all');

// Regression test: before any games are played, a team's current game is plain pool play,
// which is referenced downstream only by group *finish* ("1stA"), never by its own
// individual W#/L#, so the forward walk from buildScenarios finds zero terminal leaves --
// it must fall back to the *full* division range (every team can still finish anywhere from
// 1st to last) rather than report no scenario at all. This is exactly the case the live
// US Club Championships sheets hit on day zero, before any pool results exist.
const freshPoolGames = [
  { date: '2026-06-26', time: '8:00 AM', location: 'X', game_id: '18U_GIRLS-001', white: 'A1-TEAM A', white_score: null, dark: 'A2-TEAM B', dark_score: null, round: 'A bracket', division: '18U_GIRLS', played: false },
  { date: '2026-06-26', time: '9:00 AM', location: 'X', game_id: '18U_GIRLS-002', white: 'A3-TEAM C', white_score: null, dark: 'A4-TEAM D', dark_score: null, round: 'A bracket', division: '18U_GIRLS', played: false },
];
const freshPoolResult = global.Resolver.resolveDivision(freshPoolGames);
const freshScenario = global.Resolver.buildScenarios(freshPoolResult.ctx, 'TEAM A', 29);
assertEqual(freshScenario.ceiling, 1, 'Day-zero team (no results yet) can still finish 1st -- ceiling 1');
assertEqual(freshScenario.floor, 29, 'Day-zero team (no results yet) can still finish last of 29 -- floor 29');
const freshScenarioNoCount = global.Resolver.buildScenarios(freshPoolResult.ctx, 'TEAM A');
assertEqual(freshScenarioNoCount.floor, null, 'Omitting totalTeams keeps the old null-floor behavior (backward compatible)');

// Regression test: buildAllPossibleGames must enumerate every hypothetical pool finish as
// its own root, AND follow a "finish-relay" mini-group (a single 2-team game whose win/loss
// becomes the next round's "1stK"/"2ndK" seed, with no W#/L# reference at all -- exactly how
// the live US Club Championships 18U bracket relays crossover results) deeper than one level.
// `computeGroupStandings` can't populate real team records for K here (its entrants are seed
// tokens with no cached name until group A finishes), so this also locks in that the relay
// must work off `games.length === 1`, not the (necessarily 0) `size`.
const relayGames = [
  { date: '2026-06-26', time: '8:00 AM', location: 'X', game_id: 'RELAY-001', white: 'A1-TEAM A', white_score: null, dark: 'A2-TEAM B', dark_score: null, round: 'A bracket', division: 'RELAY_TEST', played: false },
  { date: '2026-06-26', time: '9:00 AM', location: 'X', game_id: 'RELAY-002', white: 'A1-TEAM A', white_score: null, dark: 'A3-TEAM C', dark_score: null, round: 'A bracket', division: 'RELAY_TEST', played: false },
  { date: '2026-06-26', time: '10:00 AM', location: 'X', game_id: 'RELAY-003', white: 'A2-TEAM B', white_score: null, dark: 'A3-TEAM C', dark_score: null, round: 'A bracket', division: 'RELAY_TEST', played: false },
  // Mini-group K: 1stA vs a fixed cached team (standing in for "the finish of some other pool").
  { date: '2026-06-27', time: '8:00 AM', location: 'X', game_id: 'RELAY-004', white: 'K1(1stA)-', white_score: null, dark: 'K2(1stB)-TEAM Z', dark_score: null, round: 'K bracket', division: 'RELAY_TEST', played: false },
  // Downstream of K's WINNER (1stK) -- no W#/L# ref anywhere, purely a finish relay.
  { date: '2026-06-27', time: '9:00 AM', location: 'X', game_id: 'RELAY-005', white: 'X1(1stK)-', white_score: null, dark: 'TEAM W', dark_score: null, round: 'X bracket', division: 'RELAY_TEST', played: false },
];
const relayResult = global.Resolver.resolveDivision(relayGames);
const relayAll = global.Resolver.buildAllPossibleGames(relayResult.ctx, 'TEAM A');
assertEqual(relayAll.length, 2, 'Relay test: TEAM A has exactly 2 possible future games (1stA root + its win-branch)');
assertEqual(relayAll[0].path.join(' > '), '1st in Group A', 'Relay test: root path describes the hypothetical pool finish');
assertEqual(relayAll[0].gameId, 'RELAY-004', 'Relay test: 1stA feeds into the K mini-group game');
assertEqual(relayAll[0].opponent, 'TEAM Z', 'Relay test: opponent at the entry game is the other (cached) K-group entrant');
assertEqual(relayAll[1].path.join(' > '), '1st in Group A > Win this game', 'Relay test: deeper node carries the full cumulative path');
assertEqual(relayAll[1].gameId, 'RELAY-005', 'Relay test: winning the K-group game relays forward via "1stK", not a W#/L# ref');
assertEqual(relayAll[1].opponent, 'TEAM W', 'Relay test: deeper node resolves its own opponent');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
