// Copies the finished infected models from tools/zombie/stage into public/assets/models while holding the GPU lock:
// a write into public/ makes the dev server reload every open page, which must not happen during another tool's test.
//   node tools/zombie/install.mjs              (everything in the stage folder)
//   node tools/zombie/install.mjs zombie brute (only these models and their colour maps)
import fs from 'node:fs';
import path from 'node:path';
import { acquireGpuLock } from '../lib/gpulock.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const stage = path.join(here, 'stage'), dst = path.join(here, '..', '..', 'public', 'assets', 'models');
const want = process.argv.slice(2);
const files = fs.readdirSync(stage).filter((f) => /^(zombie|runner|brute|boss)(_col_\w)?\.(glb|jpg)$/.test(f) && (!want.length || want.includes(f.split(/[_.]/)[0])));
if (!files.length) { console.error('nothing staged in', stage); process.exit(1); }
const release = await acquireGpuLock();
try {
  for (const f of files) { fs.copyFileSync(path.join(stage, f), path.join(dst, f)); console.log('installed', f, (fs.statSync(path.join(stage, f)).size / 1e6).toFixed(2), 'MB'); }
  await new Promise((r) => setTimeout(r, 3000));
} finally { release(); }
