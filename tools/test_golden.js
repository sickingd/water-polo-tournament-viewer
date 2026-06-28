// Golden-snapshot lock for the two COMPLETED (frozen) tournaments.
//
// The data-invariant sweep (test_data_invariants.js) proves nothing CRASHES or shows TBD; this
// proves the actual resolved VALUES never change. For each completed tournament it snapshots,
// per division: every group's ranked standings order, every team's final placement, and every
// game's resolved white/dark team + status. That whole snapshot is committed under
// tools/golden/. Because these tournaments are over (their data files are frozen forever), any
// future resolver change that alters who finished where, how a group ranked, or how any token
// resolved -- in a tournament whose real-world outcome is settled history -- is a regression by
// definition, and this test fails loudly with a per-key diff.
//
// Regenerate intentionally (only after a deliberate, reviewed logic change) with:
//   node tools/test_golden.js --update
// Never run --update just to make a red test go green without understanding the diff.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const GOLDEN_DIR = path.join(__dirname, 'golden');
const UPDATE = process.argv.includes('--update');

const html = fs.readFileSync(path.join(ROOT, 'tournament_app.html'), 'utf8');
const appJs = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];

class FakeEl {
  constructor() { this.innerHTML = ''; this.textContent = ''; this._classes = new Set(); this.value = ''; this.style = {}; }
  get classList() { const s = this; return { add: (c) => s._classes.add(c), remove: (c) => s._classes.delete(c), contains: (c) => s._classes.has(c), toggle: () => {} }; }
}
const elements = new Map();
const sandbox = {
  console,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  addEventListener: () => {},
  document: { getElementById: (id) => { if (!elements.has(id)) elements.set(id, new FakeEl()); return elements.get(id); }, querySelectorAll: () => [] },
  setTimeout: () => {}, setInterval: () => {},
};
sandbox.global = sandbox; sandbox.globalThis = sandbox; sandbox.window = sandbox;
vm.createContext(sandbox);
function load(file) { vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file }); }
load('src/resolver.js');
load('data/manifest.js');

// Load ALL data files so the app can initialize (its default-tournament pick from the manifest
// is a live tournament, and the inline script touches that tournament's data at load time)...
['2026-girls-futures-superfinals', '2026-girls-us-club-championships', '2026-boys-us-club-championships', '2026-boys-futures-superfinals']
  .forEach((id) => load(`data/${id}.js`));
vm.runInContext(appJs, sandbox, { filename: 'tournament_app.html(inline)' });

// ...but only SNAPSHOT the COMPLETED tournaments -- a live tournament's data file changes on
// every auto-refresh, so a value snapshot of it would churn constantly and lock in nothing.
const COMPLETED = ['2026-girls-futures-superfinals', '2026-boys-us-club-championships'];

const Resolver = sandbox.Resolver;
const TOURNAMENTS = sandbox.TOURNAMENTS;

function snapshotTournament(tid) {
  const td = TOURNAMENTS[tid];
  vm.runInContext(`selectTournament(${JSON.stringify(tid)})`, sandbox);
  const divisions = [...new Set(td.teams.map((t) => t.division))].sort();
  const out = {};
  for (const division of divisions) {
    const divTeams = td.teams.filter((t) => t.division === division).map((t) => t.name).sort();
    const resolved = vm.runInContext(`getResolved(${JSON.stringify(division)})`, sandbox);

    const standings = {};
    Object.keys(resolved.standings).sort().forEach((let_) => {
      standings[let_] = resolved.standings[let_].ranked.map((r) => r.name);
    });

    const finalPlacements = {};
    divTeams.forEach((name) => {
      const fp = vm.runInContext('finalPlacementFor', sandbox)(resolved, name, divTeams.length);
      finalPlacements[name] = fp == null ? null : fp;
    });

    const games = {};
    resolved.games.slice().sort((a, b) => (a.game_id < b.game_id ? -1 : 1)).forEach((g) => {
      games[g.game_id] = `${g.whiteTeam || '?'} | ${g.darkTeam || '?'} | ${g.status}`;
    });

    out[division] = { standings, finalPlacements, games };
  }
  return out;
}

let failures = 0;
function diffKeys(goldenObj, currentObj, prefix) {
  const keys = new Set([...Object.keys(goldenObj), ...Object.keys(currentObj)]);
  for (const k of keys) {
    const a = goldenObj[k], b = currentObj[k];
    const ja = JSON.stringify(a), jb = JSON.stringify(b);
    if (ja !== jb) {
      failures++;
      console.error(`FAIL ${prefix}${k}:\n    golden:  ${ja}\n    current: ${jb}`);
    }
  }
}

if (!fs.existsSync(GOLDEN_DIR)) fs.mkdirSync(GOLDEN_DIR, { recursive: true });

for (const tid of COMPLETED) {
  const snap = snapshotTournament(tid);
  const goldenPath = path.join(GOLDEN_DIR, `${tid}.json`);
  if (UPDATE || !fs.existsSync(goldenPath)) {
    fs.writeFileSync(goldenPath, JSON.stringify(snap, null, 2) + '\n');
    console.log(`${UPDATE ? 'Updated' : 'Created'} golden: ${path.relative(ROOT, goldenPath)}`);
    continue;
  }
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  // Compare per-division, per-section so a diff points at exactly what changed.
  const divisions = new Set([...Object.keys(golden), ...Object.keys(snap)]);
  for (const division of divisions) {
    if (!golden[division]) { failures++; console.error(`FAIL ${tid}: division ${division} not in golden (new?)`); continue; }
    if (!snap[division]) { failures++; console.error(`FAIL ${tid}: division ${division} missing from current output`); continue; }
    diffKeys(golden[division].standings, snap[division].standings, `${tid}/${division}/standings/`);
    diffKeys(golden[division].finalPlacements, snap[division].finalPlacements, `${tid}/${division}/place/`);
    diffKeys(golden[division].games, snap[division].games, `${tid}/${division}/game/`);
  }
  console.log(`Checked golden: ${tid} (${Object.keys(snap).length} divisions)`);
}

if (UPDATE) { console.log('\nGolden files written.'); process.exit(0); }
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
