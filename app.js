// ---- config -------------------------------------------------------------
// After deploying worker/worker.js, paste its URL here (e.g. https://zev-fpl.yourname.workers.dev).
const WORKER_URL = 'https://lucky-lake-ea03.zijizhouziji.workers.dev';
const FPL_URL = 'https://draft.premierleague.com/api/league/64420/details';
const POINTS = [3, 1, 0, 0];           // by place
const FIRST_GW = 7;

// ---- data loading -------------------------------------------------------
// Raw FPL response -> our normalized shape (same as data.json)
function normalize(raw) {
  return {
    fetchedAt: new Date().toISOString(),
    teams: raw.league_entries.map(e => ({
      id: e.id, entry: e.entry_id, team: e.entry_name, manager: `${e.player_first_name} ${e.player_last_name}`.trim(),
    })),
    matches: raw.matches.filter(m => m.event >= FIRST_GW).map(m => ({
      event: m.event, finished: m.finished, started: m.started,
      a: m.league_entry_1, ap: m.league_entry_1_points, b: m.league_entry_2, bp: m.league_entry_2_points,
    })),
  };
}
async function getJSON(url, ms = 6000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal, cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
async function load() {
  const live = [WORKER_URL && (base() + '/league'), FPL_URL].filter(Boolean);
  for (const u of live) {
    try { const raw = await getJSON(u); if (raw.matches && raw.league_entries) return { data: normalize(raw), live: true }; } catch (e) { /* try next */ }
  }
  return { data: await getJSON('data.json?' + Date.now()), live: false };
}

// ---- scoring ------------------------------------------------------------
function leaguePoints(scores) {            // scores: 4 numbers -> 4 league pts, ties split
  return scores.map(s => {
    const above = scores.filter(x => x > s).length;
    const tied = scores.filter(x => x === s).length;
    let sum = 0; for (let p = above; p < above + tied; p++) sum += POINTS[p] || 0;
    return sum / tied;
  });
}
function compute(data) {
  const teams = data.teams;
  const byGw = {};
  data.matches.forEach(m => {
    const g = byGw[m.event] ||= { pts: {}, started: false, allFinished: true, n: 0 };
    g.pts[m.a] = m.ap; g.pts[m.b] = m.bp; g.n++;
    if (m.started) g.started = true;
    if (!m.finished) g.allFinished = false;
  });
  const gws = Object.keys(byGw).map(Number).sort((x, y) => x - y).map(ev => {
    const g = byGw[ev];
    const scores = teams.map(t => g.pts[t.id]);
    const status = !g.started ? 'upcoming' : (g.allFinished && g.n === 2 ? 'final' : 'live');
    return { ev, status, scores, lp: status === 'upcoming' ? null : leaguePoints(scores) };
  });
  const season = teams.map((t, i) => {
    let lp = 0, prov = 0, fpl = 0, n = 0;
    gws.forEach(g => { if (!g.lp) return; lp += g.lp[i]; fpl += g.scores[i]; n++; if (g.status === 'live') prov += g.lp[i]; });
    return { ...t, lp, prov, fpl, n };
  }).sort((a, b) => b.lp - a.lp || b.fpl - a.fpl);
  return { gws, season, teams };
}

// ---- render -------------------------------------------------------------
const fmt = n => (Math.round(n * 100) / 100).toString();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render({ gws, season, teams }) {
  document.getElementById('season').innerHTML =
    '<tr><th>#</th><th>Team</th><th>Manager</th><th>League pts</th><th>FPL pts</th><th>GWs</th></tr>' +
    season.map((s, i) => `<tr><td>${i + 1}</td><td class="team">${esc(s.team)}</td><td class="mgr">${esc(s.manager)}</td>` +
      `<td class="pts">${fmt(s.lp)}${s.prov ? ` <span class="badge live" title="includes provisional points">${fmt(s.prov)} live</span>` : ''}</td>` +
      `<td>${s.fpl}</td><td>${s.n}</td></tr>`).join('');

  const started = gws.filter(g => g.status !== 'upcoming').reverse();
  document.getElementById('gws').innerHTML =
    '<tr><th>GW</th>' + teams.map(t => `<th>${esc(t.team)}</th>`).join('') + '</tr>' +
    (started.map(g => {
      const max = Math.max(...g.scores);
      return `<tr class="gw ${g.status === 'live' ? 'is-live' : ''}" data-ev="${g.ev}"><td><span class="chev">▶</span><b>${g.ev}</b>${g.status === 'live' ? ' <span class="badge live">live</span>' : ''}</td>` +
        g.scores.map((s, i) => `<td><div class="cell ${s === max ? 'top' : ''}"><b>${fmt(g.lp[i])}</b><small>${s} FPL</small></div></td>`).join('') + '</tr>';
    }).join('') || `<tr><td colspan="5">No gameweeks started yet.</td></tr>`);
}

// ---- lineups (click a gameweek row) -------------------------------------
let state = null, bootP = null;
const POS = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const base = () => WORKER_URL.replace(/\/$/, '');
function players() {
  return bootP ||= getJSON(base() + '/bootstrap', 20000).then(b => {
    const m = {}; b.elements.forEach(e => { m[e.id] = { name: e.web_name, pos: POS[e.element_type] || '' }; }); return m;
  });
}
function squadHTML(team, picksResp, live, pl, official) {
  const pts = id => (live.elements[id] && live.elements[id].stats.total_points) || 0;
  const subs = picksResp.subs || [];
  const out = new Set(subs.map(s => s.element_out)), inn = new Set(subs.map(s => s.element_in));
  const all = [...picksResp.picks].sort((x, y) => x.position - y.position);
  const starters = all.filter(p => p.position <= 11 && !out.has(p.element)).concat(all.filter(p => p.position > 11 && inn.has(p.element)));
  const bench = all.filter(p => p.position > 11 && !inn.has(p.element));
  const li = (p, cls) => { const x = pl[p.element] || { name: '#' + p.element, pos: '' };
    return `<li class="${cls}"><span class="p">${x.pos}</span><span class="n">${esc(x.name)}</span><b>${pts(p.element)}</b></li>`; };
  const sum = starters.reduce((s, p) => s + pts(p.element), 0);
  return `<div class="squad"><h3><span>${esc(team.team)}</span><span>${official}</span></h3><ul>` +
    starters.map(p => li(p, inn.has(p.element) ? 'subin' : '')).join('') +
    `</ul><div class="sep">Bench</div><ul>` + bench.map(p => li(p, 'bench')).join('') + `</ul>` +
    (sum !== official ? `<div class="dmsg">Lineup sums to ${sum}</div>` : '') + `</div>`;
}
document.getElementById('gws').addEventListener('click', async e => {
  const row = e.target.closest('tr.gw'); if (!row || !state) return;
  const next = row.nextElementSibling;
  if (next && next.classList.contains('dtl')) { next.remove(); row.classList.remove('open'); return; }
  const ev = Number(row.dataset.ev), g = state.gws.find(x => x.ev === ev);
  const dr = document.createElement('tr'); dr.className = 'dtl';
  dr.innerHTML = '<td class="detail" colspan="5"><span class="dmsg">Loading lineups…</span></td>';
  row.after(dr); row.classList.add('open');
  const cell = dr.firstElementChild;
  if (!WORKER_URL) { cell.innerHTML = '<span class="dmsg">Lineups need the Cloudflare Worker (set WORKER_URL in app.js).</span>'; return; }
  try {
    const [pl, live, ...picks] = await Promise.all([players(), getJSON(`${base()}/live/${ev}`, 20000),
      ...state.teams.map(t => getJSON(`${base()}/picks/${t.entry}/${ev}`, 20000))]);
    cell.innerHTML = '<div class="squads">' + state.teams.map((t, i) => squadHTML(t, picks[i], live, pl, g.scores[i])).join('') + '</div>';
  } catch (err) { cell.innerHTML = '<span class="dmsg">Could not load lineups right now.</span>'; }
});

(async () => {
  const el = document.getElementById('status');
  try {
    const { data, live } = await load();
    state = compute(data);
    render(state);
    const when = new Date(data.fetchedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
    el.innerHTML = live ? `<b>Live</b> · fetched just now` : `Snapshot from ${when} · live fetch unavailable`;
  } catch (e) {
    el.innerHTML = '<span class="err">Could not load scores. Try again shortly.</span>';
  }
})();
