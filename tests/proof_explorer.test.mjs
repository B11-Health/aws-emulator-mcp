import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateEvidence} from '../docs/proof-explorer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(ROOT,name), 'utf8');
const snapshots = [
  'docs/evidence/app-case-aws-emulator-1.0.506.json',
  'docs/evidence/app-case-s3-aws-emulator-1.0.506.json'
];
const load = name => JSON.parse(read(name));

test('both recorded application cases contain internally consistent red/green and cleanup proof', () => {
  for (const file of snapshots) {
    const data = load(file);
    const checked = validateEvidence(data);
    assert.equal(checked.ok, true, file + ': ' + checked.reason);
    assert.equal(checked.beforeAssertions.filter(x => !x.passed).length, 1);
    assert.equal(checked.afterAssertions.filter(x => !x.passed).length, 0);
    assert.equal(data.comparison.productionAwsValidated, false);
    assert.notEqual(data.comparison.before.sourceSha256, data.comparison.after.sourceSha256);
    assert.equal(data.comparison.before.emulatorVersion, data.comparison.after.emulatorVersion);
    assert.equal(data.comparison.before.cleanupPassed, true);
    assert.equal(data.comparison.after.cleanupPassed, true);
  }
});

test('reader refuses contradictory source, named regression, cleanup or AWS parity evidence', () => {
  const source = load(snapshots[0]);
  for (const mutate of [
    d => { d.comparison.before.cleanupPassed = false; },
    d => { d.comparison.before.sourceSha256 = d.comparison.after.sourceSha256; },
    d => { d.comparison.regression.path = 'Unrelated'; },
    d => { d.comparison.productionAwsValidated = true; },
    d => { d.comparison.after.checks[1].assertions[1].passed = false; },
    d => { d.comparison.before.sdkCalls[0].successes = 999; },
    d => { d.before.caseSha256 = '0'.repeat(64); },
  ]) {
    const altered = structuredClone(source);
    mutate(altered);
    assert.equal(validateEvidence(altered).ok, false, 'tampered proof must not render as success');
  }
});

test('raw teardown failures cannot hide behind green comparison cleanup summaries', () => {
  const original = load(snapshots[0]); // SQS includes full raw per-SDK-step evidence.
  assert.equal(validateEvidence(original).ok, true);
  for (const mutate of [
    d => { d.before.cleanup[0].passed = false; },
    d => { d.after.cleanup[1].passed = false; },
    d => { d.after.cleanup[0].observed = 'api_error'; },
    d => { d.before.cleanup[0].responseSha256 = 'invalid'; },
    d => { d.after.cleanup.pop(); },
    d => { d.comparison.after.cleanup[0].id = 'unrelated-resource'; },
  ]) {
    const altered = structuredClone(original);
    mutate(altered);
    const checked = validateEvidence(altered);
    assert.equal(checked.ok, false, 'raw or summarized teardown mismatch must fail closed');
    assert.match(checked.reason, /Saved run summaries disagree/);
  }
  // The S3 reference intentionally publishes only a sanitized comparison.
  // This correction must not require unavailable raw SDK records for that case.
  assert.equal(validateEvidence(load(snapshots[1])).ok, true);
});

test('SQS recorded proof cannot silently drop both raw cleanup histories', () => {
  const original=load(snapshots[0]);
  for (const remove of ['before','after','both']) {
    const changed=structuredClone(original);
    if (remove!=='after') delete changed.before;
    if (remove!=='before') delete changed.after;
    const outcome=validateEvidence(changed);
    assert.equal(outcome.ok,false,'missing '+remove+' raw history must not pass');
    assert.match(outcome.reason,/missing required raw cleanup evidence/);
  }
  // The S3 snapshot was recorded with only a sanitized comparison and remains valid.
  assert.equal(validateEvidence(load(snapshots[1])).ok,true);
});

test('webpage is accessible, fixed-source, and does not pretend to run live AWS', () => {
  const html = read('docs/proof-explorer.html');
  const js = read('docs/proof-explorer.js');
  const css = read('docs/proof-explorer.css');
  for (const token of ['lang="en"','href="#main"','aria-live="polite"',
                       '<label for="scenario">','id="record" hidden',
                       'type="module" src="proof-explorer.js"',
                       'Not a live emulator','production parity','app-case-compare','try --json']) {
    assert.ok(html.includes(token), 'missing product claim / accessibility token: '+token);
  }
  assert.match(css,/prefers-reduced-motion/);
  assert.match(js,/Object\.freeze/);
  assert.match(js,/textContent/);
  assert.doesNotMatch(js,/innerHTML/);
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1];
    if (target.startsWith('#') || /^https?:/.test(target)) continue;
    assert.ok(fs.existsSync(path.join(ROOT,'docs',target)), 'broken first-party web asset: '+target);
  }
});

test('public proof path points to docs and uses a master-only application command', () => {
  const recipe = read('docs/PROOF_WORKFLOW.md');
  for (const phrase of ['--branch master','try --json','app-case-inspect','app-case-compare',
                        'receive.Messages.1','HeadObject.ContentLength','v0.4.0-beta.15',
                        'Docker does **not**','productionAwsValidated']) {
    assert.ok(recipe.includes(phrase), 'missing workflow element: '+phrase);
  }
  assert.match(read('docs/index.html'), /href="proof-explorer\.html"/);
  assert.match(read('README.md'), /docs\/PROOF_WORKFLOW\.md/);
});
