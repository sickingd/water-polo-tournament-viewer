// Fallback live-data source: OneDrive Excel, used only when the primary Google Sheet for a
// tournament has gone stale (see the staleness/switchover logic in index.js's scheduled()).
//
// This whole module exists because the boys 2026 Futures Superfinals organizers stopped
// updating the Google Sheet mid-tournament but kept updating a parallel OneDrive workbook --
// confirmed by comparing the two by hand (Google: 0 played games, generated 11.5h stale;
// OneDrive: 51 real scored games from that same day).
//
// Unlike Google's CSV/gviz export, OneDrive's "anyone with the link" share has no simple
// single-URL stateless export. Getting the live file requires replicating the share-link
// redirect flow a browser does: hit the 1drv.ms short link, follow redirects while collecting
// Set-Cookie headers (Workers' fetch() has no browser-style automatic cookie jar across
// redirects -- confirmed by testing `redirect: 'follow'` first and getting 401/0 cookies),
// then use those cookies against a separate download.aspx?UniqueId=... endpoint to get the
// actual .xlsx bytes. Reusing one minted session for a second download was observed to get
// blocked ("The request is blocked") -- so every poll mints a brand-new session from scratch
// rather than caching/reusing one across polls.
//
// This is an unofficial, reverse-engineered flow (no public Microsoft API contract). It could
// break if Microsoft changes the share-link flow or tightens anti-bot detection. Treat any
// failure here as expected/recoverable, not a bug to fix blindly -- see scheduled()'s handling.

import { unzip } from 'unzipit';
import { XMLParser } from 'fast-xml-parser';

async function followRedirectsCollectingCookies(startUrl) {
  const jar = new Map();
  function applySetCookies(res) {
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  function cookieHeader() {
    return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  let url = startUrl;
  let hops = 0;
  while (hops < 10) {
    const res = await fetch(url, { redirect: 'manual', headers: { Cookie: cookieHeader() } });
    applySetCookies(res);
    if (res.status >= 300 && res.status < 400 && res.headers.get('Location')) {
      url = new URL(res.headers.get('Location'), url).toString();
      await res.body?.cancel();
      hops++;
      continue;
    }
    await res.text(); // drain the final landing page -- we only needed its cookies
    break;
  }
  return cookieHeader;
}

async function fetchOneDriveXlsx(fallbackCfg) {
  const cookieHeader = await followRedirectsCollectingCookies(fallbackCfg.share_url);
  const downloadUrl = `https://onedrive.live.com/personal/${fallbackCfg.personal_id}/_layouts/15/download.aspx` +
    `?UniqueId=${fallbackCfg.unique_id}&Translate=false`;
  const res = await fetch(downloadUrl, { headers: { Cookie: cookieHeader() } });
  if (!res.ok) throw new Error(`OneDrive download failed: HTTP ${res.status}`);
  return res.arrayBuffer();
}

// Excel serial date (days since 1899-12-30 -- the historical leap-year-bug epoch that, despite
// being "wrong", is the standard conversion every spreadsheet tool uses) -> 'YYYY-MM-DD'.
function excelSerialToDateString(serial) {
  const ms = Date.UTC(1899, 11, 30) + Math.round(parseFloat(serial)) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// Excel time-of-day fraction (0..1) -> '8:00 AM' to match the format Google's CSV export
// already gives us as a pre-formatted display string (raw XLSX cells store unformatted
// numbers -- the display format lives separately in styles.xml, which we don't replicate).
function excelFractionToTimeString(frac) {
  const totalMinutes = Math.round(parseFloat(frac) * 24 * 60);
  let h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function colLetterToIndex(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  const letters = m[1];
  let col = 0;
  for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
  return col - 1;
}

// Returns {header, rows} -- rows is an array of arrays of *raw cell strings* (dates/times
// still as unconverted Excel serial-number strings), deliberately mirroring the shape
// parseCsv() gives the Google-Sheets path so the two sources can share row-handling
// conventions even though they don't share code.
async function parseXlsxSheetRows(xlsxArrayBuffer, sheetName) {
  const { entries } = await unzip(xlsxArrayBuffer);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

  const workbook = parser.parse(await entries['xl/workbook.xml'].text());
  const sheetList = workbook.workbook.sheets.sheet;
  const sheetArr = Array.isArray(sheetList) ? sheetList : [sheetList];
  const target = sheetArr.find((s) => s['@_name'] === sheetName);
  if (!target) throw new Error(`sheet "${sheetName}" not found in workbook`);
  const rId = target['@_r:id'];

  const rels = parser.parse(await entries['xl/_rels/workbook.xml.rels'].text());
  const relList = rels.Relationships.Relationship;
  const relArr = Array.isArray(relList) ? relList : [relList];
  const rel = relArr.find((r) => r['@_Id'] === rId);
  const sheetPath = 'xl/' + rel['@_Target'];

  const sharedStringsParsed = parser.parse(await entries['xl/sharedStrings.xml'].text());
  const siList = sharedStringsParsed.sst.si;
  const siArr = Array.isArray(siList) ? siList : [siList];
  const sharedStrings = siArr.map((si) => {
    if (si.t !== undefined) return typeof si.t === 'object' ? (si.t['#text'] ?? '') : String(si.t);
    if (si.r) {
      const runs = Array.isArray(si.r) ? si.r : [si.r];
      return runs.map((r) => (typeof r.t === 'object' ? (r.t['#text'] ?? '') : String(r.t ?? ''))).join('');
    }
    return '';
  });

  const sheetParsed = parser.parse(await entries[sheetPath].text());
  const rowsXml = sheetParsed.worksheet.sheetData.row;
  const rowArr = Array.isArray(rowsXml) ? rowsXml : [rowsXml];

  function cellValue(c) {
    const raw = c.v;
    if (raw === undefined) return '';
    const text = typeof raw === 'object' ? (raw['#text'] ?? '') : String(raw);
    if (c['@_t'] === 's') return sharedStrings[parseInt(text, 10)] ?? '';
    return text;
  }

  const rows = [];
  for (const row of rowArr) {
    if (!row.c) { rows.push([]); continue; }
    const cells = Array.isArray(row.c) ? row.c : [row.c];
    const out = [];
    for (const c of cells) {
      const idx = colLetterToIndex(c['@_r']);
      out[idx] = cellValue(c);
    }
    rows.push(out);
  }
  return { header: rows[0], rows: rows.slice(1) };
}

// Mirrors buildTournamentData()'s old-format column layout in index.js (same DATE/TIME/
// LOCATION/GAME#/WHITE/S/DARK/S/COMMENTS/DIVISION/SORTKEY schema) but kept as a fully separate
// function rather than a shared helper -- this is new, less-trusted code on an unofficial data
// path, and the existing Google-Sheets parser has been working in production; isolating this
// keeps it from being able to regress that path even by accident.
export function buildTournamentDataFromOneDriveRows(cfg, header, rows, extractTeamName, parseScore) {
  const upperHeader = header.map((h) => (h || '').trim().toUpperCase());
  const col = (name) => upperHeader.indexOf(name);
  const sCols = [];
  upperHeader.forEach((h, i) => { if (h === 'S') sCols.push(i); });
  const idx = {
    date: col('DATE'), time: col('TIME'), location: col('LOCATION'),
    game_id: col('GAME#'), white: col('WHITE'), dark: col('DARK'),
    white_score: sCols[0], dark_score: sCols[1],
    comments: col('COMMENTS'), division: col('DIVISION'),
  };

  const games = [];
  const teamsMap = new Map();
  for (const row of rows) {
    if (row.length <= idx.game_id || !(row[idx.game_id] || '').trim()) continue;
    const white = (row[idx.white] || '').trim();
    const dark = (row[idx.dark] || '').trim();
    const wsRaw = (row[idx.white_score] || '').trim();
    const dsRaw = (row[idx.dark_score] || '').trim();
    const played = wsRaw !== '' && dsRaw !== '';
    const division = (row[idx.division] || '').trim();
    const dateRaw = (row[idx.date] || '').trim();
    const timeRaw = (row[idx.time] || '').trim();
    games.push({
      date: dateRaw ? excelSerialToDateString(dateRaw) : '',
      time: timeRaw ? excelFractionToTimeString(timeRaw) : '',
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

export async function refreshTournamentFromOneDrive(cfg, fallbackCfg, extractTeamName, parseScore) {
  const buf = await fetchOneDriveXlsx(fallbackCfg);
  const { header, rows } = await parseXlsxSheetRows(buf, fallbackCfg.master_sheet_name);
  return buildTournamentDataFromOneDriveRows(cfg, header, rows, extractTeamName, parseScore);
}
