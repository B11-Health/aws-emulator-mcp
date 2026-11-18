import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectOfficialSession, parseOfficialSessionArgs, formatOfficialSession} from '../scripts/official_session.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const BIN=path.join(ROOT,'bin/aws-emulator-mcp.mjs');
function fixture(fn) {
  const home=mkdtempSync(path.join(tmpdir(),'aws-companion-'));
  const dir=path.join(home,'.aws','emulator','9297');
  mkdirSync(dir,{recursive:true});
  writeFileSync(path.join(dir,'ca.pem'),'TEST_ONLY_CERTIFICATE');
  // This sentinel MUST NOT be inspected, used in requests or printed.
  writeFileSync(path.join(dir,'emulator_credentials'),'SENTINEL_NEVER_READ_PRIVATE_KEY');
  return Promise.resolve().then(()=>fn({home,dir})).finally(()=>rmSync(home,{recursive:true,force:true}));
}

test('companion docs distinguish health-only from opt-in credential identity',()=>{
  const guide=readFileSync(path.join(ROOT,'docs/AWS_COMPANION.md'),'utf8');
  assert.match(guide,/In the \*\*default health-only mode\*\*/);
  assert.match(guide,/--identity.*may report `credentialFilesRead: true`/);
  assert.match(guide,/`accountIdentityVerified: true` only after/);
  assert.match(guide,/does not use real AWS credentials/);
});

test('the official session check is read-only and never loads credentials', async()=>{
  await fixture(async({home})=>{
    const probes=[];
    const result=await inspectOfficialSession({home,probe:async({port,ca})=>{
      probes.push({port, ca:ca.toString()});
      return {statusCode:200,body:'ok\n'};
    }});
    assert.equal(result.status,'healthy');
    assert.equal(result.localHealthPassed,true);
    assert.equal(result.sessionDirectoryRecognized,true);
    assert.deepEqual(probes,[{port:9297,ca:'TEST_ONLY_CERTIFICATE'}]);
    for (const key of ['credentialFilesRead','accountIdentityVerified','officialPackageVerified',
      'applicationBehaviorTested','productionAwsValidated','cloudCallsMade','dockerOperationsPerformed'])
      assert.equal(result[key],false);
    assert.doesNotMatch(JSON.stringify(result)+formatOfficialSession(result),
      /SENTINEL_NEVER_READ|emulator_credentials|TEST_ONLY_CERTIFICATE/);
  });
});

test('unhealthy responses and unreachable sessions never become green',async()=>{
  await fixture(async({home})=>{
    for (const value of [{statusCode:501,body:'not-implemented'},
                         {statusCode:302,body:'ok'}, {statusCode:200,body:'not ok'}]) {
      const result=await inspectOfficialSession({home,probe:async()=>value});
      assert.equal(result.status,'unhealthy');
      assert.equal(result.localHealthPassed,false);
    }
    const bad=await inspectOfficialSession({home,probe:async()=>{throw Error('SECRET_VALUE_IN_EXCEPTION')}});
    assert.equal(bad.status,'unreachable');
    assert.equal(bad.localHealthPassed,false);
    assert.doesNotMatch(JSON.stringify(bad),/SECRET_VALUE/);
  });
});

test('no session, missing CA, symlinked CA or symlinked session fail closed', async()=>{
  const home=mkdtempSync(path.join(tmpdir(),'aws-companion-empty-'));
  try {
    const missing=await inspectOfficialSession({home,probe:async()=>{throw Error('should not probe')}});
    assert.equal(missing.status,'not_configured');
    await fixture(async({home:h,dir})=>{
      const fs=await import('node:fs');
      fs.unlinkSync(path.join(dir,'ca.pem'));
      assert.equal((await inspectOfficialSession({home:h})).status,'missing_ca');
      // Creating symlinks on Windows may require Developer Mode or elevation.
      if (process.platform !== 'win32') {
        symlinkSync(path.join(dir,'emulator_credentials'),path.join(dir,'ca.pem'));
        assert.equal((await inspectOfficialSession({home:h})).status,'missing_ca');
      }
    });
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('flags permit only one loopback port and one JSON flag',()=>{
  assert.deepEqual(parseOfficialSessionArgs(['--json','--port','9299']),{port:9299,json:true,identity:false});
  assert.deepEqual(parseOfficialSessionArgs(['--identity','--json']),{port:9297,json:true,identity:true});
  assert.deepEqual(parseOfficialSessionArgs([]),{port:9297,json:false,identity:false});
  for(const bad of [['--port','0'],['--port','65536'],['--port','-1'],
    ['--port','127.0.0.1:9297'],['--port','https://example.org'],['--json','--json'],
    ['--port','9297','--port','9298'],['--port'],['--unknown'],['--identity','--identity']])
    assert.throws(()=>parseOfficialSessionArgs(bad));
});

test('CLI cannot be steered to remote AWS and does not require Docker',()=>{
  const home=mkdtempSync(path.join(tmpdir(),'aws-companion-cli-'));
  try {
    const env={...process.env,HOME:home,USERPROFILE:home,
      DOCKER_HOST:'tcp://198.51.100.9:2376',AWS_ACCESS_KEY_ID:'SECRET_DO_NOT_PRINT'};
    const result=spawnSync(process.execPath,[BIN,'official-session','--json'],
      {encoding:'utf8',timeout:10000,env});
    assert.equal(result.status,1);
    const report=JSON.parse(result.stdout);
    assert.equal(report.status,'not_configured');
    assert.equal(report.localHealthPassed,false);
    assert.equal(report.cloudCallsMade,false);
    assert.equal(report.credentialFilesRead,false);
    assert.doesNotMatch(result.stdout+result.stderr,/SECRET_DO_NOT_PRINT|198\.51\.100\.9/);
    const invalid=spawnSync(process.execPath,[BIN,'official-session','--port','https://aws.amazon.com'],
      {encoding:'utf8',timeout:10000,env});
    assert.equal(invalid.status,2);
    assert.equal(invalid.stdout,'');
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('explicit identity opt-in follows verified health and reports only bounded STS proof',async()=>{
  await fixture(async({home})=>{
    const calls=[];
    const report=await inspectOfficialSession({home,identity:true,
      probe:async()=>{calls.push('health');return {statusCode:200,body:'ok'};},
      identityRunner:async({port,sessionDir,caSha256})=>{
        calls.push('sts');
        assert.equal(port,9297);
        assert.ok(sessionDir.endsWith(path.join('.aws','emulator','9297')));
        assert.match(caSha256,/^[a-f0-9]{64}$/);
        return {status:'verified',accountVerified:true,credentialFilesRead:true,sdkCallAttempted:true};
      }});
    assert.deepEqual(calls,['health','sts']);
    assert.equal(report.status,'identity_verified');
    assert.equal(report.accountIdentityVerified,true);
    assert.equal(report.localHealthPassed,true);
    assert.deepEqual(report.sdkProbe,{operation:'sts.GetCallerIdentity',passed:true,attempted:true});
    assert.equal(report.credentialFilesRead,true);
    assert.equal(report.officialPackageVerified,false);
    assert.equal(report.applicationBehaviorTested,false);
    assert.equal(report.cloudCallsMade,false);
    assert.doesNotMatch(JSON.stringify(report),/SENTINEL_NEVER_READ_PRIVATE_KEY|TEST_ONLY_CERTIFICATE/);
  });
});

test('verified worker claims are rejected when SDK attempt or credential read evidence is missing',async()=>{
  await fixture(async({home})=>{
    for(const evidence of [
      {sdkCallAttempted:false,credentialFilesRead:true},
      {sdkCallAttempted:true,credentialFilesRead:false},
      {sdkCallAttempted:false,credentialFilesRead:false},
      {sdkCallAttempted:true},
      {credentialFilesRead:true},
    ]) {
      const forged={status:'verified',accountVerified:true,...evidence};
      const report=await inspectOfficialSession({home,identity:true,
        probe:async()=>({statusCode:200,body:'ok'}),
        identityRunner:async()=>forged});
      assert.equal(report.localHealthPassed,true);
      assert.equal(report.status,'identity_unverified');
      assert.equal(report.accountIdentityVerified,false);
      assert.equal(report.sdkProbe.passed,false);
      assert.equal(report.sdkProbe.reason,'probe_unverified');
      assert.equal(report.sdkProbe.attempted,evidence.sdkCallAttempted===true);
      assert.equal(report.credentialFilesRead,evidence.credentialFilesRead===true);
      assert.equal(report.cloudCallsMade,false);
    }
  });
});

test('invalid STS account never passes even when HTTPS health is healthy',async()=>{
  await fixture(async({home})=>{
    const report=await inspectOfficialSession({home,identity:true,
      probe:async()=>({statusCode:200,body:'ok'}),
      identityRunner:async()=>({status:'unexpected_account',accountVerified:false,credentialFilesRead:true,sdkCallAttempted:true})});
    assert.equal(report.localHealthPassed,true);
    assert.equal(report.accountIdentityVerified,false);
    assert.equal(report.status,'identity_unverified');
    assert.equal(report.sdkProbe.passed,false);
    assert.equal(report.sdkProbe.reason,'unexpected_account');
  });
});

test('unhealthy or missing local CA never triggers the credential-aware worker',async()=>{
  await fixture(async({home})=>{
    let called=0;
    const runner=async()=>{called++; return {status:'verified',accountVerified:true,credentialFilesRead:true,sdkCallAttempted:true};};
    const unhealthy=await inspectOfficialSession({home,identity:true,
      probe:async()=>({statusCode:302,body:'ok'}),identityRunner:runner});
    assert.equal(unhealthy.localHealthPassed,false);
    assert.equal(unhealthy.accountIdentityVerified,false);
    const fs=await import('node:fs');
    fs.unlinkSync(path.join(home,'.aws','emulator','9297','ca.pem'));
    const missing=await inspectOfficialSession({home,identity:true,
      probe:async()=>{throw Error('CA must prevent request');},identityRunner:runner});
    assert.equal(missing.status,'missing_ca');
    assert.equal(called,0);
  });
});

test('CLI identity opt-in rejects missing official session and poisoned AWS environment',()=>{
  const home=mkdtempSync(path.join(tmpdir(),'aws-companion-sts-cli-'));
  try {
    const env={...process.env,HOME:home,USERPROFILE:home,
      AWS_ACCESS_KEY_ID:'AKIA_TEST_FAKE_CLOUD_KEY',
      AWS_PROFILE:'production',AWS_ENDPOINT_URL:'https://aws.amazon.com',
      AWS_CONTAINER_CREDENTIALS_FULL_URI:'http://198.51.100.2/metadata'};
    const result=spawnSync(process.execPath,[BIN,'official-session','--identity','--json'],{
      encoding:'utf8',timeout:10000,env});
    assert.equal(result.status,1);
    const report=JSON.parse(result.stdout);
    assert.equal(report.status,'not_configured');
    assert.equal(report.accountIdentityVerified,false);
    assert.equal(report.credentialFilesRead,false);
    assert.equal(report.cloudCallsMade,false);
    assert.doesNotMatch(result.stdout+result.stderr,
      /AKIA_TEST_FAKE_CLOUD_KEY|198\.51\.100\.2|aws\.amazon\.com/);
  }finally{rmSync(home,{recursive:true,force:true});}
});
