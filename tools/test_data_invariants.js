// Data-driven invariant sweep -- the "never regress on real data" guarantee.
//
// Loads the resolver + the app's inline render logic + EVERY committed tournament data file
// (both frozen/completed tournaments AND the live ones' last committed snapshot), then drives
// the exact same code path the UI uses to render every division of every tournament. Asserts
// the cross-cutting invariants that took many incident-driven fixes to achieve:
//
//   1. resolveDivision / buildScenarios / buildAllPossibleGames never throw, for any team.
//   2. No inverted range: a team's projected ceiling (best place) is never worse than its
//      floor (worst place) -- "floor < ceiling" was the signature of every false-certainty bug.
//   3. No TBD in the Placement Tracker: every team renders either a locked final placement or
//      a real best-worst range, never the "TBD" fallback. (Driven through the app's actual
//      placementTrackerHTML so it stays faithful to what a user sees, finalPlacementFor /
//      flatRankFor fallbacks included.)
//   4. Every team in the division appears exactly once in its tracker (none silently dropped).
//
// Unlike the targeted regression cases in test_resolver.js (each a hand-built minimal
// reproduction of one bug), this is a brute-force sweep over all 500+ real teams across all
// 31 real divisions -- it's what catches a future change that breaks some scenario shape we
// didn't think to write a unit test for. The two COMPLETED tournaments' data is frozen, so
// those assertions are a permanent golden lock; the two LIVE tournaments' data is whatever
// was last committed, so the sweep validates that snapshot on every run.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'tournament_app.html'), 'utf8');
const appJs = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];

class FakeEl {
  constructor() { this.innerHTML = ''; this.textContent = ''; this._classes = new Set(); this.value = ''; this.style = {}; }
  get classList() {
    const self = this;
    return { add: (c) => self._classes.add(c), remove: (c) => self._classes.delete(c), contains: (c) => self._classes.has(c), toggle: () => {} };
  }
}
const elements = new Map();
function el(id) { if (!elements.has(id)) elements.set(id, new FakeEl()); return elements.get(id); }
const store = new Map();
const sandbox = {
  console,
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  addEventListener: () => {},
  location: { pathname: '/' },
  history: { replaceState: () => {}, pushState: () => {} },
  document: { getElementById: (id) => el(id), querySelectorAll: () => [], querySelector: () => null },
  setTimeout: () => {}, setInterval: () => {},
};
sandbox.global = sandbox; sandbox.globalThis = sandbox; sandbox.window = sandbox;
vm.createContext(sandbox);
function load(file) { vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file }); }
load('src/resolver.js');
load('data/manifest.js');
const DATA_FILES = [
  '2026-girls-futures-superfinals',
  '2026-girls-us-club-championships',
  '2026-boys-us-club-championships',
  '2026-boys-futures-superfinals',
];
DATA_FILES.forEach((id) => load(`data/${id}.js`));
vm.runInContext(appJs, sandbox, { filename: 'tournament_app.html(inline)' });

let failures = 0;
function fail(msg) { failures++; console.error('FAIL:', msg); }

const Resolver = sandbox.Resolver;
const TOURNAMENTS = sandbox.TOURNAMENTS;

let totalTeams = 0, totalDivisions = 0;
for (const tid of DATA_FILES) {
  const td = TOURNAMENTS[tid];
  if (!td) { fail(`tournament data missing: ${tid}`); continue; }
  // Point the app at this tournament so placementTrackerHTML/getResolved use its data.
  vm.runInContext(`selectTournament(${JSON.stringify(tid)})`, sandbox);
  const divisions = [...new Set(td.teams.map((t) => t.division))];
  for (const division of divisions) {
    totalDivisions++;
    const divTeams = td.teams.filter((t) => t.division === division);
    let resolved;
    try {
      resolved = vm.runInContext(`getResolved(${JSON.stringify(division)})`, sandbox);
    } catch (e) {
      fail(`${tid} / ${division}: getResolved threw: ${e.message}`);
      continue;
    }

    // Resolver-level invariants per team: no throw, no inverted range.
    for (const t of divTeams) {
      totalTeams++;
      let scen;
      try {
        scen = Resolver.buildScenarios(resolved.ctx, t.name, divTeams.length);
      } catch (e) {
        fail(`${tid} / ${division} / ${t.name}: buildScenarios threw: ${e.message}`);
        continue;
      }
      if (scen && scen.floor != null && scen.ceiling != null && scen.floor < scen.ceiling) {
        fail(`${tid} / ${division} / ${t.name}: inverted range (ceiling ${scen.ceiling} > floor ${scen.floor})`);
      }
      try {
        Resolver.buildAllPossibleGames(resolved.ctx, t.name);
      } catch (e) {
        fail(`${tid} / ${division} / ${t.name}: buildAllPossibleGames threw: ${e.message}`);
      }
    }

    // App-level invariant: the rendered Placement Tracker must show no "TBD" range and must
    // list every team in the division exactly once. This is the faithful end-to-end check --
    // it goes through finalPlacementFor / flatRankFor / buildScenarios exactly as the UI does.
    let trackerHtml;
    try {
      trackerHtml = vm.runInContext(`placementTrackerHTML(getResolved(${JSON.stringify(division)}), ${JSON.stringify(division)})`, sandbox);
    } catch (e) {
      fail(`${tid} / ${division}: placementTrackerHTML threw: ${e.message}`);
      continue;
    }
    const tbdMatches = (trackerHtml.match(/class="tracker-range[^"]*">TBD</g) || []).length;
    if (tbdMatches > 0) {
      fail(`${tid} / ${division}: Placement Tracker shows ${tbdMatches} TBD range(s)`);
    }
    const rowCount = (trackerHtml.match(/class="tracker-row/g) || []).length;
    if (rowCount !== divTeams.length) {
      fail(`${tid} / ${division}: tracker has ${rowCount} rows but division has ${divTeams.length} teams`);
    }
  }
}

console.log(`Swept ${totalTeams} teams across ${totalDivisions} divisions in ${DATA_FILES.length} tournaments.`);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
