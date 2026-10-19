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
    matches: raw.matches.map(m => ({
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
  const all = Object.keys(byGw).map(Number).sort((x, y) => x - y).map(ev => {
    const g = byGw[ev];
    const scores = teams.map(t => g.pts[t.id]);
    const status = !g.started ? 'upcoming' : (g.allFinished && g.n === 2 ? 'final' : 'live');
    return { ev, status, scores, lp: status === 'upcoming' ? null : leaguePoints(scores) };
  });
  const gws = all.filter(g => g.ev >= FIRST_GW);
  const season = teams.map((t, i) => {
    let lp = 0, prov = 0, fpl = 0, n = 0;
    gws.forEach(g => { if (!g.lp) return; lp += g.lp[i]; fpl += g.scores[i]; n++; if (g.status === 'live') prov += g.lp[i]; });
    return { ...t, lp, prov, fpl, n };
  }).sort((a, b) => b.lp - a.lp || b.fpl - a.fpl);
  return { gws, all, season, teams };
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
      return `<tr class="gw ${g.status === 'live' ? 'is-live' : ''}" data-ev="${g.ev}"><td><span class="chev">›</span><b>${g.ev}</b>${g.status === 'live' ? ' <span class="badge live">live</span>' : ''}</td>` +
        g.scores.map((s, i) => `<td><div class="cell ${s === max ? 'top' : ''}"><b>${fmt(g.lp[i])}</b><small>${s} FPL</small></div></td>`).join('') + '</tr>';
    }).join('') || `<tr><td colspan="5">No gameweeks started yet.</td></tr>`);
}

// ---- lineups (click a gameweek row) -------------------------------------
let state = null, bootP = null;
const memo = {};
const cached = (u, ms) => memo[u] ||= getJSON(u, ms).catch(e => { delete memo[u]; throw e; });
const POS = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const base = () => WORKER_URL.replace(/\/$/, '');
function players() {
  return bootP ||= getJSON(base() + '/bootstrap', 20000).then(b => {
    const m = {}; b.elements.forEach(e => { m[e.id] = { name: e.web_name, pos: POS[e.element_type] || '' }; }); return m;
  });
}
function split(picksResp) {               // -> who actually played (after auto-subs) and who sat
  const subs = picksResp.subs || [];
  const out = new Set(subs.map(s => s.element_out)), inn = new Set(subs.map(s => s.element_in));
  const all = [...picksResp.picks].sort((x, y) => x.position - y.position);
  const starters = all.filter(p => p.position <= 11 && !out.has(p.element)).concat(all.filter(p => p.position > 11 && inn.has(p.element)));
  const bench = all.filter(p => p.position > 11 && !inn.has(p.element));
  return { starters, bench, inn };
}
const livePts = live => id => (live.elements[id] && live.elements[id].stats.total_points) || 0;
function squadHTML(team, picksResp, live, pl, official) {
  const pts = livePts(live);
  const { starters, bench, inn } = split(picksResp);
  const li = (p, cls) => { const x = pl[p.element] || { name: '#' + p.element, pos: '' };
    return `<li class="${cls}"><span class="p">${x.pos}</span><span class="n">${esc(x.name)}</span><b>${pts(p.element)}</b></li>`; };
  return `<div class="squad"><h3><span>${esc(team.team)}</span><span>${official}</span></h3><ul>` +
    starters.map(p => li(p, inn.has(p.element) ? 'subin' : '')).join('') +
    `</ul><div class="sep">Bench</div><ul>` + bench.map(p => li(p, 'bench')).join('') + `</ul></div>`;
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
    const [pl, live, ...picks] = await Promise.all([players(), cached(`${base()}/live/${ev}`, 20000),
      ...state.teams.map(t => cached(`${base()}/picks/${t.entry}/${ev}`, 20000))]);
    cell.innerHTML = '<div class="squads">' + state.teams.map((t, i) => squadHTML(t, picks[i], live, pl, g.scores[i])).join('') + '</div>';
  } catch (err) { cell.innerHTML = '<span class="dmsg">Could not load lineups right now.</span>'; }
});

// ---- extra panes ----------------------------------------------------------
const tile = (k, v, who) => `<div class="tile"><span class="k">${k}</span><b>${v}</b><span class="who">${who}</span></div>`;

function renderExtras({ all, season, teams }) {
  const played = all.filter(g => g.status !== 'upcoming'), done = played.filter(g => g.status === 'final');
  if (!played.length) return;
  renderTiles(done.length ? done : played, teams);
  drawChart(played, teams);
  renderH2H(done.length ? done : played, teams);
  renderAlt(played, teams, season);
  weekPicker(played, teams);
}

// gameweek dropdown in the "up close" heading
function weekPicker(gws, teams) {
  const btn = document.getElementById('gwBtn'), list = document.getElementById('gwList'), num = document.getElementById('gwNum');
  const CLOSE_MS = 760;                      // matches the gwrise animation + its longest delay in style.css
  let closeT;
  const fill = g => {
    list.innerHTML = [...gws].reverse().map((x, k) => `<li role="option" style="--i:${Math.min(k, 8)}" aria-selected="${x.ev === g.ev}"><button data-ev="${x.ev}">${x.ev}${x.status === 'live' ? ' <i>live</i>' : ''}</button></li>`).join('');
  };
  const open = () => { clearTimeout(closeT); list.classList.remove('closing'); list.hidden = false; btn.setAttribute('aria-expanded', true); };
  const close = then => {
    btn.setAttribute('aria-expanded', false);
    if (list.hidden) { if (then) then(); return; }
    list.classList.add('closing');
    clearTimeout(closeT);
    closeT = setTimeout(() => { list.hidden = true; list.classList.remove('closing'); if (then) then(); }, CLOSE_MS);
  };
  const pick = g => { num.textContent = g.ev; renderWeek(g, teams); };
  btn.onclick = e => { e.stopPropagation(); btn.getAttribute('aria-expanded') === 'true' ? close() : open(); };
  list.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const g = gws.find(x => x.ev === Number(b.dataset.ev));
    pick(g); close(() => fill(g));
  };
  document.addEventListener('click', e => { if (!e.target.closest('.gwpick') && !list.hidden) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !list.hidden) close(); });
  const last = gws[gws.length - 1];
  fill(last); pick(last);
}

function renderTiles(gws, teams) {
  const name = i => esc(teams[i].team);
  const flat = gws.flatMap(g => g.scores.map((s, i) => ({ s, i, ev: g.ev })));
  const best = flat.reduce((a, b) => (b.s > a.s ? b : a)), worst = flat.reduce((a, b) => (b.s < a.s ? b : a));
  const spread = teams.map((_, i) => {
    const xs = gws.map(g => g.scores[i]), m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return { i, m, sd: Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / xs.length) };
  });
  const steady = spread.reduce((a, b) => (b.sd < a.sd ? b : a)), wild = spread.reduce((a, b) => (b.sd > a.sd ? b : a));
  const order = gws.map(g => ({ ev: g.ev, o: g.scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s) }));
  const gap = (g, k) => g.o[0].s - g.o[k].s;
  const close = order.reduce((a, b) => (gap(b, 1) < gap(a, 1) ? b : a));
  const blow = order.reduce((a, b) => (gap(b, 3) > gap(a, 3) ? b : a));
  const tops = teams.map(() => 0);
  order.forEach(g => g.o.filter(x => x.s === g.o[0].s).forEach(x => tops[x.i]++));
  const topI = tops.indexOf(Math.max(...tops));
  document.getElementById('tiles').innerHTML = [
    tile('best week', best.s, `${name(best.i)} · GW ${best.ev}`),
    tile('worst week', worst.s, `${name(worst.i)} · GW ${worst.ev}`),
    tile('most weeks on top', tops[topI], name(topI)),
    tile('steadiest', '±' + steady.sd.toFixed(1), `${name(steady.i)} · averages ${steady.m.toFixed(1)}`),
    tile('boom or bust', '±' + wild.sd.toFixed(1), `${name(wild.i)} · averages ${wild.m.toFixed(1)}`),
    tile('photo finish', gap(close, 1), `${name(close.o[0].i)} edged ${name(close.o[1].i)} · GW ${close.ev}`),
    tile('biggest gap', gap(blow, 3), `${name(blow.o[0].i)} over ${name(blow.o[3].i)} · GW ${blow.ev}`),
  ].join('');
}

const DASH = ['', '7 4', '2 3', '12 3 2 3'];      // identity by line style, not color
function drawChart(gws, teams) {
  const box = document.getElementById('chart');
  document.getElementById('legend').innerHTML = teams.map((t, i) =>
    `<span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke-dasharray="${DASH[i]}"/></svg>${esc(t.team)}</span>`).join('');
  const draw = () => {
    const W = box.clientWidth, narrow = W < 520, H = narrow ? 230 : 290;
    const m = { l: 30, r: narrow ? 96 : 128, t: 26, b: 26 };
    const evs = gws.map(g => g.ev), vals = gws.flatMap(g => g.scores);
    const lo = Math.floor(Math.min(...vals) / 20) * 20, hi = Math.ceil(Math.max(...vals) / 20) * 20;
    const x = ev => m.l + (evs.length < 2 ? 0.5 : (ev - evs[0]) / (evs[evs.length - 1] - evs[0])) * (W - m.l - m.r);
    const y = v => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);
    let s = '';
    for (let v = lo; v <= hi; v += 20) s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    evs.forEach(ev => { s += `<text x="${x(ev)}" y="${H - 6}" text-anchor="middle">${ev}</text>`; });
    if (evs[0] < FIRST_GW && evs.includes(FIRST_GW))
      s += `<line class="mark" x1="${x(FIRST_GW)}" x2="${x(FIRST_GW)}" y1="${m.t - 8}" y2="${H - m.b}"/><text class="it" x="${x(FIRST_GW) - 6}" y="${m.t - 12}" text-anchor="end">zev scoring starts</text>`;
    teams.forEach((t, i) => {
      s += `<path d="${gws.map((g, k) => `${k ? 'L' : 'M'}${x(g.ev)},${y(g.scores[i])}`).join('')}" stroke-dasharray="${DASH[i]}"/>`;
      gws.forEach(g => { s += `<circle class="${g.status === 'live' ? 'open' : ''}" cx="${x(g.ev)}" cy="${y(g.scores[i])}" r="3"/>`; });
    });
    const last = gws[gws.length - 1];
    const ends = teams.map((t, i) => ({ i, y: y(last.scores[i]) })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 14);
    const max = narrow ? 12 : 16, short = n => (n.length > max ? n.slice(0, max - 1) + '…' : n);
    ends.forEach(e => { s += `<text class="lbl" x="${x(last.ev) + 8}" y="${e.y + 4}">${esc(short(teams[e.i].team))}</text>`; });
    box.innerHTML = `<svg width="${W}" height="${H}">${s}<line class="xh" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/></svg><div class="tip" hidden></div>`;
    const svg = box.firstElementChild, xh = svg.querySelector('.xh'), tip = box.querySelector('.tip');
    svg.onpointermove = e => {
      const px = e.clientX - svg.getBoundingClientRect().left;
      const g = gws.reduce((a, b) => (Math.abs(x(b.ev) - px) < Math.abs(x(a.ev) - px) ? b : a)), gx = x(g.ev);
      xh.setAttribute('x1', gx); xh.setAttribute('x2', gx); xh.setAttribute('visibility', 'visible');
      tip.innerHTML = `<b>GW ${g.ev}${g.status === 'live' ? ' · live' : ''}</b>` + g.scores.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v)
        .map(r => `<div><span>${esc(teams[r.i].team)}</span><span>${r.v}</span></div>`).join('');
      tip.hidden = false;
      tip.style.left = (gx > W / 2 ? gx - tip.offsetWidth - 12 : gx + 12) + 'px';
      tip.style.top = m.t + 'px';
    };
    svg.onpointerleave = () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); };
  };
  draw();
  let lastW = box.clientWidth;
  new ResizeObserver(() => { if (box.clientWidth !== lastW) { lastW = box.clientWidth; draw(); } }).observe(box);
}

function renderH2H(gws, teams) {
  const n = gws.length;
  document.getElementById('h2h').innerHTML = '<tr><th></th>' + teams.map(t => `<th>${esc(t.team)}</th>`).join('') + '</tr>' +
    teams.map((t, i) => `<tr><th>${esc(t.team)}</th>` + teams.map((u, j) => {
      if (i === j) return '<td class="self">—</td>';
      const w = gws.filter(g => g.scores[i] > g.scores[j]).length, l = gws.filter(g => g.scores[i] < g.scores[j]).length;
      return `<td style="--f:${(w / n).toFixed(2)}" class="${w / n > 0.55 ? 'dark' : ''}" title="${esc(t.team)} outscored ${esc(u.team)} in ${w} of ${n} weeks">${w}–${l}</td>`;
    }).join('') + '</tr>').join('');
}

function renderAlt(gws, teams, season) {
  const real = season.map(s => s.id);
  const rows = teams.map((t, i) => ({ t, lp: gws.reduce((a, g) => a + g.lp[i], 0),
    tops: gws.filter(g => g.scores[i] === Math.max(...g.scores)).length })).sort((a, b) => b.lp - a.lp);
  document.getElementById('alt').innerHTML = '<tr><th>#</th><th>Team</th><th>League pts</th><th>Weeks on top</th><th>Actual place</th></tr>' +
    rows.map((r, k) => `<tr><td>${k + 1}</td><td class="team">${esc(r.t.team)}</td><td class="pts">${fmt(r.lp)}</td><td>${r.tops}</td><td>${real.indexOf(r.t.id) + 1}</td></tr>`).join('');
}

// split-flap board: every letter/digit in the data cells flips through random glyphs on its own clock.
// settleMs null = flip until stopped; otherwise each glyph lands on its real value somewhere in that window.
const GLYPHS = { d: '0123456789', u: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', l: 'abcdefghijklmnopqrstuvwxyz' };
const FLAP_CELLS = '.tile b, .tile .who, #weekt td';
const glyphKind = c => (/\d/.test(c) ? 'd' : /[A-Z]/.test(c) ? 'u' : /[a-z]/.test(c) ? 'l' : null);
function flap(root, settleMs = null) {
  const items = [], cells = [...root.querySelectorAll(FLAP_CELLS)];
  // pin each cell's height so scrambled text re-wrapping can't make the layout jump
  cells.forEach(c => { c.style.height = c.getBoundingClientRect().height + 'px'; });
  const release = () => cells.forEach(c => { c.style.height = ''; });
  cells.forEach(cell => {
    const w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const n = w.currentNode, chars = [...n.nodeValue];
      items.push({ n, chars: chars.map((c, i) => ({ c, cur: c, k: glyphKind(c), next: 0, period: 55 + Math.random() * 75,
        done: settleMs == null ? Infinity : settleMs * (0.35 * i / chars.length + 0.65 * Math.random()) })) });
    }
  });
  const t0 = performance.now();
  let raf;
  const tick = now => {
    const t = now - t0;
    let busy = false;
    items.forEach(it => {
      let changed = false;
      it.chars.forEach(ch => {
        if (!ch.k) return;
        if (t >= ch.done) { if (ch.cur !== ch.c) { ch.cur = ch.c; changed = true; } return; }
        busy = true;
        if (t >= ch.next) { const g = GLYPHS[ch.k]; ch.cur = g[(Math.random() * g.length) | 0]; ch.next = t + ch.period; changed = true; }
      });
      if (changed) it.n.nodeValue = it.chars.map(ch => ch.cur).join('');
    });
    if (busy) raf = requestAnimationFrame(tick); else release();
  };
  raf = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(raf); release(); };
}

let weekReq = 0, stopFlap = null;
async function renderWeek(g, teams) {
  const el = document.getElementById('week'), req = ++weekReq;
  if (!WORKER_URL) { el.closest('section').hidden = true; return; }
  if (stopFlap) stopFlap();
  const board = !!el.querySelector('.tiles');  // a previous week is on screen: flip it instead of a loading line
  const minWait = board && new Promise(r => setTimeout(r, 1000));
  if (board) stopFlap = flap(el); else el.innerHTML = '<p class="dmsg">Loading players…</p>';
  try {
    const [pl, live, ...picks] = await Promise.all([players(), cached(`${base()}/live/${g.ev}`, 20000),
      ...teams.map(t => cached(`${base()}/picks/${t.entry}/${g.ev}`, 20000))]);
    await minWait;
    if (req !== weekReq) return;              // a newer gameweek was picked meanwhile
    if (stopFlap) stopFlap();
    const pts = livePts(live), nm = id => esc((pl[id] || { name: '#' + id }).name);
    const per = teams.map((t, i) => {
      const { starters, bench } = split(picks[i]);
      return { t, st: starters.map(p => ({ id: p.element, v: pts(p.element), t })).sort((a, b) => b.v - a.v),
        benchPts: bench.reduce((a, p) => a + pts(p.element), 0) };
    });
    const allSt = per.flatMap(r => r.st);
    const mvp = allSt[0] && allSt.reduce((a, b) => (b.v > a.v ? b : a)), anchor = allSt.reduce((a, b) => (b.v < a.v ? b : a));
    const regret = per.reduce((a, b) => (b.benchPts > a.benchPts ? b : a));
    const owned = new Set(picks.flatMap(p => p.picks.map(x => x.element)));
    const free = Object.keys(live.elements).map(Number).filter(id => !owned.has(id) && pl[id])
      .reduce((a, id) => (!a || pts(id) > pts(a) ? id : a), null);
    el.innerHTML = '<div class="tiles">' + [
      tile('player of the week', mvp.v, `${nm(mvp.id)} · ${esc(mvp.t.team)}`),
      tile('dead weight', anchor.v, `${nm(anchor.id)} · ${esc(anchor.t.team)}`),
      tile('bench regret', regret.benchPts, `points left on ${esc(regret.t.team)}’s bench`),
      free ? tile('the one that got away', pts(free), `${nm(free)} · on nobody’s team`) : '',
    ].join('') + '</div>' +
      '<div class="scroll"><table id="weekt"><tr><th>Team</th><th>Best</th><th>Worst</th><th>Bench pts</th></tr>' +
      per.map(r => `<tr><td class="team">${esc(r.t.team)}</td><td>${nm(r.st[0].id)} <small>${r.st[0].v}</small></td>` +
        `<td>${nm(r.st[r.st.length - 1].id)} <small>${r.st[r.st.length - 1].v}</small></td><td>${r.benchPts}</td></tr>`).join('') + '</table></div>';
    if (board) stopFlap = flap(el, 700);
  } catch (err) {
    if (req !== weekReq) return;
    if (stopFlap) stopFlap();
    el.innerHTML = '<p class="dmsg">Could not load players right now.</p>';
  }
}

// "Fun Stuff" toggle: panes render on first open, so the chart can measure its width
let extrasDone = false;
const funBtn = document.getElementById('funBtn'), fun = document.getElementById('fun');
funBtn.addEventListener('click', () => {
  const open = funBtn.getAttribute('aria-expanded') !== 'true';
  funBtn.setAttribute('aria-expanded', open);
  if (!open) { fun.classList.remove('shown'); fun.hidden = true; return; }
  fun.hidden = false;
  if (!extrasDone && state) { renderExtras(state); extrasDone = true; }
  requestAnimationFrame(() => requestAnimationFrame(() => fun.classList.add('shown')));
});

(async () => {
  const el = document.getElementById('status');
  try {
    const { data, live } = await load();
    state = compute(data);
    render(state);
    if (!fun.hidden && !extrasDone) { renderExtras(state); extrasDone = true; }
    const when = new Date(data.fetchedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
    el.innerHTML = live ? `<b>Live</b> · fetched just now` : `Snapshot from ${when} · live fetch unavailable`;
  } catch (e) {
    el.innerHTML = '<span class="err">Could not load scores. Try again shortly.</span>';
  }
})();
