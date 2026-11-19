/** Interpret an ALREADY-SAVED preflight/connect-check JSON report.
 * No subprocess, Docker, network, AWS credentials, application code, or writes.
 * Every displayed command and explanation is authored here, not read from JSON.
 */
import {constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync} from 'node:fs';
import path from 'node:path';

const MAX_BYTES=64*1024;
const PREFLIGHT_KEYS=new Set(['schemaVersion','platform','nodeMajor','architectureReady',
  'emulatorReady','imageCached','imageSourceStatus','imageReusable',
  'hostWorkspaceDisk','hostVisibleDockerRootDisk','imageBuildSpace','dockerVersion',
  'checks','nextCommand','sourceCheckoutCommand','guidance','limitations']);
const CONNECT_KEYS=new Set(['schemaVersion','check','status','passed','stage','reason',
  'daemonEndpointBound','immutableImagePinned','dockerContainerAttempted',
  'dockerBuildAttempted','settingsModified','cloudCallsMade','handshake','toolCount',
  'nextCommand','limitations']);
const CHECK_KEYS=new Set(['node','docker','image']);
const CHECK_ROW_KEYS=new Set(['passed','reason']);
const WORKSPACE_KEYS=new Set(['scope','freeGiB','advisoryThresholdGiB','lowSpaceAdvisory','dockerDataCapacityVerified']);
const ROOT_DISK_KEYS=new Set(['scope','freeGiB','advisoryThresholdGiB','lowSpaceAdvisory','dockerDaemonNamespaceVerified']);
const BUILD_KEYS=new Set(['buildExpected','status','minRecommendedGiB',
  'hostVisibleDockerRootFreeGiB','capacityVerifiedForDaemonNamespace','automaticCleanup','note']);
const HANDSHAKE_KEYS=new Set(['initialized','toolListReceived','readOnlyToolReply']);
const DOCKER_REASONS=new Set([
  '',
  'Nonlocal DOCKER_HOST refused; select a local Unix socket or Windows named pipe',
  'Docker CLI unavailable; install Docker Desktop or Docker Engine',
  'Local Docker context could not be verified; remote contexts are not supported',
  'Local Docker daemon unavailable; start Docker Desktop/Engine and check docker info',
  'Unable to verify Docker daemon type and version',
  'Linux containers required; switch Docker Desktop from Windows containers to Linux containers'
]);
const IMAGE_REASONS=new Set([
  '',
  'First emulator command will build the signed image; requires download and substantial disk space',
  'Cached image source mismatch or unverified; the next emulator command will rebuild the signed local image'
]);
const CONNECT_STAGE_REASONS=Object.freeze({
  prerequisites:new Set(['local-docker-not-verified']),
  'daemon-binding':new Set(['selected-local-docker-endpoint-unverified']),
  'cached-image':new Set(['source-matched-local-image-required',
    'source-matched-immutable-image-required']),
  stdio:new Set(['docker-mcp-transport-failed','invalid-or-oversize-mcp-stdout',
    'incomplete-or-extra-mcp-replies','invalid-mcp-json',
    'mcp-request-error-or-id-mismatch','mcp-handshake-or-tool-list-invalid',
    'read-only-mcp-tool-error','invalid-mcp-tool-status','local-emulator-status-not-ready']),
  complete:new Set(['local-mcp-stdio-read-only-tool-reply'])
});

function valid(o,keys,needed=[]) {
  return o !== null && typeof o==='object' && !Array.isArray(o) &&
    Object.keys(o).every(k=>keys.has(k)) && needed.every(k=>Object.hasOwn(o,k));
}
function oneOf(v,items) {return items.includes(v);}
function optionalBoolean(v) {return v===true || v===false || v===null;}
function measured(v) {return v===null ||
  (typeof v==='number' && Number.isFinite(v) && v>=0 && v<=1000000);}
function safeOpaque(v) {
  // Legacy reports contain authored notes, but they must never be echoed.
  return typeof v==='string' && v.length<=1200 && !/[\x00-\x1f\x7f]/.test(v) &&
    !/(?:[a-z][a-z0-9+.-]*:\/\/|\\\\|\/\/[^ ]+)/i.test(v);
}
function row(v,reasonAllowlist) {
  return valid(v,CHECK_ROW_KEYS,['passed','reason']) &&
    typeof v.passed==='boolean' && reasonAllowlist.has(v.reason) &&
    // A success with a failure reason (or a failure with no reason) is forged
    // or contradictory. This applies equally to Node, Docker, and image rows.
    v.passed === (v.reason === '');
}
function disk(v,keys,expectedScope,verifiedKey) {
  return valid(v,keys,['scope','freeGiB','advisoryThresholdGiB','lowSpaceAdvisory',verifiedKey]) &&
    v.scope===expectedScope && measured(v.freeGiB) && v.advisoryThresholdGiB===10 &&
    optionalBoolean(v.lowSpaceAdvisory) && v[verifiedKey]===false &&
    (v.freeGiB===null ? v.lowSpaceAdvisory===null :
      v.lowSpaceAdvisory===(v.freeGiB<10));
}
function buildSpace(v) {
  return valid(v,BUILD_KEYS,[...BUILD_KEYS]) && optionalBoolean(v.buildExpected) &&
    oneOf(v.status,['not_needed','unknown','critical','low','normal']) &&
    v.minRecommendedGiB===3 && measured(v.hostVisibleDockerRootFreeGiB) &&
    v.capacityVerifiedForDaemonNamespace===false && v.automaticCleanup===false &&
    safeOpaque(v.note) &&
    (v.status==='not_needed' ? v.buildExpected===false :
     ['critical','low','normal'].includes(v.status) ? v.buildExpected===true &&
       v.hostVisibleDockerRootFreeGiB!==null &&
       (v.status==='critical' ? v.hostVisibleDockerRootFreeGiB<3 :
        v.status==='low' ? v.hostVisibleDockerRootFreeGiB>=3 && v.hostVisibleDockerRootFreeGiB<10 :
        v.hostVisibleDockerRootFreeGiB>=10) : true);
}

function validatePreflight(r) {
  if(!valid(r,PREFLIGHT_KEYS,[...PREFLIGHT_KEYS]) || r.schemaVersion!==1 ||
     !oneOf(r.platform,['win32','darwin','linux']) ||
     !(r.nodeMajor===null || (Number.isInteger(r.nodeMajor) && r.nodeMajor>=0 && r.nodeMajor<=255)) ||
     typeof r.architectureReady!=='boolean' || typeof r.emulatorReady!=='boolean' ||
     !optionalBoolean(r.imageCached) || !optionalBoolean(r.imageReusable) ||
     !oneOf(r.imageSourceStatus,['not-checked','matched','mismatched','unverified']) ||
     !valid(r.checks,CHECK_KEYS,['node','docker']) ||
     !row(r.checks.node,new Set(['','Node.js 20+ required'])) ||
     !row(r.checks.docker,DOCKER_REASONS) ||
     (Object.hasOwn(r.checks,'image') && !row(r.checks.image,IMAGE_REASONS)) ||
     !disk(r.hostWorkspaceDisk,WORKSPACE_KEYS,'host-current-working-directory-volume','dockerDataCapacityVerified') ||
     !(r.hostVisibleDockerRootDisk===null || disk(r.hostVisibleDockerRootDisk,ROOT_DISK_KEYS,
       'host-visible-docker-data-root-volume','dockerDaemonNamespaceVerified')) ||
     !buildSpace(r.imageBuildSpace) ||
     !(r.dockerVersion===null || (typeof r.dockerVersion==='string' && /^[A-Za-z0-9][A-Za-z0-9 .+_-]{0,99}$/.test(r.dockerVersion))) ||
     !safeOpaque(r.nextCommand) || !safeOpaque(r.sourceCheckoutCommand) ||
     !safeOpaque(r.guidance) || !safeOpaque(r.limitations)) throw Error('invalid preflight report');
  const expectedBuild=r.imageReusable===true ? false :
    r.imageReusable===false || r.imageCached===false ? true : null;
  if(r.architectureReady!==r.checks.node.passed ||
     r.checks.node.passed !== (r.nodeMajor!==null && r.nodeMajor>=20) ||
     r.emulatorReady!==(r.checks.node.passed && r.checks.docker.passed) ||
     r.checks.docker.passed !== (r.dockerVersion!==null) ||
     Object.hasOwn(r.checks,'image') !== (r.imageCached!==null) ||
     r.imageBuildSpace.buildExpected !== expectedBuild ||
     (r.imageReusable===true && (r.imageCached!==true || r.imageSourceStatus!=='matched')) ||
     (r.imageSourceStatus==='matched' && r.imageReusable!==true) ||
     (r.imageSourceStatus==='mismatched' && r.imageReusable!==false) ||
     (r.imageCached===null && r.imageSourceStatus!=='not-checked') ||
     (r.imageBuildSpace.buildExpected===false && r.imageReusable!==true) ||
     (r.imageBuildSpace.buildExpected===true && r.imageReusable===true))
    throw Error('contradictory preflight report');
  return {kind:'preflight',platform:r.platform,report:r};
}
function validateConnect(r,currentPlatform) {
  if(!valid(r,CONNECT_KEYS,[...CONNECT_KEYS]) || r.schemaVersion!==1 ||
     r.check!=='first-mcp-stdio-response' ||
     !oneOf(r.status,['passed','blocked','failed']) || typeof r.passed!=='boolean' ||
     !oneOf(r.stage,['prerequisites','cached-image','daemon-binding','stdio','complete']) ||
     !CONNECT_STAGE_REASONS[r.stage]?.has(r.reason) ||
     !['daemonEndpointBound','immutableImagePinned','dockerContainerAttempted',
       'dockerBuildAttempted','settingsModified','cloudCallsMade'].every(k=>typeof r[k]==='boolean') ||
     r.dockerBuildAttempted || r.settingsModified || r.cloudCallsMade ||
     !valid(r.handshake,HANDSHAKE_KEYS,[...HANDSHAKE_KEYS]) ||
     ![...HANDSHAKE_KEYS].every(k=>typeof r.handshake[k]==='boolean') ||
     !(r.toolCount===null || (Number.isInteger(r.toolCount) && r.toolCount>=1 && r.toolCount<=100)) ||
     !safeOpaque(r.nextCommand) || !safeOpaque(r.limitations)) throw Error('invalid connection report');
  if(r.passed!==(r.status==='passed') ||
     r.status!==(r.stage==='complete'?'passed':r.stage==='stdio'?'failed':'blocked') ||
     (r.passed && (r.stage!=='complete' ||
       !r.daemonEndpointBound || !r.immutableImagePinned ||
       !r.dockerContainerAttempted || !Object.values(r.handshake).every(Boolean) || r.toolCount===null)) ||
     (!r.passed && (r.stage==='complete' || Object.values(r.handshake).some(Boolean) || r.toolCount!==null)) ||
     (r.stage==='prerequisites' && (r.daemonEndpointBound || r.immutableImagePinned || r.dockerContainerAttempted)) ||
     (r.stage==='daemon-binding' && (r.daemonEndpointBound || r.immutableImagePinned || r.dockerContainerAttempted)) ||
     (r.stage==='cached-image' && (r.immutableImagePinned || r.dockerContainerAttempted ||
       r.daemonEndpointBound !== (r.reason==='source-matched-immutable-image-required'))) ||
     (r.stage==='stdio' && (!r.daemonEndpointBound || !r.immutableImagePinned || !r.dockerContainerAttempted)))
    throw Error('contradictory connection report');
  return {kind:'connect-check',platform:currentPlatform,report:r};
}
export function parseReport(report,{platform=process.platform}={}) {
  if(!oneOf(platform,['win32','darwin','linux'])) throw Error('unsupported interpreter platform');
  if(!valid(report,new Set([...PREFLIGHT_KEYS,...CONNECT_KEYS])))
    throw Error('invalid report structure');
  if(Object.hasOwn(report,'check')) return validateConnect(report,platform);
  return validatePreflight(report);
}

/** Refuse URLs, UNC shares, drive-relative paths, NTFS alternate streams,
 * Windows device names (on every host), traversal, and symlinks.
 * Only the single absolute Windows drive prefix may contain a colon.
 */
const WINDOWS_DEVICES=/^(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3]|CONIN\$|CONOUT\$|CLOCK\$)$/i;
function reservedWindowsPart(part) {
  // Windows treats device names as reserved even before extensions; e.g.
  // NUL.json and COM1.backup.json are devices, not ordinary JSON files.
  const stem=part.split('.')[0].replace(/ +$/,'');
  return WINDOWS_DEVICES.test(stem);
}
export function safeReportPath(value,{platform=process.platform}={}) {
  if(typeof value!=='string' || !value || value.length>512 || value.startsWith('-') ||
     !/\.json$/i.test(value) || /[\x00-\x1f\x7f]/.test(value) ||
     /^[/\\]{2}/.test(value) || /^(?:[a-z][a-z0-9+.-]*):\/\//i.test(value) ||
     value.split(/[\\/]/).includes('..') ||
     value.split(/[\\/]/).some(reservedWindowsPart) ||
     (platform==='win32' && value.startsWith('\\'))) return false;
  const drive=/^[a-z]:[\\/]/i.test(value);
  if(drive) {
    // Drive-absolute C:\\folder\\report.json is legitimate on Windows;
    // C:\\folder\\report.txt:secret.json is an NTFS alternate data stream.
    return platform==='win32' && !value.slice(2).includes(':');
  }
  // Any other colon is unsafe on every host, including Windows drive-relative
  // C:report.json and ADS on relative paths. Block backslashes on POSIX.
  return !value.includes(':') && (platform==='win32' || !value.includes('\\'));
}
export function readLocalReport(filename,{platform=process.platform}={}) {
  if(!safeReportPath(filename,{platform})) throw Error('invalid local report path');
  const real=realpathSync(filename);
  if(!safeReportPath(real,{platform})) throw Error('unsafe resolved report path');
  const before=lstatSync(filename);
  if(!before.isFile() || before.isSymbolicLink() || before.size<=0 || before.size>MAX_BYTES)
    throw Error('invalid report file');
  const fd=openSync(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try {
    const after=fstatSync(fd);
    if(!after.isFile() || after.size<=0 || after.size>MAX_BYTES ||
       after.ino!==before.ino || after.dev!==before.dev)
      throw Error('changed report file');
    const raw=readFileSync(fd,{encoding:'utf8'});
    if(Buffer.byteLength(raw,'utf8')>MAX_BYTES) throw Error('oversize report');
    return JSON.parse(raw);
  } finally {closeSync(fd);}
}

const action=(id,where,command,why,when='Run manually; nothing is executed by rescue.')=>
  ({id,where,command,why,when});
const BOILERPLATE='Interpreting saved JSON only: no Docker probing, image build/pull, AWS requests, configuration edits, or client connection occurred.';
const PROOF_LIMIT='An offline architecture check is not an AWS API test. A passing terminal MCP handshake is NOT a Claude Desktop/VS Code GUI connection, an application test, or production AWS/IAM proof.';
const BUILD_WARNING='Build is an OPTIONAL, separate, user-approved action: it downloads and verifies the official signed AWS Emulator package, then builds a sizable local Docker image. It needs network access and sufficient Docker Engine/Desktop VM storage. Inspect actual Docker storage first. No image prune, deletion or build is ever automatic.';
const DISK_WARNING='Disk thresholds are conservative advisories: below 3 GiB is critical for a pending build; below 10 GiB triggers a lower-space warning. Host CWD/data-root readings do NOT verify free space inside the Docker Desktop VM or the daemon filesystem.';
const osName=p=>p==='win32'?'Windows PowerShell':p==='darwin'?'macOS Terminal':'Linux shell';
const dockerExecutable=p=>p==='win32'?'Get-Command docker':'command -v docker';
const nodeExecutable=p=>p==='win32'?'Get-Command node':'command -v node';
const cliCommand=mode=>mode==='checkout'?'node bin/aws-emulator-mcp.mjs':
  mode==='local-package-posix'?'./node_modules/.bin/aws-emulator-mcp':
  mode==='local-package-win32'?'.\\node_modules\\.bin\\aws-emulator-mcp.cmd':'aws-emulator-mcp';
export function interpretReport(source,{platform=process.platform,invocation='checkout'}={}) {
  if(!oneOf(invocation,['checkout','local-package-posix','local-package-win32','global']))
    throw Error('invalid command context');
  const {kind,report,platform:target}=parseReport(source,{platform});
  // If the preflight report came from a different OS, give commands for THAT
  // machine, including the local npm .cmd shim rather than the current host.
  const localPackage=invocation==='local-package-posix' || invocation==='local-package-win32';
  const command=cliCommand(localPackage ?
    (target==='win32'?'local-package-win32':'local-package-posix') : invocation);
  const run=(suffix)=>command+' '+suffix;
  const warnings=[BOILERPLATE,PROOF_LIMIT];
  if(kind==='preflight' && target!==platform) warnings.push(
    'This saved preflight was created on a different operating system. Run the suggested commands on the original '+osName(target)+' machine, not on this interpreter host.');
  let title='',summary='',actions=[];
  const add=(...items)=>actions.push(...items);
  if(kind==='preflight') {
    if(!report.checks.node.passed){
      title='Node.js prerequisite missing';
      summary='Install Node.js 20 or newer manually from the official Node.js website, then verify your PATH. No installer is launched by this report.';
      add(action('locate-node','terminal',nodeExecutable(target),'Check whether the Node executable is on this machine.'),
        action('version-node','terminal','node --version','Confirm major version 20 or newer after installing or updating Node.'));
    } else if(!report.checks.docker.passed){
      const reason=report.checks.docker.reason;
      const isRemote=reason.includes('Nonlocal DOCKER_HOST') || reason.includes('remote contexts');
      const isMissing=reason.includes('Docker CLI unavailable');
      const wrongOS=reason.includes('Linux containers required');
      title=isRemote?'Remote or unverified Docker context':isMissing?'Docker CLI unavailable':
        wrongOS?'Docker is using Windows containers':'Local Docker Engine not ready';
      summary=isRemote?'Select a trusted LOCAL Unix socket or Windows named-pipe Docker context manually. Do not connect to a remote daemon to work around the restriction.':
        wrongOS?'Use Docker Desktop in Linux-container mode; switching modes is a deliberate GUI action.':
        'Install or start a trusted local Docker Desktop/Engine manually if you need emulator-backed tests. Offline architecture checks do not require Docker.';
      if(isMissing) add(action('locate-docker','terminal',dockerExecutable(target),'Check whether the Docker CLI is available.'));
      add(action('inspect-context','terminal','docker context ls','Review the selected context. Do not choose remote SSH/TCP endpoints.'),
        action('retry-preflight','terminal',run('preflight --json'),'Only AFTER selecting/starting a trusted local Linux-container engine; this performs a new read-only probe.'));
    } else if(report.imageReusable!==true || report.imageSourceStatus!=='matched'){
      title='Signed emulator image not ready for reuse';
      summary='Docker prerequisites are present, but the versioned image is missing, stale or its local source fingerprint was not verified. Do not interpret Docker readiness as emulator readiness.';
      warnings.push(DISK_WARNING,BUILD_WARNING);
      const critical=report.imageBuildSpace.status==='critical';
      if(critical) warnings.push('CRITICAL: saved host-visible Docker data-root reading is below the 3 GiB conservative warning threshold. Review capacity before considering any build.');
      if(report.imageBuildSpace.status==='low' || report.hostWorkspaceDisk.lowSpaceAdvisory)
        warnings.push('LOW SPACE: saved host-volume advisory is below 10 GiB; do not assume Docker Desktop VM capacity is sufficient.');
      add(action('inspect-docker-storage','terminal','docker system df','Read-only Docker storage overview. Use ONLY after verifying a trusted local context.'));
      if(!critical) add(action('opt-in-build','terminal',run('build'),
        'OPTIONAL explicit signed download and image build; do not run until you personally approve after checking Docker disk capacity and network availability.'));
      add(action('retry-preflight','terminal',run('preflight --json'),
        'Recheck the local cache fingerprint AFTER any manual remediation or approved build.'));
    } else {
      title='Docker prerequisites and cached image appear ready';
      summary='Preflight alone did not launch the emulator or receive an MCP tool reply. The next check is a separate explicit local terminal handshake.';
      add(action('check-mcp-stdio','terminal',run('connect-check --json'),
        'Explicitly starts one isolated local MCP container ONLY if the source-matched cache and daemon binding are validated; never builds or pulls an image.'));
    }
  } else {
    if(report.passed){
      title='Terminal MCP handshake passed (GUI still unverified)';
      summary='The saved diagnostic reports an MCP initialize, tool list and read-only emulator_status with exact lowercase ok. The desktop app has not been checked.';
      add(action('show-claude-config','terminal',run('config claude'),
        'Review the JSON and merge its aws-emulator-local entry into Claude Desktop yourself; existing settings are not modified.'),
        action('show-copilot-config','terminal',run('config copilot'),
          'Alternative for VS Code Copilot; review and install the printed entry yourself.'),
        action('verify-gui','MCP client prompt','Call emulator_doctor and show its tool result.',
          'Copy into your actual configured assistant after connecting. Only the real GUI tool response can verify that client connection.'));
    } else if(report.stage==='prerequisites'){
      title='Local prerequisites were not verified';
      summary='The saved connection check stopped before opening a Docker container. Use a separate preflight only after selecting a trusted local Docker Engine.';
      add(action('inspect-context','terminal','docker context ls','Inspect local vs remote Docker context; do not use remote SSH/TCP endpoints.'),
        action('inspect-preflight','terminal',run('preflight --json'),'Runs a new read-only local Docker preflight only when you explicitly choose to.'));
    } else if(report.stage==='daemon-binding'){
      title='Docker daemon endpoint could not be pinned';
      summary='The selected socket/pipe or Linux daemon could not be validated. Do not bypass the local-only host guard.';
      add(action('inspect-context','terminal','docker context ls','Inspect and select a trusted local socket/pipe context manually.'),
        action('inspect-preflight','terminal',run('preflight --json'),'Recheck local Docker context after you fix its configuration.'));
    } else if(report.stage==='cached-image'){
      title='No verified immutable emulator image for this connection';
      summary='The cached image was absent, stale or failed source-label/image-ID validation. A mutable tag is not enough.';
      warnings.push(DISK_WARNING,BUILD_WARNING);
      add(action('inspect-docker-storage','terminal','docker system df','Read-only overview; use only with a verified local Docker context.'),
        action('opt-in-build','terminal',run('build'),'OPTIONAL explicit signed image build, only after personal disk/network review.'),
        action('retry-connection','terminal',run('connect-check --json'),'Run separately after the approved build; this check never builds or pulls.'));
    } else {
      title='MCP transport or read-only status check failed';
      summary='An isolated terminal container did not return the exact expected MCP protocol and healthy loopback status. A failing status is not a passing AWS API test.';
      add(action('inspect-preflight','terminal',run('preflight --json'),'Check local Docker prerequisites and source cache identity again.'),
        action('retry-connection','terminal',run('connect-check --json'),'Retry only after correcting the local issue; expect an exact lowercase ok status body.'));
    }
  }
  if(actions.length<1 || actions.length>3) throw Error('invalid action count');
  return {schemaVersion:1,mode:'offline-saved-report-rescue',source:kind,
    platform:target,shell:osName(target),title,summary,actions,warnings,
    userApprovalRequiredForBuild:actions.some(a=>a.id==='opt-in-build'),
    toolCallsMade:false,settingsModified:false,emulatorApiTested:false,
    desktopGuiVerified:false};
}
export function formatRescue(o) {
  const out=[`AWS Emulator MCP / saved ${o.source} rescue (${o.shell})`,
    o.title,o.summary,'','Copy only the actions that apply, in order:'];
  o.actions.forEach((a,i)=>out.push(`${i+1}. ${a.id} (${a.where})`,
    `   ${a.command}`,`   Why: ${a.why}`,`   When: ${a.when}`));
  out.push('',...o.warnings.map(x=>'CAUTION: '+x),'');
  return out.join('\n');
}
