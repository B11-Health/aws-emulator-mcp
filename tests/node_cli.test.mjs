import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const requirePackage = () => readFileSync(new URL('../package.json', import.meta.url), 'utf8');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'aws-emulator-mcp.mjs');
function cli(...args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 12000 });
}
test('help states a limited tool surface, not full AWS parity', () => {
  const result = cli('help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /29 curated \+ 3 SDK bridge tools/);
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

test('npm package and CLI identify AWS Emulator MCP, not an unrelated organization', () => {
  const pkg = JSON.parse(requirePackage());
  assert.equal(pkg.name, 'aws-emulator-mcp');
  assert.equal(pkg.bin['aws-emulator-mcp'], './bin/aws-emulator-mcp.mjs');
  assert.equal(pkg.version, '0.4.0-beta.6');
  assert.equal(pkg.bin['codegym-aws'], undefined);
  const result = cli('help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: aws-emulator-mcp/);
  assert.doesNotMatch(result.stdout + result.stderr, /Code Gym|CodeGym|codegym-aws/);
});

test('experiment list works without Docker and includes clear coverage caveats', () => {
  const result = cli('experiments', '--json');
  assert.equal(result.status, 0, result.stderr);
  const registry = JSON.parse(result.stdout);
  assert.equal(registry.schemaVersion, 1);
  assert.deepEqual(registry.experiments.map(x => x.id),
    ['order-recovery', 's3-recovery', 'dynamodb-overwrite',
     'sns-sqs-delivery', 'ec2-vpc-lifecycle', 'eventbridge-bus',
     'ssm-parameter', 'secretsmanager-secret']);
  for (const experiment of registry.experiments) {
    assert.ok(experiment.services.length);
    assert.ok(experiment.caveat);
  }
});

test('experiment argument validation rejects arbitrary scripts and unknown ids before Docker', () => {
  assert.equal(cli('experiment', 'exec').status, 2);
  assert.equal(cli('experiment', '../../etc/passwd').status, 2);
  assert.equal(cli('experiment').status, 2);
  assert.equal(cli('experiment', 's3-recovery', '--shell').status, 2);
});

test('DOCKER_HOST cannot redirect a local experiment to a remote Docker daemon', () => {
  const result = spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
    encoding: 'utf8', timeout: 12000,
    env: { ...process.env, DOCKER_HOST: 'tcp://198.51.100.7:2375' }
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Refusing nonlocal DOCKER_HOST/);
});


test('coverage command validates arguments before invoking Docker', () => {
  assert.equal(cli('coverage','--json','--json').status,2);
  assert.equal(cli('coverage','../../etc/passwd').status,2);
  assert.equal(cli('coverage','--unsafe-remote').status,2);
  assert.equal(cli('coverage','ec2','lambda').status,2);
});

test('coverage-diff validates a matching baseline without Docker', () => {
  const baseline = path.join(ROOT, 'docs', 'evidence', 'coverage-aws-emulator-1.0.343.json');
  const result = cli('coverage-diff', baseline, baseline, '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.equal(report.comparable, true);
  assert.equal(report.baseline.probed, 20);
  assert.equal(report.regressions.length, 0);
});

test('coverage-diff refuses API response regressions and reports the exact operation', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'aws-mcp-regression-'));
  try {
    const baseline = path.join(ROOT, 'docs', 'evidence', 'coverage-aws-emulator-1.0.343.json');
    const changed = JSON.parse(readFileSync(baseline, 'utf8'));
    const failingKey = changed.results[0].service + '.' + changed.results[0].operation;
    changed.emulatorVersion = 'synthetic-regression-version';
    changed.results[0].status = 'not_implemented';
    changed.successfulProbes = 19;
    const after = path.join(directory, 'after.json');
    writeFileSync(after, JSON.stringify(changed));
    const result = cli('coverage-diff', baseline, after, '--json');
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, false);
    assert.equal(report.comparable, true);
    assert.deepEqual(report.regressions.map(x => x.operation), [failingKey]);
    assert.equal(report.regressions[0].after, 'not_implemented');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('coverage-diff rejects mismatched probe sets and corrupted evidence', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'aws-mcp-coverage-input-'));
  try {
    const baseline = path.join(ROOT, 'docs', 'evidence', 'coverage-aws-emulator-1.0.343.json');
    const reduced = JSON.parse(readFileSync(baseline, 'utf8'));
    reduced.results.pop();
    reduced.successfulProbes--;
    reduced.totalProbes--;
    const partial = path.join(directory, 'partial.json');
    writeFileSync(partial, JSON.stringify(reduced));
    const mismatch = cli('coverage-diff', baseline, partial, '--json');
    assert.equal(mismatch.status, 2);
    const detail = JSON.parse(mismatch.stdout);
    assert.equal(detail.comparable, false);
    assert.equal(detail.missing.length, 1);
    assert.equal(detail.passed, false);
    const corrupt = path.join(directory, 'corrupt.json');
    writeFileSync(corrupt, '{"results": "fake"}');
    assert.equal(cli('coverage-diff', baseline, corrupt).status, 2);
    const duplicate = JSON.parse(readFileSync(baseline, 'utf8'));
    duplicate.results[1] = { ...duplicate.results[0] };
    writeFileSync(corrupt, JSON.stringify(duplicate));
    assert.equal(cli('coverage-diff', baseline, corrupt).status, 2);
    assert.equal(cli('coverage-diff', 'https://example.org/secret', baseline).status, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('app-debug restricts execution to packaged variants before Docker is called', () => {
  assert.equal(cli('app-debug', '../../etc/passwd').status, 2);
  assert.equal(cli('app-debug', 'https://example.com').status, 2);
  assert.equal(cli('app-debug', '--shell').status, 2);
  assert.equal(cli('app-debug', 'compare', '--unsafe').status, 2);
  assert.equal(cli('app-debug', 'fixed', '--json', '--json').status, 2);
  const result = cli('help');
  assert.match(result.stdout, /app-debug/);
  assert.match(result.stdout, /compare \(default\), buggy, fixed/);
});
