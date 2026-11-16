#!/usr/bin/env node
// Local stdio MCP server for prizepicksapi.com. Zero dependencies: newline-delimited JSON-RPC 2.0 over stdin/stdout.
// Keyless tools always work; data tools appear when PRIZEPICKS_API_KEY is set.
// Independent service operated by Stunning Couches LLC; not affiliated with PrizePicks.

import {createInterface} from 'node:readline';

const VERSION = '0.1.0';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const BASE = (process.env.PRIZEPICKS_API_BASE_URL || 'https://prizepicksapi.com').replace(/\/$/, '');
const KEY = process.env.PRIZEPICKS_API_KEY || '';
const MAX_CHARS = Number(process.env.PRIZEPICKS_MCP_MAX_CHARS || 60000);

const str = (description) => ({type: 'string', description});
const int = (description, max) => ({type: 'integer', minimum: 1, ...(max ? {maximum: max} : {}), description});
const USER_REQUEST = str('Optional, never a filter: one sentence describing what the user asked for, with no personal data. Sent as X-User-Request; never changes the data or the cost.');
const CURSOR = str('meta.next_cursor from the previous page, unchanged. Omit for the first page.');
const LEAGUE = str('League code, for example NBA, NFL, NHL, CFB, SOCCER; comma-separate up to 10. Exact codes only: NBA does not include NBA1Q.');
const STAT = str('Exact PrizePicks stat name, case-insensitive, for example Points, Pass Yards or Pts+Rebs+Asts.');
const TIER = {type: 'string', enum: ['standard', 'goblin', 'demon', 'unknown'], description: 'Only lines with this tier on either selection: standard, goblin (easier line, lower payout), demon (harder line, higher payout).'};
const BOARD_FILTERS = {
  league: LEAGUE,
  stat: STAT,
  tier: TIER,
  search: str('Part of a player name, case-insensitive.'),
  limit: int('Rows per page, 1 to 200 (up to 1000 with view=compact).', 1000),
  cursor: CURSOR,
};
const VIEW = {type: 'string', enum: ['full', 'compact'], description: 'full (default) nests player, market and event objects; compact returns flat rows and allows up to 1000 per page.'};
const KEYED = ' Needs PRIZEPICKS_API_KEY (free key, no card, at https://prizepicksapi.com/sign-up); without one it returns the sign-up link and spends nothing.';
const DEMO = ' No key, no credits. The rows are fictional (is_demo: true): never present them as real lines.';

/** name -> {description, path, params schema, keyless, raw} */
const TOOLS = [
  {name: 'demo_projections', keyless: true, path: '/api/v1/demo/projections', description: 'Fictional PrizePicks board rows in the exact live schema of get_projections, to learn the fields and test filters before the user has a key.' + DEMO, props: {...BOARD_FILTERS}},
  {name: 'demo_line_history', keyless: true, path: '/api/v1/demo/projections/{id}/history', description: 'Fictional line history for one demo projection id (for example demo_nba_001 from demo_projections), in the live schema of get_line_history.' + DEMO, props: {id: str('Demo projection id from demo_projections, for example demo_nba_001.'), limit: int('Rows per page, 1 to 200.', 200), cursor: CURSOR}, required: ['id']},
  {name: 'demo_changes', keyless: true, path: '/api/v1/demo/changes', description: 'Fictional change-feed events (offer.new, offer.changed and so on, each with previous and new line) in the live schema of get_changes, to build a polling loop before the user has a key.' + DEMO, props: {league: LEAGUE, limit: int('Rows per page, 1 to 200.', 200), cursor: CURSOR}},
  {name: 'payout_table', keyless: true, path: '/api/v1/demo/payouts', description: 'Official PrizePicks standard entry payout multipliers for power and flex plays by pick count, with the break-even probability each implies. Real reference data, no key, no credits. Goblin, demon and adjusted-odds lines pay differently and are not estimated.', props: {}},
  {name: 'credit_cost', keyless: true, path: '/api/v1/credit-costs', description: 'Quote how many credits one REST request would cost before running it, plus the plan list. Use it before a large keyed read. No key, no credits.', props: {path: str('Request path with its query string, for example /api/v1/projections?league=NBA&limit=200')}, required: ['path']},

  {name: 'get_projections', path: '/api/v1/projections', description: 'The live PrizePicks board: every current line with player, team, league, stat, line, More/Less tier (standard, goblin, demon), start time, opening line and move count. Use it for "what are the lines now"; get_board_as_of for a past moment, get_changes to poll only what moved. Follow meta.next_cursor for more pages.' + KEYED, props: {...BOARD_FILTERS, view: VIEW, status: {type: 'string', enum: ['active', 'unavailable', 'all'], description: 'active (default) is on the board now; unavailable and all add lines seen in the last 7 days.'}, start_after: str('Only games starting at or after this ISO 8601 time, with a time zone.'), start_before: str('Only games starting before this ISO 8601 time, with a time zone.')}},
  {name: 'get_line_history', path: '/api/v1/projections/{id}/history', description: 'Every recorded change for one projection: opening line, then each move with old and new line and the time it was seen. Use it for "how has this line moved"; take the id from get_projections. Change-only, recorded since the line was first seen.' + KEYED, props: {id: str('Projection id from get_projections.'), limit: int('Rows per page, 1 to 200.', 200), cursor: CURSOR}, required: ['id']},
  {name: 'get_changes', path: '/api/v1/changes', description: 'Ordered feed of board changes across all lines: new, moved, pulled and restored, each with old and new values. Use it to stay current cheaply: store meta.next_cursor and pass it back next time to get only newer changes. For one line use get_line_history.' + KEYED, props: {league: LEAGUE, limit: int('Rows per page, 1 to 200.', 200), cursor: CURSOR}},
  {name: 'get_board_as_of', path: '/api/v1/board', description: 'The PrizePicks board as it stood at a past moment, rebuilt from recorded history (recording began 28 Oct 2026). Use it for backtests and "what was the line at tip-off"; use get_projections for now.' + KEYED, props: {as_of: str('ISO 8601 time with a time zone, for example 2026-11-01T23:00:00Z (required).'), ...BOARD_FILTERS}, required: ['as_of']},
  {name: 'get_results', path: '/api/v1/results', description: 'Recorded lines graded against the final box score: closing line, actual stat, and over, under, push or void with a reason. Use it to check how lines settled; get_hit_rates summarises one player. meta.leagues_graded lists the graded leagues.' + KEYED, props: {league: LEAGUE, date: str('Game date YYYY-MM-DD, US Eastern.'), player: str('Part of the player name, case-insensitive.'), stat: STAT, result: {type: 'string', enum: ['over', 'under', 'push', 'void'], description: 'Only this outcome.'}, limit: int('Rows per page, 1 to 200.', 200), cursor: CURSOR}},
  {name: 'get_hit_rates', path: '/api/v1/hit-rates', description: 'How often one player went over graded PrizePicks lines across their last N games, per stat: over_hit_rate = over / (over + under), pushes and voids excluded. Send player or player_id. For the individual graded rows use get_results.' + KEYED, props: {player: str('Exact player name, case-insensitive. Required unless player_id is sent.'), player_id: str('PrizePicks player id. Required unless player is sent.'), stat: STAT, league: str('League code (default NBA).'), tier: {type: 'string', enum: ['standard', 'goblin', 'demon', 'unknown', 'all'], description: 'Which More-side tier to count: standard (default) or all.'}, last: int('Most recent graded games per stat (default 10).')}},
  {name: 'get_game_logs', path: '/api/v1/game-logs', description: 'Player box-score lines, one row per player per game, newest first, including games with no PrizePicks line. Use it for raw stats and trends; get_hit_rates compares them with lines. Read one player with player_id or player plus league.' + KEYED, props: {player: str('Exact player name; needs league.'), player_id: str('A pl_ id from get_projections or an sp_ id from get_results.'), league: str('League code, for example NBA.'), season: str('Season label, for example 2025-26, or 2026 in single-year leagues.'), last: int('The player\'s most recent N games.'), team: str('Team code (BOS) or team id; needs a season unless player or opponent is sent.'), opponent: str('Only games against this team code or id.')}},
  {name: 'get_coverage', path: '/api/v1/coverage', description: 'Which leagues are on the board now, with markets, live line counts and whether history and graded results exist. Call it first to avoid empty queries.' + KEYED, props: {}},
  {name: 'compare_books', path: '/api/v1/compare', description: 'PrizePicks lines next to FanDuel, DraftKings, BetRivers, Novig, Kalshi and Polymarket prices for the same player, stat and game, with the Novig fair probability and the edge against the PrizePicks break-even. Use it to find PrizePicks lines the market disagrees with; get_projections has the lines alone.' + KEYED, props: {league: LEAGUE, player: str('Part of the player name, case-insensitive.'), stat: STAT, book: str('betrivers, fanduel, draftkings, kalshi, polymarket or novig; comma-separate several. Default all.'), priced_only: {type: 'boolean', description: 'true: only lines with at least one matched book price.'}, view: {type: 'string', enum: ['full', 'compact'], description: 'full (default, up to 100 rows) or compact (flat rows, up to 1000).'}, limit: int('Projections per page, up to 100 (1000 with view=compact).', 1000), cursor: CURSOR}},
  {name: 'export_csv', raw: true, path: '/api/v1/export', description: 'One CSV page (up to 200 rows) of the live board with the same filters as get_projections, for spreadsheets. Continue with the cursor the response gives.' + KEYED, props: {...BOARD_FILTERS}},
];

function visibleTools() {
  // Every tool is listed with or without a key, so clients and registries see the whole surface. Keyed tools called
  // without a key return the sign-up link instead of data.
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {type: 'object', properties: t.keyless ? t.props : {...t.props, user_request: USER_REQUEST}, ...(t.required ? {required: t.required} : {}), additionalProperties: false},
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
  }));
}

async function callTool(name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw rpcError(-32602, `Unknown tool: ${name}`);
  if (!tool.keyless && !KEY) return toolText(`${name} needs an API key. Set PRIZEPICKS_API_KEY (free key, 100 credits a month: https://prizepicksapi.com/sign-up). Keyless tools: demo_projections, demo_line_history, demo_changes, payout_table, credit_cost.`, true);
  const {user_request: userRequest, id, ...rest} = args;
  let path = tool.path;
  if (path.includes('{id}')) {
    if (!id) return toolText('Missing required argument: id', true);
    path = path.replace('{id}', encodeURIComponent(String(id)));
  }
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const url = `${BASE}${path}${q.size ? `?${q}` : ''}`;
  const headers = {Accept: tool.raw ? 'text/csv' : 'application/json', 'User-Agent': `prizepicksapi-mcp/${VERSION}`};
  if (!tool.keyless) {
    headers.Authorization = `Bearer ${KEY}`;
    if (userRequest) headers['X-User-Request'] = encodeURI(String(userRequest));
  }
  let res;
  try {
    res = await fetch(url, {headers, signal: AbortSignal.timeout(30000)});
  } catch (e) {
    return toolText(`Request failed: ${e.message}`, true);
  }
  const body = await res.text();
  if (!res.ok) {
    let msg = body;
    try { const j = JSON.parse(body); msg = `${j.error?.code ?? 'HTTP_ERROR'}: ${j.error?.message ?? ''}`; } catch { /* keep text */ }
    const retry = res.headers.get('retry-after');
    return toolText(`HTTP ${res.status} ${msg}${retry ? ` (Retry-After: ${retry}s)` : ''}`, true);
  }
  const text = body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}\n[truncated at ${MAX_CHARS} characters: request a smaller limit or follow meta.next_cursor]` : body;
  return toolText(text, false);
}

const toolText = (text, isError) => ({content: [{type: 'text', text}], isError});
function rpcError(code, message) { const e = new Error(message); e.code = code; return e; }

async function handle(msg) {
  const {id, method, params} = msg;
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: {tools: {listChanged: false}},
        serverInfo: {name: 'prizepicksapi-mcp', title: 'PrizePicks API (local)', version: VERSION},
        instructions: 'PrizePicks player-prop data from prizepicksapi.com, an independent service not affiliated with PrizePicks. Every tool is read-only. Keyless tools (demo_*, payout_table, credit_cost) return fictional demo rows and the official payout table; the other tools need PRIZEPICKS_API_KEY and return the live board, line history, change feed, the board at a past time, graded results, hit rates, game logs and sportsbook comparison. Start with get_coverage. Pass user_request on data tools.',
      };
    }
    case 'ping': return {};
    case 'tools/list': return {tools: visibleTools()};
    case 'tools/call': return callTool(params?.name, params?.arguments);
    case 'resources/list': return {resources: []};
    case 'prompts/list': return {prompts: []};
    default:
      if (id === undefined) return undefined; // notification
      throw rpcError(-32601, `Method not found: ${method}`);
  }
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const rl = createInterface({input: process.stdin});
const pending = new Set();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { send({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}}); return; }
  const p = handle(msg).then((result) => {
    if (msg.id === undefined || msg.id === null) return;
    send({jsonrpc: '2.0', id: msg.id, result});
  }, (err) => {
    if (msg.id === undefined || msg.id === null) return;
    send({jsonrpc: '2.0', id: msg.id, error: {code: err.code ?? -32603, message: err.message}});
  });
  pending.add(p); p.finally(() => pending.delete(p));
});
rl.on('close', async () => { await Promise.allSettled([...pending]); process.exit(0); });
