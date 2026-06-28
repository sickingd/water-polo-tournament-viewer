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
assertEqual(relayAll[1].path.join(' > '), '1st in Group A > Win game RELAY-004', 'Relay test: deeper node carries the full cumulative path');
assertEqual(relayAll[1].gameId, 'RELAY-005', 'Relay test: winning the K-group game relays forward via "1stK", not a W#/L# ref');
assertEqual(relayAll[1].opponent, 'TEAM W', 'Relay test: deeper node resolves its own opponent');

// Regression test: a one-sided letter typo on an otherwise-correct seed pair, seen live in
// the US Club Championships sheet -- "O1(1stG)-..." paired with a blank-round dark side that
// should read "O2(2ndH)-..." but instead says "G2(2ndH)-..." (a real, unrelated letter
// already used by the Group G pool's own G2). Must NOT merge into G (G2 is already a
// different team there); must create a brand-new Group O with both entrants instead.
const letterTypoOGames = [
  { date: '2026-06-19', time: '8:00 AM', location: 'X', game_id: '99G01', white: 'G1-TEAM G1', white_score: 10, dark: 'G2-TEAM G2', dark_score: 3, round: 'G bracket', division: '18U_GIRLS', played: true },
  { date: '2026-06-19', time: '9:00 AM', location: 'X', game_id: '99G02', white: 'G3-TEAM G3', white_score: 8, dark: 'G4-TEAM G4', dark_score: 6, round: 'G bracket', division: '18U_GIRLS', played: true },
  { date: '2026-06-19', time: '10:00 AM', location: 'X', game_id: '99G03', white: 'H1-TEAM H1', white_score: 9, dark: 'H2-TEAM H2', dark_score: 4, round: 'H bracket', division: '18U_GIRLS', played: true },
  { date: '2026-06-20', time: '1:00 PM', location: 'X', game_id: '99G04', white: 'O1(1stG)-TEAM G1', white_score: null, dark: 'G2(2ndH)-TEAM H2', dark_score: null, round: '', division: '18U_GIRLS', played: false },
];
const letterTypoOResult = global.Resolver.resolveDivision(letterTypoOGames);
assertEqual(!!letterTypoOResult.standings['O'], true, 'Letter-typo test: a brand-new Group O is created (not silently dropped)');
assertEqual(letterTypoOResult.standings['O'] && letterTypoOResult.standings['O'].games.length, 1, 'Letter-typo test: Group O has its one decisive game');
const groupOEntrants = global.Resolver.groupEntrants(letterTypoOResult.ctx, 'O');
assertEqual(groupOEntrants.length, 2, 'Letter-typo test: Group O lists both entrants');
assertEqual(groupOEntrants[1] && groupOEntrants[1].name, 'TEAM H2', 'Letter-typo test: O2 resolves to the real team, not stuck on the typo');
assertEqual(letterTypoOResult.standings['G'].ranked.find((r) => r.name === 'TEAM H2'), undefined, 'Letter-typo test: the typo did not leak TEAM H2 into the unrelated Group G');

// Regression test: the SAME shape, but this time the typo'd letter ("VS4") is the orphan
// (used nowhere else) and the OTHER side's letter ("S") is the real, already-established
// group -- must merge into the existing group, not create a bogus new "VS" group.
const letterTypoSGames = [
  { date: '2026-06-19', time: '8:00 AM', location: 'X', game_id: '99S01', white: 'S1-TEAM S1', white_score: 10, dark: 'S4-TEAM S4', dark_score: 3, round: 'S bracket', division: '18U_GIRLS', played: true },
  { date: '2026-06-19', time: '9:00 AM', location: 'X', game_id: '99S02', white: 'S2-TEAM S2', white_score: 8, dark: 'S3-TEAM S3', dark_score: 6, round: 'S bracket', division: '18U_GIRLS', played: true },
  { date: '2026-06-20', time: '1:00 PM', location: 'X', game_id: '99S03', white: 'S2-TEAM S2', white_score: null, dark: 'VS4-TEAM S4', dark_score: null, round: '', division: '18U_GIRLS', played: false },
];
const letterTypoSResult = global.Resolver.resolveDivision(letterTypoSGames);
assertEqual(!!letterTypoSResult.standings['VS'], false, 'Letter-typo test: no bogus "VS" group created');
assertEqual(letterTypoSResult.standings['S'].games.length, 3, 'Letter-typo test: the typo\'d game merges into the existing Group S instead');

// Regression test: a genuine multi-game round-robin placement pool labeled with an ordinal
// range instead of "bracket"/"RR" ("25th-30th N1,N3", seen live in the boys Futures
// Superfinals sheet) must still be tracked -- but a real single-elimination semifinal pair
// sharing the exact same label SHAPE ("9th-12th semi 9v12", every position playing only
// once) must NOT be, since there's no real "standings" to show for that.
const ordinalRangeGames = [
  { date: '2026-06-19', time: '8:00 AM', location: 'X', game_id: '99N01', white: 'N1-TEAM N1', white_score: 10, dark: 'N3-TEAM N3', dark_score: 3, round: '25th-30th N1,N3', division: '16U_BOYS_D3', played: true },
  { date: '2026-06-19', time: '9:00 AM', location: 'X', game_id: '99N02', white: 'N2-TEAM N2', white_score: 8, dark: 'N3-TEAM N3', dark_score: 6, round: '25th-30th N2,N3', division: '16U_BOYS_D3', played: true },
  { date: '2026-06-19', time: '10:00 AM', location: 'X', game_id: '99N03', white: 'N1-TEAM N1', white_score: 9, dark: 'N2-TEAM N2', dark_score: 7, round: '25th-30th N1,N2', division: '16U_BOYS_D3', played: true },
  { date: '2026-06-19', time: '11:00 AM', location: 'X', game_id: '99J01', white: 'J1-TEAM J1', white_score: 12, dark: 'J4-TEAM J4', dark_score: 5, round: '9th-12th semi 9v12', division: '16U_BOYS_D3', played: true },
  { date: '2026-06-19', time: '12:00 PM', location: 'X', game_id: '99J02', white: 'J2-TEAM J2', white_score: 11, dark: 'J3-TEAM J3', dark_score: 4, round: '9th-12th semi 10v11', division: '16U_BOYS_D3', played: true },
];
const ordinalRangeResult = global.Resolver.resolveDivision(ordinalRangeGames);
assertEqual(!!ordinalRangeResult.standings['N'], true, 'Ordinal-range test: a real 3-team round robin labeled "25th-30th" is tracked');
assertEqual(ordinalRangeResult.standings['N'] && ordinalRangeResult.standings['N'].games.length, 3, 'Ordinal-range test: all 3 of Group N\'s round-robin games are counted');
assertEqual(!!ordinalRangeResult.standings['J'], false, 'Ordinal-range test: a single-elimination pair sharing the same label shape is NOT tracked as a pool');

// Regression test: a typo'd cached name on a downstream seed can match the SAME typo on its
// own feeder game (both written by the same broken formula), which defeats a per-token-only
// repair -- the feeder's cached name needs fixing at the SOURCE (before computeGroupStandings
// ever reads it), not just where it's reused later. Seen live: "SBWPC" cached for the real
// "SBPWC" on both a single-decider "M bracket" game AND the downstream "W bracket" seed that
// references that game's winner.
const typoPropagationGames = [
  { date: '2026-06-19', time: '8:00 AM', location: 'X', game_id: '99TY01', white: 'F1-SBPWC', white_score: 15, dark: 'F2-LB SHORE', dark_score: 5, round: 'F bracket', division: 'TYPO_TEST', played: true },
  { date: '2026-06-20', time: '1:00 PM', location: 'X', game_id: '99TY03', white: 'M1(1stF)-SBWPC', white_score: 10, dark: 'M2(2ndE)-COMMERCE', dark_score: 5, round: 'M bracket', division: 'TYPO_TEST', played: true },
  { date: '2026-06-21', time: '2:00 PM', location: 'X', game_id: '99TY04', white: 'W2(1stL)-OTHERTEAM', white_score: null, dark: 'W3(1stM)-SBWPC', dark_score: null, round: 'W bracket', division: 'TYPO_TEST', played: false },
];
const typoPropagationResult = global.Resolver.resolveDivision(typoPropagationGames);
const w3Game = typoPropagationResult.games.find((g) => g.game_id === '99TY04');
assertEqual(w3Game.darkTeam, 'SBPWC', 'Typo-propagation test: downstream seed resolves to the real team, not the typo both sides happen to agree on');
const typoScenario = global.Resolver.buildScenarios(typoPropagationResult.ctx, 'SBPWC', 8);
assertEqual(typoScenario !== null, true, 'Typo-propagation test: SBPWC gets a real scenario, not TBD');
assertEqual(typoScenario.tree.gameId, '99TY04', 'Typo-propagation test: SBPWC\'s next game is found under its real name');

// Regression test: a team can already be done with its original day-1 pool (long complete)
// and have moved on into a later placement bracket via a seed token -- their OWN games
// there can already be final while the bracket itself still has another pairing pending.
// findTeamGroupLetter must follow them to that CURRENT bracket, not keep pointing at the
// original (already-complete, no-longer-relevant) pool. Seen live: a team 1-1 in a 3-team
// "3rd place" crossover pool, with the third pairing (between the other two teams) unplayed.
const advancedGroupGames = [
  { date: '2026-06-19', time: '8:00 AM', location: 'X', game_id: '99AG01', white: 'B1-TEAMX', white_score: 10, dark: 'B2-TEAMY', dark_score: 5, round: 'B bracket', division: 'ADV_TEST', played: true },
  { date: '2026-06-20', time: '1:00 PM', location: 'X', game_id: '99AG02', white: 'T1(3rdB)-TEAMX', white_score: 6, dark: 'T3(3rdH)-TEAMZ', dark_score: 8, round: 'T bracket', division: 'ADV_TEST', played: true },
  { date: '2026-06-20', time: '2:00 PM', location: 'X', game_id: '99AG03', white: 'T1(3rdB)-TEAMX', white_score: 7, dark: 'T2(3rdE)-TEAMW', dark_score: 4, round: 'T bracket', division: 'ADV_TEST', played: true },
  { date: '2026-06-21', time: '9:00 AM', location: 'X', game_id: '99AG04', white: 'T2(3rdE)-TEAMW', white_score: null, dark: 'T3(3rdH)-TEAMZ', dark_score: null, round: 'T bracket', division: 'ADV_TEST', played: false },
];
const advancedResult = global.Resolver.resolveDivision(advancedGroupGames);
const advancedScenario = global.Resolver.buildScenarios(advancedResult.ctx, 'TEAMX', 12);
assertEqual(advancedScenario !== null, true, 'Already-advanced test: TEAMX (pool B long complete, now mid-Group-T) gets a real scenario, not TBD');
assertEqual(advancedScenario && advancedScenario.floor != null && advancedScenario.ceiling != null, true, 'Already-advanced test: TEAMX gets a real floor/ceiling range');

// Regression test: a single-elimination semifinal pair sharing a letter ("9th-12th semi
// 9v12", every position playing exactly once) uses the EXACT same ordinal-range label shape
// as a genuine round-robin placement pool ("25th-30th N1,N3"). rrPlacementRange must not
// treat the semifinal pair as a placement-RR bound and cut the tree short there -- there IS
// a real win/lose branch to walk (into a "9th" / "11th" final), unlike a real pool. Seen
// live: 14U Boys D1's "908" only showed one possible game (the semifinal itself) instead of
// the full tree through to 9th/10th/11th/12th depending on both results.
const semiPairOrdinalGames = [
  { date: '2026-06-19', time: '8:00 AM', location: 'X', game_id: '99SP01', white: 'N1(W#PlayinA)-TEAMA', white_score: null, dark: 'N4(W#PlayinD)-TEAMD', dark_score: null, round: '9th-12th semi 9v12', division: 'SEMI_TEST', played: false },
  { date: '2026-06-19', time: '9:00 AM', location: 'X', game_id: '99SP02', white: 'N2(W#PlayinB)-TEAMB', white_score: null, dark: 'N3(W#PlayinC)-TEAMC', dark_score: null, round: '9th-12th semi 10v11', division: 'SEMI_TEST', played: false },
  { date: '2026-06-20', time: '1:00 PM', location: 'X', game_id: '99SP03', white: 'W#N1/N4', white_score: null, dark: 'W#N2/N3', dark_score: null, round: '9th', division: 'SEMI_TEST', played: false },
  { date: '2026-06-20', time: '2:00 PM', location: 'X', game_id: '99SP04', white: 'L#N1/N4', white_score: null, dark: 'L#N2/N3', dark_score: null, round: '11th', division: 'SEMI_TEST', played: false },
];
const semiPairResult = global.Resolver.resolveDivision(semiPairOrdinalGames);
assertEqual(!!semiPairResult.standings['N'], false, 'Semi-pair-ordinal test: the single-elim pair is not tracked as a pool (sanity check)');
const semiPairAll = global.Resolver.buildAllPossibleGames(semiPairResult.ctx, 'TEAMA');
assertEqual(semiPairAll.length, 7, 'Semi-pair-ordinal test: TEAMA gets the full win/lose tree, not a single collapsed rrRange node');
const semiPairScenario = global.Resolver.buildScenarios(semiPairResult.ctx, 'TEAMA', 12);
assertEqual(semiPairScenario.ceiling, 9, 'Semi-pair-ordinal test: ceiling still correctly bounds at 9 (best case)');
assertEqual(semiPairScenario.floor, 12, 'Semi-pair-ordinal test: floor still correctly bounds at 12 (worst case)');

// ===========================================================================================
// Token-grammar & forward-reference coverage -- each token type and each "what comes next"
// relay mechanism, in isolation. The scenario/standings tests above exercise these indirectly;
// these pin each one down on its own so a regression names the exact mechanism that broke.
// ===========================================================================================

// progressPair (W#{LET}{a}/{b}): a placement semifinal is referenced downstream by its two
// seeded entrants' positions, not a game number. Winner of (B1 vs B4) feeds the next round.
const progressPairGames = [
  { date: 'd', time: '8:00 AM', location: 'X', game_id: 'PP1', white: 'B1(1stA)-ALPHA', white_score: 10, dark: 'B4(1stD)-DELTA', dark_score: 5, round: 'semi', division: 'PP', played: true },
  { date: 'd', time: '9:00 AM', location: 'X', game_id: 'PP2', white: 'W#B1/B4', white_score: null, dark: 'TBD', dark_score: null, round: 'final', division: 'PP', played: false },
];
assertEqual(global.Resolver.resolveDivision(progressPairGames).games.find((g) => g.game_id === 'PP2').whiteTeam, 'ALPHA', 'progressPair: "W#B1/B4" resolves to the winner of the B1-vs-B4 semifinal');

// finishPair (W#{ord1}{let1}/{ord2}{let2}): a cross-group placement game referenced by the two
// group finishes it pits against each other (bare digit+letter, no ordinal suffix).
const finishPairGames = [
  { date: 'd', time: '8:00 AM', location: 'X', game_id: 'FP1', white: '1stE-EWIN', white_score: 10, dark: '2ndF-FRUN', dark_score: 5, round: 'cross', division: 'FP', played: true },
  { date: 'd', time: '9:00 AM', location: 'X', game_id: 'FP2', white: 'W#1E/2F', white_score: null, dark: 'TBD', dark_score: null, round: 'final', division: 'FP', played: false },
];
assertEqual(global.Resolver.resolveDivision(finishPairGames).games.find((g) => g.game_id === 'FP2').whiteTeam, 'EWIN', 'finishPair: "W#1E/2F" resolves to the winner of the 1stE-vs-2ndF cross game');

// "1/2 X" / "3/4 X" semifinal-label relay: a 4-team mini-bracket's cross game carries the LET
// only in its round label (its own tokens are W#/L# refs into the semis), and the winner is
// referenced downstream as "1stX". The forward walk must derive that from the label.
const semiLabelGames = [
  { date: 'd', time: '8:00 AM', location: 'X', game_id: '99XD113', white: 'X1-A', white_score: 10, dark: 'X4-D', dark_score: 5, round: 'semi', division: 'SEMILBL', played: true },
  { date: 'd', time: '9:00 AM', location: 'X', game_id: '99XD114', white: 'X2-B', white_score: 9, dark: 'X3-C', dark_score: 4, round: 'semi', division: 'SEMILBL', played: true },
  { date: 'd', time: '10:00 AM', location: 'X', game_id: '99XD120', white: 'W#13', white_score: null, dark: 'W#14', dark_score: null, round: '1/2 X', division: 'SEMILBL', played: false },
  { date: 'd', time: '11:00 AM', location: 'X', game_id: '99XD121', white: 'AA1(1stX)-', white_score: null, dark: 'AA2(2ndZ)-Z', dark_score: null, round: 'AA bracket', division: 'SEMILBL', played: false },
];
const semiLabelAll = global.Resolver.buildAllPossibleGames(global.Resolver.resolveDivision(semiLabelGames).ctx, 'A');
assertEqual(semiLabelAll.length, 2, '"1/2 X" relay: A\'s tree is the "1/2 X" final plus its win-branch');
assertEqual(semiLabelAll[1] && semiLabelAll[1].gameId, '99XD121', '"1/2 X" relay: winning the final relays forward via "1stX" into the AA bracket');

// "1st/2ndH" / "3rd/4thD" relative-label relay: same mechanism, different spelling (ordinal/
// ordinal + letter, no space). The LET and both ords live only in the round label text.
const relLabelGames = [
  { date: 'd', time: '8:00 AM', location: 'X', game_id: 'R13', white: 'H1(1stA)-A', white_score: 10, dark: 'H4(1stD)-D', dark_score: 5, round: 'semi', division: 'RELLBL', played: true },
  { date: 'd', time: '9:00 AM', location: 'X', game_id: 'R14', white: 'H2(1stB)-B', white_score: 9, dark: 'H3(1stC)-C', dark_score: 4, round: 'semi', division: 'RELLBL', played: true },
  { date: 'd', time: '10:00 AM', location: 'X', game_id: 'R20', white: 'W#H1/H4', white_score: null, dark: 'W#H2/H3', dark_score: null, round: '1st/2ndH', division: 'RELLBL', played: false },
  { date: 'd', time: '11:00 AM', location: 'X', game_id: 'R21', white: 'AA1(1stH)-', white_score: null, dark: 'TEAMZ', dark_score: null, round: 'AA bracket', division: 'RELLBL', played: false },
];
const relLabelAll = global.Resolver.buildAllPossibleGames(global.Resolver.resolveDivision(relLabelGames).ctx, 'A');
assertEqual(relLabelAll.length, 2, '"1st/2ndH" relay: A\'s tree is the "1st/2ndH" final plus its win-branch');
assertEqual(relLabelAll[1] && relLabelAll[1].gameId, 'R21', '"1st/2ndH" relay: winning relays forward via "1stH" into the AA bracket');

// terminalPlace explicit "N-M w/l" form: each game sharing the outer bound decides a distinct,
// non-adjacent pair ("9-16 9/13" -> winner 9th, loser 13th), not the simple "Nth"/"Nth+1" shape.
const explicitPlaceGames = [
  { date: 'd', time: '8:00 AM', location: 'X', game_id: 'EP1', white: 'A1-AA', white_score: null, dark: 'A2-BB', dark_score: null, round: '9-16 9/13', division: 'EP', played: false },
];
const explicitScenario = global.Resolver.buildScenarios(global.Resolver.resolveDivision(explicitPlaceGames).ctx, 'AA', 16);
assertEqual(explicitScenario.ceiling, 9, 'terminalPlace explicit: "9-16 9/13" win = 9th (ceiling)');
assertEqual(explicitScenario.floor, 13, 'terminalPlace explicit: "9-16 9/13" lose = 13th (floor)');

// clinchedRanks before the group is complete: a 3-team pool's leader who has won both their
// games can't be caught, so "1stX" resolves to them even with the other pairing still pending.
const clinchGames = [
  { date: 'd', time: '8:00 AM', location: 'X', game_id: 'CL1', white: 'X1-LEADER', white_score: 10, dark: 'X2-MID', dark_score: 5, round: 'X bracket', division: 'CLINCH', played: true },
  { date: 'd', time: '9:00 AM', location: 'X', game_id: 'CL2', white: 'X1-LEADER', white_score: 11, dark: 'X3-LOW', dark_score: 3, round: 'X bracket', division: 'CLINCH', played: true },
  { date: 'd', time: '10:00 AM', location: 'X', game_id: 'CL3', white: 'X2-MID', dark: 'X3-LOW', white_score: null, dark_score: null, round: 'X bracket', division: 'CLINCH', played: false },
  { date: 'd', time: '11:00 AM', location: 'X', game_id: 'CL4', white: 'Y1(1stX)-', white_score: null, dark: 'TEAMZ', dark_score: null, round: 'Y bracket', division: 'CLINCH', played: false },
];
const clinchResult = global.Resolver.resolveDivision(clinchGames);
assertEqual(clinchResult.standings['X'].complete, false, 'clinched: group X is genuinely still incomplete (one pairing unplayed)');
assertEqual(clinchResult.games.find((g) => g.game_id === 'CL4').whiteTeam, 'LEADER', 'clinched: "1stX" resolves to the already-clinched leader before the group finishes');

// inferUnlabeledTerminalRange: an unlabeled bottom-band pool ("G bracket", no numeric range,
// nothing referencing its finish) is the leftover placement band -- a team in it must get that
// band's full range (3rd-5th here), never a falsely-narrow single locked place. This is the
// 12U Girls "every team showing locked 11th" shape, minimized.
const inferGames = [
  { date: 'd', time: '8:00 AM', location: 'X', game_id: 'IU1', white: 'A1-AONE', white_score: 10, dark: 'A2-ATWO', dark_score: 5, round: '1-2 RR', division: 'INFER', played: true },
  { date: 'd', time: '8:00 AM', location: 'X', game_id: 'IU2', white: 'G1-GONE', white_score: 10, dark: 'G2-GTWO', dark_score: 5, round: 'G bracket', division: 'INFER', played: true },
  { date: 'd', time: '9:00 AM', location: 'X', game_id: 'IU3', white: 'G1-GONE', white_score: 8, dark: 'G3-GTHREE', dark_score: 9, round: 'G bracket', division: 'INFER', played: true },
  { date: 'd', time: '10:00 AM', location: 'X', game_id: 'IU4', white: 'G2-GTWO', white_score: null, dark: 'G3-GTHREE', dark_score: null, round: 'G bracket', division: 'INFER', played: false },
];
const inferScenario = global.Resolver.buildScenarios(global.Resolver.resolveDivision(inferGames).ctx, 'GONE', 5);
assertEqual(inferScenario.ceiling, 3, 'infer-unlabeled: GONE\'s ceiling is 3rd (top of the leftover 3rd-5th band), not a locked single place');
assertEqual(inferScenario.floor, 5, 'infer-unlabeled: GONE\'s floor is 5th (bottom of the leftover band)');

// splitToken tolerates a stray symbol after a closing paren ("K8(2ndA)(16)]-MID PEN", an extra
// "]") -- it must still parse as a SEED (head "K8", source "2ndA", team "MID PEN"), never fall
// through to a literal team named after the whole garbled blob.
const strayTok = global.Resolver.parseToken('K8(2ndA)(16)]-MID PEN');
assertEqual(strayTok.type, 'seed', 'splitToken stray-bracket: parses as a seed, not a literal team');
assertEqual(strayTok.team, 'MID PEN', 'splitToken stray-bracket: cached team extracted past the stray "]"');
assertEqual(strayTok.sources.length === 1 && strayTok.sources[0].let, 'A', 'splitToken stray-bracket: real source "2ndA" kept; bare-numeric "(16)" filtered out');

// A trailing bare-numeric paren ("J8(1stH)(8)") is a human seed-number annotation, not a ref --
// it must be filtered so it can't become a bogus always-locked team named "8" that pre-empts
// the real (1stH) source.
const bareNumTok = global.Resolver.parseToken('J8(1stH)(8)-SOMETEAM');
assertEqual(bareNumTok.sources.length, 1, 'bare-numeric paren: only the real "(1stH)" source kept, "(8)" dropped');
assertEqual(bareNumTok.sources[0].type === 'finish' && bareNumTok.sources[0].ord, 1, 'bare-numeric paren: the kept source is the "1stH" finish ref');

// Cross-group mix-up repair: a "(2ndB)" seed cached a real team ("DALLIANCE") that structurally
// only ever plays in Group D -- it cannot be Group B's runner-up, so the live-computed Group B
// runner-up wins over the impossible cache.
const mixupGames = [
  { date: 'd', time: '8:00 AM', location: 'X', game_id: 'MX1', white: 'B1-BWIN', white_score: 10, dark: 'B2-BRUN', dark_score: 3, round: 'B bracket', division: 'MIXUP', played: true },
  { date: 'd', time: '8:00 AM', location: 'X', game_id: 'MX2', white: 'D1-DALLIANCE', white_score: 10, dark: 'D2-DOTHER', dark_score: 3, round: 'D bracket', division: 'MIXUP', played: true },
  { date: 'd', time: '9:00 AM', location: 'X', game_id: 'MX3', white: 'K1(2ndB)-DALLIANCE', white_score: null, dark: 'TEAMZ', dark_score: null, round: 'K bracket', division: 'MIXUP', played: false },
];
assertEqual(global.Resolver.resolveDivision(mixupGames).games.find((g) => g.game_id === 'MX3').whiteTeam, 'BRUN', 'cross-group mix-up: "(2ndB)" cached a Group-D team, so the real Group-B runner-up wins instead');

// labelWithMatchup expands a projected opponent two feeder games deep -- "Winner of Playin"
// becomes "Winner of Playin (AA vs Winner of Cross3 (BB vs CC))", bottoming out at locked teams.
const nestMatchupGames = [
  { date: 'd', time: '8:00 AM', location: 'X', game_id: 'NM1', white: 'A1-AA', white_score: 10, dark: 'A2-BB', dark_score: 5, round: 'A bracket', division: 'NESTMATCH', played: true },
  { date: 'd', time: '8:00 AM', location: 'X', game_id: 'NM2', white: 'A1-AA', white_score: 10, dark: 'A3-CC', dark_score: 5, round: 'A bracket', division: 'NESTMATCH', played: true },
  { date: 'd', time: '8:00 AM', location: 'X', game_id: 'NM3', white: 'A2-BB', white_score: 10, dark: 'A3-CC', dark_score: 5, round: 'A bracket', division: 'NESTMATCH', played: true },
  { date: 'd', time: '9:00 AM', location: 'X', game_id: 'NM4', white: '2ndA-BB', white_score: null, dark: '3rdA-CC', dark_score: null, round: 'Cross3', division: 'NESTMATCH', played: false },
  { date: 'd', time: '9:30 AM', location: 'X', game_id: 'NM6', white: '1stA-AA', white_score: null, dark: 'W#Cross3', dark_score: null, round: 'Playin', division: 'NESTMATCH', played: false },
  { date: 'd', time: '10:00 AM', location: 'X', game_id: 'NM5', white: 'X1(1stD)-DD', white_score: null, dark: 'W#Playin', dark_score: null, round: 'final', division: 'NESTMATCH', played: false },
];
assertEqual(global.Resolver.resolveDivision(nestMatchupGames).games.find((g) => g.game_id === 'NM5').darkLabel, 'Winner of Playin (AA vs Winner of Cross3 (BB vs CC))', 'labelWithMatchup: expands the projected opponent two feeder games deep');

// Regression test: a 4-team mini-bracket whose quarterfinal-round games are literally
// labeled "W bracket" (W1 vs W4, W2 vs W3, a single-elimination PERFECT MATCHING, every
// position playing exactly once) must NOT have its "1stW"/"2ndW" resolved from that round's
// own win/loss -- those two winners never played each other, so ranking them by goal-diff
// tiebreak is meaningless. The REAL decider is a later "1/2 W" semifinal (a W#/L# progress
// ref that never carries a {LET}{pos} token, so it never joins the "W bracket" group at
// all). Seen live: 18U Girls' "1st"/"3rd" games paired the two quarterfinal winners against
// each other (and the two losers against each other) as if the semifinals were already
// decided, when neither had been played yet.
const quarterThenSemiGames = [
  { date: 'd', time: '8:00 AM', location: 'X', game_id: 'QS01', white: 'W2(1stL)-LAMORINDA', white_score: 10, dark: 'W3(1stM)-DIABLO', dark_score: 14, round: 'W bracket', division: 'QTHENSEMI', played: true },
  { date: 'd', time: '9:00 AM', location: 'X', game_id: 'QS02', white: 'W1(1stI)-SBWPC', white_score: 12, dark: 'W4(1stP)-SDSHORES', dark_score: 4, round: 'W bracket', division: 'QTHENSEMI', played: true },
  { date: 'd', time: '10:00 AM', location: 'X', game_id: 'QS03', white: 'X2(1stK)-REGENCY', white_score: 13, dark: 'X3(1stN)-SOCAL', dark_score: 11, round: 'X bracket', division: 'QTHENSEMI', played: true },
  { date: 'd', time: '11:00 AM', location: 'X', game_id: 'QS04', white: 'X1(1stJ)-NEWPORT', white_score: 12, dark: 'X4(1stO)-SBWPCB', dark_score: 8, round: 'X bracket', division: 'QTHENSEMI', played: true },
  { date: 'd2', time: '8:00 AM', location: 'X', game_id: 'QS05', white: 'W#2-SBWPC', white_score: null, dark: 'W#1-DIABLO', dark_score: null, round: '1/2 W', division: 'QTHENSEMI', played: false },
  { date: 'd2', time: '9:00 AM', location: 'X', game_id: 'QS06', white: 'W#3-REGENCY', white_score: null, dark: 'W#4-NEWPORT', dark_score: null, round: '1/2 X', division: 'QTHENSEMI', played: false },
  { date: 'd2', time: '10:00 AM', location: 'X', game_id: 'QS07', white: 'AA1(1stW)-', white_score: null, dark: 'AA2(1stX)-', dark_score: null, round: '1st', division: 'QTHENSEMI', played: false },
  { date: 'd2', time: '11:00 AM', location: 'X', game_id: 'QS08', white: 'BB1(2ndW)-', white_score: null, dark: 'BB2(2ndX)-', dark_score: null, round: '3rd', division: 'QTHENSEMI', played: false },
];
const quarterThenSemiResult = global.Resolver.resolveDivision(quarterThenSemiGames);
assertEqual(quarterThenSemiResult.standings['W'].decidable, false, 'Quarter-then-semi: Group W (a perfect-matching pair, not a real pool) is marked non-decidable');
const qs07 = quarterThenSemiResult.games.find((g) => g.game_id === 'QS07');
assertEqual(qs07.whiteTeam, null, 'Quarter-then-semi: "1st" game does NOT pair the two quarterfinal winners against each other before the real semifinal is played');
// The hint's round-name is just the feeder's roundName (the FIRST word of its round label,
// "1/2" -- see buildDivision/chronoKey's shared roundName convention), not the full "1/2 W";
// the matchup detail itself already disambiguates which semifinal is meant.
assertEqual(qs07.whiteLabel, 'Winner of 1/2 (SBWPC vs DIABLO)', 'Quarter-then-semi: instead shows the real pending semifinal matchup');
// Now play the semifinals and confirm "1stW"/"2ndW" resolve correctly afterward.
const quarterThenSemiPlayedGames = quarterThenSemiGames.map((g) => (g.game_id === 'QS05' || g.game_id === 'QS06')
  ? { ...g, white_score: 10, dark_score: 6, played: true }
  : g);
const playedResult = global.Resolver.resolveDivision(quarterThenSemiPlayedGames);
const qs07Played = playedResult.games.find((g) => g.game_id === 'QS07');
assertEqual(qs07Played.whiteTeam, 'SBWPC', 'Quarter-then-semi: once the semifinal is actually played, "1stW" resolves to its real winner');
const qs08Played = playedResult.games.find((g) => g.game_id === 'QS08');
assertEqual(qs08Played.darkTeam, 'NEWPORT', 'Quarter-then-semi: "2ndX" resolves to the real semifinal loser');

// Regression test: a genuine multi-game round robin is still marked decidable (the new flag
// must not affect any real pool), and its standings still resolve finishes normally.
const realPoolGames = [
  { date: 'd', time: '8:00 AM', location: 'X', game_id: 'RP1', white: 'C1-AONE', white_score: 10, dark: 'C2-BTWO', dark_score: 5, round: 'C bracket', division: 'REALPOOL', played: true },
  { date: 'd', time: '9:00 AM', location: 'X', game_id: 'RP2', white: 'C1-AONE', white_score: 8, dark: 'C3-CTHREE', dark_score: 9, round: 'C bracket', division: 'REALPOOL', played: true },
  { date: 'd', time: '10:00 AM', location: 'X', game_id: 'RP3', white: 'C2-BTWO', white_score: 6, dark: 'C3-CTHREE', dark_score: 4, round: 'C bracket', division: 'REALPOOL', played: true },
];
assertEqual(global.Resolver.resolveDivision(realPoolGames).standings['C'].decidable, true, 'Real round-robin pool: still marked decidable (each position plays more than once)');

// Regression test: parseToken must tolerate every separator style seen live for the verbose
// "WIN #N"/"LOSE #N" progress-ref spelling -- a dash ("WIN #7-LAMORINDA"), no punctuation at
// all (just whitespace: "WIN #18  LAMORINDA"), and a "+" ("LOSE #3 + SD SHORES GOLD") -- and
// must keep parsing the existing compact "W#7"/"L#12" forms exactly as before.
assertEqual(global.Resolver.parseToken('W#11').ref, '11', 'progress token: bare "W#11" (no team) parses correctly');
assertEqual(global.Resolver.parseToken('W#Cross1').ref, 'Cross1', 'progress token: "W#Cross1" (named round, no team) parses correctly');
const dashForm = global.Resolver.parseToken('WIN #7-LAMORINDA');
assertEqual(dashForm.type === 'progress' && dashForm.wl === 'W' && dashForm.ref === '7' && dashForm.team, 'LAMORINDA', 'progress token: "WIN #7-LAMORINDA" (dash) parses as a clean progress ref');
const noDashForm = global.Resolver.parseToken('WIN #18  LAMORINDA');
assertEqual(noDashForm.type === 'progress' && noDashForm.wl === 'W' && noDashForm.ref === '18' && noDashForm.team, 'LAMORINDA', 'progress token: "WIN #18  LAMORINDA" (no dash, just whitespace) parses as a clean progress ref');
const plusForm = global.Resolver.parseToken('LOSE #3 + SD SHORES GOLD');
assertEqual(plusForm.type === 'progress' && plusForm.wl === 'L' && plusForm.ref === '3' && plusForm.team, 'SD SHORES GOLD', 'progress token: "LOSE #3 + SD SHORES GOLD" ("+" separator) parses as a clean progress ref');
const compactWithTeam = global.Resolver.parseToken('W#11-DIABLO A');
assertEqual(compactWithTeam.ref === '11' && compactWithTeam.team, 'DIABLO A', 'progress token: compact "W#11-DIABLO A" still parses exactly as before');
const compactNoTeam = global.Resolver.parseToken('L#12');
assertEqual(compactNoTeam.ref === '12' && compactNoTeam.team, null, 'progress token: compact "L#12" (no team) still parses exactly as before');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
