#!/usr/bin/env node
/* Record a local Chrome walkthrough of the versioned, evidence-backed tour.
 * Uses only Node built-ins, the installed browser and FFmpeg; no hosted page,
 * user browser profile, account, cloud resource or prerecorded terminal output.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/assets/demos');
const WIDTH = 1280, HEIGHT = 720, FPS = 10;
const VERSIONED_EVIDENCE = path.join(ROOT, 'docs/evidence/failure-lab-aws-emulator-1.0.385.json');

function assertObservedEvidence() {
  const j = JSON.parse(readFileSync(VERSIONED_EVIDENCE, 'utf8'));
  if (!j.passed || j.baseline.observed.queueEvents !== 0 ||
      j.presendRecovery.observed.queueEvents !== 1 ||
      j.lostAckRecovery.observed.queueEvents !== 2 ||
      j.lostAckRecovery.observed.consumerEffectMarkers !== 1 ||
      ['baseline','presendRecovery','lostAckRecovery'].some(name =>
        j[name].cleanup.length !== 7 || j[name].cleanup.some(x => !x.passed))) {
    throw new Error('Recorded signed-emulator evidence no longer matches the tour');
  }
}

function chromeBinary() {
  const p = process.env.CHROME_BIN ||
    (process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : '/usr/bin/google-chrome');
  if (!existsSync(p)) throw new Error('Chrome binary missing: set CHROME_BIN');
  return p;
}

function ffmpegBinary() {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
  const py = spawnSync('python', ['-c',
    'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    });
  if (py.status === 0 && existsSync(py.stdout.trim())) return py.stdout.trim();
  return 'ffmpeg';
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForPort(profile, proc) {
  const file = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) {
      const [port] = readFileSync(file, 'utf8').trim().split(/\r?\n/);
      if (/^[0-9]{2,5}$/.test(port)) return Number(port);
    }
    if (proc.exitCode !== null) throw new Error('Chrome exited before CDP was ready');
    await sleep(80);
  }
  throw new Error('Chrome did not start its local CDP endpoint');
}

async function connect(pageUrl) {
  const ws = new WebSocket(pageUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once:true});
    ws.addEventListener('error', reject, {once:true});
  });
  const pending = new Map();
  let ident = 0;
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const {resolve, reject} = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result ?? {});
    }
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++ident; pending.set(id, {resolve, reject});
      ws.send(JSON.stringify({id, method, params}));
    });
  }
  return {ws, send};
}

async function main() {
  assertObservedEvidence();
  mkdirSync(OUT, {recursive:true});
  const temp = mkdtempSync(path.join(tmpdir(), 'aws-mcp-failure-tour-'));
  const profile = path.join(temp, 'chrome');
  const frames = path.join(temp, 'frames');
  mkdirSync(profile); mkdirSync(frames);
  let chrome, client;
  try {
    const args = [
      '--headless=new','--no-first-run','--disable-background-networking',
      '--disable-default-apps','--disable-extensions','--disable-dev-shm-usage',
      '--no-sandbox','--hide-scrollbars', '--force-device-scale-factor=1',
      '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--user-data-dir=' + profile, '--window-size=' + WIDTH + ',' + HEIGHT,
      'about:blank'
    ];
    chrome = spawn(chromeBinary(), args, {
      stdio:'ignore', shell:false, windowsHide:true
    });
    const port = await waitForPort(profile, chrome);
    const response = await fetch('http://127.0.0.1:' + port + '/json/list');
    if (!response.ok) throw new Error('Chrome local page target unavailable');
    const pages = await response.json();
    const page = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
    if (!page) throw new Error('Chrome page target missing');
    client = await connect(page.webSocketDebuggerUrl);
    const send = client.send;
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride',
      {width:WIDTH,height:HEIGHT,deviceScaleFactor:1,mobile:false});
    const url = pathToFileURL(path.join(ROOT,'docs/onboarding/index.html')).href;
    await send('Page.navigate',{url});
    for (let i=0;i<45;i++) {
      const state = await send('Runtime.evaluate',{
        expression:'document.readyState === "complete" && Boolean(window.tour)',
        returnByValue:true
      });
      if (state.result?.value) break;
      if (i===44) throw new Error('Onboarding page did not load');
      await sleep(80);
    }
    const errors = await send('Runtime.evaluate',{expression:
      'document.querySelectorAll(".step").length',returnByValue:true});
    if (errors.result?.value !== 5) throw new Error('Expected five guide steps');

    let frameIndex = 0;
    async function frame() {
      const snapshot = await send('Page.captureScreenshot',{
        format:'jpeg',quality:85,fromSurface:true,captureBeyondViewport:false
      });
      if (!snapshot.data) throw new Error('Empty Chrome screenshot');
      const filename = 'shot-' + String(frameIndex).padStart(4,'0') + '.jpg';
      writeFileSync(path.join(frames,filename),Buffer.from(snapshot.data,'base64'));
      frameIndex += 1;
      await sleep(16);
    }
    async function hold(seconds) {
      for (let i=0; i<Math.round(seconds*FPS); i++) await frame();
    }
    async function go(target) {
      const rect = await send('Runtime.evaluate',{expression:
        `(()=>{const r=document.querySelector('[data-step="${target}"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        returnByValue:true
      });
      const point = rect.result?.value;
      if (!point || !Number.isFinite(point.x)) throw new Error('Tour step not visible');
      const {x,y}=point;
      const before = target===4 ? {x:1000,y:608} : {x:230,y:335};
      for (let i=0;i<8;i++) {
        const t=(i+1)/8, e=t*t*(3-2*t);
        await send('Input.dispatchMouseEvent',{
          type:'mouseMoved',x:before.x+(x-before.x)*e,y:before.y+(y-before.y)*e
        });
        await frame();
      }
      await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
      await sleep(140);
    }

    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1050,y:615});
    await hold(1.8);
    await go(4);
    const posterFrame = frameIndex + 14;
    await hold(5.2);
    await go(1);
    await hold(2.0);
    await go(4);
    await hold(8.3);
    // Clip length is derived from the number of genuine browser captures.
    const ffmpeg = ffmpegBinary();
    const video = path.join(OUT,'failure-lab.mp4');
    const result = spawnSync(ffmpeg,[
      '-hide_banner','-loglevel','error','-y','-framerate',String(FPS),
      '-i',path.join(frames,'shot-%04d.jpg'),
      '-an','-c:v','libx264','-preset','medium','-crf','22',
      '-pix_fmt','yuv420p','-movflags','+faststart','-r','30',video
    ],{timeout:90000,encoding:'utf8',windowsHide:true});
    if (result.status !== 0) throw new Error('FFmpeg failure: ' + result.stderr?.slice(-900));
    const posterPath = path.join(frames,'shot-'+String(Math.min(posterFrame,frameIndex-1)).padStart(4,'0')+'.jpg');
    copyFileSync(posterPath,path.join(OUT,'failure-lab-poster.jpg'));
    const size=readFileSync(video);
    if (size.toString('ascii',4,8)!=='ftyp') throw new Error('Invalid MP4 file header');
    console.log(JSON.stringify({ok:true,frames:frameIndex,durationSeconds:frameIndex/FPS,
      videoBytes:size.length,posterBytes:readFileSync(path.join(OUT,'failure-lab-poster.jpg')).length,
      evidence:'docs/evidence/failure-lab-aws-emulator-1.0.385.json'}));
  } finally {
    try {client?.ws.close();} catch {}
    if (chrome && chrome.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill',['/PID',String(chrome.pid),'/T','/F'],{
        stdio:'ignore',windowsHide:true,timeout:6000});
      else chrome.kill('SIGTERM');
    }
    try {rmSync(temp,{recursive:true,force:true,maxRetries:4,retryDelay:350});} catch {}
  }
}

main().catch(error => {console.error('Recording failed: '+error.message);process.exitCode=1;});
