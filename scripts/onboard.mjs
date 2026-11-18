/**
 * One non-interactive first win: verify bounded, temporary offline artifacts,
 * then optionally inspect existing Docker readiness. No startup or cloud calls.
 * An offline PASS is intentionally separate from application or API evidence.
 */
import {runOfflineTrial} from './offline_trial.mjs';
import {inspectPreflight} from './preflight.mjs';

const CHECKOUT = 'node bin/aws-emulator-mcp.mjs';
const INSTALLED = 'aws-emulator-mcp';
const command = (suffix, fromCheckout) =>
  (fromCheckout ? CHECKOUT : INSTALLED) + ' ' + suffix;

export function parseOnboardArgs(args) {
  const allowed = new Set(['--json', '--offline']);
  if (!Array.isArray(args) || args.length > 2 ||
      args.some(x => !allowed.has(x)) ||
      new Set(args).size !== args.length) {
    throw Error('Usage: aws-emulator-mcp onboard [--offline] [--json]');
  }
  return {json:args.includes('--json'), offline:args.includes('--offline')};
}

export function summarizeOnboarding({
  trial=null, preflight=null, offlineOnly=false, fromCheckout=true
}={}) {
  // Do not credit the application or AWS tests for a successful generator.
  const offlinePassed = trial?.passed === true &&
    trial.test === 'offline-architecture-generation' &&
    trial.artifactCount === 7 &&
    Number.isInteger(trial.syntheticContractSteps) &&
    trial.syntheticContractSteps >= 10 && trial.syntheticContractSteps <= 16 &&
    Array.isArray(trial.resourceTypes) &&
    ['AWS::DynamoDB::Table', 'AWS::S3::Bucket', 'AWS::SQS::Queue']
      .every(type => trial.resourceTypes.includes(type)) &&
    trial.resourceTypes.length === 3 &&
    trial.dockerUsed === false &&
    trial.cloudCallsMade === false &&
    trial.generatedFilesPreserved === false;

  const dockerReady = !offlineOnly && preflight?.emulatorReady === true &&
    preflight?.checks?.docker?.passed === true &&
    preflight?.checks?.node?.passed === true;

  const lowDiskAdvisory = preflight ?
    (preflight.hostVisibleDockerRootDisk?.lowSpaceAdvisory === true ||
     preflight.hostWorkspaceDisk?.lowSpaceAdvisory === true) : null;
  const imageReady = dockerReady && preflight.imageReusable === true;
  const imageNeedsBuild = dockerReady && !imageReady;

  const readiness = offlineOnly ? 'not_checked' :
    dockerReady ? 'docker_ready_not_started' :
    'docker_blocked';

  const nextSteps = offlinePassed ? [{
    id: 'explore',
    title: 'Keep and inspect the seven architecture artifacts',
    command: command('architecture demo', fromCheckout),
    requires: 'Node.js 20+; creates files under reports/architecture-studio',
    automatic: false,
  }] : [{
    id: 'retry-offline',
    title: 'Retry the local first-win check before attempting AWS API tests',
    command: command('try --json', fromCheckout),
    requires: 'Node.js 20+; validates generated architecture files; no Docker',
    automatic: false,
  }];
  if (!offlinePassed) {
    // A failed artifact check must not lead directly to a Docker build.
  } else if (offlineOnly) {
    nextSteps.push({
      id: 'check-docker', title: 'Check local Docker prerequisites when you are ready',
      command: command('onboard --json', fromCheckout),
      requires: 'Optional; checks local Docker status without starting containers',
      automatic: false,
    });
  } else if (dockerReady) {
    nextSteps.push({
      id: 'test-aws-locally',
      title: imageNeedsBuild ? 'Explicitly build the signed local emulator before testing' :
        'Run one isolated local emulator health check',
      command: command(imageNeedsBuild ? 'build' : 'doctor', fromCheckout),
      requires: imageNeedsBuild ?
        'Docker download/build; internet on first build; substantial free Docker storage' :
        'Creates an isolated Docker container; no production AWS account',
      automatic: false,
    });
    if (imageNeedsBuild) {
      nextSteps.push({
        id: 'verify-emulator',
        title: 'Verify the isolated emulator after the build',
        command: command('doctor', fromCheckout),
        requires: 'Docker; executes local emulator checks',
        automatic: false,
      });
    }
    nextSteps.push({
      id: 'run-app-proof',
      title: 'Reproduce an order-intake bug and verify its fix on the local emulator',
      command: command('app-debug compare', fromCheckout),
      requires: 'Local Docker; runs the bundled trusted example against a disposable emulator and checks cleanup',
      automatic: false,
    });
  } else {
    nextSteps.push({
      id: 'docker-help',
      title: 'Enable local Linux-container Docker only if you want AWS API tests',
      command: command('preflight', fromCheckout),
      requires: 'Install/start Docker Desktop or Engine first; Architecture Studio needs no Docker',
      automatic: false,
    });
  }
  if (offlinePassed) nextSteps.push({
    id: 'inspect-own-app',
    title: fromCheckout ?
      'Inspect the sample Python handler without executing its source' :
      'Inspect a Python handler you own (supply your files)',
    command: command(fromCheckout ?
      'app-case-inspect examples/app-case/fixed.py --json' :
      'app-case-inspect YOUR_APP.py --json', fromCheckout),
    requires: 'Python 3.10+; read-only source inspection; no AWS calls',
    automatic: false,
  }, {
    id: 'connect-agent',
    title: 'Print the native VS Code Copilot MCP configuration',
    command: command('config copilot', fromCheckout),
    requires: 'Compatible MCP client; configuration must be installed by the developer',
    automatic: false,
  });

  return {
    schemaVersion: 1,
    mode: 'guided-first-run',
    commandContext: fromCheckout ? 'source-checkout' : 'installed-cli',
    status: offlinePassed ? 'offline_first_win' : 'offline_trial_failed',
    passed: offlinePassed,
    firstWin: {
      type: 'architecture-artifact-validation-only',
      passed: offlinePassed,
      artifactCount: offlinePassed ? 7 : 0,
      resourceTypes: offlinePassed ? trial.resourceTypes : [],
      syntheticContractSteps: offlinePassed ? trial.syntheticContractSteps : null,
      contractExecuted: false,
      generatedFilesPreserved: false
    },
    readiness: {
      emulator: readiness,
      dockerProbePerformed: !offlineOnly,
      imageReusable: offlineOnly || !dockerReady ? null : imageReady,
      imageBuildRequiredBeforeDoctor: offlineOnly || !dockerReady ? null : imageNeedsBuild,
      workspaceLowSpaceAdvisory: offlineOnly ? null :
        preflight?.hostWorkspaceDisk?.lowSpaceAdvisory ?? null,
      dockerRootLowSpaceAdvisory: offlineOnly ? null :
        preflight?.hostVisibleDockerRootDisk?.lowSpaceAdvisory ?? null,
      lowDiskAdvisory: offlineOnly ? null : lowDiskAdvisory,
      reason: offlineOnly ? 'Skipped local Docker checks by request' :
        preflight?.checks?.docker?.reason ||
        preflight?.checks?.image?.reason ||
        (dockerReady ? 'Local Docker prerequisites detected; emulator was not launched' :
          'Could not verify local Docker prerequisites'),
    },
    nextSteps,
    safety: {
      noDockerBuildOrRun: true,
      noApplicationSourceExecution: true,
      noCloudCalls: true,
      noProductionCredentialReads: true
    },
    limitations: 'The first win validates local generated files only. Docker preflight is read-only. No AWS service APIs, application fixes, IAM, deployment, emulator package signature or production AWS were tested.'
  };
}

export function runOnboarding({offlineOnly=false, fromCheckout=true,
  trial=runOfflineTrial,
  preflight=inspectPreflight,
  image, expectedImageDigest}={}) {
  let offlineProof;
  try {offlineProof = trial();}
  catch {
    // Never print a thrown error: it could contain user paths or private data.
    offlineProof = null;
  }
  let readiness = null;
  if (!offlineOnly) {
    try {readiness = preflight({image, expectedImageDigest});}
    catch {readiness = null;}
  }
  return summarizeOnboarding({trial:offlineProof, preflight:readiness, offlineOnly, fromCheckout});
}

export function formatOnboarding(report) {
  const ready = report.firstWin.passed;
  const lines = [
    'AWS Emulator MCP / guided first run',
    'Commands for: ' + report.commandContext,
    '',
    ready ? 'PASS  Your first local result is verified.' :
      'CHECK  Local architecture-artifact verification did not pass.',
    ready ? '      Seven generated architecture files were inspected and removed.' :
      '      No successful offline proof was established.',
    ready ? `      The ${report.firstWin.syntheticContractSteps}-step AWS contract was NOT executed.` : '',
    '',
    report.readiness.emulator === 'not_checked' ?
      'Docker: not checked (--offline)' :
    report.readiness.emulator === 'docker_ready_not_started' ?
      'Docker: local Linux daemon prerequisites available; emulator NOT started' :
      'Docker: unavailable or not verified (offline architecture still works)',
    report.readiness.reason ? `Note: ${report.readiness.reason}` : '',
  ];
  if (report.readiness.lowDiskAdvisory) {
    lines.push('Disk advisory: check Docker storage before downloading/building the emulator.');
  }
  lines.push('', 'Your next steps (choose only what you need):');
  for (const step of report.nextSteps) {
    lines.push(`  ${step.title}`, `  > ${step.command}`, `    ${step.requires}`);
  }
  lines.push('', 'No Docker build or container launch, cloud request, or application source execution occurred.',
    'An offline PASS does not mean an AWS API or your application worked.');
  return lines.filter(line => line !== null).join('\n') + '\n';
}
