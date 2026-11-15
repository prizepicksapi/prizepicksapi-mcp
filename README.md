# prizepicksapi-mcp

A local stdio MCP server for [prizepicksapi.com](https://prizepicksapi.com): PrizePicks player-prop lines, goblin and demon tiers, recorded line history, the change feed, graded results and sportsbook comparison, inside Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI or any MCP client. Zero dependencies, Node 18+.

A hosted remote MCP server already exists at `https://prizepicksapi.com/api/mcp` (Streamable HTTP, listed in the official MCP registry as `com.prizepicksapi/server`). Use the remote one when your client supports remote servers; use this package when you want a local stdio process.

prizepicksapi.com is an independent service operated by Stunning Couches LLC. It is not affiliated with or endorsed by PrizePicks.

## Run

```bash
npx -y prizepicksapi-mcp
```

With no key it lists five keyless tools. Set `PRIZEPICKS_API_KEY` (free key, 100 credits a month, no card: https://prizepicksapi.com/sign-up) to add the live data tools.

### Claude Desktop / Cursor (`mcpServers` JSON)

```json
{
  "mcpServers": {
    "prizepicksapi": {
      "command": "npx",
      "args": ["-y", "prizepicksapi-mcp"],
      "env": { "PRIZEPICKS_API_KEY": "YOUR_KEY" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add prizepicksapi --env PRIZEPICKS_API_KEY=YOUR_KEY -- npx -y prizepicksapi-mcp
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.prizepicksapi]
command = "npx"
args = ["-y", "prizepicksapi-mcp"]
env = { PRIZEPICKS_API_KEY = "YOUR_KEY" }
```

## Tools

| Tool | Key | What it returns |
|---|---|---|
| `demo_projections` | no | Fictional rows in the live schema (`is_demo: true`) |
| `demo_line_history` | no | Fictional history for a demo id such as `demo_nba_001` |
| `demo_changes` | no | Fictional change-feed events |
| `payout_table` | no | Official PrizePicks standard power and flex multipliers with derived break-even probabilities (real data) |
| `credit_cost` | no | Credits a REST path would cost |
| `get_projections` | yes | Current board: line, tier per side, opening line, moves |
| `get_line_history` | yes | Every recorded change for one projection |
| `get_changes` | yes | New, moved, pulled and restored lines, resumable with a cursor |
| `get_board_as_of` | yes | The board at a past moment |
| `get_results` | yes | Graded lines: line at game time, actual stat, over/under/push/void |
| `get_hit_rates` | yes | Over and under rates for a player and stat |
| `get_game_logs` | yes | Player game logs for loaded seasons |
| `get_coverage` | yes | Leagues on the board, markets and line counts |
| `compare_books` | yes | PrizePicks lines next to matched sportsbook and exchange quotes |
| `export_csv` | yes | One CSV page of the board |

Keyed tools take an optional `user_request`: one sentence about what the user asked for, no personal data. It is sent as the `X-User-Request` header, stored for 35 days, and never changes the data or the cost.

Example result of `payout_table` (15 Nov 2026, first rows): power 2-pick pays 3x, break-even 0.57735; power 3-pick pays 6x, break-even 0.55032.

## Environment

| Variable | Default | |
|---|---|---|
| `PRIZEPICKS_API_KEY` | none | Enables the keyed tools |
| `PRIZEPICKS_API_BASE_URL` | `https://prizepicksapi.com` | Override for testing |
| `PRIZEPICKS_MCP_MAX_CHARS` | `60000` | Truncates very large tool results |

## Tests

```bash
npm test   # spawns the server against a local mock API: initialize, tools/list, tools/call
```

## License

MIT.
