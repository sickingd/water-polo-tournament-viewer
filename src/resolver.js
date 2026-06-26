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
    // "{age}{G|B}D{division}{shorthand}" -- e.g. "16GD133" (Girls) or "16BD239" (Boys) --
    // the single digit right after "D" is the division number, NOT part of the shorthand the
    // spreadsheet's own W#/L# refs use (e.g. "W#39" means local number 39, not 239). The
    // gender letter varies by tournament, so match either rather than hardcoding "GD" --
    // that bug silently broke every bare-number W#/L# hop in any Boys-format bracket (group
    // -finish and seed-pair refs don't go through this function, so those still resolved).
    const m = /^\d+[A-Za-z]D\d(\d+)$/.exec(gameId || '');
    if (m) return parseInt(m[1], 10);
    // Fallback for other game_id schemes (e.g. the Club Championships ingestion's
    // "{DIVISION}-{NNN}" ids) -- not every tournament's id shape matches the pattern above,
    // so any trailing run of digits is still sortable.
    const generic = /(\d+)$/.exec(gameId || '');
    return generic ? parseInt(generic[1], 10) : null;
  }

  // Canonical, order-independent key for a cross-group finish pair, e.g. (1,"E"),(2,"F") -> "1E,2F".
  function finishPairKey(ord1, let1, ord2, let2) {
    return [ord1 + let1.toUpperCase(), ord2 + let2.toUpperCase()].sort().join(',');
  }

  // Edit distance, used to repair small human typos in cached team names (e.g. "RANCO
  // TSUNAMI" -> "RANCHO TSUNAMI", a dropped letter mid-word that a prefix check can't catch).
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[m][n];
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
    // W#/L# progress, cross-group finish-pair form: W#1E/2F -- identifies a single-elim
    // placement game (e.g. a "1-4 semi") by the group finishes of its two sides, bare
    // digit-then-letter (no "st"/"nd"/"rd"/"th"), seen in 12U/14U sheets' 1-4 / 5-8 brackets.
    if ((m = /^([WL])#(\d+)([A-Za-z]+)\/(\d+)([A-Za-z]+)$/.exec(head))) {
      return {
        type: 'finishPair', wl: m[1],
        ord1: parseInt(m[2], 10), let1: m[3],
        ord2: parseInt(m[4], 10), let2: m[5],
        team, raw,
      };
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
      else if (tok.type === 'finishPair') out.push({ key: 'finishpair:' + finishPairKey(tok.ord1, tok.let1, tok.ord2, tok.let2), wl: tok.wl });
      // A bare/wrapped group finish ("2ndE", or "K1(2ndE)"'s wrapped source) is also a
      // feeder reference -- unlike W#/L#, there's no win/lose direction (the Nth-place team
      // is just whoever it is), so `wl` is null and lookups against this key ignore it.
      else if (tok.type === 'finish') out.push({ key: 'finish:' + tok.ord + tok.let.toUpperCase(), wl: null });
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

    function letOf(tok, round) {
      if (tok.type === 'slot' || tok.type === 'seed') return tok.let;
      // A flat round robin with no slot/seed grammar at all (e.g. 10U_COED) -- the token has
      // no {LET}{pos} head to read a group from, so fall back to the group letter embedded in
      // the synthesized round label ("A bracket") the ingestion script attaches per-division
      // for exactly this shape.
      if (tok.type === 'team') {
        const m = /^([A-Za-z]+)\s*bracket/i.exec(round || '');
        return m ? m[1].toUpperCase() : null;
      }
      return null;
    }

    division.games.forEach((entry) => {
      const round = (entry.raw.round || '');
      const isRR = /bracket|RR/i.test(round);
      if (!isRR) return;
      const wl = letOf(entry.white, round);
      const dl = letOf(entry.dark, round);
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
          // Other typos (a dropped/swapped letter mid-word, e.g. "RANCO TSUNAMI" for
          // "RANCHO TSUNAMI") aren't prefix mismatches -- repair via edit distance, but
          // only when exactly one roster name is unambiguously close, so two genuinely
          // different real teams never get merged.
          const close = g.ranked.filter((r) => levenshtein(r.name, tok.team) <= 2);
          if (close.length === 1) return { team: close[0].name, locked: true };
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
      case 'finishPair': {
        const feeder = findFinishPairGame(ctx, tok.ord1, tok.let1, tok.ord2, tok.let2);
        const label = `${tok.ord1}${tok.let1}/${tok.ord2}${tok.let2}`;
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

  function findFinishPairGame(ctx, ord1, let1, ord2, let2) {
    const want = finishPairKey(ord1, let1, ord2, let2);
    return ctx.division.games.find((e) => {
      const wt = e.white, dt = e.dark;
      if (wt.type !== 'finish' || dt.type !== 'finish') return false;
      if (wt.ord === dt.ord && wt.let.toUpperCase() === dt.let.toUpperCase()) return false;
      return finishPairKey(wt.ord, wt.let, dt.ord, dt.let) === want;
    }) || null;
  }

  // Reverse lookup: which game (and which of its two sides) has a token that names this
  // exact group finish as its source -- e.g. "2ndE" finds the game whose white/dark is
  // "2ndE" directly, or a seed like "K1(2ndE)" wrapping it. Built from the same refIndex
  // buildDivision already populates for W#/L# refs; finish refs there carry wl: null since
  // there's no win/lose direction, so any indexed entry is the (single, expected) answer.
  function findFeederGameForFinish(ctx, ord, let_) {
    const refs = ctx.division.refIndex.get('finish:' + ord + let_.toUpperCase());
    return refs && refs.length ? refs[0] : null;
  }

  // Every seeded position in a standings-tracked group (e.g. A1, A2, A3...), each resolved
  // to whatever's currently knowable -- a real team name once locked, otherwise the same
  // plain-language hint the source spreadsheet's own legend shows ("1st of Group A"). Lets
  // the Bracket tab show a group's eventual entrants before any of its games are cached with
  // a real name -- `computeGroupStandings` only populates `ranked` from each token's *raw*
  // cached team text, which seed-based entrants (e.g. "K1(1stC)") never have until their
  // source group finishes and the spreadsheet's own formula catches up.
  function groupEntrants(ctx, let_) {
    const group = ctx.standings[let_];
    if (!group) return [];
    const byPos = new Map();
    group.games.forEach((entry) => {
      [entry.white, entry.dark].forEach((tok) => {
        if ((tok.type === 'slot' || tok.type === 'seed') && tok.let === let_) byPos.set(tok.pos, tok);
      });
    });
    return Array.from(byPos.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([pos, tok]) => {
        const r = resolveToken(tok, ctx, 0);
        return { pos, name: r.team || r.hint || `${let_}${pos}`, locked: !!r.team };
      });
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

  // True chronological sort key (date + time-of-day), deliberately NOT game_id/GAME# --
  // numbering interleaves brackets and days and is not a reliable proxy for "what order did
  // this team actually play these games in" (see TOURNAMENT_DATA_SPEC.md). Mirrors
  // tournament_app.html's gameTS().
  function chronoKey(raw) {
    const m = /(\d+):(\d+)\s*(AM|PM)/i.exec((raw && raw.time) || '');
    let mins = 0;
    if (m) {
      let h = parseInt(m[1], 10) % 12;
      if (/PM/i.test(m[3])) h += 12;
      mins = h * 60 + parseInt(m[2], 10);
    }
    return ((raw && raw.date) || '') + ':' + String(mins).padStart(4, '0');
  }

  // --- Forward-walk helpers shared by buildScenarios and buildAllPossibleGames -----------
  // None of these close over a particular team -- they operate purely on `division`/`entry`
  // -- so both the single-path ("Path to the Finish") and exhaustive ("all possible future
  // games") walks below can share them.

  function nextGameAfter(division, entry, wl) {
    const keys = [];
    if (entry.roundName) keys.push('ref:' + entry.roundName.toLowerCase());
    if (entry.localNum != null) keys.push('ref:' + entry.localNum);
    // A placement semi (e.g. white=N1(...), dark=N4(...)) is referenced downstream as
    // "W#/L#N1/N4" -- derive that pair key from the game's own seed tokens.
    if (entry.white.type === 'seed' && entry.dark.type === 'seed' && entry.white.let === entry.dark.let) {
      keys.push('pair:' + entry.white.let.toUpperCase() + ':' + [entry.white.pos, entry.dark.pos].sort().join(','));
    }
    // Likewise a cross-group placement semi (e.g. white=1stE, dark=2ndF) is referenced
    // downstream as "W#/L#1E/2F" -- derive that finish-pair key the same way.
    if (entry.white.type === 'finish' && entry.dark.type === 'finish') {
      keys.push('finishpair:' + finishPairKey(entry.white.ord, entry.white.let, entry.dark.ord, entry.dark.let));
    }
    for (const key of keys) {
      const refs = division.refIndex.get(key);
      if (!refs) continue;
      const hit = refs.find((r) => r.wl === wl);
      if (hit) return hit;
    }
    return null;
  }

  // Some brackets relay a crossover result forward via group *finish* rather than a W#/L#
  // reference at all: a "mini-group" like K (just one game, two entrants) determines "1stK"/
  // "2ndK" the moment it's played, and the *next* round references that finish directly
  // (e.g. "X2-(1stK)"), never "W#121". A real multi-game pool can't be collapsed this way --
  // 1st/2nd there depends on every result in the group, not just one game -- so this only
  // fires for a group that is exactly one game between exactly two teams.
  function nextGameAfterByGroupFinish(ctx, entry, wl) {
    const wlet = (entry.white.type === 'slot' || entry.white.type === 'seed') && entry.white.let;
    const dlet = (entry.dark.type === 'slot' || entry.dark.type === 'seed') && entry.dark.let;
    if (!wlet || wlet !== dlet) return null;
    const group = ctx.standings[wlet];
    // `group.size` (the count of *named* teams seen so far) is unreliable here -- these
    // mini-groups' entrants are seed tokens with no cached team until their own source
    // group finishes, so computeGroupStandings can't populate records for them even once
    // played. `games.length` doesn't have that problem: it's a count of *scheduled* games
    // for this letter, fixed by the bracket's structure from the start -- a real 3+-team
    // pool always schedules 3+ games, so exactly one here reliably means "two entrants,
    // one game", independent of whether anyone's name is resolvable yet.
    if (!group || group.games.length !== 1) return null;
    return findFeederGameForFinish(ctx, wl === 'W' ? 1 : 2, wlet);
  }

  // Combines both forward-reference mechanisms a game might be followed by -- try the
  // explicit W#/L# index first, then the implicit two-team-group-finish relay above.
  function nextGameAfterAny(ctx, entry, wl) {
    return nextGameAfter(ctx.division, entry, wl) || nextGameAfterByGroupFinish(ctx, entry, wl);
  }

  function terminalPlace(entry, wl) {
    // Prefix match, not anchored at the end -- terminal-game round labels often carry a
    // trailing matchup suffix (e.g. "1st 1v2", "7th 7v8") that finalPlacementFor (in the
    // app, for already-decided games) already ignores the same way.
    const m = /^(\d+)(st|nd|rd|th)/i.exec((entry.raw.round || '').trim());
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

  // Build the forward decision tree for a team: starting from whichever upcoming game
  // they currently occupy a locked slot in, recurse through win/lose branches using the
  // reverse reference index until hitting a terminal placement.
  function buildScenarios(ctx, teamName, totalTeams) {
    const division = ctx.division;
    // Find every NOT-final game where this team is a locked participant, pick the earliest
    // unresolved one chronologically as "current".
    const myGames = division.games.filter((e) => {
      const w = resolveToken(e.white, ctx, 0);
      const d = resolveToken(e.dark, ctx, 0);
      return (w.team === teamName) || (d.team === teamName);
    });
    // A not-final game can be stale rather than truly pending: real-world results sometimes
    // never get a score typed into an early pool game, even though this team's *later* games
    // already played out (their downstream seed slots show up final, with a cached name --
    // see TOURNAMENT_DATA_SPEC.md). A team can't legitimately have a genuinely-pending game
    // chronologically BEFORE one of its own already-final games, so exclude those here --
    // otherwise this stale game gets mistaken for "current" and produces a meaningless
    // full-range floor/ceiling instead of trusting the already-decided later rounds.
    const latestFinalTS = myGames.reduce((max, e) => {
      if (!e.final) return max;
      const ts = chronoKey(e.raw);
      return max == null || ts > max ? ts : max;
    }, null);
    const upcoming = myGames.filter((e) => !e.final && (latestFinalTS == null || chronoKey(e.raw) > latestFinalTS));
    if (!upcoming.length) {
      // This team has no games left, but if those games were a placement round-robin
      // (e.g. "21-24 RR") and the bracket's OTHER teams haven't all finished yet, this
      // team's exact rank is still pending -- fall back to the bracket's own bounded
      // range rather than reporting nothing. Once every team in the group is done,
      // finalPlacementFor's standings-based lookup takes over with the exact rank.
      const rrGame = myGames.find((e) => rrPlacementRange(e));
      if (rrGame) {
        const let_ = (rrGame.white.type === 'seed' && rrGame.white.let) || (rrGame.dark.type === 'seed' && rrGame.dark.let);
        const group = let_ && ctx.standings[let_];
        if (!group || !group.complete) {
          const range = rrPlacementRange(rrGame);
          return { tree: { terminal: true, rrRange: range }, floor: range[1], ceiling: range[0] };
        }
      }
      return null;
    }
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
      const nextWin = nextGameAfterAny(ctx, entry, 'W');
      const nextLose = nextGameAfterAny(ctx, entry, 'L');

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

    // When the team's current game is still pool play, there's no W#/L# reference chain to
    // walk yet (pool games are referenced by group *finish*, e.g. "1stA", never by their own
    // individual winner/loser) -- `leaves` comes back empty even though the team obviously
    // still has a placement to play for. Rather than report "unknown", fall back to the full
    // division range: with zero results locking anything in, every team can still finish
    // anywhere from 1st to last. But that's only true while the team is still in its
    // *original* pool/round-robin stage (current's own token is a bare 'slot' or, for a flat
    // round robin with no slot grammar at all, 'team') -- a team already promoted into a
    // lower placement bracket via a finish seed (e.g. "G2(3rdB)") structurally can't reach
    // 1st anymore, so the same blind full-range guess there would be actively misleading, not
    // just imprecise. `totalTeams` is optional (existing callers that don't pass it keep
    // today's `null` behavior) and only used when nothing more specific was found.
    const myTok = resolveToken(current.white, ctx, 0).team === teamName ? current.white : current.dark;
    const stillInOriginalStage = myTok.type === 'slot' || myTok.type === 'team';
    const fallback = stillInOriginalStage ? totalTeams : null;
    return {
      tree,
      floor: leaves.length ? Math.max(...leaves) : (fallback || null),
      ceiling: leaves.length ? Math.min(...leaves) : (fallback ? 1 : null),
    };
  }

  // Does this game belong to a round-robin group that hasn't finished yet? Used to tell a
  // genuine pool-play game (no individual W#/L# reference exists for it -- it's not a
  // branch point) apart from a real bracket game, for buildAllPossibleGames below.
  function pendingPoolGame(ctx, entry) {
    const wl = (entry.white.type === 'slot' || entry.white.type === 'seed') && entry.white.let;
    const dl = (entry.dark.type === 'slot' || entry.dark.type === 'seed') && entry.dark.let;
    const let_ = wl && dl && wl === dl ? wl : null;
    if (!let_) return false;
    const group = ctx.standings[let_];
    return !!(group && !group.complete);
  }

  // Find the group letter a team was originally seeded into, via its concrete day-1 slot
  // token (e.g. "A1-NEWPORT" -> "A") -- the one token type that's always a fixed assignment,
  // never a computed/wrapped reference.
  function findTeamGroupLetter(division, teamName) {
    for (const entry of division.games) {
      if (entry.white.type === 'slot' && entry.white.team === teamName) return entry.white.let;
      if (entry.dark.type === 'slot' && entry.dark.team === teamName) return entry.dark.let;
    }
    return null;
  }

  // Every game a team could *possibly* still play, with the full path of outcomes that
  // would have to happen to get there -- not just the next one or two games (that's
  // buildScenarios above), but the complete forward tree, flattened into a list. While a
  // team's pool is still incomplete, there's no single "current" bracket entry yet, so this
  // enumerates every possible finish (1st..Nth in their group) as a separate hypothetical
  // root and walks forward from each; once seeding is locked in, there's exactly one real
  // root and this is equivalent to fully expanding buildScenarios's tree.
  //
  // Two shapes of "what's next" both have to be handled, and a group can legitimately be
  // either: a 2-team single-game relay (K, L, M... -- win/lose maps directly onto 1st/2nd,
  // handled by nextGameAfterAny) versus a genuine multi-team round robin (e.g. group T,
  // 4 entrants who each play the other 3) where there's no win/lose branch at all -- every
  // one of those games happens regardless, and what comes *after* depends on the whole
  // group's eventual standings, not any single result.
  function buildAllPossibleGames(ctx, teamName) {
    const division = ctx.division;
    const results = [];

    function describeOpponentBySide(entry, mySide) {
      const w = resolveToken(entry.white, ctx, 0);
      const d = resolveToken(entry.dark, ctx, 0);
      return mySide === 'white' ? d : w;
    }

    function pushGameNode(entry, mySide, path) {
      const opp = describeOpponentBySide(entry, mySide);
      const node = {
        path,
        gameId: entry.raw.game_id,
        date: entry.raw.date,
        time: entry.raw.time,
        location: entry.raw.location,
        opponent: labelWithMatchup(opp, ctx, 'TBD'),
        opponentLocked: !!opp.team,
        round: entry.raw.round,
      };
      results.push(node);
      return node;
    }

    // Every scheduled game for one specific seeded position (e.g. every game "T2" plays) --
    // a position keeps the same identity across all of them, so they're siblings, not
    // branches of each other.
    function gamesForPosition(let_, pos) {
      return division.games.filter((e) => {
        const w = e.white, d = e.dark;
        return ((w.type === 'slot' || w.type === 'seed') && w.let === let_ && w.pos === pos) ||
          ((d.type === 'slot' || d.type === 'seed') && d.let === let_ && d.pos === pos);
      });
    }
    function sideOfPosition(entry, let_, pos) {
      const w = entry.white;
      return ((w.type === 'slot' || w.type === 'seed') && w.let === let_ && w.pos === pos) ? 'white' : 'dark';
    }

    // Walk forward from one already-decided single game via depth-first win/lose -- the
    // single-path case, generalized to also relay through a 2-team finish-only mini-group.
    function walkSingleGame(entry, mySide, path, depth) {
      if (depth > 14) return;
      const node = pushGameNode(entry, mySide, path);
      const rrRange = rrPlacementRange(entry);
      if (rrRange) { node.rrRange = rrRange; return; }
      if (entry.final) return;
      const winPlace = terminalPlace(entry, 'W');
      const losePlace = terminalPlace(entry, 'L');
      const nextWin = nextGameAfterAny(ctx, entry, 'W');
      const nextLose = nextGameAfterAny(ctx, entry, 'L');
      if (nextWin) enterPosition(nextWin.game, nextWin.side, path.concat('Win this game'), depth + 1);
      else if (winPlace) results.push({ path: path.concat('Win this game'), terminal: true, place: winPlace });
      if (nextLose) enterPosition(nextLose.game, nextLose.side, path.concat('Lose this game'), depth + 1);
      else if (losePlace) results.push({ path: path.concat('Lose this game'), terminal: true, place: losePlace });
    }

    // Entering at (game, side): if that side is a seeded position with more than one
    // scheduled game, it's a genuine multi-team pool -- list every game that position plays
    // (siblings, not branches), then recurse into the pool's own possible finishes (each
    // entrant could end up anywhere in the group, same idea as the top-level enumeration
    // below). Otherwise it's a single game, walked the normal way.
    function enterPosition(entry, side, path, depth) {
      if (depth > 14) return;
      const tok = entry[side];
      if (tok.type !== 'slot' && tok.type !== 'seed') { walkSingleGame(entry, side, path, depth); return; }
      const sibs = gamesForPosition(tok.let, tok.pos);
      if (sibs.length <= 1) { walkSingleGame(entry, side, path, depth); return; }
      sibs.forEach((g) => pushGameNode(g, sideOfPosition(g, tok.let, tok.pos), path));
      groupEntrants(ctx, tok.let).forEach((_, idx) => {
        const rank = idx + 1;
        const feeder = findFeederGameForFinish(ctx, rank, tok.let);
        if (feeder) enterPosition(feeder.game, feeder.side, path.concat(`${ordWord(rank)} of Group ${tok.let}`), depth + 1);
      });
    }

    const myGames = division.games.filter((e) => {
      const w = resolveToken(e.white, ctx, 0);
      const d = resolveToken(e.dark, ctx, 0);
      return (w.team === teamName) || (d.team === teamName);
    });
    const realCurrent = myGames.filter((e) => !e.final).find((e) => !pendingPoolGame(ctx, e));
    if (realCurrent) {
      const w = resolveToken(realCurrent.white, ctx, 0);
      const mySide = w.team === teamName ? 'white' : 'dark';
      walkSingleGame(realCurrent, mySide, [], 0);
      return results;
    }

    const let_ = findTeamGroupLetter(division, teamName);
    const group = let_ && ctx.standings[let_];
    // Only hypothesize finishes while the group is genuinely undecided. If it's already
    // complete and there's still no realCurrent, the team's actual bracket run (locked in
    // from its real finish) has already played all the way through -- nothing left to guess.
    if (!group || group.complete) return results;
    // The home group can be *unscored* (a game never got a final typed in) without being
    // genuinely undecided for THIS team -- if they have a later final game elsewhere, that
    // already proves what happened here (same "stale game" reasoning as buildScenarios
    // above). Hypothesizing 1st/2nd/3rd-in-group branches the team has already played past
    // would be actively wrong, not just imprecise, so bail out instead.
    const groupTS = group.games.reduce((max, e) => {
      const ts = chronoKey(e.raw);
      return max == null || ts > max ? ts : max;
    }, null);
    if (groupTS != null && myGames.some((e) => e.final && chronoKey(e.raw) > groupTS)) return results;
    for (let ord = 1; ord <= group.size; ord++) {
      const feeder = findFeederGameForFinish(ctx, ord, let_);
      if (!feeder) continue;
      enterPosition(feeder.game, feeder.side, [`${ordWord(ord)} in Group ${let_}`], 0);
    }
    return results;
  }

  global.Resolver = { resolveDivision, buildScenarios, buildAllPossibleGames, groupEntrants, parseToken, localNumber };
})(typeof window !== 'undefined' ? window : globalThis);
