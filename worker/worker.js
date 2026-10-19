// Cloudflare Worker: tiny CORS proxy for the few FPL Draft endpoints this site needs,
// plus /prices: classic-FPL prices keyed by player code (the full classic bootstrap is ~1.8MB, so slim it here).
// Deploy: dash.cloudflare.com -> Workers & Pages -> your worker -> Edit code -> paste -> Deploy.
const BASE = 'https://draft.premierleague.com';
const PRICE_TTL = 3600;   // classic prices: reuse a fetch for up to 1 hour
const ENTRIES = new Set(['339281', '339357', '339604', '348889']);   // draft entry ids in the league
const ROUTES = [
  [/^\/league$/, () => '/api/league/64420/details', 60],
  [/^\/bootstrap$/, () => '/api/bootstrap-static', 3600],
  [/^\/live\/(\d{1,2})$/, m => `/api/event/${m[1]}/live`, 60],
  [/^\/picks\/(\d{1,7})\/(\d{1,2})$/, m => (ENTRIES.has(m[1]) ? `/api/entry/${m[1]}/event/${m[2]}` : null), 60],
  [/^\/choices$/, () => '/api/draft/64420/choices', 86400],          // the draft itself never changes
  [/^\/trades$/, () => '/api/draft/league/64420/trades', 600],
];

export default {
  async fetch(request) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const path = new URL(request.url).pathname;
    if (path === '/prices') {
      const r = await fetch('https://fantasy.premierleague.com/api/bootstrap-static/', { cf: { cacheTtl: PRICE_TTL, cacheEverything: true }, headers: { 'User-Agent': 'zev-fpl-tracker' } });
      if (!r.ok) return new Response('Upstream error', { status: 502, headers: cors });
      const prices = {};
      (await r.json()).elements.forEach(e => { prices[e.code] = e.now_cost; });   // now_cost is in tenths of £m
      return new Response(JSON.stringify(prices), {
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${PRICE_TTL}` },
      });
    }
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
