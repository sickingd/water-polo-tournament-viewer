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


def fetch_sheet_csv(sheet_id, sheet_name):
    url = ('https://docs.google.com/spreadsheets/d/%s/gviz/tq?%s' %
           (sheet_id, urllib.parse.urlencode({'tqx': 'out:csv', 'sheet': sheet_name})))
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


def extract_team_name(token):
    m = TOKEN_RE.match((token or '').strip())
    if not m:
        return None
    head, parens, team = m.group(1), m.group(2), m.group(3)
    if parens or not SLOT_TOKEN_RE.match(head):
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
            'white_score': float(ws_raw) if played else None,
            'dark': dark,
            'dark_score': float(ds_raw) if played else None,
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
        data = build_tournament_data(tid, sources[tid])
        write_data_file(tid, data)


if __name__ == '__main__':
    main()
