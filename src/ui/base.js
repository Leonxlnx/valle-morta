// Base: the screen between Operation runs. Salvage buys permanent upgrades here, the ability
// loadout is put together and the next run is launched. Everything listed comes from the
// catalogue in game/progress.js; this file only lays it out. Mouse only.
import './base.css';
import { TABS, SLOT_KEYS, valueText, abilityItem } from '../game/progress.js';

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const OUTCOME = { extract: 'Extracted', death: 'Fell in the valley', abandon: 'Left the run' };

export class BaseScreen {
  // handlers: sound(name, volume); the Deploy and Main menu buttons are data-act buttons handled by the UI root
  constructor(progress, handlers) {
    this.p = progress; this.h = handlers || {};
    this.tab = 'weapons'; this.group = 'rifle'; this.fresh = null; this._hover = null;
    this.el = el('section', 'screen base', `
      <div class="base-wrap">
        <header class="base-head">
          <div class="base-title"><h2>Base</h2><p class="base-sub"></p></div>
          <div class="bank"><b>0</b><span>salvage</span></div>
          <button type="button" class="btn primary deploy" data-act="deploy">Deploy</button>
        </header>
        <div class="base-bar">
          <nav class="tabs">${TABS.map((t) => `<button type="button" data-tab="${t.id}">${t.name}</button>`).join('')}</nav>
          <nav class="subtabs"></nav>
        </div>
        <div class="base-body"></div>
        <footer class="base-foot">
          <p>After every fifth cleared wave the helicopter returns for half a minute. Board it and keep everything plus a bonus; fall and keep half.</p>
          <button type="button" class="btn" data-act="quit">Main menu</button>
        </footer>
      </div>`);
    const q = (s) => this.el.querySelector(s);
    this.sub = q('.base-sub'); this.bank = q('.bank b'); this.tabs = q('.tabs'); this.subtabs = q('.subtabs'); this.body = q('.base-body');
    this.el.addEventListener('click', (e) => this._click(e));
    this.el.addEventListener('mouseover', (e) => {
      const b = e.target.closest('button');
      if (b && b !== this._hover) this.h.sound?.('ui_hover', 0.2);
      this._hover = b;
    });
    progress.onChange(() => { if (this.el.classList.contains('show')) this.render(); });
  }

  open() { this.render(); }

  _click(e) {
    const b = e.target.closest('button');
    if (!b || b.dataset.act) return;
    const d = b.dataset, p = this.p;
    if (d.tab) { this.tab = d.tab; this.h.sound?.('ui_click'); this.render(); }
    else if (d.group) { this.group = d.group; this.h.sound?.('ui_click'); this.render(); }
    else if (d.buy) {
      const item = p.item(d.buy);
      this.fresh = d.buy;
      const r = p.buy(d.buy);                        // a purchase re-renders through onChange
      if (r.ok) this.h.sound?.(r.first && (item.ability || item.levels === 1) ? 'ui_buy' : 'ui_upgrade', 0.6);
      else { this.fresh = null; this._refuse(b); }
    } else if (d.equip) {
      const slot = p.slotOf(d.equip);
      if (slot >= 0 ? p.unequip(slot) : p.equip(d.equip)) this.h.sound?.('ui_click'); else this._refuse(b);
    } else if (d.slot) { if (p.unequip(Number(d.slot))) this.h.sound?.('ui_click'); }
    else if (d.choose) { p.choose(d.choose, Number(d.level)); this.h.sound?.('ui_click'); }
  }

  _refuse(b) {
    this.h.sound?.('ui_error', 0.5);
    b.classList.remove('no'); void b.offsetWidth; b.classList.add('no');
  }

  render() {
    const p = this.p, d = p.data, tab = TABS.find((t) => t.id === this.tab) || TABS[0];
    this.bank.textContent = fmt(p.salvage);
    this.sub.textContent = d.totals.runs
      ? `Best wave ${d.best.wave} · ${d.totals.extractions} of ${d.totals.runs} ${d.totals.runs === 1 ? 'run' : 'runs'} extracted · ${fmt(d.totals.kills)} infected put down`
      : 'Nothing banked yet. Fly in, gather salvage, and bring it back out.';
    this.tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab.id));
    this.subtabs.innerHTML = tab.groups ? tab.groups.map(([id, name]) => `<button type="button" data-group="${id}"${id === this.group ? ' class="on"' : ''}>${name}</button>`).join('') : '';
    this.subtabs.style.visibility = tab.groups ? 'visible' : 'hidden';
    const fresh = this.fresh; this.fresh = null;
    const cards = (list, cls = '') => `<div class="cards${cls}">${list.map((it) => this._card(it, fresh)).join('')}</div>`;
    if (tab.id === 'weapons') this.body.innerHTML = cards(p.list('weapons', this.group));
    else if (tab.id === 'body') this.body.innerHTML = cards(p.list('body'));
    else if (tab.id === 'abilities') {
      const slots = p.loadout.map((key, i) => `<button type="button" class="slot${key ? ' full' : ''}" data-slot="${i}"><b>${SLOT_KEYS[i]}</b><span>${key ? abilityItem(key).name : 'Empty'}</span></button>`).join('');
      this.body.innerHTML = `<div class="loadout"><div><h3>Loadout</h3><p>Up to three abilities come along on a run. Click a slot to clear it.</p></div><div class="slots">${slots}</div></div>${cards(p.list('abilities'), ' three')}`;
    } else {
      const runs = d.history.slice(0, 6).map((h) => `<li><strong class="${h.outcome}">${OUTCOME[h.outcome] || OUTCOME.death}</strong><b>+${fmt(h.banked)}</b><span>Wave ${h.wave} · ${h.kills} down</span></li>`).join('');
      this.body.innerHTML = `<div class="run-grid">${cards(p.list('run'), ' three')}<aside class="runs"><h3>Recent runs</h3>${runs ? `<ol>${runs}</ol>` : '<p class="none">Your runs are listed here with what each one brought back.</p>'}</aside></div>`;
    }
  }

  _card(it, fresh) {
    const p = this.p, l = p.level(it.id), locked = p.locked(it.id), cost = p.cost(it.id), poor = cost !== null && cost > p.salvage;
    const pips = Array.from({ length: it.levels }, (_, i) => `<i${i < l ? ' class="on"' : ''}></i>`).join('');
    const cls = `card${it.id === fresh ? ' fresh' : ''}${locked ? ' locked' : ''}${it.ability ? ' ability' : ''}`;
    const head = `<div class="card-top"><h4>${it.name}</h4><span class="pips">${pips}</span></div><p class="card-desc">${it.desc}</p>`;
    let buy;
    if (locked) buy = `<span class="card-state">Needs the ${p.item(it.needs).name.toLowerCase()}</span>`;
    else if (cost === null) buy = '<span class="card-state">Complete</span>';
    else buy = `<button type="button" class="buy${poor ? ' poor' : ''}" data-buy="${it.id}"><span>${l === 0 && (it.ability || it.levels === 1) ? 'Unlock' : 'Upgrade'}</span><b>${fmt(cost)}</b></button>`;

    if (it.ability) {
      const a = it.ability, slot = p.slotOf(a.key);
      // the first level of an ability that runs for a while also names its cooldown
      const tier = (lv) => (lv === 1 && a.duration[0] > 0 ? `${a.tiers[0]}, ready again after ${a.cooldown[0]} s` : a.tiers[lv - 1]);
      const fx = l ? `<b>${tier(l)}</b>${l < it.levels ? `<span>Next: ${tier(l + 1)}</span>` : ''}` : `<span>${tier(1)}</span>`;
      const equip = l ? `<button type="button" class="equip${slot >= 0 ? ' on' : ''}" data-equip="${a.key}">${slot >= 0 ? `In slot ${SLOT_KEYS[slot]}` : 'Equip'}</button>` : '<span></span>';
      return `<article class="${cls}">${head}<p class="card-tier">${fx}</p><div class="card-foot">${equip}${buy}</div></article>`;
    }
    const now = valueText(it, l), next = l < it.levels ? valueText(it, l + 1) : '';
    let fx = '';
    if (!locked) {
      if (it.show === 'flag') fx = l ? `<b>${it.noun}</b>` : it.noun;
      else fx = `${l ? `<b>${now}</b>` : ''}${l && next ? ' <em>→</em> ' : ''}${next} ${it.noun}`;
    }
    let opt = '';
    if (it.choice && l > 0) {
      const use = p.chosen(it.id), per = it.effect[2];
      const btn = (lv) => `<button type="button" data-choose="${it.id}" data-level="${lv}"${lv === use ? ' class="on"' : ''}>${lv ? per[lv - 1] : 1}</button>`;
      opt = `<div class="card-opt"><span>Next run starts at wave</span><span class="pick">${Array.from({ length: l + 1 }, (_, i) => btn(i)).join('')}</span></div>`;
    }
    return `<article class="${cls}">${head}${opt}<div class="card-foot"><span class="card-fx">${fx}</span>${buy}</div></article>`;
  }
}
