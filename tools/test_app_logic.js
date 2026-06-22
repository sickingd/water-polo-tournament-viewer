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
  constructor() { this.innerHTML = ''; this.textContent = ''; this._classes = new Set(); this.value = ''; }
  get classList() {
    const self = this;
    return {
      add: (c) => self._classes.add(c),
      remove: (c) => self._classes.delete(c),
      contains: (c) => self._classes.has(c),
    };
  }
}

const elements = new Map();
function el(id) {
  if (!elements.has(id)) elements.set(id, new FakeEl());
  return elements.get(id);
}

const store = new Map();
const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  addEventListener: () => {},
  document: {
    getElementById: (id) => el(id),
    querySelectorAll: () => [],
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
vm.runInContext(appJs, sandbox, { filename: 'tournament_app.html(inline)' });

let failures = 0;
function check(label, cond) {
  if (!cond) { failures++; console.error('FAIL:', label); } else { console.log('PASS:', label); }
}

check('initial My Team prompt shown', el('myTeamContent').innerHTML.includes('Choose Your Team'));

vm.runInContext("selectTeam('REGENCY', '16U_GIRLS_D1')", sandbox);
const myTeamHtml = el('myTeamContent').innerHTML;
check('My Team header shows team name', el('favTeamName').textContent === 'REGENCY');
check('My Team shows age chip', el('favTeamChips').innerHTML.includes('age-16U'));
check('My Team content renders games', myTeamHtml.includes('game-card'));
check('My Team shows scenario card', myTeamHtml.includes('Path to the Finish'));
check('My Team scenario shows a best/worst case range', myTeamHtml.includes('Best Case') && myTeamHtml.includes('Worst Case'));

// --- Bracket tab: viewing bar + group standings + Game#-ordered schedule (no tracker here) ---
vm.runInContext("showTab('standings')", sandbox);
const standingsHtml = el('standingsContent').innerHTML;
check('Bracket tab shows the viewing bar for the favorite division', standingsHtml.includes('Viewing Bracket') && standingsHtml.includes('16U'));
check('Bracket tab renders group tables', standingsHtml.includes('Group B'));
check('Bracket tab does NOT show the Placement Tracker (moved to Tournament tab)', !standingsHtml.includes('Placement Tracker'));
check('Bracket tab renders that division\'s game cards', standingsHtml.includes('game-card'));

// Game# ordering within the Bracket tab's schedule, using the data-game-id attribute.
// "16GD1xx" is 16U_GIRLS_D1; "16GD2xx" (16U_GIRLS_D2) also starts with "16GD" so the division
// digit must be pinned, or this picks up both divisions' games interleaved.
const div16GameIds = [...standingsHtml.matchAll(/data-game-id="(16GD1\d+)"/g)].map((m) => m[1]);
const sortedCheck = div16GameIds.every((id, i) => i === 0 || sandbox.Resolver.localNumber(div16GameIds[i - 1]) <= sandbox.Resolver.localNumber(id));
check('Bracket tab games are ordered by Game# (localNumber), ascending', sortedCheck && div16GameIds.length > 0);

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
check('Placement Tracker shows a next-opponent hint', scheduleHtml.includes('tracker-next'));
check('Placement Tracker opponent hints are short (no nested matchup parens)', !/tracker-next">\(vs [^)]*\([^)]*\(/.test(scheduleHtml));

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

vm.runInContext("selectTeam('TESTLOSER', 'TEST_DIV')", sandbox);
const loserHtml = el('myTeamContent').innerHTML;
check('4th place shows final-placement banner without trophy styling', loserHtml.includes('final-placement') && !loserHtml.includes('top3') && !loserHtml.includes('🏆'));
check('4th place banner shows "4th"', loserHtml.includes('4th'));

// Game# should be visibly shown on each game card (not just available as a data attribute).
vm.runInContext("selectTeam('REGENCY', '16U_GIRLS_D1'); showTab('standings');", sandbox);
const bracketHtmlForGameNum = el('standingsContent').innerHTML;
check('Bracket tab visibly shows the Game# on each card', /class="game-number">16GD1\d+</.test(bracketHtmlForGameNum));

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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
