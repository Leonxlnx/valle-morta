// Renders the 45 s film (30 fps) from the running game (dev server on :5183).
//
//   node cinematic/capture.mjs --stills            quick SDR stills of every shot (framing check)
//   node cinematic/capture.mjs --stills --frames 4 --shots 3,5 [--from 0.2 --to 0.5]   more stills, only some shots / a part of them
//   node cinematic/capture.mjs --trace 2           aim trace of shot 2 (yaw / pitch over time, angular speed table), no drawing
//   node cinematic/capture.mjs --preview           the whole film at 1280x720 SDR, 2 sub-frames, H.264 -> out/preview_video.mp4
//                                                  + out/preview_sheet.jpg + out/preview_events.json, then finish.mjs --preview
//   node cinematic/capture.mjs                     final: 3840x2160 HDR10 (PQ / BT.2020), HEVC Main 10, ultra, 3 sub-frames
//                                                  -> out/seg_XX.mkv (resumable) -> valle-morta-4k-hdr.mp4 + out/film_events.json
//   node cinematic/capture.mjs --bench             time one sub-frame under the film's settings
//   options: --w --h --sub --crf --shots 1,2,5 --q ultra --set aoFull=1,reflect=1
//
// The film is rendered shot by shot into segments; finished shots are skipped on
// a re-run and a shot that stalls or crashes is retried in a fresh browser, so
// the job is resumable and can run unattended. Each output frame is the average
// of `sub` jittered sub-frames (motion blur + antialiasing). The game's sound
// tape is recorded per shot in the same run as the frames. Everything runs at
// below-normal priority, one GPU job at a time.
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
const STILLS = !!arg('stills', false), BENCH = !!arg('bench', false), PREVIEW = !!arg('preview', false), TRACE = arg('trace', false);
const LIGHT = STILLS || TRACE;
const FPS = 30;
const W = Number(arg('w', LIGHT || PREVIEW ? 1280 : 3840)), H = Number(arg('h', LIGHT || PREVIEW ? 720 : 2160));
const SUB = Number(arg('sub', PREVIEW || LIGHT ? 2 : 3)), CRF = String(arg('crf', PREVIEW ? 18 : 17));
const Q = arg('q', LIGHT ? 'high' : 'ultra');
const SAFE = W <= 1280 && H <= 720;
// film-only quality where it is free offline: full-resolution AO and reflections, longest shadow range and grass reach
const FINAL_OVER = { aoFull: 1, reflect: 1, shadowRange: 200 };
const FINAL_QO = 'grassRange:2';
const OVER = Object.fromEntries(String(arg('set', '')).split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
if (!LIGHT && !PREVIEW) for (const k in FINAL_OVER) if (!(k in OVER)) OVER[k] = FINAL_OVER[k];
const NFR = Number(arg('frames', 2)), F0 = Number(arg('from', 0)), F1 = Number(arg('to', 1));
const FRACS = NFR === 2 && F0 === 0 && F1 === 1 ? [0.3, 0.85] : Array.from({ length: NFR }, (_, k) => +(F0 + (F1 - F0) * (k + 0.5) / NFR).toFixed(4));
const only = arg('shots', '') ? String(arg('shots', '')).split(',').map((s) => Number(s) - 1) : null;
const FRAME_TIMEOUT = Number(arg('timeout', 45)) * 60000;   // per output frame; generous because the job yields to other work
const OUT = 'cinematic/out';
const SEG = PREVIEW ? (i) => `${OUT}/pseg_${String(i + 1).padStart(2, '0')}.mp4` : (i) => `${OUT}/seg_${String(i + 1).padStart(2, '0')}.mkv`;
const TAPE = PREVIEW ? (i) => `${OUT}/pseg_${String(i + 1).padStart(2, '0')}.tape.json` : (i) => `${OUT}/seg_${String(i + 1).padStart(2, '0')}.tape.json`;
fs.mkdirSync(OUT, { recursive: true });
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!SAFE && !BENCH && !arg('final', false) && !LIGHT && !PREVIEW) log('final 4K render: pass --final to confirm');
if (!SAFE && !BENCH && !arg('final', false) && !LIGHT && !PREVIEW) process.exit(2);

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* not fatal */ }
await acquireGpuLock(3600000);

// ---- encoder feed: the page POSTs finished planar Y'CbCr frames here
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
  const qo = !LIGHT && !PREVIEW ? `&qo=${FINAL_QO}` : '';
  await page.goto(`http://127.0.0.1:5183/?q=${Q}&auto=1${qo}`, { waitUntil: 'load', timeout: 600000 });
  await page.waitForFunction('window.__vm && window.__vm.film', { timeout: 1200000, polling: 1000 });
  const mode = LIGHT ? null : PREVIEW ? 'sdr' : 'hdr';
  info = await page.evaluate((w, h, mode, over) => window.__vm.film.prepare(w, h, mode, over), LIGHT ? 0 : W, LIGHT ? 0 : H, mode, Object.keys(OVER).length ? OVER : null);
  await page.evaluate((sub) => { window.__vm.film.sub = sub; }, SUB);
}
async function close() { try { await browser?.close(); } catch (e) { /* already gone */ } browser = null; page = null; }

function encoder(file) {
  if (PREVIEW) {
    return spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${info.w}x${info.h}`, '-r', String(FPS), '-i', 'pipe:0',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', CRF, '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-an', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  }
  // HEVC Main 10, PQ, BT.2020, mastering metadata
  const x265 = 'hdr10=1:hdr10-opt=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:range=limited:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400:log-level=error';
  return spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', '-s', `${info.w}x${info.h}`, '-r', String(FPS), '-i', 'pipe:0',
    '-c:v', 'libx265', '-preset', 'medium', '-profile:v', 'main10', '-crf', CRF, '-x265-params', x265, '-pix_fmt', 'yuv420p10le',
    '-color_range', 'tv', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', file], { stdio: ['pipe', 'inherit', 'inherit'] });
}

async function renderShot(i) {
  const seg = SEG(i);
  if (fs.existsSync(seg) && fs.existsSync(TAPE(i))) { log(`shot ${i + 1} already rendered`); return; }
  while (os.freemem() < 4 * 1024 ** 3) { log('low memory, waiting 60 s'); await sleep(60000); }
  const part = seg.replace(/\.(mkv|mp4)$/, '.part.$1');
  const ff = encoder(part);
  const done = new Promise((r) => ff.on('exit', r));
  sink = ff;
  ff.stdin.on('error', () => {});
  ff.on('exit', () => { if (sink === ff) sink = null; });
  const t0 = Date.now();
  let tape = null;
  try {
    await page.evaluate((i) => window.__vm.film.begin(i, true), i);
    const n = info.shots[i].frames;
    for (let f = 0; f < n; f++) {
      await page.evaluate((f, url) => window.__vm.film.frame(f, url), f, `http://127.0.0.1:${PORT}/frame`);
      if (f === 2 || (f + 1) % 30 === 0) log(`shot ${i + 1} ${info.shots[i].name}: frame ${f + 1}/${n} (${((Date.now() - t0) / 1000 / (f + 1)).toFixed(2)} s/frame)`);
    }
    tape = await page.evaluate(() => window.__vm.film.endTape());
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
  fs.writeFileSync(TAPE(i), JSON.stringify({ name: info.shots[i].name, start: info.shots[i].start, duration: info.shots[i].duration, events: (tape && tape.events) || [], taped: !!tape }));
  fs.renameSync(part, seg);
  const st = await page.evaluate((i) => window.__vm.film.state(i), i);
  log(`shot ${i + 1} done in ${((Date.now() - t0) / 60000).toFixed(1)} min, ${((Date.now() - t0) / 1000 / info.shots[i].frames).toFixed(2)} s/frame, tape ${tape ? tape.events.length + ' events' : 'none'}; ${JSON.stringify(st)}`);
}

function stitch() {
  const segs = info.shots.map((_, i) => SEG(i));
  if (!segs.every((s) => fs.existsSync(s))) { log('some shots are still missing; run again to continue'); return false; }
  fs.writeFileSync(`${OUT}/list.txt`, segs.map((s) => `file '${path.resolve(s).replace(/\\/g, '/')}'`).join('\n'));
  const outFile = PREVIEW ? `${OUT}/preview_video.mp4` : 'cinematic/valle-morta-4k-hdr.mp4';
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', `${OUT}/list.txt`, '-c', 'copy', ...(PREVIEW ? [] : ['-tag:v', 'hvc1']), '-movflags', '+faststart', outFile], { stdio: 'inherit' });
  // one sound tape for the whole film
  const shots = info.shots.map((s, i) => { const t = JSON.parse(fs.readFileSync(TAPE(i), 'utf8')); return { name: s.name, start: s.start, duration: s.duration, events: t.events }; });
  const ev = `${OUT}/${PREVIEW ? 'preview_events' : 'film_events'}.json`;
  fs.writeFileSync(ev, JSON.stringify({ fps: FPS, shots }));
  log(`FILM COMPLETE: ${outFile}, ${ev} (${shots.reduce((a, s) => a + s.events.length, 0)} sound events)`);
  if (PREVIEW) {
    // contact sheet: four frames per shot
    const files = [];
    info.shots.forEach((s, i) => [0.125, 0.375, 0.625, 0.875].forEach((u, k) => {
      const f = `${OUT}/psheet_${String(i + 1).padStart(2, '0')}_${k}.jpg`;
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (s.duration * u).toFixed(3), '-i', SEG(i), '-frames:v', '1', '-q:v', '3', f]);
      files.push(f);
    }));
    execFileSync('node', ['tools/sheet.mjs', `${OUT}/preview_sheet.jpg`, '400', '4', ...files], { stdio: 'inherit' });
    for (const f of files) fs.rmSync(f, { force: true });
  }
  return true;
}

let failed = false;
try {
  await open();
  log(`film ready: ${info.w}x${info.h}, q=${Q} ${JSON.stringify(OVER)}, sub=${SUB}, ${FPS} fps, ${info.shots.reduce((a, s) => a + s.frames, 0)} frames`);
  if (TRACE) {
    const i = Number(TRACE) - 1;
    const { trace, state } = await page.evaluate((i, sub) => window.__vm.film.traceShot(i, sub), i, SUB);
    fs.writeFileSync(`${OUT}/trace_${String(i + 1).padStart(2, '0')}.csv`, 't,yaw,pitch,recoil_sway,rounds\n' + trace.map((r) => r.join(',')).join('\n'));
    // angular speed of the view per output frame (deg/s), and the change of speed between frames
    const fr = [];
    for (let k = SUB; k < trace.length; k += SUB) {
      const a = trace[k - SUB], b = trace[k];
      const dy = Math.atan2(Math.sin(b[1] - a[1]), Math.cos(b[1] - a[1])), dp = (b[2] + b[3]) - (a[2] + a[3]);
      fr.push({ t: b[0], v: Math.hypot(dy, dp) * FPS * 180 / Math.PI, rounds: b[4] });
    }
    const vs = fr.map((f) => f.v), acc = fr.slice(1).map((f, k) => Math.abs(f.v - fr[k].v) * FPS);
    const pct = (arr, q) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
    log(`trace ${i + 1}: ${fr.length} frames, ${state.fired} rounds, ${state.hit} hits (${state.heads} head), view speed deg/s median ${pct(vs, 0.5).toFixed(1)} p90 ${pct(vs, 0.9).toFixed(1)} max ${Math.max(...vs).toFixed(1)}; speed change deg/s2 p90 ${pct(acc, 0.9).toFixed(0)} max ${Math.max(...acc).toFixed(0)}`);
    const rows = fr.filter((_, k) => k % 3 === 0).map((f) => `${f.t.toFixed(2)}:${f.v.toFixed(0)}${f.rounds ? '/' + f.rounds : ''}`);
    log('t:deg/s/rounds ' + rows.join(' '));
  } else if (STILLS) {
    log('survey ' + JSON.stringify(await page.evaluate(() => window.__vm.film.survey())));
    const files = [];
    for (let i = 0; i < info.shots.length; i++) {
      if (only && !only.includes(i)) continue;
      for (const frac of FRACS) {
        // the dev server reloads the page when someone saves a file: reopen and try again
        let st = null;
        for (let a = 0; a < 4 && !st; a++) {
          try { if (!page) await open(); st = await page.evaluate((i, f, s) => window.__vm.film.still(i, f, s), i, frac, SUB); } catch (e) { log(`still retry: ${String(e && e.message).slice(0, 120)}`); await close(); await sleep(5000); }
        }
        const file = `${OUT}/still_${String(i + 1).padStart(2, '0')}_${String(Math.round(frac * 1000)).padStart(3, '0')}.jpg`;
        await page.screenshot({ path: file, type: 'jpeg', quality: 85 });
        files.push(file);
        log(`still ${JSON.stringify(st)}`);
      }
    }
    execFileSync('node', ['tools/sheet.mjs', `${OUT}/stills.jpg`, '400', String(Math.min(6, Math.max(4, NFR))), ...files], { stdio: 'inherit' });
  } else if (BENCH) {
    await page.evaluate(() => window.__vm.film.begin(2));
    const r = await page.evaluate(() => window.__vm.film.bench(3));
    log(`bench ${info.w}x${info.h} ${JSON.stringify(OVER)} -> ${JSON.stringify(r)} ms per sub-frame`);
  } else {
    for (let i = 0; i < info.shots.length; i++) {
      if (only && !only.includes(i)) continue;
      let ok = false;
      for (let attempt = 1; attempt <= 6 && !ok; attempt++) {
        try { if (!page) await open(); await renderShot(i); ok = true; } catch (e) {
          log(`shot ${i + 1} attempt ${attempt} failed: ${String(e && e.message).slice(0, 160)}`);
          await close();
          await sleep(30000);
        }
      }
      if (!ok) throw new Error(`shot ${i + 1} failed six times`);
    }
    if (stitch() && PREVIEW && fs.existsSync('cinematic/finish.mjs')) {
      await close();
      log('running cinematic/finish.mjs --preview');
      try { execFileSync('node', ['cinematic/finish.mjs', '--preview'], { stdio: 'inherit' }); log('finish.mjs done'); } catch (e) { log('finish.mjs failed: ' + String(e && e.message).slice(0, 160)); }
    }
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
