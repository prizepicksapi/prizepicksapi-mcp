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
const USER_REQUEST = str('One sentence describing what the user asked for, with no personal data. Sent as X-User-Request; never changes the data or the cost.');
const BOARD_FILTERS = {
  league: str('League code, for example NBA, NFL, NHL, CFB, SOCCER. Comma-separate several.'),
  stat: str('Exact market name, for example Points or Pass Yards.'),
  tier: {type: 'string', enum: ['standard', 'goblin', 'demon'], description: 'Only lines with this tier on a selection.'},
  search: str('Player name search.'),
  limit: int('Rows per page (1-200, or up to 1000 with view=compact).', 1000),
  cursor: str('meta.next_cursor from the previous page.'),
};

/** name -> {description, path, params schema, keyless, raw} */
const TOOLS = [
  {name: 'demo_projections', keyless: true, path: '/api/v1/demo/projections', description: 'Fictional sample PrizePicks projections with the exact live schema (is_demo: true). Use to learn the fields before calling live data. No key.', props: {...BOARD_FILTERS}},
  {name: 'demo_line_history', keyless: true, path: '/api/v1/demo/projections/{id}/history', description: 'Fictional line history for a demo projection id such as demo_nba_001. No key.', props: {id: str('Demo projection id.'), limit: int('Rows per page.', 200), cursor: str('Cursor.')}, required: ['id']},
  {name: 'demo_changes', keyless: true, path: '/api/v1/demo/changes', description: 'Fictional change-feed events (offer.changed etc.) in the live schema. No key.', props: {league: BOARD_FILTERS.league, limit: int('Rows per page.', 200), cursor: str('Cursor.')}},
  {name: 'payout_table', keyless: true, path: '/api/v1/demo/payouts', description: 'Official PrizePicks standard entry payout multipliers (power and flex) with derived break-even probabilities. Real reference data, no key. Goblin, demon and adjusted-odds lines pay differently and are not estimated.', props: {}},
  {name: 'credit_cost', keyless: true, path: '/api/v1/credit-costs', description: 'Quote how many credits a REST request path costs before running it, plus the plan list. No key.', props: {path: str('Request path with query, for example /api/v1/projections?league=NBA&limit=200')}, required: ['path']},

  {name: 'get_projections', path: '/api/v1/projections', description: 'Current PrizePicks board: every live line with player, market, line, tier per selection (standard, goblin, demon), opening line and move count. Follow meta.next_cursor for more.', props: {...BOARD_FILTERS, view: {type: 'string', enum: ['full', 'compact'], description: 'compact allows 1,000 rows per page.'}, status: str('Line status filter.'), start_after: str('ISO time.'), start_before: str('ISO time.')}},
  {name: 'get_line_history', path: '/api/v1/projections/{id}/history', description: 'Every recorded change for one projection id: opening line, each move with old and new line and time.', props: {id: str('Projection id from get_projections.'), limit: int('Rows per page.', 200), cursor: str('Cursor.')}, required: ['id']},
  {name: 'get_changes', path: '/api/v1/changes', description: 'Change feed of new, moved, pulled and restored lines. Store meta.next_cursor and pass it back to resume.', props: {league: BOARD_FILTERS.league, limit: int('Rows per page.', 200), cursor: str('Cursor.')}},
  {name: 'get_board_as_of', path: '/api/v1/board', description: 'The PrizePicks board as it stood at a past moment (recording began 28 Oct 2026).', props: {as_of: str('ISO 8601 time.'), ...BOARD_FILTERS}, required: ['as_of']},
  {name: 'get_results', path: '/api/v1/results', description: 'Graded lines: line at game time, actual stat from the box score, and over, under, push or void with a reason. Check meta for graded leagues.', props: {league: BOARD_FILTERS.league, date: str('YYYY-MM-DD.'), player: str('Player name.'), stat: BOARD_FILTERS.stat, result: str('over, under, push or void.'), limit: int('Rows per page.', 200), cursor: str('Cursor.')}},
  {name: 'get_hit_rates', path: '/api/v1/hit-rates', description: 'How often a player went over or under graded lines, optionally by stat and tier.', props: {player: str('Player name.'), player_id: str('Player id.'), stat: BOARD_FILTERS.stat, league: BOARD_FILTERS.league, tier: BOARD_FILTERS.tier, last: int('Last N graded lines.')}},
  {name: 'get_game_logs', path: '/api/v1/game-logs', description: 'Player game logs (box-score stats per game) for loaded seasons.', props: {player: str('Player name.'), player_id: str('Player id.'), league: BOARD_FILTERS.league, season: str('Season.'), last: int('Last N games.'), team: str('Team.'), opponent: str('Opponent.')}},
  {name: 'get_coverage', path: '/api/v1/coverage', description: 'Leagues currently on the board with markets, live line counts and whether history and results exist.', props: {}},
  {name: 'compare_books', path: '/api/v1/compare', description: 'PrizePicks lines next to matched sportsbook and exchange quotes for the same player, stat and period (NBA, NFL, NHL where matched).', props: {league: BOARD_FILTERS.league, player: str('Player name.'), stat: BOARD_FILTERS.stat, book: str('Book filter.'), priced_only: {type: 'boolean', description: 'Only rows with a matched price.'}, view: {type: 'string', enum: ['full', 'compact']}, limit: int('Rows per page.', 1000), cursor: str('Cursor.')}},
  {name: 'export_csv', raw: true, path: '/api/v1/export', description: 'One CSV page (up to 200 rows) of current projections, same filters as get_projections. For spreadsheets.', props: {...BOARD_FILTERS}},
];

function visibleTools() {
  return TOOLS.filter((t) => t.keyless || KEY).map((t) => ({
    name: t.name,
    description: t.description + (t.keyless ? '' : ' Needs PRIZEPICKS_API_KEY.'),
    inputSchema: {type: 'object', properties: t.keyless ? t.props : {...t.props, user_request: USER_REQUEST}, ...(t.required ? {required: t.required} : {}), additionalProperties: false},
    annotations: {readOnlyHint: true, openWorldHint: true},
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
        instructions: 'PrizePicks player-prop data from prizepicksapi.com, an independent service not affiliated with PrizePicks. Keyless tools return demo rows and the official payout table; set PRIZEPICKS_API_KEY for the live board, line history, change feed, graded results and sportsbook comparison. Pass user_request on data tools.',
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
