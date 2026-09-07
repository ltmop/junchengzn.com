// Entry point — stage 2: full interaction layer.
// Owns: PARAMS registry (p01..p21), presets P1..P4 (+localStorage overrides),
// keyboard, camera/OrbitControls bridging, cinematic shots, audio, HUD,
// dynamic-resolution fallback, persistence + URL injection, shot interface.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Pipeline, QUALITY } from './pipeline.js';
import { HUD, DEBUG_NAMES } from './hud.js';
import { Cinematic, SHOTS } from './cinematic.js';
import { AudioPad } from './audio.js';
import { loadState, saveState } from './persist.js';
import { STRINGS, detectLang } from './i18n.js';

// ------------------------------------------------------- parameter registry
export const PARAMS = {
  p01: { label: 'cam dist',   value: 12.0,  min: 3.2,  max: 60 },
  p02: { label: 'incline',    value: 78.0,  min: 0,    max: 89.9 },
  p03: { label: 'auto orb',   value: 0.0,   min: -30,  max: 30 },
  p04: { label: 'disk in',    value: 3.0,   min: 2.5,  max: 6 },
  p05: { label: 'disk out',   value: 14.0,  min: 6,    max: 40 },
  p06: { label: 'disk temp',  value: 5200,  min: 1500, max: 25000 },
  p07: { label: 'turb amp',   value: 0.8,   min: 0,    max: 1 },
  p08: { label: 'turb scale', value: 1.0,   min: 0.1,  max: 5 },
  p09: { label: 'turb flow',  value: 0.35,  min: 0,    max: 2 },
  p10: { label: 'doppler k',  value: 3.0,   min: 0,    max: 4 },
  p11: { label: 'redshift',   value: 1.0,   min: 0,    max: 1 },
  p12: { label: 'min step',   value: 2e-3,  min: 5e-5, max: 0.05 },
  p13: { label: 'max step',   value: 0.3,   min: 0.05, max: 2 },
  p14: { label: 'max cross',  value: 3,     min: 0,    max: 8, step: 1 },
  p15: { label: 'exposure',   value: 0.0,   min: -2,   max: 4 },
  p16: { label: 'bloom str',  value: 1.0,   min: 0,    max: 3 },
  p17: { label: 'bloom rad',  value: 0.9,   min: 0.2,  max: 2.5 },
  p18: { label: 'grain',      value: 0.06,  min: 0,    max: 0.5 },
  p19: { label: 'chroma',     value: 0.004, min: 0,    max: 0.02 },
  p20: { label: 'vignette',   value: 0.45,  min: 0,    max: 1 },
  p21: { label: 'saturate',   value: 1.05,  min: 0,    max: 2 },
};

const PRESETS = {
  P1: { p01: 10,   p02: 8  },   // face-on
  P2: { p01: 9,    p02: 86 },   // edge-on / interstellar
  P3: { p01: 5.2,  p02: 80 },   // photon-ring close-up
  P4: { p01: 26,   p02: 58 },   // wide panorama
};

// Extension params — aesthetic layer, deliberately outside p01..p21.
// tintIn/tintOut: radial temperature stretch (inner blue-white / outer dark
// red, the Interstellar grade). diskH: disk scale height h/r (0 = thin plane).
export const EXT_PARAMS = {
  tintIn:  { label: 'inner tint', value: 2.4,  min: 0.5, max: 4.0 },
  tintOut: { label: 'outer tint', value: 0.78, min: 0.2, max: 1.5 },
  diskH:   { label: 'disk thick', value: 0.08, min: 0.0, max: 0.3 },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ------------------------------------------------------------- persistence
const saved = loadState();
const presetOverrides = (saved.presets && typeof saved.presets === 'object')
  ? saved.presets : {};
let audioEnabled = saved.audio !== false;
let audioVolume = typeof saved.volume === 'number' ? saved.volume : 0.5;
let lastOrbit = typeof saved.orbit === 'number' && saved.orbit !== 0
  ? saved.orbit : 6;

if (saved.params && typeof saved.params === 'object') {
  for (const id of Object.keys(PARAMS)) {
    const v = saved.params[id];
    if (typeof v === 'number' && isFinite(v)) {
      PARAMS[id].value = clamp(v, PARAMS[id].min, PARAMS[id].max);
    }
  }
}
if (saved.ext && typeof saved.ext === 'object') {
  for (const id of Object.keys(EXT_PARAMS)) {
    const v = saved.ext[id];
    if (typeof v === 'number' && isFinite(v)) {
      EXT_PARAMS[id].value = clamp(v, EXT_PARAMS[id].min, EXT_PARAMS[id].max);
    }
  }
}

// ------------------------------------------------------------- URL injection
// Priority: URL > localStorage > defaults. Supports p01..p21 directly,
// legacy aliases r0/theta, preset, debug, quality, audio, shot, w, h, name.
const url = new URLSearchParams(location.search);
if (url.has('r0') && !url.has('p01')) url.set('p01', url.get('r0'));
if (url.has('theta') && !url.has('p02')) url.set('p02', url.get('theta'));
for (const id of Object.keys(PARAMS)) {
  if (url.has(id)) {
    const v = parseFloat(url.get(id));
    if (isFinite(v)) PARAMS[id].value = clamp(v, PARAMS[id].min, PARAMS[id].max);
  }
}
for (const id of Object.keys(EXT_PARAMS)) {
  if (url.has(id)) {
    const v = parseFloat(url.get(id));
    if (isFinite(v)) EXT_PARAMS[id].value =
      clamp(v, EXT_PARAMS[id].min, EXT_PARAMS[id].max);
  }
}
let debugView = 0;
if (typeof saved.debugView === 'number') {
  debugView = clamp(Math.round(saved.debugView), 0, 9);
}
if (url.has('debug')) {
  const v = parseInt(url.get('debug'), 10);
  if (isFinite(v)) debugView = clamp(v, 0, 9);
}
let qualityName = QUALITY[saved.quality] ? saved.quality : 'high';
if (url.has('quality') && QUALITY[url.get('quality')]) {
  qualityName = url.get('quality');
}
if (url.get('audio') === 'off') audioEnabled = false;
if (url.get('audio') === 'on') audioEnabled = true;

// language: URL > localStorage > navigator
let lang = detectLang();
if (saved.lang && STRINGS[saved.lang]) lang = saved.lang;
if (url.has('lang') && STRINGS[url.get('lang')]) lang = url.get('lang');

const shotMode = url.get('shot') === '1';
const shotW = clamp(parseInt(url.get('w'), 10) || 1280, 64, 4096);
const shotH = clamp(parseInt(url.get('h'), 10) || 720, 64, 4096);
const shotName = url.get('name') || null;

// ------------------------------------------------------------- bg mode
// ?bg=1: website-background mode — HUD hidden, OrbitControls disabled,
// audio off, slow auto-orbit (4°/s unless overridden), DPR cap tightened
// to 1.5, dynamic resolution left on. Mouse parallax arrives either from
// this window's mousemove (renderer used directly as a page background)
// or via postMessage {type:'gargantua:parallax', nx, ny} (iframe embed).
const bgMode = url.get('bg') === '1';
if (bgMode) {
  audioEnabled = false;
  if (!url.has('p03') && !(saved.params && typeof saved.params.p03 === 'number'
      && saved.params.p03 !== 0)) {
    PARAMS.p03.value = 4;              // slow drift by default
  }
}
let plxTX = 0, plxTY = 0;              // parallax targets [-1, 1]
let plxX = 0, plxY = 0;                // spring-smoothed values
let plxAppliedX = 0, plxAppliedY = 0;  // deltas already applied to camera
if (bgMode) {
  window.addEventListener('mousemove', (e) => {
    plxTX = (e.clientX / Math.max(window.innerWidth, 1)) * 2 - 1;
    plxTY = (e.clientY / Math.max(window.innerHeight, 1)) * 2 - 1;
  });
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.type === 'gargantua:parallax'
        && isFinite(d.nx) && isFinite(d.ny)) {
      plxTX = clamp(d.nx, -1, 1);
      plxTY = clamp(d.ny, -1, 1);
    }
  });
}

// ------------------------------------------------------------- renderer
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, alpha: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: true,   // verification + shot interface
});
renderer.autoClear = false;

const pipeline = new Pipeline(renderer, PARAMS, EXT_PARAMS);
pipeline.setQuality(qualityName);
pipeline.debugView = debugView;

// ------------------------------------------------------------- camera (z-up)
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);
controls.minDistance = 3.2;
controls.maxDistance = 60;

let syncingFromCode = false;
let currentPreset = null;

function applyCamera(r0, thetaDeg, phiDeg, syncControls = true) {
  const th = (clamp(thetaDeg, 0, 89.9) * Math.PI) / 180;
  const ph = (phiDeg * Math.PI) / 180;
  syncingFromCode = true;
  camera.position.set(
    r0 * Math.sin(th) * Math.cos(ph),
    r0 * Math.sin(th) * Math.sin(ph),
    r0 * Math.cos(th));
  camera.lookAt(controls.target);
  if (syncControls) controls.update();
  syncingFromCode = false;
}

function cameraPhi() {
  return (Math.atan2(camera.position.y, camera.position.x) * 180) / Math.PI;
}

// apply current p01/p02 keeping the live azimuth
function placeCamera(phiDeg = 0) {
  applyCamera(PARAMS.p01.value, PARAMS.p02.value, phiDeg);
}
// NOTE: initial placeCamera(0) happens after `cinematic` and `hud` exist
// (the OrbitControls 'change' listener references them).

// user orbiting writes back into p01/p02 so HUD and params stay truthful
controls.addEventListener('change', () => {
  if (syncingFromCode || cinematic.playing) return;
  const p = camera.position;
  const r = p.length();
  if (r < 1e-6) return;
  PARAMS.p01.value = clamp(r, PARAMS.p01.min, PARAMS.p01.max);
  PARAMS.p02.value = clamp(
    (Math.acos(clamp(p.z / r, -1, 1)) * 180) / Math.PI, 0, 89.9);
  currentPreset = null;
  hud.refreshParam('p01');
  hud.refreshParam('p02');
  hud.setPreset(null);
  markDirty();
});

function orbitAzimuth(dphiDeg) {
  const a = (dphiDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const p = camera.position;
  syncingFromCode = true;
  const x = p.x * c - p.y * s;
  p.y = p.x * s + p.y * c;
  p.x = x;
  camera.lookAt(controls.target);
  syncingFromCode = false;
}

// tilt the camera's polar angle by rotating the position around the
// horizontal axis (used for bg-mode parallax)
function orbitIncline(dThetaDeg) {
  const p = camera.position;
  const axis = new THREE.Vector3(0, 0, 1).cross(p);
  if (axis.lengthSq() < 1e-9) return;
  syncingFromCode = true;
  p.applyAxisAngle(axis.normalize(), (dThetaDeg * Math.PI) / 180);
  camera.lookAt(controls.target);
  syncingFromCode = false;
}

// ------------------------------------------------------------- presets
function applyPreset(name) {
  const src = presetOverrides[name] || PRESETS[name];
  if (!src) return;
  PARAMS.p01.value = clamp(src.p01, PARAMS.p01.min, PARAMS.p01.max);
  PARAMS.p02.value = clamp(src.p02, PARAMS.p02.min, PARAMS.p02.max);
  currentPreset = name;
  placeCamera(0);
  hud.refreshParam('p01');
  hud.refreshParam('p02');
  hud.setPreset(name);
  markDirty();
}

function savePreset() {
  if (!currentPreset) return;
  presetOverrides[currentPreset] = {
    p01: PARAMS.p01.value, p02: PARAMS.p02.value,
  };
  markDirty();
}

function resetPreset() {
  if (!currentPreset) return;
  const src = presetOverrides[currentPreset] || PRESETS[currentPreset];
  PARAMS.p01.value = clamp(src.p01, PARAMS.p01.min, PARAMS.p01.max);
  PARAMS.p02.value = clamp(src.p02, PARAMS.p02.min, PARAMS.p02.max);
  placeCamera(0);
  hud.refreshParam('p01');
  hud.refreshParam('p02');
  markDirty();
}

// ------------------------------------------------------------- params
function setParam(id, v, { camUpdate = true } = {}) {
  const spec = PARAMS[id];
  if (!spec || !isFinite(v)) return;
  v = clamp(v, spec.min, spec.max);
  if (spec.step === 1) v = Math.round(v);
  spec.value = v;
  pipeline.invalidate();           // parameter change breaks TAA history
  if ((id === 'p01' || id === 'p02') && camUpdate && !cinematic.playing) {
    applyCamera(PARAMS.p01.value, PARAMS.p02.value, cameraPhi());
  }
  hud.refreshParam(id);
  markDirty();
}

// extension (aesthetic) params — same flow, no camera coupling
function setExtParam(id, v) {
  const spec = EXT_PARAMS[id];
  if (!spec || !isFinite(v)) return;
  spec.value = clamp(v, spec.min, spec.max);
  pipeline.invalidate();
  hud.refreshParam(id);
  markDirty();
}

// ------------------------------------------------------------- cinematic
const cinematic = new Cinematic((r, theta, phi) => {
  applyCamera(r, theta, phi, false);   // bypass OrbitControls while playing
});
// play()/pause() are the single source of truth — direct calls (console,
// automation) and HUD/keyboard all funnel through onStateChange.
cinematic.onStateChange = (playing) => {
  controls.enabled = !playing;
  pipeline.invalidate();
  hud.setPhase(cinematic.phase, cinematic.shot.id, playing);
};

function setCinematicPlaying(playing) {
  if (playing === cinematic.playing) return;
  if (playing) cinematic.play(); else cinematic.pause();
}

// ------------------------------------------------------------- audio
const audio = new AudioPad({ enabled: audioEnabled, volume: audioVolume });
const startAudioOnce = () => { audio.start(); };
if (audioEnabled) {
  window.addEventListener('pointerdown', startAudioOnce, { once: true });
  window.addEventListener('keydown', startAudioOnce, { once: true });
}
function audioStatusKey() {
  if (!audio.enabled) return 'audioOff';
  if (audio.muted) return 'muted';
  return audio.created ? 'audioOn' : 'audioArmed';
}

// ------------------------------------------------------------- HUD
const hud = new HUD({
  params: PARAMS,
  extParams: EXT_PARAMS,
  lang,
  onParam: (id, v) => {
    if (PARAMS[id]) setParam(id, v); else setExtParam(id, v);
  },
  onQuality: (q) => setQuality(q),
  onPreset: (p) => { setCinematicPlaying(false); applyPreset(p); },
  onShotToggle: () => {
    cinematic.toggleShot();
    pipeline.invalidate();
    hud.setPhase(cinematic.phase, cinematic.shot.id, cinematic.playing);
  },
  onPlayToggle: () => setCinematicPlaying(!cinematic.playing),
  onSavePreset: () => savePreset(),
  onLangToggle: () => setLang(lang === 'zh' ? 'en' : 'zh'),
});
hud.refreshAll();
hud.setQuality(qualityName);
hud.setDebug(debugView);
hud.setPreset(currentPreset);
hud.setAudio(audioStatusKey());
hud.setPhase(0, cinematic.shot.id, false);

// bg mode: pure background — no HUD, no user orbiting, tighter DPR cap
if (bgMode) {
  hud.root.style.display = 'none';
  controls.enabled = false;
  pipeline.bgDprCap = 1.5;
}

function setLang(l) {
  if (!STRINGS[l]) return;
  lang = l;
  hud.setLang(l);
  markDirty();
}

function setQuality(q) {
  if (!QUALITY[q]) return;
  qualityName = q;
  pipeline.setQuality(q);
  hud.setQuality(q);
  markDirty();
}
function setDebugView(v) {
  debugView = clamp(Math.round(v), 0, 9);
  pipeline.debugView = debugView;
  pipeline.invalidate();
  hud.setDebug(debugView);
  markDirty();
}

// ------------------------------------------------------------- persistence
function markDirty() {
  saveState({
    params: Object.fromEntries(
      Object.entries(PARAMS).map(([k, s]) => [k, s.value])),
    ext: Object.fromEntries(
      Object.entries(EXT_PARAMS).map(([k, s]) => [k, s.value])),
    presets: presetOverrides,
    quality: qualityName,
    volume: audio.volume,
    audio: audioEnabled,
    debugView,
    orbit: lastOrbit,
    lang,
  });
}

// ------------------------------------------------------------- keyboard
const held = new Set();
const toggleMemory = { p16: 1.0, p18: 0.06 };

window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  const code = e.code;
  if (code === 'Space') {
    e.preventDefault();
    setCinematicPlaying(!cinematic.playing);
    return;
  }
  if (/^Digit[0-9]$/.test(code)) {
    const n = +code.slice(5);
    if (e.shiftKey && n >= 1 && n <= 4) {
      setCinematicPlaying(false);
      applyPreset(`P${n}`);
    } else {
      setDebugView(n);
    }
    return;
  }
  switch (code) {
    case 'KeyB': {
      if (PARAMS.p16.value > 0) {
        toggleMemory.p16 = PARAMS.p16.value;
        setParam('p16', 0, { camUpdate: false });
      } else setParam('p16', toggleMemory.p16, { camUpdate: false });
      break;
    }
    case 'KeyG': {
      if (PARAMS.p18.value > 0) {
        toggleMemory.p18 = PARAMS.p18.value;
        setParam('p18', 0, { camUpdate: false });
      } else setParam('p18', toggleMemory.p18, { camUpdate: false });
      break;
    }
    case 'KeyF':
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else document.documentElement.requestFullscreen().catch(() => {});
      break;
    case 'KeyM': {
      audio.toggleMuted();
      hud.setAudio(audioStatusKey());
      break;
    }
    case 'KeyL': setLang(lang === 'zh' ? 'en' : 'zh'); break;
    case 'KeyR': resetPreset(); break;
    case 'KeyH': hud.toggle(); break;
    case 'KeyK': {
      if (Math.abs(PARAMS.p03.value) > 1e-9) {
        lastOrbit = PARAMS.p03.value;
        setParam('p03', 0, { camUpdate: false });
      } else {
        setParam('p03', lastOrbit || 6, { camUpdate: false });
      }
      break;
    }
    default: break;
  }
  held.add(code);
});
window.addEventListener('keyup', (e) => held.delete(e.code));
window.addEventListener('blur', () => held.clear());

// held-key continuous actions, called per frame
function applyHeldKeys(dt) {
  if (cinematic.playing) return;
  const rStep = Math.max(0.5, PARAMS.p01.value * 0.35) * dt;
  const tStep = 22 * dt;
  const phiStep = 45 * dt;                 // A/D: direct camera azimuth
  const evStep = 1.2 * dt;
  if (held.has('KeyW')) setParam('p01', PARAMS.p01.value - rStep);
  if (held.has('KeyS')) setParam('p01', PARAMS.p01.value + rStep);
  if (held.has('KeyQ')) setParam('p02', PARAMS.p02.value + tStep);
  if (held.has('KeyE')) setParam('p02', PARAMS.p02.value - tStep);
  if (held.has('ArrowUp')) setParam('p15', PARAMS.p15.value + evStep, { camUpdate: false });
  if (held.has('ArrowDown')) setParam('p15', PARAMS.p15.value - evStep, { camUpdate: false });
  if (held.has('KeyA')) orbitAzimuth(phiStep);
  if (held.has('KeyD')) orbitAzimuth(-phiStep);
}

// ------------------------------------------------------------- URL preset
if (url.has('preset')) applyPreset(url.get('preset').toUpperCase());
else placeCamera(0);

// ------------------------------------------------------------- resize
function resize() {
  // clamp to >=1: a display:none iframe (e.g. an embedder hiding the
  // background on narrow screens) reports innerWidth/Height = 0, which
  // would NaN the aspect and skip RT allocation, crashing render()
  const w = Math.max(1, shotMode ? shotW : window.innerWidth);
  const h = Math.max(1, shotMode ? shotH : window.innerHeight);
  if (shotMode) {
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pipeline.setSize(w, h, shotMode ? 1 : (window.devicePixelRatio || 1));
}
window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------- dynres + fps
const DYNRES_BUDGET = { standard: 33, high: 16.7, cinematic: 120 };
let overFrames = 0, underFrames = 0, warmup = 120;
let fpsEma = 60;
let dynResEnabled = true;
let dynResBudgetOverride = 0;    // >0 forces a budget (perf/dynres testing)

function updateDynRes(dtMs) {
  fpsEma = fpsEma * 0.95 + (1000 / Math.max(dtMs, 1e-3)) * 0.05;
  if (!dynResEnabled) return;
  if (warmup > 0) { warmup--; return; }
  const budget = dynResBudgetOverride > 0
    ? dynResBudgetOverride : DYNRES_BUDGET[pipeline.qualityName];
  if (dtMs > budget) {
    overFrames++; underFrames = 0;
    if (overFrames >= 60 && pipeline.autoScale > 0.4) {
      pipeline.setAutoScale(pipeline.autoScale - 0.1);
      hud.setDynRes(pipeline.autoScale);
      overFrames = 0;
    }
  } else if (dtMs < budget * 0.8) {
    underFrames++; overFrames = 0;
    if (underFrames >= 120 && pipeline.autoScale < 1) {
      pipeline.setAutoScale(pipeline.autoScale + 0.1);
      hud.setDynRes(pipeline.autoScale < 1 ? pipeline.autoScale : null);
      underFrames = 0;
    }
  } else {
    overFrames = 0; underFrames = 0;
  }
}

// ------------------------------------------------------------- shot mode
let shotFrames = 0, shotDone = false;
async function doShot() {
  shotDone = true;
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) return;
  const objUrl = URL.createObjectURL(blob);
  const presetTag = currentPreset || (url.get('preset') || 'custom').toLowerCase();
  const name = shotName || `gargantua-${presetTag}-d${debugView}.png`;

  // mean brightness from a downsized copy (for automated non-black checks)
  let mean = -1;
  try {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = 64; c.height = 36;
    const cx = c.getContext('2d');
    cx.drawImage(bmp, 0, 0, 64, 36);
    const d = cx.getImageData(0, 0, 64, 36).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
    mean = s / (d.length / 4);
  } catch {}

  const dataURL = await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(blob);
  });

  const a = document.createElement('a');
  a.href = objUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();

  window.postMessage({
    type: 'gargantua:shot', url: objUrl, name,
    width: canvas.width, height: canvas.height, mean,
  }, '*');
  window.__gargantua.lastShot = { name, width: canvas.width, height: canvas.height, mean, dataURL };
  setCinematicPlaying(false);   // shot completed -> leave cinematic mode
}

// ------------------------------------------------------------- render loop
const ru = pipeline.rayUniforms;
const clock = new THREE.Clock();
let frames = 0;
const lastCamPos = new THREE.Vector3(1e9, 0, 0);
const lastCamQuat = new THREE.Quaternion();
let camMoved = true;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.25);

  controls.update();
  applyHeldKeys(dt);
  if (!cinematic.playing && Math.abs(PARAMS.p03.value) > 1e-9) {
    orbitAzimuth(PARAMS.p03.value * dt);   // p03 auto-orbit
  }
  // bg-mode mouse parallax: spring-smoothed ±3° azimuth/inclination offset
  if (bgMode) {
    const k = Math.min(1, dt * 2.5);
    plxX += (plxTX - plxX) * k;
    plxY += (plxTY - plxY) * k;
    const dAz = (plxX - plxAppliedX) * 3.0;
    const dIn = (plxY - plxAppliedY) * 3.0;
    if (Math.abs(dAz) > 1e-5) orbitAzimuth(dAz);
    if (Math.abs(dIn) > 1e-5) orbitIncline(dIn);
    plxAppliedX = plxX;
    plxAppliedY = plxY;
  }
  cinematic.update(dt);

  // camera motion invalidates the TAA history (no ghosting while moving)
  if (camMoved || camera.position.distanceToSquared(lastCamPos) > 1e-12
      || Math.abs(camera.quaternion.dot(lastCamQuat)) < 1 - 1e-12) {
    pipeline.invalidate();
    lastCamPos.copy(camera.position);
    lastCamQuat.copy(camera.quaternion);
    camMoved = false;
  }

  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  ru.uCamPos.value.copy(camera.position);
  ru.uCamRight.value.set(e[0], e[1], e[2]);
  ru.uCamUp.value.set(e[4], e[5], e[6]);
  ru.uCamFwd.value.set(-e[8], -e[9], -e[10]);
  ru.uTanHalfFov.value = Math.tan((camera.fov * Math.PI) / 360);
  ru.uAspect.value = camera.aspect;

  const t = clock.getElapsedTime();
  // shot mode: freeze turbulence advection after a short development time so
  // the TAA history actually converges to a sharp frame instead of smearing
  // the (fast-moving, inner-disk) noise field into mud
  pipeline.render(shotMode ? Math.min(t, 0.5) : t, debugView);
  frames++;

  updateDynRes(dt * 1000);
  if (frames % 15 === 0) {
    hud.setFps(fpsEma);
    if (cinematic.playing) {
      hud.setPhase(cinematic.phase, cinematic.shot.id, true);
    }
  }

  // shot interface: fire only after the TAA accumulation has converged
  // (>=40 settled frames — production stills require the full settle)
  if (shotMode && !shotDone && frames >= 3 && pipeline.settledFrames >= 40) {
    doShot();
  }
}
frame();

// ------------------------------------------------------------- test hook
function captureStats() {
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

  const boxMean = (cx, cy, bw, bh, stride = 1) => {
    let sum = 0, n = 0;
    const x0 = Math.max(0, Math.round(cx - bw / 2));
    const y0 = Math.max(0, Math.round(cy - bh / 2));
    const x1 = Math.min(w, Math.round(cx + bw / 2));
    const y1 = Math.min(h, Math.round(cy + bh / 2));
    for (let y = y0; y < y1; y += stride) {
      for (let x = x0; x < x1; x += stride) {
        const i = (y * w + x) * 4;
        sum += (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
        n++;
      }
    }
    return n ? sum / n : 0;
  };

  const side = 0.1 * Math.min(w, h);   // central patch fully inside the shadow
  const center = boxMean(w / 2, h / 2, side, side);
  const frameAvg = boxMean(w / 2, h / 2, w, h, 7);
  const left = boxMean(0.30 * w, 0.5 * h, 0.08 * w, 0.12 * h);
  const right = boxMean(0.70 * w, 0.5 * h, 0.08 * w, 0.12 * h);
  return {
    width: w, height: h, frames,
    quality: pipeline.qualityName,
    halfFloat: pipeline.halfFloat,
    centerAvg: +(center / 255).toFixed(5),
    frameAvg: +(frameAvg / 255).toFixed(5),
    leftAvg: +(left / 255).toFixed(5),
    rightAvg: +(right / 255).toFixed(5),
    diskAsym: +((Math.abs(left - right) / Math.max(left, right, 1e-6))).toFixed(4),
  };
}

window.__gargantua = {
  PARAMS, EXT_PARAMS, pipeline, camera, controls, renderer, cinematic, audio, hud,
  ready: true,
  bgMode,
  webgl2: renderer.getContext() instanceof WebGL2RenderingContext,
  lastShot: null,
  setParam, setExtParam, setQuality, setDebugView, applyPreset, resetPreset, savePreset,
  setLang,
  placeCamera, captureStats,
  debugNames: DEBUG_NAMES,
  shots: SHOTS,
  // perf/dynres test hooks
  setDynResEnabled: (on) => { dynResEnabled = !!on; },
  setDynResBudget: (ms) => { dynResBudgetOverride = ms > 0 ? ms : 0; },
  getAutoScale: () => pipeline.autoScale,
  getSettledFrames: () => pipeline.settledFrames,
};
Object.defineProperty(window.__gargantua, 'params', {
  get: () => Object.fromEntries(
    Object.entries(PARAMS).map(([k, s]) => [k, s.value])),
});
