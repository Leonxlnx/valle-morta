// GPU capability checks, forced fallbacks for testing, and the plain full-screen messages for the
// cases the game cannot recover from (no WebGL2, a lost context).
//
// ?caps=a,b,... masks capabilities before three.js creates its context, to exercise each fallback:
//   nowebgl2       getContext('webgl2') returns null              -> plain message
//   nofloat        no EXT_color_buffer_float (16F targets only)   -> float32 probe target becomes 16F
//   nohalf         no renderable float formats at all             -> plain message (no HDR image possible)
//   nofloatlinear  no OES_texture_float_linear                    -> height texture sampled nearest
//   tex4096 / tex2048  MAX_TEXTURE_SIZE reported as that          -> shadow map, sky, textures clamped
//   lose=N         loses the context N seconds after start        -> reload prompt
const MASK = (() => {
  try { return new Set((new URLSearchParams(location.search).get('caps') || '').split(',').filter(Boolean)); } catch (e) { return new Set(); }
})();

export function installCapMask() {
  if (!MASK.size || globalThis.__vmCapMask) return;
  globalThis.__vmCapMask = true;
  const hidden = new Set();
  if (MASK.has('nofloat') || MASK.has('nohalf')) hidden.add('EXT_color_buffer_float');
  if (MASK.has('nohalf')) hidden.add('EXT_color_buffer_half_float');
  if (MASK.has('nofloatlinear')) hidden.add('OES_texture_float_linear');
  const maxTex = MASK.has('tex2048') ? 2048 : MASK.has('tex4096') ? 4096 : 0;
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl2' && MASK.has('nowebgl2')) return null;
    const gl = orig.call(this, type, attrs);
    if (!gl || type !== 'webgl2' || gl.__vmMasked) return gl;
    gl.__vmMasked = true;
    const ge = gl.getExtension.bind(gl), gs = gl.getSupportedExtensions.bind(gl), gp = gl.getParameter.bind(gl);
    gl.getExtension = (n) => (hidden.has(n) ? null : ge(n));
    gl.getSupportedExtensions = () => (gs() || []).filter((n) => !hidden.has(n));
    if (maxTex) gl.getParameter = (p) => (p === gl.MAX_TEXTURE_SIZE || p === gl.MAX_RENDERBUFFER_SIZE ? Math.min(maxTex, gp(p)) : gp(p));
    return gl;
  };
}

export function hasWebGL2() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; }
}

// What the engine relies on, read once from the live context.
export function probeCaps(gl) {
  const ext = (n) => !!gl.getExtension(n);
  const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  const c = {
    floatRender: ext('EXT_color_buffer_float'),                     // RGBA16F + RGBA32F targets
    halfRender: ext('EXT_color_buffer_float') || ext('EXT_color_buffer_half_float'),
    floatLinear: ext('OES_texture_float_linear'),                    // filtering of 32-bit float textures
    highp: !!hp && hp.precision >= 23,
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
    maxUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
    maxVaryings: gl.getParameter(gl.MAX_VARYING_VECTORS),
    maxFragUniforms: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
    maxVertUniforms: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),
    maxSamples: gl.getParameter(gl.MAX_SAMPLES),
  };
  // the engine's needs: renderable 16F, highp fragment floats, 16 samplers, 2048 px textures
  c.missing = [];
  if (!c.halfRender) c.missing.push('rendering to half-float targets (EXT_color_buffer_half_float)');
  if (!c.highp) c.missing.push('high-precision fragment shaders');
  if (c.maxUnits < 16) c.missing.push('16 texture units per shader');
  if (c.maxTex < 2048) c.missing.push('2048 px textures');
  return c;
}

export function loseAfter(gl) {
  const m = [...MASK].find((x) => x.startsWith('lose='));
  if (!m) return;
  const ext = gl.getExtension('WEBGL_lose_context');
  if (ext) setTimeout(() => ext.loseContext(), Number(m.slice(5)) * 1000);
}

// A plain full-screen message with an optional reload button; replaces whatever is on screen.
export function showMessage(title, text, reload = false) {
  const old = document.getElementById('vm-fatal');
  if (old) old.remove();
  const d = document.createElement('div');
  d.id = 'vm-fatal';
  d.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:#0d0f0e;color:#e8e6e1;font-family:"Inter Variable",Inter,system-ui,sans-serif;padding:24px;text-align:center';
  const box = document.createElement('div');
  box.style.cssText = 'max-width:440px';
  const h = document.createElement('div');
  h.style.cssText = 'font-size:20px;font-weight:600;margin-bottom:10px';
  h.textContent = title;
  const p = document.createElement('div');
  p.style.cssText = 'font-size:15px;line-height:1.5;opacity:.75';
  p.textContent = text;
  box.append(h, p);
  if (reload) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = 'Reload';
    b.style.cssText = 'margin-top:22px;font:inherit;font-size:16px;font-weight:600;padding:12px 32px;border-radius:10px;border:0;background:#e8e6e1;color:#111;cursor:pointer;touch-action:manipulation';
    b.addEventListener('click', () => location.reload());
    box.append(b);
  }
  d.append(box);
  document.body.appendChild(d);
}
