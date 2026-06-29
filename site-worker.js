// Thin wrapper around Workers Static Assets: redirects the old domain to the new one,
// handles /t/<id> SEO-friendly tournament URLs, otherwise falls through to serving the
// static site exactly as the assets-only Worker did before this file existed
// (see wrangler.toml's `main` + `[assets] binding`).
const OLD_HOSTS = new Set(['clubwaterpolo.com', 'www.clubwaterpolo.com']);

// Per-tournament metadata for server-side <head> injection on /t/<id> routes.
// Keeps search crawlers (which get the raw HTML before JS runs) indexed on the right content.
// When adding a new tournament: add an entry here AND to sitemap.xml.
// Per-tournament metadata for server-side <head> injection on /t/<id> routes.
// Descriptions are written to rank for the specific event search query while staying
// under ~155 chars so Google displays them untruncated in SERPs.
// When adding a new tournament: add an entry here AND update sitemap.xml.
const TOURNAMENT_META = {
  '2026-girls-us-club-championships': {
    label: '2026 Girls US Club Water Polo Championships',
    description: 'Live bracket, scores &amp; schedule for the 2026 Girls US Club Water Polo Championships. 12U–18U pool standings, bracket results &amp; team placement — updated live.',
    startDate: '2026-06-26',
    keywords: '2026 girls US Club Water Polo Championships, girls water polo bracket, 12U 14U 16U 18U girls water polo, US Club Championships bracket, girls water polo live scores',
  },
  '2026-boys-us-club-championships': {
    label: '2026 Boys US Club Water Polo Championships',
    description: 'Live bracket, scores &amp; schedule for the 2026 Boys US Club Water Polo Championships. 12U–18U pool standings, bracket results &amp; team placement — updated live.',
    startDate: '2026-06-19',
    keywords: '2026 boys US Club Water Polo Championships, boys water polo bracket, 12U 14U 16U 18U boys water polo, US Club Championships bracket, boys water polo live scores',
  },
  '2026-girls-futures-superfinals': {
    label: '2026 Girls Futures Superfinals Water Polo',
    description: 'Live bracket, scores &amp; schedule for the 2026 Girls Futures Superfinals — US Club Water Polo Futures championship. Pool standings &amp; team placement updated live.',
    startDate: '2026-06-19',
    keywords: '2026 girls Futures Superfinals, water polo futures, water polo futures finals, girls water polo futures, Futures Superfinals bracket, US Club Water Polo Futures',
  },
  '2026-boys-futures-superfinals': {
    label: '2026 Boys Futures Superfinals Water Polo',
    description: 'Live bracket, scores &amp; schedule for the 2026 Boys Futures Superfinals — US Club Water Polo Futures championship. Pool standings &amp; team placement updated live.',
    startDate: '2026-06-26',
    keywords: '2026 boys Futures Superfinals, water polo futures, water polo futures finals, boys water polo futures, Futures Superfinals bracket, US Club Water Polo Futures',
  },
};

// Replaces <title>, OG/Twitter meta, and splices in a canonical + JSON-LD block
// for a tournament-specific URL. Called only for /t/<id> routes.
function injectMeta(html, meta, canonicalUrl) {
  const { label, description, startDate, keywords } = meta;
  const title = `${label} | Splash Bracket`;
  const ldJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    'name': label,
    'sport': 'Water Polo',
    'startDate': startDate,
    'url': canonicalUrl,
    'organizer': { '@type': 'Organization', 'name': 'US Club Water Polo' },
    'keywords': keywords || '',
  });
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/,
      `$1${description.replace(/"/g, '&quot;')}$2`)
    // Append tournament-specific keywords to the base keyword list.
    .replace(/(<meta name="keywords" content=")[^"]*(")/,
      (_, open, close) => keywords ? `${open}${keywords.replace(/"/g, '&quot;')}, water polo bracket, water polo tournament, youth water polo, US Club Water Polo, splashbracket${close}` : `${open}water polo tournament${close}`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/,
      `$1${label.replace(/"/g, '&quot;')}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/,
      `$1${description.replace(/"/g, '&quot;')}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/,
      `$1${canonicalUrl}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/,
      `$1${label.replace(/"/g, '&quot;')}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/,
      `$1${description.replace(/"/g, '&quot;')}$2`)
    // Replace the base canonical (which points to /) with the tournament-specific one.
    .replace(/(<link rel="canonical" href=")[^"]*(")/,
      `$1${canonicalUrl}$2`)
    // Inject JSON-LD before </head> (canonical is already in the base HTML, just updated above).
    .replace('</head>', `<script type="application/ld+json">${ldJson}</script>\n</head>`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 301 (permanent) -- clubwaterpolo.com is being phased out; a permanent redirect
    // consolidates link equity to splashbracket.com in Google's index.
    if (OLD_HOSTS.has(url.hostname)) {
      url.hostname = 'splashbracket.com';
      return Response.redirect(url.toString(), 301);
    }

    // /t/<tournament-id> — SEO-friendly tournament URLs.
    // Serves the same app HTML but with server-injected title/description/JSON-LD so
    // search crawlers index the right content before JS runs.
    const tMatch = url.pathname.match(/^\/t\/([^/]+)/);
    if (tMatch) {
      const tournamentId = decodeURIComponent(tMatch[1]);
      const meta = TOURNAMENT_META[tournamentId];
      if (meta) {
        const appUrl = new URL(url);
        appUrl.pathname = '/tournament_app';
        const response = await env.ASSETS.fetch(new Request(appUrl, request));
        const html = await response.text();
        const canonicalUrl = `https://splashbracket.com/t/${tournamentId}`;
        return new Response(injectMeta(html, meta, canonicalUrl), {
          status: response.status,
          headers: {
            'content-type': 'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=60, stale-while-revalidate=300',
          },
        });
      }
    }

    // Serve tournament_app.html's content for "/" directly instead of index.html's
    // client-side meta-refresh stub -- same URL in the address bar, no visible redirect flash.
    // Extensionless, not "/tournament_app.html": Workers Static Assets 307s ".html" paths
    // to their extensionless form, which would just trade one visible redirect for another.
    if (url.pathname === '/') {
      url.pathname = '/tournament_app';
      return env.ASSETS.fetch(new Request(url, request));
    }

    return env.ASSETS.fetch(request);
  },
};
