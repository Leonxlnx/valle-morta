// Soundtrack and final files for the film. The film is rendered far slower than real time,
// so the game logs every sound it starts (audio.startTape) and this script rebuilds the
// soundtrack offline from the same recordings, adds the score, masters it, measures it and
// muxes it into the videos.
//   node cinematic/finish.mjs --preview   cinematic/out/preview_events.json + preview_video.mp4
//                                         -> out/soundtrack_preview.wav, out/preview.mp4, out/soundtrack_preview.png
//   node cinematic/finish.mjs --final     cinematic/out/film_events.json + valle-morta-4k-hdr.mp4
//                                         -> out/soundtrack.wav, the HDR film with sound (video stream copied),
//                                            valle-morta-4k-sdr.mp4 (3840x2160) and valle-morta-1080p-sdr.mp4 beside it
//   options: --events file  --video file (or "none": audio only)  --out file.mp4  --wav file.wav  --png file.png  --no-sdr
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gameCompressor, dcBlock } from './audio/mixer.mjs';
import { SR, buildVoices, renderEffects, musicEdit, duck, lufs, limit, truePeak, writeWav, db, undb } from './audio/mixer.mjs';

const argv = process.argv.slice(2), has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 || argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? d : argv[i + 1]; };
const final = has('final');
if (!final && !has('preview')) { console.log('usage: node cinematic/finish.mjs --preview | --final [--events f] [--video f|none] [--out f.mp4] [--wav f] [--png f] [--no-sdr]'); process.exit(1); }
const OUT = 'cinematic/out';
const P = final
  ? { events: `${OUT}/film_events.json`, video: 'cinematic/valle-morta-4k-hdr.mp4', out: 'cinematic/valle-morta-4k-hdr.mp4', wav: `${OUT}/soundtrack.wav`, png: `${OUT}/soundtrack.png` }
  : { events: `${OUT}/preview_events.json`, video: `${OUT}/preview_video.mp4`, out: `${OUT}/preview.mp4`, wav: `${OUT}/soundtrack_preview.wav`, png: `${OUT}/soundtrack_preview.png` };
for (const k of Object.keys(P)) P[k] = arg(k, P[k]);
const MUSIC = path.resolve('public/assets/audio/music_film.mp3');
const TARGET = -14, CEIL = -1.6;
const ff = (args, opt = {}) => execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const probe = (f, entries, sel = 'v:0') => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', sel, '-show_entries', entries, '-of', 'json', f]).toString());
const r2 = (x, d = 2) => +(+x).toFixed(d);
// HDR10 static metadata travels in-band (SEI): compare the first frame's side data before and after the mux
const frameSide = (f) => (JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_entries', 'frame=color_transfer:frame_side_data', '-of', 'json', f]).toString()).frames || []).map((x) => JSON.stringify(x)).join();
fs.mkdirSync(path.dirname(path.resolve(P.wav)), { recursive: true });

// ------------------------------------------------------------------ inputs
const film = JSON.parse(fs.readFileSync(P.events, 'utf8'));
const useVideo = P.video !== 'none' && fs.existsSync(P.video);
if (P.video !== 'none' && !useVideo) throw new Error(`video not found: ${P.video} (use --video none for audio only)`);
const shotsEnd = Math.max(0, ...film.shots.map((s) => s.start + s.duration));
const D = useVideo ? +probe(P.video, 'format=duration', 'v:0').format.duration : shotsEnd;
const N = Math.round(D * SR);
console.log(`[finish] ${final ? 'final' : 'preview'}: ${film.shots.length} shots, ${shotsEnd.toFixed(2)} s of tape, film ${D.toFixed(3)} s${useVideo ? '' : ' (audio only)'}`);

// ------------------------------------------------------------------ effects, score, ducking, master
const voices = buildVoices(film);
const fx = renderEffects(voices, N);
const compRed = gameCompressor(fx);
dcBlock(fx.L); dcBlock(fx.R);
const missing = [...new Set(voices.filter((v) => v.missing).map((v) => v.file))];
if (missing.length) console.log(`[finish] missing recordings: ${missing.join(', ')}`);
const mus = musicEdit(MUSIC, D);
const Lf = lufs(fx.L, fx.R), Lm0 = lufs(mus.L, mus.R);
const mg = undb((Lf > -60 ? Lf - 5 : -20) - Lm0);           // score sits about 5 LU under the effects before ducking
for (let i = 0; i < N; i++) { mus.L[i] *= mg; mus.R[i] *= mg; }
const red = duck(fx, mus, { maxDb: 6 });
const preL = new Float32Array(N), preR = new Float32Array(N);
for (let i = 0; i < N; i++) { preL[i] = fx.L[i] + mus.L[i]; preR[i] = fx.R[i] + mus.R[i]; }
let gain = undb(TARGET - lufs(preL, preR)), L, R, lim = 0, I = 0, ceil = CEIL;
for (let it = 0; it < 4; it++) {
  L = preL.map((x) => x * gain); R = preR.map((x) => x * gain);
  lim = limit(L, R, ceil);
  I = lufs(L, R);
  if (Math.abs(I - TARGET) < 0.15) break;
  gain *= undb(TARGET - I);
}
writeWav(P.wav, L, R);

// ------------------------------------------------------------------ measurements
const st = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', P.wav, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
const grab = (re) => { const m = st.match(re); return m ? +m[1] : null; };
const meas = { integratedLUFS: grab(/I:\s+(-?[\d.]+) LUFS/), truePeak_dBTP: grab(/Peak:\s+(-?[\d.]+) dBFS/), LRA: grab(/LRA:\s+(-?[\d.]+) LU/), jsLUFS: r2(I), limiterMaxGR_dB: r2(-lim), gameCompressorMaxGR_dB: r2(compRed), limiterOver3dB_s: r2(limit.busy) };

// onsets: every gunshot must start a transient in the mix within one frame of its time
const HOP = 120, nh = Math.floor(N / HOP), E = new Float32Array(nh);
for (let k = 0; k < nh; k++) { let s = 0; for (let i = k * HOP; i < (k + 1) * HOP; i++) s += L[i] * L[i] + R[i] * R[i]; E[k] = 10 * Math.log10(s / HOP + 1e-12); }
const shotsEv = voices.filter((v) => /(rifle|pistol|sniper)_shot|sentry_fire/.test(v.name) && v.t0 < D);
const onset = shotsEv.map((v) => {
  const k0 = Math.ceil((v.t0 - 1 / 30) * SR / HOP), k1 = Math.floor((v.t0 + 1 / 30) * SR / HOP - 1);   // hops wholly inside +-1 frame
  let best = -99, at = -1;
  for (let k = Math.max(8, k0); k <= Math.min(nh - 1, k1); k++) { let m = 99; for (let j = k - 8; j < k; j++) m = Math.min(m, E[j]); const rise = E[k] - m; if (rise > best) { best = rise; at = k; } }
  return { t: v.t0, name: v.name, shot: v.shot, rise: best, dt: at * HOP / SR - v.t0 };
});
const passed = onset.filter((o) => o.rise >= 6 && Math.abs(o.dt) <= 1 / 30);
const atShots = shotsEv.map((v) => red[Math.min(N - 1, Math.round((v.t0 + 0.05) * SR))]);
// gaps, DC, clipping
let minRms = 0; for (let s = 0; s + 2400 <= N; s += 2400) { let e = 0; for (let i = s; i < s + 2400; i++) e += L[i] * L[i] + R[i] * R[i]; minRms = Math.min(minRms, 10 * Math.log10(e / 4800 + 1e-20)); }
let dcL = 0, dcR = 0, clip = 0, pk = 0; for (let i = 0; i < N; i++) { dcL += L[i]; dcR += R[i]; const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); pk = Math.max(pk, a); if (a >= 0.999) clip++; }
const report = {
  mode: final ? 'final' : 'preview', events: P.events, video: useVideo ? P.video : null, duration: r2(D, 3), voices: voices.length, missing,
  music: { file: MUSIC, ...mus.info, levelBeforeDuck_LUFS: r2(Lm0 + db(mg)), effects_LUFS: r2(Lf) },
  master: meas,
  gunshots: { count: shotsEv.length, onsetWithinOneFrame: passed.length, worstRise_dB: onset.length ? r2(Math.min(...onset.map((o) => o.rise))) : null, misses: onset.filter((o) => o.rise < 6).map((o) => ({ t: r2(o.t, 3), name: o.name, shot: o.shot, rise_dB: r2(o.rise) })), maxOffset_ms: passed.length ? r2(1000 * Math.max(...passed.map((o) => Math.abs(o.dt))), 1) : null },
  ducking: { max_dB: r2(red.reduce((a, b) => Math.max(a, b), 0)), meanAtGunshots_dB: atShots.length ? r2(atShots.reduce((a, b) => a + b, 0) / atShots.length) : 0, timeDucked3dB_s: r2(red.filter((x) => x > 3).length / SR) },
  quietest50ms_dBFS: r2(minRms), dcOffset: [r2(dcL / N, 6), r2(dcR / N, 6)], samplePeak_dBFS: r2(db(pk)), clippedSamples: clip, jsTruePeak_dBTP: r2(truePeak(L, R)),
};

// waveform and spectrogram of the whole mix
ff(['-i', P.wav, '-filter_complex', '[0:a]showwavespic=s=2400x360:split_channels=1:colors=0x9ad0ff|0xffc27a,format=rgba[w];[0:a]showspectrumpic=s=2000x480:legend=1:scale=log:fscale=log:color=intensity,scale=2400:-2,format=rgba[s];[w][s]vstack=inputs=2', '-frames:v', '1', P.png]);

// ------------------------------------------------------------------ mux
const AAC = ['-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2'];
if (useVideo) {
  const v = probe(P.video, 'stream=codec_name,color_transfer,color_primaries,color_space,pix_fmt:stream_side_data=side_data_type');
  const vs = v.streams[0], hevc = vs.codec_name === 'hevc';
  const tmp = P.out.replace(/\.mp4$/i, '') + '.tmp.mp4';
  ff(['-i', P.video, '-i', P.wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...(hevc ? ['-tag:v', 'hvc1'] : []), ...AAC, '-t', D.toFixed(3), '-movflags', '+faststart', tmp]);
  const w = probe(tmp, 'stream=codec_name,color_transfer,color_primaries,color_space,pix_fmt:stream_side_data=side_data_type');
  const side = (s) => (s.side_data_list || []).map((x) => x.side_data_type).sort().join(',');
  const ok = ['codec_name', 'color_transfer', 'color_primaries', 'color_space', 'pix_fmt'].every((k) => vs[k] === w.streams[0][k]) && side(vs) === side(w.streams[0]) && frameSide(P.video) === frameSide(tmp);
  if (!ok) { fs.unlinkSync(tmp); throw new Error(`video metadata changed in the mux: ${JSON.stringify(vs)} -> ${JSON.stringify(w.streams[0])}`); }
  fs.renameSync(tmp, P.out);
  const a = probe(P.out, 'stream=codec_name,sample_rate,channels,bit_rate,duration', 'a:0').streams[0];
  report.mux = { file: P.out, video: `${vs.codec_name} ${vs.pix_fmt} ${vs.color_transfer || ''} ${side(vs)}`.trim(), audio: `${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch ${Math.round(a.bit_rate / 1000)} kb/s` };
  if (final && !has('no-sdr')) {
    // SDR copies for X, tone-mapped from the HDR master (as in render-film.ps1, but limited range BT.709)
    const tm = 'zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
    const dir = path.dirname(P.out), tag = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'];
    const x264 = (crf, maxrate, level) => ['-c:v', 'libx264', '-profile:v', 'high', '-level', level, '-preset', 'slow', '-crf', String(crf), '-maxrate', maxrate, '-bufsize', maxrate.replace('M', '') * 2 + 'M', '-pix_fmt', 'yuv420p', ...tag];
    for (const [name, size, crf, maxrate, level] of [['valle-morta-4k-sdr.mp4', '3840:2160', 16, '60M', '5.2'], ['valle-morta-1080p-sdr.mp4', '1920:1080', 17, '20M', '4.2']]) {
      const f = path.join(dir, name);
      ff(['-i', P.out, '-map', '0:v:0', '-map', '0:a:0', '-vf', `${tm},scale=${size}:flags=lanczos,setsar=1`, ...x264(crf, maxrate, level), '-c:a', 'copy', '-movflags', '+faststart', f], { stdio: ['ignore', 'ignore', 'pipe'] });
      const s = probe(f, 'stream=codec_name,profile,width,height,pix_fmt,color_transfer,color_primaries,color_space,bit_rate:format=duration');
      report.mux[name] = `${s.streams[0].codec_name} ${s.streams[0].profile} ${s.streams[0].width}x${s.streams[0].height} ${s.streams[0].pix_fmt} ${s.streams[0].color_primaries}/${s.streams[0].color_transfer} ${Math.round(s.streams[0].bit_rate / 1e6)} Mb/s ${(+s.format.duration).toFixed(2)} s`;
    }
  }
}
const rep = P.wav.replace(/\.wav$/i, '') + '_report.json';
fs.writeFileSync(rep, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report));
console.log(`[finish] wrote ${P.wav}, ${P.png}, ${rep}${useVideo ? ', ' + P.out : ''}. Measured only: nobody has listened to this mix.`);
