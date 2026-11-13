#!/usr/bin/env node
/* AWS Emulator MCP: boot a signed AWS Emulator and Python MCP in an isolated container.
 * Neither AWS credentials nor writable host directories are passed to Docker.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { stderr, stdout, execPath, exit } from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '0.4.0-beta.3';
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
  mcp              Run 29 curated + 2 modeled-SDK tools via local MCP
  catalog          List implemented MCP tools
  experiments      Discover repeatable AWS lab missions (no Docker needed)
  experiment <id>  Run one allowlisted mission with proof and scoped cleanup
  self-test        Exercise supported services and scoped cleanup
  build            Build the image from the signed official AWS package
  config [format]  Print MCP configuration: copilot or vscode
  help             Show this help

Docker is required to run experiments and MCP tools; listing experiments or printing config needs only Node.
No AWS account or Python is required on the host.
Use --json with doctor, demo, self-test, catalog, experiments, or experiment for machine-readable results.\nFirst build downloads and verifies the official AWS Emulator.
Source: ${SOURCE}
`);
}
function requireDocker() {
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
  } else if (command === 'catalog') {
    lines.push('  ' + result.length + ' available MCP tools', '');
    for (const tool of result) lines.push('  - ' + tool.name);
  }
  lines.push('', '  Local Docker lab only. No production AWS resources.', '');
  stdout.write(lines.join('\n') + '\n');
}
function runCaptured(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, shell: false
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
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, raw: Buffer.concat(output).toString('utf8') }));
  });
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
