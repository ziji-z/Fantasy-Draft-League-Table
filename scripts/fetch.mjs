// Pulls league data from the public FPL Draft API and writes data.json.
// Fails loudly (non-zero exit) on anything unexpected so a bad pull never replaces good data.
import { writeFileSync, mkdirSync } from 'node:fs';

const LEAGUE = 64420;
const FIRST_GW = 7;
const out = process.argv[2] || 'data.json';

async function get(path) {
  const r = await fetch('https://draft.premierleague.com' + path, { headers: { 'User-Agent': 'zev-fpl-tracker' } });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

const [league, game] = await Promise.all([get(`/api/league/${LEAGUE}/details`), get('/api/game')]);
if (!Array.isArray(league.league_entries) || league.league_entries.length !== 4) throw new Error('Expected 4 league entries');
if (!Array.isArray(league.matches) || !league.matches.length) throw new Error('No matches in response');

const data = {
  fetchedAt: new Date().toISOString(),
  currentEvent: game.current_event,
  currentEventFinished: game.current_event_finished,
  teams: league.league_entries.map(e => ({
    id: e.id, entry: e.entry_id, team: e.entry_name, manager: `${e.player_first_name} ${e.player_last_name}`.trim(),
  })),
  matches: league.matches
    .filter(m => m.event >= FIRST_GW)
    .map(m => ({
      event: m.event, finished: m.finished, started: m.started,
      a: m.league_entry_1, ap: m.league_entry_1_points,
      b: m.league_entry_2, bp: m.league_entry_2_points,
    })),
};
const ids = new Set(data.teams.map(t => t.id));
for (const m of data.matches) if (!ids.has(m.a) || !ids.has(m.b)) throw new Error(`GW${m.event}: unknown team id`);

mkdirSync(out.includes('/') ? out.replace(/\/[^/]+$/, '') : '.', { recursive: true });
writeFileSync(out, JSON.stringify(data));
console.log(`wrote ${out}: ${data.matches.length} matches, current GW ${data.currentEvent}`);
