import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
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
test('round-three beginner instructions use one checkout with Claude config and connect-check', () => {
  const readme = readFileSync(new URL('../README.md',import.meta.url),'utf8');
  const firstRun = readFileSync(new URL('../docs/FIRST_RUN.md',import.meta.url),'utf8');
  const checkout = 'git clone --depth 1 --branch release/agent-team-preview-r3-20261118';
  for(const doc of [readme,firstRun]) {
    assert.ok(doc.includes(checkout),'must clone branch containing both commands');
    assert.ok(doc.includes('node bin/aws-emulator-mcp.mjs config claude'));
    assert.ok(doc.includes('node bin/aws-emulator-mcp.mjs connect-check --json'));
    assert.ok(!doc.includes('git clone --depth 1 --branch release/agent-team-preview-r2-20261118'));
  }
  assert.match(readme,/older round-two preview has `config claude` but not `connect-check`/);
  assert.match(firstRun,/earlier round-two checkout: that checkout has `config claude` but does not/);
});

test('README and FIRST_RUN agree with the exact lowercase MCP health body checked by source', () => {
  const source = readFileSync(new URL('../scripts/mcp_connection_check.mjs',import.meta.url),'utf8');
  const readme = readFileSync(new URL('../README.md',import.meta.url),'utf8');
  const firstRun = readFileSync(new URL('../docs/FIRST_RUN.md',import.meta.url),'utf8');
  const expected = source.match(/const HEALTH_BODY = '([^']+)';/);
  assert.ok(expected, 'connection checker must declare one exact health body');
  assert.equal(expected[1], 'ok', 'signed local emulator health response is lowercase');
  assert.match(source, /status\.body!==HEALTH_BODY/, 'status body must be checked exactly');
  for (const [name,doc] of [['README',readme],['FIRST_RUN',firstRun]]) {
    const firstDocumented = doc.match(/`body: "([^"]+)"`/);
    assert.ok(firstDocumented, `${name} must document the expected health body`);
    assert.equal(firstDocumented[1], expected[1], `${name} must not describe uppercase OK as healthy`);
  }
  assert.doesNotMatch(readme,/exact healthy `body: "OK"` from loopback/,
    'regression: README formerly claimed uppercase OK was healthy');
  assert.match(firstRun,/`body: "OK"` is \*\*not\*\* enough|`body: "OK"`, or/,
    'uppercase OK must remain documented as a rejected response');
});

test('Claude Desktop config is a paste-ready stdio entry with the real executable and package path', () => {
  const result = cli('config', 'claude');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(payload), ['mcpServers']);
  const cfg = payload.mcpServers['aws-emulator-local'];
  assert.deepEqual(Object.keys(cfg), ['command', 'args']);
  assert.equal(cfg.command, process.execPath);
  assert.deepEqual(cfg.args, [BIN, 'mcp']);
  assert.ok(existsSync(cfg.args[0]));
  assert.ok(path.isAbsolute(cfg.command) && path.isAbsolute(cfg.args[0]));
});

test('Claude config rejects unattended install, file-write and extra CLI arguments', () => {
  for (const args of [
    ['claude','--install'], ['claude','--write'], ['claude','/tmp/other.json'],
    ['claude','--json'], ['claude','--docker'], ['claude','claude']
  ]) {
    const result = cli('config', ...args);
    assert.equal(result.status, 2, `Unexpected status for ${JSON.stringify(args)}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /config accepts at most one format/);
  }
});

test('Claude config fails closed for unknown clients and does not print a fallback JSON', () => {
  for (const name of ['claude-desktop', 'claude-code', 'http', 'remote', '-h']) {
    const result = cli('config', name);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /config format: copilot .* claude .* vscode/);
  }
});

test('Claude config is read-only even with remote Docker and ambient AWS credentials', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aws-mcp-claude-config-'));
  try {
    const result = spawnSync(process.execPath, [BIN, 'config', 'claude'], {
      cwd:home, encoding:'utf8', timeout:12000,
      env:{...process.env, HOME:home, APPDATA:home,
        PATH:'/nonexistent', DOCKER_HOST:'tcp://192.0.2.88:2375',
        AWS_SECRET_ACCESS_KEY:'DO_NOT_PRINT_SECRET', AWS_PROFILE:'DO_NOT_PRINT_PROFILE'}
    });
    assert.equal(result.status, 0, result.stderr);
    const cfg = JSON.parse(result.stdout).mcpServers['aws-emulator-local'];
    assert.equal(cfg.env, undefined);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /DO_NOT_PRINT|192\.0\.2\.88/);
    assert.deepEqual(readdirSync(home), []); // Does not modify the user's settings.
  } finally { rmSync(home, {recursive:true, force:true}); }
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

test('contract assertion challenge is opt-in, rejects invalid flags before Docker', () => {
  const help = cli('help');
  assert.match(help.stdout, /Add --challenge/);
  for (const args of [
    ['contract', 'demo', '--challenge', '--challenge'],
    ['contract', 'demo', '--json', '--json', '--challenge'],
    ['contract', 'demo', '--challenge', '--json', '--unsafe'],
    ['contract', 'https://example.com/contract.json', '--challenge'],
    ['contract', 'file:///etc/passwd', '--challenge'],
  ]) {
    const result = cli(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
  }
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
