import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSha256, summarizeProjectProbes, formatProjectCheck,
  buildAssertionChallenge } from '../scripts/project_check.mjs';

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

function assertedFailure(plan, target) {
  const last = target.stepIndex;
  const sample = proof(plan, -1);
  sample.steps = sample.steps.slice(0, last + 1);
  const failed = sample.steps[last];
  failed.passed = false;
  failed.assertions[target.assertionIndex].passed = false;
  sample.passedSteps = last;
  sample.passed = false;
  return { code: 1, proof: sample };
}

test('challenge changes one expectation, never an operation or request argument', () => {
  for (const filename of ['s3-write-read.json', 'sqs-consume.json',
    'dynamodb-put-get.json', 'ec2-vpc.json']) {
    const before = JSON.parse(readFileSync(path.join(ROOT, 'examples/contracts', filename)));
    const unchanged = structuredClone(before);
    const generated = buildAssertionChallenge(before);
    assert.ok(generated, filename);
    assert.deepEqual(before, unchanged);
    assert.notEqual(planSha256(before), planSha256(generated.plan));
    const restored = structuredClone(generated.plan);
    restored.steps[generated.stepIndex].expect.assertions[generated.assertionIndex].equals =
      before.steps[generated.stepIndex].expect.assertions[generated.assertionIndex].equals;
    assert.deepEqual(restored, before, `${filename}: mutation must be expectation-only`);
  }
  assert.equal(buildAssertionChallenge({steps:[{id:'a', expect:{assertions:[{path:'A', exists:true}]}}]}), null);
});

test('challenge reports detected on exact failed assertion in fresh emulator evidence', () => {
  const inv = fixture();
  const baseline = {code:0,proof:proof(sqs)};
  const mutation = buildAssertionChallenge(sqs);
  const negative = assertedFailure(mutation.plan, mutation);
  const report = summarizeProjectProbes(inv,[baseline],[negative]);
  assert.equal(report.mode,'assertion_challenge');
  assert.equal(report.summary.challengesDetected,1);
  assert.equal(report.summary.challengesUnverified,0);
  assert.equal(report.probes[0].assertionChallenge.status,'detected');
  assert.equal(report.probes[0].assertionChallenge.stepId,mutation.stepId);
  assert.equal(report.applicationFixVerified,false);
  assert.equal(report.status,'incomplete'); // unmatched SDK method and argument gaps
  assert.match(formatProjectCheck(report),/Assertion challenge: detected/);
});

test('challenge rejects mismatched versions, failures at wrong steps and forged results', () => {
  const baseline = {code:0,proof:proof(sqs)};
  const mutation = buildAssertionChallenge(sqs);
  const valid = assertedFailure(mutation.plan,mutation);
  const invalid = [];
  const wrongVersion = structuredClone(valid);
  wrongVersion.proof.emulatorVersion = 'Version: 0.0.0';
  invalid.push(wrongVersion);
  const corruptedHash = structuredClone(valid);
  corruptedHash.proof.planSha256 = 'f'.repeat(64);
  invalid.push(corruptedHash);
  const unrelated = structuredClone(valid);
  unrelated.proof.steps[mutation.stepIndex].observed='local_error';
  unrelated.proof.steps[mutation.stepIndex].assertions=[];
  invalid.push(unrelated);
  const errorEarlier = {code:1,proof:proof(mutation.plan,0)};
  invalid.push(errorEarlier);
  const wrongAssert = structuredClone(valid);
  wrongAssert.proof.steps[mutation.stepIndex].assertions[mutation.assertionIndex].passed = true;
  invalid.push(wrongAssert);
  for (const bad of invalid) {
    const report=summarizeProjectProbes(fixture(),[baseline],[bad]);
    assert.notEqual(report.probes[0].assertionChallenge.status,'detected');
    assert.notEqual(report.status,'assertion_challenges_passed');
  }
  const notRun = summarizeProjectProbes(fixture(),[baseline],[]);
  assert.equal(notRun.probes[0].assertionChallenge.status,'not_run');
  const noBaseline = summarizeProjectProbes(fixture(),[],[valid]);
  assert.equal(noBaseline.probes[0].assertionChallenge.status,'baseline_not_passed');
});

test('challenge can yield fully confirmed API probe status without claiming app behavior', () => {
  const inv = fixture();
  inv.calls = [inv.calls[0]];
  inv.calls[0].keywordNames = ['QueueUrl','MessageBody'];
  inv.drafts[0].argumentGaps=[];
  inv.unmatchedMethods=[];
  const mutation = buildAssertionChallenge(sqs);
  const report = summarizeProjectProbes(inv,[{code:0,proof:proof(sqs)}],[assertedFailure(mutation.plan,mutation)]);
  assert.equal(report.status,'assertion_challenges_passed');
  assert.equal(report.applicationFixVerified,false);
  assert.equal(report.probes[0].assertionChallenge.status,'detected');
  const noChallenge = summarizeProjectProbes(inv,[{code:0,proof:proof(sqs)}],[{code:0,proof:proof(mutation.plan)}]);
  assert.notEqual(noChallenge.status,'assertion_challenges_passed');
});

test('challenge opt-in requires --run and rejects duplicate flags before Docker', () => {
  for (const args of [
    ['project-check','file.py','--challenge'],
    ['project-check','file.py','--challenge','--json'],
    ['project-check','file.py','--run','--challenge','--challenge'],
    ['project-check','file.py','--run','--shell'],
  ]) {
    const outcome=spawnSync(process.execPath,[CLI,...args],{encoding:'utf8',timeout:10000});
    assert.equal(outcome.status,2,args.join(' '));
    assert.equal(outcome.stdout,'');
  }
  const help=spawnSync(process.execPath,[CLI,'help'],{encoding:'utf8'});
  assert.match(help.stdout,/--challenge/);
});
