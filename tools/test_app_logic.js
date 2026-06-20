// Smoke-test the app's inline JS logic without a real browser: stub document/localStorage,
// load resolver + data + the <script> body extracted from tournament_app.html, then drive
// the same functions a user interaction would call and sanity-check the produced HTML.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'tournament_app.html'), 'utf8');
const m = /<script>([\s\S]*?)<\/script>\s*<\/body>/.exec(html);
if (!m) throw new Error('could not find inline <script> body');
const appJs = m[1];

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

vm.runInContext("showTab('standings')", sandbox);
const standingsHtml = el('standingsContent').innerHTML;
check('Standings renders group tables', standingsHtml.includes('Group B'));
check('Standings shows Placement Tracker', standingsHtml.includes('Placement Tracker'));
check('Standings tracker has a tier class', /tier-(gold|mid|low)/.test(standingsHtml));

vm.runInContext("showTab('schedule')", sandbox);
const scheduleHtml = el('scheduleContent').innerHTML;
check('Schedule renders total game count', /\d+ total games/.test(scheduleHtml));
check('Schedule shows resolved bracket labels, not raw tokens', !scheduleHtml.includes('>W#') );

// Tournament switcher: re-selecting the same (only) tournament should be a no-op, not crash.
vm.runInContext("selectTournament('2026-girls-futures-superfinals')", sandbox);
check('Re-selecting current tournament does not crash', true);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
