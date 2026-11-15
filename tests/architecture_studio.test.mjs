import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArchitectureError, validateArchitecture, generateArchitecture, generateTemplate,
  generateContract, generateYaml, generateDrawio, generateSvg,
  readManifest, writeArchitecture, executeArchitecture
} from '../scripts/architecture_studio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = JSON.parse(readFileSync(path.join(ROOT, 'examples/architecture/order-intake.json'), 'utf8'));
const reference = path.join(ROOT, 'examples/architecture/reference');
const sha = value => createHash('sha256').update(value).digest('hex');

function workspace(fn) {
  const home = mkdtempSync(path.join(tmpdir(), 'aws-arch-studio-'));
  try { return fn(home); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

test('demo manifest compiles deterministic CloudFormation, diagram, and synthetic contract', () => {
  const first = generateArchitecture(DEMO);
  const second = generateArchitecture(JSON.parse(JSON.stringify(DEMO)));
  assert.deepEqual(first.files, second.files);
  assert.equal(first.report.validated.awsDeployment, false);
  assert.equal(first.report.validated.emulatorContractExecuted, false);
  assert.equal(first.report.validated.graphNodes, 3);
  assert.deepEqual(Object.keys(first.template.Resources),
    ['ReceiptsBucket', 'OrdersTable', 'FulfillmentQueue']);
  assert.deepEqual(first.template.Resources.ReceiptsBucket.Properties.PublicAccessBlockConfiguration,
    { BlockPublicAcls: true, BlockPublicPolicy: true,
      IgnorePublicAcls: true, RestrictPublicBuckets: true });
  assert.equal(first.template.Resources.ReceiptsBucket.DeletionPolicy, 'Retain');
  assert.equal(first.template.Resources.OrdersTable.DeletionPolicy, 'Retain');
  assert.equal(first.template.Resources.OrdersTable.Properties.BillingMode, 'PAY_PER_REQUEST');
  assert.equal(first.template.Resources.OrdersTable.Properties.SSESpecification.SSEEnabled, true);
  assert.equal(first.template.Resources.FulfillmentQueue.Properties.SqsManagedSseEnabled, true);
  assert.deepEqual(first.template.Outputs.FulfillmentQueueUrl.Value,
    { Ref: 'FulfillmentQueue' });
  assert.deepEqual(Object.values(first.template.Resources).map(r => r.Type),
    ['AWS::S3::Bucket', 'AWS::DynamoDB::Table', 'AWS::SQS::Queue']);
  assert.equal(first.contract.steps.length, 14);
  assert.deepEqual(new Set(first.contract.steps.map(s => s.service)),
    new Set(['s3', 'dynamodb', 'sqs']));
  assert.ok(first.contract.steps.every(s => !s.fault && !('credentials' in s)));
  assert.match(first.files['template.yaml'], /AWSTemplateFormatVersion: "2010-09-09"/);
  assert.doesNotMatch(first.files['template.yaml'], /AWS_ACCESS_KEY_ID|aws:InvokeFunction/);
  assert.ok(first.report.warnings.some(x => /not test a deployed/.test(x)));
});

test('checked-in reference assets are exact compiler outputs, no timestamps', () => {
  const generated = generateArchitecture(DEMO);
  assert.equal(Object.keys(generated.files).length, 7);
  for (const [filename, content] of Object.entries(generated.files)) {
    assert.equal(readFileSync(path.join(reference, filename), 'utf8'), content, filename);
    if (filename !== 'report.json') {
      assert.equal(generated.report.artifacts[filename].sha256, sha(content));
      assert.equal(generated.report.artifacts[filename].bytes, Buffer.byteLength(content));
    }
    assert.doesNotMatch(content, /2026-11-15T\d{2}:\d{2}:\d{2}/);
  }
});

test('input ordering cannot change the compiled artifact hashes', () => {
  const reordered = structuredClone(DEMO);
  reordered.resources.reverse(); reordered.flows.reverse();
  assert.deepEqual(generateArchitecture(reordered).files, generateArchitecture(DEMO).files);
});

test('SVG and editable diagrams.net XML preserve IDs, services and edges', () => {
  const svg = generateSvg(validateArchitecture(DEMO));
  const drawio = generateDrawio(validateArchitecture(DEMO));
  assert.match(svg, /^<svg\s/);
  assert.match(drawio, /^<mxfile\s/);
  assert.match(drawio, /<mxGraphModel/);
  assert.ok(!svg.includes('<script') && !drawio.includes('<script'));
  for (const r of DEMO.resources) {
    assert.match(svg, new RegExp('data-resource-id="' + r.id + '"'));
    assert.match(drawio, new RegExp('id="resource-' + r.id + '"'));
    assert.match(drawio, new RegExp('target="resource-' + r.id + '"'));
    assert.match(svg, new RegExp('data-flow="OrderApp:' + r.id + '"'));
  }
  assert.equal((drawio.match(/ edge="1" /g) || []).length, 3);
  assert.equal((drawio.match(/ vertex="1" /g) || []).length, 4);

  const withSymbols = structuredClone(DEMO);
  withSymbols.resources[0].label = 'R&D <receipts> "data"';
  withSymbols.flows[0].label = "Save & store";
  const xmlSvg = generateSvg(validateArchitecture(withSymbols));
  const xmlDrawio = generateDrawio(validateArchitecture(withSymbols));
  assert.match(xmlSvg, /R&amp;D &lt;receipts&gt; &quot;data&quot;/);
  assert.match(xmlDrawio, /R&amp;D &lt;receipts&gt; &quot;data&quot;/);
  assert.doesNotMatch(xmlDrawio, /<receipts>/);
});

test('supported subsets generate matching subset contract and outputs', () => {
  for (const type of ['s3-bucket', 'dynamodb-table', 'sqs-queue']) {
    const one = structuredClone(DEMO);
    one.resources = one.resources.filter(x => x.type === type);
    one.flows = one.flows.filter(x => x.to === one.resources[0].id);
    const x = generateArchitecture(one);
    assert.equal(x.report.resources.length, 1);
    assert.deepEqual(Object.keys(x.template.Resources), [one.resources[0].id]);
    assert.equal(new Set(x.contract.steps.map(s => s.service)).size, 1);
    assert.ok(x.contract.steps.length >= 4 && x.contract.steps.length <= 5);
  }
});

test('rejects unsupported, duplicate or credential-bearing declarations', () => {
  const invalid = [];
  const change = fn => { const x = structuredClone(DEMO); fn(x); invalid.push(x); };
  change(x => { x.schemaVersion = 2; });
  change(x => { x.description = 'AWS_SECRET_ACCESS_KEY=not-real'; });
  change(x => { x.description = 'https://internal.invalid/private'; });
  change(x => { x.actor.label = 'password=do-not-use'; });
  change(x => { x.resources[0].label = 'a'.repeat(75); });
  change(x => { x.resources[0].type = 'lambda-function'; });
  change(x => { x.resources[0].id = 'INVALID-WITH-DASH'; });
  change(x => { x.resources[0].id = x.resources[1].id; });
  change(x => { x.resources[0].type = 'dynamodb-table'; });
  change(x => { x.resources[0].Policy = 's3:*'; });
  change(x => { x.resources[0].partitionKey = 'not-applicable'; });
  change(x => { x.resources[1].partitionKey = 'status'; });
  change(x => { delete x.resources[1].partitionKey; });
  change(x => { x.resources[1].partitionKey = 'bad#key'; });
  change(x => { x.resources.push(x.resources[0]); });
  change(x => { x.resources = []; x.flows = []; });
  change(x => { x.flows[0].to = 'NotAResource'; });
  change(x => { x.flows[0].from = 'OtherActor'; });
  change(x => { x.flows[0].to = x.flows[1].to; });
  change(x => { x.flows[1].label = 'https://secret.example'; });
  change(x => { x.flows.pop(); });
  change(x => { x.iamPolicy = { Action: '*' }; });
  change(x => { x.actor = { id: 'OrderApp' }; });
  change(x => { x.name = 'Not-A-Valid-Name'; });
  invalid.push(null, [], {}, 'json');
  invalid.forEach((v, i) => assert.throws(
    () => validateArchitecture(v), ArchitectureError, 'invalid ' + i
  ));
});

test('safe directory creation is idempotent but never overwrites differing artifacts', () => {
  workspace(home => {
    const first = writeArchitecture(DEMO, home, 'outputs/architecture');
    const second = writeArchitecture(DEMO, home, 'outputs/architecture');
    assert.deepEqual(first, second);
    assert.equal(first.generatedFiles.length, 7);
    const template = path.join(home, 'outputs/architecture/template.yaml');
    writeFileSync(template, 'manual changes');
    assert.throws(() => writeArchitecture(DEMO, home, 'outputs/architecture'),
      /Output conflict/);
    assert.equal(readFileSync(template, 'utf8'), 'manual changes');
  });
});

test('rejects unsafe paths, symlinks, invalid source JSON and giant files', {
  skip: false
}, () => workspace(home => {
  mkdirSync(path.join(home, 'source'));
  const input = path.join(home, 'source/manifest.json');
  writeFileSync(input, JSON.stringify(DEMO));
  assert.deepEqual(readManifest(home, 'source/manifest.json'), validateArchitecture(DEMO));
  assert.throws(() => readManifest(home, '../private.json'), ArchitectureError);
  assert.throws(() => writeArchitecture(DEMO, home, '../escaped'), ArchitectureError);
  assert.throws(() => writeArchitecture(DEMO, home, '/tmp/absolute'), ArchitectureError);
  assert.throws(() => writeArchitecture(DEMO, home, '.git/objects'), ArchitectureError);
  assert.throws(() => writeArchitecture(DEMO, home, 'node_modules/cache'), ArchitectureError);
  assert.throws(() => writeArchitecture(DEMO, home, 'a\\WindowsPath'), ArchitectureError);
  assert.throws(() => readManifest(home, 'https://example.com/code'), ArchitectureError);
  writeFileSync(input, '{bad json');
  assert.throws(() => readManifest(home, 'source/manifest.json'), ArchitectureError);
  writeFileSync(input, ' '.repeat(25 * 1024));
  assert.throws(() => readManifest(home, 'source/manifest.json'), ArchitectureError);
  if (process.platform !== 'win32') {
    symlinkSync(home, path.join(home, 'linked'), 'dir');
    assert.throws(() => writeArchitecture(DEMO, home, 'linked/outputs'), /Symlinks/);
    const clean = path.join(home, 'source/real.json');
    writeFileSync(clean, JSON.stringify(DEMO));
    rmSync(input);
    symlinkSync(clean, input);
    assert.throws(() => readManifest(home, 'source/manifest.json'), /Symlinks/);
  }
}));

test('CLI builds from source and refuses unknown commands without Docker', () => {
  workspace(home => {
    const source = 'manifest.json';
    writeFileSync(path.join(home, source), JSON.stringify(DEMO));
    const output = executeArchitecture(['build', source, 'output', '--json'], home);
    assert.ok(output.json);
    assert.equal(output.report.generatedFiles.length, 7);
    assert.ok(existsSync(path.join(home, 'output', 'diagram.drawio')));
    assert.throws(() => executeArchitecture(['deploy', 'prod'], home), ArchitectureError);
    assert.throws(() => executeArchitecture(['demo', '--json', '--json'], home), ArchitectureError);
  });
});

test('CLI handles custom manifests without running cloud code', () => {
  workspace(home => {
    writeFileSync(path.join(home, 'my-architecture.json'), JSON.stringify(DEMO));
    const ok = spawnSync(process.execPath,
      [path.join(ROOT, 'bin/aws-emulator-mcp.mjs'),
        'architecture', 'build', 'my-architecture.json', 'generated-output', '--json'],
      { cwd: home, encoding: 'utf8', timeout: 12000 });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).outputDirectory, 'generated-output');
    const conflict = spawnSync(process.execPath,
      [path.join(ROOT, 'bin/aws-emulator-mcp.mjs'),
        'architecture', 'build', 'my-architecture.json', 'generated-output', '--json'],
      { cwd: home, encoding: 'utf8', timeout: 12000 });
    assert.equal(conflict.status, 0, conflict.stderr);
    const unsafe = structuredClone(DEMO);
    unsafe.resources[0].ResourcePolicy = { Action: 's3:*' };
    writeFileSync(path.join(home, 'unsafe.json'), JSON.stringify(unsafe));
    const bad = spawnSync(process.execPath,
      [path.join(ROOT, 'bin/aws-emulator-mcp.mjs'),
        'architecture', 'build', 'unsafe.json'],
      { cwd: home, encoding: 'utf8', timeout: 12000 });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Resource has invalid or unsupported/);
    assert.ok(!existsSync(path.join(home, 'reports/architecture-studio/template.yaml')));
  });
});

test('installed CLI exposes local architecture demo without cloud or Docker', () => {
  workspace(home => {
    const result = spawnSync(process.execPath,
      [path.join(ROOT, 'bin/aws-emulator-mcp.mjs'),
        'architecture', 'demo', 'preview', '--json'],
      { cwd: home, encoding: 'utf8', timeout: 25000,
        env: { ...process.env, DOCKER_HOST: 'tcp://198.51.100.1:2375' } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.validated.awsDeployment, false);
    assert.equal(report.outputDirectory, 'preview');
    assert.ok(existsSync(path.join(home, 'preview', 'template.yaml')));
    assert.ok(existsSync(path.join(home, 'preview', 'diagram.svg')));
    assert.ok(existsSync(path.join(home, 'preview', 'diagram.drawio')));
  });
});
