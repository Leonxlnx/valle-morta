(async () => {
  // Helicopter review views: one parked heli at the landing zone meadow, one hovering far away showing its LOD.
  // node tools/shot.mjs --views h34,hrear,hside,hnose,hhub,hglass,hcock,hcabin,hfly,hfar --w 1280 --h 720 --q high --out tools/_preview/heli2 --eval "$(cat tools/vehicles/heli/shots.js)"
  const vm = window.__vm, T = vm.terrain, X = 40, Z = -90, g = T.heightAt(X, Z);
  const m = await import('/src/game/operation.js?t=' + Date.now());
  const mk = async () => { const h = new m.Helicopter(vm.game); await h.ready; vm.engine.scene.add(h.group); return h; };
  const near = (k) => { k._far = false; k.lod.visible = false; k.near.forEach((o) => { o.visible = true; }); };
  const h = await mk(); h.group.position.set(X, g, Z); h.spin = 0; h._spin(0); near(h);
  const f = await mk(); f.group.position.set(X, g + 18, Z + 240); f.spin = 1; f._spin(0); f.lod.visible = true; f.near.forEach((o) => { o.visible = false; });
  const fl = await mk(); fl.group.position.set(X + 70, g + 14, Z - 20); fl.group.rotation.set(-0.08, 0.6, 0.04); fl.spin = 1; fl._spin(0); near(fl);
  const V = vm.VIEWS, P = (x, y, z) => [X + x, g + y, Z + z];
  V.h34 = { pos: [X + 8.5, 1.6, Z - 10], look: P(0, 1.5, -1.2) };
  V.hrear = { pos: [X - 9, 2.2, Z + 10], look: P(0, 1.8, 2) };
  V.hside = { pos: [X + 15.5, 1.7, Z - 1.5], look: P(0, 1.8, 1.5) };
  V.hnose = { pos: [X + 2.6, 1.5, Z - 8.2], look: P(0, 1.35, -3.6) };
  V.hhub = { pos: [X + 3.2, 4.9, Z + 2.2], look: P(0, 3.2, -0.2) };
  V.hglass = { pos: [X + 1.9, 2.0, Z - 6.4], look: P(0.2, 1.55, -2.6) };
  V.hcock = { pos: [X + 0.05, 1.68, Z - 1.6], look: P(0, 1.25, -5) };
  V.hcabin = { pos: [X + 0.42, 1.52, Z + 0.1], look: P(10, 1.0, 0.6) };
  V.hfly = { pos: [X + 58, 1.6, Z - 3], look: [X + 70, g + 15, Z - 20] };
  V.hfar = { pos: [X - 20, 2.0, Z + 60], look: [X, g + 18, Z + 240] };
  window.__heliShots = { h, f, fl };
})();
