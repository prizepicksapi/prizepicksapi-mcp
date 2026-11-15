import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';

const BIN = fileURLToPath(new URL('../bin/prizepicksapi-mcp.js', import.meta.url));

/** Mock prizepicksapi.com: records requests, answers demo and keyed routes. */
async function mockApi() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({url: req.url, auth: req.headers.authorization, userRequest: req.headers['x-user-request']});
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/api/v1/demo/projections') return res.end(JSON.stringify({data: [{id: 'demo_nba_001', line: 27.5}], meta: {is_demo: true}}));
    if (u.pathname === '/api/v1/projections') {
      if (req.headers.authorization !== 'Bearer test_key') { res.statusCode = 401; return res.end(JSON.stringify({error: {code: 'INVALID_API_KEY', message: 'bad'}})); }
      return res.end(JSON.stringify({data: [{id: 'p1', line: 24.5}], meta: {next_cursor: null}}));
    }
    res.statusCode = 404; res.end(JSON.stringify({error: {code: 'NOT_FOUND', message: 'no'}}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {seen, server, base: `http://127.0.0.1:${server.address().port}`};
}

function startMcp(env) {
  const child = spawn(process.execPath, [BIN], {env: {...process.env, PRIZEPICKS_API_KEY: '', ...env}, stdio: ['pipe', 'pipe', 'inherit']});
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      waiters.get(msg.id)?.(msg); waiters.delete(msg.id);
    }
  });
  let next = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = next++; waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
  });
  const notify = (method) => child.stdin.write(JSON.stringify({jsonrpc: '2.0', method}) + '\n');
  return {child, rpc, notify, stop: () => child.stdin.end()};
}

test('keyless: initialize, tools/list shows only keyless tools, demo call works', async () => {
  const api = await mockApi();
  const mcp = startMcp({PRIZEPICKS_API_BASE_URL: api.base});
  try {
    const init = await mcp.rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '1'}});
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'prizepicksapi-mcp');
    mcp.notify('notifications/initialized');
    const list = await mcp.rpc('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('demo_projections') && names.includes('payout_table'));
    assert.ok(!names.includes('get_projections'));
    const call = await mcp.rpc('tools/call', {name: 'demo_projections', arguments: {league: 'NBA', limit: 1}});
    assert.equal(call.result.isError, false);
    assert.equal(JSON.parse(call.result.content[0].text).data[0].id, 'demo_nba_001');
    assert.equal(api.seen[0].url, '/api/v1/demo/projections?league=NBA&limit=1');
    assert.equal(api.seen[0].auth, undefined);
    const keyed = await mcp.rpc('tools/call', {name: 'get_projections', arguments: {}});
    assert.equal(keyed.result.isError, true);
    assert.match(keyed.result.content[0].text, /PRIZEPICKS_API_KEY/);
    const bad = await mcp.rpc('nope/method', {});
    assert.equal(bad.error.code, -32601);
  } finally { mcp.stop(); api.server.close(); }
});

test('keyed: data tools appear and send bearer plus X-User-Request', async () => {
  const api = await mockApi();
  const mcp = startMcp({PRIZEPICKS_API_BASE_URL: api.base, PRIZEPICKS_API_KEY: 'test_key'});
  try {
    await mcp.rpc('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 't', version: '1'}});
    const list = await mcp.rpc('tools/list', {});
    const tool = list.result.tools.find((t) => t.name === 'get_projections');
    assert.ok(tool && tool.inputSchema.properties.user_request);
    const call = await mcp.rpc('tools/call', {name: 'get_projections', arguments: {league: 'NBA', tier: 'goblin', user_request: 'NBA goblins today'}});
    assert.equal(call.result.isError, false);
    assert.equal(JSON.parse(call.result.content[0].text).data[0].line, 24.5);
    const hit = api.seen.at(-1);
    assert.equal(hit.url, '/api/v1/projections?league=NBA&tier=goblin');
    assert.equal(hit.auth, 'Bearer test_key');
    assert.equal(hit.userRequest, 'NBA%20goblins%20today');
  } finally { mcp.stop(); api.server.close(); }
});
