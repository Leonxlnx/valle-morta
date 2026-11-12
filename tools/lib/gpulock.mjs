// Cross-process lock so that only one headless-Chrome / GPU job runs at a time
// (the machine has a single integrated GPU shared with other work).
import fs from 'node:fs';

const LOCK = 'tools/_cache/gpu.lock';

export async function acquireGpuLock(maxWaitMs = 900000, staleMs = 300000) {
  fs.mkdirSync('tools/_cache', { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > staleMs) fs.unlinkSync(LOCK); } catch (e2) { /* raced */ }
      if (Date.now() - t0 > maxWaitMs) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const release = () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK); } catch (e) { /* gone */ } };
  process.on('exit', release);
  // keep the lock fresh during long jobs
  const beat = setInterval(() => { try { fs.utimesSync(LOCK, new Date(), new Date()); } catch (e) { /* gone */ } }, 30000);
  beat.unref();
  return release;
}
