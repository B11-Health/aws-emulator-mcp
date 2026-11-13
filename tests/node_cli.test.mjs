import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'codegym-aws.mjs');
function cli(...args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 12000 });
}
test('help states a limited tool surface, not full AWS parity', () => {
  const result = cli('help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /27 curated \+ 2 modeled-SDK tools/);
  assert.match(result.stdout, /No AWS account/);
  assert.doesNotMatch(result.stdout, /1000|full AWS API parity/i);
});
test('Copilot config is valid stdio for installed package', () => {
  const result = cli('config');
  assert.equal(result.status, 0);
  const cfg = JSON.parse(result.stdout).mcpServers['aws-emulator-local'];
  assert.equal(cfg.command, process.execPath);
  assert.deepEqual(cfg.args, [BIN, 'mcp']);
  assert.equal(cfg.type, 'stdio');
});
test('VS Code config is valid stdio', () => {
  const result = cli('config', 'vscode');
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).servers['aws-emulator-local'].type, 'stdio');
});
test('invalid commands/format fail before calling Docker', () => {
  assert.equal(cli('config', 'remote').status, 2);
  assert.equal(cli('execute', 'aws').status, 2);
});
test('errors do not corrupt MCP stdout', () => {
  const result = cli('invalid-command');
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown command/);
});
