// Light asset set for phones and tablets (public/assets/m/, built by tools/mobile-assets.mjs).
// When MOBILE is true (or ?lite=1), every request for a file under assets/ that the manifest lists is
// sent to its reduced copy instead, whoever makes it: fetch() calls and three.js loaders alike (the
// default loading manager's URL modifier). Files the manifest does not list load as they are.
// ?lite=0 forces the full set on a phone.
import * as THREE from 'three';
import { MOBILE } from '../core/device.js';

// bytes: received so far through fetch() for files under assets/ (three's image bitmaps, GLBs,
// terrain data), for a loading display that follows the real download on a slow connection
export const assetStats = { lite: false, mapped: 0, redirected: 0, bytes: 0 };
let files = null;
const map = (url) => {
  if (!files || typeof url !== 'string') return url;
  const i = url.indexOf('assets/');
  if (i < 0 || url.startsWith('blob:') || url.startsWith('data:')) return url;
  const m = files[url.slice(i + 7).split(/[?#]/)[0]];
  if (!m) return url;
  assetStats.redirected++;
  return url.slice(0, i + 7) + 'm/' + m;
};
function count(res) {
  if (!res.ok || !res.body || typeof TransformStream === 'undefined') return res;
  const ts = new TransformStream({ transform(chunk, ctl) { assetStats.bytes += chunk.byteLength; ctl.enqueue(chunk); } });
  return new Response(res.body.pipeThrough(ts), { status: res.status, statusText: res.statusText, headers: res.headers });
}
function wanted() {
  try {
    const p = new URLSearchParams(location.search).get('lite');
    if (p === '1' || p === '0') return p === '1';
  } catch (e) { /* no location */ }
  return MOBILE;
}

// Started when this module is evaluated (main.js imports it first): some modules begin their
// downloads at import time (the helicopter), and their fetch() calls wait for the manifest.
let ready = null;
function start() {
  if (ready) return ready;
  const f0 = globalThis.fetch.bind(globalThis);
  ready = !wanted() ? Promise.resolve() : f0('./assets/m/manifest.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((m) => {
      files = m.files || {};
      assetStats.startBytes = m.startBytes || 0;
      assetStats.lite = true; assetStats.mapped = Object.keys(files).length;
      THREE.DefaultLoadingManager.setURLModifier(map);
    })
    .catch(() => { console.info('[assets] no light set, loading the full assets'); });
  if (!globalThis.__vmFetch) {
    globalThis.__vmFetch = true;
    globalThis.fetch = (input, init) => {
      if (typeof input !== 'string' || !input.includes('assets/')) return f0(input, init);
      return ready.then(() => f0(map(input), init)).then(count);
    };
  }
  return ready;
}
if (typeof window !== 'undefined') start();

export async function initAssets() {
  await start();
  return assetStats;
}
