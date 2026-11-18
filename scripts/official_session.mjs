/** Read-only companion probe for an AWS Emulator session started by AWS's tools.
 * Never reads credentials, runs AWS CLI, starts Docker, or contacts public AWS.
 * Healthy loopback HTTPS is NOT account identity, package provenance, or fidelity.
 */
import https from 'node:https';
import {lstatSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

const MAX_CA = 256 * 1024;
const LOCAL_HOST = '127.0.0.1';

export function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function parseOfficialSessionArgs(args) {
  let port = 9297, json = false, seenPort = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--port' && !seenPort) {
      const next = args[++i];
      if (typeof next !== 'string' || !/^[1-9][0-9]{0,4}$/.test(next))
        throw Error('Port must be a decimal integer from 1 to 65535');
      port = Number(next);
      if (!validPort(port)) throw Error('Port must be 1 to 65535');
      seenPort = true;
      continue;
    }
    throw Error('Usage: aws-emulator-mcp official-session [--port 9297] [--json]');
  }
  return {port, json};
}

export function healthRequest({port, ca}) {
  return new Promise((resolve, reject) => {
    const req = https.request({hostname: LOCAL_HOST, port,
      path: '/__admin/health', method: 'GET', ca, rejectUnauthorized: true,
      timeout: 2500, agent: false, headers: {accept: 'text/plain'}}, res => {
      const parts = [];
      let count = 0;
      res.on('data', data => {
        count += data.length;
        if (count > 32) { req.destroy(Error('oversized')); return; }
        parts.push(data);
      });
      res.on('end', () => resolve({statusCode: res.statusCode,
        body: Buffer.concat(parts).toString('utf8')}));
    });
    req.on('timeout', () => req.destroy(Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function isRegularNoLink(file) {
  try {
    const stat = lstatSync(file);
    return !stat.isSymbolicLink() && stat.isFile() && stat.size > 0 && stat.size <= MAX_CA;
  } catch { return false; }
}

function isDirectoryNoLink(file) {
  try {
    const stat = lstatSync(file);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch { return false; }
}

export async function inspectOfficialSession({port=9297, home=homedir(), probe=healthRequest}={}) {
  if (!validPort(port)) throw Error('Port must be 1 to 65535');
  const base = {schemaVersion: 1, mode: 'official_session_read_only', port,
    endpoint: `https://${LOCAL_HOST}:${port}`, sessionDirectoryRecognized: false,
    localHealthPassed: false, status: 'not_configured',
    dockerOperationsPerformed: false, cloudCallsMade: false, credentialFilesRead: false,
    accountIdentityVerified: false, officialPackageVerified: false,
    applicationBehaviorTested: false, productionAwsValidated: false,
    limitations: 'Local TLS health only. Does not attach this MCP to the session, sign AWS API calls, prove package origin, test IAM/fidelity, or deploy to AWS.'};
  const awsDir = path.join(home,'.aws');
  const emuDir = path.join(awsDir,'emulator');
  const sessionDir = path.join(emuDir,String(port));
  if (![awsDir,emuDir,sessionDir].every(isDirectoryNoLink)) {
    return {...base, nextAction: 'Use the official AWS Emulator skill to install and start an emulator, then rerun this read-only check.'};
  }
  const caFile = path.join(sessionDir,'ca.pem');
  if (!isRegularNoLink(caFile)) {
    return {...base, status: 'missing_ca', sessionDirectoryRecognized: true,
      nextAction: 'Check the official emulator run and its per-port CA certificate; never bypass TLS verification.'};
  }
  // Do not access emulator_credentials, config, AWS_PROFILE, or any credential env vars.
  let ca;
  try { ca = readFileSync(caFile); }
  catch { return {...base, status: 'missing_ca', sessionDirectoryRecognized: true,
    nextAction: 'Official emulator TLS certificate is unreadable.'}; }
  try {
    const response = await probe({port, ca});
    if (response?.statusCode === 200 && response.body?.trim() === 'ok') {
      return {...base, status:'healthy', sessionDirectoryRecognized: true,
        localHealthPassed: true,
        nextAction:'Use the official AWS SDK/CLI configuration and verify sts.GetCallerIdentity account 000000000000 before any AWS API test. This MCP still uses independent disposable Docker labs.'};
    }
    return {...base, status:'unhealthy', sessionDirectoryRecognized:true,
      nextAction:'The loopback health response was not the documented 200 OK. Check the official emulator logs.'};
  } catch {
    return {...base, status:'unreachable', sessionDirectoryRecognized:true,
      nextAction:'The local TLS health request failed or timed out. Check the official emulator process, port and CA; do not disable certificate verification.'};
  }
}

export function formatOfficialSession(report) {
  return ['AWS Emulator MCP / official-session companion check',
    `Official local session on ${report.endpoint}: ${report.status}`,
    `CA/session recognized: ${report.sessionDirectoryRecognized ? 'yes':'no'}`,
    `Verified local HTTPS health: ${report.localHealthPassed ? 'yes':'no'}`,
    'No Docker started; no credential files read; no AWS cloud calls.',
    report.nextAction, `Limits: ${report.limitations}`].join('\n');
}
