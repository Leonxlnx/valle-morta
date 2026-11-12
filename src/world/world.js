// World assembly. Each module lives in its own file and exports
//   async function build(ctx) -> handle (optional)
// ctx = {
//   engine, scene, terrain, layout, quality,
//   colliders: [],   // push static THREE.Mesh objects (world matrices final) the player/bullets collide with
//   updaters: [],    // push (dt, camera, time) => void, called every frame
//   mods: {},        // handles of the modules built so far
// }
// A module that throws is logged and skipped so one broken file never takes
// the whole scene down. `?off=a,b` in the URL skips modules by name.
const LOADERS = {
  water: () => import('./water.js'),
  buildings: () => import('./buildings.js'),
  props: () => import('./props.js'),
  vegetation: () => import('./vegetation.js'),
};

export async function buildWorld(engine, terrain, layout, off = new Set(), onProgress = () => {}) {
  const ctx = { engine, scene: engine.scene, terrain, layout, quality: engine.q, colliders: [], updaters: [], mods: {} };
  const names = Object.keys(LOADERS).filter((n) => !off.has(n));
  let i = 0;
  for (const name of names) {
    try {
      const mod = await LOADERS[name]();
      ctx.mods[name] = (await mod.build(ctx)) || {};
    } catch (e) {
      console.error(`[world] module "${name}" failed:`, e);
    }
    onProgress(++i / names.length, name);
  }
  return ctx;
}
