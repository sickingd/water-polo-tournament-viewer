#!/usr/bin/env python3
"""Pull the latest scores/schedule for a tournament from its live, public Google Sheet
and regenerate data/<tournament_id>.js for the viewer.

Run by hand whenever you want fresh data -- this is *not* called from the browser (the
sheet sends no CORS headers, so a page can't fetch it directly). After running this,
just reload tournament_app.html.

Usage:
    python3 tools/refresh_data.py                    # refresh every tournament in sources.json
    python3 tools/refresh_data.py <tournament_id>     # refresh just one

Stdlib only -- no pip install needed.
"""
import csv
import io
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES_FILE = ROOT / 'tools' / 'sources.json'
DATA_DIR = ROOT / 'data'

MONTHS = {m: i + 1 for i, m in enumerate(
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])}

# Mirrors src/resolver.js's splitToken: pulls a trailing "-{TEAM}" cached resolution off
# any slot/ordinal/bracket-progress/placement token, ignoring hyphens inside parens.
TOKEN_RE = re.compile(r'^([^()-]+?)((?:\([^()]*\))*)(?:-(.*))?$')

# A *concrete round-robin slot* token, e.g. "A1-SANTA BARBARA A" -- no parens, head is just
# {GROUP_LETTER}{POSITION}. These are fixed day-1 seeding assignments, never computed, so
# they're the only place a team's name is guaranteed correct. Every other token type ("1stA",
# "W#QF2", "K1(2ndE)", ...) is a downstream formula and the live sheet has shown at least one
# bug there: a club's squad-letter suffix ("SANTA BARBARA A") silently dropped to just
# "SANTA BARBARA" on a "1stA" cell. Only extracting team names from slot tokens means that
# kind of mangled cell can never inject a phantom team into the picker list.
SLOT_TOKEN_RE = re.compile(r'^[A-Za-z]+\d+$')

# A handful of divisions (e.g. 10U_COED in the Club Championships format) play a flat round
# robin with no "A1-" slot convention at all -- the WHITE/DARK cell is just the team name
# outright. extract_team_name() below trusts a dash-less head as a literal name UNLESS it
# matches one of these unresolved-formula shapes (a W#/L# bracket ref or an ordinal group
# finish with no cached name), which must stay untrusted like any other formula token.
BARE_PROGRESS_RE = re.compile(r'^[WL]#', re.IGNORECASE)
BARE_FINISH_RE = re.compile(r'^\d+(?:st|nd|rd|th)[A-Za-z]+$', re.IGNORECASE)


def fetch_sheet_csv(sheet_id, sheet_name):
    url = ('https://docs.google.com/spreadsheets/d/%s/gviz/tq?%s' %
           (sheet_id, urllib.parse.urlencode({'tqx': 'out:csv', 'sheet': sheet_name})))
    with urllib.request.urlopen(url, timeout=30) as resp:
        return resp.read().decode('utf-8')


# The gviz/tq endpoint above (used by the old per-sheet-name format) was confirmed to serve a
# STALE, edge-cached snapshot for the Club Championships docs -- e.g. a score typed into the
# live sheet days ago still came back blank from gviz on every refetch, cache-busting query
# params included, while /export?format=csv returned the correct value immediately every
# time. These single-tab docs never need a sheet name, so gid=0 (the default/only tab) via
# /export is both simpler and actually live.
def fetch_sheet_csv_export(sheet_id):
    url = 'https://docs.google.com/spreadsheets/d/%s/export?format=csv&gid=0' % sheet_id
    with urllib.request.urlopen(url, timeout=30) as resp:
        return resp.read().decode('utf-8')


def parse_date(raw, year):
    m = re.match(r'(\d+)-([A-Za-z]+)', raw.strip())
    if not m:
        return raw.strip()
    day, mon = int(m.group(1)), MONTHS.get(m.group(2)[:3].title())
    if not mon:
        return raw.strip()
    return f'{year:04d}-{mon:02d}-{day:02d}'


# A shootout-decided score is goals + a decimal shootout tally (e.g. "7.1"). At least one
# live cell had that typed with a comma instead ("7,2") -- a locale-keyboard slip, not a
# different format -- so normalize before parsing rather than letting float() reject it.
def parse_score(raw):
    return float(raw.replace(',', '.'))


def extract_team_name(token):
    m = TOKEN_RE.match((token or '').strip())
    if not m:
        return None
    head, parens, team = m.group(1), m.group(2), m.group(3)
    if parens or not SLOT_TOKEN_RE.match(head):
        if (not team and not parens and not BARE_PROGRESS_RE.match(head)
                and not BARE_FINISH_RE.match(head)):
            return head.strip() or None
        return None
    return team.strip() if team and team.strip() else None


def build_tournament_data(tournament_id, cfg):
    print(f'[{tournament_id}] fetching "{cfg["master_sheet_name"]}" from live sheet...')
    csv_text = fetch_sheet_csv(cfg['sheet_id'], cfg['master_sheet_name'])
    rows = list(csv.reader(io.StringIO(csv_text)))
    if not rows:
        raise RuntimeError('empty sheet response')
    header = [h.strip().upper() for h in rows[0]]

    def col(name):
        return header.index(name)

    idx = {
        'date': col('DATE'), 'time': col('TIME'), 'location': col('LOCATION'),
        'game_id': col('GAME#'), 'white': col('WHITE'), 'white_score': col('S'),
        'dark': None, 'dark_score': None, 'comments': col('COMMENTS'),
        'division': col('DIVISION'),
    }
    # There are two columns literally named "S" (white score, dark score) -- find the second.
    s_cols = [i for i, h in enumerate(header) if h == 'S']
    idx['white_score'], idx['dark_score'] = s_cols[0], s_cols[1]
    idx['dark'] = col('DARK')

    games = []
    teams = {}  # (name, division) -> True
    for r in rows[1:]:
        if len(r) <= idx['game_id'] or not r[idx['game_id']].strip():
            continue
        game_id = r[idx['game_id']].strip()
        division = r[idx['division']].strip()
        white = r[idx['white']].strip()
        dark = r[idx['dark']].strip()
        ws_raw = r[idx['white_score']].strip()
        ds_raw = r[idx['dark_score']].strip()
        played = ws_raw != '' and ds_raw != ''
        games.append({
            'date': parse_date(r[idx['date']], cfg['year']),
            'time': r[idx['time']].strip(),
            'location': r[idx['location']].strip(),
            'game_id': game_id,
            'white': white,
            'white_score': parse_score(ws_raw) if played else None,
            'dark': dark,
            'dark_score': parse_score(ds_raw) if played else None,
            'round': r[idx['comments']].strip(),
            'division': division,
            'played': played,
        })
        for tok in (white, dark):
            name = extract_team_name(tok)
            if name:
                teams[(name, division)] = True

    games.sort(key=lambda g: g['game_id'])
    team_list = [{'name': n, 'division': d} for (n, d) in sorted(teams.keys())]
    print(f'[{tournament_id}] {len(games)} games, {len(team_list)} teams across '
          f'{len({g["division"] for g in games})} divisions')
    return {
        'tournament': cfg['label'],
        'generated': datetime.now(timezone.utc).isoformat(),
        'games': games,
        'teams': team_list,
    }


# =====================================================================================
# "Club Championships" format -- separate from build_tournament_data() above on purpose.
# Multiple spreadsheets (one per age group), no GAME# column, no DIVISION column, a
# different DATE format, and two token-grammar quirks not present in the old format. See
# TOURNAMENT_DATA_SPEC.md / the plan that introduced this for the full reverse-engineering
# notes. This block must never be merged with the old-format parser above: the old format
# will recur for future tournaments and its logic must stay exactly as-is.
# =====================================================================================

# Day-boundary header repeat, e.g. `"","LOCATION","","WHITE TEAM",...` -- the LOCATION
# column literally contains the word "LOCATION" again.
CC_HEADER_REPEAT = 'LOCATION'

# A broken merged-cell cross-reference into another age group's sheet renders as the DARK
# TEAM cell containing the bare literal word "GAME" (e.g. `"18 GIRLS","","GAME"`). A real
# dark-team token never matches this exactly, so it's a safe, specific filter.
CC_BOGUS_DARK = 'GAME'

CC_GAME_STAMP_RE = re.compile(r'GAME\s*#\s*(\d+)', re.IGNORECASE)
CC_WINNER_LOSER_RE = re.compile(r'^(WINNER|LOSER)\s*#\s*(\d+)(.*)$', re.IGNORECASE)
# No-parens placement-seed form seen in the 12U sheet only, e.g. "E1 -1st A - TEAM" --
# resolver.js's existing `seed` token type expects parens around the source
# ("E1(1stA)-TEAM"), which is what files using "T3 (3rdF) - " already match once trimmed.
CC_NOPAREN_SEED_RE = re.compile(
    r'^([A-Za-z]+\d+)\s*-\s*(\d+(?:st|nd|rd|th))\s*([A-Za-z]+)\s*-\s*(.*)$', re.IGNORECASE)
# Dash-before-parens placement-seed form, e.g. "AA1-(1st W)-" -- common in the 14U/16U/18U
# placement brackets (S/T/W/X/Y/Z/AA/BB/.../LL groups). resolver.js's splitToken expects the
# parens to immediately follow the head with no hyphen in between ("AA1(1stW)-"); the extra
# hyphen here makes it misparse the *whole* "(1st W)-" remainder as a literal cached team
# name, which is exactly the "(1st W)" bogus team the Placement Tracker was showing.
CC_DASHPAREN_SEED_RE = re.compile(
    r'^([A-Za-z]+\d+)-\((\d+(?:st|nd|rd|th))\s*([A-Za-z]+)\)-(.*)$', re.IGNORECASE)


def parse_date_mdy(raw):
    m = re.match(r'(\d+)/(\d+)/(\d+)', (raw or '').strip())
    if not m:
        return (raw or '').strip()
    month, day, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return f'{year:04d}-{month:02d}-{day:02d}'


# Matches the leading "{LETTERS}{digits}" of EITHER a bare slot ("A1-NEWPORT") or a seed
# ("K1(1stC)-") -- this sheet uses the exact same "two entrants of group LET" shape for both
# the initial pool stage (A-H, bare slots) and single-game crossover "mini-groups" later in
# the bracket (e.g. K/L/M/N, I/J, W/X/Y/Z -- seeds wrapping the previous round's finish).
# Both need the same standings/round-robin treatment, just with different head token types.
CC_GROUP_LETTER_RE = re.compile(r'^([A-Za-z]+)\d+')


def pool_group_letter(white, dark):
    """If both (already-collapsed) tokens belong to the *same* LET group (whether bare
    slots or seeds), this game determines that group's standings -- returns the shared
    group letter, else None."""
    mw, md = CC_GROUP_LETTER_RE.match(white), CC_GROUP_LETTER_RE.match(dark)
    if mw and md and mw.group(1) == md.group(1):
        return mw.group(1)
    return None


def normalize_clubchamps_token(raw):
    s = (raw or '').strip()
    # Unlike the old format ("A1-STANFORD", never spaced), this sheet inconsistently writes
    # slot tokens with spaces around the hyphen ("B1 -  LAMORINDA" alongside "A1-NEWPORT" in
    # the same column) -- collapse that whitespace first so the shared TOKEN_RE/SLOT_TOKEN_RE
    # (and resolver.js's splitToken) see one consistent "{HEAD}-{TEAM}" shape either way.
    s = re.sub(r'\s*-\s*', '-', s)
    m = CC_WINNER_LOSER_RE.match(s)
    if m:
        letter = 'W' if m.group(1).upper() == 'WINNER' else 'L'
        return f'{letter}#{m.group(2)}{m.group(3)}'
    m = CC_DASHPAREN_SEED_RE.match(s)
    if m:
        slot, ord_, group, team = m.group(1), m.group(2), m.group(3), m.group(4).strip()
        return f'{slot}({ord_}{group})-{team}'
    m = CC_NOPAREN_SEED_RE.match(s)
    if m:
        slot, ord_, group, team = m.group(1), m.group(2), m.group(3), m.group(4).strip()
        return f'{slot}({ord_}{group})-{team}'
    return s


def build_clubchamps_tournament_data(tournament_id, cfg):
    all_games = []
    teams = {}  # (name, division) -> True
    for source in cfg['sources']:
        division = source['division']
        print(f'[{tournament_id}] fetching {division} from sheet {source["sheet_id"]}...')
        csv_text = fetch_sheet_csv_export(source['sheet_id'])
        rows = list(csv.reader(io.StringIO(csv_text)))
        if not rows:
            raise RuntimeError(f'empty sheet response for {division}')
        # The real header isn't always row 0 -- organizers prepend ad-hoc announcement rows
        # ("GATE FEE THIS WEEKEND...", "SCHEDULE UPDATED...") above it, and the count varies
        # by sheet and changes over time. Find the row that actually has 'LOCATION' as a cell
        # instead of assuming a fixed offset.
        header_idx = next((i for i, r in enumerate(rows) if 'LOCATION' in [c.strip().upper() for c in r]), None)
        if header_idx is None:
            raise RuntimeError(f'could not find header row (no LOCATION cell) for {division}')
        header = [h.strip().upper() for h in rows[header_idx]]
        rows = rows[header_idx:]
        loc_idx = header.index('LOCATION')
        time_idx = header.index('TIME')
        white_idx = header.index('WHITE TEAM')
        dark_idx = header.index('DARK TEAM')
        comments_idx = header.index('COMMENTS')
        s_cols = [i for i, h in enumerate(header) if h == 'S']
        white_score_idx, dark_score_idx = s_cols[0], s_cols[1]
        date_idx = 0  # the DATE header cell is polluted with a weekly banner string

        # Pass 1: clean rows + capture each row's *official* GAME# stamp, if any. The stamp
        # is NOT row-order (confirmed against the live sheet: e.g. 18U_GIRLS row 1 is stamped
        # "GAME #7" while row 8 is stamped "GAME #1") -- it's the bracket's own numbering,
        # and WINNER #N / LOSER #N refs point at that number, not at sheet position. So the
        # stamp must be trusted directly rather than re-numbered by row order.
        cleaned = []
        for r in rows[1:]:
            if not any((c or '').strip() for c in r):
                continue
            if len(r) <= dark_idx:
                continue
            if (r[loc_idx] or '').strip().upper() == CC_HEADER_REPEAT:
                continue
            if (r[dark_idx] or '').strip().upper() == CC_BOGUS_DARK:
                continue
            white_raw = (r[white_idx] or '').strip()
            dark_raw = (r[dark_idx] or '').strip()
            if not white_raw and not dark_raw:
                continue
            comments = (r[comments_idx] or '').strip()
            stamp_m = CC_GAME_STAMP_RE.search(comments)
            white = normalize_clubchamps_token(white_raw)
            dark = normalize_clubchamps_token(dark_raw)
            cleaned.append({
                'row': r, 'white': white, 'dark': dark,
                'comments': comments, 'stamp': int(stamp_m.group(1)) if stamp_m else None,
            })

        # Some divisions (e.g. 10U_COED) play a flat round robin with no "A1-"/seed slot
        # grammar anywhere -- WHITE/DARK cells are bare team names from start to finish, no
        # bracket at all. Detect that once per division (not per game, which could misfire on
        # a genuine head-to-head placement game using a cached literal name inside an
        # otherwise-structured bracket) and synthesize a single implicit group "A" for the
        # whole division below.
        division_is_flat = not any(
            CC_GROUP_LETTER_RE.match(c['white']) or CC_GROUP_LETTER_RE.match(c['dark'])
            or c['white'].upper().startswith(('W#', 'L#')) or c['dark'].upper().startswith(('W#', 'L#'))
            for c in cleaned
        )

        # Pass 2: assign each row a number. Stamped rows keep their official number (this is
        # what WINNER#/LOSER# refs resolve against); unstamped rows (pool play -- never
        # referenced by number) get the next number from a range well clear of any stamp seen
        # in this division, so they can never collide with a real stamped number.
        max_stamp = max((c['stamp'] for c in cleaned if c['stamp'] is not None), default=0)
        next_unstamped = max(max_stamp, 99) + 1
        used_numbers = set()
        for c in cleaned:
            num = c['stamp']
            if num is None or num in used_numbers:
                num = next_unstamped
                next_unstamped += 1
            used_numbers.add(num)

            r = c['row']
            ws_raw = (r[white_score_idx] or '').strip()
            ds_raw = (r[dark_score_idx] or '').strip()
            played = ws_raw != '' and ds_raw != ''
            round_label = CC_GAME_STAMP_RE.sub('', c['comments']).strip()
            white = c['white']
            dark = c['dark']
            if not round_label:
                if division_is_flat:
                    round_label = 'A bracket'
                else:
                    # Unlike the old format (COMMENTS always said e.g. "B bracket B1,B3" for
                    # pool play), this sheet leaves pool-play COMMENTS blank -- src/resolver.js's
                    # round-robin detector requires the literal word "bracket"/"RR" in the round
                    # label, so a same-letter bare-slot-vs-bare-slot game (the only shape pool
                    # play ever takes here) is tagged the same way the old format already does.
                    pool_let = pool_group_letter(white, dark)
                    if pool_let:
                        round_label = f'{pool_let} bracket'
            all_games.append({
                'date': parse_date_mdy(r[date_idx]),
                'time': (r[time_idx] or '').strip(),
                'location': (r[loc_idx] or '').strip(),
                'game_id': f'{division}-{num:03d}',
                'white': white,
                'white_score': parse_score(ws_raw) if played else None,
                'dark': dark,
                'dark_score': parse_score(ds_raw) if played else None,
                'round': round_label,
                'division': division,
                'played': played,
            })
            for tok in (white, dark):
                name = extract_team_name(tok)
                if name:
                    teams[(name, division)] = True

    team_list = [{'name': n, 'division': d} for (n, d) in sorted(teams.keys())]
    print(f'[{tournament_id}] {len(all_games)} games, {len(team_list)} teams across '
          f'{len(cfg["sources"])} divisions')
    return {
        'tournament': cfg['label'],
        'generated': datetime.now(timezone.utc).isoformat(),
        'games': all_games,
        'teams': team_list,
    }


def write_data_file(tournament_id, data):
    DATA_DIR.mkdir(exist_ok=True)
    out_path = DATA_DIR / f'{tournament_id}.js'
    js = (
        'window.TOURNAMENTS = window.TOURNAMENTS || {};\n'
        f'window.TOURNAMENTS[{json.dumps(tournament_id)}] = {json.dumps(data)};\n'
    )
    out_path.write_text(js, encoding='utf-8')
    print(f'[{tournament_id}] wrote {out_path.relative_to(ROOT)}')


def main():
    sources = json.loads(SOURCES_FILE.read_text(encoding='utf-8'))
    requested = sys.argv[1:] or list(sources.keys())
    for tid in requested:
        if tid not in sources:
            print(f'Unknown tournament id "{tid}" -- check tools/sources.json', file=sys.stderr)
            sys.exit(1)
        cfg = sources[tid]
        if cfg.get('status') == 'completed':
            print(f'[{tid}] completed -- skipping refresh (data is frozen)')
            continue
        if 'sources' in cfg:
            data = build_clubchamps_tournament_data(tid, cfg)
        else:
            data = build_tournament_data(tid, cfg)
        write_data_file(tid, data)


if __name__ == '__main__':
    main()
