// Operation profile: what the player owns between runs, kept in localStorage.
// CATALOGUE describes everything that can be bought; the profile stores one level per entry,
// so adding something to the game is one entry here (and, for a new effect path, one default
// in blankBuild). The run reads the result through Progress.build().

export const PROFILE_KEY = 'valle-morta-profile';
export const PROFILE_VERSION = 1;
export const SLOT_KEYS = ['G', '4', '5'];          // ability slots: player.input.ability 1 / 2 / 3
export const WEAPON_IDS = ['rifle', 'pistol', 'sniper'];
export const TABS = [
  { id: 'weapons', name: 'Weapons', groups: [['rifle', 'AK rifle'], ['pistol', '9 mm pistol'], ['sniper', 'Bolt-action rifle']] },
  { id: 'body', name: 'Body' },
  { id: 'abilities', name: 'Abilities' },
  { id: 'run', name: 'Run' },
];

// An entry:
//   id       unique; also the key in the stored profile
//   tab      weapons | body | abilities | run          group   sub-section inside the tab
//   name, desc                                          one line each
//   levels   how often it can be bought                 cost    [first, growth]: first * growth^level
//   effect   [path into the build, 'mul' | 'add' | 'set', amount per level]
//            mul: base * (1 + amount * level), add: base + amount * level, set: amount[level - 1]
//   show     how the card words the value: pct | int | sec | num | wave | flag     noun   what it is a value of
//   needs    id of an entry that has to be owned first
//   ability  abilities only: { key, short, cooldown[level], duration[level], tiers[level], params }
const S = [60, 1.6];      // cost curve of a five-level weapon line: 60, 95, 155, 245, 395
const line = (w, key, name, desc, per, show, noun, op = 'mul', cost = S) =>
  ({ id: `${w}.${key}`, tab: 'weapons', group: w, name, desc, levels: 5, cost, effect: [`weapon.${w}.${key}`, op, per], show, noun, needs: w === 'sniper' ? 'sniper.unlock' : null });
const perk = (w, key, name, desc, levels, cost, stat, per, show, noun) =>
  ({ id: `${w}.${key}`, tab: 'weapons', group: w, name, desc, levels, cost, effect: [`weapon.${w}.${stat}`, 'add', per], show, noun, needs: w === 'sniper' ? 'sniper.unlock' : null });
const body = (key, name, desc, levels, cost, stat, op, per, show, noun) =>
  ({ id: `body.${key}`, tab: 'body', group: 'body', name, desc, levels, cost, effect: [`player.${stat}`, op, per], show, noun });
const run = (key, name, desc, levels, cost, stat, op, per, show, noun, extra = {}) =>
  ({ id: `run.${key}`, tab: 'run', group: 'run', name, desc, levels, cost, effect: [`run.${stat}`, op, per], show, noun, ...extra });
const ability = (key, name, short, desc, cost, cooldown, duration, tiers, params) =>
  ({ id: `ability.${key}`, tab: 'abilities', group: 'abilities', name, desc, levels: 3, cost, ability: { key, short, cooldown, duration, tiers, params } });

export const CATALOGUE = [
  // ---- AK rifle
  line('rifle', 'damage', 'Damage', 'Hotter loads that hit harder at every range.', 0.08, 'pct', 'damage'),
  line('rifle', 'mag', 'Magazine', 'Longer magazines, fewer pauses in the worst moments.', 4, 'int', 'rounds', 'add'),
  line('rifle', 'reload', 'Reload speed', 'Drilled hands change the magazine faster.', 0.07, 'pct', 'faster'),
  line('rifle', 'recoil', 'Recoil control', 'A heavier stock and a brake keep the muzzle down.', -0.09, 'pct', 'recoil'),
  perk('rifle', 'duplex', 'Double shot', 'Duplex cartridges: two bullets per trigger pull, the second a little wide.', 1, [900, 1], 'pellets', 1, 'flag', 'Two bullets per shot'),
  perk('rifle', 'ap', 'Armour-piercing rounds', 'Steel cores carry on through the body in front.', 2, [350, 2], 'bodies', 1, 'int', 'more bodies'),
  perk('rifle', 'fire', 'Incendiary rounds', 'Every hit sets the target alight for four seconds.', 3, [300, 1.8], 'burn', 8, 'num', 'burn a second'),
  perk('rifle', 'reserve', 'Extended reserve', 'More spare ammunition flown in, more taken from every crate.', 3, [150, 1.7], 'reserve', 0.25, 'pct', 'reserve'),
  // ---- 9 mm pistol (its reserve is unlimited already)
  line('pistol', 'damage', 'Damage', 'Overpressure loads for the side arm.', 0.1, 'pct', 'damage'),
  line('pistol', 'mag', 'Magazine', 'Extended magazines that stand proud of the grip.', 2, 'int', 'rounds', 'add', [50, 1.6]),
  line('pistol', 'reload', 'Reload speed', 'A flared magazine well and a practised thumb.', 0.07, 'pct', 'faster', 'mul', [50, 1.6]),
  line('pistol', 'recoil', 'Recoil control', 'A compensator and a firmer grip.', -0.09, 'pct', 'recoil', 'mul', [50, 1.6]),
  perk('pistol', 'duplex', 'Double shot', 'Duplex cartridges: two bullets per trigger pull, the second a little wide.', 1, [600, 1], 'pellets', 1, 'flag', 'Two bullets per shot'),
  perk('pistol', 'ap', 'Armour-piercing rounds', 'Hardened cores that do not stop at the first body.', 2, [250, 2], 'bodies', 1, 'int', 'more bodies'),
  perk('pistol', 'fire', 'Incendiary rounds', 'Every hit sets the target alight for four seconds.', 3, [220, 1.8], 'burn', 6, 'num', 'burn a second'),
  // ---- bolt-action rifle
  { id: 'sniper.unlock', tab: 'weapons', group: 'sniper', name: 'Bolt-action rifle', desc: 'A scoped rifle with a bipod comes along on every run.', levels: 1, cost: [500, 1], effect: ['weapon.sniper.owned', 'add', 1], show: 'flag', noun: 'Carried on every run' },
  line('sniper', 'damage', 'Damage', 'Match-grade loads for the long shot.', 0.08, 'pct', 'damage', 'mul', [80, 1.6]),
  line('sniper', 'mag', 'Magazine', 'A deeper box magazine under the action.', 1, 'int', 'rounds', 'add'),
  line('sniper', 'reload', 'Reload speed', 'Stripper clips ready on the belt.', 0.08, 'pct', 'faster'),
  line('sniper', 'recoil', 'Recoil control', 'A recoil pad and a weighted fore-end.', -0.09, 'pct', 'recoil'),
  perk('sniper', 'duplex', 'Double shot', 'Duplex cartridges: two bullets per trigger pull, the second a little wide.', 1, [1200, 1], 'pellets', 1, 'flag', 'Two bullets per shot'),
  perk('sniper', 'ap', 'Armour-piercing rounds', 'Tungsten cores go through a whole column of them.', 2, [300, 2], 'bodies', 1, 'int', 'more bodies'),
  perk('sniper', 'fire', 'Incendiary rounds', 'Every hit sets the target alight for four seconds.', 3, [300, 1.8], 'burn', 14, 'num', 'burn a second'),
  perk('sniper', 'reserve', 'Extended reserve', 'More spare ammunition flown in, more taken from every crate.', 3, [150, 1.7], 'reserve', 0.25, 'pct', 'reserve'),
  // ---- body
  body('armour', 'Armour', 'Plates that take a share of every blow.', 5, [80, 1.6], 'armour', 'add', 0.06, 'pct', 'absorbed'),
  body('health', 'Maximum health', 'More to lose before you fall.', 5, [60, 1.6], 'maxHealth', 'add', 10, 'int', 'health'),
  body('sprint', 'Sprint speed', 'Lighter webbing and stronger legs.', 5, [60, 1.6], 'sprint', 'mul', 0.04, 'pct', 'sprint'),
  body('heal', 'Healing speed', 'Bandages go on faster and wounds close sooner.', 5, [60, 1.6], 'heal', 'mul', 0.12, 'pct', 'faster'),
  body('bandages', 'Bandage capacity', 'Room for more bandages on the belt.', 3, [120, 1.8], 'bandageMax', 'add', 1, 'int', 'carried'),
  body('fall', 'Softer landings', 'Better boots take the sting out of a long drop.', 4, [70, 1.6], 'fall', 'mul', -0.15, 'pct', 'from falls'),
  body('regen', 'Second wind', 'The health segment you are in starts to refill sooner after a blow.', 4, [90, 1.6], 'regenDelay', 'mul', -0.15, 'pct', 'wait'),
  // ---- abilities: level 1 unlocks, levels 2 and 3 upgrade. The effects plug into operation.abilities.
  ability('tank', 'Deployable tank', 'Tank', 'A light tank is set down beside you: drive it through the infected.', [600, 1.8], [150, 130, 110], [12, 14, 16],
    ['12 s at the controls', '14 s, ready again after 130 s', '16 s, ready again after 110 s'], { speed: 9, crush: 1.7 }),
  ability('mortar', 'Mortar barrage', 'Mortar', 'Mark the ground ahead; the shells arrive a moment later.', [450, 1.8], [90, 80, 70], [4, 4, 4],
    ['6 shells', '8 shells, ready again after 80 s', '11 shells, ready again after 70 s'], { shells: [6, 8, 11], radius: 5.5, damage: 420, spread: 11, delay: 1.6, range: 60 }),
  ability('sentry', 'Sentry gun', 'Sentry', 'An automatic gun on a tripod covers your back until it runs dry.', [450, 1.8], [100, 90, 80], [25, 32, 40],
    ['25 s of fire', '32 s, ready again after 90 s', '40 s, ready again after 80 s'], { damage: [16, 20, 24], rate: 7, range: 32 }),
  ability('adrenaline', 'Adrenaline', 'Adrenaline', 'One shot in the thigh and the world slows while your hands stay fast.', [350, 1.8], [70, 62, 55], [5, 6.5, 8],
    ['5 s of slow motion', '6.5 s, ready again after 62 s', '8 s, ready again after 55 s'], { timeScale: 0.4 }),
  ability('jump', 'Jump pack', 'Jump', 'A boosted leap over walls, the river and reaching hands.', [300, 1.8], [14, 11, 8], [0, 0, 0],
    ['A leap every 14 s', 'Higher, every 11 s', 'Higher still, every 8 s'], { up: [11, 12.5, 14], forward: 9 }),
  // ---- run modifiers
  run('salvage', 'Salvage rights', 'Everything you gather in the valley is worth more.', 5, [200, 1.7], 'salvage', 'mul', 0.1, 'pct', 'salvage'),
  run('start', 'Forward insertion', 'Skip the quiet opening and begin at a later wave.', 4, [250, 1.8], 'startWave', 'set', [3, 6, 8, 11], 'wave', 'start', { choice: true }),
  run('bandages', 'Field dressings', 'Extra bandages in your pockets as you step off the skid.', 2, [150, 2], 'bandages', 'add', 1, 'int', 'at the start'),
  run('crates', 'Supply priority', 'The crates dropped between waves carry more ammunition.', 3, [180, 1.7], 'crates', 'mul', 0.25, 'pct', 'in crates'),
  run('window', 'Patient pilot', 'The helicopter waits longer at the landing zone.', 2, [200, 2], 'window', 'add', 10, 'sec', 'waiting'),
  run('bonus', 'Extraction premium', 'A bigger bonus for bringing the haul out yourself.', 3, [300, 1.8], 'bonus', 'add', 0.1, 'pct', 'bonus'),
];
const BY_ID = new Map(CATALOGUE.map((i) => [i.id, i]));
const ABILITIES = new Map(CATALOGUE.filter((i) => i.ability).map((i) => [i.ability.key, i]));
export const abilityItem = (key) => ABILITIES.get(key) || null;

// price of the next level when `level` are owned
export function costAt(item, level) { return Math.round((item.cost[0] * Math.pow(item.cost[1], level)) / 5) * 5; }

// the value an entry gives at a level, in the words of the card ('' when nothing is owned)
export function valueText(item, level) {
  if (!level) return '';
  if (item.ability) return item.ability.tiers[level - 1];
  const per = item.effect[2];
  switch (item.show) {
    case 'pct': { const v = Math.round(per * level * 100); return `${v < 0 ? '−' : '+'}${Math.abs(v)}%`; }
    case 'int': return `+${Math.round(per * level)}`;
    case 'sec': return `+${Math.round(per * level)} s`;
    case 'num': return `${Math.round(per * level)}`;
    case 'wave': return `wave ${per[level - 1]}`;
    default: return '';
  }
}
export function effectText(item, level) {
  if (item.ability || !level) return valueText(item, level);
  return `${valueText(item, level)} ${item.noun}`.trim();
}

// What a run is built from. Survival uses stockBuild(); an Operation run the profile's build().
export function blankBuild() {
  const weapon = {};
  for (const id of WEAPON_IDS) weapon[id] = { owned: id === 'sniper' ? 0 : 1, damage: 1, mag: 0, reload: 1, recoil: 1, bodies: 0, pellets: 1, burn: 0, reserve: 1 };
  return {
    weapon,
    player: { maxHealth: 100, armour: 0, sprint: 1, heal: 1, bandageMax: 3, fall: 1, regenDelay: 1 },
    run: { salvage: 1, startWave: 1, bandages: 0, crates: 1, window: 0, bonus: 0 },
  };
}
export function stockBuild() { const b = blankBuild(); b.weapon.sniper.owned = 1; return b; }

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(num(v, lo))));
const blank = () => ({
  v: PROFILE_VERSION, salvage: 0, levels: {}, loadout: [null, null, null], options: {},
  best: { wave: 0, salvage: 0 }, totals: { runs: 0, extractions: 0, kills: 0, salvage: 0 }, history: [],
});

// Whatever was stored (nothing, an older version, a damaged or hand-edited record) becomes a valid profile.
function clean(raw) {
  const p = blank();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return p;
  p.salvage = Math.max(0, Math.floor(num(raw.salvage)));
  const lv = raw.levels && typeof raw.levels === 'object' ? raw.levels : {};
  for (const item of CATALOGUE) { const l = int(lv[item.id], 0, item.levels); if (l > 0) p.levels[item.id] = l; }
  if (Array.isArray(raw.loadout)) {
    for (let i = 0; i < SLOT_KEYS.length; i++) {
      const key = raw.loadout[i], item = typeof key === 'string' ? ABILITIES.get(key) : null;
      if (item && p.levels[item.id] && !p.loadout.includes(key)) p.loadout[i] = key;
    }
  }
  const opt = raw.options && typeof raw.options === 'object' ? raw.options : {};
  for (const item of CATALOGUE) if (item.choice && opt[item.id] !== undefined) p.options[item.id] = int(opt[item.id], 0, p.levels[item.id] || 0);
  const b = raw.best && typeof raw.best === 'object' ? raw.best : {}, t = raw.totals && typeof raw.totals === 'object' ? raw.totals : {};
  p.best.wave = Math.max(0, Math.floor(num(b.wave))); p.best.salvage = Math.max(0, Math.floor(num(b.salvage)));
  for (const k in p.totals) p.totals[k] = Math.max(0, Math.floor(num(t[k])));
  if (Array.isArray(raw.history)) {
    for (const h of raw.history.slice(0, 12)) {
      if (!h || typeof h !== 'object') continue;
      p.history.push({ t: num(h.t), outcome: h.outcome === 'extract' || h.outcome === 'abandon' ? h.outcome : 'death', wave: Math.floor(num(h.wave)), cleared: Math.floor(num(h.cleared)), kills: Math.floor(num(h.kills)), earned: Math.floor(num(h.earned)), banked: Math.floor(num(h.banked)) });
    }
  }
  return p;
}

function defaultStorage() {
  try { const s = window.localStorage; s.getItem(PROFILE_KEY); return s; } catch (e) { /* private mode, no window */ }
  const mem = {};
  return { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
}

export class Progress {
  constructor(storage) {
    this.storage = storage || defaultStorage();
    this._subs = [];
    this.data = blank();
    this.load();
  }

  get catalogue() { return CATALOGUE; }
  load() {
    let raw = null;
    try { raw = JSON.parse(this.storage.getItem(PROFILE_KEY) || 'null'); } catch (e) { raw = null; }
    this.data = clean(raw);
    return this;
  }
  save() {
    try { this.storage.setItem(PROFILE_KEY, JSON.stringify(this.data)); } catch (e) { /* storage full or blocked: the session still works */ }
    for (const fn of this._subs) fn(this);
  }
  reset() { this.data = blank(); this.save(); }
  onChange(fn) { this._subs.push(fn); return this; }

  get salvage() { return this.data.salvage; }
  grant(n) { this.data.salvage = Math.max(0, this.data.salvage + Math.floor(num(n))); this.save(); return this.data.salvage; }

  item(id) { return BY_ID.get(id) || null; }
  list(tab, group) { return CATALOGUE.filter((i) => i.tab === tab && (!group || i.group === group)); }
  level(id) { return this.data.levels[id] || 0; }
  owned(id) { return this.level(id) > 0; }
  locked(id) { const it = BY_ID.get(id); return !!(it && it.needs && !this.owned(it.needs)); }
  // price of the next level, or null when there is none
  cost(id) { const it = BY_ID.get(id); if (!it) return null; const l = this.level(id); return l >= it.levels ? null : costAt(it, l); }

  // { ok, reason: 'unknown' | 'locked' | 'max' | 'funds', level, cost }
  buy(id) {
    const it = BY_ID.get(id);
    if (!it) return { ok: false, reason: 'unknown' };
    const level = this.level(id), cost = this.cost(id);
    if (this.locked(id)) return { ok: false, reason: 'locked', level, cost };
    if (cost === null) return { ok: false, reason: 'max', level, cost };
    if (cost > this.data.salvage) return { ok: false, reason: 'funds', level, cost };
    this.data.salvage -= cost;
    this.data.levels[id] = level + 1;
    if (it.choice) this.data.options[id] = level + 1;                       // a new step is switched on when bought
    if (it.ability && level === 0 && this.slotOf(it.ability.key) < 0) {     // a new ability takes a free slot
      const free = this.data.loadout.indexOf(null);
      if (free >= 0) this.data.loadout[free] = it.ability.key;
    }
    this.save();
    return { ok: true, level: level + 1, cost, first: level === 0 };
  }

  // entries with `choice` can be turned down again (start wave): the level in use, 0 .. owned
  chosen(id) { const l = this.level(id), o = this.data.options[id]; return o === undefined ? l : Math.min(l, o); }
  choose(id, level) { const it = BY_ID.get(id); if (!it || !it.choice) return false; this.data.options[id] = int(level, 0, this.level(id)); this.save(); return true; }

  // ---- ability loadout: up to three, one per slot
  get loadout() { return this.data.loadout.slice(); }
  slotOf(key) { return this.data.loadout.indexOf(key); }
  equip(key, slot) {
    const it = ABILITIES.get(key);
    if (!it || !this.owned(it.id)) return false;
    const lo = this.data.loadout, cur = lo.indexOf(key);
    if (slot === undefined) slot = lo.indexOf(null);
    if (slot < 0 || slot >= SLOT_KEYS.length) return false;
    if (cur >= 0) lo[cur] = null;
    lo[slot] = key;
    this.save();
    return true;
  }
  unequip(slot) { if (!this.data.loadout[slot]) return false; this.data.loadout[slot] = null; this.save(); return true; }

  // everything bought, folded into the numbers a run starts from
  build() {
    const b = blankBuild();
    for (const item of CATALOGUE) {
      const level = item.choice ? this.chosen(item.id) : this.level(item.id);
      if (!level || !item.effect) continue;
      const [path, op, per] = item.effect, keys = path.split('.');
      let o = b;
      for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
      const k = keys[keys.length - 1];
      o[k] = op === 'mul' ? o[k] * (1 + per * level) : op === 'add' ? o[k] + per * level : per[level - 1];
    }
    return b;
  }

  // a finished run: banks the salvage, keeps the records and the last twelve runs
  recordRun(run) {
    const d = this.data, banked = Math.max(0, Math.floor(num(run.banked)));
    const record = num(run.wave) > d.best.wave;
    d.salvage += banked;
    d.best.wave = Math.max(d.best.wave, Math.floor(num(run.wave)));
    d.best.salvage = Math.max(d.best.salvage, banked);
    d.totals.runs++; d.totals.kills += Math.floor(num(run.kills)); d.totals.salvage += banked;
    if (run.outcome === 'extract') d.totals.extractions++;
    d.history.unshift({ t: Date.now(), outcome: run.outcome, wave: Math.floor(num(run.wave)), cleared: Math.floor(num(run.cleared)), kills: Math.floor(num(run.kills)), earned: Math.floor(num(run.earned)), banked });
    d.history.length = Math.min(d.history.length, 12);
    this.save();
    return { record, balance: d.salvage };
  }
}
