// Renders the 45 s film (30 fps) from the running game (dev server on :5183).
//
//   node cinematic/capture.mjs --stills            quick SDR stills of every shot (framing check)
//   node cinematic/capture.mjs --stills --frames 4 --shots 3,5 [--from 0.2 --to 0.5]   more stills, only some shots / a part of them
//   node cinematic/capture.mjs --trace 2           aim trace of shot 2 (yaw / pitch over time, angular speed table), no drawing
//   node cinematic/capture.mjs --preview           the whole film at 1280x720 SDR, 2 sub-frames, H.264 -> out/preview_video.mp4
//                                                  + out/preview_sheet.jpg + out/preview_events.json, then finish.mjs --preview
//   node cinematic/capture.mjs                     final: 3840x2160 HDR10 (PQ / BT.2020), HEVC Main 10, ultra, 3 sub-frames
//                                                  -> out/seg_XX.mkv (resumable) -> valle-morta-4k-hdr.mp4 + out/film_events.json
//   node cinematic/capture.mjs --smoke             final settings, 4 frames per shot -> out/smoke_hdr.mkv, smoke_f*.jpg, smoke_sheet.jpg, smoke_stats.json
//                                                  (--seekdraw: draw every sub-frame in between too, the render's exact path; use with --w 1280 --h 720)
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
import { spawn, execFile, execFileSync } from 'node:child_process';
import { acquireGpuLock } from '../tools/lib/gpulock.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const STILLS = !!arg('stills', false), BENCH = !!arg('bench', false), PREVIEW = !!arg('preview', false), TRACE = arg('trace', false), SMOKE = !!arg('smoke', false), SIM = !!arg('sim', false), PROBE = arg('probe', false), ALOG = arg('alog', false);
const LIGHT = STILLS || TRACE || SIM || !!ALOG;
const FPS = 30;
const W = Number(arg('w', LIGHT || PREVIEW ? 1280 : 3840)), H = Number(arg('h', LIGHT || PREVIEW ? 720 : 2160));
// final: 10 to 16 sub-frames over a 180 degree shutter (stratified sample times; camera and weapon interpolated inside the 12-step simulation), see film.js
const SUB = Number(arg('sub', PREVIEW || LIGHT ? 2 : 10)), CRF = String(arg('crf', PREVIEW ? 18 : 17)), SDR_CRF = String(arg('sdrcrf', PREVIEW ? 18 : 15));
const SHUTTER = Number(arg('shutter', 0.5));
// adaptive sample count: up to SUBMAX sub-frames in a frame with fast screen motion (about one per 2.5 px of motion)
const SUBMAX = Number(arg('submax', PREVIEW || LIGHT ? 4 : 16));
const MASTERS = PREVIEW ? ['sdr'] : ['hdr', 'sdr'];
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
// segments per master: preview pseg_XX.mp4; final seg_XX.mkv (HDR10) and sseg_XX.mkv (native SDR)
const SEGM = (m, i) => (PREVIEW ? `${OUT}/pseg_${String(i + 1).padStart(2, '0')}.mp4` : `${OUT}/${m === 'hdr' ? 'seg' : 'sseg'}_${String(i + 1).padStart(2, '0')}.mkv`);
const SEG = (i) => SEGM(PREVIEW ? 'sdr' : 'hdr', i);
const TAPE = PREVIEW ? (i) => `${OUT}/pseg_${String(i + 1).padStart(2, '0')}.tape.json` : (i) => `${OUT}/seg_${String(i + 1).padStart(2, '0')}.tape.json`;
fs.mkdirSync(OUT, { recursive: true });
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!SAFE && !BENCH && !SMOKE && !PROBE && !arg('final', false) && !LIGHT && !PREVIEW) log('final 4K render: pass --final to confirm');
if (!SAFE && !BENCH && !SMOKE && !PROBE && !arg('final', false) && !LIGHT && !PREVIEW) process.exit(2);

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* not fatal */ }
await acquireGpuLock(3600000);

// ---- encoder feed: the page POSTs finished planar Y'CbCr frames here
// one encoder per master: POST /frame/hdr and /frame/sdr
let sinks = null;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') { res.end(); return; }
  const m = String(req.url).split('/').pop();
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const sink = sinks && sinks[m];
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
  const qo = arg('qo', false) ? `&qo=${arg('qo')}` : !LIGHT && !PREVIEW ? `&qo=${FINAL_QO}` : '';
  await page.goto(`http://127.0.0.1:5183/?q=${Q}&auto=1${qo}`, { waitUntil: 'load', timeout: 600000 });
  await page.waitForFunction('window.__vm && window.__vm.film', { timeout: 1200000, polling: 1000 });
  const mode = ALOG ? 'sdr' : LIGHT ? null : PREVIEW ? 'sdr' : 'hdr';
  info = await page.evaluate((w, h, mode, over) => window.__vm.film.prepare(w, h, mode, over), LIGHT && !ALOG ? 0 : W, LIGHT && !ALOG ? 0 : H, mode, Object.keys(OVER).length ? OVER : null);
  await page.evaluate((sub, sh, ss, sm) => { const f = window.__vm.film; f.sub = sub; f.subMax = sm; f.shutter = sh; if (ss) f.simSub = ss; }, SUB, SHUTTER, Number(arg('simsub', 0)), SUBMAX);
}
// A few things in the game carry over from one shot to the next (the film resets what it can), so every run plays the
// shots before shot i first, simulation only (about a second for all of them): a retried shot in a fresh browser, a
// part of the film (--shots) and the smoke test then play exactly as in a full render.
let played = -1;
async function prime(i) {
  for (let j = played + 1; j < i; j++) await page.evaluate((j) => window.__vm.film.simShot(j), j);
  played = i;
}
async function close() { played = -1; await close0(); }
async function close0() { try { await browser?.close(); } catch (e) { /* already gone */ } browser = null; page = null; }

function encoder(file, m = 'hdr') {
  if (m === 'sdr') {
    // native SDR: the game's own tone curve and grade, BT.709 limited range; final: visually lossless H.264 High
    const enc = PREVIEW ? ['-preset', 'medium', '-crf', SDR_CRF, '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv'] : ['-profile:v', 'high', '-level', '5.2', '-preset', 'slow', '-crf', SDR_CRF, '-x264-params', 'aq-mode=3:deblock=-1,-1:colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv'];
    return spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${info.w}x${info.h}`, '-r', String(FPS), '-i', 'pipe:0',
      '-c:v', 'libx264', ...enc, '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-an', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  }
  // HEVC Main 10, PQ, BT.2020, mastering metadata
  const x265 = 'hdr10=1:hdr10-opt=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:range=limited:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400:log-level=error';
  return spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', '-s', `${info.w}x${info.h}`, '-r', String(FPS), '-i', 'pipe:0',
    '-c:v', 'libx265', '-preset', 'medium', '-profile:v', 'main10', '-crf', CRF, '-x265-params', x265, '-pix_fmt', 'yuv420p10le',
    '-color_range', 'tv', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', file], { stdio: ['pipe', 'inherit', 'inherit'] });
}

async function renderShot(i) {
  // a shot counts as rendered only when every master and the tape exist; otherwise all its masters are rendered again
  const segs = MASTERS.map((m) => SEGM(m, i));
  if (segs.every((s) => fs.existsSync(s)) && fs.existsSync(TAPE(i))) { log(`shot ${i + 1} already rendered`); return; }
  while (os.freemem() < 4 * 1024 ** 3) { log('low memory, waiting 60 s'); await sleep(60000); }
  const parts = segs.map((s) => s.replace(/\.(mkv|mp4)$/, '.part.$1'));
  const encs = MASTERS.map((m, k) => { const e = encoder(parts[k], m); e.stdin.on('error', () => {}); return e; });
  const dones = encs.map((e) => new Promise((r) => e.on('exit', r)));
  const done = Promise.all(dones);
  const ff = { kill: () => encs.forEach((e) => e.kill()), stdin: { end: () => encs.forEach((e) => e.stdin.end()) } };
  sinks = Object.fromEntries(MASTERS.map((m, k) => [m, encs[k]]));
  const t0 = Date.now();
  let tape = null;
  try {
    await prime(i);
    await page.evaluate((i) => window.__vm.film.begin(i, true), i);
    const n = info.shots[i].frames;
    for (let f = 0; f < n; f++) {
      await page.evaluate((f, url) => window.__vm.film.frame(f, url), f, `http://127.0.0.1:${PORT}/frame`);
      if (f === 2 || (f + 1) % 30 === 0) log(`shot ${i + 1} ${info.shots[i].name}: frame ${f + 1}/${n} (${((Date.now() - t0) / 1000 / (f + 1)).toFixed(2)} s/frame)`);
    }
    tape = await page.evaluate(() => window.__vm.film.endTape());
  } catch (e) {
    sinks = null;
    try { ff.kill(); } catch (e2) { /* gone */ }
    await done;
    throw e;
  }
  sinks = null;
  ff.stdin.end();
  const codes = await done;
  if (codes.some((c) => c !== 0)) throw new Error(`ffmpeg exit ${codes.join(',')}`);
  fs.writeFileSync(TAPE(i), JSON.stringify({ name: info.shots[i].name, start: info.shots[i].start, duration: info.shots[i].duration, events: (tape && tape.events) || [], taped: !!tape }));
  parts.forEach((p, k) => fs.renameSync(p, segs[k]));
  const st = await page.evaluate((i) => window.__vm.film.state(i), i);
  log(`shot ${i + 1} done in ${((Date.now() - t0) / 60000).toFixed(1)} min, ${((Date.now() - t0) / 1000 / info.shots[i].frames).toFixed(2)} s/frame, tape ${tape ? tape.events.length + ' events' : 'none'}; ${JSON.stringify(st)}`);
}

function stitch() {
  if (!MASTERS.every((m) => info.shots.every((_, i) => fs.existsSync(SEGM(m, i))))) { log('some shots are still missing; run again to continue'); return false; }
  // preview: out/preview_video.mp4; final: the HDR10 master and the native SDR master (out/sdr_video.mp4, silent; finish.mjs muxes)
  let outFile = '';
  for (const m of MASTERS) {
    const segs = info.shots.map((_, i) => SEGM(m, i));
    fs.writeFileSync(`${OUT}/list_${m}.txt`, segs.map((s) => `file '${path.resolve(s).replace(/\\/g, '/')}'`).join('\n'));
    const f = PREVIEW ? `${OUT}/preview_video.mp4` : m === 'hdr' ? 'cinematic/valle-morta-4k-hdr.mp4' : `${OUT}/sdr_video.mp4`;
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', `${OUT}/list_${m}.txt`, '-c', 'copy', ...(m === 'hdr' ? ['-tag:v', 'hvc1'] : []), '-movflags', '+faststart', f], { stdio: 'inherit' });
    outFile += (outFile ? ', ' : '') + f;
  }
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
  log(`film ready: ${info.w}x${info.h}, q=${Q} ${JSON.stringify(OVER)}, sub=${SUB}-${SUBMAX}, ${FPS} fps, ${info.shots.reduce((a, s) => a + s.frames, 0)} frames`);
  if (TRACE) {
    const i = Number(TRACE) - 1;
    const { trace, state, simSub: SS } = await page.evaluate((i) => window.__vm.film.traceShot(i), i);
    fs.writeFileSync(`${OUT}/trace_${String(i + 1).padStart(2, '0')}.csv`, 't,yaw,pitch,recoil_sway,rounds\n' + trace.map((r) => r.join(',')).join('\n'));
    // angular speed of the view per output frame (deg/s), and the change of speed between frames
    const fr = [];
    for (let k = SS; k < trace.length; k += SS) {
      const a = trace[k - SS], b = trace[k];
      const dy = Math.atan2(Math.sin(b[1] - a[1]), Math.cos(b[1] - a[1])), dp = (b[2] + b[3]) - (a[2] + a[3]);
      fr.push({ t: b[0], v: Math.hypot(dy, dp) * FPS * 180 / Math.PI, rounds: b[4] });
    }
    const vs = fr.map((f) => f.v), acc = fr.slice(1).map((f, k) => Math.abs(f.v - fr[k].v) * FPS);
    const pct = (arr, q) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
    log(`trace ${i + 1}: ${fr.length} frames, ${state.fired} rounds, ${state.hit} hits (${state.heads} head), view speed deg/s median ${pct(vs, 0.5).toFixed(1)} p90 ${pct(vs, 0.9).toFixed(1)} max ${Math.max(...vs).toFixed(1)}; speed change deg/s2 p90 ${pct(acc, 0.9).toFixed(0)} max ${Math.max(...acc).toFixed(0)}`);
    const rows = fr.filter((_, k) => k % 3 === 0).map((f) => `${f.t.toFixed(2)}:${f.v.toFixed(0)}${f.rounds ? '/' + f.rounds : ''}`);
    log('t:deg/s/rounds ' + rows.join(' '));
  } else if (SIM) {
    // simulation only, every shot (or --shots): rounds, hits and head hits, and the state at --at fractions
    const at = String(arg('at', '')).split(',').filter(Boolean).map(Number);
    let F = 0, Hh = 0;
    for (let i = 0; i < info.shots.length; i++) {
      if (only && !only.includes(i)) continue;
      await prime(i);
      const r = await page.evaluate((i, at) => window.__vm.film.simShot(i, at), i, at);
      for (const m of r.mid) log(`  ${i + 1} ${JSON.stringify(m)}`);
      log(`sim ${i + 1} ${JSON.stringify(r.end)}`);
      F += r.end.fired; Hh += r.end.hit;
    }
    if (arg('fp', false)) {
      // fingerprint of shot --fp after begin, written to out/fp_<label>.json (compare two runs)
      const fp = await page.evaluate((i) => window.__vm.film.fingerprint(i), Number(arg('fp', 2)) - 1);
      fs.writeFileSync(`${OUT}/fp_${arg('label', 'a')}.json`, JSON.stringify(fp, null, 0).replace(/,"/g, ',\n"'));
    }
    log(`sim total: ${Hh}/${F} hits (${F ? Math.round(100 * Hh / F) : 0}%)`);
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
  } else if (SMOKE) {
    // final settings and pipeline, four frames per shot: the simulation runs up to each frame, only those frames are drawn
    const tag = only ? `_s${only.map((x) => x + 1).join('')}` : '';   // a part of the shots: files get a suffix
    // --sf 0.2,0.5: other frame fractions (any count); --tag name: own file names
    const SF = arg('sf', '') ? String(arg('sf', '')).split(',').map(Number) : [0.1, 0.35, 0.6, 0.85];
    const tag2 = arg('tag', '') ? `_${arg('tag', '')}` : tag;
    const file = `${OUT}/smoke_hdr${tag2}.mkv`, sfile = `${OUT}/smoke_sdr${tag2}.mkv`, url = `http://127.0.0.1:${PORT}/frame`;
    const encs = [encoder(file, 'hdr'), encoder(sfile, 'sdr')];
    encs.forEach((e) => e.stdin.on('error', () => {}));
    const done = Promise.all(encs.map((e) => new Promise((r) => e.on('exit', r))));
    const ff = { stdin: { end: () => encs.forEach((e) => e.stdin.end()) } };
    sinks = { hdr: encs[0], sdr: encs[1] };
    const pid = browser.process().pid;
    let peak = 0, minFree = os.freemem(), lowMem = false, polling = false;
    const ps = `$p=Get-CimInstance Win32_Process; $k=@(${pid}); do { $n=$k.Count; $k=@(@($k) + @($p | ? { $k -contains $_.ParentProcessId } | % ProcessId) | sort -Unique) } while ($k.Count -gt $n); ($p | ? { $k -contains $_.ProcessId } | measure WorkingSetSize -Sum).Sum`;
    const poll = () => {
      minFree = Math.min(minFree, os.freemem()); if (os.freemem() < 6 * 1024 ** 3) lowMem = true;
      if (polling) return; polling = true;
      execFile('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }, (e, o) => { polling = false; if (!e) peak = Math.max(peak, Number(String(o).trim()) || 0); });
    };
    const timer = setInterval(poll, 3000); poll();
    await page.evaluate(() => { window.__vm.film.check = true; });
    const rows = [], ends = [];
    const t00 = Date.now();
    try {
      for (let i = 0; i < info.shots.length; i++) {
        if (only && !only.includes(i)) continue;
        await prime(i);
        await page.evaluate((i) => window.__vm.film.begin(i, false), i);
        const n = info.shots[i].frames;
        let cur = 0;
        for (const u of SF) {
          const f = Math.round(u * n), ta = Date.now();
          const st = await page.evaluate((k, d) => window.__vm.film.seek(k, d), f - cur, !!arg('seekdraw', false));
          const tb = Date.now();
          const s = await page.evaluate((f, url) => window.__vm.film.frame(f, url), f, url);
          const tc = Date.now();
          cur = f + 1;
          const row = { shot: i + 1, name: info.shots[i].name, f, seek: (tb - ta) / 1000, render: +((tc - tb - s.ms) / 1000).toFixed(2), ...s, alive: st.alive, dead: st.dead, fired: st.fired };
          rows.push(row);
          log(`smoke ${JSON.stringify(row)} freeGB ${(os.freemem() / 1024 ** 3).toFixed(1)} browserGB ${(peak / 1024 ** 3).toFixed(2)}`);
          if (lowMem) throw new Error('free RAM below 6 GB');
        }
        const end = await page.evaluate((k, d) => window.__vm.film.seek(k, d), n - cur, !!arg('seekdraw', false));
        ends.push(end);
        log(`smoke end state shot ${i + 1}: ${JSON.stringify(end)}`);
      }
    } finally { clearInterval(timer); }
    sinks = null;
    const te = Date.now();
    ff.stdin.end();
    const code = (await done).join(',');
    log(`encoder exit ${code}, tail ${((Date.now() - te) / 1000).toFixed(1)} s, total ${((Date.now() - t00) / 60000).toFixed(1)} min; peak browser RAM ${(peak / 1024 ** 3).toFixed(2)} GB, min free RAM ${(minFree / 1024 ** 3).toFixed(1)} GB`);
    fs.writeFileSync(`${OUT}/smoke_stats${tag2}.json`, JSON.stringify({ w: info.w, h: info.h, sub: SUB, shutter: SHUTTER, q: Q, over: OVER, peakBrowserBytes: peak, minFreeBytes: minFree, rows, ends }, null, 1));
    await close();
    // stills from the native SDR master, a contact sheet and 1:1 crops (--crop w:h:x:y, default the weapon at the lower right)
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', sfile, '-vf', 'scale=in_range=tv:out_range=pc,format=yuvj420p', '-q:v', '2', `${OUT}/smoke${tag2}_f%02d.jpg`], { stdio: 'inherit' });
    const files = rows.map((_, k) => `${OUT}/smoke${tag2}_f${String(k + 1).padStart(2, '0')}.jpg`).filter((f) => fs.existsSync(f));
    const crop = String(arg('crop', `${Math.round(info.w * 0.25)}:${Math.round(info.h * 0.25)}:${Math.round(info.w * 0.6)}:${Math.round(info.h * 0.62)}`));
    const crops = files.map((f) => { const c = f.replace(/\.jpg$/, '_crop.jpg'); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', f, '-vf', `crop=${crop}`, '-q:v', '2', c]); return c; });
    const cols = String(Math.min(4, files.length));
    execFileSync('node', ['tools/sheet.mjs', `${OUT}/smoke_sheet${tag2}.jpg`, '480', cols, ...files], { stdio: 'inherit' });
    execFileSync('node', ['tools/sheet.mjs', `${OUT}/smoke_crops${tag2}.jpg`, crop.split(':')[0], cols, ...crops], { stdio: 'inherit' });
    for (const c of crops) fs.rmSync(c, { force: true });
    log(`smoke done: ${files.length} stills, ${OUT}/smoke_sheet${tag2}.jpg, ${OUT}/smoke_crops${tag2}.jpg`);
  } else if (ALOG) {
    // the complete action log of every shot (or --shots): --draw 1 draws every sub-frame as a render would (no read-back)
    const DRAW = arg('draw', '0') === '1' || arg('draw', '0') === true;
    await page.evaluate(() => { window.__vm.film.logging = true; });
    const all = [];
    for (let i = 0; i < info.shots.length; i++) {
      if (only && !only.includes(i)) continue;
      await prime(i);
      await page.evaluate((i) => window.__vm.film.begin(i, false), i);
      const end = await page.evaluate((n, d) => window.__vm.film.seek(n, d), info.shots[i].frames, DRAW);
      const e = await page.evaluate(() => window.__vm.film.alog.e);
      all.push({ shot: i + 1, end, e });
      log(`alog ${i + 1}: ${e.filter((x) => x[0] === 'shot').length} rounds, hits ${end.hit}, heads ${end.heads}, ${e.length} entries`);
    }
    fs.writeFileSync(`${OUT}/alog_${ALOG}.json`, JSON.stringify(all));
  } else if (PROBE) {
    // diagnostics: one frame (final pipeline) of shot:frame per variant (film.probe switches), SDR and linear, 1:1 crops
    const [ps, pf] = String(PROBE).split(':').map(Number);
    const vars = String(arg('variants', 'base')).split(',');
    const tag = String(arg('tag', 'p'));
    const crop = String(arg('crop', `${Math.round(info.w * 0.25)}:${Math.round(info.h * 0.25)}:${Math.round(info.w * 0.6)}:${Math.round(info.h * 0.62)}`));
    const got = {};
    const POUT = String(arg('pout', 'sdr,lin')).split(',');
    sinks = Object.fromEntries(['sdr', 'lin', 'hdr'].map((m) => [m, { stdin: { write: (b) => { got[m] = b; return true; } } }]));
    await page.evaluate((o) => { window.__vm.film.outputs = o; window.__vm.film.check = true; }, POUT);
    const files = [];
    for (const v of vars) {
      await page.evaluate((i, f, v) => { const film = window.__vm.film; for (let j = 0; j < i; j++) film.simShot(j); film.begin(i, false); film.seek(f); window.__undo = film.probe(v); }, ps - 1, pf, v);
      const st = await page.evaluate((f, url) => window.__vm.film.frame(f, url), pf, `http://127.0.0.1:${PORT}/frame`);
      await page.evaluate(() => { window.__undo(); });
      for (const m of POUT.filter((x) => x !== 'hdr')) {
        const f = `${OUT}/probe_${tag}_${v}_${m}.jpg`;
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${info.w}x${info.h}`, '-i', 'pipe:0', '-vf', `crop=${crop},scale=in_range=tv:out_range=pc,format=yuvj420p`, '-q:v', '2', f], { input: got[m] });
        files.push(f);
      }
      log(`probe ${v}: ${JSON.stringify({ clip: st.sdrClip, mean: st.sdrMean, maxCll: st.maxCll, fall: st.fall, sub: st.sub })}`);
    }
    execFileSync('node', ['tools/sheet.mjs', `${OUT}/probe_${tag}.jpg`, String(arg('tile', crop.split(':')[0])), String(POUT.filter((x) => x !== 'hdr').length * Number(arg('pcols', 1))), ...files], { stdio: 'inherit' });
    log(`probe sheet ${OUT}/probe_${tag}.jpg (rows: ${vars.join(', ')}; left SDR, right linear)`);
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
  if (sinks) for (const s of Object.values(sinks)) { try { s.stdin.end(); } catch (e) { /* closing */ } }
  await close();
  server.close();
}
process.exit(failed ? 1 : 0);
