/** Explicit first MCP stdio check against an already cached, source-matched image.
 * Revalidates the local Docker daemon and image on one pinned --host endpoint,
 * then runs a content-addressed image ID. Never builds, pulls, prunes, edits
 * desktop settings, forwards AWS credentials, or contacts production AWS.
 */
import {spawnSync} from 'node:child_process';

const MAX_REPLY_BYTES = 256 * 1024;
const IMAGE = 'aws-emulator-mcp:0.4.0-beta.15';
const SOURCE_LABEL = 'dev.aws-emulator-mcp.source-sha256';
const FINGERPRINT = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const PROTOCOL_VERSION = '2025-11-25';
const STATUS_ENDPOINT = 'https://127.0.0.1:9297';
const HEALTH_BODY = 'ok';
const DOCKER_RUN_ARGS = Object.freeze(['run', '--rm', '-i', '--pull', 'never',
  '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--pids-limit', '256', '--memory', '2g']);
const CONTEXT_FORMAT = '{{json .Endpoints.docker.Host}}';
const IMAGE_FORMAT = `{{.Id}}|{{index .Config.Labels "${SOURCE_LABEL}"}}`;

/** Preserve the selected context only for read-only context inspection.
 * A pinned --host must not be overridden by ambient Docker context settings.
 * No host AWS credential environment is needed by this local Docker workflow.
 */
export function dockerChildEnv(source=process.env, pinned=false) {
  const env={...source};
  for(const key of Object.keys(env)) if(key.startsWith('AWS_')) delete env[key];
  if(pinned) {
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;
    delete env.DOCKER_TLS_VERIFY;
    delete env.DOCKER_CERT_PATH;
  }
  return env;
}
function dockerCommand(args, input, {pinned=false, timeout=6000}={}) {
  return spawnSync('docker',args,{
    input,encoding:'utf8',timeout,maxBuffer:MAX_REPLY_BYTES,
    shell:false,windowsHide:true,env:dockerChildEnv(process.env,pinned)
  });
}

/** Unix paths can contain spaces (including macOS user names); never use a shell. */
function localSocket(endpoint) {
  if(typeof endpoint!=='string' || endpoint.length>512 ||
      /[\x00-\x1f\x7f]/.test(endpoint)) return false;
  if(endpoint.startsWith('unix:///')) {
    const name=endpoint.slice('unix://'.length);
    return name.startsWith('/') && !name.startsWith('//') && name!=='/' &&
      !/[\\?#]/.test(name) &&
      !name.split('/').some(part=>part==='.' || part==='..');
  }
  return /^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]{1,120}$/.test(endpoint);
}

function request(id, method, params) {
  return {jsonrpc:'2.0', id, method, ...(params ? {params} : {})};
}

export function handshakeInput() {
  return [
    request(1,'initialize',{
      protocolVersion:PROTOCOL_VERSION, capabilities:{},
      clientInfo:{name:'aws-emulator-mcp-connection-check',version:'1.0.0'}
    }),
    {jsonrpc:'2.0',method:'notifications/initialized'},
    request(2,'tools/list'),
    request(3,'tools/call',{name:'emulator_status',arguments:{}})
  ].map(line=>JSON.stringify(line)).join('\n')+'\n';
}

function checkedReplies(stdout) {
  if(typeof stdout!=='string' || Buffer.byteLength(stdout,'utf8')>MAX_REPLY_BYTES)
    return {reason:'invalid-or-oversize-mcp-stdout'};
  const lines=stdout.trim().split(/\r?\n/);
  if(lines.length!==3 || lines.some(x=>!x || Buffer.byteLength(x,'utf8')>MAX_REPLY_BYTES))
    return {reason:'incomplete-or-extra-mcp-replies'};
  let replies;
  try {replies=lines.map(x=>JSON.parse(x));} catch {return {reason:'invalid-mcp-json'};}
  if(replies.some((x,i)=>!x || typeof x!=='object' || Array.isArray(x) ||
      x.jsonrpc!=='2.0' || x.id!==i+1 || x.error || !x.result ||
      typeof x.result!=='object')) return {reason:'mcp-request-error-or-id-mismatch'};
  const [init,listing,called]=replies.map(x=>x.result);
  if(init.protocolVersion!==PROTOCOL_VERSION ||
      init.serverInfo?.name!=='aws-emulator-mcp' ||
      !Array.isArray(listing.tools) || listing.tools.length<1 || listing.tools.length>100 ||
      !listing.tools.some(x=>x && x.name==='emulator_status'))
    return {reason:'mcp-handshake-or-tool-list-invalid'};
  if(called.isError!==false || !Array.isArray(called.content) || called.content.length!==1 ||
      called.content[0]?.type!=='text' || typeof called.content[0].text!=='string' ||
      Buffer.byteLength(called.content[0].text,'utf8')>16384)
    return {reason:'read-only-mcp-tool-error'};
  let status;
  try {status=JSON.parse(called.content[0].text);}catch{return {reason:'invalid-mcp-tool-status'};}
  if(!status || status.running!==true || status.installed!==true ||
      status.port!==9297 || status.endpoint!==STATUS_ENDPOINT || status.body!==HEALTH_BODY)
    return {reason:'local-emulator-status-not-ready'};
  return {passed:true,toolCount:listing.tools.length};
}

/** Dependency-injected Docker command lets tests prove every path without running a container.
 * The first context selection is read-only. All later Docker operations include
 * --host with the verified socket; image inspect checks ID+label in one request.
 */
export function inspectMcpConnection({readiness,expectedImageDigest=null,fromCheckout=false,
  dockerHost=process.env.DOCKER_HOST,
  run=dockerCommand}={}) {
  const cli=fromCheckout ? 'node bin/aws-emulator-mcp.mjs' : 'aws-emulator-mcp';
  const report={
    schemaVersion:1,check:'first-mcp-stdio-response',status:'blocked',passed:false,
    stage:'prerequisites',reason:'local-docker-not-verified',
    daemonEndpointBound:false,immutableImagePinned:false,
    dockerContainerAttempted:false,dockerBuildAttempted:false,
    settingsModified:false,cloudCallsMade:false,
    handshake:{initialized:false,toolListReceived:false,readOnlyToolReply:false},
    toolCount:null,nextCommand:cli+' preflight --json',
    limitations:'Only a local MCP stdio handshake, tool listing, and read-only emulator_status with exact healthy response body can pass this check. A pinned local Docker socket and image ID are independently verified. No desktop GUI connection, AWS SDK call, application proof, production IAM or AWS compatibility is verified.'
  };
  if(readiness?.emulatorReady!==true || readiness?.checks?.docker?.passed!==true) return report;
  if(readiness?.imageReusable!==true || readiness?.imageSourceStatus!=='matched' ||
      !FINGERPRINT.test(expectedImageDigest||'')) {
    report.stage='cached-image';
    report.reason='source-matched-local-image-required';
    report.nextCommand=cli+' build';
    return report;
  }
  const inspect=(args,pinned=false)=>{
    let result;
    try {result=run(args,undefined,{pinned,timeout:6000});} catch {return null;}
    if(result?.status!==0 || result.error || typeof result.stdout!=='string' ||
        Buffer.byteLength(result.stdout,'utf8')>MAX_REPLY_BYTES) return null;
    return result.stdout.trim();
  };
  report.stage='daemon-binding';
  report.reason='selected-local-docker-endpoint-unverified';
  const context=inspect(['context','inspect','--format',CONTEXT_FORMAT]);
  let endpoint=null;
  try {endpoint=JSON.parse(context);} catch {return report;}
  if(!localSocket(endpoint) || (dockerHost && dockerHost!==endpoint)) return report;
  const info=inspect(['--host',endpoint,'info','--format','{{.OSType}}'],true);
  if(info!=='linux') return report;
  report.daemonEndpointBound=true;
  report.stage='cached-image';
  report.reason='source-matched-immutable-image-required';
  const evidence=inspect(['--host',endpoint,'image','inspect',IMAGE,'--format',IMAGE_FORMAT],true);
  if(!evidence) return report;
  const match=/^(sha256:[a-f0-9]{64})\|([a-f0-9]{64})$/.exec(evidence);
  if(!match || !IMAGE_ID.test(match[1]) || match[2]!==expectedImageDigest) return report;
  const imageId=match[1];
  report.immutableImagePinned=true;
  report.dockerContainerAttempted=true;
  report.stage='stdio';
  report.status='failed';
  report.reason='docker-mcp-transport-failed';
  report.nextCommand=cli+' preflight --json';
  let outcome;
  try {
    outcome=run(['--host',endpoint,...DOCKER_RUN_ARGS,imageId,'mcp'],handshakeInput(),
      {pinned:true,timeout:45000});
  } catch {return report;}
  if(outcome?.error || outcome?.status!==0) return report;
  const checked=checkedReplies(outcome.stdout);
  if(!checked.passed){report.reason=checked.reason;return report;}
  report.passed=true;
  report.status='passed';
  report.stage='complete';
  report.reason='local-mcp-stdio-read-only-tool-reply';
  report.handshake={initialized:true,toolListReceived:true,readOnlyToolReply:true};
  report.toolCount=checked.toolCount;
  report.nextCommand='Open your configured desktop assistant and invoke emulator_doctor; verify the actual tool reply there.';
  return report;
}

export function formatMcpConnection(report) {
  const lines=[
    'AWS Emulator MCP / first MCP response check (explicit, no image build)',
    report.passed ? 'PASS  Local MCP initialize + tools/list + emulator_status with exact lowercase ok health body responded.' :
      `CHECK  ${report.stage}: ${report.reason}`,
    report.passed ? `Read-only MCP tools listed: ${report.toolCount}` : '',
    `Next: ${report.nextCommand}`,
    'No settings changed, Docker image built, or production AWS called.',
    'This is NOT a Claude Desktop/VS Code GUI verification or an AWS API test.',
  ];
  return lines.filter(Boolean).join('\n')+'\n';
}
