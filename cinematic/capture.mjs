// Renders the 45 s film from the running game (dev server on :5173).
//
//   node cinematic/capture.mjs --stills            quick SDR stills of every shot (framing check)
//   node cinematic/capture.mjs                     full render: 3840x2160, 24 fps, HDR10 (PQ / BT.2020), HEVC 10 bit
//   options: --w 3840 --h 2160 --sub 3 --crf 17 --shots 1,2,5 --q ultra
//
// The film is rendered shot by shot into cinematic/out/seg_XX.mkv (finished
// segments are skipped on a re-run, so the job is resumable), then joined
// into cinematic/valle-morta-4k-hdr.mp4. Each output frame is the average of
// `sub` jittered sub-frames (motion blur + antialiasing). Everything runs at
// below-normal priority and one GPU job at a time.
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
const STILLS = !!arg('stills', false);
const W = Number(arg('w', STILLS ? 1280 : 3840)), H = Number(arg('h', STILLS ? 720 : 2160));
const SUB = Number(arg('sub', 3)), CRF = String(arg('crf', 17));
const Q = arg('q', STILLS ? 'high' : 'ultra');
const only = arg('shots', '') ? String(arg('shots', '')).split(',').map((s) => Number(s) - 1) : null;
const OUT = 'cinematic/out';
fs.mkdirSync(OUT, { recursive: true });
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

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

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  userDataDir: path.join(os.tmpdir(), 'vm-chrome-film'),
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  protocolTimeout: 900000,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1280,720', '--hide-scrollbars', '--mute-audio', '--disable-web-security'],
});
let failed = false;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  await page.goto(`http://127.0.0.1:5173/?q=${Q}&auto=1`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction('window.__vm && window.__vm.film', { timeout: 300000, polling: 500 });
  const info = await page.evaluate((w, h, hdr) => window.__vm.film.prepare(w, h, hdr), STILLS ? 0 : W, STILLS ? 0 : H, !STILLS);
  log(`film ready: ${info.w}x${info.h}, ${info.shots.length} shots, ${info.shots.reduce((a, s) => a + s.frames, 0)} frames`);

  if (STILLS) {
    const files = [];
    for (let i = 0; i < info.shots.length; i++) {
      if (only && !only.includes(i)) continue;
      for (const frac of [0.3, 0.85]) {
        const st = await page.evaluate((i, f) => window.__vm.film.still(i, f), i, frac);
        const file = `${OUT}/still_${String(i + 1).padStart(2, '0')}_${Math.round(frac * 100)}.jpg`;
        await page.screenshot({ path: file, type: 'jpeg', quality: 88 });
        files.push(file);
        log(`still ${JSON.stringify(st)}`);
      }
    }
    execFileSync('node', ['tools/sheet.mjs', `${OUT}/stills.jpg`, '480', '4', ...files], { stdio: 'inherit' });
  } else {
    const fps = 24;
    const x265 = `hdr10=1:hdr10-opt=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400:pools=8:log-level=error`;
    const vf = (SUB > 1 ? `vflip,tmix=frames=${SUB},select=eq(mod(n\\,${SUB})\\,${SUB - 1}),setpts=N/(${fps}*TB),` : 'vflip,') + 'scale=out_color_matrix=bt2020:out_range=tv,format=yuv420p10le';
    for (let i = 0; i < info.shots.length; i++) {
      if (only && !only.includes(i)) continue;
      const seg = `${OUT}/seg_${String(i + 1).padStart(2, '0')}.mkv`;
      if (fs.existsSync(seg)) { log(`shot ${i + 1} already rendered`); continue; }
      // never start a shot while the machine is short of memory
      while (os.freemem() < 6 * 1024 ** 3) { log('low memory, waiting 60 s'); await new Promise((r) => setTimeout(r, 60000)); }
      const part = seg.replace('.mkv', '.part.mkv');
      const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-s', `${info.w}x${info.h}`, '-r', String(fps * SUB), '-i', 'pipe:0',
        '-vf', vf, '-r', String(fps), '-c:v', 'libx265', '-preset', 'medium', '-crf', CRF, '-x265-params', x265, '-pix_fmt', 'yuv420p10le',
        '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', part], { stdio: ['pipe', 'inherit', 'inherit'] });
      const done = new Promise((r) => ff.on('exit', r));
      sink = ff;
      // if the encoder dies, stop accepting frames so the page fails fast
      ff.stdin.on('error', () => {});
      ff.on('exit', () => { if (sink === ff) sink = null; });
      const t0 = Date.now();
      await page.evaluate((i) => window.__vm.film.begin(i), i);
      const n = info.shots[i].frames;
      for (let f = 0; f < n; f++) {
        await page.evaluate((f, url) => window.__vm.film.frame(f, url), f, `http://127.0.0.1:${PORT}/frame`);
        if (f === 2 || (f + 1) % 48 === 0) log(`shot ${i + 1} ${info.shots[i].name}: frame ${f + 1}/${n} (${((Date.now() - t0) / 1000 / (f + 1)).toFixed(2)} s/frame)`);
      }
      sink = null;
      ff.stdin.end();
      const code = await done;
      if (code !== 0) throw new Error(`ffmpeg failed on shot ${i + 1} (exit ${code})`);
      fs.renameSync(part, seg);
      log(`shot ${i + 1} done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    }
    const segs = info.shots.map((_, i) => `${OUT}/seg_${String(i + 1).padStart(2, '0')}.mkv`);
    if (segs.every((s) => fs.existsSync(s))) {
      fs.writeFileSync(`${OUT}/list.txt`, segs.map((s) => `file '${path.resolve(s).replace(/\\/g, '/')}'`).join('\n'));
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', `${OUT}/list.txt`, '-c', 'copy', '-tag:v', 'hvc1', '-movflags', '+faststart', 'cinematic/valle-morta-4k-hdr.mp4'], { stdio: 'inherit' });
      log('FILM COMPLETE: cinematic/valle-morta-4k-hdr.mp4');
    } else log('some shots are still missing; run again to continue');
  }
  if (errors.length) log('page errors: ' + [...new Set(errors)].slice(0, 6).join(' | '));
} catch (e) {
  failed = true;
  log('CAPTURE FAILED: ' + (e && e.message));
} finally {
  if (sink) { try { sink.stdin.end(); } catch (e) { /* closing */ } }
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
