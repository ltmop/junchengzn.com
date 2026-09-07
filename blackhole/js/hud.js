// HUD: title/fps/status bar, 21-parameter panel, quality switch, cinematic
// controls, hotkey legend. Pure DOM, styled by css/hud.css. All parameter
// edits flow out through onParam(id, value); the HUD never touches uniforms.
// All visible copy goes through STRINGS (js/i18n.js); setLang re-renders.

import { STRINGS } from './i18n.js';

export const DEBUG_NAMES = STRINGS.en.debugNames; // legacy export (tests)

const PARAM_ORDER = [
  'p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10',
  'p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'p17', 'p18', 'p19', 'p20', 'p21',
];
// extension params live in their own AESTHETICS group at the panel bottom
const EXT_ORDER = ['tintIn', 'tintOut', 'diskH'];

function fmt(v) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && a < 0.001) return v.toExponential(1);
  if (a < 1) return String(+v.toFixed(3));
  if (a < 100) return String(+v.toFixed(2));
  return String(Math.round(v));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class HUD {
  constructor(hooks) {
    this.h = hooks;
    this.lang = hooks.lang || 'en';
    this.collapsed = false;
    this.rows = {};
    this.debugView = 0;
    this.quality = 'high';
    this.playing = false;
    this.shotLabel = '';

    const root = el('div', 'hud-root');
    document.body.appendChild(root);
    this.root = root;

    // ---- top-left status
    const tl = el('div', 'hud-topleft panel');
    this.titleEl = el('div', 'hud-title');
    tl.appendChild(this.titleEl);
    const statLine = el('div', 'hud-stats');
    this.fpsEl = el('span', 'hud-stat', '— FPS');
    this.qualEl = el('span', 'hud-stat');
    this.presetEl = el('span', 'hud-stat hud-accent');
    this.dynEl = el('span', 'hud-stat hud-warn');
    this.dynEl.style.display = 'none';
    this.audioEl = el('span', 'hud-stat');
    this.langBtn = el('button', 'hud-btn hud-lang-btn', '中/EN');
    this.langBtn.addEventListener('click', () => this.h.onLangToggle());
    statLine.append(this.fpsEl, this.qualEl, this.presetEl, this.dynEl,
      this.audioEl, this.langBtn);
    tl.appendChild(statLine);
    root.appendChild(tl);

    // ---- debug view badge (top-right)
    this.badgeEl = el('div', 'hud-badge panel');
    root.appendChild(this.badgeEl);

    // ---- cinematic bar (top-center)
    const cine = el('div', 'hud-cine panel');
    this.cineName = el('span', 'hud-stat');
    this.cineState = el('span', 'hud-stat hud-accent', '⏸');
    const phaseWrap = el('div', 'hud-phase');
    this.phaseEl = el('div', 'hud-phase-fill');
    phaseWrap.appendChild(this.phaseEl);
    cine.append(this.cineName, this.cineState, phaseWrap);
    root.appendChild(cine);

    // ---- parameter panel (right)
    const panel = el('div', 'hud-panel panel');
    this.panel = panel;

    this.headQuality = el('div', 'hud-heading');
    panel.appendChild(this.headQuality);
    const qrow = el('div', 'hud-qrow');
    this.qBtns = {};
    for (const q of ['standard', 'high', 'cinematic']) {
      const b = el('button', 'hud-btn');
      b.addEventListener('click', () => this.h.onQuality(q));
      qrow.appendChild(b);
      this.qBtns[q] = b;
    }
    panel.appendChild(qrow);

    this.headCine = el('div', 'hud-heading');
    panel.appendChild(this.headCine);
    const crow = el('div', 'hud-qrow');
    this.playBtn = el('button', 'hud-btn');
    this.playBtn.addEventListener('click', () => this.h.onPlayToggle());
    this.shotBtn = el('button', 'hud-btn');
    this.shotBtn.addEventListener('click', () => this.h.onShotToggle());
    crow.append(this.playBtn, this.shotBtn);
    panel.appendChild(crow);

    this.headPreset = el('div', 'hud-heading');
    panel.appendChild(this.headPreset);
    const prow = el('div', 'hud-qrow');
    this.pBtns = {};
    for (const p of ['P1', 'P2', 'P3', 'P4']) {
      const b = el('button', 'hud-btn', p);
      b.addEventListener('click', () => this.h.onPreset(p));
      prow.appendChild(b);
      this.pBtns[p] = b;
    }
    this.saveBtn = el('button', 'hud-btn hud-btn-accent');
    this.saveBtn.addEventListener('click', () => this.h.onSavePreset());
    prow.appendChild(this.saveBtn);
    panel.appendChild(prow);

    this.headParams = el('div', 'hud-heading');
    panel.appendChild(this.headParams);
    for (const id of PARAM_ORDER) panel.appendChild(this._paramRow(id));

    this.headAes = el('div', 'hud-heading');
    panel.appendChild(this.headAes);
    for (const id of EXT_ORDER) panel.appendChild(this._paramRow(id));

    root.appendChild(panel);

    // ---- legend (bottom)
    this.legendEl = el('div', 'hud-legend panel');
    root.appendChild(this.legendEl);

    this.collapsibles = [panel, this.legendEl, cine];
    this.refreshLang();
  }

  get S() { return STRINGS[this.lang]; }

  _paramRow(id) {
    const spec = this.h.params[id] || (this.h.extParams || {})[id];
    const row = el('div', 'hud-row');
    const label = el('label', 'hud-label');
    row.appendChild(label);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = spec.min;
    slider.max = spec.max;
    slider.step = spec.step || (spec.max - spec.min) / 200;
    slider.value = spec.value;
    slider.addEventListener('input', () => {
      this.h.onParam(id, parseFloat(slider.value));
    });

    const val = document.createElement('input');
    val.className = 'hud-value';
    val.value = fmt(spec.value);
    val.readOnly = true;
    val.spellcheck = false;
    val.addEventListener('dblclick', () => {
      val.readOnly = false;
      val.classList.add('editing');
      val.select();
    });
    const commit = () => {
      if (val.readOnly) return;
      val.readOnly = true;
      val.classList.remove('editing');
      const v = parseFloat(val.value);
      if (isFinite(v)) this.h.onParam(id, v);
      else val.value = fmt(spec.value);
    };
    val.addEventListener('blur', commit);
    val.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { commit(); val.blur(); }
      if (e.key === 'Escape') { val.readOnly = true; val.value = fmt(spec.value); }
      e.stopPropagation();
    });

    row.append(slider, val);
    this.rows[id] = { slider, val, label };
    return row;
  }

  // ---------------------------------------------------------- language
  setLang(lang) {
    this.lang = STRINGS[lang] ? lang : 'en';
    this.refreshLang();
  }

  refreshLang() {
    const S = this.S;
    this.root.classList.toggle('lang-zh', this.lang === 'zh');
    this.titleEl.textContent = S.title;
    this.langBtn.textContent = S.langBtn;
    this.langBtn.title = S.langTip;
    this.headQuality.textContent = S.headings.quality;
    this.headCine.textContent = S.headings.cinematic;
    this.headPreset.textContent = S.headings.preset;
    this.headParams.textContent = S.headings.parameters;
    this.headAes.textContent = S.headings.aesthetics || 'AESTHETICS';
    for (const q in this.qBtns) this.qBtns[q].textContent = S.qualities[q];
    this.shotBtn.textContent = S.shotAB;
    this.saveBtn.textContent = S.save;
    this.saveBtn.title = S.saveTip;
    this.playBtn.textContent = this.playing ? S.pause : S.play;
    for (const id of PARAM_ORDER) {
      this.rows[id].label.textContent = `${id} · ${S.params[id]}`.toUpperCase();
      this.rows[id].val.title = S.valueTip;
    }
    for (const id of EXT_ORDER) {
      this.rows[id].label.textContent = String(S.params[id] || id).toUpperCase();
      this.rows[id].val.title = S.valueTip;
    }
    // legend rebuild
    this.legendEl.textContent = '';
    for (const [k, v] of S.legend) {
      const item = el('span', 'hud-key-item');
      item.appendChild(el('span', 'hud-key', k));
      item.appendChild(el('span', 'hud-key-desc', v));
      this.legendEl.appendChild(item);
    }
    // re-render dynamic bits in the new language
    this.setDebug(this.debugView);
    this.setQuality(this.quality);
    this.setPreset(this._presetName);
    this.setPhase(this._phase || 0, this.shotLabel, this.playing);
    this.setAudio(this._audioKey || 'audioOff');
    this.setFps(this._fps || 0);
    if (this._dynScale) this.setDynRes(this._dynScale);
  }

  // ---------------------------------------------------------- updates
  refreshParam(id) {
    const r = this.rows[id];
    if (!r) return;
    const spec = this.h.params[id] || (this.h.extParams || {})[id];
    const v = spec.value;
    r.slider.value = v;
    if (r.val.readOnly) r.val.value = fmt(v);
  }

  refreshAll() {
    for (const id of PARAM_ORDER) this.refreshParam(id);
    for (const id of EXT_ORDER) this.refreshParam(id);
  }

  setFps(f) {
    this._fps = f;
    this.fpsEl.textContent = `${f.toFixed(0)} ${this.S.fpsSuffix}`;
  }

  setQuality(q) {
    this.quality = q;
    this.qualEl.textContent = this.S.qualities[q] || q.toUpperCase();
    for (const k in this.qBtns) this.qBtns[k].classList.toggle('active', k === q);
  }

  setDebug(v) {
    this.debugView = v;
    this.badgeEl.textContent =
      `${this.S.viewPrefix} ${v} · ${this.S.debugNames[v] || '?'}`;
  }

  setPreset(name) {
    this._presetName = name;
    this.presetEl.textContent = name || this.S.custom;
    for (const k in this.pBtns) this.pBtns[k].classList.toggle('active', k === name);
  }

  // shotLabel is the raw "A"/"B" id; display name localized here
  setPhase(phase, shotId, playing) {
    this._phase = phase;
    this.playing = playing;
    const idx = shotId === 'B' ? 1 : 0;
    this.shotLabel = shotId;
    this.cineName.textContent =
      `${this.S.shotPrefix} ${shotId} · ${this.S.shotNames[idx]}`;
    this.cineState.textContent = playing ? '⏵' : '⏸';
    this.playBtn.textContent = playing ? this.S.pause : this.S.play;
    this.phaseEl.style.width = `${(phase * 100).toFixed(1)}%`;
  }

  setDynRes(scale) {
    this._dynScale = scale;
    if (scale && scale < 1) {
      this.dynEl.style.display = '';
      this.dynEl.textContent = `${this.S.dynresPrefix} ×${scale.toFixed(1)}`;
    } else {
      this.dynEl.style.display = 'none';
    }
  }

  setAudio(key) {
    this._audioKey = key;
    this.audioEl.textContent = this.S[key] || key;
  }

  toggle() {
    this.collapsed = !this.collapsed;
    for (const e of this.collapsibles) e.style.display = this.collapsed ? 'none' : '';
    return this.collapsed;
  }
}
