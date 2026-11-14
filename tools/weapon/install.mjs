// Copies finished view models from tools/weapon/build/out into public/assets/models while holding the GPU lock
// (writing into public/ reloads every open dev-server page, so this must not happen under someone else's test).
//   node tools/weapon/install.mjs pistol sniper
import fs from 'node:fs';
import path from 'node:path';
const { acquireGpuLock } = await import('../lib/gpulock.mjs');
const ids = process.argv.slice(2);
const release = await acquireGpuLock();
try {
  for (const id of ids) for (const ext of ['.glb', '.anim.json']) {
    const src = path.join('tools/weapon/build/out', id + ext);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join('public/assets/models', id + ext)); console.log('installed', id + ext); }
  }
  await new Promise((r) => setTimeout(r, 3000));
} finally { if (typeof release === 'function') release(); }
