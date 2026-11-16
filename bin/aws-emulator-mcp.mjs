#!/usr/bin/env node
/* AWS Emulator MCP: boot a signed AWS Emulator and Python MCP in an isolated container.
 * Neither AWS credentials nor writable host directories are passed to Docker.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { stderr, stdout, execPath, exit } from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '0.4.0-beta.14';
const IMAGE = 'aws-emulator-mcp:' + VERSION;
const SOURCE = 'https://github.com/B11-Health/aws-emulator-mcp';
const EXPERIMENT_FILE = path.join(ROOT, 'src', 'aws_emulator_mcp', 'experiments.json');
function experiments() {
  const data = JSON.parse(readFileSync(EXPERIMENT_FILE, 'utf8'));
  if (data.schemaVersion !== 1 || !Array.isArray(data.experiments) ||
      data.experiments.some(item => !/^[a-z][a-z0-9-]{0,47}$/.test(item.id))) {
    fail('Bundled experiment registry invalid. Reinstall from source.');
  }
  return data;
}

function fail(message, code = 1) {
  stderr.write('AWS Emulator MCP: ' + message + '\n');
  exit(code);
}
function help() {
  stdout.write(`AWS Emulator MCP (Docker beta)

Usage: aws-emulator-mcp <command>

Commands:
  doctor           Verify Docker and the isolated emulator account
  demo             Execute a real S3 + DynamoDB + SQS order workflow
  mcp              Run 29 curated + 9 Docker-only tools via local MCP
  catalog          List implemented MCP tools
  coverage [svc]   Probe 20 allowlisted read-only AWS operations; distinguish modeled vs observed
  coverage-diff     Compare two saved coverage snapshots and fail on regressions
  experiments      Discover repeatable AWS lab missions (no Docker needed)
  experiment <id>  Run one allowlisted mission with proof and scoped cleanup
  contract demo|fault-demo|<file>  Replay an isolated AWS SDK test plan
  gate [directory] Run 1-6 checked-in JSON contracts and write sanitized CI evidence
  architecture demo|build|review  Generate diagrams, CloudFormation and PR change reviews offline
  failure-lab      Reproduce missing events, timeout recovery and deduplication
                   Modes: compare (default), fragile-before-send,
                   recover-before-send, recover-lost-ack
  app-verify <file> Verify YOUR trusted Python order handler in local Docker
                   No host mounts, outbound network, AWS account, or remote MCP execution
  app-debug [mode] Run the packaged order-intake bug/fix against real AWS APIs
                   Modes: compare (default), buggy, fixed
  self-test        Exercise supported services and scoped cleanup
  build            Build the image from the signed official AWS package
  config [format]  Print MCP configuration: copilot or vscode
  help             Show this help

Docker is required to run experiments and MCP tools; listing experiments or printing config needs only Node.
No AWS account or Python is required on the host.
Use --json with doctor, demo, self-test, catalog, coverage, experiments, or experiment for machine-readable results.\nFirst build downloads and verifies the official AWS Emulator.
Source: ${SOURCE}
`);
}
function requireDocker() {
  // DOCKER_HOST can override the selected context; reject remote daemon
  // redirects before invoking Docker. A remote daemon defeats local isolation.
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost && !/^(unix|npipe):\/\//.test(dockerHost)) {
    fail('Refusing nonlocal DOCKER_HOST. Use a local Docker Unix socket or Windows named pipe.');
  }
  const check = spawnSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], {
    encoding: 'utf8', timeout: 10000, windowsHide: true
  });
  if (check.error || check.status !== 0) {
    fail('Docker CLI unavailable. Install Docker Desktop/Engine and check: docker info');
  }
  let endpoint;
  try { endpoint = JSON.parse(check.stdout.trim()); } catch {
    fail('Unable to verify Docker context endpoint. Refusing unverified daemon.');
  }
  if (typeof endpoint !== 'string' || !/^(unix|npipe):\/\//.test(endpoint)) {
    fail('Use a local Unix-socket or Windows-pipe Docker context, not a remote daemon.');
  }
  const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8', timeout: 12000, windowsHide: true
  });
  if (info.status !== 0) fail('Docker daemon not running or inaccessible to this user.');
}
function imageExists() {
  return spawnSync('docker', ['image', 'inspect', IMAGE], {
    stdio: 'ignore', timeout: 10000, windowsHide: true
  }).status === 0;
}
function dockerArgs(mode, extra = []) {
  return ['run', '--rm', '-i', '--network', 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', '2g', IMAGE, mode, ...extra];
}
function runDocker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: 'inherit', windowsHide: true, shell: false });
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.once(sig, () => { if (!child.killed) child.kill(sig); });
    }
  });
}
async function buildImage() {
  if (!existsSync(path.join(ROOT, 'docker', 'Dockerfile')) ||
      !existsSync(path.join(ROOT, 'scripts', 'install_wsl.sh'))) {
    fail('Bundled Docker source missing; reinstall from a verified source release.');
  }
  stderr.write('AWS Emulator MCP: building a local image with the signed official AWS Emulator.\n');
  const child = spawn('docker', ['build', '--pull', '-t', IMAGE, '-f', 'docker/Dockerfile', ROOT], {
    stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, shell: false
  });
  child.stdout.pipe(stderr); // Docker build output must never corrupt MCP stdout.
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', value => resolve(value ?? 1));
  });
  if (code !== 0) fail('Image build failed; check Docker space and AWS signature/download.', code);
}
function renderReport(command, result) {
  const green = text => stdout.isTTY ? '\x1b[32m' + text + '\x1b[0m' : text;
  const muted = text => stdout.isTTY ? '\x1b[2m' + text + '\x1b[0m' : text;
  const mark = ok => ok ? green('PASS') : 'FAIL';
  const lines = ['', '  AWS EMULATOR MCP   /   LOCAL LAB', '  ----------------------------------------'];
  if (command === 'doctor') {
    lines.push('  ' + mark(result.ready) + '  Official AWS Emulator diagnostics',
      '  ' + muted(String(result.emulator_version || 'unknown')),
      '  Isolated account: ' + (result.account_verified ? 'verified' : 'NOT VERIFIED'), '');
    for (const item of result.checks || []) lines.push('  ' + mark(item.passed) + '  ' + item.check);
  } else if (command === 'demo') {
    lines.push('  ' + mark(result.passed) + '  Real synthetic order processing',
      '  Order: ' + result.order_id, '');
    for (const step of result.steps || []) {
      lines.push('  ' + mark(step.passed) + '  ' + step.name +
        '  ' + muted(String(step.duration_ms ?? '?') + ' ms'));
    }
    const recovery = result.recovery || [];
    const cleanup = result.cleanup || [];
    lines.push('', '  Recovery: ' + recovery.filter(x => x.passed).length + '/' + recovery.length,
      '  Scoped cleanup: ' + cleanup.filter(x => x.passed).length + '/' + cleanup.length,
      '  Duration: ' + (result.duration_ms / 1000).toFixed(2) + ' seconds',
      '  ' + (result.passed ? 'All test resources removed.' : 'Failure: ' + (result.error || 'see details')));
  } else if (command === 'self-test') {
    lines.push('  ' + mark(result.passed) + '  AWS Emulator S3 / DynamoDB / SQS tests', '');
    for (const item of result.checks || []) lines.push('  ' + mark(item.passed) + '  ' + item.name);
    const cleanup = result.cleanup || [];
    lines.push('  Scoped cleanup: ' + cleanup.filter(x => x.passed).length + '/' + cleanup.length);
  } else if (command === 'experiment') {
    lines.push('  ' + mark(result.passed) + '  ' + result.title,
      '  Services: ' + (result.services || []).join(', '),
      '  Real API assertions: ' + (result.steps || []).filter(x => x.passed).length +
        '/' + (result.steps || []).length,
      '  Expected faults: ' + (result.expectedFailures || []).filter(x => x.passed).length +
        '/' + (result.expectedFailures || []).length,
      '  Scoped cleanup: ' + (result.cleanup || []).filter(x => x.passed).length +
        '/' + (result.cleanup || []).length,
      '  Duration: ' + (result.duration_ms / 1000).toFixed(2) + ' seconds',
      '  ' + (result.passed ? 'All checks passed; lab resources removed.' :
        'Failure: ' + (result.error || 'inspect JSON evidence')));
  } else if (command === 'app-verify') {
    lines.push('  ' + mark(result.passed) + '  Local Python order-handler verification',
      '  Source SHA-256: ' + String(result.sourceSha256 || 'unverified').slice(0,20) + '…',
      '  Trusted local source executed in isolated Docker (never via MCP)',
      '  Application calls: DynamoDB / S3 / SQS',
      '  Accepted submissions: ' + result.observed?.acceptedSubmissions,
      '  SQS events: ' + result.observed?.queueEvents,
      '  Rich DynamoDB fields match: ' + String(result.observed?.businessFieldsMatch),
      '  Checks: ' + (result.assertions || []).filter(a => a.passed).length +
        '/' + (result.assertions || []).length,
      '  Cleanup: ' + (result.cleanup || []).filter(c => c.passed).length +
        '/' + (result.cleanup || []).length,
      '  Scope: One selected Python handler, NOT whole-app or AWS fidelity',
      '');
  } else if (command === 'app-debug') {
    const evidence = result.variant === 'compare' ? result : result.result;
    if (result.variant === 'compare') {
      lines.push('  ' + mark(result.passed) + '  Order-intake application debugging lab',
        '  Application: examples/order-intake',
        '  Services: DynamoDB, S3, SQS',
        '  Broken app:  ' + (result.bugReproduced ? 'BUG REPRODUCED' : 'NOT REPRODUCED'),
        '    Accepted submissions: ' + result.before.observed.acceptedSubmissions,
        '    SQS events: ' + result.before.observed.queueEvents,
        '  Reference fix: ' + (result.referenceFixVerified ? 'VERIFIED' : 'FAILED'),
        '    Accepted submissions: ' + result.after.observed.acceptedSubmissions,
        '    SQS events: ' + result.after.observed.queueEvents,
        '  Cleanup: ' + (result.before.cleanup.every(x => x.passed) &&
          result.after.cleanup.every(x => x.passed) ? 'VERIFIED BOTH RUNS' : 'FAILED'),
        '  Patch: examples/order-intake/reference.patch',
        '  NOTE: the packaged reference patch was tested; arbitrary agent patches are not executed.');
    } else {
      lines.push('  ' + mark(result.passed) +
        '  Order-intake application ' + result.variant + ' variant',
        '  Accepted submissions: ' + evidence.observed.acceptedSubmissions,
        '  SQS events: ' + evidence.observed.queueEvents,
        '  Assertions: ' + evidence.assertions.filter(x => x.passed).length +
          '/' + evidence.assertions.length,
        '  Cleanup: ' + evidence.cleanup.filter(x => x.passed).length +
          '/' + evidence.cleanup.length);
    }
  } else if (command === 'contract') {
    lines.push('  ' + mark(result.passed) + '  Replayable AWS SDK contract: ' + result.name,
      '  Steps passed: ' + result.passedSteps + '/' + result.totalSteps,
      '  Plan SHA-256: ' + result.planSha256);
    for (const step of result.steps || []) {
      lines.push('  ' + mark(step.passed) + '  ' + step.id + '  ' +
        step.service + '.' + step.operation + '  (' + step.observed + ')');
      if (step.fault) lines.push('    SDK fault ' + step.fault.mode +
        '; forwarded to emulator: ' + String(step.fault.sentToEmulator));
    }
    lines.push('  Isolated emulator state discarded when this run exits.');
  } else if (command === 'failure-lab') {
    if (result.scenario === 'compare') {
      const old = result.baseline.observed;
      const retry = result.presendRecovery.observed;
      const ack = result.lostAckRecovery.observed;
      lines.push('  ' + mark(result.passed) + '  Retry & delivery failure laboratory',
        '  Failure injected: local SDK wrapper (NOT an emulator outage)',
        '  FRAGILE:  first send failed, retry produced ' + old.queueEvents + ' events',
        '  RECOVER:  pre-send timeout, retry produced ' + retry.queueEvents + ' event',
        '  LOST ACK: duplicate SQS deliveries: ' + ack.queueEvents,
        '  CONSUMER: single idempotency effect marker: ' + ack.consumerEffectMarkers,
        '  Cleanup: ' + [result.baseline, result.presendRecovery, result.lostAckRecovery]
          .map(x => x.cleanup.filter(c => c.passed).length + '/' + x.cleanup.length).join(' | '));
    } else {
      const row = result.result;
      lines.push('  ' + mark(result.passed) + '  Failure Lab: ' + result.scenario,
        '  Expected scenario assertions: ' + row.assertions.filter(x => x.passed).length +
          '/' + row.assertions.length,
        '  Observed queue events: ' + row.observed.queueEvents,
        '  Consumer effect markers: ' + row.observed.consumerEffectMarkers,
        '  Cleanup: ' + row.cleanup.filter(x => x.passed).length + '/' + row.cleanup.length,
        '  Fault injected by a local SDK wrapper; not an emulator outage.');
    }
  } else if (command === 'coverage') {
    lines.push('  Read-only SDK coverage audit', '',
      '  Emulator: ' + (result.emulatorVersion || 'unknown'),
      '  SDK-modeled services: ' + result.modeledServiceCount,
      '  Read-only API probes: ' + result.totalProbes,
      '  Responded: ' + result.successfulProbes + '/' + result.totalProbes, '');
    if (result.serviceProbeStatus === 'not_probed') {
      lines.push('  NOT PROBED: this service has a model but is outside the safe probe list.');
    }
    for (const probe of result.results || []) {
      lines.push('  ' + (probe.status === 'responded' ? green('PASS') : '----') +
        '  ' + probe.service + '.' + probe.operation + '  (' + probe.status + ')');
    }
    lines.push('', '  Smoke responses are NOT proof of full AWS API or IAM fidelity.',
      '  Upstream fidelity: https://github.com/aws/aws-emulator/releases');
  } else if (command === 'catalog') {
    lines.push('  ' + result.length + ' available MCP tools', '');
    for (const tool of result) lines.push('  - ' + tool.name);
  }
  lines.push('', '  Local Docker lab only. No production AWS resources.', '');
  stdout.write(lines.join('\n') + '\n');
}
function runCaptured(args, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'inherit'], windowsHide: true, shell: false
    });
    const output = [];
    let length = 0;
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) {
        child.kill('SIGTERM');
        reject(Error('Docker command produced excessive output'));
      } else {
        output.push(chunk);
      }
    });
    if (input !== null) {
      child.stdin.on('error', () => {}); // Docker may close early on rejected input.
      child.stdin.end(input);
    }
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, raw: Buffer.concat(output).toString('utf8') }));
  });
}
// Bounded, read-only comparison of snapshots from the allowlisted SDK
// coverage probe. No shell, network, remote URL, or arbitrary code execution.
const COVERAGE_STATUSES = new Set([
  'responded', 'not_implemented', 'api_error', 'not_modeled', 'error'
]);
function readCoverageSnapshot(filename) {
  let info, data;
  try {
    info = lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 ||
        info.size === 0) throw Error('Snapshot is not a small regular file');
    data = JSON.parse(readFileSync(filename, 'utf8'));
  } catch {
    fail('Cannot read a valid local coverage snapshot (max 256 KiB)', 2);
  }
  const invalid = !data || data.schemaVersion !== 1 ||
    !Array.isArray(data.results) || data.results.length < 1 ||
    data.results.length > 200 || data.totalProbes !== data.results.length ||
    typeof data.emulatorVersion !== 'string' ||
    data.emulatorVersion.length > 100 ||
    !Number.isInteger(data.successfulProbes) ||
    data.successfulProbes < 0 || data.successfulProbes > data.totalProbes;
  if (invalid) fail('Invalid coverage snapshot schema; use coverage --json', 2);
  const keys = new Set();
  for (const row of data.results) {
    if (!row || typeof row.service !== 'string' ||
        typeof row.operation !== 'string' ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(row.service) ||
        !/^[A-Z][A-Za-z0-9]{0,80}$/.test(row.operation) ||
        !COVERAGE_STATUSES.has(row.status)) {
      fail('Invalid service, operation or probe status in coverage snapshot', 2);
    }
    const key = row.service + '.' + row.operation;
    if (keys.has(key)) fail('Duplicate API probe in coverage snapshot', 2);
    keys.add(key);
  }
  if (data.successfulProbes !== data.results.filter(x => x.status === 'responded').length)
    fail('Coverage snapshot success count does not match API results', 2);
  return data;
}
function compareCoverage(before, after) {
  const key = x => x.service + '.' + x.operation;
  const old = new Map(before.results.map(x => [key(x), x.status]));
  const now = new Map(after.results.map(x => [key(x), x.status]));
  const missing = [...old.keys()].filter(x => !now.has(x)).sort();
  const added = [...now.keys()].filter(x => !old.has(x)).sort();
  const comparable = missing.length === 0 && added.length === 0;
  const regressions = [], improvements = [], changed = [];
  if (comparable) {
    for (const k of [...old.keys()].sort()) {
      const left = old.get(k), right = now.get(k);
      if (left === right) continue;
      const row = { operation: k, before: left, after: right };
      if (left === 'responded' && right !== 'responded') regressions.push(row);
      else if (left !== 'responded' && right === 'responded') improvements.push(row);
      else changed.push(row);
    }
  }
  return {
    schemaVersion: 1, comparable, passed: comparable && regressions.length === 0,
    baselineVersion: before.emulatorVersion, currentVersion: after.emulatorVersion,
    baseline: { successful: before.successfulProbes, probed: before.totalProbes },
    current: { successful: after.successfulProbes, probed: after.totalProbes },
    regressions, improvements, changed, missing, added,
    note: 'Compares only matching, allowlisted read-only API probe responses; not full AWS fidelity or compatibility.'
  };
}
function renderDiff(report) {
  const lines = ['',
    '  AWS EMULATOR MCP / COVERAGE REGRESSION CHECK',
    '  ------------------------------------------------',
    '  Baseline: ' + report.baselineVersion +
      '  (' + report.baseline.successful + '/' + report.baseline.probed + ')',
    '  Current:  ' + report.currentVersion +
      '  (' + report.current.successful + '/' + report.current.probed + ')',
    '  Comparison: ' + (report.comparable ? 'same operation set' : 'NOT COMPARABLE'),
    '  Regressions: ' + report.regressions.length,
    '  Improvements: ' + report.improvements.length,
    '  Other changes: ' + report.changed.length
  ];
  for (const row of report.regressions)
    lines.push('  REGRESSION ' + row.operation + ': ' + row.before + ' -> ' + row.after);
  for (const row of report.improvements)
    lines.push('  IMPROVEMENT ' + row.operation + ': ' + row.before + ' -> ' + row.after);
  for (const k of report.missing)
    lines.push('  MISSING CURRENT PROBE ' + k);
  for (const k of report.added)
    lines.push('  ADDED CURRENT PROBE ' + k);
  lines.push('', '  ' + (report.passed ? 'PASS' : 'FAIL') +
    '  Snapshot comparison only; no AWS production fidelity claim.', '');
  stdout.write(lines.join('\n') + '\n');
}

function config(format = 'copilot') {
  if (!['copilot', 'vscode'].includes(format)) fail('config format: copilot or vscode', 2);
  const launch = { type: 'stdio', command: execPath, args: [fileURLToPath(import.meta.url), 'mcp'] };
  const result = format === 'copilot'
    ? { mcpServers: { 'aws-emulator-local': launch } }
    : { servers: { 'aws-emulator-local': launch } };
  stdout.write(JSON.stringify(result, null, 2) + '\n');
}
async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) return help();
  if (command === 'architecture') {
    const script = path.join(ROOT, 'scripts', args[0] === 'review'
      ? 'architecture_review.mjs' : 'architecture_studio.mjs');
    const scriptArgs = args[0] === 'review' ? args.slice(1) : args;
    if (!existsSync(script)) fail('Architecture Studio generator unavailable', 2);
    const result = spawnSync(process.execPath, [script, ...scriptArgs], {
      cwd: process.cwd(), stdio: 'inherit', timeout: 12000,
      windowsHide: true, shell: false
    });
    if (result.error || result.status !== 0)
      fail('Architecture Studio validation or generation failed', result.status || 1);
    return;
  }
  if (command === 'gate') {
    if (args.length > 1 || (args[0] && args[0].startsWith('-'))) {
      fail('Usage: aws-emulator-mcp gate [relative-contract-directory]', 2);
    }
    const script = path.join(ROOT, 'scripts', 'contract_pr_gate.mjs');
    if (!existsSync(script)) fail('Contract gate runner unavailable in installed package', 2);
    const result = spawnSync(process.execPath, [script], {
      cwd: process.cwd(), stdio: 'inherit', timeout: 15 * 60 * 1000,
      windowsHide: true, shell: false,
      env: { ...process.env, AWS_MCP_GATE_DIRECTORY: args[0] || '.aws-emulator/contracts' }
    });
    if (result.error || result.status !== 0) fail('One or more PR contracts failed', result.status || 1);
    return;
  }
  if (command === 'contract') {
    const wantsJson = args.includes('--json');
    const rest = args.filter(x => x !== '--json');
    if (rest.length !== 1 || args.length > 2 ||
        args.filter(x => x === '--json').length > 1 || rest[0].startsWith('-') ||
        /^(https?:|file:)/i.test(rest[0])) {
      fail('Usage: aws-emulator-mcp contract demo|fault-demo|<local-plan.json> [--json]', 2);
    }
    let plan;
    try {
      const filename = rest[0] === 'demo'
        ? path.join(ROOT, 'examples', 'contracts', 's3-write-read.json')
        : rest[0] === 'fault-demo'
          ? path.join(ROOT, 'examples', 'contracts', 'sqs-after-success.json')
          : rest[0];
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 ||
          stat.size > 48 * 1024) throw Error('not a bounded regular file');
      plan = JSON.parse(readFileSync(filename, 'utf8'));
    } catch {
      fail('Contract must be a small local JSON file (max 48 KiB, no symlinks)', 2);
    }
    if (!plan || plan.schemaVersion !== 1 || typeof plan.name !== 'string' ||
        !Array.isArray(plan.steps) || plan.steps.length < 1 ||
        plan.steps.length > 16) {
      fail('Contract plan requires schemaVersion=1, name and 1-16 steps', 2);
    }
    requireDocker();
    if (!imageExists()) await buildImage();
    const result = await runCaptured(dockerArgs('contract'), JSON.stringify(plan));
    let proof;
    try { proof = JSON.parse(result.raw); }
    catch { fail('Contract worker returned invalid evidence', result.code || 1); }
    if (wantsJson) stdout.write(JSON.stringify(proof, null, 2) + '\n');
    else renderReport('contract', proof);
    if (result.code !== 0 || !proof.passed)
      fail('One or more contract assertions failed', result.code || 1);
    return;
  }
  if (command === 'failure-lab') {
    const jsonFlag = args.includes('--json');
    const rest = args.filter(x => x !== '--json');
    const modes = ['compare', 'fragile-before-send', 'recover-before-send', 'recover-lost-ack'];
    if (args.length > 2 || rest.length > 1 ||
        args.filter(x => x === '--json').length > 1 ||
        (rest.length && !modes.includes(rest[0]))) {
      fail('Usage: aws-emulator-mcp failure-lab [compare|fragile-before-send|recover-before-send|recover-lost-ack] [--json]', 2);
    }
    requireDocker();
    if (!imageExists()) await buildImage();
    const result = await runCaptured(dockerArgs('failure-lab', [rest[0] || 'compare']));
    let parsed;
    try { parsed = JSON.parse(result.raw); }
    catch { fail('Could not parse Failure Lab evidence (exit ' + result.code + ')',
                 result.code || 1); }
    if (jsonFlag) stdout.write(JSON.stringify(parsed, null, 2) + '\n');
    else renderReport('failure-lab', parsed);
    if (result.code !== 0 || !parsed.passed)
      fail('Failure Lab scenario assertions or cleanup failed', result.code || 1);
    return;
  }
  if (command === 'app-verify') {
    const wantsJson = args.includes('--json');
    const rest = args.filter(x => x !== '--json');
    if (rest.length !== 1 || args.length > 2 ||
        args.filter(x => x === '--json').length > 1 ||
        rest[0].startsWith('-') || rest[0].length > 260 ||
        /^(https?:|file:)/i.test(rest[0])) {
      fail('Usage: aws-emulator-mcp app-verify <trusted-local-handler.py> [--json]', 2);
    }
    let source, raw;
    try {
      const file = rest[0];
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() ||
          info.size < 1 || info.size > 20 * 1024 ||
          !file.endsWith('.py')) throw Error('invalid source file');
      raw = readFileSync(file);
      source = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      if (!source.trim() || source.includes('\0')) throw Error('invalid source data');
    } catch {
      fail('Choose a bounded, regular local Python .py file (max 20 KiB, no symlinks)', 2);
    }
    const envelope = {
      schemaVersion: 1, source,
      sourceSha256: createHash('sha256').update(raw).digest('hex')
    };
    // Source bytes are sent via stdin into this one-shot no-network Docker
    // container. Nothing is bind-mounted, and no host credentials are passed.
    requireDocker();
    if (!imageExists()) await buildImage();
    const result = await runCaptured(
      dockerArgs('app-verify'), JSON.stringify(envelope));
    let proof;
    try { proof = JSON.parse(result.raw); }
    catch { fail('Local handler returned no valid sanitized evidence', result.code || 1); }
    if (wantsJson) stdout.write(JSON.stringify(proof, null, 2) + '\n');
    else renderReport('app-verify', proof);
    if (result.code !== 0 || !proof.passed)
      fail('Trusted local handler failed synthetic assertions or cleanup', result.code || 1);
    return;
  }
  if (command === 'app-debug') {
    const wantsJson = args.includes('--json');
    const rest = args.filter(x => x !== '--json');
    if (args.length > 2 || rest.length > 1 ||
        args.filter(x => x === '--json').length > 1 ||
        (rest.length && !['compare', 'buggy', 'fixed'].includes(rest[0]))) {
      fail('Usage: aws-emulator-mcp app-debug [compare|buggy|fixed] [--json]', 2);
    }
    requireDocker();
    if (!imageExists()) await buildImage();
    const result = await runCaptured(dockerArgs('app-debug', [rest[0] || 'compare']));
    let parsed;
    try { parsed = JSON.parse(result.raw); }
    catch { fail('Could not parse packaged app-debug result (exit ' + result.code + ')',
                 result.code || 1); }
    if (wantsJson) stdout.write(JSON.stringify(parsed, null, 2) + '\n');
    else renderReport('app-debug', parsed);
    if (result.code !== 0 || !parsed.passed)
      fail('Order-intake application assertions or cleanup failed', result.code || 1);
    return;
  }
  if (command === 'coverage-diff') {
    const wantsJson = args.includes('--json');
    const rest = args.filter(x => x !== '--json');
    if (args.length < 2 || args.length > 3 || rest.length !== 2 ||
        args.filter(x => x === '--json').length > 1 ||
        rest.some(x => x.startsWith('-') || /^(https?:|file:)/i.test(x))) {
      fail('Usage: aws-emulator-mcp coverage-diff <baseline.json> <current.json> [--json]', 2);
    }
    const report = compareCoverage(
      readCoverageSnapshot(rest[0]), readCoverageSnapshot(rest[1]));
    if (wantsJson) stdout.write(JSON.stringify(report, null, 2) + '\n');
    else renderDiff(report);
    if (!report.comparable) fail('Coverage snapshots have different probe sets', 2);
    if (!report.passed) fail('One or more read-only API responses regressed', 1);
    return;
  }
  if (command === 'coverage') {
    const withJson = args.includes('--json');
    const rest = args.filter(x => x !== '--json');
    if (args.length > 2 || rest.length > 1 ||
        (rest.length && !/^[a-z][a-z0-9-]{0,63}$/.test(rest[0])) ||
        args.filter(x => x === '--json').length > 1) {
      fail('Usage: aws-emulator-mcp coverage [service] [--json]', 2);
    }
    requireDocker();
    if (!imageExists()) await buildImage();
    const result = await runCaptured(dockerArgs('coverage', [rest[0] || 'all']));
    let parsed;
    try { parsed = JSON.parse(result.raw); }
    catch { fail('Could not parse local coverage response (exit ' + result.code + ')', result.code || 1); }
    if (withJson) stdout.write(JSON.stringify(parsed, null, 2) + '\n');
    else renderReport('coverage', parsed);
    if (result.code !== 0) fail('Read-only coverage checks failed (inspect JSON)', result.code || 1);
    return;
  }
  if (command === 'experiments') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--json'))
      fail('Usage: aws-emulator-mcp experiments [--json]', 2);
    const result = experiments();
    if (args[0] === '--json') stdout.write(JSON.stringify(result, null, 2) + '\n');
    else {
      stdout.write('AWS EMULATOR MCP / REPRODUCIBLE LABS\n\n');
      for (const item of result.experiments) {
        stdout.write('  ' + item.id + '  -  ' + item.title + '\n');
        stdout.write('    ' + item.services.join(', ') + '  |  ' + item.goal + '\n\n');
      }
      stdout.write('Run: aws-emulator-mcp experiment <id> [--json]\n');
    }
    return;
  }
  if (command === 'experiment') {
    if (args.length < 1 || args.length > 2 ||
        (args.length === 2 && args[1] !== '--json') ||
        !experiments().experiments.some(item => item.id === args[0])) {
      fail('Unknown experiment. Run: aws-emulator-mcp experiments', 2);
    }
    requireDocker();
    if (!imageExists()) await buildImage();
    const result = await runCaptured(dockerArgs('experiment', [args[0]]));
    let parsed;
    try { parsed = JSON.parse(result.raw); }
    catch { fail('Could not parse experiment evidence (exit ' + result.code + ')', result.code || 1); }
    if (args[1] === '--json') stdout.write(JSON.stringify(parsed, null, 2) + '\n');
    else renderReport('experiment', parsed);
    if (result.code !== 0 || !parsed.passed)
      fail('Experiment assertions or cleanup failed', result.code || 1);
    return;
  }
  if (command === 'config') {
    if (args.length > 1) fail('config accepts at most one format', 2);
    return config(args[0]);
  }
  const commands = ['build', 'doctor', 'demo', 'mcp', 'catalog', 'self-test'];
  const wantsJson = args.length === 1 && args[0] === '--json';
  if (!commands.includes(command) ||
      (args.length && !(wantsJson && !['build', 'mcp'].includes(command)))) {
    fail('Unknown command/arguments. Run: aws-emulator-mcp help', 2);
  }
  requireDocker();
  if (command === 'build' || !imageExists()) await buildImage();
  if (command === 'build') return;
  if (command === 'mcp') {
    const code = await runDocker(dockerArgs(command));
    if (code !== 0) fail('MCP server exited (exit ' + code + ')', code);
    return;
  }
  if (!wantsJson) stderr.write('AWS Emulator MCP: running verified local ' + command + '...\n');
  const result = await runCaptured(dockerArgs(command));
  let parsed;
  try { parsed = JSON.parse(result.raw); }
  catch { fail('Could not parse container output (exit ' + result.code + ')', result.code || 1); }
  if (wantsJson) stdout.write(JSON.stringify(parsed, null, 2) + '\n');
  else renderReport(command, parsed);
  if (result.code !== 0) fail(command + ' failed (exit ' + result.code + ')', result.code);
}
main().catch(err => fail(err?.message || String(err)));
