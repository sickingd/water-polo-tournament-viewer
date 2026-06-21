// Generic tournament bracket resolver.
//
// The master schedule table encodes the entire bracket topology inside the WHITE/DARK
// cell text (slot tokens) -- it does NOT need a hardcoded per-division-size flow.
// This module parses those tokens, computes round-robin standings for any group/mini-group,
// and resolves forward references (who plays the winner/loser of game X) generically so it
// works for every division regardless of team count or bracket shape.
//
// Token grammar (see TOURNAMENT_DATA_SPEC.md section 4, cross-checked against the live sheet):
//   {LET}{pos}-{TEAM}              concrete round-robin slot, e.g. "A1-STANFORD"
//   {ord}{LET}(-{TEAM})?           group/mini-group finish, e.g. "2ndB-REGENCY", "1stG"
//   W#{ROUND}(-{TEAM})?            winner of the game tagged ROUND in COMMENTS, e.g. "W#Cross1"
//   L#{ROUND}(-{TEAM})?            loser of that game
//   W#{N}(-{TEAM})?  L#{N}         ROUND can also be a bare number -- the game whose GAME#
//                                  numeric suffix equals N (seen in 12U/14U D2 sheets)
//   W#{LET}{a}/{b}  L#{LET}{a}/{b} winner/loser of the specific seeded pair {a} vs {b} within
//                                  mini-bracket LET, e.g. "W#B1/B4"
//   {LET}{n}(SOURCE)(SOURCE...)(-{TEAM})?  placement seed, SOURCE is itself one of the above
//                                  (e.g. "K1(2ndE)-SAN DIEGO SHORES", "E2(1stD)(W#14)-ROSE BOWL")
//
// Resolution strategy: whenever the sheet has already cached a "-{TEAM}" suffix, trust it
// directly -- it's the tournament's own live, formula-driven truth. Only when a token is
// still bare (no cached team) do we independently walk the reference graph, and we only ever
// assert a *future* projection once it's structurally unambiguous (exact round-name match,
// exact numeric-id match, or exact seed-pair match) -- otherwise we surface a plain-language
// placeholder ("Winner of QF1") rather than guess.

(function (global) {
  'use strict';

  const ORD_WORDS = { '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '6th': 6, '7th': 7, '8th': 8 };
  function ordToNum(word) {
    if (ORD_WORDS[word] != null) return ORD_WORDS[word];
    const m = /^(\d+)(st|nd|rd|th)$/i.exec(word);
    return m ? parseInt(m[1], 10) : null;
  }

  function localNumber(gameId) {
    const m = /^\d+GD\d(\d+)$/.exec(gameId || '');
    return m ? parseInt(m[1], 10) : null;
  }

  // Split "E2(1stD)(W#14)-ROSE BOWL" into { head: "E2", parens: ["1stD","W#14"], team: "ROSE BOWL" }
  function splitToken(raw) {
    const s = (raw || '').trim();
    const m = /^([^()-]+?)((?:\([^()]*\))*)(?:-(.*))?$/.exec(s);
    if (!m) return { head: s, parens: [], team: null };
    const head = m[1].trim();
    const team = m[3] && m[3].trim() ? m[3].trim() : null;
    const parens = [];
    const parenRe = /\(([^()]*)\)/g;
    let pm;
    while ((pm = parenRe.exec(m[2]))) parens.push(pm[1]);
    return { head, parens, team };
  }

  // Parse a single token (no recursion into parens here -- callers parse parens on demand).
  function parseToken(raw) {
    const { head, parens, team } = splitToken(raw);
    if (head === '') return { type: 'empty', raw, team };

    let m;
    // W#/L# progress, pair form: W#N1/N4 (the letter repeats before each seed number)
    if ((m = /^([WL])#([A-Za-z]+)(\d+)\/\2(\d+)$/.exec(head))) {
      return { type: 'progressPair', wl: m[1], let: m[2], a: parseInt(m[3], 10), b: parseInt(m[4], 10), team, raw };
    }
    // W#/L# progress, round-name or numeric form: W#Cross1, L#12
    if ((m = /^([WL])#(.+)$/.exec(head))) {
      return { type: 'progress', wl: m[1], ref: m[2], team, raw };
    }
    // ordinal group finish: 2ndB, 13thG
    if ((m = /^(\d+(?:st|nd|rd|th))([A-Za-z]+)$/.exec(head))) {
      return { type: 'finish', ord: ordToNum(m[1]), let: m[2], team, raw };
    }
    // {LET}{pos} with parenthetical source(s) -> a placement seed, e.g. "N1(L#Playin3)",
    // "K1(2ndE)", "E2(1stD)(W#14)" -- NOT a fixed slot, must resolve via its source(s).
    if (parens.length && (m = /^([A-Za-z]+)(\d+)$/.exec(head))) {
      return {
        type: 'seed', let: m[1], pos: parseInt(m[2], 10), team,
        sources: parens.map(parseToken), raw,
      };
    }
    // concrete round-robin slot: A1, K3 (fixed from day-1 seeding, no source needed)
    if ((m = /^([A-Za-z]+)(\d+)$/.exec(head))) {
      return { type: 'slot', let: m[1], pos: parseInt(m[2], 10), team, raw };
    }
    // bare literal team name, no structural prefix
    return { type: 'team', team: team || head, raw };
  }

  // --- Division model ---------------------------------------------------

  function buildDivision(games) {
    const byId = new Map();
    const byLocal = new Map();
    const parsedGames = games.map((g) => {
      const white = parseToken(g.white);
      const dark = parseToken(g.dark);
      const ln = localNumber(g.game_id);
      const roundName = (g.round || '').trim().split(/\s+/)[0] || null;
      const entry = { raw: g, white, dark, localNum: ln, roundName, final: g.played === true };
      byId.set(g.game_id, entry);
      if (ln != null) byLocal.set(ln, entry);
      return entry;
    });

    // Reverse index: canonical key -> games that reference it, so we can answer
    // "what game does the winner/loser of THIS game feed into?"
    // Keys: round name (e.g. "Cross1"), local number (e.g. 14), and "LET-pair" (e.g. "B-1-4").
    const refIndex = new Map(); // key -> [{ game, side: 'white'|'dark', wl: 'W'|'L' }]
    function addRef(key, game, side, wl) {
      if (!refIndex.has(key)) refIndex.set(key, []);
      refIndex.get(key).push({ game, side, wl });
    }
    // Placement seeds wrap their real reference in parens (e.g. "N1(L#Playin3)") -- recurse
    // into `sources` so those nested W#/L# refs still get indexed against the outer game.
    function collectProgressRefs(tok, out) {
      if (!tok) return;
      if (tok.type === 'progress') out.push({ key: 'ref:' + tok.ref.toLowerCase(), wl: tok.wl });
      else if (tok.type === 'progressPair') out.push({ key: 'pair:' + tok.let.toUpperCase() + ':' + [tok.a, tok.b].sort().join(','), wl: tok.wl });
      else if (tok.type === 'seed') tok.sources.forEach((s) => collectProgressRefs(s, out));
    }
    parsedGames.forEach((entry) => {
      ['white', 'dark'].forEach((side) => {
        const refs = [];
        collectProgressRefs(entry[side], refs);
        refs.forEach((r) => addRef(r.key, entry, side, r.wl));
      });
    });

    return { games: parsedGames, byId, byLocal, refIndex };
  }

  // --- Round-robin / mini-group standings --------------------------------

  function computeGroupStandings(division) {
    // A game counts toward a LET's standings when both tokens resolve to that LET
    // (either a plain slot A1/A2 or a placement seed like G1(1stA)) AND its COMMENTS
    // marks it as round-robin play (contains "bracket" or "RR").
    const groups = new Map(); // LET -> { teams: Map(name -> record), games: [] }

    function letOf(tok) {
      if (tok.type === 'slot' || tok.type === 'seed') return tok.let;
      return null;
    }

    division.games.forEach((entry) => {
      const round = (entry.raw.round || '');
      const isRR = /bracket|RR/i.test(round);
      if (!isRR) return;
      const wl = letOf(entry.white);
      const dl = letOf(entry.dark);
      if (!wl || !dl || wl !== dl) return;
      const let_ = wl;
      if (!groups.has(let_)) groups.set(let_, { records: new Map(), games: [] });
      const g = groups.get(let_);
      g.games.push(entry);
      const whiteName = entry.white.team;
      const darkName = entry.dark.team;
      if (whiteName && !g.records.has(whiteName)) g.records.set(whiteName, blankRecord());
      if (darkName && !g.records.has(darkName)) g.records.set(darkName, blankRecord());
      if (!entry.final) return;
      const ws = parseFloat(entry.raw.white_score);
      const ds = parseFloat(entry.raw.dark_score);
      if (isNaN(ws) || isNaN(ds) || !whiteName || !darkName) return;
      const wr = g.records.get(whiteName);
      const dr = g.records.get(darkName);
      // A shootout-decided tie is recorded as e.g. 5.3 vs 5.1 (5 goals + 3/1 in the
      // shootout). The decimal correctly decides the winner below, but shootout goals
      // aren't real goals -- only the whole-number part counts toward goal differential.
      const wGoals = Math.trunc(ws), dGoals = Math.trunc(ds);
      wr.gf += wGoals; wr.ga += dGoals;
      dr.gf += dGoals; dr.ga += wGoals;
      if (ws > ds) { wr.w++; dr.l++; wr.beat.add(darkName); }
      else if (ds > ws) { dr.w++; wr.l++; dr.beat.add(whiteName); }
      else { wr.t++; dr.t++; }
    });

    const standings = {};
    groups.forEach((g, let_) => {
      const allPlayed = g.games.every((e) => e.final);
      const ranked = rankRecords(g.records);
      standings[let_] = { complete: allPlayed, ranked, size: g.records.size, games: g.games };
    });
    return standings;
  }

  function blankRecord() {
    return { w: 0, l: 0, t: 0, gf: 0, ga: 0, beat: new Set() };
  }

  // Head-to-head only gives a *consistent* tiebreak for an exact 2-way tie. With 3+ teams
  // tied on wins, pairwise H2H can cycle (A beat B, B beat C, C beat A all at once -- a real
  // rock-paper-scissors result, not a bug in the data), and applying it pairwise inside a
  // single sort comparator produces a non-transitive, sort-order-dependent result. So: group
  // by win count first, and only consult H2H within a group of exactly two; any group of 3+
  // falls straight through to goal differential / goals against for the whole group.
  function rankRecords(records) {
    const entries = Array.from(records.entries()).map(([name, r]) => ({ name, ...r }));
    const byWins = new Map();
    entries.forEach((e) => {
      if (!byWins.has(e.w)) byWins.set(e.w, []);
      byWins.get(e.w).push(e);
    });
    const byGoalDiff = (a, b) => {
      const gdA = a.gf - a.ga, gdB = b.gf - b.ga;
      if (gdB !== gdA) return gdB - gdA;
      return a.ga - b.ga;
    };
    const ranked = [];
    Array.from(byWins.keys()).sort((a, b) => b - a).forEach((w) => {
      const group = byWins.get(w);
      if (group.length === 2) {
        const [a, b] = group;
        if (a.beat.has(b.name) && !b.beat.has(a.name)) { ranked.push(a, b); return; }
        if (b.beat.has(a.name) && !a.beat.has(b.name)) { ranked.push(b, a); return; }
        // Neither beat the other decisively (tie/no result yet) -- fall through to GD/GA.
      }
      group.sort(byGoalDiff);
      ranked.push(...group);
    });
    return ranked;
  }

  // --- Resolving a token to a team ---------------------------------------

  // Precedence note -- this differs by token type, deliberately:
  //
  // `finish`/`seed` (group-standings placements like "2ndE", or placement seeds wrapping
  // them) are resolved by OUR tiebreaker rules (head-to-head -> goal diff -> goals against),
  // which are a documented *assumption* (TOURNAMENT_DATA_SPEC.md section 6) and can be wrong
  // for a given tournament's actual rules -- e.g. a 3-way tie where we'd guess one order and
  // the tournament's real rule picks another. The live sheet's cached "-{TEAM}" suffix reflects
  // whatever the tournament officially decided, so for these it's the master data: prefer it,
  // and only fall back to our own computed standings when nothing's been resolved yet.
  //
  // `progress`/`progressPair` (W#/L# of a specific game) have no such ambiguity -- the winner
  // of a single final game is just whoever scored more, not a judgment call. There the risk is
  // staleness, not disagreement: the cached suffix is a downstream formula that can lag a
  // recalculation cycle behind a just-entered score. So there we verify independently first and
  // only fall back to the cache when we can't find/verify the feeder game ourselves.
  function resolveToken(tok, ctx, depth) {
    depth = depth || 0;
    if (depth > 12) return { team: null, locked: false, hint: 'TBD' };
    if (!tok) return { team: null, locked: false, hint: 'TBD' };

    switch (tok.type) {
      case 'team':
        return { team: tok.team, locked: true };
      case 'slot':
        if (tok.team) return { team: tok.team, locked: true };
        return { team: null, locked: false, hint: `${tok.let}${tok.pos}` };
      case 'seed': {
        if (tok.team) return { team: tok.team, locked: true };
        let best = { hint: `${tok.let}${tok.pos}` };
        for (const src of tok.sources) {
          const r = resolveToken(src, ctx, depth + 1);
          if (r.team) return r;
          // Carry the whole result (not just .hint) so a feederGame found inside the
          // wrapped source -- e.g. "P2(L#QF4)" wraps a progress ref to QF4 -- survives the
          // unwrap. Dropping it here silently breaks the matchup expansion one level up.
          if (r.hint) best = r;
        }
        return { team: null, locked: false, hint: best.hint, feederGame: best.feederGame };
      }
      case 'finish': {
        const g = ctx.standings[tok.let];
        if (tok.team) {
          // Trust the cache as-is when it matches a real team in this group's roster
          // (round-robin slot names are always reliable -- fixed day-1 assignments, never
          // computed). But the live sheet has shown a downstream formula bug where a
          // "{ord}{group}" cell drops a club's squad letter (e.g. "1stA-SANTA BARBARA"
          // instead of "1stA-SANTA BARBARA A", because the real team is "SANTA BARBARA A").
          // If the cached name doesn't match anyone in the roster but is an unambiguous
          // prefix of exactly one real name, repair it instead of inventing a phantom team.
          if (!g || g.ranked.some((r) => r.name === tok.team)) {
            return { team: tok.team, locked: true };
          }
          const fix = g.ranked.filter((r) => r.name.startsWith(tok.team));
          if (fix.length === 1) return { team: fix[0].name, locked: true };
          return { team: tok.team, locked: true };
        }
        if (g && g.complete && g.ranked[tok.ord - 1]) {
          return { team: g.ranked[tok.ord - 1].name, locked: true };
        }
        return { team: null, locked: false, hint: `${ordWord(tok.ord)} of Group ${tok.let}` };
      }
      case 'progress': {
        const feeder = findFeederGame(ctx, tok.ref);
        if (feeder) return resolveFromGame(feeder, tok.wl, ctx, depth);
        if (tok.team) return { team: tok.team, locked: true };
        return { team: null, locked: false, hint: `${tok.wl === 'W' ? 'Winner' : 'Loser'} of ${tok.ref}` };
      }
      case 'progressPair': {
        const feeder = findSeedPairGame(ctx, tok.let, tok.a, tok.b);
        const label = `${tok.let}${tok.a}/${tok.let}${tok.b}`;
        if (feeder) return resolveFromGame(feeder, tok.wl, ctx, depth);
        if (tok.team) return { team: tok.team, locked: true };
        return { team: null, locked: false, hint: `${tok.wl === 'W' ? 'Winner' : 'Loser'} of ${label}` };
      }
      default:
        return { team: null, locked: false, hint: 'TBD' };
    }
  }

  function ordWord(n) {
    const rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return n + 'th';
    const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
    return n + suffix;
  }

  function resolveFromGame(feeder, wl, ctx, depth) {
    const wRes = resolveToken(feeder.white, ctx, depth + 1);
    const dRes = resolveToken(feeder.dark, ctx, depth + 1);
    if (!feeder.final) {
      const roundLabel = feeder.roundName || feeder.raw.round || ('Game ' + feeder.localNum);
      // feederGame lets a display layer show who's actually playing in that game (one level
      // deep) instead of a bare "Winner of X" placeholder -- see describeFeederMatchup. Kept
      // un-expanded here so nested feeders don't recursively balloon the hint text.
      return { team: null, locked: false, hint: `${wl === 'W' ? 'Winner' : 'Loser'} of ${roundLabel}`, feederGame: feeder };
    }
    const ws = parseFloat(feeder.raw.white_score);
    const ds = parseFloat(feeder.raw.dark_score);
    if (isNaN(ws) || isNaN(ds)) return { team: null, locked: false, hint: 'TBD' };
    const winnerIsWhite = ws > ds;
    const team = wl === 'W'
      ? (winnerIsWhite ? wRes.team : dRes.team)
      : (winnerIsWhite ? dRes.team : wRes.team);
    return { team: team || null, locked: !!team };
  }

  function findFeederGame(ctx, ref) {
    const refLower = ref.toLowerCase();
    // Try exact round-name match against COMMENTS leading token.
    const byName = ctx.division.games.find((e) => e.roundName && e.roundName.toLowerCase() === refLower);
    if (byName) return byName;
    // Try bare numeric local-id match.
    if (/^\d+$/.test(ref)) {
      const g = ctx.division.byLocal.get(parseInt(ref, 10));
      if (g) return g;
    }
    return null;
  }

  function findSeedPairGame(ctx, let_, a, b) {
    const want = new Set([a, b]);
    return ctx.division.games.find((e) => {
      const wt = e.white, dt = e.dark;
      const isSeed = (t) => t.type === 'seed' && t.let === let_ && want.has(t.pos);
      return isSeed(wt) && isSeed(dt) && wt.pos !== dt.pos;
    }) || null;
  }

  // --- Public API ----------------------------------------------------------

  // When a result is an unresolved placeholder pointing at a specific feeder game (e.g.
  // "Winner of Playin1"), describe who's actually playing in that feeder game, one level
  // deep -- e.g. "SHAQ vs Winner of Cross3". Deliberately shallow: the feeder's own sides
  // are resolved without expanding *their* feeders, so this never nests.
  // levels controls how many feeder games deep the description expands -- e.g. at levels=2,
  // "Winner of Playin1" becomes "Winner of Playin1 (CLOVIS vs Winner of Cross3 (680 vs ROSE
  // BOWL))". Each level resolves one more feeder's own two sides; it bottoms out either when
  // a side is a locked team, or when levels reaches 0 (then it's left as a bare hint).
  function labelWithMatchup(result, ctx, fallback, levels) {
    if (levels == null) levels = 2;
    if (result.team) return result.team;
    if (!result.hint) return fallback;
    if (levels <= 0 || !result.feederGame) return result.hint;
    const feeder = result.feederGame;
    const w = resolveToken(feeder.white, ctx, 0);
    const d = resolveToken(feeder.dark, ctx, 0);
    const wLabel = labelWithMatchup(w, ctx, '?', levels - 1);
    const dLabel = labelWithMatchup(d, ctx, '?', levels - 1);
    return `${result.hint} (${wLabel} vs ${dLabel})`;
  }

  function resolveDivision(games) {
    const division = buildDivision(games);
    const standings = computeGroupStandings(division);
    const ctx = { division, standings };

    const resolvedGames = division.games.map((entry) => {
      const w = resolveToken(entry.white, ctx, 0);
      const d = resolveToken(entry.dark, ctx, 0);
      return {
        ...entry.raw,
        whiteTeam: w.team,
        whiteLabel: labelWithMatchup(w, ctx, entry.raw.white),
        whiteLocked: w.locked,
        darkTeam: d.team,
        darkLabel: labelWithMatchup(d, ctx, entry.raw.dark),
        darkLocked: d.locked,
        status: entry.final ? 'final' : 'scheduled',
      };
    });

    return { games: resolvedGames, standings, ctx };
  }

  // Build the forward decision tree for a team: starting from whichever upcoming game
  // they currently occupy a locked slot in, recurse through win/lose branches using the
  // reverse reference index until hitting a terminal placement.
  function buildScenarios(ctx, teamName) {
    const division = ctx.division;
    // Find every NOT-final game where this team is a locked participant, pick the earliest
    // unresolved one chronologically as "current".
    const myGames = division.games.filter((e) => {
      const w = resolveToken(e.white, ctx, 0);
      const d = resolveToken(e.dark, ctx, 0);
      return (w.team === teamName) || (d.team === teamName);
    });
    const upcoming = myGames.filter((e) => !e.final);
    if (!upcoming.length) return null;
    upcoming.sort((a, b) => (a.raw.game_id > b.raw.game_id ? 1 : -1));
    const current = upcoming[0];

    // mySide, when given, is which side of `entry` represents the team we're tracking --
    // known for certain because that's the side whose W#/L# reference led us to this game
    // (see nextGameAfter). Without it (the real, current game) we fall back to name
    // matching, which works there because that slot is always actually locked to teamName.
    function describeOpponent(entry, mySide) {
      const w = resolveToken(entry.white, ctx, 0);
      const d = resolveToken(entry.dark, ctx, 0);
      if (mySide === 'white') return { mine: w, opp: d };
      if (mySide === 'dark') return { mine: d, opp: w };
      const mine = w.team === teamName ? w : d;
      const opp = w.team === teamName ? d : w;
      return { mine, opp };
    }

    function nextGameAfter(entry, wl) {
      const keys = [];
      if (entry.roundName) keys.push('ref:' + entry.roundName.toLowerCase());
      if (entry.localNum != null) keys.push('ref:' + entry.localNum);
      // A placement semi (e.g. white=N1(...), dark=N4(...)) is referenced downstream as
      // "W#/L#N1/N4" -- derive that pair key from the game's own seed tokens.
      if (entry.white.type === 'seed' && entry.dark.type === 'seed' && entry.white.let === entry.dark.let) {
        keys.push('pair:' + entry.white.let.toUpperCase() + ':' + [entry.white.pos, entry.dark.pos].sort().join(','));
      }
      for (const key of keys) {
        const refs = division.refIndex.get(key);
        if (!refs) continue;
        const hit = refs.find((r) => r.wl === wl);
        if (hit) return hit;
      }
      return null;
    }

    function terminalPlace(entry, wl) {
      const m = /^(\d+)(st|nd|rd|th)$/i.exec((entry.raw.round || '').trim());
      if (m) {
        const place = parseInt(m[1], 10);
        return wl === 'W' ? place : place + 1;
      }
      return null;
    }

    // Placement brackets like "17-20 RR K1,K4" or "21-24 RR M2,M3" are 4-team round robins,
    // not single-elimination -- there's no single win/lose branch to the next game (the
    // final rank depends on all those games together). But the bracket's own label already
    // bounds the placement, so use that directly instead of leaving floor/ceiling unknown.
    function rrPlacementRange(entry) {
      const m = /^(\d+)\s*-\s*(\d+)\s*RR/i.exec((entry.raw.round || '').trim());
      return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
    }

    function walk(entry, depth, mySide) {
      if (depth > 8) return { opponentHint: 'TBD', terminal: true, placeRange: null };
      const { opp } = describeOpponent(entry, mySide);
      const node = {
        gameId: entry.raw.game_id,
        date: entry.raw.date,
        time: entry.raw.time,
        location: entry.raw.location,
        opponent: labelWithMatchup(opp, ctx, 'TBD'),
        opponentLocked: !!opp.team,
        round: entry.raw.round,
        final: entry.final,
      };
      const rrRange = rrPlacementRange(entry);
      if (rrRange) {
        node.terminal = true;
        node.rrRange = rrRange;
        return node;
      }
      if (entry.final) {
        // Already decided -- no branching, just report what happened and stop.
        node.terminal = true;
        return node;
      }
      const winPlace = terminalPlace(entry, 'W');
      const losePlace = terminalPlace(entry, 'L');
      const nextWin = nextGameAfter(entry, 'W');
      const nextLose = nextGameAfter(entry, 'L');

      node.onWin = nextWin ? walk(nextWin.game, depth + 1, nextWin.side) : (winPlace ? { terminal: true, place: winPlace } : { terminal: true, placeRange: null });
      node.onLose = nextLose ? walk(nextLose.game, depth + 1, nextLose.side) : (losePlace ? { terminal: true, place: losePlace } : { terminal: true, placeRange: null });
      return node;
    }

    const tree = walk(current, 0);
    const leaves = [];
    (function collect(n) {
      if (!n) return;
      if (n.rrRange) { leaves.push(n.rrRange[0], n.rrRange[1]); return; }
      if (n.terminal) { if (n.place) leaves.push(n.place); return; }
      collect(n.onWin); collect(n.onLose);
    })(tree);

    return {
      tree,
      floor: leaves.length ? Math.max(...leaves) : null,
      ceiling: leaves.length ? Math.min(...leaves) : null,
    };
  }

  global.Resolver = { resolveDivision, buildScenarios, parseToken, localNumber };
})(typeof window !== 'undefined' ? window : globalThis);
