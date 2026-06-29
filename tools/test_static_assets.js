// Static-analysis check, not a behavioral one: every local asset reference in
// tournament_app.html (script src, link href, img src) must be root-absolute ("/...") or a
// full external URL, never a bare relative path ("data/manifest.js", "logo.png", etc.).
//
// Why this matters: the app's plain HTML/JS render logic is exercised by loading files
// straight off disk in a Node vm sandbox (see test_app_logic.js) -- that proves the JS is
// correct, but it can never catch a browser's actual relative-URL resolution, because there's
// no real URL involved at all. The site is served at more than one path depth now
// (splashbracket.com/, /tournament_app, and /t/<id> for the SEO deep-link feature) -- a
// relative reference resolves against whichever path depth happens to be current, so the
// exact same HTML that works at "/" 404s every script/image it loads at "/t/<id>" (one path
// segment deeper). That's a real incident, not a hypothetical: shipping bare-relative refs
// alongside the /t/<id> feature took down the entire app (no data, no logo, nothing but the
// static footer) for any link/reload/share landing on a /t/<id> URL -- exactly the use case
// the feature exists for. This check is the cheap, fast guard against it recurring.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'tournament_app.html'), 'utf8');

let failures = 0;
function fail(msg) { failures++; console.error('FAIL:', msg); }

const ATTR_RE = /\b(?:src|href)="([^"]+)"/g;
let m;
let checked = 0;
while ((m = ATTR_RE.exec(html))) {
  const ref = m[1];
  // External URLs, root-absolute paths, fragments, and the mailto:/javascript: schemes some
  // attributes legitimately use are all fine -- only a bare relative path is the failure mode.
  if (/^(https?:|\/|#|mailto:|javascript:|data:)/.test(ref)) continue;
  checked++;
  fail(`tournament_app.html has a relative asset reference: "${ref}" -- must be root-absolute ("/${ref}") since this HTML is served at multiple path depths (/, /tournament_app, /t/<id>)`);
}

console.log(`Checked all src=/href= attributes in tournament_app.html (0 relative references allowed).`);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
