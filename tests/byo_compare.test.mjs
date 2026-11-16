import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { compareHandlerEvidence, comparisonMarkdown } from '../scripts/byo_compare.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/aws-emulator-mcp.mjs');
const BEFORE = 'a'.repeat(64), AFTER = 'b'.repeat(64);
function proof(sha, {broken = false, cleanup = true} = {}) {
  const names = [
    'first submission accepted', 'duplicate retry rejected',
    'exactly one accepted submission', 'exactly one SQS fulfillment event',
    'event body matches logical order', 'DynamoDB row matches submitted order',
    'typed tenant, customer, currency and totals match', 'S3 receipt matches submitted order'
  ];
  return {
    schemaVersion: 1, case: 'local-order-handler', passed: !broken && cleanup,
    accountVerified: true, sourceSha256: sha, emulatorVersion: '1.0.385',
    observed: {
      acceptedSubmissions: broken ? 2 : 1,
      queueEvents: broken ? 2 : 1,
      duplicateSuppressed: !broken,
      dbOrderPresent: true, businessFieldsMatch: true, receiptMatches: true,
    },
    assertions: names.map((name, index) => ({
      name, passed: !broken || ![1, 2, 3].includes(index)
    })),
    cleanup: Array.from({length: 7}, (_, i) => ({
      name: 'cleanup step ' + i, passed: cleanup
    })),
    error: broken ? 'A duplicate-order invariant failed' : null,
  };
}
function compare(a = proof(BEFORE, { broken: true }), b = proof(AFTER), ac = 1, bc = 0) {
  return compareHandlerEvidence(a, BEFORE, ac, b, AFTER, bc);
}
function cli(...args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 12000 });
}

test('before/after evidence proves only a real observed duplicate corrected on isolated emulator', () => {
  const result = compare();
  assert.equal(result.passed, true);
  assert.equal(result.bugReproduced, true);
  assert.equal(result.fixVerified, true);
  assert.equal(result.before.observed.queueEvents, 2);
  assert.equal(result.after.observed.queueEvents, 1);
  assert.equal(result.before.sourceSha256, BEFORE);
  assert.equal(result.after.sourceSha256, AFTER);
  const text = comparisonMarkdown(result);
  assert.match(text, /2 \| 1/);
  assert.match(text, /Resource cleanup \| PASS \| PASS/);
  assert.doesNotMatch(text, /order\.py|source code|SECRET/i);
});

test('a merely failing baseline never counts as reproduction', () => {
  for (const mutate of [
    p => { p.observed.queueEvents = 0; },
    p => { p.observed.acceptedSubmissions = 1; },
    p => { p.observed.dbOrderPresent = false; },
    p => { p.observed.businessFieldsMatch = false; },
    p => { p.observed.receiptMatches = false; },
    p => { p.assertions[0].passed = false; },
  ]) {
    const before = proof(BEFORE, {broken: true});
    mutate(before);
    assert.equal(compare(before).passed, false);
  }
  assert.equal(compare(proof(BEFORE), proof(AFTER), 0, 0).passed, false);
  assert.equal(compare(proof(BEFORE, {broken: true}), proof(AFTER), 2, 0).passed, false);
});

test('false green is refused when the alleged fix has bugs, missing checks or failed cleanup', () => {
  assert.equal(compare(proof(BEFORE, {broken: true}), proof(AFTER, {broken:true}),1,1).passed, false);
  assert.equal(compare(proof(BEFORE, {broken: true, cleanup:false})).passed, false);
  assert.equal(compare(proof(BEFORE, {broken: true}), proof(AFTER, {cleanup:false})).passed, false);
  const after = proof(AFTER);
  after.assertions[2].passed = false;
  assert.equal(compare(proof(BEFORE, {broken:true}), after).passed, false);
});

test('forged hashes, mismatched versions and incomplete proof fail closed', () => {
  assert.throws(() => compareHandlerEvidence(proof(BEFORE), BEFORE, 0,
    proof(BEFORE), BEFORE, 0), /distinct/);
  assert.throws(() => compare({...proof(BEFORE, {broken:true}), sourceSha256:'f'.repeat(64)}), /unverifiable/);
  assert.throws(() => compare({...proof(BEFORE, {broken:true}), accountVerified:false}), /unverifiable/);
  assert.throws(() => compare({...proof(BEFORE, {broken:true}), cleanup:[]}), /unverifiable/);
  assert.throws(() => compare(proof(BEFORE, {broken:true}), {...proof(AFTER), emulatorVersion:'different'}), /different/);
  assert.throws(() => compare(proof(BEFORE, {broken:true}), {...proof(AFTER), observed:{}}), /outcomes/);
});

test('untrusted paths and same source are refused before Docker', () => {
  assert.equal(cli('app-compare').status, 2);
  assert.equal(cli('app-compare', 'foo.py').status, 2);
  assert.equal(cli('app-compare', 'https://example.org/code.py', 'after.py').status, 2);
  assert.equal(cli('app-compare', 'file:///etc/source.py', 'after.py').status, 2);
  assert.equal(cli('app-compare', 'before.py', '--shell').status, 2);
  assert.equal(cli('app-compare', 'before.py', 'after.py', '--json', '--markdown').status, 2);
  const dir = mkdtempSync(path.join(tmpdir(), 'byo-compare-'));
  try {
    const a = path.join(dir, 'before.py');
    const b = path.join(dir, 'after.py');
    writeFileSync(a, 'def submit_order(): pass\n');
    writeFileSync(b, 'def submit_order(): pass\n');
    const identical = cli('app-compare', a, b, '--json');
    assert.equal(identical.status, 2);
    assert.match(identical.stderr, /identical/);
    assert.equal(identical.stdout, '');
    writeFileSync(b, 'def submit_order(): return True\n');
    const remote = spawnSync(process.execPath, [BIN, 'app-compare', a, b, '--json'], {
      encoding:'utf8', timeout: 12000,
      env: {...process.env, DOCKER_HOST:'tcp://198.51.100.9:2375'}
    });
    assert.equal(remote.status, 1);
    assert.match(remote.stderr, /Refusing nonlocal DOCKER_HOST/);
    assert.equal(remote.stdout, '');
    if (process.platform !== 'win32') {
      const link = path.join(dir, 'symlink.py');
      symlinkSync(a, link);
      assert.equal(cli('app-compare', link, b).status, 2);
    }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
