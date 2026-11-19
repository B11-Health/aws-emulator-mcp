# Rescue a failed first run without running another probe

**Round-four development preview only.** The `rescue` command reads an **already saved**
`preflight --json` or `connect-check --json` file and prints at most **three**
platform-aware, copyable next actions. It does not run those actions, call
Docker or AWS, read credentials, install software, build images, edit a desktop
configuration, or connect to an MCP client. It is different from `onboard`,
which generates a new seven-artifact *architecture-only* result and may perform
read-only Docker preflight unless `--offline` is selected.

## Safe R4 clone, verify, and rescue

The mutable R4 preview branch `release/agent-team-preview-r4-20261118` can move when a fix lands. The published `v0.4.0-beta.15`, `master`, and R3 do **not** include this draft `rescue` workflow. Do **not** use an old, static audit SHA as a default. Verify the current branch HEAD, then **independently inspect the source and current head of [PR #91](https://github.com/B11-Health/aws-emulator-mcp/pull/91)** before entering the full reviewed SHA. If the PR branch or HEAD does not match, **STOP**.

Each platform has two separate, copyable blocks. **Step 1 only clones. Step 2 runs a host-supplied inline Node verification script before any Node code from the clone.** The inline guard is part of the instructions, not imported from the unchecked checkout. It compares the reviewed SHA with the current remote ref; checks the root and origin; disables Git replacement objects; rejects replacement refs, hidden `assume-unchanged` / `skip-worktree` flags, index/tree mismatches, submodules and symlinks; hashes the **actual bytes** of all tracked files against the reviewed Git commit; and refuses unexpected extra files. It rechecks branch and index flags before executing the saved-report interpreter. These checks establish checkout consistency, **not third-party source attestation**. Never skip source review because a hash matches. No Docker or AWS call is made by `rescue`.

The only allowed untracked files *inside* the checkout are regular, root-level `preflight-report.json` and `connect-report.json`; any other saved JSON should remain **outside** the checkout and be passed by quoted absolute local path. This avoids using ignored or hidden extra code by accident. The selected report is still validated separately by the interpreter. The source checkout should be a fresh folder; never reuse a failed clone.

### macOS / Linux (POSIX shell)

**Step 1 — clone only; fail on an existing destination (no project code):**

```sh
(
  set -eu
  repo='aws-emulator-mcp-r4'
  test ! -e "$repo" || { echo 'STOP: checkout directory already exists' >&2; exit 1; }
  git clone --config core.autocrlf=false --depth 1 --branch release/agent-team-preview-r4-20261118 https://github.com/B11-Health/aws-emulator-mcp.git "$repo" || exit 1
)
```

**Step 2 — compare the PR's current head yourself, then paste this verification block:**

```sh
(
  set -eu
  repo='aws-emulator-mcp-r4'
  report='./preflight-report.json'  # Or a quoted absolute path outside checkout
  head=$(git -C "$repo" rev-parse --verify HEAD) || exit 1
  remote=$(git ls-remote --exit-code https://github.com/B11-Health/aws-emulator-mcp.git refs/heads/release/agent-team-preview-r4-20261118) || exit 1
  test "$remote" = "$(printf '%s\t%s' "$head" refs/heads/release/agent-team-preview-r4-20261118)" || { echo 'STOP: R4 remote HEAD differs' >&2; exit 1; }
  echo "Current R4 head: $head"
  echo 'Open https://github.com/B11-Health/aws-emulator-mcp/pull/91; review and compare its CURRENT head.'
  test -t 0 || { echo 'STOP: human source review required' >&2; exit 1; }
  printf 'Type the entire PR #91 SHA you independently reviewed: '
  IFS= read -r reviewed || exit 1
  test "$reviewed" = "$head" || { echo 'STOP: PR head not confirmed' >&2; exit 1; }
  node - "$reviewed" "$repo" "$report" <<'RESCUE_CHECKOUT_GUARD'
// Inline, host-Node guard: verifies the checkout BEFORE loading its code.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const cp=require('node:child_process');
const reviewed=process.argv[2];
const dir=process.argv[3];
const report=process.argv[4];
const origin='https://github.com/B11-Health/aws-emulator-mcp.git';
const branch='release/agent-team-preview-r4-20261118';
const ref='refs/heads/'+branch;
const env={...process.env};
for(const name of Object.keys(env))if(name.startsWith('GIT_')||name.startsWith('AWS_'))delete env[name];
env.GIT_NO_REPLACE_OBJECTS='1';
const stop=reason=>{throw Error(reason)};
const git=(args)=>cp.execFileSync('git',['-c','core.fsmonitor=false','-C',dir,...args],{
  env,encoding:'buffer',maxBuffer:16*1024*1024,stdio:['ignore','pipe','ignore']
});
const txt=args=>git(args).toString('utf8').trim();
const nul=args=>git(args).toString('utf8').split('\0').filter(Boolean);
try {
  if(!/^[0-9a-f]{40}$/.test(reviewed||''))stop('invalid reviewed SHA');
  const root=path.resolve(dir);
  const eqPath=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
  if(!eqPath(fs.realpathSync(root),root))stop('symlinked checkout root');
  if(!fs.lstatSync(path.join(root,'.git')).isDirectory())stop('indirect Git metadata');
  if(!eqPath(txt(['rev-parse','--show-toplevel']),root))stop('unexpected Git root');
  if(txt(['remote','get-url','origin'])!==origin)stop('unexpected Git origin');
  if(txt(['symbolic-ref','--quiet','--short','HEAD'])!==branch)stop('wrong branch');
  if(txt(['rev-parse','--show-object-format'])!=='sha1')stop('unexpected Git hash format');
  const head=txt(['rev-parse','--verify','HEAD']);
  if(head!==reviewed)stop('checkout differs from human-reviewed PR SHA');
  if(txt(['for-each-ref','--format=%(refname)','refs/replace'])!=='')stop('Git replacement objects found');
  const line=git(['ls-remote','--exit-code',origin,ref]).toString('utf8').trim();
  if(line!==head+'\t'+ref)stop('R4 branch moved or remote HEAD unverified');
  if(txt(['status','--porcelain','--untracked-files=no'])!=='')stop('tracked source changed');
  const trees=nul(['ls-tree','-rz','HEAD']);
  const staged=nul(['ls-files','--stage','-z']);
  const flags=nul(['ls-files','-v','-z']);
  if(!trees.length||trees.length!==staged.length||flags.length!==trees.length)
    stop('index/tree count mismatch');
  const index=new Map();
  for(const row of staged){
    const match=/^(100644|100755) ([a-f0-9]{40}) 0\t(.+)/.exec(row);
    if(!match||match[0]!==row||index.has(match[3]))stop('unsafe index stage, mode or path');
    index.set(match[3],match[1]+' '+match[2]);
  }
  for(const flag of flags){
    if(!flag.startsWith('H ')||!index.has(flag.slice(2)))
      stop('assume-unchanged, skip-worktree or altered Git index flag');
  }
  const dirs=new Set();
  for(const row of trees){
    const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)/.exec(row);
    if(!match||match[0]!==row||index.get(match[3])!==match[1]+' '+match[2])
      stop('commit/index mismatch, symlink or submodule');
    const parts=match[3].split('/');
    let current=root;
    let rel='';
    for(let i=0;i<parts.length;i++){
      const part=parts[i];
      if(!part||part==='.'||part==='..')stop('invalid tracked path');
      current=path.join(current,part);
      const info=fs.lstatSync(current);
      if(info.isSymbolicLink())stop('symlinked tracked path');
      if(i<parts.length-1){
        if(!info.isDirectory())stop('non-directory tracked path');
        rel=rel?rel+'/'+part:part;
        dirs.add(rel);
      }else{
        if(!info.isFile())stop('non-file tracked path');
        const bytes=fs.readFileSync(current);
        const digest=crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
        if(digest!==match[2])stop('tracked bytes do not match reviewed commit');
      }
    }
  }
  // The only permitted untracked files are previously saved input reports.
  const reports=new Set(['preflight-report.json','connect-report.json']);
  const walk=(directory,relative)=>{
    for(const name of fs.readdirSync(directory)){
      if(!relative&&name==='.git')continue;
      const rel=relative?relative+'/'+name:name;
      const full=path.join(directory,name);
      const info=fs.lstatSync(full);
      if(info.isSymbolicLink())stop('symlinked extra path');
      if(info.isDirectory()){
        if(!dirs.has(rel))stop('unexpected directory');
        walk(full,rel);
      }else if(!info.isFile()||(!index.has(rel)&&!(reports.has(rel)&&!relative)))
        stop('unexpected file');
    }
  };
  walk(root,'');
  // Recheck source flags and remote HEAD just before the actual Node launch.
  if(nul(['ls-files','-v','-z']).some(v=>!v.startsWith('H ')))stop('Git index flag changed');
  if(git(['ls-remote','--exit-code',origin,ref]).toString('utf8').trim()!==line)
    stop('R4 branch moved during verification');
  if(txt(['rev-parse','--verify','HEAD'])!==head)stop('checkout moved during verification');
  const result=cp.spawnSync(process.execPath,[path.join(root,'bin/aws-emulator-mcp.mjs'),
    'rescue',report],{cwd:root,env,stdio:'inherit'});
  process.exit(result.status===null?1:result.status);
}catch(error){
  console.error('STOP: refusing unverified rescue checkout ('+error.message+')');
  process.exit(2);
}
RESCUE_CHECKOUT_GUARD
)
```

### Windows PowerShell (including Windows PowerShell 5.1)

**Step 1 — clone only; stop on failure or an existing destination (no project code):**

```powershell
& {
  $repo = 'aws-emulator-mcp-r4'
  if (Test-Path -LiteralPath $repo) { throw 'STOP: checkout directory already exists' }
  git clone --config core.autocrlf=false --depth 1 --branch release/agent-team-preview-r4-20261118 https://github.com/B11-Health/aws-emulator-mcp.git $repo
  if ($LASTEXITCODE -ne 0) { throw 'STOP: clone failed; never enter an old checkout' }
}
```

**Step 2 — compare the PR's current head yourself, then paste this verification block:**

```powershell
& {
  $repo = 'aws-emulator-mcp-r4'
  $report = '.\preflight-report.json'  # Or a quoted absolute path outside checkout
  $head = git -C $repo rev-parse --verify HEAD
  if ($LASTEXITCODE -ne 0) { throw 'STOP: checkout HEAD unavailable' }
  $ref = 'refs/heads/release/agent-team-preview-r4-20261118'
  $remote = @(git ls-remote --exit-code https://github.com/B11-Health/aws-emulator-mcp.git $ref)
  if ($LASTEXITCODE -ne 0 -or $remote.Count -ne 1 -or $remote[0] -cne ($head + "`t" + $ref)) { throw 'STOP: R4 remote HEAD differs' }
  Write-Host "Current R4 head: $head"
  Write-Host 'Open https://github.com/B11-Health/aws-emulator-mcp/pull/91; review and compare its CURRENT head.'
  $reviewed = Read-Host 'Type the entire PR #91 SHA you independently reviewed'
  if ($reviewed -cne $head) { throw 'STOP: PR head not confirmed' }
  $guard = @'
// Inline, host-Node guard: verifies the checkout BEFORE loading its code.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const cp=require('node:child_process');
const reviewed=process.argv[2];
const dir=process.argv[3];
const report=process.argv[4];
const origin='https://github.com/B11-Health/aws-emulator-mcp.git';
const branch='release/agent-team-preview-r4-20261118';
const ref='refs/heads/'+branch;
const env={...process.env};
for(const name of Object.keys(env))if(name.startsWith('GIT_')||name.startsWith('AWS_'))delete env[name];
env.GIT_NO_REPLACE_OBJECTS='1';
const stop=reason=>{throw Error(reason)};
const git=(args)=>cp.execFileSync('git',['-c','core.fsmonitor=false','-C',dir,...args],{
  env,encoding:'buffer',maxBuffer:16*1024*1024,stdio:['ignore','pipe','ignore']
});
const txt=args=>git(args).toString('utf8').trim();
const nul=args=>git(args).toString('utf8').split('\0').filter(Boolean);
try {
  if(!/^[0-9a-f]{40}$/.test(reviewed||''))stop('invalid reviewed SHA');
  const root=path.resolve(dir);
  const eqPath=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
  if(!eqPath(fs.realpathSync(root),root))stop('symlinked checkout root');
  if(!fs.lstatSync(path.join(root,'.git')).isDirectory())stop('indirect Git metadata');
  if(!eqPath(txt(['rev-parse','--show-toplevel']),root))stop('unexpected Git root');
  if(txt(['remote','get-url','origin'])!==origin)stop('unexpected Git origin');
  if(txt(['symbolic-ref','--quiet','--short','HEAD'])!==branch)stop('wrong branch');
  if(txt(['rev-parse','--show-object-format'])!=='sha1')stop('unexpected Git hash format');
  const head=txt(['rev-parse','--verify','HEAD']);
  if(head!==reviewed)stop('checkout differs from human-reviewed PR SHA');
  if(txt(['for-each-ref','--format=%(refname)','refs/replace'])!=='')stop('Git replacement objects found');
  const line=git(['ls-remote','--exit-code',origin,ref]).toString('utf8').trim();
  if(line!==head+'\t'+ref)stop('R4 branch moved or remote HEAD unverified');
  if(txt(['status','--porcelain','--untracked-files=no'])!=='')stop('tracked source changed');
  const trees=nul(['ls-tree','-rz','HEAD']);
  const staged=nul(['ls-files','--stage','-z']);
  const flags=nul(['ls-files','-v','-z']);
  if(!trees.length||trees.length!==staged.length||flags.length!==trees.length)
    stop('index/tree count mismatch');
  const index=new Map();
  for(const row of staged){
    const match=/^(100644|100755) ([a-f0-9]{40}) 0\t(.+)/.exec(row);
    if(!match||match[0]!==row||index.has(match[3]))stop('unsafe index stage, mode or path');
    index.set(match[3],match[1]+' '+match[2]);
  }
  for(const flag of flags){
    if(!flag.startsWith('H ')||!index.has(flag.slice(2)))
      stop('assume-unchanged, skip-worktree or altered Git index flag');
  }
  const dirs=new Set();
  for(const row of trees){
    const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)/.exec(row);
    if(!match||match[0]!==row||index.get(match[3])!==match[1]+' '+match[2])
      stop('commit/index mismatch, symlink or submodule');
    const parts=match[3].split('/');
    let current=root;
    let rel='';
    for(let i=0;i<parts.length;i++){
      const part=parts[i];
      if(!part||part==='.'||part==='..')stop('invalid tracked path');
      current=path.join(current,part);
      const info=fs.lstatSync(current);
      if(info.isSymbolicLink())stop('symlinked tracked path');
      if(i<parts.length-1){
        if(!info.isDirectory())stop('non-directory tracked path');
        rel=rel?rel+'/'+part:part;
        dirs.add(rel);
      }else{
        if(!info.isFile())stop('non-file tracked path');
        const bytes=fs.readFileSync(current);
        const digest=crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
        if(digest!==match[2])stop('tracked bytes do not match reviewed commit');
      }
    }
  }
  // The only permitted untracked files are previously saved input reports.
  const reports=new Set(['preflight-report.json','connect-report.json']);
  const walk=(directory,relative)=>{
    for(const name of fs.readdirSync(directory)){
      if(!relative&&name==='.git')continue;
      const rel=relative?relative+'/'+name:name;
      const full=path.join(directory,name);
      const info=fs.lstatSync(full);
      if(info.isSymbolicLink())stop('symlinked extra path');
      if(info.isDirectory()){
        if(!dirs.has(rel))stop('unexpected directory');
        walk(full,rel);
      }else if(!info.isFile()||(!index.has(rel)&&!(reports.has(rel)&&!relative)))
        stop('unexpected file');
    }
  };
  walk(root,'');
  // Recheck source flags and remote HEAD just before the actual Node launch.
  if(nul(['ls-files','-v','-z']).some(v=>!v.startsWith('H ')))stop('Git index flag changed');
  if(git(['ls-remote','--exit-code',origin,ref]).toString('utf8').trim()!==line)
    stop('R4 branch moved during verification');
  if(txt(['rev-parse','--verify','HEAD'])!==head)stop('checkout moved during verification');
  const result=cp.spawnSync(process.execPath,[path.join(root,'bin/aws-emulator-mcp.mjs'),
    'rescue',report],{cwd:root,env,stdio:'inherit'});
  process.exit(result.status===null?1:result.status);
}catch(error){
  console.error('STOP: refusing unverified rescue checkout ('+error.message+')');
  process.exit(2);
}
'@
  $guard | node - $reviewed $repo $report
  if ($LASTEXITCODE -ne 0) { throw 'STOP: checkout verification or rescue failed' }
}
```

Copy **only one platform's blocks**, in order. If clone fails or the destination already exists, do not continue; do not run `cd` or the installed CLI from that folder. If the branch moves during your review, the inline guard rejects it. A report outside the checkout can have spaces in its absolute path; change only the **quoted `report` variable** in Step 2. For a previously saved connection report in the checkout, set it to `./connect-report.json` on POSIX or `.\connect-report.json` on PowerShell. The source guard runs host Node.js code supplied in this guide; it does not attest that the project or reviewed PR is trustworthy. Review the source before continuing, particularly any downloaded repository code.

### Optional: capture a report separately

If you already have a saved report, **do not** rerun `preflight` or `connect-check`. Otherwise, run one diagnostic **only from a separately reviewed and verified checkout**. `preflight --json` checks Node/local Docker read-only; `connect-check --json` can start one isolated local MCP container using an existing matched image but does not build or pull. These probes are not part of offline `rescue`. Preserve the guarded checkout and consent checks when choosing to capture a new report, and save its JSON to a quoted local file.

Rescue itself reads one previously saved, bounded local JSON report. It returns 1–3 manual actions and exits **0** on successful interpretation even when the original diagnostic failed; exit **2** means the report was unsafe or invalid. It never performs Docker probes, image builds, AWS requests, configuration changes or execution of report-supplied commands. A suggested signed-image build is always a separate user opt-in.

## What the advice means

- **Missing Node.js**: install Node.js **20+ manually** and check its version.
  No installer runs automatically.
- **Docker blocked or remote**: inspect/select a **trusted local** Docker
  context and Linux-container mode yourself. Do not redirect to a remote
  TCP/SSH daemon or bypass the `connect-check` local-only guard.
- **Missing/stale/unverified image**: inspect actual Docker image storage
  (`docker system df` is shown only for you to run manually with a trusted
  local daemon). `build` is **explicit opt-in**: it downloads and verifies the
  official signed AWS Emulator package and builds a sizable local image.
  It requires network and free Docker Engine/Desktop VM storage; no pruning
  or automatic cleanup is performed.
- **Critical disk warning**: below **3 GiB** host-visible Docker data-root
  free space, no `build` command is suggested; fix capacity and recheck first.
  Below **10 GiB** is a conservative advisory. Neither working-directory nor
  host-visible data-root readings certify Docker Desktop VM capacity or
  actual available image-build space.
- **Failed MCP reply**: inspect prerequisites and retry `connect-check` only
  after correcting the local issue. A healthy read-only reply requires the
  exact lowercase `ok` health body. Do not mistake an HTTP 200 or malformed
  response for a successful local emulator check.
- **Passing `connect-check`**: this verifies a *terminal* MCP stdio initialize,
  tool listing, and read-only status result only. It does **not** prove that
  Claude Desktop or VS Code Copilot loaded your configuration. Review/install
  the printed MCP config yourself, then call `emulator_doctor` **from your real
  client** and inspect its actual reply. Neither check proves application
  correctness, production IAM behavior, or AWS cloud compatibility.

The interpreter never verifies an AWS API. A successful `onboard --offline`
result verifies seven locally generated architecture files, **not** AWS APIs.
For the actual first MCP connection and its safeguards, see [FIRST_RUN.md](FIRST_RUN.md).
