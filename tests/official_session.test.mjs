import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
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
  assert.deepEqual(parseOfficialSessionArgs(['--json','--port','9299']),{port:9299,json:true});
  assert.deepEqual(parseOfficialSessionArgs([]),{port:9297,json:false});
  for(const bad of [['--port','0'],['--port','65536'],['--port','-1'],
    ['--port','127.0.0.1:9297'],['--port','https://example.org'],['--json','--json'],
    ['--port','9297','--port','9298'],['--port'],['--unknown']])
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
