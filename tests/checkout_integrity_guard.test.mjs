import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Script} from 'node:vm';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const HTML=readFileSync(join(ROOT,'docs/index.html'),'utf8');
const R3='d577c490f7c6d92c9ac9040913728bf700b52244';
const BETA='12bae624be4cd9d428844dcfd17d24ea38cbc788';
const commands={
  'goal-api-run':{dir:'aws-mcp-api',sha:R3,args:["'config'","'copilot'"]},
  'goal-app-run':{dir:'aws-mcp-app',sha:R3,args:["'app-guide'","'examples/app-case/s3-upload.py'","'--json'"]},
  'goal-architecture-run':{dir:'aws-mcp-architecture',sha:BETA,args:["'architecture'","'demo'"]},
  'goal-gaps-run':{dir:'aws-mcp-gaps',sha:R3,args:["'preflight'","'--json'"]},
  'goal-gaps-probe':{dir:'aws-mcp-gaps',sha:R3,args:["'coverage'","'s3'","'--json'"]},
  'app-proof-preflight-command':{dir:'aws-mcp-proof',sha:R3,args:["'preflight'","'--json'"]},
  'app-proof-build-command':{dir:'aws-mcp-proof',sha:R3,args:["'build'"]},
  'app-proof-command':{dir:'aws-mcp-proof',sha:R3,args:["'app-case-compare'","'examples/app-case/buggy.py'","'examples/app-case/fixed.py'","'examples/app-case/sqs-idempotency.json'","'--json'"]},
};

function command(id) {
  const tag='<pre id="'+id+'" tabindex="0"><code>';
  const begin=HTML.indexOf(tag);
  assert.ok(begin>=0,'Missing source command '+id);
  const end=HTML.indexOf('</code></pre>',begin);
  assert.ok(end>begin,'Missing end tag '+id);
  return HTML.slice(begin+tag.length,end);
}
function script(id,sha=commands[id].sha) {
  const cmd=command(id);
  assert.ok(cmd.startsWith('node -e "') && cmd.endsWith('"'),id);
  assert.ok(!cmd.includes('\n') && !cmd.includes('\r'),'One shell line');
  const code=cmd.slice('node -e "'.length,-1);
  assert.ok(!code.includes('"') && !code.includes('$') &&
    !code.includes(String.fromCharCode(96)),'No Bash/PowerShell expansion or nested double quotes');
  return code.replace("h='"+commands[id].sha+"'", "h='"+sha+"'");
}
function execute(executable,args,cwd,env={}) {
  return spawnSync(executable,args,{
    cwd,encoding:'utf8',timeout:30000,
    env:{...process.env,DOCKER_HOST:'tcp://198.51.100.1:2375',...env}
  });
}
function git(cwd,args) {
  const result=execute('git',args,cwd,{
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:join(cwd,'unused-global-config'),
  });
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim();
}
function fixture(parent,directory){
  const path=join(parent,directory);
  mkdirSync(join(path,'bin'),{recursive:true});
  git(parent,['init','-q',path]);
  git(parent,['-C',path,'config','user.email','inert@example.invalid']);
  git(parent,['-C',path,'config','user.name','Inert QA']);
  git(parent,['-C',path,'config','core.autocrlf','false']);
  writeFileSync(join(path,'.gitignore'),'ignored-secret.txt\n');
  writeFileSync(join(path,'README.md'),'Harmless test fixture.\n');
  const marker=join(parent,directory+'-executed.marker');
  // This is a controlled inert fixture: a sentinel if *and only if* an
  // unsafe guard accidentally reaches the trusted local test script.
  writeFileSync(join(path,'bin/aws-emulator-mcp.mjs'),
    "import{writeFileSync}from'node:fs';import{resolve}from'node:path';writeFileSync(resolve('..','"+directory+"-executed.marker'),'RUN');\n");
  git(parent,['-C',path,'add','.']);
  git(parent,['-C',path,'-c','core.hooksPath='+parent,'commit','-qm','Fixture']);
  return {path,marker,sha:git(parent,['-C',path,'rev-parse','HEAD'])};
}
function refuse(scriptSource,cwd){
  // Executing trusted inline Node builtins for the integrity check is safe;
  // no repository code should be reached in any negative case.
  const result=execute(process.execPath,['-e',scriptSource],cwd);
  assert.equal(result.status,2,result.stderr);
  assert.match(result.stderr,/Refusing unverified checkout/);
  return result.stderr;
}
function withoutFastStatus(code) {
  const fast="if(t(['status','--porcelain','--untracked-files=all'])!=='')throw Error('modified checkout');";
  assert.ok(code.includes(fast));
  return code.replace(fast,'');
}

test('all eight copied run/build/test commands compile and require exact blob and index verification',()=>{
  assert.equal(Object.keys(commands).length,8);
  for(const [id,spec] of Object.entries(commands)){
    const code=script(id);
    new Script(code);
    for(const required of [
      "d='"+spec.dir+"'","h='"+spec.sha+"'",
      "g(['ls-tree','-rz','HEAD'])",
      "z(['ls-tree','-rz','HEAD'])",
      "z(['ls-files','--stage','-z'])",
      "z(['ls-files','-v','-z'])",
      "z(['ls-files','--others','-z'])",
      "f.lstatSync(file).isSymbolicLink()",
      "e.GIT_NO_REPLACE_OBJECTS='1'",
      "'core.fsmonitor=false'",
      "q.createHash('sha1')",
      "digest!==m[2]",
      "f.readdirSync(dir)",
      "'Refusing unverified checkout: '"
    ]){
      // The tree read is routed through z(), not directly through g().
      if(required==="g(['ls-tree','-rz','HEAD'])")continue;
      assert.ok(code.includes(required),id+' missing '+required);
    }
    assert.ok(code.includes('a=['+spec.args.join(',')+']'),id+' wrong CLI route');
    assert.ok(HTML.includes('data-copy="'+id+'"'));
  }
});

test('assume-unchanged hides a changed tracked executable from git status but cannot pass guard',()=>{
  const parent=mkdtempSync(join(tmpdir(),'guard-assume-'));
  try{
    const f=fixture(parent,'aws-mcp-api');
    git(parent,['-C',f.path,'update-index','--assume-unchanged','bin/aws-emulator-mcp.mjs']);
    writeFileSync(join(f.path,'bin/aws-emulator-mcp.mjs'),"// CHANGED BUT HIDDEN\n");
    assert.equal(git(parent,['-C',f.path,'status','--porcelain']),'');
    assert.match(git(parent,['-C',f.path,'ls-files','-v','bin/aws-emulator-mcp.mjs']),/^h /);
    const error=refuse(script('goal-api-run',f.sha),parent);
    assert.match(error,/unsafe index flag|tracked bytes differ/);
    assert.equal(existsSync(f.marker),false);
  }finally{rmSync(parent,{recursive:true,force:true});}
});

test('skip-worktree flag cannot hide changed executable from guarded App Proof build',()=>{
  const parent=mkdtempSync(join(tmpdir(),'guard-skip-'));
  try{
    const f=fixture(parent,'aws-mcp-proof');
    git(parent,['-C',f.path,'update-index','--skip-worktree','bin/aws-emulator-mcp.mjs']);
    writeFileSync(join(f.path,'bin/aws-emulator-mcp.mjs'),"// HIDDEN SKIP-WORKTREE CHANGE\n");
    assert.equal(git(parent,['-C',f.path,'status','--porcelain']),'');
    assert.match(git(parent,['-C',f.path,'ls-files','-v','bin/aws-emulator-mcp.mjs']),/^S /);
    const error=refuse(script('app-proof-build-command',f.sha),parent);
    assert.match(error,/unsafe index flag|tracked bytes differ/);
    assert.equal(existsSync(f.marker),false);
  }finally{rmSync(parent,{recursive:true,force:true});}
});

test('actual tracked file bytes are independently checked, even with the status fast-path disabled',()=>{
  const parent=mkdtempSync(join(tmpdir(),'guard-blob-'));
  try{
    const f=fixture(parent,'aws-mcp-api');
    writeFileSync(join(f.path,'README.md'),'Tampered unrelated committed file.\n');
    assert.equal(git(parent,['-C',f.path,'ls-files','-v','README.md']).startsWith('H '),true);
    const error=refuse(withoutFastStatus(script('goal-api-run',f.sha)),parent);
    assert.match(error,/tracked bytes differ from commit/);
    assert.equal(existsSync(f.marker),false);
  }finally{rmSync(parent,{recursive:true,force:true});}
});

test('local Git replace refs cannot spoof the pinned commit tree',()=>{
  const parent=mkdtempSync(join(tmpdir(),'guard-replace-'));
  try {
    const f=fixture(parent,'aws-mcp-api');
    const original=f.sha;
    writeFileSync(join(f.path,'bin/aws-emulator-mcp.mjs'),
      "// Inert substituted fixture: no app behavior or AWS access.\\n");
    git(parent,['-C',f.path,'add','bin/aws-emulator-mcp.mjs']);
    git(parent,['-C',f.path,'commit','-qm','Different inert tree']);
    const alternate=git(parent,['-C',f.path,'rev-parse','HEAD']);
    assert.notEqual(original,alternate);
    git(parent,['-C',f.path,'replace',original,alternate]);
    git(parent,['-C',f.path,'reset','--hard',original]);
    assert.equal(git(parent,['-C',f.path,'rev-parse','HEAD']),original);
    assert.equal(git(parent,['-C',f.path,'status','--porcelain']),'',
      'Git replace ref can make a substituted worktree appear clean');
    const error=refuse(withoutFastStatus(script('goal-api-run',original)),parent);
    assert.match(error,/commit\/index mismatch|tracked bytes differ/);
    assert.equal(existsSync(f.marker),false);
  }finally{rmSync(parent,{recursive:true,force:true});}
});

test('ignored untracked files are refused even when Git status is clean',()=>{
  const parent=mkdtempSync(join(tmpdir(),'guard-ignored-'));
  try{
    const f=fixture(parent,'aws-mcp-proof');
    writeFileSync(join(f.path,'ignored-secret.txt'),'INERT');
    assert.equal(git(parent,['-C',f.path,'status','--porcelain']),'');
    const error=refuse(script('app-proof-preflight-command',f.sha),parent);
    assert.match(error,/untracked|ignored/);
    assert.equal(existsSync(f.marker),false);
  }finally{rmSync(parent,{recursive:true,force:true});}
});

test('unexpected symlink instead of tracked file is refused without executing it',()=>{
  if(process.platform==='win32')return;
  const parent=mkdtempSync(join(tmpdir(),'guard-link-'));
  try{
    const f=fixture(parent,'aws-mcp-app');
    rmSync(join(f.path,'bin/aws-emulator-mcp.mjs'));
    symlinkSync('../README.md',join(f.path,'bin/aws-emulator-mcp.mjs'));
    const error=refuse(withoutFastStatus(script('goal-app-run',f.sha)),parent);
    assert.match(error,/symlinked path/);
    assert.equal(existsSync(f.marker),false);
  }finally{rmSync(parent,{recursive:true,force:true});}
});

test('a failed clone into stale App Proof checkout never falls through to build or trusted-app test',()=>{
  const parent=mkdtempSync(join(tmpdir(),'guard-app-stale-'));
  try{
    const f=fixture(parent,'aws-mcp-proof');
    const failed=execute('git',['clone',f.path,f.path],parent);
    assert.notEqual(failed.status,0,'Must simulate failed clone into existing target');
    for(const id of ['app-proof-preflight-command','app-proof-build-command','app-proof-command']){
      refuse(script(id),parent);
    }
    assert.equal(existsSync(f.marker),false);
  }finally{rmSync(parent,{recursive:true,force:true});}
});

test('a clean, commit-matching inert fixture passes the guard and only executes its own test marker',()=>{
  const parent=mkdtempSync(join(tmpdir(),'guard-clean-fixture-'));
  try{
    const f=fixture(parent,'aws-mcp-api');
    const result=execute(process.execPath,['-e',script('goal-api-run',f.sha)],parent);
    assert.equal(result.status,0,result.stderr);
    assert.equal(existsSync(f.marker),true,'only the self-authored inert fixture was executed');
  }finally{rmSync(parent,{recursive:true,force:true});}
});

test('missing checkout fails closed for all eight paths, including optional emulator probe',()=>{
  const parent=mkdtempSync(join(tmpdir(),'guard-missing-'));
  try{
    for(const id of Object.keys(commands))refuse(script(id),parent);
  }finally{rmSync(parent,{recursive:true,force:true});}
});
