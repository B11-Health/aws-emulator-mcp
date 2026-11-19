/** Desktop MCP startup: inspect the chosen LOCAL Docker daemon and pin the
 * immutable, source-matched image before Docker run. No container is started
 * during inspection. This does not constitute an MCP handshake or GUI proof.
 */
import {spawnSync} from 'node:child_process';
import {dockerChildEnv,localSocket} from './mcp_connection_check.mjs';

const IMAGE='aws-emulator-mcp:0.4.0-beta.15';
const LABEL='dev.aws-emulator-mcp.source-sha256';
const FINGERPRINT=/^[a-f0-9]{64}$/;
const INSPECTED=/^(sha256:[a-f0-9]{64})\|([a-f0-9]{64})$/;
const CONTEXT_FORMAT='{{json .Endpoints.docker.Host}}';
const IMAGE_FORMAT=`{{.Id}}|{{index .Config.Labels "${LABEL}"}}`;

function dockerRead(args,{pinned=false,timeout=10000}={}) {
  return spawnSync('docker',args,{
    encoding:'utf8',timeout,maxBuffer:16*1024,windowsHide:true,
    shell:false,env:dockerChildEnv(process.env,pinned)
  });
}

/** Inert-testable verification. Report reasons are fixed codes, never Docker
 * output or a user-controlled path; Docker is contacted only on the selected
 * socket/pipe with --host after local context inspection.
 */
export function inspectMcpStartup({
  image=IMAGE,expectedImageDigest,dockerHost=process.env.DOCKER_HOST,
  run=dockerRead
}={}) {
  const blocked=reason=>({ready:false,reason});
  if(!FINGERPRINT.test(expectedImageDigest||''))
    return blocked('source-fingerprint-unavailable');
  if(dockerHost && !localSocket(dockerHost))
    return blocked('nonlocal-docker-host-refused');
  const inspect=(args,pinned=false)=>{
    let observed;
    try {observed=run(args,{pinned,timeout:10000});}catch{return null;}
    if(observed?.error||observed?.status!==0||typeof observed.stdout!=='string'||
       Buffer.byteLength(observed.stdout,'utf8')>16*1024) return null;
    return observed.stdout.trim();
  };
  const context=inspect(['context','inspect','--format',CONTEXT_FORMAT]);
  let endpoint;
  try {endpoint=JSON.parse(context);}catch{return blocked('local-context-unverified');}
  if(!localSocket(endpoint)||(dockerHost&&dockerHost!==endpoint))
    return blocked('local-context-unverified');
  // Explicit --host and a clean Docker environment prevent a concurrent
  // DOCKER_CONTEXT/DOCKER_HOST switch from changing the verified daemon.
  const info=inspect(['--host',endpoint,'info','--format','{{.OSType}}'],true);
  if(info!=='linux')return blocked('local-linux-daemon-unverified');
  // Obtain the content-addressed image ID and source label atomically from
  // ONE image inspect on that same daemon. Never trust a mutable image tag
  // during subsequent container execution.
  const inspected=inspect(['--host',endpoint,'image','inspect',image,
    '--format',IMAGE_FORMAT],true);
  const match=typeof inspected==='string'&&inspected.match(INSPECTED);
  if(!match||match[2]!==expectedImageDigest)
    return blocked('source-matched-immutable-image-required');
  return {ready:true,endpoint,imageId:match[1]};
}
