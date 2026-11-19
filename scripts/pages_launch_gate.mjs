/**
 * Read-only GitHub Pages launch gate.
 *
 * --local  verifies the exact /docs tree that GitHub Pages must publish.
 * --public verifies the deployed HTML, relative link destinations and two
 * project-maintained application evidence JSON files after a reviewed deploy.
 *
 * No Pages deployment, credentials, AWS calls, Docker or user source execution.
 * Public URLs are fixed to this project's GitHub Pages origin (no URL argument).
 */
import {readFileSync, existsSync} from 'node:fs';
import {dirname, extname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateEvidence} from '../docs/proof-explorer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DOCS = join(ROOT, 'docs');
export const PUBLIC_BASE = 'https://b11-health.github.io/aws-emulator-mcp/';
export const REQUIRED_EVIDENCE = Object.freeze([
  'evidence/app-case-aws-emulator-1.0.506.json',
  'evidence/app-case-s3-aws-emulator-1.0.506.json',
]);
const BROWSABLE = ['index.html', 'proof-explorer.html'];
const REQUIRED_PROOF_ASSETS = ['proof-explorer.js', 'proof-explorer.css', ...REQUIRED_EVIDENCE];
/**
 * This intentionally scans only rendered HTML start tags. A text-wide
 * href/src regex can mistake <!-- comments --> or JavaScript strings for
 * real links, and it misses the video poster attribute.
 *
 * No DOM, external parser or network dependency is required. Quoted '>'
 * characters remain inside a tag; raw script/style/textarea/title bodies
 * are skipped, because their contents are not HTML navigation elements.
 */
const RESOURCE_ATTRIBUTES = Object.freeze({
  a: ['href'], area: ['href'], link: ['href'],
  script: ['src'], img: ['src'], video: ['src', 'poster'],
  source: ['src'], track: ['src'], audio: ['src'],
  iframe: ['src'], embed: ['src'],
});
const REQUIRED_VIDEO_POSTERS = Object.freeze([
  'assets/demos/proof-first-beta15-poster.jpg',
]);
const JS_EVIDENCE = /\bfile:\s*(["'])(evidence\/[a-zA-Z0-9._/-]+\.json)\1/g;
const ASSET_RE = /^[a-zA-Z0-9._/-]+$/;
const MAX_TEXT_BYTES = 1048576;

function parseAttributes(source) {
  const found = new Map();
  let i = 0;
  while (i < source.length) {
    while (i < source.length && (/\s/.test(source[i]) || source[i] === '/')) i++;
    if (i >= source.length) break;
    const start = i;
    while (i < source.length && !/[\s=/>]/.test(source[i])) i++;
    if (i === start) {i++; continue;}
    const name = source.slice(start, i).toLowerCase();
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] !== '=') continue;
    i++;
    while (i < source.length && /\s/.test(source[i])) i++;
    let value = '';
    const quote = source[i] === '"' || source[i] === "'" ? source[i++] : null;
    if (quote) {
      const end = source.indexOf(quote, i);
      if (end < 0) throw Error('Unclosed quoted HTML attribute: ' + name);
      value = source.slice(i, end);
      i = end + 1;
    } else {
      const startValue = i;
      while (i < source.length && !/[\s>]/.test(source[i])) i++;
      value = source.slice(startValue, i);
    }
    if (!found.has(name)) found.set(name, value);
  }
  return found;
}

function *activeHtmlTags(html) {
  if (typeof html !== 'string') throw Error('HTML body must be text');
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const start = html.indexOf('<', i);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end < 0) throw Error('Unclosed HTML comment');
      i = end + 3;
      continue;
    }
    let cursor = start + 1;
    if (!/[a-z]/i.test(html[cursor] || '')) { i = cursor; continue; }
    const nameStart = cursor;
    while (cursor < html.length && /[a-z0-9:-]/i.test(html[cursor])) cursor++;
    const name = html.slice(nameStart, cursor).toLowerCase();
    if (cursor < html.length && !/[\s/>]/.test(html[cursor])) {i=cursor; continue;}
    const attrsStart = cursor;
    let quote = null;
    while (cursor < html.length) {
      const character = html[cursor];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
      cursor++;
    }
    if (cursor >= html.length) throw Error('Unclosed HTML start tag: '+name);
    const attrs = parseAttributes(html.slice(attrsStart,cursor));
    yield {name, attrs};
    i = cursor + 1;
    if (['script','style','textarea','title'].includes(name)) {
      // HTML raw-text and escapable-raw-text elements do not contain live
      // anchors, even if their strings resemble <a href="..."> markup.
      const close = lower.indexOf('</' + name, i);
      if (close < 0) throw Error('Unclosed HTML raw-text element: '+name);
      i = close;
    }
  }
}

function collectHtmlAssets(html, page, {navigationOnly = false, postersOnly = false} = {}) {
  const files = new Set();
  for (const {name, attrs} of activeHtmlTags(html)) {
    if (navigationOnly && name !== 'a' && name !== 'area') continue;
    if (postersOnly && name !== 'video') continue;
    const keys = postersOnly ? ['poster'] : navigationOnly ? ['href'] : (RESOURCE_ATTRIBUTES[name] || []);
    for (const key of keys) {
      if (!attrs.has(key)) continue;
      const file = internalPath(attrs.get(key),page);
      if (file) files.add(file);
    }
  }
  return files;
}

/**
 * Reproduce how GitHub Pages resolves relative href/src URLs. Forbid paths
 * outside this site's prefix; never accept caller-chosen network destinations.
 * External HTTP(S) links and #anchors are separately scoped out.
 */
export function internalPath(raw, page = 'index.html') {
  if (typeof raw !== 'string' || !raw.trim() || raw.startsWith('#')) return null;
  const base = new URL(page, PUBLIC_BASE);
  const u = new URL(raw, base);
  const allowed = new URL(PUBLIC_BASE);
  if (u.origin !== allowed.origin) {
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') return null;
    throw Error('Disallowed URL scheme: ' + u.protocol);
  }
  if (!u.pathname.startsWith(allowed.pathname)) throw Error('Link outside Pages path: ' + raw);
  const p = decodeURIComponent(u.pathname.slice(allowed.pathname.length));
  const name = !p || p.endsWith('/') ? p + 'index.html' : p;
  if (!ASSET_RE.test(name) || name.split('/').includes('..') || name.split('/').includes('.')) {
    throw Error('Invalid local Pages asset path: ' + raw);
  }
  return name;
}

export function linkedAssets(html, page) {
  return collectHtmlAssets(html, page);
}

export function navigationAssets(html, page) {
  return collectHtmlAssets(html, page, {navigationOnly:true});
}

export function videoPosterAssets(html, page) {
  return collectHtmlAssets(html, page, {postersOnly:true});
}

/**
 * The public copy button must never put a potentially expensive Docker build
 * in the same pasted step as an informational preflight. Validate each
 * standalone, PowerShell-compatible command and the immediately visible
 * source/disk warning before CI treats the homepage as launch-ready.
 */
export function appProofCopyErrors(html) {
  const errors = [];
  const blocks = {};
  for (const id of ['app-proof-preflight-command','app-proof-build-command','app-proof-command']) {
    const regex = new RegExp('<pre\\s+id="'+id+'"[^>]*>\\s*<code>([\\s\\S]*?)<\\/code>\\s*<\\/pre>','g');
    const matches = [...html.matchAll(regex)];
    if (matches.length !== 1 || !html.includes('data-copy="'+id+'"')) {
      errors.push('APP PROOF COPY missing or ambiguous standalone block: '+id);
      continue;
    }
    blocks[id] = matches[0][1].trim();
    if (/\\\s*\r?\n/.test(blocks[id])) {
      errors.push('APP PROOF COPY contains nonportable shell line continuation: '+id);
    }
  }
  const first = blocks['app-proof-preflight-command'] || '';
  const build = blocks['app-proof-build-command'] || '';
  const test = blocks['app-proof-command'] || '';
  if (!/^git clone --depth 1 --branch master https:\/\/github\.com\/B11-Health\/aws-emulator-mcp\.git\r?\ncd aws-emulator-mcp\r?\nnode bin\/aws-emulator-mcp\.mjs preflight --json$/.test(first)) {
    errors.push('APP PROOF COPY must clone and inspect read-only preflight without building');
  }
  if (build !== 'node bin/aws-emulator-mcp.mjs build') {
    errors.push('APP PROOF COPY requires a separately opted-in signed image build');
  }
  if (test !== 'node bin/aws-emulator-mcp.mjs app-case-compare examples/app-case/buggy.py examples/app-case/fixed.py examples/app-case/sqs-idempotency.json --json') {
    errors.push('APP PROOF COPY requires a separate single-line trusted app comparison');
  }
  if (!html.includes('may automatically build') ||
      !html.includes('Docker Desktop VM capacity') ||
      !html.includes('trusted local Python') ||
      !html.includes('Docker is not a sandbox for hostile code')) {
    errors.push('APP PROOF WARNINGS must disclose possible automatic rebuild, real disk review, and trusted-source execution');
  }
  if (!html.includes('Proof Explorer (available only after an approved Pages deployment)')) {
    errors.push('APP PROOF WARNINGS must not call the public Explorer live before deployment');
  }
  return errors;
}

export function evidenceAssets(js) {
  const paths = new Set([...js.matchAll(JS_EVIDENCE)].map(x => x[2]));
  for (const required of REQUIRED_EVIDENCE) {
    if (!paths.has(required)) throw Error('Proof Explorer script does not load required evidence: ' + required);
  }
  return paths;
}

function checkEvidence(text, filename) {
  let data;
  try { data = JSON.parse(text); }
  catch { throw Error('Evidence is not valid JSON: ' + filename); }
  const verdict = validateEvidence(data);
  if (!verdict.ok) throw Error('Evidence does not substantiate the saved red/green comparison (' + filename + '): ' + verdict.reason);
  const expected = filename.includes('s3-') ? 'independent-s3-object-write' : 'sqs-idempotent-retry';
  if (data.comparison.case !== expected) throw Error('Evidence has the wrong case: ' + filename);
}

/** Verify source-tree links before ANY Pages deployment or merge. */
export function auditLocal({docs = DOCS, read = readFileSync, exists = existsSync} = {}) {
  const errors = [];
  const checked = new Set();
  const root = resolve(docs);
  const reportError = (message) => errors.push(message);
  const full = (p) => {
    const pathname = resolve(root, p);
    if (!pathname.startsWith(root + sep)) throw Error('Path escaped docs/: ' + p);
    return pathname;
  };
  const fileIsPresent = (p) => {
    const pathname = full(p);
    if (!exists(pathname)) { reportError('MISSING docs/' + p); return false; }
    checked.add(p);
    return true;
  };
  const readText = (p) => String(read(full(p), 'utf8'));
  const pages = new Map();
  for (const p of BROWSABLE) {
    if (fileIsPresent(p)) {
      try { pages.set(p,readText(p)); }
      catch (e) { reportError('UNREADABLE docs/' + p + ': ' + e.message); }
    }
  }
  const homepage = pages.get('index.html') || '';
  for (const message of appProofCopyErrors(homepage)) reportError(message);
  const explorer = pages.get('proof-explorer.html') || '';
  if (!navigationAssets(homepage, 'index.html').has('proof-explorer.html')) {
    reportError('NO HOMEPAGE LINK: docs/index.html must link to proof-explorer.html');
  }
  for (const name of ['proof-explorer.js','proof-explorer.css']) {
    if (!linkedAssets(explorer, 'proof-explorer.html').has(name)) {
      reportError('PROOF PAGE ASSET NOT LINKED: ' + name);
    }
  }
  try {
    const posters = videoPosterAssets(homepage,'index.html');
    for (const name of REQUIRED_VIDEO_POSTERS) {
      if (!posters.has(name)) reportError('MISSING VIDEO POSTER ATTRIBUTE: '+name);
    }
  } catch (e) { reportError('INVALID VIDEO POSTER markup: '+e.message); }
  const files = new Set(REQUIRED_PROOF_ASSETS);
  for (const [page, html] of pages) {
    try {
      for (const f of linkedAssets(html,page)) files.add(f);
    } catch (e) { reportError('INVALID HTML LINK in ' + page + ': ' + e.message); }
  }
  let js = '';
  if (fileIsPresent('proof-explorer.js')) {
    try { js=readText('proof-explorer.js'); }
    catch (e) { reportError('UNREADABLE proof-explorer.js: ' + e.message); }
  }
  try {
    for (const f of evidenceAssets(js)) files.add(f);
  } catch (e) { reportError(e.message); }
  for (const f of files) fileIsPresent(f);
  for (const f of REQUIRED_EVIDENCE) {
    if (fileIsPresent(f)) {
      try { checkEvidence(readText(f),f); }
      catch (e) { reportError(e.message); }
    }
  }
  return {mode:'local',passed:errors.length===0,checked:checked.size,errors};
}

function expectedType(name) {
  const ext = extname(name).toLowerCase();
  const types = {'.html':/text\/html/i,'.js':/(?:java|ecma)script/i,
    '.css':/text\/css/i,'.json':/application\/json/i,'.mp4':/video\/mp4/i,
    '.jpg':/image\/jpeg/i,'.jpeg':/image\/jpeg/i,'.png':/image\/png/i,
    '.gif':/image\/gif/i,'.vtt':/text\/vtt/i,'.svg':/image\/svg\+xml/i};
  return types[ext] || null;
}

/**
 * Fetch ONLY first-party public Pages paths. GET bounded HTML/JS/JSON; HEAD
 * large media. No cookies, credentials, AWS APIs, arbitrary endpoints or writes.
 */
async function loadPublic(file, fetcher, checked, errors) {
  const url = new URL(file, PUBLIC_BASE);
  if (url.origin !== new URL(PUBLIC_BASE).origin || !url.pathname.startsWith(new URL(PUBLIC_BASE).pathname)) {
    errors.push('DISALLOWED public path: '+file); return null;
  }
  const getBody = /\.(?:html|js|json)$/.test(file);
  const method = getBody ? 'GET' : 'HEAD';
  try {
    const resp = await fetcher(url.href, {method, redirect:'error', cache:'no-store',
      headers:{'Accept':getBody?'text/html, application/json, text/javascript, */*':'*/*'},
      signal:AbortSignal.timeout(12000)});
    const mime=resp.headers.get('content-type') || '';
    if (!resp.ok) throw Error('HTTP '+resp.status);
    const type=expectedType(file);
    if (type && !type.test(mime)) throw Error('unexpected Content-Type '+(mime || '(missing)'));
    checked.add(file);
    if (!getBody) return '';
    const length = Number(resp.headers.get('content-length') || 0);
    if (length > MAX_TEXT_BYTES) throw Error('response exceeds 1 MiB');
    const body=await resp.text();
    if (Buffer.byteLength(body,'utf8') > MAX_TEXT_BYTES) throw Error('response exceeds 1 MiB');
    return body;
  } catch(e) { errors.push('PUBLIC FAILURE '+url.href+': '+e.message); return null; }
}

/** Browser-facing, read-only post-deployment smoke. Not run automatically on PRs. */
export async function auditPublic({fetcher = fetch} = {}) {
  const errors=[],checked=new Set();
  const home = await loadPublic('index.html',fetcher,checked,errors);
  const proof = await loadPublic('proof-explorer.html',fetcher,checked,errors);
  const links = new Set(REQUIRED_PROOF_ASSETS);
  if (home!==null) {
    for (const message of appProofCopyErrors(home)) errors.push('PUBLIC '+message);
    try {
      const found=linkedAssets(home,'index.html');
      if (!navigationAssets(home,'index.html').has('proof-explorer.html'))
        errors.push('PUBLIC HOMEPAGE does not link to proof-explorer.html');
      const posters = videoPosterAssets(home,'index.html');
      for (const name of REQUIRED_VIDEO_POSTERS) {
        if (!posters.has(name)) errors.push('PUBLIC HOMEPAGE missing video poster attribute: '+name);
      }
      for (const f of found) links.add(f);
    } catch(e){errors.push('PUBLIC HOMEPAGE link parse failed: '+e.message);}
  }
  if (proof!==null) {
    try {
      const found=linkedAssets(proof,'proof-explorer.html');
      for (const f of ['proof-explorer.js','proof-explorer.css']) if (!found.has(f)) errors.push('PUBLIC PROOF PAGE missing link to '+f);
      for (const f of found) links.add(f);
    } catch(e){errors.push('PUBLIC PROOF PAGE link parse failed: '+e.message);}
  }
  const js=await loadPublic('proof-explorer.js',fetcher,checked,errors);
  if (js !== null) {
    try{for(const f of evidenceAssets(js)) links.add(f);}
    catch(e){errors.push('PUBLIC PROOF SCRIPT: '+e.message);}
  }
  // Fetch bounded JSON, and use HEAD for big media to avoid downloading videos.
  for (const file of [...links].sort()) {
    if (['index.html','proof-explorer.html','proof-explorer.js'].includes(file)) continue;
    const body=await loadPublic(file,fetcher,checked,errors);
    if (body!==null && REQUIRED_EVIDENCE.includes(file)) {
      try {checkEvidence(body,file);}
      catch(e){errors.push('PUBLIC EVIDENCE: '+e.message);}
    }
  }
  return {mode:'public',base:PUBLIC_BASE,passed:errors.length===0,checked:checked.size,errors};
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const mode=process.argv[2];
  if (!['--local','--public'].includes(mode) || process.argv.length !== 3) {
    process.stderr.write('Usage: node scripts/pages_launch_gate.mjs --local | --public\n');
    process.exitCode=2;
  } else {
    try {
      const result=mode==='--local'?auditLocal():await auditPublic();
      process.stdout.write(JSON.stringify(result,null,2)+'\n');
      if (!result.passed) process.exitCode=1;
    } catch(e) {
      process.stderr.write('Pages gate failed closed: '+e.message+'\n');
      process.exitCode=1;
    }
  }
}
