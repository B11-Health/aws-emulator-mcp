import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
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
  assert.match(result.stdout, /29 curated \+ 10 Docker-only tools/);
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
  assert.match(result.stderr, /deprecated editor-managed/);
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
  assert.equal(pkg.version, '0.4.0-beta.15');
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

test('opt-in local app-verify refuses unsafe source input before Docker', () => {
  assert.equal(cli('app-verify').status, 2);
  assert.equal(cli('app-verify','https://example.org/order.py').status, 2);
  assert.equal(cli('app-verify','file:./order.py').status, 2);
  assert.equal(cli('app-verify','--shell').status, 2);
  assert.equal(cli('app-verify','app.py','--json','--json').status, 2);
  assert.equal(cli('app-verify','../../etc/passwd').status, 2);
  const dir=mkdtempSync(path.join(tmpdir(),'aws-mcp-local-source-'));
  try {
    const file=path.join(dir,'handler.py');
    writeFileSync(file,'# private source file\n');
    // A valid local file may reach Docker verification, but a nonlocal
    // Docker endpoint is rejected *before any container starts*.
    const blocked=spawnSync(process.execPath,[BIN,'app-verify',file,'--json'],{
      encoding:'utf8',timeout:12000,
      env:{...process.env,DOCKER_HOST:'tcp://192.0.2.4:2375'}
    });
    assert.equal(blocked.status,1);
    assert.match(blocked.stderr,/Refusing nonlocal DOCKER_HOST/);
    assert.equal(blocked.stdout,'');
    assert.doesNotMatch(blocked.stderr,/private source/);
    writeFileSync(file,Buffer.from([0xff,0xfe,0xfd]));
    assert.equal(cli('app-verify',file).status,2);
    writeFileSync(file,'z'.repeat(20*1024+1));
    assert.equal(cli('app-verify',file).status,2);
    writeFileSync(file,'valid Python?');
    assert.equal(cli('app-verify',path.join(dir,'no.txt')).status,2);
    if(process.platform!=='win32'){
      const link=path.join(dir,'alias.py');
      symlinkSync(file,link);
      assert.equal(cli('app-verify',link).status,2);
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
  const help=cli('help').stdout;
  assert.match(help,/app-verify <file>/);
  assert.match(help,/No host mounts/);
  const src=readFileSync(BIN,'utf8');
  assert.match(src,/dockerArgs\('app-verify'\)/);
  assert.doesNotMatch(src,/docker cp |--volume/);
});

test('contract CLI refuses remote paths, bad files and bad shapes before Docker', () => {
  assert.equal(cli('contract').status, 2);
  assert.equal(cli('contract', 'https://example.org/plan.json').status, 2);
  assert.equal(cli('contract', '--shell').status, 2);
  assert.equal(cli('contract', 'demo', '--json', '--json').status, 2);
  const directory = mkdtempSync(path.join(tmpdir(), 'aws-mcp-contract-'));
  try {
    const invalid = path.join(directory, 'invalid.json');
    writeFileSync(invalid, JSON.stringify({ schemaVersion: 1, name: 'empty', steps: [] }));
    assert.equal(cli('contract', invalid).status, 2);
    writeFileSync(invalid, '{invalid json');
    assert.equal(cli('contract', invalid).status, 2);
    writeFileSync(invalid, 'z'.repeat(50000));
    assert.equal(cli('contract', invalid).status, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  assert.match(cli('help').stdout, /contract demo/);
  assert.match(cli('help').stdout, /fault-demo/);
});



test('Docker image builder never references the contract stdin variable', () => {
  const source = readFileSync(BIN, 'utf8');
  const build = source.slice(source.indexOf('async function buildImage()'),
    source.indexOf('function renderReport('));
  assert.match(build, /stdio: \[\x27ignore\x27, \x27pipe\x27, \x27inherit\x27\]/);
  assert.doesNotMatch(build, /\binput\b/);
});

test('Failure Lab CLI rejects arbitrary code, paths and invalid modes before Docker', () => {
  assert.equal(cli('failure-lab', '../../etc/passwd').status, 2);
  assert.equal(cli('failure-lab', 'https://example.org/script.py').status, 2);
  assert.equal(cli('failure-lab', '--shell').status, 2);
  assert.equal(cli('failure-lab', 'compare', '--json', '--json').status, 2);
  assert.equal(cli('failure-lab', 'recover-before-send', '--unsafe').status, 2);
  const shown = cli('help');
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /failure-lab/);
  assert.match(shown.stdout, /lost-ack/);
  assert.match(shown.stdout, /partial-compare/);
  assert.equal(cli('failure-lab', 'arbitrary-remote', '--json').status, 2);
  assert.equal(cli('failure-lab', 'fragile-before-receipt', '--json', '--json').status, 2);
});


test('fault contract examples are bundled, bounded and reject script input before Docker', () => {
  const pkg = JSON.parse(requirePackage());
  for (const name of ['sqs-before-call', 'sqs-after-success']) {
    const relative = 'examples/contracts/' + name + '.json';
    assert.ok(pkg.files.includes(relative));
    const plan = JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
    assert.equal(plan.schemaVersion, 1);
    assert.ok(plan.steps.length >= 5 && plan.steps.length <= 16);
    const faults = plan.steps.filter(step => step.fault);
    assert.equal(faults.length, 1);
    assert.deepEqual(faults[0].expect, { errorCode: 'RequestTimeout' });
  }
  assert.equal(cli('contract', 'fault-demo', '--json', '--json').status, 2);
  assert.equal(cli('contract', 'file:///etc/passwd').status, 2);
  const content = readFileSync(BIN, 'utf8');
  assert.match(content, /sqs-after-success\.json/);
});


test('PR gate command has local usage and the bundled runner is present', () => {
  assert.match(cli('help').stdout, /gate \[directory\]/);
  assert.equal(cli('gate', 'two', 'directories').status, 2);
  const pkg = JSON.parse(requirePackage());
  assert.ok(pkg.files.includes('scripts/contract_pr_gate.mjs'));
  assert.ok(pkg.files.includes('docs/CI_CONTRACT_GATE.md'));
});
