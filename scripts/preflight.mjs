/** Read-only local readiness checks. No container, Docker image build, network fetch,
 * application code execution, cloud credentials or environment dumps.
 */
import { spawnSync } from 'node:child_process';

const LOCAL_DOCKER = /^(?:unix|npipe):\/\//;
const VERSION_TEXT = /^[A-Za-z0-9][A-Za-z0-9 .+_\-]{0,99}$/;

function result(ok, reason = '') {
  return { passed: Boolean(ok), reason };
}

function safeCommand(run, args, timeout) {
  try {
    const outcome = run(args, timeout);
    return {status: outcome?.status, stdout: typeof outcome?.stdout === 'string' ? outcome.stdout : ''};
  } catch {
    return {status: null, stdout: ''};
  }
}

/** Dependency injection keeps malformed endpoints and nonlocal daemon tests deterministic. */
export function inspectPreflight({
  nodeVersion = process.versions.node,
  platform = process.platform,
  dockerHost = process.env.DOCKER_HOST,
  image = 'aws-emulator-mcp:0.4.0-beta.14',
  run = (args, timeout) => spawnSync('docker', args, {
    encoding: 'utf8', timeout, windowsHide: true, shell: false
  })
} = {}) {
  const major = Number(String(nodeVersion).split('.')[0]);
  const nodeOk = Number.isInteger(major) && major >= 20;
  const checks = { node: result(nodeOk, nodeOk ? '' : 'Node.js 20+ required') };
  const output = {
    schemaVersion: 1,
    platform: ['win32','darwin','linux'].includes(platform) ? platform : 'other',
    nodeMajor: Number.isInteger(major) ? major : null,
    architectureReady: nodeOk,
    emulatorReady: false,
    imageCached: null,
    dockerVersion: null,
    checks,
    nextCommand: nodeOk ? 'aws-emulator-mcp architecture demo' : 'Install Node.js 20+',
    guidance: 'Architecture demo needs no Docker; Docker-backed commands need a local daemon and enough image space.',
    limitations: 'Read-only local checks only. Does not check disk capacity, AWS API parity, outbound network, or execute any emulator.',
  };
  // Never attempt to contact an ambient remote daemon, even to query version.
  if (dockerHost && !LOCAL_DOCKER.test(dockerHost)) {
    checks.docker = result(false, 'Nonlocal DOCKER_HOST refused; select a local Unix socket or Windows named pipe');
    return output;
  }
  const cli = safeCommand(run, ['--version'], 4000);
  if (cli.status !== 0) {
    checks.docker = result(false, 'Docker CLI unavailable; install Docker Desktop or Docker Engine');
    return output;
  }
  const context = safeCommand(run, ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], 6000);
  let endpoint = null;
  try { endpoint = JSON.parse(context.stdout.trim()); } catch { /* unverified */ }
  if (context.status !== 0 || typeof endpoint !== 'string' || !LOCAL_DOCKER.test(endpoint)) {
    checks.docker = result(false, 'Local Docker context could not be verified; remote contexts are not supported');
    return output;
  }
  const info = safeCommand(run, ['info', '--format', '{{.OSType}}|{{.ServerVersion}}'], 6000);
  if (info.status !== 0) {
    checks.docker = result(false, 'Local Docker daemon unavailable; start Docker Desktop/Engine and check docker info');
    return output;
  }
  const parts = info.stdout.trim().split('|');
  if (parts.length !== 2 || !VERSION_TEXT.test(parts[1])) {
    checks.docker = result(false, 'Unable to verify Docker daemon type and version');
    return output;
  }
  if (parts[0] !== 'linux') {
    checks.docker = result(false, 'Linux containers required; switch Docker Desktop from Windows containers to Linux containers');
    return output;
  }
  output.dockerVersion = parts[1];
  checks.docker = result(true);
  const cached = safeCommand(run, ['image', 'inspect', image, '--format', '{{.Id}}'], 4000);
  output.imageCached = cached.status === 0;
  checks.image = result(output.imageCached, output.imageCached
    ? '' : 'First emulator command will build the signed image; requires download and substantial disk space');
  output.emulatorReady = nodeOk && checks.docker.passed;
  if (output.emulatorReady) output.nextCommand = 'aws-emulator-mcp doctor';
  return output;
}

export function printPreflight(report) {
  const mark = ok => ok ? 'PASS' : 'CHECK';
  const out = [
    'AWS Emulator MCP / first-run preflight',
    `  ${mark(report.checks.node.passed)} Node.js 20+ (observed major: ${report.nodeMajor ?? 'unknown'})`,
    `  ${mark(report.checks.docker?.passed)} Local Docker CLI + daemon`,
  ];
  if (report.dockerVersion) out.push(`  Docker server: ${report.dockerVersion}`);
  if (report.imageCached !== null) out.push(`  Signed emulator image cached: ${report.imageCached ? 'yes' : 'no'}`);
  if (report.checks.docker?.reason) out.push(`  Blocker: ${report.checks.docker.reason}`);
  if (report.checks.image?.reason) out.push(`  Note: ${report.checks.image.reason}`);
  out.push(`  Architecture-only path ready: ${report.architectureReady ? 'yes' : 'no'}`,
    `  Emulator launch prerequisites: ${report.emulatorReady ? 'ready' : 'blocked'}`,
    `  Next: ${report.nextCommand}`,
    '  No container was launched or built. No credentials or private paths reported.',
    '  Disk space and upstream service fidelity are not tested.', '');
  return out.join('\n');
}
