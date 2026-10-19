// Cloudflare Worker: tiny CORS proxy for the few FPL Draft endpoints this site needs.
// Deploy: dash.cloudflare.com -> Workers & Pages -> your worker -> Edit code -> paste -> Deploy.
const BASE = 'https://draft.premierleague.com';
const ENTRIES = new Set(['339281', '339357', '339604', '348889']);   // draft entry ids in the league
const ROUTES = [
  [/^\/league$/, () => '/api/league/64420/details', 60],
  [/^\/bootstrap$/, () => '/api/bootstrap-static', 3600],
  [/^\/live\/(\d{1,2})$/, m => `/api/event/${m[1]}/live`, 60],
  [/^\/picks\/(\d{1,7})\/(\d{1,2})$/, m => (ENTRIES.has(m[1]) ? `/api/entry/${m[1]}/event/${m[2]}` : null), 60],
];

export default {
  async fetch(request) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const path = new URL(request.url).pathname;
    for (const [re, build, ttl] of ROUTES) {
      const m = path.match(re);
      if (!m) continue;
      const target = build(m);
      if (!target) break;
      const r = await fetch(BASE + target, { cf: { cacheTtl: ttl, cacheEverything: true }, headers: { 'User-Agent': 'zev-fpl-tracker' } });
      return new Response(r.body, {
        status: r.status,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
      });
    }
    return new Response('Not found', { status: 404, headers: cors });
  },
};
