import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSha256, summarizeProjectProbes, formatProjectCheck } from '../scripts/project_check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'aws-emulator-mcp.mjs');
const sqs = JSON.parse(readFileSync(path.join(ROOT, 'examples/contracts/sqs-consume.json')));
const fixture = () => ({
  schemaVersion: 1, executed: false,
  calls: [
    { file: 'handler.py', line: 5, method: 'sqs.send_message', keywordNames: ['MessageBody', 'QueueUrl', 'DelaySeconds'] },
    { file: 'handler.py', line: 6, method: 'lambda.invoke', keywordNames: [], hasUnresolvedArguments: true },
  ],
  analyzedFiles: [{ file: 'handler.py', sha256: 'a'.repeat(64) }], skippedFiles: [],
  unmatchedMethods: ['lambda.invoke'],
  drafts: [{
    service: 'sqs', plan: sqs, matchedMethods: ['sqs.send_message'],
    argumentGaps: [{ file: 'handler.py', line: 5, method: 'sqs.send_message',
      unexercisedKeywords: ['DelaySeconds'], unresolvedArguments: false }],
  }],
});

function proof(plan, untilFailure = -1) {
  const steps = plan.steps.slice(0, untilFailure >= 0 ? untilFailure + 1 : plan.steps.length)
    .map((step, index) => ({
      id: step.id, service: step.service, operation: step.operation,
      passed: index !== untilFailure,
      observed: index === untilFailure ? 'local_error' : 'success',
      assertions: index === untilFailure ? [] : (step.expect?.assertions || [])
        .map(a => ({ path: a.path, passed: true })),
      ...(index === untilFailure ? { errorType: 'TestMismatch' }
        : { responseSha256: 'b'.repeat(64) }),
    }));
  const passedSteps = steps.filter(x => x.passed).length;
  return { schemaVersion: 1, name: plan.name, emulatorVersion: 'Version: 1.0.385',
    accountVerified: true, planSha256: planSha256(plan), totalSteps: plan.steps.length,
    passedSteps, passed: untilFailure === -1, steps };
}

test('preview gives honest statuses without Docker or application code execution', () => {
  const report = summarizeProjectProbes(fixture());
  assert.equal(report.mode, 'static_inventory');
  assert.equal(report.applicationFixVerified, false);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.summary.untested, 2);
  assert.equal(report.callSites[0].status, 'not_run');
  assert.equal(report.callSites[1].status, 'not_covered');
  assert.match(formatProjectCheck(report), /APP FIX NOT VERIFIED/);
});

test('passing synthetic SDK probe does not claim application or value coverage', () => {
  const f = fixture();
  const run = { code: 0, proof: proof(sqs) };
  const report = summarizeProjectProbes(f, [run]);
  assert.equal(report.summary.apiProbePassed, 1);
  assert.equal(report.summary.untested, 1);
  assert.equal(report.summary.argumentReviewNeeded, 1);
  assert.equal(report.callSites[0].status, 'api_probe_passed');
  assert.equal(report.callSites[0].applicationBehaviorTested, false);
  assert.deepEqual(report.callSites[0].unexercisedKeywords, ['DelaySeconds']);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.applicationFixVerified, false);
});

test('failure at a matched operation differs from a later operation not reached', () => {
  const sendError = summarizeProjectProbes(fixture(), [{ code: 1, proof: proof(sqs, 1) }]);
  assert.equal(sendError.callSites[0].status, 'api_probe_failed');
  assert.equal(sendError.status, 'api_probe_failed');
  const createError = summarizeProjectProbes(fixture(), [{ code: 1, proof: proof(sqs, 0) }]);
  assert.equal(createError.callSites[0].status, 'not_reached');
  assert.equal(createError.summary.failedContracts, 1);
});

test('rejects stale, forged, malformed, and contradictory probe records', () => {
  const base = { code: 0, proof: proof(sqs) };
  for (const mutate of [
    p => { p.planSha256 = '0'.repeat(64); },
    p => { p.accountVerified = false; },
    p => { p.passedSteps = 0; },
    p => { p.steps[0].id = 'other'; },
    p => { p.steps[1].assertions[0].passed = false; },
    p => { p.steps[1].responseSha256 = 'not-a-hash'; },
    p => { p.steps.pop(); },
  ]) {
    const bad = structuredClone(base);
    mutate(bad.proof);
    const result = summarizeProjectProbes(fixture(), [bad]);
    assert.equal(result.probes[0].status, 'invalid_evidence');
    assert.equal(result.callSites[0].status, 'invalid_evidence');
    assert.equal(result.summary.apiProbePassed, 0);
  }
  const mismatchedExit = summarizeProjectProbes(fixture(), [{ code: 1, proof: proof(sqs) }]);
  assert.equal(mismatchedExit.probes[0].status, 'invalid_evidence');
});

test('plan SHA-256 matches Python contract canonical JSON encoding', () => {
  const source = JSON.stringify(sqs);
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(sqs)
    .sort(([a],[b]) => a.localeCompare(b)).map(([k, v]) => [k,v])));
  assert.match(planSha256(sqs), /^[a-f0-9]{64}$/);
  assert.notEqual(planSha256(sqs), createHash('sha256').update(source).digest('hex'));
  assert.notEqual(planSha256(sqs), createHash('sha256').update(canonical).digest('hex'));
  assert.equal(planSha256(sqs), '2268734922e77c7ed1b65c6ef0631b182bddc9aa3d8ed778cef6493eb710b71c');
});

test('project-check local CLI scans but does not run untrusted Python source', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aws-mcp-check-'));
  try {
    const file = path.join(dir, 'handler.py');
    writeFileSync(file, 'import boto3\nraise Exception("TOP_SECRET_DO_NOT_PRINT")\n'
      + 'q = boto3.client("sqs")\nq.send_message(QueueUrl="PRIVATE", MessageBody="SECRET_VALUE")\n');
    const result = spawnSync(process.execPath, [CLI, 'project-check', file, '--json'], {
      encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.callSites, 1);
    assert.equal(report.callSites[0].method, 'sqs.send_message');
    assert.equal(report.callSites[0].status, 'not_run');
    assert.equal(report.sourceExecution, false);
    assert.doesNotMatch(result.stdout, /TOP_SECRET|SECRET_VALUE|PRIVATE/);
    const remote = spawnSync(process.execPath, [CLI, 'project-check', file, '--run', '--json'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, DOCKER_HOST: 'tcp://192.0.2.15:2375' },
    });
    assert.equal(remote.status, 1);
    assert.match(remote.stderr, /Refusing nonlocal DOCKER_HOST/);
    assert.equal(remote.stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no false green for no direct calls or missing operations', () => {
  const empty = fixture();
  empty.calls = [];
  empty.drafts = [];
  empty.unmatchedMethods = [];
  assert.equal(summarizeProjectProbes(empty).status, 'incomplete');
  const invalid = fixture();
  invalid.calls = Array(257).fill(invalid.calls[0]);
  assert.throws(() => summarizeProjectProbes(invalid), /Invalid or oversized/);
  const bad = spawnSync(process.execPath, [CLI, 'project-check', '--run'], {encoding:'utf8'});
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
});
