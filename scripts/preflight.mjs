/** Read-only local readiness checks. No container, Docker image build, network fetch,
 * application code execution, cloud credentials or environment dumps.
 */
import { spawnSync } from 'node:child_process';
import { statfsSync } from 'node:fs';

const LOCAL_DOCKER = /^(?:unix|npipe):\/\//;
const VERSION_TEXT = /^[A-Za-z0-9][A-Za-z0-9 .+_\-]{0,99}$/;

const HOST_SPACE_ADVISORY_GIB = 10;
const GIB = 1024 ** 3;
const FINGERPRINT = /^[a-f0-9]{64}$/;

/** Host CWD volume is only an advisory, NOT Docker Desktop VM storage. */
export function inspectWorkspaceDisk(statfs = () => statfsSync(process.cwd(), {bigint: true})) {
  const report = {
    scope: 'host-current-working-directory-volume',
    freeGiB: null,
    advisoryThresholdGiB: HOST_SPACE_ADVISORY_GIB,
    lowSpaceAdvisory: null,
    dockerDataCapacityVerified: false
  };
  try {
    const fs = statfs();
    const blockSize = BigInt(fs.bsize);
    const availableBlocks = BigInt(fs.bavail);
    if (blockSize <= 0n || availableBlocks < 0n) return report;
    const bytes = blockSize * availableBlocks;
    if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) return report;
    const availableGiB = Number(bytes) / GIB;
    report.freeGiB = Math.floor(availableGiB * 10) / 10;
    report.lowSpaceAdvisory = availableGiB < HOST_SPACE_ADVISORY_GIB;
  } catch { /* Unknown/unsupported host filesystem. */ }
  return report;
}


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
  image = 'aws-emulator-mcp:0.4.0-beta.15',
  expectedImageDigest = null,
  statfs = () => statfsSync(process.cwd(), {bigint: true}),
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
    imageSourceStatus: 'not-checked',
    imageReusable: null,
    hostWorkspaceDisk: inspectWorkspaceDisk(statfs),
    dockerVersion: null,
    checks,
    nextCommand: nodeOk ? 'aws-emulator-mcp architecture demo' : 'Install Node.js 20+',
    sourceCheckoutCommand: nodeOk ? 'node bin/aws-emulator-mcp.mjs architecture demo' : 'Install Node.js 20+',
    guidance: 'Architecture demo needs no Docker; Docker-backed commands need a local daemon and enough image space.',
    limitations: 'Read-only local checks. Host working-volume space is advisory, not Docker Desktop/VM capacity. Cached image reuse requires a matching source fingerprint. No AWS parity, outbound network, credentials, or emulator execution checked.',
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
  if (output.imageCached && typeof expectedImageDigest === 'function') {
    try {
      const expected = expectedImageDigest();
      if (!FINGERPRINT.test(expected)) throw Error('Invalid local source fingerprint');
      const observed = safeCommand(run, ['image', 'inspect', image,
        '--format', '{{index .Config.Labels "dev.aws-emulator-mcp.source-sha256"}}'], 4000);
      const observedLabel = observed.stdout.trim();
      if (observed.status === 0 && FINGERPRINT.test(observedLabel)) {
        output.imageReusable = observedLabel === expected;
        output.imageSourceStatus = output.imageReusable ? 'matched' : 'mismatched';
      } else {
        output.imageReusable = false;
        output.imageSourceStatus = 'unverified';
      }
    } catch {
      output.imageReusable = false;
      output.imageSourceStatus = 'unverified';
    }
    if (!output.imageReusable) {
      checks.image = result(false, 'Cached image source mismatch or unverified; the next emulator command will rebuild the signed local image');
    }
  }
  output.emulatorReady = nodeOk && checks.docker.passed;
  if (output.emulatorReady) {
    output.nextCommand = 'aws-emulator-mcp doctor';
    output.sourceCheckoutCommand = 'node bin/aws-emulator-mcp.mjs doctor';
  }
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
  if (report.hostWorkspaceDisk?.freeGiB !== null) {
    out.push('  Host working-volume free space: ' + report.hostWorkspaceDisk.freeGiB.toFixed(1) + ' GiB (Docker storage NOT verified)');
    if (report.hostWorkspaceDisk.lowSpaceAdvisory)
      out.push('  Advisory: below 10 GiB on host working volume; inspect actual Docker storage before an initial build.');
  } else out.push('  Host working-volume space: unavailable (Docker storage NOT verified)');

  if (report.imageCached !== null) out.push(`  Versioned Docker image tag present: ${report.imageCached ? 'yes' : 'no'} (not a source verification)`);
  if (report.checks.docker?.reason) out.push(`  Blocker: ${report.checks.docker.reason}`);
  if (report.imageSourceStatus === 'matched') out.push('  Cached image Docker-copy source fingerprint: matches current checkout');
  if (report.imageSourceStatus === 'mismatched' || report.imageSourceStatus === 'unverified')
    out.push('  Cached image Docker-copy source fingerprint: rebuild needed (not a signature or AWS fidelity check)');
  if (report.checks.image?.reason) out.push(`  Note: ${report.checks.image.reason}`);
  out.push(`  Architecture-only path ready: ${report.architectureReady ? 'yes' : 'no'}`,
    `  Emulator launch prerequisites: ${report.emulatorReady ? 'ready' : 'blocked'}`,
    `  Next (from source checkout): ${report.sourceCheckoutCommand}`,
    `  Next (if globally installed): ${report.nextCommand}`,
    '  No container was launched or built. No credentials or private paths reported.',
    '  Docker data-store free space and upstream service fidelity are not tested.', '');
  return out.join('\n');
}
