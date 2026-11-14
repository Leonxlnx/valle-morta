// Renders the 45 s film from the running game (dev server on :5173).
//
//   node cinematic/capture.mjs --stills            quick SDR stills of every shot (framing check)
//   node cinematic/capture.mjs --bench             time one 4K sub-frame under a few quality settings
//   node cinematic/capture.mjs                     full render: 3840x2160, 24 fps, HDR10 (PQ / BT.2020), HEVC 10 bit
//   node cinematic/capture.mjs --stills --frames 4 --shots 3,5   more stills per shot, only some shots
//   options: --w 3840 --h 2160 --sub 3 --crf 17 --shots 1,2,5 --q ultra --set msaa=0,volScale=3,shadow=2048
//
// The film is rendered shot by shot into cinematic/out/seg_XX.mkv. Finished
// shots are skipped on a re-run and a shot that stalls or crashes is retried
// in a fresh browser, so the job is resumable and can run unattended. Each
// output frame is the average of `sub` jittered sub-frames (motion blur +
// antialiasing). Everything runs at below-normal priority, one GPU job at a time.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { acquireGpuLock } from '../tools/lib/gpulock.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const STILLS = !!arg('stills', false), BENCH = !!arg('bench', false);
const W = Number(arg('w', STILLS ? 1280 : 3840)), H = Number(arg('h', STILLS ? 720 : 2160));
const SUB = Number(arg('sub', 3)), CRF = String(arg('crf', 17)), FPS = 24;
const Q = arg('q', STILLS ? 'high' : 'ultra');
const OVER = Object.fromEntries(String(arg('set', '')).split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
// --frames n: n stills per shot, evenly spread over its duration (default two, at 30 % and 85 %)
const NFR = Number(arg('frames', 2));
const FRACS = NFR === 2 ? [0.3, 0.85] : Array.from({ length: NFR }, (_, k) => +((k + 0.5) / NFR).toFixed(3));
const only = arg('shots', '') ? String(arg('shots', '')).split(',').map((s) => Number(s) - 1) : null;
const FRAME_TIMEOUT = Number(arg('timeout', 45)) * 60000;   // per output frame; generous because the job yields to other work
const OUT = 'cinematic/out';
fs.mkdirSync(OUT, { recursive: true });
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* not fatal */ }
await acquireGpuLock(3600000);

// ---- encoder feed: the page POSTs raw rgb48le sub-frames here
let sink = null;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') { res.end(); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (!sink) { res.statusCode = 500; res.end(); return; }
    const buf = Buffer.concat(chunks);
    if (sink.stdin.write(buf)) res.end('ok'); else sink.stdin.once('drain', () => res.end('ok'));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

let browser = null, page = null, info = null;
async function open() {
  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    userDataDir: path.join(os.tmpdir(), 'vm-chrome-film'),
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    protocolTimeout: FRAME_TIMEOUT,
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1280,720', '--hide-scrollbars', '--mute-audio', '--disable-web-security'],
  });
  page = await browser.newPage();
  page.on('pageerror', (e) => log('page error: ' + String(e).slice(0, 200)));
  await page.goto(`http://127.0.0.1:5173/?q=${Q}&auto=1`, { waitUntil: 'load', timeout: 300000 });
  await page.waitForFunction('window.__vm && window.__vm.film', { timeout: 600000, polling: 500 });
  const hdr = !STILLS;
  info = await page.evaluate((w, h, hdr, over) => window.__vm.film.prepare(w, h, hdr, over), STILLS ? 0 : W, STILLS ? 0 : H, hdr, Object.keys(OVER).length ? OVER : null);
  await page.evaluate((sub) => { window.__vm.film.sub = sub; }, SUB);
}
async function close() { try { await browser?.close(); } catch (e) { /* already gone */ } browser = null; page = null; }

async function renderShot(i) {
  const seg = `${OUT}/seg_${String(i + 1).padStart(2, '0')}.mkv`;
  if (fs.existsSync(seg)) { log(`shot ${i + 1} already rendered`); return; }
  while (os.freemem() < 6 * 1024 ** 3) { log('low memory, waiting 60 s'); await sleep(60000); }
  const part = seg.replace('.mkv', '.part.mkv');
  // The page delivers finished frames as planar 10-bit BT.2020 Y'CbCr 4:2:0, so no filters are needed.
  const x265 = 'hdr10=1:hdr10-opt=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:range=limited:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400:log-level=error';
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', '-s', `${info.w}x${info.h}`, '-r', String(FPS), '-i', 'pipe:0',
    '-c:v', 'libx265', '-preset', 'medium', '-crf', CRF, '-x265-params', x265, '-pix_fmt', 'yuv420p10le',
    '-color_range', 'tv', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', part], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((r) => ff.on('exit', r));
  sink = ff;
  ff.stdin.on('error', () => {});
  ff.on('exit', () => { if (sink === ff) sink = null; });
  const t0 = Date.now();
  try {
    await page.evaluate((i) => window.__vm.film.begin(i), i);
    const n = info.shots[i].frames;
    for (let f = 0; f < n; f++) {
      await page.evaluate((f, url) => window.__vm.film.frame(f, url), f, `http://127.0.0.1:${PORT}/frame`);
      if (f === 2 || (f + 1) % 24 === 0) log(`shot ${i + 1} ${info.shots[i].name}: frame ${f + 1}/${n} (${((Date.now() - t0) / 1000 / (f + 1)).toFixed(1)} s/frame)`);
    }
  } catch (e) {
    sink = null;
    try { ff.kill(); } catch (e2) { /* gone */ }
    await done;
    throw e;
  }
  sink = null;
  ff.stdin.end();
  const code = await done;
  if (code !== 0) throw new Error(`ffmpeg exit ${code}`);
  fs.renameSync(part, seg);
  log(`shot ${i + 1} done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

let failed = false;
try {
  await open();
  log(`film ready: ${info.w}x${info.h}, q=${Q} ${JSON.stringify(OVER)}, sub=${SUB}, ${info.shots.reduce((a, s) => a + s.frames, 0)} frames`);
  if (STILLS) {
    const files = [];
    for (let i = 0; i < info.shots.length; i++) {
      if (only && !only.includes(i)) continue;
      for (const frac of FRACS) {
        // the dev server reloads the page when someone saves a file: reopen and try again
        let st = null;
        for (let a = 0; a < 4 && !st; a++) {
          try { if (!page) await open(); st = await page.evaluate((i, f) => window.__vm.film.still(i, f), i, frac); } catch (e) { log(`still retry: ${String(e && e.message).slice(0, 80)}`); await close(); await sleep(5000); }
        }
        const file = `${OUT}/still_${String(i + 1).padStart(2, '0')}_${Math.round(frac * 100)}.jpg`;
        await page.screenshot({ path: file, type: 'jpeg', quality: 88 });
        files.push(file);
        log(`still ${JSON.stringify(st)}`);
      }
    }
    execFileSync('node', ['tools/sheet.mjs', `${OUT}/stills.jpg`, '480', String(NFR <= 2 ? 4 : NFR), ...files], { stdio: 'inherit' });
  } else if (BENCH) {
    await page.evaluate(() => window.__vm.film.begin(0));
    for (const over of [{}, { msaa: 0 }, { msaa: 0, volScale: 3, volSteps: 20 }, { msaa: 0, volScale: 3, volSteps: 20, shadow: 2048, ao: 0 }]) {
      const r = await page.evaluate((o) => { const f = window.__vm.film; f.retune(o); return f.bench(3); }, over);
      log(`bench ${JSON.stringify(over)} -> ${JSON.stringify(r)} ms per sub-frame`);
    }
  } else {
    for (let i = 0; i < info.shots.length; i++) {
      if (only && !only.includes(i)) continue;
      let ok = false;
      for (let attempt = 1; attempt <= 6 && !ok; attempt++) {
        try { if (!page) await open(); await renderShot(i); ok = true; } catch (e) {
          log(`shot ${i + 1} attempt ${attempt} failed: ${String(e && e.message).slice(0, 160)}`);
          await close();
          await sleep(90000);
        }
      }
      if (!ok) throw new Error(`shot ${i + 1} failed six times`);
    }
    const segs = info.shots.map((_, i) => `${OUT}/seg_${String(i + 1).padStart(2, '0')}.mkv`);
    if (segs.every((s) => fs.existsSync(s))) {
      fs.writeFileSync(`${OUT}/list.txt`, segs.map((s) => `file '${path.resolve(s).replace(/\\/g, '/')}'`).join('\n'));
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', `${OUT}/list.txt`, '-c', 'copy', '-tag:v', 'hvc1', '-movflags', '+faststart', 'cinematic/valle-morta-4k-hdr.mp4'], { stdio: 'inherit' });
      log('FILM COMPLETE: cinematic/valle-morta-4k-hdr.mp4');
    } else log('some shots are still missing; run again to continue');
  }
} catch (e) {
  failed = true;
  log('GAVE UP: ' + (e && e.message));
} finally {
  if (sink) { try { sink.stdin.end(); } catch (e) { /* closing */ } }
  await close();
  server.close();
}
process.exit(failed ? 1 : 0);
