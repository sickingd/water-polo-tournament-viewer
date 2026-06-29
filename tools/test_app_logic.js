// Smoke-test the app's inline JS logic without a real browser: stub document/localStorage,
// load resolver + data + the <script> body extracted from tournament_app.html, then drive
// the same functions a user interaction would call and sanity-check the produced HTML.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'tournament_app.html'), 'utf8');
// Bare <script>...</script> (no attributes) appears more than once now (the GA4 config
// snippet in <head> is one too) -- the main app logic is always the *last* one, right
// before </body>, so take that rather than the first match.
const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!scriptMatches.length) throw new Error('could not find inline <script> body');
const appJs = scriptMatches[scriptMatches.length - 1][1];

class FakeEl {
  constructor() { this.innerHTML = ''; this.textContent = ''; this._classes = new Set(); this.value = ''; this.style = {}; }
  get classList() {
    const self = this;
    return {
      add: (c) => self._classes.add(c),
      remove: (c) => self._classes.delete(c),
      contains: (c) => self._classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !self._classes.has(c) : !!force;
        if (on) self._classes.add(c); else self._classes.delete(c);
        return on;
      },
    };
  }
}

const elements = new Map();
function el(id) {
  if (!elements.has(id)) elements.set(id, new FakeEl());
  return elements.get(id);
}

const store = new Map();
// A fake <link rel="canonical"> so updatePageMeta()'s querySelector('link[rel="canonical"]')
// has something to write to -- a plain object with just enough of the Element surface
// (get/setAttribute) rather than a full FakeEl, since nothing else needs this one.
const canonicalEl = {
  _href: '',
  setAttribute(name, v) { if (name === 'href') this._href = v; },
  getAttribute(name) { return name === 'href' ? this._href : null; },
};
const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  addEventListener: () => {},
  location: { pathname: '/' },
  history: { replaceState: () => {}, pushState: () => {} },
  document: {
    getElementById: (id) => el(id),
    querySelectorAll: () => [],
    querySelector: (sel) => (sel === 'link[rel="canonical"]' ? canonicalEl : null),
  },
  setTimeout: () => {},
  setInterval: () => {},
};
sandbox.global = sandbox;
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

function load(file) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
}
load('src/resolver.js');
load('data/manifest.js');
load('data/2026-girls-futures-superfinals.js');
load('data/2026-girls-us-club-championships.js');
load('data/2026-boys-us-club-championships.js');
load('data/2026-boys-futures-superfinals.js');
vm.runInContext(appJs, sandbox, { filename: 'tournament_app.html(inline)' });

let failures = 0;
function check(label, cond) {
  if (!cond) { failures++; console.error('FAIL:', label); } else { console.log('PASS:', label); }
}

check('initial My Team prompt shown', el('myTeamContent').innerHTML.includes('Choose Your Team'));

// --- Multi-tournament manifest: Club Championships is "current" (LIVE), Superfinals is the
// one frozen "Past" entry -- everything below this block re-selects Superfinals explicitly so
// the existing Regency-based assertions keep testing the OLD tournament regardless of which
// tournament the manifest marks as default/current.
// `activeTournamentId`/`TD` are top-level `let`s in the inline script -- vm.runInContext
// doesn't expose those as sandbox properties (only function/var declarations attach to the
// context global), so check the default tournament indirectly via what renderHeader() wrote.
check('Default tournament is the current one (Club Championships)',
  el('tourneyLabel').textContent === '2026 Girls US Club Championships');
vm.runInContext("openTourneyPicker()", sandbox);
const tourneyPickerHtml = el('tourneyPickerList').innerHTML;
check('Tournament picker shows LIVE chip on Club Championships',
  /Club Championships[\s\S]*?LIVE/.test(tourneyPickerHtml));
check('Tournament picker buckets Superfinals under Past Tournaments',
  /Past Tournaments[\s\S]*Superfinals/.test(tourneyPickerHtml));
check('Tournament picker does not show a LIVE chip on the frozen Superfinals entry',
  !/Superfinals<\/div>[\s\S]{0,40}LIVE/.test(tourneyPickerHtml));
vm.runInContext("closeTourneyPicker()", sandbox);

vm.runInContext("selectTournament('2026-girls-futures-superfinals')", sandbox);
vm.runInContext("selectTeam('REGENCY', '16U_GIRLS_D1')", sandbox);
const myTeamHtml = el('myTeamContent').innerHTML;
check('My Team header shows team name', el('favTeamName').textContent === 'REGENCY');
check('My Team shows age chip', el('favTeamChips').innerHTML.includes('age-16U'));
check('My Team content renders games', myTeamHtml.includes('game-card'));
// REGENCY's run in this frozen fixture is over (all its games are already final by now) --
// it shows a final-placement banner and a Completed Games list, not a Next Game/Path to the
// Finish section. See the synthetic TEAMA fixture below for a mid-tournament team instead.
check('REGENCY (run over in this frozen fixture) shows a final-placement banner', myTeamHtml.includes('final-placement'));
check('REGENCY shows Completed Games, not a Path to the Finish section', myTeamHtml.includes('Completed Games') && !myTeamHtml.includes('Path to the Finish'));

// --- Bracket tab: viewing bar + group standings + Game#-ordered schedule (no tracker here) ---
vm.runInContext("showTab('standings')", sandbox);
const standingsHtml = el('standingsContent').innerHTML;
check('Bracket tab shows the viewing bar for the favorite division', standingsHtml.includes('Viewing Bracket') && standingsHtml.includes('16U'));
check('Bracket tab renders group tables', standingsHtml.includes('Group B'));
check('Bracket tab does NOT show the Placement Tracker (moved to Tournament tab)', !standingsHtml.includes('Placement Tracker'));
check('Bracket tab renders that division\'s game cards', standingsHtml.includes('game-card'));

// Chronological ordering within the Bracket tab's schedule, using the data-game-id attribute.
// "16GD1xx" is 16U_GIRLS_D1; "16GD2xx" (16U_GIRLS_D2) also starts with "16GD" so the division
// digit must be pinned, or this picks up both divisions' games interleaved.
const div16GameIds = [...standingsHtml.matchAll(/data-game-id="(16GD1\d+)"/g)].map((m) => m[1]);
const div16Games = sandbox.TOURNAMENTS['2026-girls-futures-superfinals'].games;
function chronoKeyFor(id) {
  const g = div16Games.find((x) => x.game_id === id);
  const m = (g.time || '').match(/(\d+):(\d+)\s*(AM|PM)/i);
  let mins = 0;
  if (m) { let h = parseInt(m[1], 10) % 12; if (/PM/i.test(m[3])) h += 12; mins = h * 60 + parseInt(m[2], 10); }
  return (g.date || '') + ':' + String(mins).padStart(4, '0');
}
const chronoCheck = div16GameIds.every((id, i) => i === 0 || chronoKeyFor(div16GameIds[i - 1]) <= chronoKeyFor(id));
check('Bracket tab games are ordered chronologically (date, then time)', chronoCheck && div16GameIds.length > 0);

// Bracket switcher: viewing a division your favorite team isn't in should work standalone.
vm.runInContext("selectBracket('18U_GIRLS_D1')", sandbox);
const otherBracketHtml = el('standingsContent').innerHTML;
check('Switching bracket away from favDiv still renders groups', otherBracketHtml.includes('standings-card'));
check('Switching bracket away from favDiv shows the new division in the viewing bar', otherBracketHtml.includes('18U'));
// Re-picking the favorite team should snap the bracket view back to their division.
vm.runInContext("selectTeam('REGENCY', '16U_GIRLS_D1')", sandbox);
vm.runInContext("showTab('standings')", sandbox);
check('Re-selecting favorite team resets viewingDivision', el('standingsContent').innerHTML.includes('16U'));

// --- Tournament tab: viewing bar + Placement Tracker only (GD column + next opponent) ---
vm.runInContext("showTab('schedule')", sandbox);
const scheduleHtml = el('scheduleContent').innerHTML;
check('Tournament tab shows the viewing bar', scheduleHtml.includes('Viewing Bracket'));
check('Tournament tab shows the Placement Tracker', scheduleHtml.includes('Placement Tracker'));
check('Tournament tab does NOT show individual game cards (moved to Bracket tab)', !scheduleHtml.includes('game-card'));
check('Placement Tracker has a GD column', scheduleHtml.includes('tracker-gd'));

// The next-opponent hint can only appear for a team that still HAS an upcoming game -- the
// frozen Superfinals viewed above is fully completed (every team locked into a final
// placement), so a synthetic mid-tournament division is injected to test it data-independently.
// Group A is fully played (ALPHA 1st, BETA 2nd, GAMMA 3rd); a Cross game pairs 2ndA vs 3rdA;
// a decider pits 1stA-ALPHA against the winner of that Cross -- so ALPHA's projected next
// opponent is "Winner of Cross5 (BETA vs GAMMA)", a NESTED-paren matchup that the tracker must
// strip down to just "Winner of Cross5" for its compact one-line display.
// Group B (DELTA/EPSILON) exists only so the division has more teams than Group A's 3 --
// otherwise allFinalPlacements treats a complete group whose size equals the whole division
// as a flat round robin and locks every team into a final placement (no scenario, no next
// opponent). With 5 teams total and two separate complete pools, nothing is yet pinned, so
// ALPHA keeps a live scenario.
vm.runInContext(`
  TD.games.push(
    { date: '2026-06-20', time: '8:00 AM', location: 'X', game_id: 'TRK01', white: 'A1-ALPHA', white_score: 10, dark: 'A2-BETA', dark_score: 5, round: 'A bracket', division: 'TRK_TEST', played: true },
    { date: '2026-06-20', time: '9:00 AM', location: 'X', game_id: 'TRK02', white: 'A1-ALPHA', white_score: 12, dark: 'A3-GAMMA', dark_score: 4, round: 'A bracket', division: 'TRK_TEST', played: true },
    { date: '2026-06-20', time: '10:00 AM', location: 'X', game_id: 'TRK03', white: 'A2-BETA', white_score: 9, dark: 'A3-GAMMA', dark_score: 6, round: 'A bracket', division: 'TRK_TEST', played: true },
    { date: '2026-06-20', time: '8:00 AM', location: 'X', game_id: 'TRK06', white: 'B1-DELTA', white_score: 11, dark: 'B2-EPSILON', dark_score: 3, round: 'B bracket', division: 'TRK_TEST', played: true },
    { date: '2026-06-21', time: '1:00 PM', location: 'X', game_id: 'TRK04', white: '2ndA-BETA', white_score: null, dark: '3rdA-GAMMA', dark_score: null, round: 'Cross5', division: 'TRK_TEST', played: false },
    { date: '2026-06-21', time: '3:00 PM', location: 'X', game_id: 'TRK05', white: '1stA-ALPHA', white_score: null, dark: 'W#Cross5', dark_score: null, round: 'Playin', division: 'TRK_TEST', played: false }
  );
  TD.teams.push(
    { name: 'ALPHA', division: 'TRK_TEST' }, { name: 'BETA', division: 'TRK_TEST' }, { name: 'GAMMA', division: 'TRK_TEST' },
    { name: 'DELTA', division: 'TRK_TEST' }, { name: 'EPSILON', division: 'TRK_TEST' }
  );
  resolvedCache = {};
  selectBracket('TRK_TEST');
  showTab('schedule');
`, sandbox);
const trackerSyntheticHtml = el('scheduleContent').innerHTML;
check('Placement Tracker shows a next-opponent hint', trackerSyntheticHtml.includes('tracker-next'));
check('Placement Tracker opponent hints are short (no nested matchup parens)', !/tracker-next">\(vs [^)]*\([^)]*\(/.test(trackerSyntheticHtml));
check('Placement Tracker strips the nested feeder matchup to the top label only', /tracker-next">\(vs Winner of Cross5\)/.test(trackerSyntheticHtml));

// Tournament switcher: re-selecting the same (only) tournament should be a no-op, not crash.
vm.runInContext("selectTournament('2026-girls-futures-superfinals')", sandbox);
check('Re-selecting current tournament does not crash', true);

// Final placement banner: no real team has finished mid-tournament yet, so inject a synthetic
// finished bracket (a single decided "3rd" game) to verify the banner itself renders correctly.
vm.runInContext(`
  TD.games.push({ date: '2026-06-21', time: '1:00 PM', location: 'TEST COURT', game_id: 'TESTG01',
    white: 'TESTWINNER', white_score: 10, dark: 'TESTLOSER', dark_score: 8, round: '3rd',
    division: 'TEST_DIV', played: true });
  TD.teams.push({ name: 'TESTWINNER', division: 'TEST_DIV' }, { name: 'TESTLOSER', division: 'TEST_DIV' });
  resolvedCache = {};
  selectTeam('TESTWINNER', 'TEST_DIV');
`, sandbox);
const winnerHtml = el('myTeamContent').innerHTML;
check('Finished team (3rd place) shows final-placement banner', winnerHtml.includes('final-placement'));
check('3rd place gets the top3 trophy styling', winnerHtml.includes('top3') && winnerHtml.includes('🏆'));
check('3rd place banner shows "3rd"', winnerHtml.includes('3rd'));
check('Finished team does NOT also show Best Case/Worst Case stats (the banner already says it)', !winnerHtml.includes('Best Case') && !winnerHtml.includes('Worst Case'));

vm.runInContext("selectTeam('TESTLOSER', 'TEST_DIV')", sandbox);
const loserHtml = el('myTeamContent').innerHTML;
check('4th place shows final-placement banner without trophy styling', loserHtml.includes('final-placement') && !loserHtml.includes('top3') && !loserHtml.includes('🏆'));
check('4th place banner shows "4th"', loserHtml.includes('4th'));

// Game# should be visibly shown on each game card (not just available as a data attribute) --
// shortened to just the trailing number (the "16GD1" division prefix is noise a coach doesn't
// need repeated on every card; data-game-id keeps the full id for the chronological-order check
// above).
vm.runInContext("selectTeam('REGENCY', '16U_GIRLS_D1'); showTab('standings');", sandbox);
const bracketHtmlForGameNum = el('standingsContent').innerHTML;
check('Bracket tab visibly shows the Game# on each card', /class="game-number">\d+</.test(bracketHtmlForGameNum));
check('Bracket tab shortens the Game# (no division prefix repeated on the card)', !/class="game-number">16GD1\d+</.test(bracketHtmlForGameNum));

// My Team layout: a team mid-tournament (one completed game, one upcoming win/lose decider)
// to verify the restructured page -- Best/Worst Case promoted next to the record, the
// win/lose split shown right under "Next Game" (not in its own separate card), a "Completed
// Games" section for the played game, and a "Path to the Finish" section (renamed from "All
// Possible Upcoming Games") for the one still-unplayed game. REGENCY's real fixture can't
// cover this: by now its actual run in the frozen Superfinals data is already over.
vm.runInContext(`
  TD.games.push(
    { date: '2026-06-20', time: '8:00 AM', location: 'TEST COURT', game_id: 'TESTC01',
      white: 'A1-TEAMA', white_score: 10, dark: 'A2-TEAMC', dark_score: 5, round: 'A bracket',
      division: 'TEST_DIV2', played: true },
    { date: '2026-06-21', time: '2:00 PM', location: 'TEST COURT', game_id: 'TESTC02',
      white: 'TEAMA', white_score: null, dark: 'TEAMB', dark_score: null, round: '1st',
      division: 'TEST_DIV2', played: false }
  );
  TD.teams.push({ name: 'TEAMA', division: 'TEST_DIV2' }, { name: 'TEAMB', division: 'TEST_DIV2' }, { name: 'TEAMC', division: 'TEST_DIV2' });
  resolvedCache = {};
  selectTeam('TEAMA', 'TEST_DIV2');
`, sandbox);
const midHtml = el('myTeamContent').innerHTML;
check('My Team stat row promotes Best Case/Worst Case (Coming is gone)', midHtml.includes('Best Case') && midHtml.includes('Worst Case') && !midHtml.includes('>Coming<'));
check('My Team shows the win/lose split right after Next Game, not a separate Path-to-Finish card', /Next Game[\s\S]*?If they win[\s\S]*?If they lose/.test(midHtml));
check('My Team has a Completed Games section', midHtml.includes('Completed Games'));
check('My Team has a Path to the Finish section (renamed from All Possible Upcoming Games)', midHtml.includes('Path to the Finish') && !midHtml.includes('All Possible Upcoming Games'));
check('Completed Games section appears before Path to the Finish', midHtml.indexOf('Completed Games') < midHtml.indexOf('Path to the Finish'));

// Placement Tracker rows should be numbered by rank.
vm.runInContext("showTab('schedule')", sandbox);
const trackerHtmlForRank = el('scheduleContent').innerHTML;
check('Placement Tracker rows show a rank number', /class="tracker-name"><span class="rank-num">1<\/span>/.test(trackerHtmlForRank));

// selectBracket must refresh whichever tab is currently active, not always the Bracket tab --
// previously switching brackets while on the Tournament tab left scheduleContent stale until
// you navigated away and back.
vm.runInContext("selectBracket('18U_GIRLS_D1')", sandbox);
check('selectBracket refreshes the Tournament tab immediately when it is active', el('scheduleContent').innerHTML.includes('18U'));
vm.runInContext("selectBracket('16U_GIRLS_D1'); showTab('standings'); selectBracket('18U_GIRLS_D1');", sandbox);
check('selectBracket refreshes the Bracket tab immediately when it is active', el('standingsContent').innerHTML.includes('18U'));

// ===========================================================================================
// Direct unit tests for the app's pure helper functions (called straight, not via DOM smoke).
// ===========================================================================================
const appFn = (name) => vm.runInContext(name, sandbox);

// pickDefaultTournamentId: a /t/<id> URL should win over localStorage/default when the id is
// real, and be silently ignored (falling back to normal behavior) when it's not -- a stale
// bookmark or a typo'd share link must never crash or strand the user on a blank tournament.
const pickDefaultTournamentId = appFn('pickDefaultTournamentId');
sandbox.location.pathname = '/t/2026-boys-futures-superfinals';
check('pickDefaultTournamentId honors a valid /t/<id> URL', pickDefaultTournamentId() === '2026-boys-futures-superfinals');
sandbox.location.pathname = '/t/not-a-real-tournament';
check('pickDefaultTournamentId ignores an unknown /t/<id> and falls back normally', pickDefaultTournamentId() !== 'not-a-real-tournament');
sandbox.location.pathname = '/';

// updatePageMeta keeps the canonical <link> in sync with whichever tournament is active --
// otherwise a crawler that renders the JS after a client-side switch sees a stale canonical
// still pointing at the tournament that was active on first load.
vm.runInContext("selectTournament('2026-boys-futures-superfinals')", sandbox);
check('updatePageMeta updates the canonical link to the active tournament\'s /t/<id> URL',
  canonicalEl._href === 'https://splashbracket.com/t/2026-boys-futures-superfinals');
vm.runInContext("selectTournament('2026-girls-us-club-championships')", sandbox);

// shortGameId strips the division prefix to just the per-game number. For the Boys
// "{age}{B}D{div}{num}" id shape the division digit is part of the prefix and is dropped too
// ("14BD310" -> "10"); the Girls "{DIVISION}-{NNN}" shape keeps the full trailing number
// including any leading zero ("14U_GIRLS-011" -> "011").
const shortGameId = appFn('shortGameId');
check('shortGameId strips a "{DIVISION}-{NNN}" prefix', shortGameId('18U_GIRLS-127') === '127');
check('shortGameId drops the division digit of a "{age}{B}D{div}{num}" id', shortGameId('14BD310') === '10');
check('shortGameId handles the old Girls "{n}GD{d}{num}" id', shortGameId('16GD133') === '33');
check('shortGameId preserves a leading zero', shortGameId('14U_GIRLS-011') === '011');

// ordWord: the 11th/12th/13th teens are all "th" despite ending in 1/2/3.
const appOrdWord = appFn('ordWord');
check('ordWord 1/2/3 use st/nd/rd', appOrdWord(1) === '1st' && appOrdWord(2) === '2nd' && appOrdWord(3) === '3rd');
check('ordWord 11/12/13 are all "th" (teens exception)', appOrdWord(11) === '11th' && appOrdWord(12) === '12th' && appOrdWord(13) === '13th');
check('ordWord 21/111 resume the normal suffix', appOrdWord(21) === '21st' && appOrdWord(111) === '111th');

// Build one synthetic division to drive recordFor / allFinalPlacements / the tracker sort
// against, so these don't depend on the constantly-changing live data. A1-WIN beats A2-LOSE in
// a shootout (8.3 vs 8.1); a "3rd 3v4" game is a real absolute placement; a "3rd/4thB" game is
// group-relative and must NOT be read as an absolute place.
vm.runInContext(`
  TD.games.push(
    { date: 'd', time: '8:00 AM', location: 'X', game_id: 'ZT1', white: 'A1-WIN', white_score: 8.3, dark: 'A2-LOSE', dark_score: 8.1, round: 'A bracket', division: 'ZT', played: true },
    { date: 'd', time: '9:00 AM', location: 'X', game_id: 'ZT2', white: 'C1-THIRDWIN', white_score: 10, dark: 'C2-THIRDLOSE', dark_score: 6, round: '3rd 3v4', division: 'ZT', played: true },
    { date: 'd', time: '10:00 AM', location: 'X', game_id: 'ZT3', white: 'D1-RELWIN', white_score: 10, dark: 'D2-RELLOSE', dark_score: 6, round: '3rd/4thB', division: 'ZT', played: true }
  );
  ['WIN','LOSE','THIRDWIN','THIRDLOSE','RELWIN','RELLOSE'].forEach((n) => TD.teams.push({ name: n, division: 'ZT' }));
  resolvedCache = {};
`, sandbox);
const ztResolved = vm.runInContext("getResolved('ZT')", sandbox);
const ztRecord = appFn('recordFor')(ztResolved, 'WIN');
check('recordFor credits a shootout win', ztRecord.w === 1 && ztRecord.l === 0);
check('recordFor excludes shootout decimals from goal differential (8-8, not 8.3-8.1)', ztRecord.gf - ztRecord.ga === 0);
const ztPlacements = appFn('allFinalPlacements')(ztResolved, 6);
check('allFinalPlacements reads an absolute "3rd 3v4" decider (winner 3rd, loser 4th)', ztPlacements.get('THIRDWIN') === 3 && ztPlacements.get('THIRDLOSE') === 4);
check('allFinalPlacements does NOT treat a group-relative "3rd/4thB" as an absolute place', ztPlacements.get('RELWIN') === undefined && ztPlacements.get('RELLOSE') === undefined);

// A sibling band labeled "1-3 RR" but still missing one game must still reserve places 1-3 --
// otherwise the leftover-gap inference below would (wrongly) see 5 open slots instead of 2 and
// refuse to place the unlabeled "Y bracket" pair at all. Regression test for a real bug: 12U
// Girls' bottom 5-team bracket carried no "7-11 RR" label, and its sibling "1-3 RR" band still
// had one pending game, so every team in the unlabeled bracket showed a flat "TBD" even though
// 3 of the 5 had already played every game they'd ever play.
vm.runInContext(`
  TD.games.push(
    { date: 'd', time: '8:00 AM', location: 'X', game_id: 'ZU1', white: 'X1-NEWPORTX', white_score: 10, dark: 'X3-DELMARX', dark_score: 2, round: '1-3 RR', division: 'ZU', played: true },
    { date: 'd', time: '9:00 AM', location: 'X', game_id: 'ZU2', white: 'X2-LAMORINDAX', white_score: 9, dark: 'X3-DELMARX', dark_score: 3, round: '1-3 RR', division: 'ZU', played: true },
    { date: 'd', time: '10:00 AM', location: 'X', game_id: 'ZU3', white: 'X1-NEWPORTX', white_score: null, dark: 'X2-LAMORINDAX', dark_score: null, round: '1-3 RR', division: 'ZU', played: false },
    { date: 'd', time: '8:00 AM', location: 'X', game_id: 'ZU4', white: 'Y1-TEAMY1', white_score: 6, dark: 'Y2-TEAMY2', dark_score: 4, round: 'Y bracket', division: 'ZU', played: true }
  );
  ['NEWPORTX','LAMORINDAX','DELMARX','TEAMY1','TEAMY2'].forEach((n) => TD.teams.push({ name: n, division: 'ZU' }));
  resolvedCache = {};
`, sandbox);
const zuResolved = vm.runInContext("getResolved('ZU')", sandbox);
const zuPlacements = appFn('allFinalPlacements')(zuResolved, 5);
check('allFinalPlacements infers an unlabeled terminal band from a labeled-but-pending sibling', zuPlacements.get('TEAMY1') === 4 && zuPlacements.get('TEAMY2') === 5);
check('allFinalPlacements leaves the genuinely undecided sibling band unresolved', !zuPlacements.has('NEWPORTX') && !zuPlacements.has('LAMORINDAX') && !zuPlacements.has('DELMARX'));

// Placement Tracker sort order: best reachable place (ceiling) leads; ties on the range break
// on record, then goal differential. HIGH/HIGH2 are still in pool (can reach 1st) so they lead
// the three "5-7 RR" teams (capped at 5th); among those three, KONE's 2-0 record sorts it ahead.
vm.runInContext(`
  TD.games.push(
    { date: 'd', time: '8:00 AM', location: 'X', game_id: 'ST1', white: 'A1-HIGH', white_score: null, dark: 'A2-HIGH2', dark_score: null, round: 'A bracket', division: 'SORTT', played: false },
    { date: 'd', time: '8:00 AM', location: 'X', game_id: 'ST2', white: 'K1-KONE', white_score: 10, dark: 'K2-KTWO', dark_score: 3, round: '5-7 RR', division: 'SORTT', played: true },
    { date: 'd', time: '9:00 AM', location: 'X', game_id: 'ST3', white: 'K1-KONE', white_score: 11, dark: 'K3-KTHREE', dark_score: 2, round: '5-7 RR', division: 'SORTT', played: true },
    { date: 'd', time: '10:00 AM', location: 'X', game_id: 'ST4', white: 'K2-KTWO', white_score: null, dark: 'K3-KTHREE', dark_score: null, round: '5-7 RR', division: 'SORTT', played: false }
  );
  ['HIGH','HIGH2','KONE','KTWO','KTHREE'].forEach((n) => TD.teams.push({ name: n, division: 'SORTT' }));
  resolvedCache = {};
  selectBracket('SORTT');
  showTab('schedule');
`, sandbox);
const sortTracker = el('scheduleContent').innerHTML;
const sortOrder = [...sortTracker.matchAll(/rank-num">(\d+)<\/span>([A-Z0-9 ]+?)(?:<| )/g)].map((m) => m[2].trim());
check('Tracker sort: higher-ceiling pool teams (can reach 1st) lead lower-capped placement teams', sortOrder.indexOf('HIGH') < sortOrder.indexOf('KONE') && sortOrder.indexOf('HIGH2') < sortOrder.indexOf('KONE'));
check('Tracker sort: among teams with the same range, the better record sorts first', sortOrder.indexOf('KONE') < sortOrder.indexOf('KTWO') && sortOrder.indexOf('KONE') < sortOrder.indexOf('KTHREE'));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
