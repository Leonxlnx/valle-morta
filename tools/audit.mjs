// World-geometry audit: floating / buried parts, collider mismatches, chunk-culling errors and
// coplanar overlaps (z-fighting), with world coordinates. Runs in the real game (headless Chrome).
//   node tools/audit.mjs [--probe] [--only float,col,cull,zf] [--w 640 --h 360]
// Prints a short table and writes tools/_preview/audit/audit.json.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acquireGpuLock } from './lib/gpulock.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i < 0) return d; const v = process.argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; };
const out = 'tools/_preview/audit';
fs.mkdirSync(out, { recursive: true });
const only = String(arg('only', 'float,col,cull,zf')).split(',');
const W = Number(arg('w', 480)), H = Number(arg('h', 270));
await acquireGpuLock();
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 1800000,
  userDataDir: path.join(os.tmpdir(), 'vm-chrome-profile'), defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--window-size=${W},${H}`],
});
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  await page.goto(`http://127.0.0.1:5173/?q=${arg('q', 'medium')}&auto=1`, { waitUntil: 'load', timeout: 300000 });
  await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 600000, polling: 500 });
  if (arg('probe', false)) {
    const r = await page.evaluate(() => {
      const L = [];
      __vm.engine.scene.traverse((o) => { if (o.isMesh || o.isInstancedMesh) L.push(`${o.type}|${o.name || o.parent?.name}|${o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3}|${o.isInstancedMesh ? o.count : 1}|vis${o.visible}`); });
      return { meshes: L.slice(0, 400), n: L.length, vm: Object.keys(__vm), game: Object.keys(__vm.game || {}).slice(0, 60), world: Object.keys(__vm.world || {}) };
    });
    fs.writeFileSync(`${out}/probe.json`, JSON.stringify(r, null, 1));
    console.log(`meshes ${r.n}; vm: ${r.vm.join(',')}; world: ${r.world.join(',')}`);
  } else {
    const src = fs.readFileSync(new URL('./lib/audit-page.js', import.meta.url), 'utf8');
    const r = await page.evaluate(`(async () => { ${src}\n return await runAudit(${JSON.stringify({ only })}); })()`);
    fs.writeFileSync(`${out}/audit.json`, JSON.stringify(r, null, 1));
    for (const [k, list] of Object.entries(r.classes)) {
      console.log(`${k.padEnd(14)} ${String(list.length).padStart(4)}  ${list.slice(0, 6).map((q) => `${q.what}@${q.at.join(',')}${q.d !== undefined ? ' ' + q.d : ''}`).join(' | ')}`);
    }
    if (r.notes) console.log(r.notes.join('\n'));
  }
} finally {
  if (errors.length) console.log('--- page errors:\n' + [...new Set(errors)].slice(0, 6).join('\n'));
  await browser.close();
}
