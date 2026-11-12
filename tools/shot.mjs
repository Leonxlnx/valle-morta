// Headless Chrome helper: loads the running dev server, takes screenshots of
// named views and (optionally) benchmarks GPU frame time.
//   node tools/shot.mjs --views meadow,bridge --w 1280 --h 720 --q high --bench --out tools/_preview/shots
//   --eval "js"  runs extra JS in the page before shooting (e.g. tweak uniforms)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const views = String(arg('views', 'meadow')).split(',');
const W = Number(arg('w', 1280)), H = Number(arg('h', 720));
const q = arg('q', 'high');
const out = arg('out', 'tools/_preview/shots');
const tag = arg('tag', '');
const extra = arg('eval', '');
const url = arg('url', 'http://127.0.0.1:5173/');
const query = arg('query', '');
const settle = Number(arg('settle', 12));
fs.mkdirSync(out, { recursive: true });
const { acquireGpuLock } = await import('./lib/gpulock.mjs');
await acquireGpuLock();

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: arg('headed', false) ? false : 'new',
  userDataDir: path.join(os.tmpdir(), 'vm-chrome-profile'),
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader=false', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`.slice(0, 600)); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e).slice(0, 600)}`));
  await page.goto(`${url}?q=${q}&auto=1${query ? '&' + query : ''}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 180000, polling: 250 });
  const gpu = await page.evaluate(() => {
    const gl = window.__vm.engine.gl;
    const e = gl.getExtension('WEBGL_debug_renderer_info');
    return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  console.log('GPU:', gpu);
  if (extra) await page.evaluate(extra);
  const variantFile = arg('variants', '');
  const variants = variantFile ? JSON.parse(fs.readFileSync(variantFile, 'utf8')) : [{ tag, eval: '' }];
  for (const variant of variants) {
  if (variant.eval) await page.evaluate(variant.eval);
  const tag = variant.tag || '';
  for (const view of views) {
    const info = await page.evaluate(async (view, settle) => {
      const vm = window.__vm;
      // "name" = preset view, or "label:x,y,z,lx,ly,lz" = custom camera (y is height above ground)
      if (view.includes(':')) { const c = view.split(':')[1].split(',').map(Number); vm.cam(c[0], c[1], c[2], c[3], c[4], c[5], true); } else vm.setView(view);
      // let progressive systems (clouds, streaming) settle
      for (let i = 0; i < settle; i++) await new Promise((r) => requestAnimationFrame(r));
      return vm.info();
    }, view, settle);
    const file = path.join(out, `${view.split(':')[0]}${tag ? '_' + tag : ''}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 90 });
    let bench = '';
    if (arg('bench', false)) {
      const ms = await page.evaluate(() => window.__vm.bench(40));
      bench = ` | ${ms.toFixed(2)} ms/frame (${(1000 / ms).toFixed(0)} fps)`;
    }
    console.log(`${view}: ${file} | calls ${info.calls} tris ${info.tris}${bench}`);
  }
  }
  if (errors.length) console.log('--- console:\n' + [...new Set(errors)].slice(0, 12).join('\n'));
} finally {
  await browser.close();
}
