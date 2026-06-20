# Futures League Girls Superfinals — Spreadsheet & Bracket Spec

A reference for building a live, team-specific schedule/bracket viewer from the tournament workbook
(`2026_GIRLS_FUTURES_SUPERFINALS.XLSX`). Everything below was reverse-engineered from the file; items
that are inferred rather than certain are flagged **(assumption)**.

---

## 1. Big picture

- One workbook covers **multiple divisions**: 12U/14U/16U/18U, each split into Girls **D1** and **D2**,
  with team counts from 10 to 24. Each division is a separate single-elimination-with-consolation event.
- The data exists in two forms:
  1. **Flat master tables** (best for an app) — every game in one table, all divisions.
  2. **Per-division "bracket tabs"** — the same games laid out per venue/day, *plus* the bracket-flow
     definitions (who feeds which game). Useful for extracting the advancement rules.
- A team's full path is **conditional**: round-robin group finish decides the entry point, then each
  win/loss routes them through championship or placement brackets. The sheet encodes this with
  **slot references** (e.g. `2ndB`, `W#Cross1`, `L#QF3`) that resolve to real teams as scores come in.

---

## 2. Recommended data source: the master tables

Use **`MASTER BY DIVISION`** or **`MASTER BY TIME`** (identical schema, different row order).
~366 game rows covering all divisions. Columns:

| Col | Header | Meaning | Example |
|----|--------|---------|---------|
| A | `DATE` | Game date (datetime) | 2026-06-19 |
| B | `TIME` | Start time (time) | 10:00 |
| C | `LOCATION` | Venue | `WOOLLETT NEAR RIGHT` |
| D | `GAME#` | Unique game id | `16GD133` |
| E | `WHITE` | "White caps" team or slot ref | `2ndB-REGENCY` |
| F | `S` | White score (blank until played) | `11` |
| G | `DARK` | "Dark caps" team or slot ref | `W#Cross1` |
| H | `S` | Dark score (blank until played) | `14` |
| I | `COMMENTS` | Round / matchup descriptor | `Playin3` |
| J | `DIVISION` | Division tag (filter key) | `16U_GIRLS_D1` |
| K | `SORTKEY` | `YYYYMMDDHHMM` string | `202606201200` |

Notes:
- **Filter by `DIVISION`** to get one event. Filter `WHITE`/`DARK` for a team's games once slots resolve.
- **Always sort by `SORTKEY`** (or DATE+TIME), **never by `GAME#`** — game numbers are *not* chronological
  (e.g. `16GD148` is played Sunday, late in the M-bracket). GAME# is a stable id, not an order.
- A game is **final** when both score cells (F and H) are numeric. **Winner = higher score.**
- The `CHICLETS` sheet is a printable visual grid (by venue × time). `CHICLETS OLD` is a **stale draft**
  with different venues — ignore it. `TEAM LISTING AND BRACKETS` is a directory/seeding overview.

---

## 3. Game ID convention (`GAME#`)

Format: `{AGE}{G}{D}{DIV}{NN}` →  e.g. `16GD133`
- `16` = age group (12 / 14 / 16 / 18)
- `G`  = Girls
- `D`  = Division marker
- next digit = division number: `1` = D1, `2` = D2  → `16GD1xx` = 16U Girls D1, `16GD2xx` = D2
- `NN(N)` = sequential game number **within that division** (not globally unique across divisions only
  by combination; the full `GAME#` string is unique).

So `16GD1` is the prefix for the 24-team 16U Girls D1 event this spec focuses on.

---

## 4. Team labels and slot references (the resolver)

The `WHITE`/`DARK` cells hold one of these token types. Parsing/resolving these **is the core of the app**.

### 4a. Concrete group entry (round-robin games)
`{GROUP}{POS}-{TEAM}` where GROUP ∈ A..H, POS ∈ 1..3.
Examples: `B3-REGENCY`, `A1-STANFORD`, `C2-NEWPORT BEACH`.

### 4b. Group-finish reference
`{ORD}{GROUP}` and, once known, the sheet appends `-{TEAM}`.
ORD ∈ {`1st`,`2nd`,`3rd`}. Examples: `1stG` (unresolved), `2ndB-REGENCY`, `3rdC-GREENWICH`.
Resolve by computing the group's round-robin standings (see §6).

### 4c. Bracket-progress reference (championship side)
`W#{ROUND}` or `L#{ROUND}` — winner/loser of a prior game.
ROUND ∈ {`Cross1..4`, `Playin1..4`, `QF1..4`, `Semi1..2`}.
Examples: `W#Cross1`, `L#Playin3`, `W#QF2`, `L#Semi1`.

### 4d. Placement-bracket seeding
`{LET}{n}({SOURCE})` optionally `-{TEAM}`. LET ∈ {J,K,M,N,P}.
The parenthetical SOURCE is itself a §4b or §4c reference.
Examples: `J1(L#Cross1)`, `K1(2ndE)-SAN DIEGO SHORES`, `N2(L#Playin4)`, `P3(L#QF1)`.

### 4e. Placement-progress reference
`W#{LET}{a}/{b}` or `L#{LET}{a}/{b}` — winner/loser of the placement semifinal between that bracket's
seeds a and b. Examples: `W#N1/N4`, `L#P2/P3`, `W#J1/J4`.

### COMMENTS round descriptors (parallel signal to the above)
- Round robin: `{GROUP} bracket {pos},{pos}` → `B bracket B1,B3`
- `Cross{n} {x}v{y}` (the `x v y` are seed-shorthand, e.g. `Cross2 10v15`)
- `Playin{n}`, `QF{n}`, `Semi{n} {x}v{y}`
- Placement semis: `9th-12th semi 9v12`, `5th-8th semi 5v8`, `13-16 semi 16v13`
  *(formatting is inconsistent — sometimes `13-16`, sometimes `9th-12th`)*
- Placement round-robins: `17-20 RR K1,K4`, `21-24 RR M1,M4`
- Finals / placement finals: `1st`, `3rd`, `5th`, `7th`, `9th`, `11th`, `13th`, `15th`

---

## 5. The 24-team bracket flow (16U_GIRLS_D1 and 18U_GIRLS_D1)

**8 groups (A–H) of 3, single round-robin** (each team plays 2). Then:

### Group strength (from the SEEDING grid)
Overall seeds 1–24 are distributed so **A–D are the "top" groups** (seeds 1–12) and **E–H the "bottom"
groups** (seeds 13–24):

| Group | Seeds (pos1, pos2, pos3) |
|-------|--------------------------|
| A | 1, 8, 9 |
| B | 2, 7, 10 |
| C | 3, 6, 11 |
| D | 4, 5, 12 |
| E | 13, 20, 21 |
| F | 14, 19, 22 |
| G | 15, 18, 23 |
| H | 16, 17, 24 |

Consequence: **all 12 teams from A–D advance to the championship side; only the *winner* of each E–H
group does.** The 2nd/3rd of E–H go straight to the 17–24 placement round-robins.
*(The `16U GIRLS D1-24 TEAMS info` tab shows a different, generic snake-seed grid — treat the live
`16U GIRLS D1-24 TEAMS` tab as authoritative.)*

### Championship side (places 1–8)

**Crossovers** (3rd of a top group vs winner of a bottom group):
| Game | White | Dark |
|------|-------|------|
| Cross1 | 3rdA | 1stH |
| Cross2 | 3rdB | 1stG |
| Cross3 | 3rdC | 1stF |
| Cross4 | 3rdD | 1stE |

**Play-ins** (2nd of a top group vs a crossover winner):
| Game | White | Dark |
|------|-------|------|
| Playin1 | 2ndD | W#Cross3 |
| Playin2 | 2ndC | W#Cross4 |
| Playin3 | 2ndB | W#Cross1 |
| Playin4 | 2ndA | W#Cross2 |

**Quarterfinals** (1st of a top group vs a play-in winner):
| Game | White | Dark |
|------|-------|------|
| QF1 | 1stD | W#Playin3 |
| QF2 | 1stA | W#Playin2 |
| QF3 | 1stC | W#Playin4 |
| QF4 | 1stB | W#Playin1 |

**Semis / Finals:**
- Semi1 = W#QF2 vs W#QF1
- Semi2 = W#QF4 vs W#QF3
- 1st (Gold) = W#Semi1 vs W#Semi2
- 3rd (Bronze) = L#Semi1 vs L#Semi2

### Placement brackets (places 5–24)
Seeds are assigned from championship-side losers + the E–H non-winners:

| Bracket | Places | Seed sources |
|---------|--------|--------------|
| P | 5–8 | P1=L#QF4, P2=L#QF2, P3=L#QF1, P4=L#QF3 |
| N | 9–12 | N1=L#Playin3, N2=L#Playin4, N3=L#Playin1, N4=L#Playin2 |
| J | 13–16 | J1=L#Cross1, J2=L#Cross2, J3=L#Cross3, J4=L#Cross4 |
| K | 17–20 | K1=2ndE, K2=2ndF, K3=2ndG, K4=2ndH |
| M | 21–24 | M1=3rdE, M2=3rdF, M3=3rdG, M4=3rdH |

**P / N / J** run as 4-team single-elim (two semis, then a placement final + a 3rd/4th-of-bracket game):
- semis: `seed1 v seed4` and `seed2 v seed3`
- top final: `W# vs W#` (→ better place); lower final: `L# vs L#` (→ worse place)
- e.g. N: 9th = W#N1/N4 vs W#N2/N3; 11th = L#N1/N4 vs L#N2/N3

**K / M** run as **4-team round-robins** (6 games each: 1-4, 2-3, 1-3, 2-4, 1-2, 3-4); final standings
give 17th–20th (K) and 21st–24th (M).

### Floor/ceiling shortcut (handy for a viewer)
A team's group finish bounds its possible placement before any bracket game:
- **1st in a top group (A–D):** can finish 1st–8th (bye to QF).
- **2nd in a top group:** 1st–12th (enters at Play-in).
- **3rd in a top group:** 1st–16th (enters at Crossover; a crossover loss caps at 13th–16th).
- **1st in a bottom group (E–H):** 1st–16th (enters championship at Crossover).
- **2nd in a bottom group:** 17th–20th (K round-robin only).
- **3rd in a bottom group:** 21st–24th (M round-robin only).

> ⚠️ **Division-size dependence.** The mapping above is specific to **24-team** divisions
> (`16U_GIRLS_D1`, `18U_GIRLS_D1`). Divisions with 10/14/15/17/18/20/21 teams use *different* flows,
> each encoded in its own bracket tab. For a multi-division app, **parse the flow from the sheet's
> COMMENTS + slot references generically** rather than hardcoding this one. If you only target a chosen
> team in one 24-team division, the explicit tables above are enough.

---

## 6. Computing group standings (to resolve `1st/2nd/3rd`)

For each group: each team plays the other two. Win = higher score (both scores present).
Rank by **wins**, then tiebreakers. Per-division tabs carry helper columns (rank, team, score-pairs,
goal-diff like `+1`) suggesting the order is **(assumption)**:
1. Head-to-head result
2. Goal differential (goals for − against)
3. (then goals against / fewest allowed)

Confirm the exact tiebreaker order from the **`RULES & GIRLS LINKS`** sheet before trusting 3-way ties.
Two-team comparisons are unambiguous via head-to-head.

---

## 7. Calendar & venues (this event)

- **Day 1 — Fri 2026-06-19:** group round-robins.
- **Day 2 — Sat 2026-06-20:** crossovers → play-ins → QFs (championship side); placement RR + 13–16 semis.
- **Day 3 — Sun 2026-06-21:** semis, medal games, and all placement finals.
- Venues seen for 16U D1: `JSERRA CHS` (Fri), `WOOLLETT NEAR RIGHT`, `WOOLLETT LEFT`,
  `CHAPMAN UNIVERSITY`, `CAPISTRANO VALLEY HS`. Other divisions add `WOOLLETT FAR RIGHT`,
  `SAN CLEMENTE HS`, `EL MODENA HS`, `ESPERANZA HS`, `LA SERNA HS`, etc.
- Game length: 7-minute quarters (per the 16U D1 tab header). Slot spacing varies by division
  (16U is hourly; 12U uses 55-min slots).

---

## 8. Per-division bracket tab layout (for extracting flow / scraping)

Each `… TEAMS` tab (e.g. `16U GIRLS D1-24 TEAMS`) is laid out as:
- **Row 1:** title + format meta (`24 TEAMS`, `64 GAMES`, `24+22+18`, `7 minute quarters`).
- **`BRACKETS` grid (~rows 5–8):** 8 columns A–H, 3 rows → cells like `B3-REGENCY`.
- **`SEEDING` grid (~rows 10–14):** overall seed numbers per group position (see §5 table).
- **Schedule blocks:** repeated header rows `DATE | TIME | LOCATION | GAME# | WHITE | S | DARK | S |
  COMMENTS | DIVISION`, one block per venue/day. Same 10 columns as the master, minus SORTKEY.
- **Placement seed table (~rows 60–64):** defines `J/K/M/N/P` columns with their seed sources
  (e.g. `N2(L#Playin4)`, `K1(2ndE)-SAN DIEGO SHORES`).
- Slot cells **auto-resolve**: once a feeder game is final, the sheet appends the team name after a
  hyphen (`1stH-DIABLO ALLIANCE`). Unresolved slots stay bare (`1stG`).

---

## 9. Recommended app model & algorithm

**Data model**
```
Game {
  id            // GAME#  e.g. "16GD133"
  division      // "16U_GIRLS_D1"
  date, time, sortkey, location
  round         // parsed from COMMENTS: RR | Cross | Playin | QF | Semi | Final | PlacementSemi | PlacementFinal | PlacementRR
  whiteRef, darkRef   // raw slot tokens
  whiteTeam, darkTeam // resolved team names (null until known)
  whiteScore, darkScore // null until played
  status        // scheduled | final
}
Team { name, group, groupPos, seed }
```

**Resolution loop (recompute from raw scores — don't trust cached formula values):**
1. Load all rows for the division; parse each `WHITE`/`DARK` token into a typed reference (§4).
2. Resolve round-robin games first → compute group standings (§6) → map `1st/2nd/3rd{Group}` to teams.
3. Iterate the bracket in dependency order (Cross → Playin → QF → Semi → Final; and the placement
   feeds). For each final game, set `W#/L#` of that game; re-resolve dependents. Repeat to fixpoint.
4. A reference resolves to a concrete team only when its feeder game is `final`; otherwise show the
   token (or a "winner of game X" label) so the UI can display *projected* vs *locked* opponents.

**For a chosen team's view:** after resolution, a game belongs to the team if `whiteTeam`/`darkTeam`
equals the team **or** an unresolved ref *could* resolve to them (trace the dependency graph backward
from each slot to see whether the team is still alive in that branch). The §5 floor/ceiling table is a
cheap way to bound which future games are reachable.

**Live updates:** the workbook links to live "GOOGLE SCHEDULES" / "SUBMIT SCORES LOGIN" / "HOT! RESULTS"
sources, so scores originate in a Google Sheet **(assumption)**. For a live app, poll that sheet (CSV
export or Sheets API) on the same 11-column schema and re-run the resolver. Treat any single late or
missing score as "branch not yet locked," not as an error.

---

## 10. Worked example — Regency (16U_GIRLS_D1) as a test fixture

Use this to validate a resolver implementation.

**Inputs (Day 1 finals):**
- `16GD105` B1-MISSION **14**, B3-REGENCY **11** → Mission wins
- `16GD113` B1-MISSION **16**, B2-LAMORINDA A **10** → Mission wins
- `16GD121` B2-LAMORINDA A **8**, B3-REGENCY **10** → Regency wins

**Expected group B standings:** Mission 2-0 → **1stB**; Regency 1-1 (beat Lamorinda A H2H) → **2ndB**;
Lamorinda A 0-2 → **3rdB**.

**Therefore Regency = 2ndB**, entering at **Playin3** (`16GD133`, Sat 12:00 PM).
- Playin3 opponent = `W#Cross1` = winner of (`3rdA-680` vs `1stH-DIABLO ALLIANCE`).
- If Regency wins Playin3 → **QF1** (`16GD141`) vs `1stD` = **PATRIOT** (already resolved: Patriot went
  2-0 in group D). Win → Semi1; loss → P-bracket (5–8).
- If Regency loses Playin3 → **N-bracket** (9–12), game `16GD149`.
- Guaranteed final placement: **1st–12th** (per §5, a top-group runner-up).

Other resolved Day-1 facts useful for opponent projections: 1stA=Santa Barbara, 2ndA=Stanford, 3rdA=680;
1stC=TBD (Santa Cruz/Newport Beach 7pm game not scored in file), 3rdC=Greenwich; 1stD=Patriot, 2ndD=Shaq,
3rdD=Legacy; 1stE=Meridian; 1stF=Rancho Tsunami; 1stG=TBD (Arroyo Grande/South Coast not scored),
3rdG=Lamorinda B; 1stH=Diablo Alliance, 2ndH=Club Daygo, 3rdH=CIU.

---

## 11. Gotchas / caveats

- **Order by SORTKEY, not GAME#.** Game numbers interleave brackets and days.
- **Two unentered Friday 7 PM games** in the current file (`16GD123` Santa Cruz–Newport Beach,
  `16GD124` Arroyo Grande–South Coast) leave 1st/2nd of groups C and G unresolved. The resolver must
  tolerate partially-known standings.
- **Cached vs live values.** `data_only=True` reads Excel's last cached calc. If the file is edited by a
  non-Excel tool, cached values may be missing/stale — prefer recomputing from raw scores.
- **`CHICLETS OLD` is stale** (wrong venues). Don't read schedule from it.
- **COMMENTS formatting is inconsistent** (`13-16` vs `9th-12th`, seed-shorthand `10v15`). Parse
  leniently; rely on the structured `W#/L#/{ord}{group}` tokens in WHITE/DARK as the source of truth.
- **Flow differs by division size** — don't hardcode the 24-team map for 10/14/15/17/18/20/21-team events.
- **Tiebreakers unconfirmed** — verify 3-way tie rules against `RULES & GIRLS LINKS`.
- Column letters can shift if someone inserts columns; key off the **header row text**
  (`DATE/TIME/LOCATION/GAME#/WHITE/S/DARK/S/COMMENTS/DIVISION/SORTKEY`), not fixed indices.
