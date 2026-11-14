// Offline soundtrack mixer for the film. Rebuilds the game's sound from the tape
// (events logged by src/game/audio.js during the film) using the same recordings,
// lays a music edit under it, ducks the music under the effects, and masters the sum.
// Nothing is synthesised: every sample comes from a recording in public/assets/audio.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SR = 48000;
const AUDIO = path.resolve('public/assets/audio');
const db = (x) => 20 * Math.log10(Math.max(1e-12, x));
const undb = (d) => Math.pow(10, d / 20);

// ------------------------------------------------------------------ decode
const cache = new Map();
export function decode(file) {
  const f = path.isAbsolute(file) ? file : path.join(AUDIO, file);
  if (cache.has(f)) return cache.get(f);
  let buf;
  try { buf = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'], { maxBuffer: 1 << 30 }); } catch (e) { cache.set(f, null); return null; }
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2), n = all.length >> 1;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = all[2 * i]; R[i] = all[2 * i + 1]; }
  const r = { L, R, n };
  cache.set(f, r);
  return r;
}
// loops: a 20 ms self-crossfade at the seam so the wrap never clicks
const loopCache = new Map();
function decodeLoop(file) {
  if (loopCache.has(file)) return loopCache.get(file);
  const b = decode(file);
  if (!b) return null;
  const X = Math.min(Math.floor(0.02 * SR), b.n >> 3), n = b.n - X;
  const L = b.L.slice(0, n), R = b.R.slice(0, n);
  for (let i = 0; i < X; i++) { const a = i / X; L[i] = b.L[i] * a + b.L[n + i] * (1 - a); R[i] = b.R[i] * a + b.R[n + i] * (1 - a); }
  // a bed recorded off-centre (tank_engine.mp3 is 7 dB louder on the right) is levelled so the loop sits in the middle
  let el = 0, er = 0; for (let i = 0; i < n; i++) { el += L[i] * L[i]; er += R[i] * R[i]; }
  if (el > 0 && er > 0 && Math.abs(10 * Math.log10(el / er)) > 3) { const m = Math.sqrt(Math.sqrt(el * er)), gl = m / Math.sqrt(el), gr = m / Math.sqrt(er); for (let i = 0; i < n; i++) { L[i] *= gl; R[i] *= gr; } }
  const r = { L, R, n };
  loopCache.set(file, r);
  return r;
}

const herm = (x0, x1, x2, x3, t) => { const c = (x2 - x0) * 0.5, v = x1 - x2, w = c + v, a = w + v + (x3 - x1) * 0.5, b = w + a; return ((a * t - b) * t + c) * t + x1; };

// ------------------------------------------------------------------ spatial (the game's PannerNode: inverse distance, ref 4, rolloff 1.1 unless the call says otherwise)
function spatial(v, pos, ear, fwd) {
  if (!pos || !ear || !fwd) return { g: 1, pl: 1, pr: 1, fc: 0 };
  const dx = pos[0] - ear[0], dy = pos[1] - ear[1], dz = pos[2] - ear[2], d = Math.hypot(dx, dy, dz) || 1e-6;
  const ref = v.ref ?? 4, roll = v.rolloff ?? 1.1;
  const g = ref / (ref + roll * (Math.max(d, ref) - ref));
  // listener right = fwd x up
  let rx = -fwd[2], rz = fwd[0]; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
  const x = Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d)) * 0.75;     // HRTF is softer than a hard pan
  const th = (x + 1) * Math.PI / 4;
  const fc = d <= 15 ? 0 : Math.max(1800, 18000 * Math.pow(15 / d, 0.8)); // gentle air absorption for far sources
  return { g, pl: Math.cos(th) * Math.SQRT2, pr: Math.sin(th) * Math.SQRT2, fc };
}

// ------------------------------------------------------------------ effects from the tape
export function buildVoices(film) {
  const voices = [];
  for (const shot of film.shots) {
    const S = shot.start, D = shot.duration, end = S + D, byId = new Map();
    for (const e of shot.events || []) {
      if (e.name) {
        if (e.cat === 'music' || /^music_/.test(e.name)) continue;      // the film has its own score
        const v = { ...e, t0: S + e.t, shot: shot.name, S, end, ups: [] };
        byId.set(e.id, v); voices.push(v);
      } else { const v = byId.get(e.id); if (v) v.ups.push({ ...e, t: S + e.t }); }
    }
  }
  return voices;
}

export function renderEffects(voices, N) {
  const L = new Float32Array(N), R = new Float32Array(N), BL = 128;
  const ending = new Map();               // loops cut at a picture cut: file@time -> phase, for a seamless cross-fade
  voices.sort((a, b) => a.t0 - b.t0);
  for (const v of voices) {
    const buf = v.loop ? decodeLoop(v.file) : decode(v.file);
    if (!buf) { v.missing = true; continue; }
    const bus = v.cat === 'ambient' ? 0.9 : 1;
    const XF = Math.round(0.01 * SR);   // half of the 20 ms cut cross-fade
    let s0 = Math.round(v.t0 * SR), pos = 0, edgeIn = 0;
    const cutStart = v.loop && v.t0 - v.S < 0.02 && v.S > 0;
    if (cutStart) { s0 = Math.round(v.S * SR) - XF; edgeIn = 2 * XF; const ph = ending.get(`${v.file}@${v.S.toFixed(4)}`); if (ph !== undefined) pos = ph; }
    else if (v.loop) edgeIn = Math.round(0.012 * SR); else edgeIn = Math.round(0.002 * SR);
    // automation
    const stop = v.ups.find((u) => u.stop);
    const cutEnd = v.loop ? Math.round(v.end * SR) + XF : Infinity;
    const stopS = stop ? Math.round(stop.t * SR) : Infinity, stopTc = stop ? Math.max(0.01, (stop.fade ?? 0.03) / 3) : 0.01;
    const hardEnd = Math.min(cutEnd, stop ? stopS + Math.round(Math.max(0.03, (stop.fade ?? 0.03) * 1.6) * SR) : Infinity, N);
    const ups = v.ups.filter((u) => !u.stop).sort((a, b) => a.t - b.t);
    let ui = 0, gT = v.gain, rT = v.rate || 1, posT = v.pos, ear = v.ear, fwd = v.fwd;
    let g = v.loop && (v.fade ?? 0) > 0 && !cutStart ? 0 : v.gain, r = rT, gTc = v.loop && (v.fade ?? 0) > 0 ? Math.max(0.03, v.fade / 3) : 0.12;
    let sp = spatial(v, posT, ear, fwd), lpL = 0, lpR = 0, outEnd = -1;
    for (let b = Math.max(0, s0); b < hardEnd; b += BL) {
      const tb = b / SR;
      while (ui < ups.length && ups[ui].t <= tb) { const u = ups[ui++]; if (u.gain !== undefined) { gT = u.gain; gTc = 0.12; } if (u.rate !== undefined) rT = u.rate; if (u.pos) { posT = u.pos; ear = u.ear || ear; fwd = u.fwd || fwd; } }
      const target = b >= stopS ? 0 : gT, tc = b >= stopS ? stopTc : gTc, k = 1 - Math.exp(-BL / SR / tc);
      g += (target - g) * k; r += (rT - r) * (1 - Math.exp(-BL / SR / 0.25));
      const sp2 = spatial(v, posT, ear, fwd);
      sp = { g: sp.g + (sp2.g - sp.g) * 0.3, pl: sp.pl + (sp2.pl - sp.pl) * 0.3, pr: sp.pr + (sp2.pr - sp.pr) * 0.3, fc: sp2.fc };
      const a = sp.fc ? 1 - Math.exp(-2 * Math.PI * sp.fc / SR) : 1, positional = !!v.pos;
      const gg = g * bus * sp.g, e = Math.min(hardEnd, b + BL, N);
      for (let i = b; i < e; i++) {
        const j = Math.floor(pos), t = pos - j;
        let xl, xr;
        if (v.loop) { const n = buf.n, j0 = (j - 1 + n) % n, j1 = j % n, j2 = (j + 1) % n, j3 = (j + 2) % n; xl = herm(buf.L[j0], buf.L[j1], buf.L[j2], buf.L[j3], t); xr = herm(buf.R[j0], buf.R[j1], buf.R[j2], buf.R[j3], t); }
        else { if (j >= buf.n - 2) { outEnd = i; break; } const j0 = Math.max(0, j - 1); xl = herm(buf.L[j0], buf.L[j], buf.L[j + 1], buf.L[j + 2] ?? 0, t); xr = herm(buf.R[j0], buf.R[j], buf.R[j + 1], buf.R[j + 2] ?? 0, t); }
        let env = gg; const k0 = i - s0;
        if (k0 < edgeIn) env *= k0 / edgeIn;
        if (v.loop && i > cutEnd - 2 * XF) env *= Math.max(0, (cutEnd - i) / (2 * XF));
        if (!v.loop) { const left = (buf.n - 2 - j) / (r || 1); if (left < 240) env *= left / 240; }
        if (positional) { const m = (xl + xr) * 0.5; lpL += (m - lpL) * a; L[i] += lpL * env * sp.pl; R[i] += lpL * env * sp.pr; }
        else { lpL += (xl - lpL) * a; lpR += (xr - lpR) * a; L[i] += lpL * env; R[i] += lpR * env; }
        pos += r; if (v.loop && pos >= buf.n) pos -= buf.n;
      }
      if (outEnd >= 0) break;
    }
    if (v.loop && cutEnd < Infinity && (!stop || stopS > cutEnd)) ending.set(`${v.file}@${v.end.toFixed(4)}`, (pos - XF * 2 * r + buf.n * 4) % buf.n);
  }
  return { L, R };
}

// ------------------------------------------------------------------ loudness (BS.1770-4, K-weighted, gated)
function kweight(x) {
  const y = new Float64Array(x.length);
  const st = [[1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585], [1, -2, 1, -1.99004745483398, 0.99007225036621]];
  let src = x;
  for (const [b0, b1, b2, a1, a2] of st) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < src.length; i++) { const xi = src[i], yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi; }
    src = Float64Array.from(y);
  }
  return src;
}
export function lufs(L, R) {
  const kl = kweight(L), kr = kweight(R), B = Math.round(0.4 * SR), H = Math.round(0.1 * SR), blocks = [];
  for (let s = 0; s + B <= L.length; s += H) { let e = 0; for (let i = s; i < s + B; i++) e += kl[i] * kl[i] + kr[i] * kr[i]; blocks.push(e / B); }
  const ld = (m) => -0.691 + 10 * Math.log10(Math.max(1e-20, m));
  const g1 = blocks.filter((m) => ld(m) > -70); if (!g1.length) return -70;
  const rel = ld(g1.reduce((a, b) => a + b, 0) / g1.length) - 10;
  const g2 = g1.filter((m) => ld(m) > rel);
  return ld(g2.reduce((a, b) => a + b, 0) / g2.length);
}

// ------------------------------------------------------------------ true peak (4x oversampled) and a transparent look-ahead limiter
const TAPS = 16, OS = 4, FIR = [];
for (let p = 1; p < OS; p++) { const h = []; for (let k = -TAPS / 2 + 1; k <= TAPS / 2; k++) { const x = k - p / OS, w = 0.5 + 0.5 * Math.cos(Math.PI * x / (TAPS / 2)); h.push(x === 0 ? 1 : (Math.sin(Math.PI * x) / (Math.PI * x)) * w); } FIR.push(h); }
function tpeaks(x) {
  const n = x.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = Math.abs(x[i]);
    for (let p = 0; p < OS - 1; p++) { const h = FIR[p]; let s = 0; for (let k = 0; k < TAPS; k++) { const j = i + k - TAPS / 2 + 1; if (j >= 0 && j < n) s += x[j] * h[k]; } m = Math.max(m, Math.abs(s)); }
    out[i] = m;
  }
  return out;
}
export function truePeak(L, R) { const a = tpeaks(L), b = tpeaks(R); let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, a[i], b[i]); return db(m); }
export function limit(L, R, ceilingDb = -1.6, la = 0.005, rel = 0.06) {
  const n = L.length, c = undb(ceilingDb), pl = tpeaks(L), pr = tpeaks(R), req = new Float32Array(n), LA = Math.round(la * SR);
  for (let i = 0; i < n; i++) { const p = Math.max(pl[i], pr[i]); req[i] = p > c ? c / p : 1; }
  // forward running minimum over [i, i+LA] (monotonic deque)
  const g1 = new Float32Array(n), dq = new Int32Array(n + LA + 1); let h = 0, t = 0;
  for (let i = n - 1; i >= 0; i--) { while (t > h && req[dq[t - 1]] >= req[i]) t--; dq[t++] = i; while (dq[h] > i + LA) h++; g1[i] = req[dq[h]]; }
  const g2 = new Float32Array(n), kr = 1 - Math.exp(-1 / (rel * SR)); let g = 1;
  for (let i = 0; i < n; i++) { g = Math.min(g1[i], g + (1 - g) * kr); g2[i] = g; }
  let acc = 0, minG = 1; const q = new Float32Array(n);
  for (let i = 0; i < n; i++) { acc += g2[i]; if (i > LA) acc -= g2[i - LA - 1]; q[i] = (acc + Math.max(0, LA - i)) / (LA + 1); minG = Math.min(minG, q[i]); }
  let busy = 0; for (let i = 0; i < n; i++) { L[i] *= q[i]; R[i] *= q[i]; if (q[i] < 0.7079) busy++; }
  limit.busy = busy / SR;
  return db(minG);
}

// ------------------------------------------------------------------ music edit: the track's opening (it builds), cut to its ending so the last hit lands on the film's last second
function envelope(b, hop) {
  const n = Math.floor(b.n / hop), e = new Float32Array(n);
  for (let k = 0; k < n; k++) { let s = 0; for (let i = k * hop; i < (k + 1) * hop; i++) s += b.L[i] * b.L[i] + b.R[i] * b.R[i]; e[k] = Math.sqrt(s / (2 * hop)); }
  return e;
}
export function musicEdit(file, D, opts = {}) {
  const b = decode(file); if (!b) throw new Error(`music not decodable: ${file}`);
  const hop = 480, env = envelope(b, hop), T = (k) => k * hop / SR, peak = Math.max(...env);
  let first = 0; while (first < env.length && env[first] < peak * undb(-50)) first++;
  let last = env.length - 1; while (last > 0 && env[last] < peak * undb(-50)) last--;
  // onset strength (positive log-energy flux) for rhythm alignment and for finding the final hit
  const le = Array.from(env, (x) => db(x + 1e-9)), on = le.map((x, k) => (k ? Math.max(0, x - le[k - 1]) : 0));
  const sm = Array.from(env, (x, k) => { let s = 0, c = 0; for (let j = Math.max(0, k - 10); j <= Math.min(env.length - 1, k + 10); j++) { s += env[j]; c++; } return s / c; });
  const smPeak = Math.max(...sm);
  let finalHit = last; for (let k = last; k > last - Math.round(20 * SR / hop); k--) if (on[k] > 4 && sm[k + 5] > smPeak * undb(-14)) { finalHit = k; break; }
  // place the final hit about 1.4 s before the end (or the track's true end at D - 0.15 s, whichever is earlier)
  const land = opts.land ?? 1.4;
  let off0 = T(finalHit) - (D - land); off0 = Math.max(off0, T(last) - (D - 0.15));
  // fine-tune the offset (within +-0.3 s) so the beat grid of the ending lines up with the opening at the cut region
  const H0 = Math.round(T(first) * SR / hop), lagOf = (o) => Math.round(o * SR / hop);
  let best = off0, bestC = -1;
  for (let d = -0.3; d <= 0.3; d += hop / SR) {
    const lag = lagOf(off0 + d - T(first)); let c = 0;
    for (let k = Math.round((D - 26) * SR / hop); k < Math.round((D - 8) * SR / hop); k++) { const a = on[H0 + k], bb = on[H0 + k + lag]; if (a !== undefined && bb !== undefined) c += a * bb; }
    if (c > bestC) { bestC = c; best = off0 + d; }
  }
  const tailOff = best;                               // film time t plays track time t + tailOff in the ending
  // cut where opening and ending match in level best, between D-24 s and D-10 s
  let cut = D - 15, bestM = 1e9;
  if (D < 14) cut = Infinity;                          // too short for an edit: the opening only, faded at the end
  for (let x = Math.max(2, D - 24); x <= D - 10; x += 0.05) {
    let m = 0; for (let y = -1; y <= 1; y += 0.1) { const ka = Math.round((T(first) + x + y) * SR / hop), kb = Math.round((x + y + tailOff) * SR / hop); m += Math.abs(db(sm[ka] + 1e-9) - db(sm[kb] + 1e-9)); }
    m += 0.15 * Math.abs(x - (D - 15)); if (m < bestM) { bestM = m; cut = x; }
  }
  const N = Math.round(D * SR), L = new Float32Array(N), R = new Float32Array(N), XF = 1.5, s0 = Math.round(T(first) * SR);
  for (let i = 0; i < N; i++) {
    const t = i / SR, a = Math.min(1, Math.max(0, (t - (cut - XF / 2)) / XF));
    const ga = Math.cos(a * Math.PI / 2), gb = Math.sin(a * Math.PI / 2);
    let l = 0, r = 0;
    if (ga > 0) { const j = s0 + i; if (j < b.n) { l += b.L[j] * ga; r += b.R[j] * ga; } }
    if (gb > 0) { const j = Math.round((t + tailOff) * SR); if (j >= 0 && j < b.n) { l += b.L[j] * gb; r += b.R[j] * gb; } }
    const fi = Math.min(1, i / (0.01 * SR)), fo = Math.min(1, (N - 1 - i) / (0.35 * SR));
    L[i] = l * fi * fo; R[i] = r * fi * fo;
  }
  return { L, R, info: { trackStart: +T(first).toFixed(2), cutAt: Number.isFinite(cut) ? +cut.toFixed(2) : null, endingFrom: +(cut + tailOff).toFixed(2), finalHitAt: +(T(finalHit) - tailOff).toFixed(2), trackEndAt: +(T(last) - tailOff).toFixed(2) } };
}

// ------------------------------------------------------------------ side-chain ducking of the music from the effects bus
export function duck(fx, mus, { maxDb = 6, ratio = 0.5, att = 0.008, rel = 0.45, thrBelowPeak = 20 } = {}) {
  const n = fx.L.length, ka = 1 - Math.exp(-1 / (0.002 * SR)), kr = 1 - Math.exp(-1 / (0.12 * SR));
  let e = 0, pk = 0; const lev = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = Math.max(Math.abs(fx.L[i]), Math.abs(fx.R[i])); e += (x - e) * (x > e ? ka : kr); lev[i] = e; pk = Math.max(pk, e); }
  const thr = db(pk) - thrBelowPeak, ga = 1 - Math.exp(-1 / (att * SR)), gr = 1 - Math.exp(-1 / (rel * SR)), red = new Float32Array(n);
  let g = 0;
  for (let i = 0; i < n; i++) { const want = Math.min(maxDb, Math.max(0, (db(lev[i]) - thr) * ratio)); g += (want - g) * (want > g ? ga : gr); red[i] = g; const m = undb(-g); mus.L[i] *= m; mus.R[i] *= m; }
  return red;
}

export function writeWav(file, L, R) {
  const n = L.length, data = Buffer.alloc(n * 8), h = Buffer.alloc(44);
  for (let i = 0; i < n; i++) { data.writeFloatLE(L[i], i * 8); data.writeFloatLE(R[i], i * 8 + 4); }
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 8, 28); h.writeUInt16LE(8, 32); h.writeUInt16LE(32, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

export { db, undb };

// the game's own master compressor (audio.js: threshold -14 dB, knee 30, ratio 5, attack 3 ms, release 200 ms),
// after the game's bus gains (master 0.8, sfx 0.9), so the effects keep the dynamics the game gives them
export function gameCompressor(fx, { pre = 0.72, T = -14, K = 30, ratio = 5, att = 0.003, rel = 0.2 } = {}) {
  const n = fx.L.length, ka = 1 - Math.exp(-1 / (att * SR)), kr = 1 - Math.exp(-1 / (rel * SR));
  let g = 0, maxRed = 0;
  for (let i = 0; i < n; i++) {
    const l = fx.L[i] * pre, r = fx.R[i] * pre, x = db(Math.max(Math.abs(l), Math.abs(r))), over = x - T;
    const want = over <= 0 ? 0 : over < K ? (1 - 1 / ratio) * over * over / (2 * K) : (1 - 1 / ratio) * (over - K / 2);
    g += (want - g) * (want > g ? ka : kr); maxRed = Math.max(maxRed, g);
    const m = undb(-g); fx.L[i] = l * m; fx.R[i] = r * m;
  }
  return maxRed;
}
// DC blocker (one-pole high-pass at about 8 Hz)
export function dcBlock(x) { const a = 1 - 2 * Math.PI * 8 / SR; let px = 0, py = 0; for (let i = 0; i < x.length; i++) { const y = x[i] - px + a * py; px = x[i]; py = y; x[i] = y; } }
