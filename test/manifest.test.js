import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url)));

test('server.json matches package.json for registry verification', () => {
  assert.equal(pkg.mcpName, server.name);
  const npm = server.packages.find((p) => p.registryType === 'npm');
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.equal(npm.transport.type, 'stdio');
  assert.ok(server.description.length <= 100);
});
