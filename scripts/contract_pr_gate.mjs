#!/usr/bin/env node
/**
 * PR gate for reviewed declarative AWS Emulator contract files.
 *
 * The caller's repository supplies JSON data only. The runner and Docker
 * launcher are loaded from the pinned action source; no untrusted application
 * code, shell commands, external endpoints, or cloud credentials are used.
 * Evidence is deliberately narrowed to assertion outcomes and hashes.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, unlinkSync, writeFileSync
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const TRUSTED_CLI = path.join(PACKAGE_ROOT, 'bin', 'aws-emulator-mcp.mjs');
const MAX_CONTRACTS = 6;
const MAX_CONTRACT_BYTES = 48 * 1024;
const MAX_EVIDENCE_BYTES = 140 * 1024;

class GateError extends Error {
  constructor(message) { super(message); this.name = 'GateError'; }
}

const safeText = (v, max = 100) => typeof v === 'string'
  ? v.slice(0, max).replace(/[\r\n<>|\x00-\x1f]/g, ' ') : '';

function jsonFile(target, value) {
  writeFileSync(target, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'w' });
}

function within(base, dest) {
  const rel = path.relative(base, dest);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** Flat folder of 1-6 bounded regular JSON files, no links, traversal or scripts. */
export function discoverContracts(workspace, folder = '.aws-emulator/contracts') {
  if (typeof folder !== 'string' || folder.length > 160 ||
      !/^[A-Za-z0-9._/-]+$/.test(folder) || folder.startsWith('/') ||
      folder.split('/').some(segment => segment === '..' || segment === '' || segment === '.')) {
    throw new GateError('Contract directory must be a relative workspace path without traversal');
  }
  const root = realpathSync(workspace);
  let directory = root;
  for (const segment of folder.split('/')) {
    directory = path.join(directory, segment);
    if (!existsSync(directory)) throw new GateError('Contract directory not found');
    if (lstatSync(directory).isSymbolicLink()) {
      throw new GateError('Contract directory symlinks are not allowed');
    }
  }
  if (!within(root, directory) || !lstatSync(directory).isDirectory()) {
    throw new GateError('Contract directory must be a workspace subdirectory');
  }
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (!entries.length) throw new GateError('No .json contracts found in the selected directory');
  if (entries.length > MAX_CONTRACTS) {
    throw new GateError('Contract directory may contain at most six JSON plans');
  }
  return entries.map(entry => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/.test(entry.name) ||
        !entry.isFile() || entry.isSymbolicLink()) {
      throw new GateError('Contract names must be simple regular .json files; no symlinks');
    }
    const target = path.join(directory, entry.name);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CONTRACT_BYTES) {
      throw new GateError('Each contract must be a regular JSON file of at most 48 KiB');
    }
    // Parsing also catches empty/invalid JSON before invoking Docker.
    let parsed;
    try { parsed = JSON.parse(readFileSync(target, 'utf8')); }
    catch { throw new GateError('Contract directory contains invalid JSON'); }
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.steps) ||
        parsed.steps.length < 1 || parsed.steps.length > 16) {
      throw new GateError('Contract must use schemaVersion 1 and 1-16 steps');
    }
    return { name: entry.name, path: target };
  });
}

function defaultInvoke(filename, workspace) {
  return spawnSync(process.execPath, [TRUSTED_CLI, 'contract', filename, '--json'], {
    cwd: workspace, encoding: 'utf8', timeout: 240_000, maxBuffer: MAX_EVIDENCE_BYTES,
    shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
}

function sanitizedStep(row) {
  const result = {
    id: safeText(row.id, 32), service: safeText(row.service, 64),
    operation: safeText(row.operation, 80), passed: row.passed === true,
    observed: safeText(row.observed, 28)
  };
  if (typeof row.errorCode === 'string') result.errorCode = safeText(row.errorCode, 80);
  if (row.fault && ['before-call', 'after-success'].includes(row.fault.mode)) {
    result.fault = {
      mode: row.fault.mode, sentToEmulator: row.fault.sentToEmulator === true,
      source: 'local SDK wrapper'
    };
  }
  if (Array.isArray(row.assertions)) {
    result.assertions = row.assertions.slice(0, 10).map(a => ({
      path: safeText(a.path, 100), passed: a.passed === true
    }));
  }
  return result;
}

function sanitizedProof(raw, exitCode) {
  let proof;
  try {
    if (typeof raw === 'string' && Buffer.byteLength(raw) <= MAX_EVIDENCE_BYTES) {
      proof = JSON.parse(raw);
    }
  } catch { /* Malformed output is a failed gate, never a console dump. */ }
  if (!proof || typeof proof !== 'object' || !Array.isArray(proof.steps) ||
      proof.steps.length > 16 || proof.steps.length < 1 ||
      typeof proof.totalSteps !== 'number' || typeof proof.passedSteps !== 'number' ||
      proof.totalSteps < 1 || proof.totalSteps > 16 ||
      proof.steps.length > proof.totalSteps ||
      !/^[a-f0-9]{64}$/.test(proof.planSha256 || '')) {
    return { passed: false, reason: 'Runner did not return valid, bounded evidence', steps: [] };
  }
  const steps = proof.steps.map(sanitizedStep);
  const expectedSuccess = (
    exitCode === 0 && proof.passed === true &&
    proof.accountVerified === true && proof.totalSteps === proof.passedSteps &&
    proof.steps.length === proof.totalSteps && steps.every(s => s.passed)
  );
  return {
    passed: expectedSuccess, planSha256: proof.planSha256,
    emulatorVersion: safeText(proof.emulatorVersion, 100),
    passedSteps: steps.filter(s => s.passed).length,
    totalSteps: proof.totalSteps,
    steps,
    ...(expectedSuccess ? {} : { reason: 'Contract assertions or isolated runner failed' })
  };
}

function rowStatus(item) {
  return item.passed ? 'PASS' : 'FAIL';
}

function makeMarkdown(report) {
  const rows = report.results.map(item =>
    '| ' + item.file + ' | ' + item.passedSteps + '/' +
    item.totalSteps + ' | ' + rowStatus(item) + ' |');
  return [
    '### AWS Emulator MCP · PR contract gate',
    '',
    '**' + (report.passed ? 'PASS' : 'FAIL') + '** · ' +
      report.results.filter(item => item.passed).length + '/' +
      report.results.length + ' contracts passed',
    '',
    '| Contract | SDK steps passed | Result |',
    '| :-- | --: | :-- |',
    ...rows,
    '',
    ...(report.error ? ['- **Gate:** ' + safeText(report.error, 180), ''] : []),
    '- Runs against an isolated local AWS Emulator. Each contract gets a separate temporary container.',
    '- Download **aws-emulator-contract-evidence** from the workflow artifacts for sanitized step results.',
    '- This verifies emulated API behavior only, not application code, production AWS/IAM fidelity or real network failures.',
    ''
  ].join('\n');
}

/**
 * Used by both the CLI entry and controlled unit tests (which inject a fake
 * contract executor). In production the executor path is fixed to this action.
 */
export function runGate({
  workspace, directory = '.aws-emulator/contracts', outputDirectory,
  summaryPath, invokeContract = defaultInvoke
}) {
  const root = realpathSync(workspace);
  const output = outputDirectory || path.join(root, 'reports', 'aws-emulator-contract-evidence');
  mkdirSync(output, { recursive: true });
  // A repeat local run must never upload evidence from an earlier run.
  // Clear only the numbered case artifacts owned by this runner.
  for (const old of readdirSync(output)) {
    if (/^case-0[1-6]\.json$/.test(old)) unlinkSync(path.join(output, old));
  }
  const report = {
    schemaVersion: 1, gate: 'aws-emulator-contracts', passed: false,
    verification: 'isolated local AWS SDK contract tests', results: []
  };
  try {
    const files = discoverContracts(root, directory);
    for (const [index, file] of files.entries()) {
      let execution;
      try { execution = invokeContract(file.path, root); }
      catch { execution = { status: null, stdout: '' }; }
      const outcome = sanitizedProof(execution?.stdout, execution?.status);
      const item = { file: file.name, ...outcome };
      report.results.push(item);
      jsonFile(path.join(output, 'case-' + String(index + 1).padStart(2, '0') + '.json'), item);
    }
    report.passed = report.results.length === files.length &&
      report.results.every(item => item.passed);
  } catch (err) {
    report.error = err instanceof GateError ? err.message : 'Contract discovery or report generation failed';
    report.passed = false;
  }
  jsonFile(path.join(output, 'report.json'), report);
  const markdown = makeMarkdown(report);
  writeFileSync(path.join(output, 'summary.md'), markdown, 'utf8');
  if (summaryPath) appendFileSync(summaryPath, markdown, 'utf8');
  return report;
}

async function main() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const outputDirectory = process.env.AWS_MCP_GATE_EVIDENCE ||
    path.join(workspace, 'reports', 'aws-emulator-contract-evidence');
  const summaryPath = process.env.GITHUB_STEP_SUMMARY || undefined;
  const report = runGate({
    workspace, directory: process.env.AWS_MCP_GATE_DIRECTORY || '.aws-emulator/contracts',
    outputDirectory, summaryPath
  });
  const completed = report.results.filter(v => v.passed).length;
  console.log('AWS Emulator PR contracts: ' + completed + '/' + report.results.length +
    ' passed; sanitized evidence in ' + outputDirectory);
  if (report.error) console.error('AWS Emulator contract gate: ' + report.error);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('AWS Emulator contract gate failed safely'); process.exitCode = 1; });
}
