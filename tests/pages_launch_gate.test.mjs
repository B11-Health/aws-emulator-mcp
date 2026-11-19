import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {
  DOCS,
  PUBLIC_BASE,
  REQUIRED_EVIDENCE,
  internalPath,
  linkedAssets,
  navigationAssets,
  videoPosterAssets,
  appProofCopyErrors,
  evidenceAssets,
  auditLocal,
  auditPublic,
} from '../scripts/pages_launch_gate.mjs';

const text = path => readFileSync(join(DOCS,path),'utf8');

function localWith({replace={},missing=[]}={}) {
  return auditLocal({
    docs:DOCS,
    read:(path,encoding) => {
      const relative=path.slice(DOCS.length+1).replaceAll('\\','/');
      return Object.hasOwn(replace,relative) ? replace[relative] : readFileSync(path,encoding);
    },
    exists:path => {
      const relative=path.slice(DOCS.length+1).replaceAll('\\','/');
      return !missing.includes(relative) && existsSync(path);
    }
  });
}

function mime(path) {
  return path.endsWith('.html')?'text/html; charset=utf-8':
    path.endsWith('.js')?'text/javascript; charset=utf-8':
    path.endsWith('.css')?'text/css; charset=utf-8':
    path.endsWith('.json')?'application/json':
    path.endsWith('.mp4')?'video/mp4':
    path.endsWith('.jpg')?'image/jpeg':
    path.endsWith('.vtt')?'text/vtt':'application/octet-stream';
}
function publicMock({missing=[],replace={},badMime={}}={}) {
  const calls=[];
  const fetcher=async (url, init) => {
    assert.equal(new URL(url).origin,new URL(PUBLIC_BASE).origin,'must not fetch outside Pages');
    assert.ok(url.startsWith(PUBLIC_BASE),'must stay under Pages site path');
    assert.equal(init.redirect,'error');
    assert.equal(init.cache,'no-store');
    assert.ok(!init.headers.Authorization,'never forward credentials');
    const pathname=url.slice(PUBLIC_BASE.length);
    calls.push({pathname,method:init.method});
    const body=Object.hasOwn(replace,pathname)?replace[pathname]:existsSync(join(DOCS,pathname))?text(pathname):'';
    const absent=missing.includes(pathname) || !existsSync(join(DOCS,pathname));
    const contentType=badMime[pathname] || mime(pathname);
    return {
      ok:!absent,
      status:absent?404:200,
      headers:{get:k=>k==='content-type'?contentType:k==='content-length'?String(Buffer.byteLength(body)):null},
      text:async()=> {
        assert.equal(init.method,'GET','never download heavy media');
        return body;
      }
    };
  };
  return {fetcher,calls};
}

test('prelaunch source integrity: homepage links to explorer and two real red/green JSON records',()=>{
  const result=localWith();
  assert.equal(result.passed,true,result.errors.join('\n'));
  assert.equal(result.mode,'local');
  assert.ok(result.checked>=15,'must check homepage, CSS, JavaScript, media links and evidence');
  assert.ok(linkedAssets(text('index.html'),'index.html').has('proof-explorer.html'));
  assert.ok(linkedAssets(text('proof-explorer.html'),'proof-explorer.html').has('proof-explorer.js'));
  assert.deepEqual([...evidenceAssets(text('proof-explorer.js'))].sort(),[...REQUIRED_EVIDENCE].sort());
});

test('local gate catches broken homepage-to-Explorer navigation, even though Explorer source exists',()=>{
  const home=text('index.html');
  assert.ok(home.includes('href="proof-explorer.html"'));
  const result=localWith({replace:{'index.html':home.replace('href="proof-explorer.html"','href="#proof-explorer"')}});
  assert.equal(result.passed,false);
  assert.ok(result.errors.some(x=>x.includes('NO HOMEPAGE LINK')));
});

test('local gate catches missing page, script, stylesheet, and required independent evidence files',()=>{
  for(const filename of [
    'proof-explorer.html','proof-explorer.js','proof-explorer.css',
    ...REQUIRED_EVIDENCE,'assets/demos/beta15-quickstart-demo.mp4',
  ]){
    const result=localWith({missing:[filename]});
    assert.equal(result.passed,false,'required file removal should fail: '+filename);
    assert.ok(result.errors.some(x=>x.includes('MISSING docs/'+filename)),filename+': '+result.errors.join('\n'));
  }
});

test('local gate refuses missing JSON loader, malformed records, and a swapped S3 case',()=>{
  const js=text('proof-explorer.js');
  const script=localWith({replace:{'proof-explorer.js':js.replace('evidence/app-case-s3-aws-emulator-1.0.506.json','evidence/unknown-case.json')}});
  assert.equal(script.passed,false);
  assert.ok(script.errors.some(x=>x.includes('does not load required evidence')));
  const broken=localWith({replace:{[REQUIRED_EVIDENCE[0]]:'not-json'}});
  assert.equal(broken.passed,false);
  assert.ok(broken.errors.some(x=>x.includes('not valid JSON')));
  const swapped=localWith({replace:{[REQUIRED_EVIDENCE[1]]:text(REQUIRED_EVIDENCE[0])}});
  assert.equal(swapped.passed,false);
  assert.ok(swapped.errors.some(x=>x.includes('wrong case')));
});

test('HTML extraction ignores comments, script strings and non-navigation href attributes',()=>{
  const html = [
    '<!-- <a href="proof-explorer.html">inert comment</a> -->',
    '<script>const x = \'<a href="proof-explorer.html">fake</a>\';</script>',
    '<div data-demo="href=&quot;proof-explorer.html&quot;">not a link</div>',
    '<link rel="stylesheet" href="demo-studio.css">',
    '<video controls poster = "assets/demos/proof-first-beta15-poster.jpg">',
    '<source src="assets/demos/proof-first-beta15.mp4"></video>',
    '<a title="quoted > markup" href="docs/example.html">real navigation</a>',
  ].join('\n');
  const all = linkedAssets(html,'index.html');
  assert.ok(all.has('assets/demos/proof-first-beta15-poster.jpg'));
  assert.ok(all.has('assets/demos/proof-first-beta15.mp4'));
  assert.ok(all.has('demo-studio.css'));
  assert.ok(!all.has('proof-explorer.html'));
  assert.deepEqual([...navigationAssets(html,'index.html')],['docs/example.html']);
  assert.deepEqual([...videoPosterAssets(html,'index.html')],['assets/demos/proof-first-beta15-poster.jpg']);
  assert.throws(()=>linkedAssets('<!-- unclosed <a href="proof-explorer.html">','index.html'),/Unclosed HTML comment/);
});

test('local release gate rejects a homepage with only a commented-out Explorer link',()=>{
  const home=text('index.html');
  const anchor=/<a class="proof-link" href="proof-explorer\.html">[^<]*<\/a>/;
  assert.match(home,anchor);
  const commented=home.replace(anchor,match=>'<!-- '+match+' -->');
  assert.ok(commented.includes('href="proof-explorer.html"'),'the inert string remains');
  assert.ok(!navigationAssets(commented,'index.html').has('proof-explorer.html'));
  const result=localWith({replace:{'index.html':commented}});
  assert.equal(result.passed,false);
  assert.ok(result.errors.some(x=>x.includes('NO HOMEPAGE LINK')),result.errors.join('\n'));
});

test('local release gate catches both missing video poster bytes and missing poster attribute',()=>{
  const poster='assets/demos/proof-first-beta15-poster.jpg';
  assert.ok(videoPosterAssets(text('index.html'),'index.html').has(poster));
  const missing=localWith({missing:[poster]});
  assert.equal(missing.passed,false);
  assert.ok(missing.errors.some(x=>x.includes('MISSING docs/'+poster)),missing.errors.join('\n'));
  const html=text('index.html');
  const withoutAttr=html.replace(' poster="'+poster+'"','');
  assert.notEqual(withoutAttr,html);
  const omitted=localWith({replace:{'index.html':withoutAttr}});
  assert.equal(omitted.passed,false);
  assert.ok(omitted.errors.some(x=>x.includes('MISSING VIDEO POSTER ATTRIBUTE')),omitted.errors.join('\n'));
});

test('app proof copy has separate portable preflight, optional build, and trusted compare steps',()=>{
  const html=text('index.html');
  assert.deepEqual(appProofCopyErrors(html),[]);
  const ids=['app-proof-preflight-command','app-proof-build-command','app-proof-command'];
  const blocks=ids.map(id=> {
    const match=html.match(new RegExp('<pre id="'+id+'"[^>]*><code>([\\s\\S]*?)<\\/code><\\/pre>'));
    assert.ok(match,'missing copyable block '+id);
    assert.ok(html.includes('data-copy="'+id+'"'));
    return match[1];
  });
  const [preflight,build,compare]=blocks;
  assert.match(preflight,/node bin\/aws-emulator-mcp\.mjs preflight --json/);
  assert.doesNotMatch(preflight,/\bapp-case-compare\b|\baws-emulator-mcp\.mjs build\b/);
  assert.equal(build,'node bin/aws-emulator-mcp.mjs build');
  assert.match(compare,/app-case-compare .* --json/);
  for(const script of blocks){
    assert.doesNotMatch(script,/\\\r?\n/,'PowerShell-incompatible shell continuations');
    assert.ok(script.trim().split(/\r?\n/).every(line=>line.trim().length>0));
  }
  assert.ok(html.indexOf('id="'+ids[0]+'"')<html.indexOf('id="'+ids[1]+'"'));
  assert.ok(html.indexOf('id="'+ids[1]+'"')<html.indexOf('id="'+ids[2]+'"'));
  assert.match(html,/may automatically build/);
  assert.match(html,/not<\/strong> prove Docker Desktop VM capacity/);
  assert.match(html,/Docker is not a sandbox for hostile code/);
  assert.match(html,/available only after an approved Pages deployment/);
  const weakened=html.replace('may automatically build','might do something');
  assert.ok(appProofCopyErrors(weakened).some(e=>e.includes('APP PROOF WARNINGS')));
  assert.equal(localWith({replace:{'index.html':weakened}}).passed,false);
});

test('URL resolver honors Pages project prefix and never accepts traversal outside the published site',()=>{
  assert.equal(internalPath('proof-explorer.html','index.html'),'proof-explorer.html');
  assert.equal(internalPath('./','proof-explorer.html'),'index.html');
  assert.equal(internalPath('evidence/a.json','proof-explorer.html'),'evidence/a.json');
  assert.equal(internalPath('https://github.com/aws/aws-emulator','index.html'),null);
  assert.equal(internalPath('#faq','index.html'),null);
  assert.throws(()=>internalPath('../../secret','index.html'),/outside Pages path/);
  assert.throws(()=>internalPath('javascript:alert(1)','index.html'),/Disallowed/);
});

test('post-deploy smoke succeeds only with published HTML, JS, CSS, media and two verified JSON records',async()=>{
  const fake=publicMock();
  const result=await auditPublic({fetcher:fake.fetcher});
  assert.equal(result.passed,true,result.errors.join('\n'));
  assert.ok(result.checked>=15);
  assert.ok(fake.calls.some(x=>x.pathname==='proof-explorer.html' && x.method==='GET'));
  for (const file of REQUIRED_EVIDENCE){
    assert.ok(fake.calls.some(x=>x.pathname===file&&x.method==='GET'));
  }
  assert.ok(fake.calls.some(x=>x.pathname.endsWith('.mp4')&&x.method==='HEAD'));
  assert.ok(!fake.calls.some(x=>x.pathname.includes('.aws')||x.pathname.includes('credentials')));
});

test('post-deploy smoke fails when the Explorer public URL remains HTTP 404',async()=>{
  const fake=publicMock({missing:['proof-explorer.html']});
  const report=await auditPublic({fetcher:fake.fetcher});
  assert.equal(report.passed,false);
  assert.ok(report.errors.some(x=>x.includes('proof-explorer.html: HTTP 404')));
});

test('post-deploy smoke fails on missing evidence or corrupted verification and on absent homepage link',async()=>{
  for(const file of REQUIRED_EVIDENCE){
    const fake=publicMock({missing:[file]});
    const report=await auditPublic({fetcher:fake.fetcher});
    assert.equal(report.passed,false);
    assert.ok(report.errors.some(x=>x.includes(file)&&x.includes('404')));
  }
  const badEvidence=publicMock({replace:{[REQUIRED_EVIDENCE[0]]:'{"passed":true}'}});
  const bad=await auditPublic({fetcher:badEvidence.fetcher});
  assert.equal(bad.passed,false);
  assert.ok(bad.errors.some(x=>x.includes('PUBLIC EVIDENCE')));
  const index=text('index.html');
  const badLink=publicMock({replace:{'index.html':index.replace('href="proof-explorer.html"','href="#proof-explorer"')}});
  const badHome=await auditPublic({fetcher:badLink.fetcher});
  assert.equal(badHome.passed,false);
  assert.ok(badHome.errors.some(x=>x.includes('does not link to proof-explorer.html')));
});

test('public release gate rejects a missing video poster and a commented-out Explorer link',async()=>{
  const poster='assets/demos/proof-first-beta15-poster.jpg';
  const missing=publicMock({missing:[poster]});
  const failed=await auditPublic({fetcher:missing.fetcher});
  assert.equal(failed.passed,false);
  assert.ok(failed.errors.some(x=>x.includes(poster)&&x.includes('HTTP 404')),failed.errors.join('\n'));
  assert.ok(missing.calls.some(x=>x.pathname===poster && x.method==='HEAD'));

  const real=text('index.html');
  const anchor=/<a class="proof-link" href="proof-explorer\.html">[^<]*<\/a>/;
  const commented=real.replace(anchor,x=>'<!-- '+x+' -->');
  assert.notEqual(commented,real);
  const mocked=publicMock({replace:{'index.html':commented}});
  const broken=await auditPublic({fetcher:mocked.fetcher});
  assert.equal(broken.passed,false);
  assert.ok(broken.errors.some(x=>x.includes('PUBLIC HOMEPAGE does not link to proof-explorer.html')),broken.errors.join('\n'));

  const noPoster=real.replace(' poster="'+poster+'"','');
  const missingAttribute=publicMock({replace:{'index.html':noPoster}});
  const attributeResult=await auditPublic({fetcher:missingAttribute.fetcher});
  assert.equal(attributeResult.passed,false);
  assert.ok(attributeResult.errors.some(x=>x.includes('PUBLIC HOMEPAGE missing video poster attribute')),attributeResult.errors.join('\n'));
});

test('public release gate also rejects app-proof steps with missing build warning',async()=>{
  const edited=text('index.html').replace('may automatically build','will never need a build');
  const fake=publicMock({replace:{'index.html':edited}});
  const report=await auditPublic({fetcher:fake.fetcher});
  assert.equal(report.passed,false);
  assert.ok(report.errors.some(x=>x.includes('PUBLIC APP PROOF WARNINGS')),report.errors.join('\n'));
});

test('post-deploy rejects fake MIME and HTTP redirects, without remote AWS or path overrides',async()=>{
  const wrong=publicMock({badMime:{[REQUIRED_EVIDENCE[1]]:'text/html; charset=utf-8'}});
  const result=await auditPublic({fetcher:wrong.fetcher});
  assert.equal(result.passed,false);
  assert.ok(result.errors.some(x=>x.includes('unexpected Content-Type')));
  const fake=publicMock();
  const redirected=await auditPublic({fetcher:async(url,init) => {
    if(url.endsWith('proof-explorer.html')) throw Error('redirect disallowed');
    return fake.fetcher(url,init);
  }});
  assert.equal(redirected.passed,false);
  assert.ok(redirected.errors.some(x=>x.includes('redirect disallowed')));
});
