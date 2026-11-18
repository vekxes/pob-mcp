import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const tempRoot = resolve(tmpdir());
const home = await mkdtemp(join(tempRoot, 'pob-integration-settings-'));
const portCheck = createServer().listen(0, '127.0.0.1');
await once(portCheck, 'listening');
process.env.POE_TRADE_PORT = String(portCheck.address().port);
await new Promise(resolve => portCheck.close(resolve));
const originalBuilds = join(home, 'original builds');
const selectedBuilds = join(home, 'selected builds');
const pobRoot = join(home, 'PoB');
const source = join(pobRoot, 'src');
const config = join(home, 'config.toml');
await Promise.all([mkdir(originalBuilds), mkdir(selectedBuilds), mkdir(source, { recursive: true })]);
await writeFile(join(selectedBuilds, 'Selected.xml'), '<PathOfBuilding/>');
await writeFile(join(source, 'HeadlessWrapper.lua'), '');
const originalConfig = '# Keep this comment\nmodel = "test-model"\n\n[mcp_servers.keep]\ncommand = "keep-me"\n';
await writeFile(config, originalConfig);
process.env.POE_TRADE_HOME = home;
process.env.POB_DIRECTORY = originalBuilds;
const { startTradeDaemon } = await import('../../build/trade/daemon.js');
const daemon = await startTradeDaemon();
const address = new URL(daemon.url);
const headers = { Authorization: `Bearer ${address.hash.slice(1)}`, Origin: address.origin };
const stream = await fetch(`${address.origin}/events`, { headers });
const owner = stream.headers.get('X-PoE-Trade-Window');
assert.ok(owner);

async function request(path, body, expected = 200, includeWindow = true) {
  const response = await fetch(address.origin + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...headers, ...(includeWindow && { 'X-PoE-Trade-Window': owner }),
      ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  assert.equal(response.status, expected, `${path}: ${value.error ?? 'unexpected status'}`);
  return value.data;
}

try {
  assert.equal((await request('/settings/pob')).buildsDirectory, originalBuilds);
  const save = { action: 'save', buildsDirectory: selectedBuilds, sourceDirectory: pobRoot };
  await request('/settings/pob', save, 409, false);
  const saved = await request('/settings/pob', save);
  assert.equal(saved.buildsDirectory, selectedBuilds);
  assert.equal(saved.sourceDirectory, source);
  assert.deepEqual(await request('/pob-build-files'), ['Selected.xml']);
  await request('/settings/pob', { ...save, sourceDirectory: selectedBuilds }, 400);
  assert.equal((await request('/settings/pob')).sourceDirectory, source);
  const { IntegrationSettings } = await import('../../build/trade/integrationSettings.js');
  assert.deepEqual(new IntegrationSettings(join(home, 'integration-settings.json')).pob, {
    buildsDirectory: selectedBuilds, sourceDirectory: source,
  });

  const selection = { path: config, servers: ['pob', 'poe-trade'] };
  const preview = await request('/settings/mcp', { action: 'preview', ...selection });
  assert.match(preview.snippet, /\[mcp_servers\.pob\]/);
  assert.match(preview.snippet, /\[mcp_servers\.poe-trade\]/);
  assert.match(preview.snippet, /POB_DIRECTORY/);
  assert.match(preview.snippet, /POE_TRADE_PORT/);
  assert.doesNotMatch(preview.snippet, /keep-me|test-model/);
  assert.equal(await readFile(config, 'utf8'), originalConfig);
  const externalEdit = originalConfig + '# External edit\n';
  await writeFile(config, externalEdit);
  await request('/settings/mcp', { action: 'apply', ...selection, version: preview.version }, 409);
  assert.equal(await readFile(config, 'utf8'), externalEdit);

  if (process.argv.includes('--apply')) {
    const current = await request('/settings/mcp', { action: 'preview', ...selection });
    const applied = await request('/settings/mcp', { action: 'apply', ...selection, version: current.version });
    assert.equal(await readFile(applied.backup, 'utf8'), externalEdit);
    const written = await readFile(config, 'utf8');
    assert.match(written, /# Keep this comment/);
    assert.match(written, /model = "test-model"/);
    assert.match(written, /\[mcp_servers\.keep\][\s\S]*command = "keep-me"/);
    assert.match(written, /\[mcp_servers\.pob\]/);
    assert.match(written, /\[mcp_servers\.poe-trade\]/);
    assert.equal((await request('/settings/mcp')).path, config);
    const newDirectory = join(home, 'New config');
    await mkdir(newDirectory);
    const newSelection = { path: join(newDirectory, 'Config.TOML'), servers: ['poe-trade'] };
    const newPreview = await request('/settings/mcp', { action: 'preview', ...newSelection });
    await request('/settings/mcp', { action: 'apply', ...newSelection, version: newPreview.version });
    const created = await readFile(newSelection.path, 'utf8');
    assert.match(created, /\[mcp_servers\.poe-trade\]/);
    assert.doesNotMatch(created, /\[mcp_servers\.pob\]/);
  }
  console.log('PoB folder settings and Codex MCP config checks passed.');
} finally {
  await stream.body?.cancel();
  await daemon.close();
  assert.equal(dirname(home), tempRoot);
  assert.ok(basename(home).startsWith('pob-integration-settings-'));
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
}
