# Splash Bracket — Project Handoff (CLAUDE.md)

Auto-loaded by Claude Code. Captures the current architecture so work can continue in VS Code.
**This file was refreshed 2026-06-28** to match the deployed product; earlier versions described an
old single-file prototype and are obsolete.

## What this is

Splash Bracket is a **live, deployed** team-centric water polo tournament viewer at
**splashbracket.com** (`clubwaterpolo.com` 302-redirects over to it). A user picks a tournament, then
their team, and sees: their games (times/dates/locations), live results, division standings, **projected
future opponents and routes**, and **where the team can place** given the bracket and current results.
The "future routes + placement" feature that the original spec called the real prize is **built** (see
the resolver, below).

## Architecture (three deployables, one repo)

1. **Static-site Worker — `clubwaterpolo-site`** (`site-worker.js` + `wrangler.toml`). Cloudflare
   Workers Static Assets serving the repo. Redirects the old host to splashbracket.com and rewrites
   `/` → `/tournament_app`. `run_worker_first = true` so the redirect logic runs before asset serving.
2. **Live-data Worker — `clubwaterpolo-live`** (`worker/` + `worker/wrangler.toml`). Bound to
   `*/api/*`. A **staggered cron** (two patterns, every 6 min offset by 3 → ~3-min effective) polls each
   non-`completed` tournament, normalizes it, and writes to **KV** (`TOURNAMENT_KV`). `fetch()` serves
   `GET /api/tournaments/<id>` from KV and `POST /api/tournaments/<id>?refresh=now` for on-demand refresh.
3. **The app — `tournament_app.html`** (single self-contained file: CSS + vanilla JS). Loads baseline
   `data/<id>.js` + `data/manifest.js` at page load, then **polls `GET /api/tournaments/<id>`**
   (`cache: no-store`) for live updates. No build step, no framework.

**Data flow:** OneDrive/Google sheet → (cron) `clubwaterpolo-live` Worker normalizes → KV → app fetches
`/api/...` → `src/resolver.js` computes standings/brackets/placement client-side → render functions
draw the UI.

## Repo layout

| Path | What it is |
|------|-----------|
| `tournament_app.html` | The app. ~1,300 lines: render layer + an inline copy of resolver usage. Loaded for `/`. |
| `src/resolver.js` | **The brain.** Generic bracket resolver (~1,500 lines). Pure, UI-agnostic, runs client-side. Public API: `window.Resolver = { resolveDivision, buildScenarios, buildAllPossibleGames, groupEntrants, parseToken, localNumber }`. |
| `data/manifest.js` | `window.TOURNAMENT_MANIFEST` — list of tournaments + `current`/`completed` status. |
| `data/<id>.js` | Per-tournament baseline snapshot: `window.TOURNAMENTS[id] = { tournament, generated, games:[...] }`. Each game: `date,time,location,game_id,white,white_score,dark,dark_score,round,division,played`. WHITE/DARK hold **slot tokens** like `A1-NEWPORT BEACH A`, `2ndB-REGENCY`, `W#Cross1`. |
| `worker/index.js` | Live-data Worker: `scheduled()` (cron refresh) + `fetch()` (API). CSV-parsing mirrors `tools/refresh_data.py`. |
| `worker/onedrive.js` | OneDrive `.xlsx` fallback source (unzip + XML parse) for sheets not on Google. |
| `tools/sources.json` | Per-tournament source config: Google `sheet_id`(s) per division, OneDrive fallback, `cron_group` (A/B → which cron pattern handles it), `status`. |
| `tools/refresh_data.py` | Local/CI data refresh; regenerates `data/<id>.js`. Skips `completed` tournaments. |
| `tools/run_tests.js` | `npm test` entry point; runs the suite below in isolated child processes. |
| `tools/test_resolver.js` | Resolver unit + regression tests (hand-built fixtures). |
| `tools/test_app_logic.js` | App render-layer logic (resolver + inline `<script>`, DOM stubbed). |
| `tools/test_data_invariants.js` | Brute-force sweep over all committed data: no throw / no stray TBD / no inverted placement range. |
| `tools/test_golden.js` | Value-lock snapshots of the two frozen/completed tournaments (`tools/golden/*.json`). Update with `npm run test:golden:update`. |
| `.github/workflows/refresh-data.yml` | Hourly **durable snapshot** to git (NOT the live mechanism — the Worker is). Commits `data/` changes. |
| `_headers` | Cloudflare `Cache-Control: no-cache` catch-all (GitHub Pages' fixed 10-min cache was the original staleness bug). |
| `.assetsignore` | Excludes non-public files from the static-assets upload. |
| `index.html` | Meta-refresh stub to `tournament_app.html` (the Worker normally serves `/` directly). |
| `TOURNAMENT_DATA_SPEC.md` | Reverse-engineered spec of the workbook + slot-token grammar. Still the authority for token meaning. |
| `IOS_APP_PLAN.md` | Plan for an iPhone app (Capacitor wrapper) + native-feature evaluation. Written against this stack. |
| `DESIGN_NOTES.md` | Older change log (the division-keying bug fix). |

## The app layer (`tournament_app.html`)

Multi-tournament, multi-sport (boys/girls × Futures / US Club Championships). Key functions:
`pickDefaultTournamentId`, `getResolved(division)` (memoized `Resolver.resolveDivision` call),
`renderMyTeam` / `renderStandings` / `renderSchedule`, `possibleGamesSectionHTML` + `scenarioBranchHTML`
(the projected-routes view), `placementTrackerHTML` / `finalPlacementFor` (placement floor/ceiling),
`pollLiveData` (the `/api` poll), and three pickers (tournament / bracket-division / team). State
(`favTeam`, `favDiv`, active tournament) lives in `localStorage`. Has Google Analytics (`gtag`/`track`)
and a `followedTeam` user property.

## Build / deploy / test

- **Install once:** `npm install`. **Test:** `npm test`. **Deploy:** `npm run deploy` (site + worker),
  or `deploy:site` / `deploy:worker` individually. Requires `wrangler` auth to the Cloudflare account.
- Domains live on Cloudflare zones `splashbracket.com` and `clubwaterpolo.com`.
- **Hosting is the Cloudflare Free plan** — it has real per-invocation CPU limits. The staggered cron
  and "one tournament per invocation" design exist *because* a single combined tick exceeded the limit
  and silently failed. Keep new per-tick work cheap, or move it off the cron (e.g. Cloudflare Queues).

## Critical domain facts & gotchas

- **Teams are keyed by (name + division), never name alone.** Many team names recur across divisions
  (e.g. LAMORINDA A in three). Every filter/lookup/standings map must include the division. This was a
  real bug that's been fixed — don't reintroduce it.
- **Order games by time/SORTKEY, never by GAME#** — game numbers interleave brackets and days. The app
  parses 12h time to minutes (`gameTS`).
- **Standings use round-robin (pool) games only**, and strip `^[A-H]\d-` group prefixes — bracket slot
  refs (`2ndB-REGENCY`, `W#Cross1`) must never create standings rows.
- **Slot tokens are the source of truth** for bracket topology; the resolver parses them generically
  (no hardcoded per-division-size flow). When a token already carries a cached `-{TEAM}` suffix, trust
  it; only walk the reference graph for bare tokens, and only project a *future* opponent when it's
  structurally unambiguous (else show "Winner of QF1").
- **Don't trust cached formula values** from the sheet blindly; recompute from raw scores.
- **Tiebreakers** (H2H → goal diff → goals against) should still be confirmed against the sheet's
  `RULES & GIRLS LINKS` for 3-way ties — see `TOURNAMENT_DATA_SPEC.md` §6.

## Adding a new tournament

Add an entry to `tools/sources.json` (sheet IDs / OneDrive fallback / `cron_group` / `status`), run
`tools/refresh_data.py` to generate `data/<id>.js`, list it in `data/manifest.js`, and add a matching
`<script src="data/<id>.js">` tag in `tournament_app.html`.
