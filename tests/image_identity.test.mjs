import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync} from 'node:fs';
import {imageSourceDigest} from '../scripts/image_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/aws-emulator-mcp.mjs');

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'aws-image-identity-'));
  for (const dir of ['docker','scripts','src/aws_emulator_mcp',
                     'examples/order-intake', 'examples/contracts','examples/reliability-lab'])
    mkdirSync(path.join(root,dir),{recursive:true});
  for (const [name,contents] of [
    ['docker/Dockerfile','FROM scratch\n'],
    ['docker/entrypoint.sh','#!/bin/sh\n'],
    ['scripts/install_wsl.sh','exit 0\n'],
    ['src/aws_emulator_mcp/server.py','x = 1\n'],
    ['examples/order-intake/order_service.py','def submit_order(): pass\n'],
    ['examples/reliability-lab/README.md','test fixture\n']
  ]) writeFileSync(path.join(root,name),contents);
  return root;
}

test('fingerprint is stable and changes for any copied runtime file', () => {
  const root = fixture();
  try {
    const before = imageSourceDigest(root);
    assert.match(before,/^[0-9a-f]{64}$/);
    assert.equal(before,imageSourceDigest(root));
    const file=path.join(root,'src/aws_emulator_mcp/server.py');
    writeFileSync(file,'x = 2\n');
    const after=imageSourceDigest(root);
    assert.notEqual(after,before);
    writeFileSync(path.join(root,'src/aws_emulator_mcp/new_module.py'),'answer = 42\n');
    assert.notEqual(imageSourceDigest(root),after);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('ignored bytecode does not change runtime source fingerprint', () => {
  const root=fixture();
  try {
    const before=imageSourceDigest(root);
    const dir=path.join(root,'src/aws_emulator_mcp/__pycache__');
    mkdirSync(dir);
    writeFileSync(path.join(dir,'server.cpython-312.pyc'),'not a runtime source');
    assert.equal(imageSourceDigest(root),before);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('missing build input and symlink in copied runtime source fail closed', () => {
  const root=fixture();
  try {
    const file=path.join(root,'docker/Dockerfile');
    rmSync(file);
    assert.throws(()=>imageSourceDigest(root));
    writeFileSync(file,'FROM scratch\n');
    if(process.platform!=='win32') {
      symlinkSync(file,path.join(root,'src/aws_emulator_mcp/sneaky.py'));
      assert.throws(()=>imageSourceDigest(root),/Symlink/);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('all Dockerfile COPY sources are represented in the fingerprint contract', () => {
  const source=readFileSync(path.join(ROOT,'docker/Dockerfile'),'utf8');
  const copied=source.split('\n').filter(line=>/^COPY\s/.test(line))
    .map(line=>line.trim().split(/\s+/).filter(part=>!part.startsWith('--'))[1]);
  assert.deepEqual(copied.sort(), [
    'src/aws_emulator_mcp','examples/order-intake', 'examples/contracts','examples/reliability-lab',
    'scripts/install_wsl.sh','docker/entrypoint.sh'
  ].sort());
});

test('repo fingerprint is repeatable from the shipped script', () => {
  const hash=imageSourceDigest(ROOT);
  const run=spawnSync(process.execPath,[path.join(ROOT,'scripts/image_identity.mjs')],{
    encoding:'utf8',timeout:12000
  });
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.stdout.trim(),hash);
  assert.match(hash,/^[a-f0-9]{64}$/);
});

test('stale or unlabeled local images rebuild; matching source identity reuses image',
  {skip:process.platform==='win32'}, () => {
    const temp=mkdtempSync(path.join(tmpdir(),'aws-image-docker-stub-'));
    const docker=path.join(temp,'docker');
    const log=path.join(temp,'docker.log');
    const stub=`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='context') console.log(JSON.stringify('unix:///var/run/docker.sock'));
else if(args[0]==='info') console.log('25.0.16');
else if(args[0]==='image') console.log(process.env.MOCK_DOCKER_LABEL||'<no value>');
else if(args[0]==='build') process.exit(17);
else if(args[0]==='run') console.log(JSON.stringify({ready:true,checks:[],account_verified:true,emulator_version:'synthetic-stub'}));
else process.exit(77);
`;
    writeFileSync(docker,stub);chmodSync(docker,0o755);
    try {
      const invoke=label=> {
        writeFileSync(log,'');
        const run=spawnSync(process.execPath,[BIN,'doctor','--json'],{
          encoding:'utf8',timeout:12000,
          env:{...process.env,PATH:temp+path.delimiter+process.env.PATH,
               MOCK_DOCKER_LABEL:label,MOCK_DOCKER_LOG:log}
        });
        const commands=readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s));
        return {run,commands};
      };
      const wrong=invoke('0'.repeat(64));
      assert.equal(wrong.run.status,17);
      assert.match(wrong.run.stderr,/cached image source differs/);
      const build=wrong.commands.find(c=>c[0]==='build');
      assert.ok(build,'missing build command for stale source');
      assert.equal(build[build.indexOf('--build-arg')+1],
        'AWS_MCP_SOURCE_SHA256='+imageSourceDigest(ROOT));
      assert.equal(wrong.commands.some(c=>c[0]==='run'),false);
      const unlabelled=invoke('');
      assert.equal(unlabelled.run.status,17);
      assert.ok(unlabelled.commands.some(c=>c[0]==='build'));
      const good=invoke(imageSourceDigest(ROOT));
      assert.equal(good.run.status,0,good.run.stderr);
      assert.equal(good.commands.some(c=>c[0]==='build'),false);
      assert.ok(good.commands.some(c=>c[0]==='run'));
    } finally {rmSync(temp,{recursive:true,force:true});}
  });

test('desktop MCP startup never downloads, builds or pulls a missing or stale image',
  {skip:process.platform==='win32'}, () => {
    // A fake Docker executable makes this a pure CLI contract test. No daemon,
    // image, container, network or AWS credentials are used.
    const folder=mkdtempSync(path.join(tmpdir(),'aws-mcp-no-surprise-'));
    const docker=path.join(folder,'docker');
    const log=path.join(folder,'docker.log');
    const stub=`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG,JSON.stringify(args)+'\\n');
const command=args[0]==='--host' ? args.slice(2) : args;
if(command[0]==='context') console.log(JSON.stringify('unix:///var/run/docker.sock'));
else if(command[0]==='info') console.log('linux');
else if(command[0]==='image') {
  if(process.env.MOCK_DOCKER_MISSING==='1') process.exit(1);
  console.log('sha256:'+'f'.repeat(64)+'|'+(process.env.MOCK_DOCKER_LABEL || '<no value>'));
} else if(command[0]==='build') process.exit(89);
else if(command[0]==='run') console.log('SYNTHETIC_MCP_SERVER_RESPONSE');
else process.exit(77);
`;
    writeFileSync(docker,stub);chmodSync(docker,0o755);
    const invoke=({label='',missing=false,remote=false}={})=>{
      writeFileSync(log,'');
      const env={...process.env,
        PATH:folder+path.delimiter+process.env.PATH,
        MOCK_DOCKER_LOG:log,MOCK_DOCKER_LABEL:label,
        MOCK_DOCKER_MISSING:missing?'1':'0'};
      if(remote) env.DOCKER_HOST='tcp://192.0.2.22:2375';
      else delete env.DOCKER_HOST;
      const result=spawnSync(process.execPath,[BIN,'mcp'],{
        env,encoding:'utf8',timeout:14000});
      const commands=readFileSync(log,'utf8').trim().split('\n')
        .filter(Boolean).map(line=>JSON.parse(line));
      return {result,commands};
    };
    try {
      const stale=invoke({label:'0'.repeat(64)});
      const unverified=invoke();
      const absent=invoke({missing:true});
      for(const item of [stale,unverified,absent]) {
        assert.equal(item.result.status,1,item.result.stderr);
        assert.equal(item.result.stdout,'','MCP stdout must remain JSON-RPC-only');
        assert.match(item.result.stderr,/no image build was attempted/);
        assert.match(item.result.stderr,/preflight --json/);
        assert.match(item.result.stderr,/explicitly run build/);
        assert.equal(item.commands.some(args=>args.includes('build')||args.includes('run')),false);
        assert.equal(item.commands.some(args=>args.includes('--pull')),false);
      }
      const remote=invoke({remote:true});
      assert.equal(remote.result.status,1);
      assert.equal(remote.result.stdout,'');
      assert.equal(remote.commands.length,0,'remote Docker host must be refused before any command');
      const matched=invoke({label:imageSourceDigest(ROOT)});
      assert.equal(matched.result.status,0,matched.result.stderr);
      assert.equal(matched.result.stdout.trim(),'SYNTHETIC_MCP_SERVER_RESPONSE');
      assert.equal(matched.commands.some(args=>args.includes('build')),false);
      const actualRun=matched.commands.find(args=>args.includes('run'));
      assert.ok(actualRun,'existing matched image must still start MCP');
      assert.deepEqual(actualRun.slice(0,9),
        ['--host','unix:///var/run/docker.sock','run','--rm','-i','--pull','never','--network','none']);
      assert.equal(actualRun.at(-2),'sha256:'+'f'.repeat(64));
    } finally {rmSync(folder,{recursive:true,force:true});}
  });
