#!/usr/bin/env node
/* Code Gym: boot a signed AWS Emulator and Python MCP in an isolated container.
 * Neither AWS credentials nor writable host directories are passed to Docker.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { stderr, stdout, execPath, exit } from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '0.4.0-beta.1';
const IMAGE = 'codegym/aws-emulator-mcp:' + VERSION;
const SOURCE = 'https://github.com/B11-Health/aws-emulator-mcp';

function fail(message, code = 1) {
  stderr.write('Code Gym AWS Lab: ' + message + '\n');
  exit(code);
}
function help() {
  stdout.write(`Code Gym AWS Lab (developer beta)

Usage: codegym-aws <command>

Commands:
  doctor           Verify Docker and the isolated emulator account
  demo             Execute a real S3 + DynamoDB + SQS order workflow
  mcp              Run the 27-tool local MCP server (stdio)
  catalog          List implemented MCP tools
  self-test        Exercise supported services and scoped cleanup
  build            Build the image from the signed official AWS package
  config [format]  Print MCP configuration: copilot or vscode
  help             Show this help

Docker is required. No AWS account or Python required on the host.
First build downloads and verifies the official AWS Emulator.
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
function dockerArgs(mode) {
  return ['run', '--rm', '-i', '--network', 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', '2g', IMAGE, mode];
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
  stderr.write('Code Gym: building a local image with the signed official AWS Emulator.\n');
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
  if (command === 'config') return config(args[0]);
  if (!['build', 'doctor', 'demo', 'mcp', 'catalog', 'self-test'].includes(command) || args.length) {
    fail('Unknown command/arguments. Run: codegym-aws help', 2);
  }
  requireDocker();
  if (command === 'build' || !imageExists()) await buildImage();
  if (command === 'build') return;
  const code = await runDocker(dockerArgs(command));
  if (code !== 0) fail(command + ' failed (exit ' + code + ')', code);
}
main().catch(err => fail(err?.message || String(err)));
