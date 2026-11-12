// Texture loading helpers: plain PBR sets and layered array textures.
import * as THREE from 'three';

const loader = new THREE.ImageBitmapLoader();
loader.setOptions({ imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });

export function loadBitmap(url) {
  return new Promise((resolve) => loader.load(url, resolve, undefined, () => resolve(null)));
}

function pixels(bitmap, size, fallback) {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (bitmap) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, size, size);
  } else {
    ctx.fillStyle = fallback;
    ctx.fillRect(0, 0, size, size);
  }
  return ctx.getImageData(0, 0, size, size).data;
}

export async function loadImageData(url) {
  const bmp = await loadBitmap(url);
  if (!bmp) return null;
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close?.();
  return d;
}

const FALLBACK = { col: '#777a70', nrm: '#8080ff', arh: '#ffc880' };

/**
 * Builds three array textures (albedo / normal / AO-rough-height) from a list
 * of material names. Missing files fall back to flat colours so the engine
 * always runs.
 */
export async function loadMaterialArrays(names, size, aniso = 8, base = './assets/tex/') {
  const out = {};
  for (const kind of ['col', 'nrm', 'arh']) {
    const data = new Uint8Array(size * size * 4 * names.length);
    const bitmaps = await Promise.all(names.map((n) => loadBitmap(`${base}${n}_${kind}.jpg`)));
    bitmaps.forEach((b, i) => {
      data.set(pixels(b, size, FALLBACK[kind]), i * size * size * 4);
      b?.close?.();
    });
    const tex = new THREE.DataArrayTexture(data, size, size, names.length);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.colorSpace = kind === 'col' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = aniso;
    tex.needsUpdate = true;
    out[kind] = tex;
  }
  out.index = Object.fromEntries(names.map((n, i) => [n, i]));
  return out;
}

const texLoader = new THREE.TextureLoader();
export function loadTexture(url, { srgb = false, repeat = true, aniso = 8, flipY = true } = {}) {
  const t = texLoader.load(url);
  t.flipY = flipY;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}

export function loadPBR(name, opts = {}) {
  const base = opts.base || './assets/tex/';
  return {
    map: loadTexture(`${base}${name}_col.jpg`, { srgb: true, aniso: opts.aniso }),
    normalMap: loadTexture(`${base}${name}_nrm.jpg`, { aniso: opts.aniso }),
    arh: loadTexture(`${base}${name}_arh.jpg`, { aniso: opts.aniso }),
  };
}

// Small tiling RGBA value-noise texture used all over the shaders.
export function makeNoiseTexture(size = 256, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const data = new Uint8Array(size * size * 4);
  for (let ch = 0; ch < 4; ch++) {
    const acc = new Float32Array(size * size);
    let amp = 1, norm = 0;
    for (let o = 0; o < 6; o++) {
      const n = 4 << o;
      if (n > size) break;
      const g = new Float32Array(n * n);
      for (let i = 0; i < g.length; i++) g[i] = rnd();
      const step = size / n;
      for (let y = 0; y < size; y++) {
        const fy = y / step, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < size; x++) {
          const fx = x / step, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
          const a = g[(y0 % n) * n + (x0 % n)], b = g[(y0 % n) * n + ((x0 + 1) % n)];
          const c = g[((y0 + 1) % n) * n + (x0 % n)], d = g[((y0 + 1) % n) * n + ((x0 + 1) % n)];
          acc[y * size + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
        }
      }
      norm += amp; amp *= 0.5;
    }
    let mn = 1e9, mx = -1e9;
    for (let i = 0; i < acc.length; i++) { acc[i] /= norm; mn = Math.min(mn, acc[i]); mx = Math.max(mx, acc[i]); }
    for (let i = 0; i < acc.length; i++) data[i * 4 + ch] = Math.round(((acc[i] - mn) / (mx - mn)) * 255);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
