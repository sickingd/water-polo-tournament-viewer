// List of tournaments the viewer knows about. Exactly one should have status "current" --
// that's the one the app opens to by default. Add a new tournament by running
// tools/refresh_data.py against a new entry in tools/sources.json, then list it here and
// add a matching <script src="data/<id>.js"> tag in tournament_app.html.
window.TOURNAMENT_MANIFEST = [
  {
    id: '2026-girls-us-club-championships',
    label: '2026 Girls US Club Championships',
    year: 2026,
    start_date: '2026-06-26',
    status: 'current',
  },
  {
    id: '2026-girls-futures-superfinals',
    label: '2026 Girls Futures Superfinals',
    year: 2026,
    start_date: '2026-06-19',
    status: 'completed',
  },
];
