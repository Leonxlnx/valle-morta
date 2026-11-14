// Walk-through check of the enterable houses: every ground-floor doorway (found by probing the
// collision mesh, not from the build config), every stair and debris ramp, the inn's balcony, an
// infected reaching a player inside the inn, and the survival start / Operation landing zones
// being clear of props.  Deterministic stepping through __vm (no rendering).
//   node tools/housewalk.mjs
import puppeteer from 'puppeteer-core'; import os from 'node:os'; import path from 'node:path';
import { acquireGpuLock } from './lib/gpulock.mjs';
await acquireGpuLock();
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 900000, userDataDir: path.join(os.tmpdir(), 'vm-chrome-profile'), args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const errors = [];
try {
  const page = await b.newPage();
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text().slice(0, 200)); });
  await page.goto('http://127.0.0.1:5173/?q=low&auto=1', { waitUntil: 'load', timeout: 300000 });
  await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 600000, polling: 500 });
  const r = await page.evaluate(async () => {
    const vm = __vm, g = vm.game, p = g.player, T = vm.THREE, col = g.collision, Z = g.zombies, H = (x, z) => vm.terrain.heightAt(x, z);
    const { specialCfg } = await import('/src/world/bld/town.js');
    vm.stop(); if (g.state !== 'playing') g.start();
    const hold = () => { g.interT = 1e9; g.queue = 0; g.queueList = []; g.cleared = true; };
    const r2 = (v) => +v.toFixed(2);
    const sim = (sec, each) => { const n = Math.round(sec * 60); for (let i = 0; i < n; i++) { g.update(1 / 60); p.health = p.maxHealth; if (each && each() === false) return (i + 1) / 60; } return sec; };
    const ray = new T.Ray();
    const hitD = (x, y, z, dx, dz, far) => { ray.origin.set(x, y, z); ray.direction.set(dx, 0, dz).normalize(); const h = col.bvh.raycastFirst(ray, T.DoubleSide, 0, far); return h ? h.distance : far; };
    const place = (x, z, y) => { Z.clear(); hold(); p.spawn(x, z, 0); p.enabled = true; p.script = () => {}; if (y !== undefined) { p.pos.y = col.floorAt(x, y + 1.0, z, 2.5); } p.vel?.set?.(0, 0, 0); };
    const walk = (tx, ty, tz, sec, stop) => { const tg = new T.Vector3(tx, ty, tz); p.script = (dt, pl) => { tg.y = pl.eye.y; pl.lookAt(tg, 999, dt); pl.input.fwd = 1; }; const t = sim(sec, () => (stop ? !stop() : Math.hypot(p.pos.x - tx, p.pos.z - tz) > 0.5)); p.script = () => {}; return t; };
    const rc = new T.Raycaster();
    const seen = (o, d) => { rc.set(new T.Vector3(o[0], d.y0 + 0.35, o[1]), new T.Vector3(d[0] - d.bx, 0, d[1] - d.bz).normalize()); rc.far = 2.6; const h = rc.intersectObjects(vm.engine.scene.children, true).find((q) => q.object.visible && q.object.isMesh); return h ? `${h.object.name || h.object.parent?.name || '?'} ${r2(h.distance)} m, ${r2(h.point.y - d.y0)} up` : 'none'; };
    const pt2 = () => `${r2(p.pos.x)},${r2(p.pos.y)},${r2(p.pos.z)}`;
    const out = { doors: [], doorsExpected: [], stairs: [], errors: [] };
    const blds = vm.layout.buildings.filter((q) => q.enterable);
    out.buildings = blds.map((q) => `${q.id}@${Math.round(q.x)},${Math.round(q.z)}`);
    for (const bd of blds) {
      const c = Math.cos(bd.rot), s = Math.sin(bd.rot), W = (lx, lz) => [bd.x + lx * c - lz * s, bd.z + lx * s + lz * c];
      const L = (x, z) => { const dx = x - bd.x, dz = z - bd.z; return [dx * c + dz * s, -dx * s + dz * c]; };
      const t = 0.55, hw = bd.w / 2, hd = bd.d / 2, y0 = bd.baseY;
      const inside = () => { const l = L(p.pos.x, p.pos.z); return Math.abs(l[0]) < hw - t && Math.abs(l[1]) < hd - t && p.pos.y < y0 + 1.5; };
      // walls: outward normal n (local), tangent u; probe from 1.2 m outside inwards at 0.5 m and 1.7 m above the floor
      const walls = [[0, 1, hw], [0, -1, hw], [1, 0, hd], [-1, 0, hd]];
      let cfg0 = {}; try { cfg0 = specialCfg(bd) || {}; } catch (e) { /* not hand-planned */ }
      for (const [nx, nz, half] of walls) {
        const off = nx ? hw : hd, run = [];
        for (let u = -half + 0.4; u <= half - 0.4; u += 0.15) {
          const lx = nx ? nx * (off + 1.2) : u, lz = nz ? nz * (off + 1.2) : u, w = W(lx, lz), d = W(-nx, -nz); const dx = d[0] - bd.x, dz = d[1] - bd.z;
          const fy = Math.max(y0 + 0.03, H(w[0], w[1]));
          const open = [fy + 0.5, y0 + 0.35, Math.max(fy, y0) + 1.75].every((yy) => hitD(w[0], yy, w[1], dx, dz, 2.6) >= 2.6);
          if (open) run.push(u);
        }
        const groups = []; for (const u of run) { const gq = groups[groups.length - 1]; if (gq && u - gq[gq.length - 1] < 0.2) gq.push(u); else groups.push([u]); }
        for (const gq of groups) {
          if (gq.length < 3) continue;        // narrower than ~0.45 m: not a doorway
          const u = (gq[0] + gq[gq.length - 1]) / 2, a = W(nx ? nx * (off + 2.0) : u, nz ? nz * (off + 2.0) : u), e = W(nx ? -nx * (off - 2.2) : u, nz ? -nz * (off - 2.2) : u);
          place(a[0], a[1]); const tin = walk(e[0], y0, e[1], 6); const inn = inside();
          const e2 = W(nx ? nx * (off + 2.5) : u, nz ? nz * (off + 2.5) : u); const tout = walk(e2[0], y0, e2[1], 6);
          const l = L(p.pos.x, p.pos.z), outOk = Math.abs(l[0]) > hw || Math.abs(l[1]) > hd;
          out.doors.push(`${bd.id} wall ${nx},${nz} u ${r2(u)} w ${r2(gq[gq.length - 1] - gq[0] + 0.15)}: in ${inn ? 'ok' : 'STUCK'} ${r2(tin)}s, out ${outOk ? 'ok' : 'STUCK'} ${r2(tout)}s`);
        }
      }
      if (cfg0.doors) for (const dr of cfg0.doors) {
        const fr = [[-hw, hd, 1, 0, 0, 1], [hw, -hd, -1, 0, 0, -1], [hw, hd - t, 0, -1, 1, 0], [-hw, -hd + t, 0, 1, -1, 0]][dr.wall];
        const lx = fr[0] + fr[2] * dr.u, lz = fr[1] + fr[3] * dr.u, o = W(lx + fr[4] * 1.2, lz + fr[5] * 1.2), d = W(-fr[4], -fr[5]); d.y0 = y0; d.bx = bd.x; d.bz = bd.z;
        const hits = [0.35, 1.0, 1.75].map((hh) => { ray.origin.set(o[0], y0 + hh, o[1]); ray.direction.set(d[0] - bd.x, 0, d[1] - bd.z).normalize(); const h = col.bvh.raycastFirst(ray, T.DoubleSide, 0, 2.6); return h ? `${r2(h.distance)}@${r2(h.point.x)},${r2(h.point.z)}` : '-'; });
        const a = W(lx + fr[4] * 2.0, lz + fr[5] * 2.0), e = W(lx - fr[4] * 2.2, lz - fr[5] * 2.2);
        place(a[0], a[1]); const tin = walk(e[0], y0, e[1], 6); const ok = inside();
        out.doorsExpected.push(`${bd.id} wall ${dr.wall} u ${r2(dr.u)} at ${r2(W(lx, lz)[0])},${r2(W(lx, lz)[1])} rays 0.35/1/1.75 m: ${hits.join(' ')}; y0 ${r2(y0)} ground@door ${r2(H(W(lx, lz)[0], W(lx, lz)[1]))} ground@out ${r2(H(o[0], o[1]))} first mesh ${seen(o, d)}; walk in ${ok ? 'ok' : 'STUCK'} ${r2(tin)}s at ${pt2()}`);
      }
      // stairs and ramps from the build config (local frame, floor at baseY)
      let cfg = {}; try { cfg = specialCfg(bd) || {}; } catch (e) { out.errors.push(bd.id + ': ' + e.message); }
      if (cfg.stair) {
        // the foot abuts a wall: step on from the open side over the first treads, then climb
        const st = cfg.stair, sg = Math.sign(st.z1 - st.z0), side = st.open > 0 ? 1 : -1, a = W(st.x + side * 1.4, st.z0 + sg * 0.3), m = W(st.x + side * 0.15, st.z0 + sg * 0.3), e = W(st.x, st.z1 + sg * 1.4);
        place(a[0], a[1], y0); walk(m[0], y0, m[1], 4); const tt = walk(e[0], y0 + st.h, e[1], 12);
        out.stairs.push(`${bd.id} stair h ${st.h}: top ${r2(p.pos.y - y0)} m at ${pt2()} ${p.pos.y - y0 > st.h - 0.3 ? 'ok' : 'FAIL'} ${r2(tt)}s`);
      }
      if (cfg.ramp) {
        const rp = cfg.ramp, zm = (rp.z0 + rp.z1) / 2, sg = Math.sign(rp.xt - rp.xb), a = W(rp.xb + sg * 0.45, zm), e = W(rp.xt + sg * 0.6, zm);
        place(a[0], a[1], y0); const tt = walk(e[0], y0 + rp.h, e[1], 12);
        out.stairs.push(`${bd.id} ramp h ${rp.h}: top ${r2(p.pos.y - y0)} m ${p.pos.y - y0 > rp.h - 0.4 ? 'ok' : 'FAIL'} ${r2(tt)}s`);
      }
      if (bd.special === 'inn') {
        // balcony: from the upper floor through each upper door, out to the rail
        const fH = bd.floorH || 2.75;
        for (const xl of [hw - 4.6, hw - 8.4]) {
          const a = W(xl, -hd + 1.6), e = W(xl, -hd - 1.0);
          place(a[0], a[1], y0 + fH); const y1 = p.pos.y - y0; walk(e[0], y0 + fH, e[1], 5);
          const l = L(p.pos.x, p.pos.z);
          out.stairs.push(`inn balcony via x ${r2(xl)}: start ${r2(y1)} m, ${r2(-hd - l[1])} m out past the wall face at ${r2(p.pos.y - y0)} m ${l[1] < -hd - 0.3 && Math.abs(p.pos.y - y0 - fH) < 0.3 ? 'ok' : 'FAIL'}`);
        }
        // an infected reaches the player standing inside the inn
        const m = W(0, 0); place(m[0], m[1]); const zp = W(0, -hd - 22);
        Z.passive = false; const z = Z.spawn(zp[0], zp[1], { type: 'walker', aware: true });
        const tz = sim(60, () => Math.hypot(z.pos.x - p.pos.x, z.pos.z - p.pos.z) > 1.7);
        out.infectedInside = { walkableAtPlayer: Z.flow.walkable(p.pos.x, p.pos.z), zState: z.state, zDirect: z.direct, zAt: [r2(z.pos.x), r2(z.pos.z)], playerAt: [r2(p.pos.x), r2(p.pos.z)], inside: inside(), reached: Math.hypot(z.pos.x - p.pos.x, z.pos.z - p.pos.z) <= 1.7, time: r2(tz), dist: r2(Math.hypot(z.pos.x - p.pos.x, z.pos.z - p.pos.z)) };
        Z.clear();
      }
    }
    // clear ground: survival start and the Operation landing zones
    const clear = (x, z) => { const y = H(x, z); let m = 99; for (let k = 0; k < 32; k++) { const an = k / 32 * 6.283; for (const hh of [0.4, 1.2, 2.5]) m = Math.min(m, hitD(x, y + hh, z, Math.sin(an), Math.cos(an), 20)); } return { freeRadius: r2(m), propUnder: r2(col.floorAt(x, y + 3, z, 4) - y) }; };
    const s = g._startPoint(); out.start = { at: [r2(s[0]), r2(s[1])], ...clear(s[0], s[1]) };
    out.lz = (g.operation || vm.operation)._lzs().map((l) => ({ id: l.id, at: [r2(l.x), r2(l.z)], room: l.room, ...clear(l.x, l.z) }));
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
} finally { await b.close(); }
console.log(errors.length ? 'console:\n' + [...new Set(errors)].slice(0, 8).join('\n') : 'console: clean');
