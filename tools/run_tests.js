// Single entry point for the whole test suite -- `npm test`.
//
// Runs every test file in its own child process (so a hard crash in one doesn't abort the
// rest), streams each one's output, and exits non-zero if ANY file failed. Unlike chaining with
// `&&`, this always runs all of them so one failure never hides another.
const { spawnSync } = require('child_process');
const path = require('path');

const TESTS = [
  'test_resolver.js',      // resolver unit + regression tests (hand-built fixtures)
  'test_app_logic.js',     // app render-layer logic (resolver + inline <script>, DOM stubbed)
  'test_data_invariants.js', // brute-force sweep over ALL committed data: no throw/TBD/inverted range
  'test_golden.js',        // value-lock snapshot of the two completed (frozen) tournaments
  'test_static_assets.js', // no relative asset refs -- breaks at any path depth other than /
];

let anyFailed = false;
for (const t of TESTS) {
  const file = path.join(__dirname, t);
  console.log(`\n${'='.repeat(78)}\n  ${t}\n${'='.repeat(78)}`);
  const res = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (res.status !== 0) anyFailed = true;
}

console.log(`\n${'='.repeat(78)}`);
console.log(anyFailed ? 'SUITE FAILED -- see failures above.' : 'SUITE PASSED -- all test files green.');
process.exit(anyFailed ? 1 : 0);
