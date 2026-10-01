import { NumMaterials, kNumBands } from './model.js';
import { presets, defaultState, applyPreset, roomSpecOf } from './presets.js';
import { RoomScene, materialStyles } from './scene.js';
import { PoolAudio } from './audio.js';

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const kStorageKey = 'pool-designer-web-v1';

//==============================================================================
// 状態(ブラウザに保存して次回も同じ部屋から始める)

const state = defaultState();
let presetIndex = 0;
let detailMode = false;
let bypass = false; // 原音と聴き比べ中
try {
  const saved = JSON.parse(localStorage.getItem(kStorageKey) || 'null');
  if (saved && saved.state) {
    Object.assign(state, saved.state);
    presetIndex = saved.preset ?? 0;
    detailMode = !!saved.detail;
  }
} catch { /* 保存できない環境では毎回既定値 */ }

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(kStorageKey, JSON.stringify({ state, preset: presetIndex, detail: detailMode }));
    } catch { /* 無視 */ }
  }, 300);
}

//==============================================================================
// パラメータ(Source/Parameters.h と同じ範囲)

// JUCE の NormalisableRange::setSkewForCentre と同じ写像
function range(min, max, step, centre) {
  const skew = centre === undefined ? 1 : Math.log(0.5) / Math.log((centre - min) / (max - min));
  return {
    min, max, step,
    from01: (p) => {
      const v = min + (max - min) * Math.exp(Math.log(Math.max(1e-9, p)) / skew);
      return Math.min(max, Math.max(min, Math.round(v / step) * step));
    },
    to01: (v) => Math.pow((Math.min(max, Math.max(min, v)) - min) / (max - min), skew),
  };
}

const pct = (v) => `${Math.round(v * 100)} %`;
const paramDefs = [
  { key: 'length', range: range(5, 100, 0.1, 30), fmt: (v) => `${v.toFixed(1)} m`, title: '部屋の長さ / LENGTH', room: true },
  { key: 'width', range: range(4, 60, 0.1, 18), fmt: (v) => `${v.toFixed(1)} m`, title: '部屋の幅 / WIDTH', room: true },
  { key: 'height', range: range(2.5, 30, 0.1, 7), fmt: (v) => `${v.toFixed(1)} m`, title: '天井の高さ / HEIGHT', room: true },
  { key: 'deckWidth', range: range(0, 10, 0.1), fmt: (v) => `${v.toFixed(1)} m`, title: 'プールサイドの幅 / DECK', room: true },
  { key: 'scattering', range: range(0, 1, 0.01), fmt: pct, basic: '壁の凹凸 / SCATTERING', title: '壁の凹凸(散乱)/ SCATTERING', room: true },
  { key: 'temperatureC', range: range(15, 35, 0.5), fmt: (v) => `${v.toFixed(1)} °C`, title: '気温 / AIR TEMP', room: true },
  { key: 'humidity', range: range(20, 100, 1), fmt: (v) => `${Math.round(v)} %`, title: '湿度 / HUMIDITY', room: true },
  { key: 'waveHeight', range: range(0, 20, 0.1), fmt: (v) => `${v.toFixed(1)} cm`, basic: '水面の揺れ / WAVES', title: '波の高さ / WAVE HEIGHT' },
  { key: 'waveSpeed', range: range(0.05, 3, 0.01, 0.5), fmt: (v) => `${v.toFixed(2)} Hz`, title: '揺れの速さ / WAVE SPEED' },
  { key: 'predelayMs', range: range(0, 200, 1), fmt: (v) => `${Math.round(v)} ms`, title: 'プリディレイ / PRE-DELAY', room: true },
  { key: 'lowCut', range: range(20, 1000, 1, 150), fmt: (v) => (v <= 20.5 ? 'Off' : `${Math.round(v)} Hz`), title: 'ローカット / LOW CUT' },
  { key: 'mix', range: range(0, 1, 0.01), fmt: pct, basic: '原音と響き / MIX', title: '原音と響き / MIX' },
  { key: 'output', range: range(-24, 12, 0.1), fmt: (v) => `${v.toFixed(1)} dB`, basic: '出力 / OUTPUT', title: '出力 / OUTPUT' },
];
const defaults = defaultState();

const sliders = new Map();
function setFill(input) { input.style.setProperty('--fill', `${input.value / input.max * 100}%`); }

for (const d of paramDefs) {
  const row = document.createElement('div');
  row.className = 'param' + (d.basic ? '' : ' advanced');
  const id = `p-${d.key}`;
  row.innerHTML = `<label for="${id}"></label><output for="${id}"></output>
    <input id="${id}" type="range" min="0" max="1000" step="1">`;
  const label = row.querySelector('label'), out = row.querySelector('output'), input = row.querySelector('input');
  input.addEventListener('input', () => {
    state[d.key] = d.range.from01(input.value / 1000);
    out.textContent = d.fmt(state[d.key]);
    setFill(input);
    changed(d.room);
  });
  // ダブルクリックで既定値
  input.addEventListener('dblclick', () => {
    state[d.key] = defaults[d.key];
    syncControls();
    changed(d.room);
  });
  $('params').append(row);
  sliders.set(d.key, { d, row, label, out, input });
}

//==============================================================================
// 面・素材

const kSurfaceOrder = [0, 1, 2, 3, 4, 5]; // Deck, Ceiling, WallFront, WallBack, WallLeft, WallRight
const kSurfaceLabels = ['床(プールサイド)', '天井', '長い壁・奥', '長い壁・手前', '短い壁・奥', '短い壁・手前'];
let selectedSurface = 0;

const surfaceTabs = kSurfaceOrder.map((surface, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tab';
  b.role = 'tab';
  b.textContent = kSurfaceLabels[i];
  b.title = kSurfaceLabels[i];
  b.addEventListener('click', () => { selectedSurface = surface; refresh(); });
  $('surfaceTabs').append(b);
  return b;
});

const materialChips = [];
for (let m = 0; m < NumMaterials; ++m) {
  const st = materialStyles[m];
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'material';
  const sw = document.createElement('span');
  sw.className = 'swatch';
  sw.style.background = swatchBackground(st);
  b.append(sw, st.japanese);
  b.addEventListener('click', () => {
    if (detailMode) {
      state.surfaces[selectedSurface].materialA = m;
    } else {
      for (const s of state.surfaces) { s.materialA = m; s.mixB = 0; }
    }
    changed(true);
  });
  $('materials').append(b);
  materialChips.push(b);
  const opt = document.createElement('option');
  opt.value = m;
  opt.textContent = st.japanese;
  $('materialB').append(opt);
}

function swatchBackground(st) {
  const ink = 'rgba(20,46,54,0.3)';
  const lines = {
    vertical: `repeating-linear-gradient(90deg, transparent 0 7px, ${ink} 7px 8px)`,
    horizontal: `linear-gradient(transparent 5px, ${ink} 5px 6px, transparent 6px)`,
    grid: `repeating-linear-gradient(90deg, transparent 0 7px, ${ink} 7px 8px), linear-gradient(transparent 5px, ${ink} 5px 6px, transparent 6px)`,
    dots: `radial-gradient(circle at 3px 6px, ${ink} 1px, transparent 1.5px) 0 0 / 6px 12px`,
    none: '',
  }[st.pattern];
  return [lines, st.colour].filter(Boolean).join(', ');
}

$('materialB').addEventListener('change', (e) => {
  state.surfaces[selectedSurface].materialB = +e.target.value;
  changed(true);
});
$('mixB').addEventListener('input', (e) => {
  state.surfaces[selectedSurface].mixB = +e.target.value;
  changed(true);
});

function uniformMaterial() {
  let m = -1;
  for (const s of state.surfaces) {
    if (s.mixB > 0 || (m >= 0 && s.materialA !== m)) return -1;
    m = s.materialA;
  }
  return m;
}

//==============================================================================
// プリセット・詳細表示

presets.forEach((p, i) => {
  const opt = document.createElement('option');
  opt.value = i;
  opt.textContent = p.label;
  $('preset').append(opt);
});
$('preset').addEventListener('change', (e) => {
  presetIndex = +e.target.value;
  applyPreset(state, presetIndex);
  changed(true);
});

$('detailToggle').addEventListener('click', () => {
  detailMode = !detailMode;
  refresh();
  save();
  scene.resize();
});

//==============================================================================
// 表示の同期

const scene = new RoomScene($('scene'), state, (room) => changed(room));

function syncControls() {
  for (const { d, label, out, input } of sliders.values()) {
    input.value = Math.round(d.range.to01(state[d.key]) * 1000);
    out.textContent = d.fmt(state[d.key]);
    label.textContent = detailMode || !d.basic ? d.title : d.basic;
    setFill(input);
  }
}

function refresh() {
  app.classList.toggle('detail', detailMode);
  $('detailToggle').setAttribute('aria-pressed', String(detailMode));
  $('detailToggle').textContent = detailMode ? '詳細を閉じる' : '詳細設定';
  $('preset').value = String(presetIndex);

  surfaceTabs.forEach((t, i) => t.setAttribute('aria-selected', String(kSurfaceOrder[i] === selectedSurface)));
  const current = detailMode ? state.surfaces[selectedSurface].materialA : uniformMaterial();
  materialChips.forEach((c, m) => c.setAttribute('aria-pressed', String(m === current)));
  $('materialTitle').textContent = detailMode ? '素材 / MATERIAL' : '素材 / MATERIAL ― すべての面';
  $('customNote').hidden = detailMode || current >= 0;

  const sf = state.surfaces[selectedSurface];
  $('materialB').value = String(sf.materialB);
  $('mixB').value = String(sf.mixB);
  $('mixBValue').textContent = `${Math.round(sf.mixB * 100)} %`;
  $('mixB').style.setProperty('--fill', `${sf.mixB * 100}%`);

  $('roomSize').textContent = `${state.length.toFixed(1)} × ${state.width.toFixed(1)} × ${state.height.toFixed(1)} m · ${Math.round(state.length * state.width * state.height).toLocaleString()} m³`;
  scene.selectedSurface = detailMode ? selectedSurface : -1;
  syncControls();
  scene.draw();
}

//==============================================================================
// IR の再計算(操作が落ち着いてから Worker で)

const worker = new Worker(new URL('./ir-worker.js', import.meta.url), { type: 'module' });
let renderId = 0, busy = false, dirty = true, renderTimer = 0, stats = null, renderedRate = 0;
let firstResult = true;

function requestRender(delay = 120) {
  dirty = true;
  updateState();
  clearTimeout(renderTimer);
  renderTimer = setTimeout(startRender, delay);
}

function startRender() {
  if (busy || !dirty) return;
  dirty = false;
  busy = true;
  renderedRate = audio.sampleRate;
  worker.postMessage({ id: ++renderId, spec: roomSpecOf(state), sampleRate: renderedRate });
  updateState();
}

worker.onmessage = (e) => {
  busy = false;
  const { result } = e.data;
  stats = result.stats;
  if (renderedRate === audio.sampleRate) {
    audio.setResult(result, firstResult);
    firstResult = false;
  } else {
    dirty = true; // 計算中にサンプルレートが決まった
  }
  if (dirty) startRender();
  updateState();
  drawChart();
};
worker.onerror = (e) => {
  busy = false;
  setStatus(`響きの計算に失敗しました: ${e.message}`, 'error');
};

function updateState() {
  const updating = busy || dirty;
  $('figState').textContent = updating ? '計算中…' : stats ? `反映済み ${Math.round(stats.renderMs)} ms` : '–';
  if (!stats) return;
  const rtMid = 0.5 * (stats.rtMeasured[2] + stats.rtMeasured[3]);
  $('figRt').textContent = `${rtMid.toFixed(2)} s`;
  $('figCd').textContent = `${stats.criticalDistance.toFixed(1)} m`;
  $('figDist').textContent = `${stats.directDistance.toFixed(1)} m`;
  drawChart(updating);
}

function changed(room) {
  refresh();
  audio.setParams({ ...state, bypass });
  if (room) requestRender();
  save();
}

//==============================================================================
// 残響時間のグラフ

const chart = $('rtChart');
function drawChart(updating = busy || dirty) {
  const dpr = window.devicePixelRatio || 1;
  const w = chart.clientWidth, h = chart.clientHeight;
  if (chart.width !== Math.round(w * dpr)) { chart.width = Math.round(w * dpr); chart.height = Math.round(h * dpr); }
  const g = chart.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!stats) return;

  let maxRt = 2;
  for (let b = 0; b < kNumBands; ++b) maxRt = Math.max(maxRt, stats.rtMeasured[b], stats.rtEyring[b]);
  maxRt = Math.ceil(maxRt);
  const names = ['125', '250', '500', '1k', '2k', '4k', '8k'];
  const top = 8, bottom = h - 14, colW = w / kNumBands;
  const bar = Math.min(24, colW * 0.4);
  g.font = 'bold 10px system-ui, sans-serif';
  for (let b = 0; b < kNumBands; ++b) {
    const cx = colW * (b + 0.5);
    const sim = stats.rtMeasured[b], ey = stats.rtEyring[b];
    const yS = bottom - (bottom - top) * sim / maxRt;
    const yE = bottom - (bottom - top) * ey / maxRt;
    g.fillStyle = '#243b42';
    g.beginPath(); g.roundRect(cx - bar / 2, top, bar, bottom - top, 3); g.fill();
    g.fillStyle = updating ? 'rgba(107,219,200,0.35)' : 'rgba(107,219,200,0.9)';
    g.beginPath(); g.roundRect(cx - bar / 2, yS, bar, bottom - yS, 3); g.fill();
    g.strokeStyle = '#f4d18c'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(cx - bar / 2 - 5, yE); g.lineTo(cx + bar / 2 + 5, yE); g.stroke();
    g.fillStyle = '#e9f2f0'; g.textAlign = 'left'; g.textBaseline = 'middle';
    if (colW > 50) g.fillText(sim.toFixed(1), cx + bar / 2 + 3, Math.max(top + 6, yS + 5));
    g.fillStyle = '#8da5aa'; g.textAlign = 'center'; g.font = '9px system-ui, sans-serif';
    g.fillText(names[b], cx, h - 5);
    g.font = 'bold 10px system-ui, sans-serif';
  }
}
new ResizeObserver(() => drawChart()).observe(chart);

//==============================================================================
// 入力

const audio = new PoolAudio();
const sourceButtons = { tab: $('srcTab'), file: $('srcFile'), mic: $('srcMic'), demo: $('srcDemo') };
let currentSource = null;

function setStatus(text, kind = '') {
  const s = $('status');
  s.textContent = text;
  s.className = 'status' + (kind ? ` ${kind}` : '');
}

function setSource(kind) {
  currentSource = kind;
  for (const [k, b] of Object.entries(sourceButtons)) b.classList.toggle('on', k === kind);
  $('srcStop').disabled = !kind;
}

// AudioContext を作った後、サンプルレートが IR と違えば計算し直す
async function startAudio() {
  await audio.init();
  audio.setParams({ ...state, bypass }, true);
  if (renderedRate !== audio.sampleRate) { firstResult = true; requestRender(0); }
}

async function run(kind, fn) {
  try {
    await startAudio();
    const label = await fn();
    setSource(kind);
    return label;
  } catch (err) {
    console.error(err);
    if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') setStatus('キャンセルされました。もう一度選んでください', 'error');
    else if (err?.message === 'no-audio') setStatus('タブの音声が共有されていません。共有ダイアログで「タブの音声も共有」をオンにしてください', 'error');
    else setStatus(`入力を開けませんでした(${err?.name || err})`, 'error');
    return null;
  }
}

audio.onSourceEnded = () => { setSource(null); setStatus('共有が終了しました'); };

$('srcTab').addEventListener('click', async () => {
  const label = await run('tab', () => audio.useTab());
  if (label !== null) setStatus(`タブの音を取り込み中${label ? `: ${label}` : ''}`, 'live');
});
$('srcMic').addEventListener('click', async () => {
  const label = await run('mic', () => audio.useMic());
  if (label !== null) setStatus(`マイク${label ? `: ${label}` : ''}(ハウリングに注意。ヘッドホン推奨)`, 'live');
});
$('srcDemo').addEventListener('click', async () => {
  const r = await run('demo', () => audio.useDemo());
  if (r !== null) setStatus('デモ音を再生中', 'live');
});
$('srcFile').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const r = await run('file', () => audio.useFile(file));
  if (r !== null) setStatus(`再生中: ${file.name}`, 'live');
});
// ファイルのドラッグ&ドロップ
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files || [])].find((f) => /^(audio|video)\//.test(f.type));
  if (!file) return;
  const r = await run('file', () => audio.useFile(file));
  if (r !== null) setStatus(`再生中: ${file.name}`, 'live');
});
$('srcStop').addEventListener('click', () => {
  audio.disconnectSource();
  setSource(null);
  setStatus('停止しました');
});

// YouTube を隣のタブで開く(URL でなければ検索語として扱う)
$('ytForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('ytUrl').value.trim();
  let url = 'https://www.youtube.com/';
  if (text) {
    try {
      const u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
      url = /(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname) ? u.href : `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`;
    } catch {
      url = `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`;
    }
  }
  window.open(url, '_blank', 'noopener');
  setStatus('YouTube で再生を始めたら「タブの音を取り込む」を押してください');
});

// 原音と聴き比べ
function setBypass(on) {
  bypass = on;
  $('bypass').setAttribute('aria-pressed', String(on));
  audio.setParams({ ...state, bypass });
}
$('bypass').addEventListener('click', () => setBypass(!bypass));
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  const t = e.target;
  if (t instanceof HTMLInputElement && t.type !== 'range') return;
  if (t instanceof HTMLButtonElement || t instanceof HTMLSelectElement) return;
  e.preventDefault();
  setBypass(!bypass);
});

// タブの音の取り込みは デスクトップの Chromium 系だけ
const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const chromium = !!navigator.userAgentData?.brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand));
if (!navigator.mediaDevices?.getDisplayMedia || mobile) {
  $('srcTab').disabled = true;
  $('browserNote').hidden = false;
} else if (!chromium) {
  $('browserNote').hidden = false;
}

//==============================================================================
// アニメーション(水面とメーター)

let wavePhase = 0, lastFrame = 0;
function frame(t) {
  requestAnimationFrame(frame);
  if (t - lastFrame < 1000 / 30) return;
  const dt = lastFrame ? Math.min(0.1, (t - lastFrame) / 1000) : 0;
  lastFrame = t;
  if (state.waveHeight > 0 && !document.hidden) {
    // プラグイン版(15 Hz で 0.05 + 0.25 × 速さ)と同じ見た目の速さ
    wavePhase += (0.05 + 0.25 * state.waveSpeed) * 15 * dt;
    scene.wavePhase = wavePhase;
    scene.draw();
  }
  const db = audio.level();
  const fill = $('meterFill');
  fill.style.width = `${Math.max(0, Math.min(100, (db + 60) / 60 * 100))}%`;
  fill.classList.toggle('hot', db > -3);
}
requestAnimationFrame(frame);

refresh();
requestRender(0);

// デバッグ用(ブラウザのコンソールから触れるように)
window.poolDesigner = { audio, state };
