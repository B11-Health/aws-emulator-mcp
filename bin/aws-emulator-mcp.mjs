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
import { compareHandlerEvidence, comparisonMarkdown } from '../scripts/byo_compare.mjs';
import { inspectPreflight, printPreflight, buildSpaceWarning } from '../scripts/preflight.mjs';
import { inspectOfficialSession, parseOfficialSessionArgs, formatOfficialSession } from '../scripts/official_session.mjs';
import { imageSourceDigest } from '../scripts/image_identity.mjs';
import { runOfflineTrial, formatOfflineTrial } from '../scripts/offline_trial.mjs';
import {parseOnboardArgs, runOnboarding, formatOnboarding} from '../scripts/onboard.mjs';
import {inspectMcpConnection, formatMcpConnection} from '../scripts/mcp_connection_check.mjs';
import { summarizeProjectProbes, formatProjectCheck, buildAssertionChallenge, assessContractChallenge, planSha256 } from '../scripts/project_check.mjs';
import { verifyAppCaseProof, compareAppCaseEvidence, appCaseMarkdown } from '../scripts/app_case_compare.mjs';
import {createGapReproCapsule,readGapReport} from '../scripts/gap_repro_capsule.mjs';
import {parseAppGuideArgs, summarizeAppGuide, formatAppGuide, writeDraftExclusive, buildProofDraftPair, writeProofDraftPairExclusive, requiredOperationsSucceeded} from '../scripts/app_guide.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '0.4.0-beta.15';
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
  onboard [--offline] [--json]  First verified result + optional read-only Docker guidance
  try [--json]     Verify 7 architecture artifacts offline in a temporary workspace
  project-plan PATH [--json | --contract SERVICE]  Find Python SDK calls and draft local tests
  project-check PATH [--run] [--challenge] [--json]  Scan app, run SDK probes, challenge an assertion
  preflight [--json]  Check Node and local Docker without building an image
  connect-check [--json]  Explicit local MCP handshake and read-only tool reply (prebuilt image only)
  official-session [--port 9297] [--identity] [--json]  Inspect an existing official AWS Emulator loopback session (no Docker)
  doctor           Verify Docker and the isolated emulator account
  demo             Execute a real S3 + DynamoDB + SQS order workflow
  mcp              Run 29 curated + 10 Docker-only tools via local MCP
  catalog          List implemented MCP tools
  coverage [svc]   Probe 20 allowlisted read-only AWS operations; distinguish modeled vs observed
  coverage-diff     Compare two saved coverage snapshots and fail on regressions
  experiments      Discover repeatable AWS lab missions (no Docker needed)
  experiment <id>  Run one allowlisted mission with proof and scoped cleanup
  contract demo|fault-demo|<file>  Replay an isolated AWS SDK test plan
                   Add --challenge to test that a wrong expectation is detected
  gate [directory] Run 1-6 checked-in JSON contracts and write sanitized CI evidence
  architecture demo|build|review  Generate diagrams, CloudFormation and PR change reviews offline
  failure-lab      Reproduce missing events, timeout recovery and deduplication
                   Modes: compare (default), fragile-before-send,
                   recover-before-send, recover-lost-ack, partial-compare
                   (before/after a synthetic S3 receipt-upload failure)
  app-case-inspect APP.py [CASE.json] [--entrypoint NAME] [--json]  Read-only onboarding
  app-guide APP.py [CASE.json] [--json | --draft NEW.json | --draft-proof NEW.json | --run --approve TOKEN]
                   Scan trusted Python code; draft a NON-runnable case or reviewed state/expected-red pair for one S3/SQS/DDB write
                   Requires a matching hash token before any local execution
  app-case <app.py> <case.json>  Verify YOUR trusted Python function with independent SDK assertions
  app-case-compare <before.py> <after.py> <case.json>  Verify an app regression and its fix
                   Explicit local-only code execution; never callable through MCP/PR Actions
  gap-capsule <failed-report.json>  Offline redacted JSON triage from an existing report; NO app/Docker/AWS execution
  app-verify <file> Verify YOUR trusted Python order handler in local Docker
  app-compare <before.py> <after.py>  Reproduce a bug and verify your own fix
                   JSON or PR-ready Markdown evidence; trusted local files only
                   No host mounts, outbound network, AWS account, or remote MCP execution
  app-debug [mode] Run the packaged order-intake bug/fix against real AWS APIs
                   Modes: compare (default), buggy, fixed
  self-test        Exercise supported services and scoped cleanup
  build            Build the image from the signed official AWS package
  config [format]  Print MCP configuration: copilot, claude or vscode (legacy)
  help             Show this help

Docker is required to run experiments and MCP tools; listing experiments or printing config needs only Node.
No AWS account is required. Optional project/app source inspection needs host Python 3.10+.
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
  // A semver tag alone may point to an older checkout's Python bundle.
  // Only reuse a locally built image with matching Docker-copy inputs.
  const expected = imageSourceDigest(ROOT);
  const observed = spawnSync('docker', ['image', 'inspect', IMAGE,
    '--format', '{{index .Config.Labels "dev.aws-emulator-mcp.source-sha256"}}'], {
    encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false
  });
  if (observed.status === 0 && observed.stdout.trim() !== expected) {
    stderr.write('AWS Emulator MCP: cached image source differs or is unverified; rebuilding local image.\n');
  }
  return observed.status === 0 && observed.stdout.trim() === expected;
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
  const digest = imageSourceDigest(ROOT);
  const readiness = inspectPreflight({image: IMAGE, expectedImageDigest: () => digest});
  const storageWarning = buildSpaceWarning(readiness);
  if (storageWarning) stderr.write('AWS Emulator MCP: BUILD RISK: ' + storageWarning + '\n');
  stderr.write('AWS Emulator MCP: building a local image with the signed official AWS Emulator.\n');
  const child = spawn('docker', ['build', '--pull', '--build-arg',
    'AWS_MCP_SOURCE_SHA256=' + digest, '-t', IMAGE, '-f', 'docker/Dockerfile', ROOT], {
    stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, shell: false
  });
  child.stdout.pipe(stderr); // Docker build output must never corrupt MCP stdout.
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', value => resolve(value ?? 1));
  });
  if (code !== 0) fail('Image build failed; check signed download, Docker storage and the preflight capacity advisory. No automatic cleanup was performed.', code);
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
  } else if (command === 'app-case') {
    lines.push('  ' + mark(result.passed) + '  Developer-approved local application scenario',
      '  Case: ' + result.case,
      '  Emulator: ' + result.emulatorVersion,
      '  Actual entrypoint invoked: ' + String(result.sourceInvoked),
      '  Independent SDK checks: ' + result.checks.flatMap(c=>c.assertions).filter(x=>x.passed).length +
        '/' + result.checks.flatMap(c=>c.assertions).length,
      '  Observed SDK calls: ' + result.sdkCalls.map(x=>x.service+'.'+x.operation+':'+x.attempts).join(', '),
      '  Cleanup: ' + mark(result.cleanupPassed),
      '  Source SHA-256: ' + result.sourceSha256,
      '  App code was executed ONLY after explicit local CLI selection; never via MCP.');
  } else if (command === 'app-case-compare') {
    lines.push('  ' + mark(result.passed) + '  Developer-approved application regression comparison',
      '  Named regression: ' + result.regression.stepId + '.' + result.regression.path,
      '  Before: ' + mark(result.bugReproduced) + ' expected bug reproduced',
      '  After:  ' + mark(result.fixVerified) + ' corrected invariant verified',
      '  Emulator: ' + result.emulatorVersion,
      '  Both cleanups: ' + mark(result.before.cleanupPassed && result.after.cleanupPassed),
      '  Not full application coverage or AWS production parity.');
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
  } else if (command === 'app-compare') {
    lines.push('  ' + mark(result.passed) + '  Your own Python handler / before-and-after',
      '  Duplicate event bug reproduced: ' + mark(result.bugReproduced),
      '  Developer-selected fix verified: ' + mark(result.fixVerified),
      '  Emulator: ' + result.emulatorVersion,
      '  Before: ' + result.before.observed.acceptedSubmissions + ' accepted / ' +
        result.before.observed.queueEvents + ' messages',
      '  After:  ' + result.after.observed.acceptedSubmissions + ' accepted / ' +
        result.after.observed.queueEvents + ' messages',
      '  Source hashes (before / after):',
      '    ' + result.before.sourceSha256,
      '    ' + result.after.sourceSha256,
      '  Cleanup: ' + mark(result.before.cleanupPassed && result.after.cleanupPassed),
      '  PR evidence: rerun with --markdown or --json',
      '  Trusted local source only; not generic codebase testing or AWS parity.');
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
    } else if (result.scenario === 'partial-compare') {
      const broken = result.baseline.observed;
      const recovered = result.recovery.observed;
      lines.push('  ' + mark(result.passed) + '  DynamoDB -> S3 -> SQS partial-write recovery',
        '  Fault: first S3 receipt upload rejected at local SDK boundary',
        '  DynamoDB order after first write: ' + broken.statusAfterFault,
        '  FRAGILE: receipt after retry: ' + String(broken.receiptPresentAfterRetry) +
          '; SQS events: ' + broken.queueEvents,
        '  RECOVERED: receipt matches: ' + String(recovered.receiptMatches) +
          '; SQS events: ' + recovered.queueEvents,
        '  Consumer effect markers after recovery: ' + recovered.consumerEffectMarkers,
        '  Cleanup: ' + [result.baseline, result.recovery]
          .map(x => x.cleanup.filter(c => c.passed).length + '/' + x.cleanup.length).join(' | '),
        '  Synthetic SDK timeout, NOT an actual crash or AWS service outage.');
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
  if (!['copilot', 'claude', 'vscode'].includes(format))
    fail('config format: copilot (native), claude (desktop), or vscode (legacy)', 2);
  if (format === 'vscode') stderr.write('AWS Emulator MCP: config vscode uses the deprecated editor-managed servers format. For current VS Code Copilot use: config copilot (native mcpServers).\n');
  // Claude Desktop accepts an mcpServers stdio command/args entry, without the
  // Copilot-specific type property. Never edit a client config file or start
  // Docker here: the developer must review and install this output manually.
  const launch = { command: execPath, args: [fileURLToPath(import.meta.url), 'mcp'] };
  if (format !== 'claude') launch.type = 'stdio';
  const result = format === 'vscode'
    ? { servers: { 'aws-emulator-local': launch } }
    : { mcpServers: { 'aws-emulator-local': launch } };
  stdout.write(JSON.stringify(result, null, 2) + '\n');
}
function readSelectedHandler(file) {
  if (typeof file !== 'string' || file.startsWith('-') || file.length > 260 ||
      /^(https?:|file:)/i.test(file)) {
    fail('Choose a bounded local Python .py file, not a URL or option', 2);
  }
  let source, raw;
  try {
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
  return { envelope: {
    schemaVersion: 1, source,
    sourceSha256: createHash('sha256').update(raw).digest('hex')
  } };
}

function readSelectedCase(file, {includeHash = false} = {}) {
  if (typeof file !== 'string' || file.length > 260 || file.startsWith('-') ||
      /^(https?:|file:)/i.test(file) || !file.endsWith('.json')) {
    fail('Select a regular local JSON case file (max 48 KiB), never a URL', 2);
  }
  let value, raw;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 48 * 1024)
      throw Error('not a small regular file');
    raw = readFileSync(file);
    if (raw.length < 1 || raw.length > 48 * 1024)
      throw Error('case bytes changed during read');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    value = JSON.parse(decoded);
    if (!value || value.schemaVersion !== 1 || typeof value.name !== 'string' ||
        !Array.isArray(value.setup) || !Array.isArray(value.checks) ||
        !Array.isArray(value.cleanup) || !value.invoke || !value.regression)
      throw Error('not a supported application case');
  } catch {
    fail('Select a valid, bounded local application case .json file (max 48 KiB, no symlinks)', 2);
  }
  return includeHash ? {value, sha256:createHash('sha256').update(raw).digest('hex')} : value;
}

async function runSelectedAppCase(sourceEnvelope, reviewedCase) {
  const envelope = { ...sourceEnvelope, case: reviewedCase };
  const response = await runCaptured(dockerArgs('app-case'), JSON.stringify(envelope));
  let proof;
  try { proof = JSON.parse(response.raw); }
  catch { fail('Application case produced no structured sanitized evidence', 2); }
  return { code: response.code, proof };
}

async function runSelectedHandler(envelope) {
  // Only explicit local CLI commands can execute trusted source. Never MCP or
  // PR Actions. Source and its hash reach the container via stdin only.
  const result = await runCaptured(dockerArgs('app-verify'), JSON.stringify(envelope));
  let proof;
  try { proof = JSON.parse(result.raw); }
  catch { fail('Local handler returned no valid sanitized evidence', result.code || 2); }
  return { code: result.code, proof };
}

function runPythonProject(file, options) {
  return runPythonReadOnly('project_plan.py', [file, ...options]);
}

function runPythonReadOnly(scriptName, args) {
  // Source is parsed with AST, never imported. Prefer supported host Python;
  // do not silently pick a system Python 3.9 when 3.10+ is installed.
  const script = path.join(ROOT, 'src', 'aws_emulator_mcp', scriptName);
  const interpreters = process.platform === 'win32'
    ? [['py', '-3'], ['python']]
    : [['python3.12'], ['python3.11'], ['python3.10'], ['python3']];
  for (const [exe, ...prefix] of interpreters) {
    const result = spawnSync(exe, [...prefix, '-I', '-B', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 3 * 1024 * 1024,
      timeout: 30000, windowsHide: true, shell: false,
    });
    if (result.error?.code === 'ENOENT' ||
        (result.status !== 0 && result.stderr?.includes('requires Python 3.10 or newer')))
      continue;
    if (result.error || result.status === null)
      fail('Local Python analysis did not finish', 2);
    return result;
  }
  fail('Read-only Python scanning requires Python 3.10 or newer on the host', 2);
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) return help();
  if (command === 'gap-capsule') {
    if (args.length!==1) fail('Usage: aws-emulator-mcp gap-capsule <local-failed-report.json>',2);
    let result;
    try {result=createGapReproCapsule(readGapReport(args[0]));}
    catch {fail('Invalid or unsupported local app-case report; no capsule produced',2);}
    stdout.write(JSON.stringify(result,null,2)+'\n');
    return;
  }
  if (command === 'app-guide') {
    let options;
    try { options = parseAppGuideArgs(args); }
    catch { fail('Usage: aws-emulator-mcp app-guide FILE.py [CASE.json] [--json | --draft NEW.json | --draft-proof NEW.json | --run --approve TOKEN]', 2); }
    // The AST scanner never imports or executes the selected module. Its
    // stdout is parsed only, not forwarded blindly to a remote MCP client.
    const scan = runPythonReadOnly('app_case_inspect.py',
      [options.source, ...(options.caseFile ? [options.caseFile] : []), '--json']);
    if (scan.status !== 0) fail('Static Python case inspection could not verify the selected files', 2);
    let inspected;
    try { inspected = JSON.parse(scan.stdout); }
    catch { fail('Python case inspection produced invalid structured output', 2); }
    let caseData = null, selectedCaseSha256 = null, schemaValidation = null;
    if (options.caseFile) {
      const selectedCase = readSelectedCase(options.caseFile,{includeHash:true});
      caseData = selectedCase.value;
      selectedCaseSha256 = selectedCase.sha256;
      const formal = runPythonReadOnly('app_case_static_validate.py',[options.caseFile]);
      if (formal.status === 0) {
        try { schemaValidation = JSON.parse(formal.stdout); }
        catch { schemaValidation = null; }
      }
    }
    let review;
    try { review = summarizeAppGuide(inspected,caseData,{schemaValidation,selectedCaseSha256}); }
    catch { fail('Static case inspection produced unverifiable evidence', 2); }
    if (options.draft) {
      if (review.status !== 'draft_available')
        fail('Selected Python source is not eligible for a non-executable starter case', 2);
      try { writeDraftExclusive(options.draft, review.draftCase); }
      catch { fail('Could not create a NEW bounded .json draft file; existing files are never overwritten', 2); }
      const result = {...review, draftWritten:true};
      stdout.write(options.json ? JSON.stringify(result,null,2)+'\n' :
        formatAppGuide(result,{draftWritten:true}));
      return;
    }
    if (options.proofDraft) {
      if (review.status !== 'draft_available')
        fail('Selected source cannot produce a review-required proof draft; resolve static inspection gaps first', 2);
      let pair, written;
      try {
        pair = buildProofDraftPair(inspected);
        written = writeProofDraftPairExclusive(options.proofDraft,pair);
      } catch {
        fail('Cannot create proof drafts: choose ONE literal S3 PutObject, SQS SendMessage or DynamoDB PutItem; both NEW .json output paths must be available', 2);
      }
      const result = {...review, draftCase:pair.positive, expectedRedDraft:pair.expectedRed,
        proofDraftWritten:true, expectedRedDraftWritten:true,
        templateOperation:pair.operation, independentAssertion:pair.assertion,
        readyForApproval:false, approvalToken:null,
        nextStep:'Review setup, synthetic inputs, independent assertion, cleanup and BOTH case files. Resolve every REVIEW_ME placeholder, remove reviewRequired after personal review, then separately inspect each case for a source+case approval token. A healthy baseline should make the deliberately inverted expected-red case fail its named assertion.'};
      stdout.write(options.json ? JSON.stringify(result,null,2)+'\n' :
        formatAppGuide(result,{proofDraftWritten:true}));
      return;
    }
    if (!options.run) {
      stdout.write(options.json ? JSON.stringify(review,null,2)+'\n' : formatAppGuide(review));
      return;
    }
    if (!review.readyForApproval || review.approvalToken!==options.approval)
      fail('Review gaps or approval token mismatch; re-inspect both files and explicitly approve the exact source and case', 2);
    // Re-read the source and case after inspection and compare byte hashes.
    // The selected in-memory source/case, not mutable host paths, reach Docker.
    const sourceEnvelope = readSelectedHandler(options.source).envelope;
    // Hash the same exact bytes that produced the case object sent to Docker;
    // a subsequent path read could otherwise hash a different case version.
    const selectedForRun = readSelectedCase(options.caseFile,{includeHash:true});
    const validatedCase = selectedForRun.value;
    if (sourceEnvelope.sourceSha256!==review.sourceSha256 ||
        selectedForRun.sha256!==review.caseSha256 ||
        planSha256(validatedCase)!==planSha256(caseData)) {
      fail('Trusted source or case changed since inspection; re-review and reapprove', 2);
    }
    requireDocker();
    if (!imageExists()) fail('No matching local signed emulator image. Explicitly run the build command after reviewing Docker capacity, then reapprove and retry.', 2);
    const {code,proof} = await runSelectedAppCase(sourceEnvelope,validatedCase);
    let verified;
    try { verified = verifyAppCaseProof(proof,sourceEnvelope.sourceSha256,validatedCase,code); }
    catch { fail('Local Docker application evidence failed consistency verification', 2); }
    const successfulExpectedOperations = requiredOperationsSucceeded(proof,validatedCase);
    const result = {schemaVersion:1,mode:'approved_trusted_app_case',
      passed:verified.passed && successfulExpectedOperations,
      successfulExpectedOperations,
      sourceSha256:sourceEnvelope.sourceSha256,
      caseSha256:review.caseSha256, localExecutionApproved:true,
      sourceExecution:'trusted_local_opt_in', proof:verified,
      applicationBehaviorTested:true,productionAwsValidated:false,
      limitations:'One trusted developer-selected local Python entrypoint, one declarative case and independent emulator assertions. A passing single case does not prove a bug fix, whole application, IAM behavior, or production AWS parity.'};
    stdout.write(options.json ? JSON.stringify(result,null,2)+'\n' :
      ['AWS Emulator MCP / developer-approved case',
       '  '+(result.passed?'PASS':'FAIL')+'  Independent local AWS state checks',
       '  Source SHA-256: '+result.sourceSha256,
       '  Case SHA-256: '+result.caseSha256,
       '  Cleanup: '+(verified.cleanupPassed?'PASS':'FAIL'),
       '  No AWS production validation; review scoped JSON evidence via --json.',''].join('\n'));
    if (!result.passed) process.exitCode=1;
    return;
  }
  if (command === 'app-case-inspect') {
    const jsonFlag = args.includes('--json');
    let remaining = args.filter(value => value !== '--json');
    const index = remaining.indexOf('--entrypoint');
    let selectedName;
    if (index >= 0) {
      selectedName = remaining[index+1];
      remaining = remaining.filter((value, i) => i !== index && i !== index+1);
    }
    const files = remaining;
    if (files.length < 1 || files.length > 2 ||
        args.length !== files.length + Number(jsonFlag) + (index >= 0 ? 2 : 0) ||
        args.filter(value => value === '--json').length > 1 ||
        (index >= 0 && (typeof selectedName !== 'string' ||
          !/^[A-Za-z][A-Za-z_0-9]{0,63}$/.test(selectedName))) ||
        files.some(value => value.startsWith('-') || /^(https?:|file:)/i.test(value))) {
      fail('Usage: aws-emulator-mcp app-case-inspect FILE.py [CASE.json] [--entrypoint NAME] [--json]', 2);
    }
    // Host-only AST inspection: no Docker image, imports, AWS credentials,
    // application code execution or case submission to remote MCP clients.
    const report = runPythonReadOnly('app_case_inspect.py',
      [...files, ...(selectedName ? ['--entrypoint', selectedName] : []), ...(jsonFlag ? ['--json'] : [])]);
    if (report.stdout) stdout.write(report.stdout);
    if (report.stderr) stderr.write(report.stderr);
    process.exitCode = report.status;
    return;
  }
  if (command === 'project-plan') {
    const [file, ...options] = args;
    if (!file || file.startsWith('-') ||
        !(options.length === 0 || (options.length === 1 && options[0] === '--json') ||
          (options.length === 2 && options[0] === '--contract' && /^[a-z][a-z0-9-]*$/.test(options[1])))) {
      fail('Usage: aws-emulator-mcp project-plan MODULE.py|GIT_DIRECTORY [--json | --contract SERVICE]', 2);
    }
    const result = runPythonProject(file, options);
    if (result.stdout) stdout.write(result.stdout);
    if (result.stderr) stderr.write(result.stderr);
    process.exitCode = result.status;
    return;
  }
  if (command === 'project-check') {
    const [file, ...options] = args;
    if (!file || file.startsWith('-') || options.length > 3 ||
        options.some(option => !['--json', '--run', '--challenge'].includes(option)) ||
        new Set(options).size !== options.length ||
        (options.includes('--challenge') && !options.includes('--run'))) {
      fail('Usage: aws-emulator-mcp project-check MODULE.py|GIT_DIRECTORY [--run] [--challenge] [--json]', 2);
    }
    const scan = runPythonProject(file, ['--json']);
    if (scan.status !== 0) {
      if (scan.stderr) stderr.write(scan.stderr);
      fail('Could not inspect the selected local Python source', 2);
    }
    let inventory;
    try { inventory = JSON.parse(scan.stdout); }
    catch { fail('Project scan returned invalid JSON', 2); }
    const runs = [];
    if (options.includes('--run') && inventory.drafts?.length) {
      // Explicit opt-in. Use only the existing, validated contract worker.
      // No application source or host mounts enter Docker.
      requireDocker();
      if (!imageExists()) await buildImage();
      for (const draft of inventory.drafts) {
        const result = await runCaptured(dockerArgs('contract'), JSON.stringify(draft.plan));
        let proof;
        try { proof = JSON.parse(result.raw); } catch { proof = null; }
        runs.push({ code: result.code, proof });
      }
    }
    // Challenge is opt-in and runs only for passing baseline contracts. The
    // only mutation is a synthetic assertion's expected value. Both executions
    // use independent, network-disabled local emulator containers.
    let controlRuns;
    if (options.includes('--challenge')) {
      const firstPass = summarizeProjectProbes(inventory, runs);
      controlRuns = [];
      for (const [index, draft] of inventory.drafts.entries()) {
        const challenge = firstPass.probes[index].status === 'passed'
          ? buildAssertionChallenge(draft.plan) : null;
        if (!challenge) { controlRuns.push(null); continue; }
        const result = await runCaptured(dockerArgs('contract'), JSON.stringify(challenge.plan));
        let proof;
        try { proof = JSON.parse(result.raw); } catch { proof = null; }
        controlRuns.push({ code: result.code, proof });
      }
    }
    let report;
    try { report = summarizeProjectProbes(inventory, runs, controlRuns); }
    catch { fail('Project check could not verify the scan or probe evidence', 2); }
    stdout.write(options.includes('--json') ? JSON.stringify(report, null, 2) + '\n'
      : formatProjectCheck(report));
    // A successfully completed synthetic probe is not a passing app test.
    // Exit nonzero for untested calls, failed probes or review gaps after --run.
    if (options.includes('--run') && !['api_probes_passed', 'assertion_challenges_passed'].includes(report.status))
      process.exitCode = 1;
    return;
  }
  if (command === 'onboard') {
    let selected;
    try { selected = parseOnboardArgs(args); }
    catch { fail('Usage: aws-emulator-mcp onboard [--offline] [--json]', 2); }
    const report = runOnboarding({offlineOnly:selected.offline, image:IMAGE,
      fromCheckout: path.resolve(process.cwd()) === ROOT &&
        !ROOT.split(path.sep).includes('node_modules'),
      expectedImageDigest:() => imageSourceDigest(ROOT)});
    stdout.write(selected.json ? JSON.stringify(report, null, 2) + '\n'
      : formatOnboarding(report));
    if (!report.passed) process.exitCode = 1;
    return;
  }
  if (command === 'try') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--json'))
      fail('Usage: aws-emulator-mcp try [--json]', 2);
    let report;
    try { report = runOfflineTrial(); }
    catch { fail('Offline installation test failed; inspect architecture demo and package files', 1); }
    stdout.write(args.includes('--json') ? JSON.stringify(report, null, 2) + '\n'
      : formatOfflineTrial(report) + '\n');
    return;
  }

  if (command === 'official-session') {
    let parsed;
    try { parsed = parseOfficialSessionArgs(args); }
    catch { fail('Usage: aws-emulator-mcp official-session [--port 9297] [--identity] [--json]', 2); }
    const report = await inspectOfficialSession(parsed);
    stdout.write(parsed.json ? JSON.stringify(report, null, 2) + '\n'
      : formatOfficialSession(report) + '\n');
    if (!report.localHealthPassed || (parsed.identity && !report.accountIdentityVerified)) process.exitCode = 1;
    return;
  }
  if (command === 'connect-check') {
    if (args.length > 1 || (args.length===1 && args[0]!=='--json'))
      fail('Usage: aws-emulator-mcp connect-check [--json]', 2);
    const fromCheckout=path.resolve(process.cwd())===ROOT &&
      !ROOT.split(path.sep).includes('node_modules');
    // Use one exact Docker-copy fingerprint for preflight and the pinned-ID check.
    // If a source file cannot be fingerprinted, both checks fail closed.
    let expectedImageDigest=null;
    try {expectedImageDigest=imageSourceDigest(ROOT);} catch { /* incomplete bundle */ }
    const readiness=inspectPreflight({image:IMAGE,
      expectedImageDigest:()=>expectedImageDigest});
    const report=inspectMcpConnection({readiness,expectedImageDigest,fromCheckout});
    stdout.write(args[0]==='--json' ? JSON.stringify(report,null,2)+'\n'
      : formatMcpConnection(report));
    if (!report.passed) process.exitCode=1;
    return;
  }
  if (command === 'preflight') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--json'))
      fail('Usage: aws-emulator-mcp preflight [--json]', 2);
    const report = inspectPreflight({image: IMAGE, expectedImageDigest: () => imageSourceDigest(ROOT)});
    if (args.includes('--json')) stdout.write(JSON.stringify(report, null, 2) + '\n');
    else stdout.write(printPreflight(report) + '\n');
    if (!report.emulatorReady) process.exitCode = 1;
    return;
  }
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
    const challengeRequested = args.includes('--challenge');
    const rest = args.filter(x => x !== '--json' && x !== '--challenge');
    if (rest.length !== 1 || args.length > 3 ||
        args.filter(x => x === '--json').length > 1 ||
        args.filter(x => x === '--challenge').length > 1 || rest[0].startsWith('-') ||
        /^(https?:|file:)/i.test(rest[0])) {
      fail('Usage: aws-emulator-mcp contract demo|fault-demo|<local-plan.json> [--json] [--challenge]', 2);
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
    if (challengeRequested) {
      const original = { code: result.code, proof };
      const candidate = buildAssertionChallenge(plan);
      // No second Docker run after failed/invalid baseline evidence or when
      // the contract contains no equality assertion to mutate.
      const preliminary = assessContractChallenge(plan, original, null);
      let control = null;
      if (candidate && preliminary.status === 'not_run') {
        const attempted = await runCaptured(dockerArgs('contract'), JSON.stringify(candidate.plan));
        let observed;
        try { observed = JSON.parse(attempted.raw); } catch { observed = null; }
        control = { code: attempted.code, proof: observed };
      }
      const assessment = assessContractChallenge(plan, original, control);
      const verified = assessment.status === 'detected';
      const report = { schemaVersion: 1, mode: 'assertion_challenge',
        baseline: proof, assertionChallenge: assessment, passed: verified,
        applicationFixVerified: false, productionAwsValidated: false,
        scope: 'One equality assertion negative control of an isolated local AWS SDK contract; no application execution or AWS parity.' };
      if (wantsJson) stdout.write(JSON.stringify(report, null, 2) + '\n');
      else {
        renderReport('contract', proof);
        stdout.write('  Assertion negative control: ' + assessment.status.toUpperCase() +
          (assessment.stepId ? ' at ' + assessment.stepId + '.' + assessment.path : '') + '\n' +
          '  This does not verify application source or AWS parity.\n');
      }
      if (!verified) fail('Assertion challenge did not establish expected mismatch detection', 1);
      return;
    }
    if (wantsJson) stdout.write(JSON.stringify(proof, null, 2) + '\n');
    else renderReport('contract', proof);
    if (result.code !== 0 || !proof.passed)
      fail('One or more contract assertions failed', result.code || 1);
    return;
  }
  if (command === 'failure-lab') {
    const jsonFlag = args.includes('--json');
    const rest = args.filter(x => x !== '--json');
    const modes = ['compare', 'fragile-before-send', 'recover-before-send', 'recover-lost-ack',
      'partial-compare', 'fragile-before-receipt', 'recover-before-receipt'];
    if (args.length > 2 || rest.length > 1 ||
        args.filter(x => x === '--json').length > 1 ||
        (rest.length && !modes.includes(rest[0]))) {
      fail('Usage: aws-emulator-mcp failure-lab [compare|partial-compare|reviewed-scenario] [--json]', 2);
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
  if (command === 'app-compare') {
    const format = args[2] || '';
    if (args.length < 2 || args.length > 3 ||
        (format && !['--json', '--markdown'].includes(format))) {
      fail('Usage: aws-emulator-mcp app-compare <before.py> <after.py> [--json|--markdown]', 2);
    }
    // Validate *both* trusted local inputs before starting any container.
    const beforeInput = readSelectedHandler(args[0]);
    const afterInput = readSelectedHandler(args[1]);
    if (beforeInput.envelope.sourceSha256 === afterInput.envelope.sourceSha256) {
      fail('Before and after source hashes are identical; comparison refused', 2);
    }
    requireDocker();
    if (!imageExists()) await buildImage();
    const before = await runSelectedHandler(beforeInput.envelope);
    const after = await runSelectedHandler(afterInput.envelope);
    let report;
    try {
      report = compareHandlerEvidence(
        before.proof, beforeInput.envelope.sourceSha256, before.code,
        after.proof, afterInput.envelope.sourceSha256, after.code);
    } catch {
      fail('Comparison could not verify both isolated handler results', 2);
    }
    if (format === '--json') stdout.write(JSON.stringify(report, null, 2) + '\n');
    else if (format === '--markdown') stdout.write(comparisonMarkdown(report));
    else renderReport('app-compare', report);
    if (!report.passed) fail('Could not reproduce expected duplicate and verify fix', 1);
    return;
  }
  if (command === 'app-case' || command === 'app-case-compare') {
    const wantsCompare = command === 'app-case-compare';
    const wantsJson = args.includes('--json');
    const wantsMarkdown = args.includes('--markdown');
    const files = args.filter(x => x !== '--json' && x !== '--markdown');
    const expectedCount = wantsCompare ? 3 : 2;
    if (files.length !== expectedCount || args.length > expectedCount + 1 ||
        (wantsJson && wantsMarkdown) || (wantsMarkdown && !wantsCompare) ||
        args.filter(x=>x==='--json').length > 1 ||
        args.filter(x=>x==='--markdown').length > 1) {
      fail('Usage: aws-emulator-mcp app-case APP.py CASE.json [--json] | app-case-compare BEFORE.py AFTER.py CASE.json [--json|--markdown]', 2);
    }
    const reviewed = readSelectedCase(files[expectedCount-1]);
    const left = readSelectedHandler(files[0]).envelope;
    const right = wantsCompare ? readSelectedHandler(files[1]).envelope : null;
    if (wantsCompare && left.sourceSha256 === right.sourceSha256)
      fail('Before and after must be distinct source revisions', 2);
    requireDocker();
    if (!imageExists()) await buildImage();
    const before = await runSelectedAppCase(left, reviewed);
    if (!wantsCompare) {
      try { verifyAppCaseProof(before.proof,left.sourceSha256,reviewed,before.code); }
      catch { fail('Application case returned unverifiable or incomplete evidence', 2); }
      if (wantsJson) stdout.write(JSON.stringify(before.proof,null,2)+'\n');
      else renderReport('app-case',before.proof);
      if (!before.proof.passed) fail('Application invariant or cleanup failed', 1);
      return;
    }
    const after = await runSelectedAppCase(right, reviewed);
    let result;
    try {
      result = compareAppCaseEvidence(before.proof,left.sourceSha256,before.code,
                                      after.proof,right.sourceSha256,after.code,reviewed);
    } catch { fail('Before/after evidence could not be verified or compared', 2); }
    if (wantsJson) stdout.write(JSON.stringify(result,null,2)+'\n');
    else if (wantsMarkdown) stdout.write(appCaseMarkdown(result));
    else renderReport('app-case-compare',result);
    if (!result.passed) fail('Expected regression not reproduced or app fix not verified', 1);
    return;
  }
  if (command === 'app-verify') {
    const wantsJson = args.includes('--json');
    const rest = args.filter(x => x !== '--json');
    if (rest.length !== 1 || args.length > 2 ||
        args.filter(x => x === '--json').length > 1) {
      fail('Usage: aws-emulator-mcp app-verify <trusted-local-handler.py> [--json]', 2);
    }
    const { envelope } = readSelectedHandler(rest[0]);
    requireDocker();
    if (!imageExists()) await buildImage();
    const { code, proof } = await runSelectedHandler(envelope);
    if (wantsJson) stdout.write(JSON.stringify(proof, null, 2) + '\n');
    else renderReport('app-verify', proof);
    if (code !== 0 || !proof.passed)
      fail('Trusted local handler failed synthetic assertions or cleanup', code || 1);
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
