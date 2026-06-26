// Thin wrapper around Workers Static Assets: redirects the old domain to the new one,
// otherwise falls through to serving the static site exactly as the assets-only Worker did
// before this file existed (see wrangler.toml's `main` + `[assets] binding`).
//
// 302 (temporary), not 301 -- clubwaterpolo.com is being phased out but isn't fully
// retired yet, so this shouldn't get permanently cached by browsers/search engines.
const OLD_HOSTS = new Set(['clubwaterpolo.com', 'www.clubwaterpolo.com']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (OLD_HOSTS.has(url.hostname)) {
      url.hostname = 'splashbracket.com';
      return Response.redirect(url.toString(), 302);
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
