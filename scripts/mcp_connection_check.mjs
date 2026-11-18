/** Explicit, bounded first MCP transport check against an ALREADY cached,
 * source-fingerprint-matched local emulator image. No Docker build, image pull,
 * settings writes, cloud credentials, or production AWS requests.
 */
import {spawnSync} from 'node:child_process';

const MAX_REPLY_BYTES = 256 * 1024;
const IMAGE = 'aws-emulator-mcp:0.4.0-beta.15';
const PROTOCOL_VERSION = '2025-11-25';
const STATUS_ENDPOINT = 'https://127.0.0.1:9297';
const DOCKER_ARGS = Object.freeze(['run', '--rm', '-i', '--pull', 'never', '--network', 'none',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--pids-limit', '256', '--memory', '2g', IMAGE, 'mcp']);

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
  if(typeof stdout !== 'string' || Buffer.byteLength(stdout,'utf8')>MAX_REPLY_BYTES)
    return {reason:'invalid-or-oversize-mcp-stdout'};
  const lines=stdout.trim().split(/\r?\n/);
  if(lines.length!==3 || lines.some(x=>!x || Buffer.byteLength(x,'utf8')>MAX_REPLY_BYTES))
    return {reason:'incomplete-or-extra-mcp-replies'};
  let replies;
  try { replies=lines.map(x=>JSON.parse(x)); } catch { return {reason:'invalid-mcp-json'}; }
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
      status.port!==9297 || status.endpoint!==STATUS_ENDPOINT)
    return {reason:'local-emulator-status-not-ready'};
  return {passed:true, toolCount:listing.tools.length};
}

/** Injectable read-only readiness and Docker runner for deterministic safety tests. */
export function inspectMcpConnection({readiness, fromCheckout=false,
  run=(args,input)=>spawnSync('docker',args,{
    input,encoding:'utf8',timeout:45000,maxBuffer:MAX_REPLY_BYTES,
    shell:false,windowsHide:true
  })}={}) {
  const cli=fromCheckout ? 'node bin/aws-emulator-mcp.mjs' : 'aws-emulator-mcp';
  const report={
    schemaVersion:1,
    check:'first-mcp-stdio-response',
    status:'blocked',
    passed:false,
    stage:'prerequisites',
    reason:'local-docker-not-verified',
    dockerContainerAttempted:false,
    dockerBuildAttempted:false,
    settingsModified:false,
    cloudCallsMade:false,
    handshake:{initialized:false,toolListReceived:false,readOnlyToolReply:false},
    toolCount:null,
    nextCommand:cli+' preflight --json',
    limitations:'Only a local MCP stdio handshake, tool listing, and read-only emulator_status response can pass this check. No desktop GUI connection, AWS SDK call, application proof, production IAM or AWS compatibility is verified.'
  };
  if(readiness?.emulatorReady!==true || readiness?.checks?.docker?.passed!==true) return report;
  if(readiness?.imageReusable!==true || readiness?.imageSourceStatus!=='matched') {
    report.stage='cached-image';
    report.reason='source-matched-local-image-required';
    report.nextCommand=cli+' build';
    return report;
  }
  report.dockerContainerAttempted=true;
  report.stage='stdio';
  report.status='failed';
  report.reason='docker-mcp-transport-failed';
  report.nextCommand=cli+' preflight --json';
  let outcome;
  try {outcome=run([...DOCKER_ARGS],handshakeInput());}catch{return report;}
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
    report.passed ? 'PASS  Local MCP initialize + tools/list + emulator_status responded.' :
      `CHECK  ${report.stage}: ${report.reason}`,
    report.passed ? `Read-only MCP tools listed: ${report.toolCount}` : '',
    `Next: ${report.nextCommand}`,
    'No settings changed, Docker image built, or production AWS called.',
    'This is NOT a Claude Desktop/VS Code GUI verification or an AWS API test.',
  ];
  return lines.filter(Boolean).join('\n')+'\n';
}
