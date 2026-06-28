// Cloudflare Worker: server-side live-data refresh + API, replacing GitHub Actions/GitHub
// Pages as the freshness mechanism (see TOURNAMENT_DATA_SPEC.md and the project's hosting
// plan for why -- GitHub Pages hardcodes a 10-minute cache it can't be configured around).
//
// Two entry points:
//   - scheduled(): cron-triggered (see wrangler.toml), polls every non-completed tournament's
//     live source and writes the normalized result into KV.
//   - fetch(): serves GET /api/tournaments/<id> from KV, and POST /api/tournaments/<id>?refresh=now
//     for an on-demand refresh that bypasses the cron wait entirely.
//
// The CSV-parsing logic mirrors tools/refresh_data.py exactly (column-name lookup, the
// slot-token team-name extraction, date parsing) so the two stay interchangeable -- this
// Worker is just that script's logic running server-side on a much tighter schedule.
import sources from '../tools/sources.json';
import { refreshTournamentFromOneDrive } from './onedrive.js';

// Must match wrangler.toml's [triggers].crons[0] exactly -- Cloudflare passes the literal
// cron expression string back as event.cron, which is how scheduled() tells the two
// staggered trigger patterns apart (see the cron_group comment in scheduled() below).
const CRON_GROUP_A_PATTERN = '*/6 * * * *';

const MONTHS = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

// Mirrors src/resolver.js's splitToken / tools/refresh_data.py's TOKEN_RE: pulls a trailing
// "-{TEAM}" cached resolution off any slot/ordinal/bracket-progress/placement token.
const TOKEN_RE = /^([^()-]+?)((?:\([^()]*\))*)(?:-(.*))?$/;
// A *concrete round-robin slot* token, e.g. "A1-SANTA BARBARA A" -- no parens, head is just
// {GROUP_LETTER}{POSITION}. Only these are guaranteed-correct day-1 seeding, so only these
// ever populate the team picker (see tools/refresh_data.py for the full rationale).
const SLOT_TOKEN_RE = /^[A-Za-z]+\d+$/;

// A handful of divisions (e.g. 10U_COED in the Club Championships format) play a flat round
// robin with no "A1-" slot convention at all -- the WHITE/DARK cell is just the team name
// outright. extractTeamName() below trusts a dash-less head as a literal name UNLESS it
// matches one of these unresolved-formula shapes (a W#/L# bracket ref or an ordinal group
// finish with no cached name), which must stay untrusted like any other formula token.
const BARE_PROGRESS_RE = /^[WL]#/i;
const BARE_FINISH_RE = /^\d+(?:st|nd|rd|th)[A-Za-z]+$/i;

function parseDate(raw, year) {
  const m = /(\d+)-([A-Za-z]+)/.exec((raw || '').trim());
  if (!m) return (raw || '').trim();
  const day = parseInt(m[1], 10);
  const mon = MONTHS[m[2].slice(0, 3).replace(/^(.)(.*)/, (_, a, b) => a.toUpperCase() + b.toLowerCase())];
  if (!mon) return (raw || '').trim();
  return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// A shootout-decided score is goals + a decimal shootout tally (e.g. "7.1"). At least one
// live cell had that typed with a comma instead ("7,2") -- a locale-keyboard slip, not a
// different format -- so normalize before parsing rather than letting parseFloat mangle it.
function parseScore(raw) {
  return parseFloat(raw.replace(',', '.'));
}

function extractTeamName(token) {
  const m = TOKEN_RE.exec((token || '').trim());
  if (!m) return null;
  const [, head, parens, team] = m;
  if (parens || !SLOT_TOKEN_RE.test(head)) {
    if (!team && !parens && !BARE_PROGRESS_RE.test(head) && !BARE_FINISH_RE.test(head)) {
      return head.trim() || null;
    }
    return null;
  }
  return team && team.trim() ? team.trim() : null;
}

// Minimal RFC4180 CSV parser -- handles quoted fields, embedded commas/newlines, and
// escaped ("") quotes. Google's gviz/tq CSV export needs exactly this, nothing fancier.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchSheetCsv(sheetId, sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?` +
    `tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sheet fetch failed: HTTP ${res.status}`);
  return res.text();
}

// gviz/tq above (used by the old per-sheet-name format) was confirmed to serve a STALE,
// edge-cached snapshot for the Club Championships docs -- a score typed into the live sheet
// came back blank from gviz on every refetch (cache-busting query params included), while
// /export?format=csv returned the correct value immediately every time. These single-tab
// docs never need a sheet name, so gid=0 (the default/only tab) via /export is both simpler
// and actually live -- this is what the cron and on-demand refresh now use for that format.
async function fetchSheetCsvExport(sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sheet export failed: HTTP ${res.status}`);
  return res.text();
}

function buildTournamentData(cfg, csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error('empty sheet response');
  const header = rows[0].map((h) => h.trim().toUpperCase());
  const col = (name) => header.indexOf(name);
  const sCols = [];
  header.forEach((h, i) => { if (h === 'S') sCols.push(i); });
  const idx = {
    date: col('DATE'), time: col('TIME'), location: col('LOCATION'),
    game_id: col('GAME#'), white: col('WHITE'), dark: col('DARK'),
    white_score: sCols[0], dark_score: sCols[1],
    comments: col('COMMENTS'), division: col('DIVISION'),
  };

  const games = [];
  const teamsMap = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length <= idx.game_id || !(row[idx.game_id] || '').trim()) continue;
    const white = (row[idx.white] || '').trim();
    const dark = (row[idx.dark] || '').trim();
    const wsRaw = (row[idx.white_score] || '').trim();
    const dsRaw = (row[idx.dark_score] || '').trim();
    const played = wsRaw !== '' && dsRaw !== '';
    const division = (row[idx.division] || '').trim();
    games.push({
      date: parseDate(row[idx.date], cfg.year),
      time: (row[idx.time] || '').trim(),
      location: (row[idx.location] || '').trim(),
      game_id: (row[idx.game_id] || '').trim(),
      white, white_score: played ? parseScore(wsRaw) : null,
      dark, dark_score: played ? parseScore(dsRaw) : null,
      round: (row[idx.comments] || '').trim(),
      division, played,
    });
    for (const tok of [white, dark]) {
      const name = extractTeamName(tok);
      if (name) teamsMap.set(`${name} ${division}`, { name, division });
    }
  }

  games.sort((a, b) => (a.game_id < b.game_id ? -1 : a.game_id > b.game_id ? 1 : 0));
  const teams = Array.from(teamsMap.values())
    .sort((a, b) => (a.name === b.name ? (a.division < b.division ? -1 : 1) : (a.name < b.name ? -1 : 1)));

  return { tournament: cfg.label, generated: new Date().toISOString(), games, teams };
}

// =====================================================================================
// "Club Championships" format -- separate from buildTournamentData() above on purpose,
// mirroring tools/refresh_data.py's build_clubchamps_tournament_data exactly (and just as
// deliberately kept apart from the old-format parser, which will recur for future
// tournaments). Multiple spreadsheets (one per age group), no GAME# column, no DIVISION
// column, a different DATE format, and two token-grammar quirks not present above.
// =====================================================================================

const CC_HEADER_REPEAT = 'LOCATION';
const CC_BOGUS_DARK = 'GAME';
const CC_GAME_STAMP_RE = /GAME\s*#\s*(\d+)/i;
// Some divisions (confirmed live: the Girls Club Championships sheet) abbreviate this as just
// "WIN #7"/"LOSE #7" rather than the full "WINNER #11"/"LOSER #11" -- both spellings mean the
// same thing, so both must rewrite to "W#"/"L#" or this token falls through parseToken's
// catch-all into a bare, never-repaired literal team name instead of a real progress ref.
const CC_WINNER_LOSER_RE = /^(WIN(?:NER)?|LOSE(?:R)?)\s*#\s*(\d+)(.*)$/i;
// No-parens placement-seed form seen in the 12U sheet only, e.g. "E1 -1st A - TEAM" --
// the shared `seed` token type in src/resolver.js expects parens around the source
// ("E1(1stA)-TEAM"), which is what sheets using "T3 (3rdF) - " already match once trimmed.
const CC_NOPAREN_SEED_RE = /^([A-Za-z]+\d+)\s*-\s*(\d+(?:st|nd|rd|th))\s*([A-Za-z]+)\s*-\s*(.*)$/i;
// Dash-before-parens placement-seed form, e.g. "AA1-(1st W)-" -- common in the 14U/16U/18U
// placement brackets (S/T/W/X/Y/Z/AA/BB/.../LL groups). resolver.js's splitToken expects the
// parens to immediately follow the head with no hyphen in between ("AA1(1stW)-"); the extra
// hyphen here makes it misparse the *whole* "(1st W)-" remainder as a literal cached team
// name, which is exactly the "(1st W)" bogus team the Placement Tracker was showing.
const CC_DASHPAREN_SEED_RE = /^([A-Za-z]+\d+)-\((\d+(?:st|nd|rd|th))\s*([A-Za-z]+)\)-(.*)$/i;

function parseDateMdy(raw) {
  const m = /(\d+)\/(\d+)\/(\d+)/.exec((raw || '').trim());
  if (!m) return (raw || '').trim();
  const month = parseInt(m[1], 10), day = parseInt(m[2], 10), year = parseInt(m[3], 10);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Matches the leading "{LETTERS}{digits}" of EITHER a bare slot ("A1-NEWPORT") or a seed
// ("K1(1stC)-") -- this sheet uses the exact same "two entrants of group LET" shape for both
// the initial pool stage (A-H, bare slots) and single-game crossover "mini-groups" later in
// the bracket (e.g. K/L/M/N, I/J, W/X/Y/Z -- seeds wrapping the previous round's finish).
// Both need the same standings/round-robin treatment, just with different head token types.
const CC_GROUP_LETTER_RE = /^([A-Za-z]+)\d+/;

// If both (already-collapsed) tokens belong to the *same* LET group (whether bare slots or
// seeds), this game determines that group's standings -- returns the shared group letter,
// else null.
function poolGroupLetter(white, dark) {
  const mw = CC_GROUP_LETTER_RE.exec(white), md = CC_GROUP_LETTER_RE.exec(dark);
  if (mw && md && mw[1] === md[1]) return mw[1];
  return null;
}


function normalizeClubChampsToken(raw) {
  let s = (raw || '').trim();
  // Unlike the old format ("A1-STANFORD", never spaced), this sheet inconsistently writes
  // slot tokens with spaces around the hyphen ("B1 -  LAMORINDA" alongside "A1-NEWPORT" in
  // the same column) -- collapse that whitespace first so the shared TOKEN_RE/SLOT_TOKEN_RE
  // (and resolver.js's splitToken) see one consistent "{HEAD}-{TEAM}" shape either way.
  s = s.replace(/\s*-\s*/g, '-');
  let m = CC_WINNER_LOSER_RE.exec(s);
  if (m) {
    const letter = /^WIN/i.test(m[1]) ? 'W' : 'L';
    return `${letter}#${m[2]}${m[3]}`;
  }
  m = CC_DASHPAREN_SEED_RE.exec(s);
  if (m) {
    const [, slot, ord, group, team] = m;
    return `${slot}(${ord}${group})-${team.trim()}`;
  }
  m = CC_NOPAREN_SEED_RE.exec(s);
  if (m) {
    const [, slot, ord, group, team] = m;
    return `${slot}(${ord}${group})-${team.trim()}`;
  }
  return s;
}

function buildClubChampsTournamentData(cfg, csvTexts) {
  const allGames = [];
  const teamsMap = new Map();
  cfg.sources.forEach((source, sourceIdx) => {
    const division = source.division;
    const rawRows = parseCsv(csvTexts[sourceIdx]);
    if (!rawRows.length) throw new Error(`empty sheet response for ${division}`);
    // The real header isn't always row 0 -- organizers prepend ad-hoc announcement rows
    // ("GATE FEE THIS WEEKEND...", "SCHEDULE UPDATED...") above it, and the count varies by
    // sheet and changes over time. Find the row that actually has 'LOCATION' as a cell
    // instead of assuming a fixed offset.
    const headerIdx = rawRows.findIndex((r) => r.some((c) => (c || '').trim().toUpperCase() === 'LOCATION'));
    if (headerIdx === -1) throw new Error(`could not find header row (no LOCATION cell) for ${division}`);
    const rows = rawRows.slice(headerIdx);
    const header = rows[0].map((h) => h.trim().toUpperCase());
    const locIdx = header.indexOf('LOCATION');
    const timeIdx = header.indexOf('TIME');
    const whiteIdx = header.indexOf('WHITE TEAM');
    const darkIdx = header.indexOf('DARK TEAM');
    const commentsIdx = header.indexOf('COMMENTS');
    const sCols = [];
    header.forEach((h, i) => { if (h === 'S') sCols.push(i); });
    const [whiteScoreIdx, darkScoreIdx] = sCols;
    const dateIdx = 0; // the DATE header cell is polluted with a weekly banner string

    // Pass 1: clean rows + capture each row's *official* GAME# stamp, if any. The stamp is
    // NOT row-order (confirmed against the live sheet: e.g. 18U_GIRLS row 1 is stamped
    // "GAME #7" while row 8 is stamped "GAME #1") -- it's the bracket's own numbering, and
    // WINNER #N / LOSER #N refs point at that number, not at sheet position, so it must be
    // trusted directly rather than re-numbered by row order.
    const cleaned = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row.some((c) => (c || '').trim())) continue;
      if (row.length <= darkIdx) continue;
      if ((row[locIdx] || '').trim().toUpperCase() === CC_HEADER_REPEAT) continue;
      if ((row[darkIdx] || '').trim().toUpperCase() === CC_BOGUS_DARK) continue;
      const whiteRaw = (row[whiteIdx] || '').trim();
      const darkRaw = (row[darkIdx] || '').trim();
      if (!whiteRaw && !darkRaw) continue;
      const comments = (row[commentsIdx] || '').trim();
      const stampM = CC_GAME_STAMP_RE.exec(comments);
      const white = normalizeClubChampsToken(whiteRaw);
      const dark = normalizeClubChampsToken(darkRaw);
      cleaned.push({ row, white, dark, comments, stamp: stampM ? parseInt(stampM[1], 10) : null });
    }

    // Some divisions (e.g. 10U_COED) play a flat round robin with no "A1-"/seed slot grammar
    // anywhere -- WHITE/DARK cells are bare team names from start to finish, no bracket at
    // all. Detect that once per division (not per game, which could misfire on a genuine
    // head-to-head placement game using a cached literal name inside an otherwise-structured
    // bracket) and synthesize a single implicit group "A" for the whole division below.
    const divisionIsFlat = !cleaned.some((c) =>
      CC_GROUP_LETTER_RE.test(c.white) || CC_GROUP_LETTER_RE.test(c.dark) ||
      /^[WL]#/i.test(c.white) || /^[WL]#/i.test(c.dark));

    // Pass 2: assign each row a number. Stamped rows keep their official number (what
    // WINNER#/LOSER# refs resolve against); unstamped rows (pool play -- never referenced by
    // number) get the next number from a range well clear of any stamp seen in this division.
    const maxStamp = cleaned.reduce((max, c) => (c.stamp != null && c.stamp > max ? c.stamp : max), 0);
    let nextUnstamped = Math.max(maxStamp, 99) + 1;
    const usedNumbers = new Set();
    for (const c of cleaned) {
      let num = c.stamp;
      if (num == null || usedNumbers.has(num)) {
        num = nextUnstamped;
        nextUnstamped += 1;
      }
      usedNumbers.add(num);

      const wsRaw = (c.row[whiteScoreIdx] || '').trim();
      const dsRaw = (c.row[darkScoreIdx] || '').trim();
      const played = wsRaw !== '' && dsRaw !== '';
      let roundLabel = c.comments.replace(CC_GAME_STAMP_RE, '').trim();
      const { white, dark } = c;
      if (!roundLabel) {
        if (divisionIsFlat) {
          roundLabel = 'A bracket';
        } else {
          // Unlike the old format (COMMENTS always said e.g. "B bracket B1,B3" for pool
          // play), this sheet leaves pool-play COMMENTS blank -- the shared round-robin
          // detector in src/resolver.js requires the literal word "bracket"/"RR" in the round
          // label, so a same-letter bare-slot-vs-bare-slot game (the only shape pool play
          // takes here) gets tagged the same way the old format already does.
          const poolLet = poolGroupLetter(white, dark);
          if (poolLet) roundLabel = `${poolLet} bracket`;
        }
      }
      allGames.push({
        date: parseDateMdy(c.row[dateIdx]),
        time: (c.row[timeIdx] || '').trim(),
        location: (c.row[locIdx] || '').trim(),
        game_id: `${division}-${String(num).padStart(3, '0')}`,
        white, white_score: played ? parseScore(wsRaw) : null,
        dark, dark_score: played ? parseScore(dsRaw) : null,
        round: roundLabel,
        division, played,
      });
      for (const tok of [white, dark]) {
        const name = extractTeamName(tok);
        if (name) teamsMap.set(`${name} ${division}`, { name, division });
      }
    }
  });

  const teams = Array.from(teamsMap.values())
    .sort((a, b) => (a.name === b.name ? (a.division < b.division ? -1 : 1) : (a.name < b.name ? -1 : 1)));
  return { tournament: cfg.label, generated: new Date().toISOString(), games: allGames, teams };
}

async function refreshTournament(cfg, env) {
  if (cfg.sources) {
    const csvTexts = await Promise.all(cfg.sources.map((s) => fetchSheetCsvExport(s.sheet_id)));
    return buildClubChampsTournamentData(cfg, csvTexts);
  }
  const csv = await fetchSheetCsv(cfg.sheet_id, cfg.master_sheet_name);
  return buildTournamentData(cfg, csv);
}

// Ignores `generated` (always differs) and compares only the content that actually matters,
// so a cron tick where nothing changed on the sheet skips the KV write entirely. KV reads are
// effectively unlimited on the free tier (100k/day); writes are not (1,000/day) -- this is
// what keeps a tight cron interval from blowing through that quota (see wrangler.toml).
function sameData(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a.games) === JSON.stringify(b.games) &&
    JSON.stringify(a.teams) === JSON.stringify(b.teams);
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
  });
}

// `_fallback` is internal bookkeeping (see handleScheduledTickWithFallback below) -- it must
// never leak into the public API response, both to keep the payload small (it duplicates a
// full games/teams snapshot while a fallback is active) and to keep the response contract
// identical regardless of which source is currently serving.
function stripInternal(data) {
  if (!data || !data._fallback) return data;
  const { _fallback, ...rest } = data;
  return rest;
}

function localHourInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  return parseInt(parts.find((p) => p.type === 'hour').value, 10);
}

function isWithinActiveHours(date, fallbackCfg) {
  const hour = localHourInTimezone(date, fallbackCfg.timezone);
  const [start, end] = fallbackCfg.active_hours_local;
  return hour >= start && hour < end;
}

// For a tournament whose organizers have stopped updating Google Sheets entirely (confirmed
// for the 2026 Boys Futures Superfinals -- the Google doc just sits there unplayed while the
// OneDrive workbook gets real scores), checking Google on every tick is pure waste: it costs
// real CPU time (compounding into the "Exceeded CPU Limit" cron failures seen live once a
// season's sheets grow large enough), AND that specific old-format Google endpoint
// (fetchSheetCsv's gviz/tq) has been independently observed returning HTTP 500/429 for this
// sheet regardless. `fallback.only_source: true` skips Google completely -- OneDrive is the
// sole source, polled on the same poll_interval_minutes boundary as the auto-switchover path
// below (its reverse-engineered, anti-bot-sensitive flow still shouldn't be hit every tick).
async function handleScheduledTickOneDriveOnly(tournamentId, cfg, env, opts) {
  const fb = cfg.fallback;
  const force = !!(opts && opts.force);
  if (!force && new Date().getUTCMinutes() % fb.poll_interval_minutes !== 0) {
    console.log(`[${tournamentId}] OneDrive-only, not due for a re-poll yet`);
    return;
  }
  const cachedRaw = await env.TOURNAMENT_KV.get(tournamentId);
  const cached = cachedRaw ? JSON.parse(cachedRaw) : null;
  const data = await refreshTournamentFromOneDrive(cfg, fb, extractTeamName, parseScore);
  if (sameData(cached, data)) {
    console.log(`[${tournamentId}] OneDrive-only checked, no change (${data.games.length} games)`);
    return;
  }
  await env.TOURNAMENT_KV.put(tournamentId, JSON.stringify(data));
  console.log(`[${tournamentId}] OneDrive-only updated (${data.games.length} games)`);
}

// Google Sheets is always primary. A tournament only ever gets here (cfg.fallback present)
// because its organizers were observed updating a parallel OneDrive workbook instead of the
// Google Sheet mid-tournament (see onedrive.js's header comment) -- this is the
// staleness-detection + auto-switchover logic agreed for that situation:
//   - Google unchanged for fallback.stale_after_minutes AND it's local "game time"
//     (fallback.active_hours_local) -> switch to OneDrive.
//   - Once on OneDrive, re-check Google every tick anyway; the moment it changes, switch
//     straight back -- Google is trusted again automatically, no manual step.
//   - While on OneDrive, only actually re-poll it on a poll_interval_minutes wall-clock
//     boundary (it's the fragile, reverse-engineered, anti-bot-sensitive side of this -- see
//     onedrive.js), not every 3-minute tick like Google.
// The public KV blob is the plain {tournament, generated, games, teams} shape whenever Google
// is healthy -- identical to before this feature existed. The extra `_fallback` key (mode,
// when Google last actually changed, and a snapshot of Google's data to keep diffing against
// without disturbing what's being served) only appears while a fallback is actually active.
async function handleScheduledTickWithFallback(tournamentId, cfg, env) {
  const fb = cfg.fallback;
  const cachedRaw = await env.TOURNAMENT_KV.get(tournamentId);
  const cached = cachedRaw ? JSON.parse(cachedRaw) : null;
  const inFallback = !!(cached && cached._fallback && cached._fallback.mode === 'onedrive');

  const googleData = await refreshTournament(cfg, env);

  if (inFallback) {
    const googleResumed = !sameData(cached._fallback.googleSnapshot, googleData);
    if (googleResumed) {
      await env.TOURNAMENT_KV.put(tournamentId, JSON.stringify(googleData));
      console.log(`[${tournamentId}] Google resumed -- switched back from OneDrive fallback (${googleData.games.length} games)`);
      return;
    }

    const staleMinutes = Math.round((Date.now() - new Date(cached._fallback.googleChangedAt).getTime()) / 60000);
    const isPollBoundary = new Date().getUTCMinutes() % fb.poll_interval_minutes === 0;
    if (!isPollBoundary) {
      console.log(`[${tournamentId}] still on OneDrive fallback (Google stale ${staleMinutes}m, not due for a re-poll yet)`);
      return;
    }
    try {
      const onedriveData = await refreshTournamentFromOneDrive(cfg, fb, extractTeamName, parseScore);
      if (sameData(cached, onedriveData)) {
        console.log(`[${tournamentId}] OneDrive fallback checked, no change (Google still stale ${staleMinutes}m, ${onedriveData.games.length} games)`);
        return;
      }
      const combined = Object.assign({}, onedriveData, { _fallback: cached._fallback });
      await env.TOURNAMENT_KV.put(tournamentId, JSON.stringify(combined));
      console.log(`[${tournamentId}] OneDrive fallback updated (Google still stale ${staleMinutes}m, ${onedriveData.games.length} games)`);
    } catch (e) {
      console.error(`[${tournamentId}] OneDrive fallback re-poll failed (staying on last-known fallback data):`, e.message || e);
    }
    return;
  }

  // Normal mode: Google is primary and (as far as we know) healthy.
  if (!sameData(cached, googleData)) {
    await env.TOURNAMENT_KV.put(tournamentId, JSON.stringify(googleData));
    console.log(`[${tournamentId}] updated (${googleData.games.length} games)`);
    return;
  }
  console.log(`[${tournamentId}] checked, no change (${googleData.games.length} games)`);

  if (!cached || !cached.generated) return; // no baseline yet to measure staleness against
  const staleMinutes = (Date.now() - new Date(cached.generated).getTime()) / 60000;
  if (staleMinutes <= fb.stale_after_minutes) return;
  if (!isWithinActiveHours(new Date(), fb)) return;

  console.log(`[${tournamentId}] Google stale ${Math.round(staleMinutes)}m during active hours -- attempting OneDrive fallback`);
  try {
    const onedriveData = await refreshTournamentFromOneDrive(cfg, fb, extractTeamName, parseScore);
    const combined = Object.assign({}, onedriveData, {
      _fallback: {
        mode: 'onedrive',
        googleChangedAt: cached.generated,
        googleSnapshot: { games: cached.games, teams: cached.teams },
      },
    });
    await env.TOURNAMENT_KV.put(tournamentId, JSON.stringify(combined));
    console.log(`[${tournamentId}] switched to OneDrive fallback (${onedriveData.games.length} games)`);
  } catch (e) {
    console.error(`[${tournamentId}] OneDrive fallback attempt failed, staying on stale Google data:`, e.message || e);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = /^\/api\/tournaments\/([^/]+)$/.exec(url.pathname);
    if (!m) return new Response('Not found', { status: 404 });
    const tournamentId = decodeURIComponent(m[1]);
    const cfg = sources[tournamentId];
    if (!cfg) return json({ error: 'unknown tournament' }, 404);

    if (request.method === 'POST' && url.searchParams.get('refresh') === 'now') {
      // Manual escape hatch: force an immediate refresh instead of waiting for the next
      // cron tick. A completed/frozen tournament must never be re-fetched once archived.
      if (cfg.status === 'completed') return json({ error: 'tournament is archived' }, 409);
      try {
        if (cfg.fallback && cfg.fallback.only_source) {
          await handleScheduledTickOneDriveOnly(tournamentId, cfg, env, { force: true });
        } else if (cfg.fallback) {
          // Must NOT just force-overwrite with fresh Google data here -- if a OneDrive
          // fallback is currently active because Google is stale, that would silently
          // regress live OneDrive scores back to stale Google ones. Route through the same
          // staleness-aware logic the cron uses so a manual trigger can only ever match or
          // improve on whatever's currently being served, never go backwards.
          await handleScheduledTickWithFallback(tournamentId, cfg, env);
        } else {
          const data = await refreshTournament(cfg, env);
          await env.TOURNAMENT_KV.put(tournamentId, JSON.stringify(data));
        }
        const freshRaw = await env.TOURNAMENT_KV.get(tournamentId);
        return json(stripInternal(JSON.parse(freshRaw)));
      } catch (e) {
        return json({ error: String(e.message || e) }, 502);
      }
    }

    const cached = await env.TOURNAMENT_KV.get(tournamentId);
    if (!cached) return json({ error: 'no data yet -- has the cron run at least once?' }, 404);
    return json(stripInternal(JSON.parse(cached)));
  },

  async scheduled(event, env, ctx) {
    // Two staggered cron patterns (see wrangler.toml) fire on alternating ticks, each as its
    // OWN invocation with a fresh CPU budget -- handling every non-completed tournament in a
    // single invocation was overrunning the Workers Free plan's per-invocation CPU limit
    // every single tick once this season's sheets grew large enough (confirmed live via
    // `wrangler tail`: "Exceeded CPU Limit" on every firing), which silently stopped BOTH
    // tournaments from ever refreshing. `cron_group` in sources.json assigns each tournament
    // to whichever pattern's invocation should handle it.
    const cronGroup = event.cron === CRON_GROUP_A_PATTERN ? 'A' : 'B';
    for (const [tournamentId, cfg] of Object.entries(sources)) {
      // Once a tournament is flagged completed, it's permanently frozen -- never re-polled,
      // never overwritten. (The registry/automatic-freeze workflow itself is follow-up work;
      // this guard is what makes that safe to flip on later without touching this file.)
      if (cfg.status === 'completed') continue;
      if (cfg.cron_group && cfg.cron_group !== cronGroup) continue;

      if (cfg.fallback && cfg.fallback.only_source) {
        ctx.waitUntil(
          handleScheduledTickOneDriveOnly(tournamentId, cfg, env)
            .catch((e) => console.error(`[${tournamentId}] OneDrive-only refresh failed (keeping last-known data):`, e.message || e))
        );
        continue;
      }

      if (cfg.fallback) {
        ctx.waitUntil(
          handleScheduledTickWithFallback(tournamentId, cfg, env)
            .catch((e) => console.error(`[${tournamentId}] fallback-aware refresh failed:`, e.message || e))
        );
        continue;
      }

      ctx.waitUntil((async () => {
        try {
          const data = await refreshTournament(cfg, env);
          const cachedRaw = await env.TOURNAMENT_KV.get(tournamentId);
          const cached = cachedRaw ? JSON.parse(cachedRaw) : null;
          // Logged either way (not just on error) so a tail session shows every tick actually
          // ran, not just the ones that wrote -- "no log line in 6 minutes" is a much clearer
          // signal that the cron itself stalled than silence, which is indistinguishable from
          // "ran fine, nothing changed" (the normal case between score updates).
          if (sameData(cached, data)) {
            console.log(`[${tournamentId}] checked, no change (${data.games.length} games)`);
            return; // nothing changed -- skip the write
          }
          await env.TOURNAMENT_KV.put(tournamentId, JSON.stringify(data));
          console.log(`[${tournamentId}] updated (${data.games.length} games)`);
        } catch (e) {
          console.error(`[${tournamentId}] refresh failed:`, e.message || e);
        }
      })());
    }
  },
};
