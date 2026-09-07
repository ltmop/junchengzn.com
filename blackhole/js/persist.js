// localStorage persistence, key 'gargantua.v1'.
// Shape: {
//   params:   { p01..p21: number },
//   presets:  { P1..P4: { p01, p02 } },     // user overrides of factory presets
//   quality:  'standard'|'high'|'cinematic',
//   volume:   0..1,
//   audio:    true|false,                   // false = never create AudioContext
//   debugView: 0..9,
//   orbit:    number                        // last non-zero p03 for K toggle
// }

const KEY = 'gargantua.v1';

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const s = JSON.parse(raw);
    return (s && typeof s === 'object') ? s : {};
  } catch {
    return {};
  }
}

let timer = null;
export function saveState(state, immediate = false) {
  const write = () => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  };
  if (immediate) {
    if (timer) { clearTimeout(timer); timer = null; }
    write();
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; write(); }, 300); // debounce
}

export function clearState() {
  try { localStorage.removeItem(KEY); } catch {}
}
