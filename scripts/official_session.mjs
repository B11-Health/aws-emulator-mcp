/** Read-only companion probe for an AWS Emulator session started by AWS's tools.
 * Never reads credentials, runs AWS CLI, starts Docker, or contacts public AWS.
 * Healthy loopback HTTPS is NOT account identity, package provenance, or fidelity.
 */
import https from 'node:https';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {lstatSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

const MAX_CA = 256 * 1024;
const LOCAL_HOST = '127.0.0.1';

export function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function parseOfficialSessionArgs(args) {
  let port = 9297, json = false, identity = false, seenPort = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--identity' && !identity) { identity = true; continue; }
    if (arg === '--port' && !seenPort) {
      const next = args[++i];
      if (typeof next !== 'string' || !/^[1-9][0-9]{0,4}$/.test(next))
        throw Error('Port must be a decimal integer from 1 to 65535');
      port = Number(next);
      if (!validPort(port)) throw Error('Port must be 1 to 65535');
      seenPort = true;
      continue;
    }
    throw Error('Usage: aws-emulator-mcp official-session [--port 9297] [--identity] [--json]');
  }
  return {port, json, identity};
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


const WORKER = fileURLToPath(new URL('../src/aws_emulator_mcp/official_session_identity.py', import.meta.url));
const IDENTITY_FAILURES = new Set([
  'invalid_port','invalid_certificate_digest','invalid_input',
  'session_directory_untrusted','session_file_untrusted','session_file_changed',
  'session_file_unavailable','session_certificate_changed',
  'session_config_mismatch','emulator_credentials_unrecognized',
  'botocore_unavailable','python_unsupported','network_target_blocked','unexpected_account',
  'sdk_request_failed','probe_unverified',
]);

/** A separate trusted-local worker, never an MCP or PR source-execution path.
 * Only this subprocess may inspect the official per-run emulator credentials.
 * Its environment contains no inherited AWS profiles, endpoints, proxies,
 * web identity providers, container credential sources, or real AWS keys.
 */
export function readOfficialIdentity({port, sessionDir, caSha256}) {
  if (!validPort(port) || !/^[a-f0-9]{64}$/.test(caSha256))
    return {status:'probe_unverified',accountVerified:false};
  const payload = JSON.stringify({schemaVersion:1,port,sessionDir,caSha256});
  const env = {PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'};
  // PATH only locates the Python interpreter. No shell is used and Python -I
  // prevents injection through Python startup and environment import paths.
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])
      if (process.env[key]) env[key]=process.env[key];
  }
  const choices = process.platform === 'win32'
    ? [['py','-3'],['python']]
    : [['python3.12'],['python3.11'],['python3.10'],['python3']];
  for (const [command, ...prefix] of choices) {
    const completed = spawnSync(command,[...prefix,'-I','-B',WORKER],{
      input:payload,encoding:'utf8',timeout:7500,maxBuffer:4096,
      windowsHide:true,shell:false,env,
    });
    if (completed.error?.code === 'ENOENT') continue;
    if (completed.error || completed.signal || ![0,1,2].includes(completed.status))
      return {status:'probe_unverified',accountVerified:false};
    let result;
    try {result=JSON.parse(completed.stdout || '');}
    catch {return {status:'probe_unverified',accountVerified:false};}
    if (result?.schemaVersion !== 1 || result.operation !== 'sts.GetCallerIdentity' ||
        typeof result.accountVerified !== 'boolean' ||
        typeof result.credentialFilesRead !== 'boolean' ||
        typeof result.sdkCallAttempted !== 'boolean')
      return {status:'probe_unverified',accountVerified:false};
    if (completed.status === 0 && result.status === 'verified' &&
        result.accountVerified && result.sdkCallAttempted === true &&
        result.credentialFilesRead === true)
      return {status:'verified',accountVerified:true,
        credentialFilesRead:true,sdkCallAttempted:true};
    if (completed.status !== 0 && !result.accountVerified &&
        IDENTITY_FAILURES.has(result.status)) {
      // Try a different already-installed Python only if botocore was absent.
      if (['botocore_unavailable','python_unsupported'].includes(result.status)) continue;
      return {status:result.status,accountVerified:false,
        credentialFilesRead:result.credentialFilesRead,
        sdkCallAttempted:result.sdkCallAttempted};
    }
    return {status:'probe_unverified',accountVerified:false};
  }
  return {status:'botocore_unavailable',accountVerified:false};
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

export async function inspectOfficialSession({port=9297, home=homedir(), probe=healthRequest,
  identity=false, identityRunner=readOfficialIdentity}={}) {
  if (!validPort(port)) throw Error('Port must be 1 to 65535');
  const base = {schemaVersion: 1, mode: 'official_session_read_only', port,
    endpoint: `https://${LOCAL_HOST}:${port}`, sessionDirectoryRecognized: false,
    localHealthPassed: false, status: 'not_configured',
    dockerOperationsPerformed: false, cloudCallsMade: false, credentialFilesRead: false,
    accountIdentityVerified: false, officialPackageVerified: false,
    applicationBehaviorTested: false, productionAwsValidated: false,
    limitations: identity
      ? 'Only an explicit signed STS identity read against the official local session. No package origin, IAM/fidelity, application behavior or production AWS proof.'
      : 'Local TLS health only. Does not attach this MCP to the session, sign AWS API calls, prove package origin, test IAM/fidelity, or deploy to AWS.'};
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
      const healthy = {...base, status:'healthy', sessionDirectoryRecognized: true,
        localHealthPassed: true,
        nextAction:'Use the official AWS SDK/CLI configuration and verify sts.GetCallerIdentity account 000000000000 before any AWS API test. This MCP still uses independent disposable Docker labs.'};
      if (!identity) return healthy;
      // Health is not identity: deliberately run a second, separately approved
      // local-only process for the one allowlisted STS operation.
      let observed;
      try {observed = await identityRunner({port,sessionDir,
        caSha256:createHash('sha256').update(ca).digest('hex')});}
      catch {observed = {status:'probe_unverified',accountVerified:false};}
      const ok = observed?.status === 'verified' && observed.accountVerified === true;
      const reason = IDENTITY_FAILURES.has(observed?.status)
        ? observed.status : 'probe_unverified';
      return {...healthy, status: ok ? 'identity_verified':'identity_unverified',
        accountIdentityVerified:ok, credentialFilesRead: observed?.credentialFilesRead === true,
        sdkProbe: {operation:'sts.GetCallerIdentity',passed:ok,
          attempted:observed?.sdkCallAttempted === true,
          ...(ok ? {} : {reason})},
        nextAction: ok
          ? 'The local emulator account is verified. Application cases still run in separate disposable Docker labs.'
          : 'Official local STS identity could not be verified. Review the per-run session credentials, configuration, CA, and installed Python botocore; do not run non-STS tests.'};
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
    ...(report.sdkProbe ? [`Signed local STS identity: ${report.accountIdentityVerified ? 'verified account 000000000000':'unverified'}`] : []),
    `No Docker started; ${report.credentialFilesRead ? 'official ephemeral credentials read only in isolated worker':'no credential files read'}; no AWS cloud calls.`,
    report.nextAction, `Limits: ${report.limitations}`].join('\n');
}
