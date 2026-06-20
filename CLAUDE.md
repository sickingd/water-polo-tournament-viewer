# Water Polo Tournament Viewer — Project Handoff

This file is auto-loaded by Claude Code. It captures everything known about the project so work can
continue in VS Code.

## Goal

Turn a hard-to-read tournament workbook into a simple, team-centric viewer. A user picks their team and
sees: their games (times/dates/locations), results, division standings, and — the real prize — the
**routes and options for future games** and **where the team can place** given the bracket and current
results.

## Files in this folder

| File | What it is |
|------|-----------|
| `2026 GIRLS FUTURES SUPERFINALS.XLSX` | Source workbook. Multiple divisions in one file. The hard-to-read input. |
| `TOURNAMENT_DATA_SPEC.md` | **Read this first.** Reverse-engineered spec of the workbook: schema, game-ID convention, slot-reference grammar, the 24-team bracket flow, standings rules, the resolver algorithm, and gotchas. The authority for any new work. |
| `tournament_app.html` | Working prototype. Single self-contained file: embedded data (`const TD = {...}`), CSS, and vanilla-JS render functions. Mobile-style team viewer with tabs: My Team / Standings / Full Schedule + a team picker. |
| `DESIGN_NOTES.md` | Last session's change log + the proposed next-iteration plan (same plan is in §"Implementation plan" below). |
| `CLAUDE.md` | This handoff. |

## How the prototype works

`tournament_app.html` is one file. The data is **pre-exported** from the spreadsheet into a JS object
on line ~182:

```js
const TD = {
  tournament: "...",
  generated: "ISO timestamp",
  games: [ { date, time, location, game_id, white, white_score, dark, dark_score, round, division, played }, ... ],
  teams: [ { name, division }, ... ]
}
```

- ~416 games, 135 teams, 8 divisions: `{12U,14U,16U,18U}_GIRLS_{D1,D2}`.
- `game_id` encodes age+division: `16GD133` = 16U Girls D1, game 33. (See spec §3.)
- `round` is the raw COMMENTS descriptor, e.g. `"B bracket B1,B3"` (pool), `"Cross2 10v15"`, `"QF1"`.
- `played` is true only when both scores are present.
- Render functions: `renderMyTeam()`, `renderStandings()`, `renderSchedule()`, `gameCardHTML()`,
  `renderPickerList()` / `selectTeam()`. State is `favTeam` + `favDiv` in `localStorage`.

**Important:** bracket games in `TD.games` store whatever team name was cached in the sheet at export
time. The app does **not** compute advancement itself yet — unresolved slots show as raw tokens.

## Critical domain fact: teams are keyed by (name + division), never name alone

**42 of 135 team names appear in more than one division.** `LAMORINDA A` is in 12U_D1, 14U_D1, and
16U_D1; `SANTA BARBARA`, `RANCHO TSUNAMI`, `SAN DIEGO SHORES`, `SOUTH COAST` each span three. Any
filter, lookup, standings map, or dedupe MUST include the division (or `game_id` prefix). Keying by
bare name is the bug that was just fixed — don't reintroduce it.

## Bugs fixed last session (already in `tournament_app.html`)

1. **My Team division-scoped** — `renderMyTeam()` filters on `g.division === favDiv` AND team name
   (was name only, which mixed divisions).
2. **Highlight division-aware** — `gameCardHTML()` only stars a game as "yours" when `g.division === favDiv`.
3. **Standings round-robin-only + A–H prefix strip** — standings use only pool games
   (`/bracket/i.test(g.round)`) and strip `^[A-H]\d-` (was `^[A-D]\d-`), so bracket slot-refs
   (`2ndB-REGENCY`, `W#Cross1`) no longer create junk rows. 16U_D1 → exactly 24 clean teams.
4. **Chronological sort** — `gameTS(g)` parses 12h time into minutes; replaced the string sort that
   put "10:00 AM" before "8:00 AM". Spec rule: order by time/SORTKEY, never by GAME#.

## Implementation plan (next iteration — not yet built)

The pre-resolved data is the ceiling on what the prototype can do. Delivering "future routes + placement"
needs a **resolver** that recomputes the bracket from raw scores (spec §4, §6, §9). Build order:

1. **Slot-reference resolver (start here).** Parse each `white`/`dark` token into a typed reference:
   - `{group}{pos}-{TEAM}` round-robin entries (groups A–H, pos 1–3)
   - `{ord}{group}` group-finish refs (`1stB`, `2ndE`)
   - `W#/L#{round}` bracket progress (`W#Cross1`, `L#QF3`, `W#Semi1`)
   - `{LET}{n}({source})` + `W#/L#{LET}a/b` placement refs (LET ∈ J,K,M,N,P)

   Then: resolve round-robin games → compute group standings (spec §6; **verify tiebreakers against the
   `RULES & GIRLS LINKS` sheet** — currently assumed H2H → goal diff → goals against) → iterate the
   bracket in dependency order to a fixpoint. A ref resolves to a real team only when its feeder game is
   `final`; otherwise keep the token.

2. **Projected vs. locked opponents.** In the UI, show "Winner of Cross1" until that game finalizes,
   then the actual team. This is the headline feature — a team's path is visible before games happen.

3. **Floor/ceiling placement (spec §5).** From group finish, bound the places a team can still get
   (e.g. top-group runner-up = 1st–12th) and tighten it as results come in.

4. **Generic bracket flow.** The explicit 24-team map (16U_D1, 18U_D1) in spec §5 is only correct for
   24-team divisions. 10/14/15/17/18/20/21-team divisions differ — parse flow from COMMENTS + slot refs
   generically rather than hardcoding. Needed for full multi-division support.

5. **Live data (optional).** Workbook links to a Google Sheet. A live build polls its CSV export on the
   same 11-column schema and re-runs the resolver. Treat a missing score as "branch not locked," not an error.

### Test fixture (use to validate the resolver)

Spec §10 — Regency, 16U_GIRLS_D1:
- Day-1 results make Regency **2ndB**, entering at **Playin3** (`16GD133`, Sat 12:00 PM).
- Playin3 opponent = `W#Cross1` = winner of (`3rdA-680` vs `1stH-DIABLO ALLIANCE`).
- Win Playin3 → QF1 (`16GD141`) vs `1stD` = Patriot. Guaranteed final placement: 1st–12th.

### Data-extraction note (if regenerating `TD` from the .xlsx)

Use the `MASTER BY DIVISION` or `MASTER BY TIME` sheet (11 columns incl. SORTKEY). Key off **header-row
text**, not fixed column indices (columns can shift). Recompute from raw scores; don't trust cached
formula values (`data_only=True` may be stale). Ignore `CHICLETS OLD` (stale venues). See spec §2, §8, §11.

## Suggested architecture if rebuilding beyond a single HTML file

The current single-file app is fine for a prototype. If it grows, separate concerns:
`data/` (the `TD` export + a refresh script), `src/resolver.js` (pure functions: parse → standings →
bracket fixpoint → placement bounds; fully unit-testable against the Regency fixture), and `src/ui/`
(render layer). Keep the resolver UI-agnostic so it can be tested headless.

## Conventions / gotchas (from spec §11)

- Order by time/SORTKEY, **never GAME#** (numbers interleave brackets and days).
- COMMENTS formatting is inconsistent (`13-16` vs `9th-12th`, seed-shorthand `10v15`); parse leniently
  and treat the structured `W#/L#/{ord}{group}` tokens as source of truth.
- Two unentered Friday 7 PM games (`16GD123`, `16GD124`) leave groups C and G partially unresolved — the
  resolver must tolerate partial standings.
- Flow differs by division size — don't hardcode the 24-team map for other sizes.
