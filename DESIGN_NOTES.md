# Tournament App — Update Notes (2026-06-20)

## The bug you reported

Scores got confused when the same team name appeared in different divisions. This is real:
**42 of 135 teams share a name with a team in another division.** Examples:

- `LAMORINDA A` → 12U_D1, 14U_D1, 16U_D1
- `SANTA BARBARA` → 12U_D2, 14U_D1, 16U_D1
- `RANCHO TSUNAMI`, `SAN DIEGO SHORES`, `SOUTH COAST` → three divisions each

**Root cause:** teams were keyed by bare name everywhere. The "My Team" view filtered games by
name only and ignored the selected division, so picking 16U Lamorinda A pulled in its 12U and 14U
games too — inflating the win/loss record and the schedule. (The real unique key is name + division;
the `game_id` prefix, e.g. `16GD1xx`, already encodes age + division as a cross-check.)

## What changed in this pass (bug fix + spec alignment)

1. **My Team is now division-scoped.** `renderMyTeam()` filters on `g.division === favDiv` *and* the
   team name. Verified: Lamorinda A now returns 4 / 3 / 3 games per division instead of 10 mixed.
2. **Highlighting is division-aware.** On the full-schedule tab, a game is only flagged as "your
   team's" when it's in your division — same-name teams elsewhere are no longer starred.
3. **Standings are round-robin-only and group-safe.** Standings now use only pool-play games and strip
   A–H group prefixes (was A–D). This drops bracket games whose cells hold slot refs (`2ndB-REGENCY`,
   `W#Cross1`), which previously created junk standings rows. Verified: 16U_D1 → exactly 24 clean teams.
4. **Correct chronological order.** Replaced the string sort (which put "10:00 AM" before "8:00 AM")
   with a parsed timestamp, matching the spec's "order by SORTKEY, not GAME#" rule.

No feature was removed; the app does the same things, just correctly per division.

## Known limitation still in the data

The embedded data (`TD.games`) is pre-resolved — bracket games store whatever team name was cached in
the spreadsheet at export time. The app does **not** yet compute standings/advancement itself, so any
unplayed or unresolved slot (e.g. the two unentered Friday 7 PM games that leave groups C and G open)
shows as a raw token rather than a projected team.

## Proposed next iteration (for us to discuss)

The spec describes the features that would deliver the project's real goal — "routes and options for
future games, and where a team can place." These need a resolver, not just better filtering:

1. **Slot-reference resolver** (spec §4, §6, §9). Parse `WHITE`/`DARK` tokens into typed refs
   (`{group}{pos}`, `W#/L#{round}`, placement seeds), compute group standings, then iterate the bracket
   to a fixpoint. Recompute from raw scores rather than trusting cached names.
2. **Projected vs. locked opponents.** Show "winner of Cross1" until the feeder game is final, then the
   real team — so your team's path is visible before games are played.
3. **Floor/ceiling placement** (spec §5). From a team's group finish, show the range of places it can
   still finish (e.g. a top-group runner-up = 1st–12th) and update it as results come in.
4. **Generic bracket flow.** The 24-team map (16U_D1, 18U_D1) is explicit in the spec, but 10/14/15/17/
   18/20/21-team divisions differ — parse flow from COMMENTS + slot refs rather than hardcoding.
5. **Live data (optional).** The workbook links to a Google Sheet; a live build would poll the CSV
   export on the same 11-column schema and re-run the resolver.

Suggested order: (1)+(2) first — they unlock the headline "future games / routes" view — then (3),
then (4) for full multi-division coverage.
