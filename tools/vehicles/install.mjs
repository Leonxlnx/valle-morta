// Copies finished vehicle models into public/assets/models while holding the GPU lock: a write into public/
// makes the dev server reload every open page, which must not happen in the middle of another tool's test.
//   node tools/vehicles/install.mjs heli            (tools/vehicles/heli/_work/heli.glb)
//   node tools/vehicles/install.mjs tank_wreck tank  (tools/vehicles/tank/build/<name>.glb)
import fs from 'node:fs';
import path from 'node:path';
import { acquireGpuLock } from '../lib/gpulock.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const src = (n) => n === 'heli' ? path.join(root, 'tools/vehicles/heli/_work/heli.glb') : path.join(root, 'tools/vehicles/tank/build', n + '.glb');
const names = process.argv.slice(2);
for (const n of names) if (!fs.existsSync(src(n))) { console.error('missing', src(n)); process.exit(1); }
const release = await acquireGpuLock();
try {
  for (const n of names) {
    fs.copyFileSync(src(n), path.join(root, 'public/assets/models', n + '.glb'));
    console.log('installed', n, (fs.statSync(src(n)).size / 1e6).toFixed(2), 'MB');
  }
  await new Promise((r) => setTimeout(r, 3000));
} finally { release(); }
