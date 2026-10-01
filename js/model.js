// Pool Designer の音響モデル(Source/RoomModel.cpp の移植)。
// 直方体の屋内プールを、鏡像法(鏡面反射)+レイトレーシングの diffuse rain(散乱成分)で
// シミュレートし、ステレオのインパルス応答を生成する。重いので Web Worker から呼ぶ。

export const kNumBands = 7;
export const kBandCentres = [125, 250, 500, 1000, 2000, 4000, 8000];
export const kMaxIrSeconds = 6.0;

export const Material = {
  Tile: 0, Glass: 1, Concrete: 2, Plaster: 3, Brick: 4, WoodPanel: 5,
  MetalRoof: 6, PerforatedDeck: 7, AcousticTile: 8, Curtain: 9, Audience: 10,
};
export const NumMaterials = 11;

export const Surface = { Deck: 0, Ceiling: 1, WallFront: 2, WallBack: 3, WallLeft: 4, WallRight: 5 };
export const NumSurfaces = 6;

// 吸音率 125 Hz .. 8 kHz(一般的な文献値の概算。8 kHz は 4 kHz 付近からの外挿)
const kMaterialTable = [
  [0.01, 0.01, 0.01, 0.01, 0.02, 0.02, 0.02],   // Tile(施釉タイル)
  [0.18, 0.06, 0.04, 0.03, 0.02, 0.02, 0.02],   // Glass(大判ガラス)
  [0.10, 0.05, 0.06, 0.07, 0.09, 0.08, 0.08],   // Concrete(塗装)
  [0.013, 0.015, 0.02, 0.03, 0.04, 0.05, 0.05], // Plaster
  [0.03, 0.03, 0.03, 0.04, 0.05, 0.07, 0.07],   // Brick
  [0.28, 0.22, 0.17, 0.09, 0.10, 0.11, 0.11],   // Wood Panel(下地付き合板)
  [0.15, 0.10, 0.08, 0.06, 0.05, 0.05, 0.05],   // Metal Roof(無孔)
  [0.40, 0.70, 0.90, 0.85, 0.70, 0.55, 0.50],   // Perforated Deck(有孔+グラスウール)
  [0.30, 0.35, 0.60, 0.75, 0.70, 0.65, 0.60],   // Acoustic Tile(耐湿吸音板)
  [0.14, 0.35, 0.55, 0.72, 0.70, 0.65, 0.60],   // Curtain(厚手)
  [0.60, 0.74, 0.88, 0.96, 0.93, 0.85, 0.80],   // Audience(着席の人)
].map((a) => Float32Array.from(a));

export const materialNames = [
  'Tile', 'Glass', 'Concrete', 'Plaster', 'Brick', 'Wood Panel',
  'Metal Roof', 'Perforated Deck', 'Acoustic Tile', 'Curtain', 'Audience',
];
export const surfaceNames = ['Deck', 'Ceiling', 'Front Wall', 'Back Wall', 'Left Wall', 'Right Wall'];

const kWater = Float32Array.from([0.008, 0.008, 0.013, 0.015, 0.020, 0.025, 0.025]);
const kWaterScattering = 0.05;

// 頭部による左右のレベル差 [dB](真横から来たときの左右差)
const kIldDb = [0.5, 1.0, 2.0, 4.0, 7.0, 10.0, 12.0];
const kHeadRadius = 0.0875;
const kEarSpacing = 0.18;

const kMaxImages = 1500000; // 鏡像法の計算量の上限
const kNumRays = 6000;
const kBinSeconds = 0.001;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const f32 = Math.fround;

// C++ 版と同じ xorshift64(BigInt は遅いので 32bit ×2 で実装)
class Rng {
  constructor(seed) {
    // s = seed * 0x9E3779B97F4A7C15 + 0x632BE59BD9B4E019 (mod 2^64)
    let s = (BigInt(seed) * 0x9E3779B97F4A7C15n + 0x632BE59BD9B4E019n) & 0xFFFFFFFFFFFFFFFFn;
    this.hi = Number(s >> 32n) >>> 0;
    this.lo = Number(s & 0xFFFFFFFFn) >>> 0;
  }
  next() {
    let hi = this.hi, lo = this.lo;
    // s ^= s << 13
    hi = (hi ^ ((hi << 13) | (lo >>> 19))) >>> 0;
    lo = (lo ^ (lo << 13)) >>> 0;
    // s ^= s >> 7
    lo = (lo ^ ((lo >>> 7) | (hi << 25))) >>> 0;
    hi = (hi ^ (hi >>> 7)) >>> 0;
    // s ^= s << 17
    hi = (hi ^ ((hi << 17) | (lo >>> 15))) >>> 0;
    lo = (lo ^ (lo << 17)) >>> 0;
    this.hi = hi; this.lo = lo;
  }
  uniform() { // [0, 1)、上位 53bit
    this.next();
    return ((this.hi >>> 0) * 2097152 + (this.lo >>> 11)) / 9007199254740992;
  }
  noise() { return (this.uniform() * 2 - 1) * 1.7320508; } // 分散 1
}

// 双二次フィルター(RBJ)。IR 生成時のバンド分割用
function makeBiquad(type, freq, sampleRate) {
  const w = 2 * Math.PI * freq / sampleRate;
  const cw = Math.cos(w), alpha = Math.sin(w) / (2 * 0.7071067811865476);
  const a0 = 1 + alpha;
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
  else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
  else { b0 = 1 - alpha; b1 = -2 * cw; b2 = 1 + alpha; }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: -2 * cw / a0, a2: (1 - alpha) / a0 };
}

function runBiquad(f, data) {
  const { b0, b1, b2, a1, a2 } = f;
  let z1 = 0, z2 = 0;
  for (let i = 0; i < data.length; ++i) {
    const x = data[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    data[i] = y;
  }
}

// Linkwitz-Riley 4次のクロスオーバーで帯域分割(全帯域の和が全域通過になる)
function filterBand(data, band, sampleRate) {
  for (let j = 0; j < kNumBands - 1; ++j) {
    const fc = Math.sqrt(kBandCentres[j] * kBandCentres[j + 1]);
    if (fc >= sampleRate * 0.45) continue;
    if (j < band) {
      runBiquad(makeBiquad('hp', fc, sampleRate), data);
      runBiquad(makeBiquad('hp', fc, sampleRate), data);
    } else if (j === band) {
      runBiquad(makeBiquad('lp', fc, sampleRate), data);
      runBiquad(makeBiquad('lp', fc, sampleRate), data);
    } else {
      runBiquad(makeBiquad('ap', fc, sampleRate), data);
    }
  }
}

// 帯域のエネルギー減衰曲線から T30(取れなければ T20)を求める
function measureRt(a, b, sampleRate) {
  const n = a.length;
  const edc = new Float64Array(n + 1);
  for (let i = n; i-- > 0;) edc[i] = edc[i + 1] + a[i] * a[i] + b[i] * b[i];
  if (edc[0] <= 0) return 0;
  const timeAt = (db) => {
    const target = edc[0] * Math.pow(10, db / 10);
    for (let i = 0; i < n; ++i) if (edc[i] < target) return i / sampleRate;
    return -1;
  };
  const t5 = timeAt(-5), t35 = timeAt(-35);
  if (t5 >= 0 && t35 > t5) return 2 * (t35 - t5);
  const t25 = timeAt(-25);
  if (t5 >= 0 && t25 > t5) return 3 * (t25 - t5);
  return 0;
}

function mixMaterials(s) {
  const a = kMaterialTable[clamp(s.materialA | 0, 0, NumMaterials - 1)];
  const b = kMaterialTable[clamp(s.materialB | 0, 0, NumMaterials - 1)];
  const m = clamp(s.mixB, 0, 1);
  const out = new Float32Array(kNumBands);
  for (let i = 0; i < kNumBands; ++i) out[i] = Math.min(0.99, a[i] * (1 - m) + b[i] * m);
  return out;
}

export function materialAbsorption(m) { return kMaterialTable[clamp(m, 0, NumMaterials - 1)]; }

export function speedOfSound(t) { return 331.3 * Math.sqrt(1 + t / 273.15); }

export function airAbsorptionDbPerMetre(f, tC, rh) {
  // ISO 9613-1
  const pr = 101.325, pa = 101.325;
  const T = tC + 273.15, T0 = 293.15, T01 = 273.16;
  const C = -6.8346 * Math.pow(T01 / T, 1.261) + 4.6151;
  const h = rh * Math.pow(10, C) * (pr / pa);
  const frO = (pa / pr) * (24 + 4.04e4 * h * (0.02 + h) / (0.391 + h));
  const frN = (pa / pr) * Math.pow(T / T0, -0.5)
    * (9 + 280 * h * Math.exp(-4.170 * (Math.pow(T / T0, -1 / 3) - 1)));
  const ff = f * f;
  return 8.686 * ff * (1.84e-11 * (pr / pa) * Math.sqrt(T / T0)
    + Math.pow(T / T0, -2.5) * (0.01275 * Math.exp(-2239.1 / T) / (frO + ff / frO)
      + 0.1068 * Math.exp(-3352.0 / T) / (frN + ff / frN)));
}

export function directOffsetSamples(sampleRate) { return Math.ceil(0.001 * sampleRate); }

// 面の内部番号(z=0 の床は水面/デッキを位置で切り替える)
const FFloor = 0, FCeiling = 1, FFront = 2, FBack = 3, FLeft = 4, FRight = 5, NumFaces = 6;

// spec の形は app.js の defaultSpec() を参照。seed が同じなら結果は決定的
export function renderRoom(spec, sampleRate, seed = 0x5eed) {
  const startTime = performance.now();
  const stats = {
    rtSabine: new Array(kNumBands).fill(0), rtEyring: new Array(kNumBands).fill(0),
    rtFitzroy: new Array(kNumBands).fill(0), rtMeasured: new Array(kNumBands).fill(0),
    volume: 0, surfaceArea: 0, meanFreePath: 0, criticalDistance: 0, directDistance: 0,
    imageCount: 0, rayCount: 0, specularSeconds: 0, irSeconds: 0, renderMs: 0,
  };
  const water = { active: false, delaySamples: [0, 0], gain: [0, 0], pathPerWaveHeight: 0 };

  //==================================================================
  // 幾何
  const L = clamp(spec.length, 3, 200);
  const W = clamp(spec.width, 3, 100);
  const H = clamp(spec.height, 2.2, 40);
  const deck = clamp(spec.deckWidth, 0, Math.min(L, W) / 2 - 0.5);
  const poolX0 = deck, poolX1 = L - deck, poolY0 = deck, poolY1 = W - deck;
  const V = L * W * H;
  const waterArea = (poolX1 - poolX0) * (poolY1 - poolY0);

  const inside = (v, size) => clamp(v, 0.1, size - 0.1);
  const sourceHeight = spec.sourceHeight ?? 1.6, listenerHeight = spec.listenerHeight ?? 1.6;
  const src = { x: inside(spec.sourceX * L, L), y: inside(spec.sourceY * W, W), z: inside(sourceHeight, H) };
  const lst = { x: inside(spec.listenerX * L, L), y: inside(spec.listenerY * W, W), z: inside(listenerHeight, H) };
  if (Math.hypot(lst.x - src.x, lst.y - src.y, lst.z - src.z) < 0.5)
    lst.x = lst.x + (lst.x < L / 2 ? 0.5 : -0.5);

  const c = speedOfSound(spec.temperatureC);
  const d0 = Math.hypot(lst.x - src.x, lst.y - src.y, lst.z - src.z);
  const tDirect = d0 / c;

  // 聴取者は音源の方を向く。右耳方向の単位ベクトル
  let fx = src.x - lst.x, fy = src.y - lst.y;
  const fl = Math.sqrt(fx * fx + fy * fy);
  if (fl < 1e-6) { fx = 0; fy = 1; } else { fx /= fl; fy /= fl; }
  const rightEar = { x: fy, y: -fx };

  //==================================================================
  // 面の特性
  const scatter = clamp(spec.scattering, 0, 1);
  const alpha = new Array(NumFaces);
  const faceScatter = new Float64Array(NumFaces);
  const surfaces = spec.surfaces;
  const deckAlpha = mixMaterials(surfaces[Surface.Deck]);
  alpha[FCeiling] = mixMaterials(surfaces[Surface.Ceiling]);
  alpha[FFront] = mixMaterials(surfaces[Surface.WallFront]);
  alpha[FBack] = mixMaterials(surfaces[Surface.WallBack]);
  alpha[FLeft] = mixMaterials(surfaces[Surface.WallLeft]);
  alpha[FRight] = mixMaterials(surfaces[Surface.WallRight]);
  for (let f = FCeiling; f < NumFaces; ++f) faceScatter[f] = scatter;

  // 鏡像法では床を水面とデッキの面積平均で扱う
  const floorArea = L * W;
  const wFrac = waterArea / floorArea;
  alpha[FFloor] = new Float32Array(kNumBands);
  const floorEnergyRefl = new Float32Array(kNumBands);
  for (let b = 0; b < kNumBands; ++b) {
    alpha[FFloor][b] = wFrac * kWater[b] + (1 - wFrac) * deckAlpha[b];
    floorEnergyRefl[b] = wFrac * (1 - kWater[b]) * (1 - kWaterScattering)
      + (1 - wFrac) * (1 - deckAlpha[b]) * (1 - scatter);
  }
  faceScatter[FFloor] = wFrac * kWaterScattering + (1 - wFrac) * scatter;

  const faceArea = [floorArea, floorArea, L * H, L * H, W * H, W * H];
  const S = 2 * (L * W + L * H + W * H);

  const airM = new Float64Array(kNumBands); // エネルギー減衰係数 [1/m]
  for (let b = 0; b < kNumBands; ++b)
    airM[b] = f32(airAbsorptionDbPerMetre(kBandCentres[b], spec.temperatureC, spec.humidity) / 4.3429448);

  //==================================================================
  // 統計的な残響時間(比較・表示用)
  {
    const k = 24 * Math.log(10) / c;
    const pairs = [[FLeft, FRight], [FFront, FBack], [FFloor, FCeiling]];
    for (let b = 0; b < kNumBands; ++b) {
      let A = 0;
      for (let f = 0; f < NumFaces; ++f) A += faceArea[f] * alpha[f][b];
      const abar = A / S, air = 4 * airM[b] * V;
      stats.rtSabine[b] = k * V / (A + air);
      stats.rtEyring[b] = k * V / (-S * Math.log(1 - abar) + air);
      // Fitzroy: 軸ごと(x / y / z の対になる面)に Eyring を面積加重
      let t = 0;
      for (const p of pairs) {
        const Sa = faceArea[p[0]] + faceArea[p[1]];
        const aa = (faceArea[p[0]] * alpha[p[0]][b] + faceArea[p[1]] * alpha[p[1]][b]) / Sa;
        t += Sa / (-Math.log(1 - aa) + air / S);
      }
      stats.rtFitzroy[b] = k * V / (S * S) * t;
    }
    stats.volume = V;
    stats.surfaceArea = S;
    stats.meanFreePath = 4 * V / S;
    stats.directDistance = d0;
    const rtMid = 0.5 * (stats.rtEyring[2] + stats.rtEyring[3]);
    stats.criticalDistance = 0.057 * Math.sqrt(V / Math.max(0.05, rtMid));
  }

  //==================================================================
  // バッファ
  const offset = directOffsetSamples(sampleRate);
  const predelay = clamp(spec.predelayMs, 0, 200) * 0.001 * sampleRate;
  const N = Math.floor(offset + predelay + Math.ceil(kMaxIrSeconds * sampleRate)) + 4;
  const band = [];
  for (let b = 0; b < kNumBands; ++b) band.push([new Float32Array(N), new Float32Array(N)]);

  // 鏡像法で扱う時間(計算量の上限から決める)
  const rBudget = Math.cbrt(kMaxImages * V * 3 / (4 * Math.PI));
  const tEnd = tDirect + kMaxIrSeconds;
  const tSpec = Math.min(tEnd, rBudget / c);
  const xfade = Math.min(0.02, tSpec * 0.2);
  const specularWeight = (t) => {
    if (t <= tSpec - xfade) return 1;
    if (t >= tSpec) return 0;
    return 0.5 + 0.5 * Math.cos(Math.PI * (t - (tSpec - xfade)) / xfade);
  };
  stats.specularSeconds = tSpec - tDirect;

  // 物理時間 → IR 上のサンプル位置
  const toSample = (t, isDirect) => offset + (t - tDirect) * sampleRate + (isDirect ? 0 : predelay);

  // 左右の耳への振り分け(Woodworth の ITD と帯域ごとの ILD)
  const kLatSteps = 128;
  const ildRight = [], ildLeft = [];
  for (let i = 0; i <= kLatSteps; ++i) {
    const lat = -1 + 2 * i / kLatSteps;
    const r = new Float32Array(kNumBands), l = new Float32Array(kNumBands);
    for (let b = 0; b < kNumBands; ++b) {
      r[b] = Math.pow(10, lat * kIldDb[b] / 40);
      l[b] = Math.pow(10, -lat * kIldDb[b] / 40);
    }
    ildRight.push(r); ildLeft.push(l);
  }
  const itdSeconds = (lat) => {
    const th = Math.asin(clamp(lat, -1, 1));
    return kHeadRadius / c * (th + Math.sin(th)); // 正なら右耳が先
  };

  const place = (buf, pos, value) => {
    if (pos < 0) return;
    const i = Math.floor(pos);
    if (i + 1 >= N) return;
    const frac = pos - i;
    buf[i] += value * (1 - frac);
    buf[i + 1] += value * frac;
  };

  //==================================================================
  // 水面の1次反射(リアルタイムで揺らすので IR からは除く)
  {
    const t = src.z / (src.z + lst.z);
    const rx = src.x + (lst.x - src.x) * t, ry = src.y + (lst.y - src.y) * t;
    if (rx >= poolX0 && rx <= poolX1 && ry >= poolY0 && ry <= poolY1) {
      const vx = src.x - lst.x, vy = src.y - lst.y, vz = -src.z - lst.z;
      const d = Math.hypot(vx, vy, vz);
      const lat = (vx * rightEar.x + vy * rightEar.y) / d;
      const itd = itdSeconds(lat);
      const li = Math.round((lat + 1) * 0.5 * kLatSteps);
      const amp = Math.sqrt((1 - kWater[3]) * (1 - kWaterScattering)) * Math.exp(-airM[4] * d / 2) / d;
      water.active = true;
      const base = toSample(d / c, false);
      water.delaySamples[0] = base + itd * 0.5 * sampleRate;
      water.delaySamples[1] = base - itd * 0.5 * sampleRate;
      water.gain[0] = amp * ildLeft[li][3];
      water.gain[1] = amp * ildRight[li][3];
      water.pathPerWaveHeight = 2 * (src.z + lst.z) / d;
    }
  }

  //==================================================================
  // 鏡像法(鏡面反射成分)
  {
    const rMax = c * tSpec;
    const rMax2 = rMax * rMax;
    const pruneAmp = 1e-4 / d0; // 直接音から -80 dB 以下は捨てる

    const axisImages = (s, size, l) => {
      const v = [];
      const n = Math.ceil(rMax / (2 * size)) + 1;
      for (let m = -n; m <= n; ++m)
        for (let p = 0; p <= 1; ++p) {
          const pos = (p ? -s : s) + 2 * m * size;
          if (Math.abs(pos - l) <= rMax) v.push({ offset: pos - l, cntLow: Math.abs(m - p), cntHigh: Math.abs(m) });
        }
      return v;
    };
    const xs = axisImages(src.x, L, lst.x);
    const ys = axisImages(src.y, W, lst.y);
    const zs = axisImages(src.z, H, lst.z);

    // 面ごとの反射(振幅)の累乗表
    let maxCount = 0;
    for (const v of [xs, ys, zs]) for (const a of v) maxCount = Math.max(maxCount, a.cntLow, a.cntHigh);
    const powTable = [];
    for (let f = 0; f < NumFaces; ++f) {
      const r = new Float32Array(kNumBands);
      for (let b = 0; b < kNumBands; ++b)
        r[b] = f === FFloor ? Math.sqrt(floorEnergyRefl[b]) : Math.sqrt((1 - alpha[f][b]) * (1 - faceScatter[f]));
      const table = [];
      const acc = new Float32Array(kNumBands).fill(1);
      for (let n = 0; n <= maxCount; ++n) {
        table.push(Float32Array.from(acc));
        for (let b = 0; b < kNumBands; ++b) acc[b] *= r[b];
      }
      powTable.push(table);
    }

    // 空気吸収(振幅)の表 0.25 m 刻み
    const airStep = 0.25;
    const airSize = Math.floor(rMax / airStep) + 2;
    const airAmp = [];
    for (let i = 0; i < airSize; ++i) {
      const a = new Float32Array(kNumBands);
      for (let b = 0; b < kNumBands; ++b) a[b] = Math.exp(-airM[b] * i * airStep / 2);
      airAmp.push(a);
    }

    const zOff = Float64Array.from(zs, (z) => z.offset);
    const gxy = new Float32Array(kNumBands), g = new Float32Array(kNumBands);
    const latScale = 0.5 * kLatSteps;
    const halfRate = 0.5 * sampleRate;
    const skipWaterFirst = water.active;
    let count = 0;
    for (const ix of xs) {
      const gx = powTable[FLeft][ix.cntLow];
      const gr = powTable[FRight][ix.cntHigh];
      const xCount = ix.cntLow + ix.cntHigh;
      for (const iy of ys) {
        const dxy2 = ix.offset * ix.offset + iy.offset * iy.offset;
        if (dxy2 > rMax2) continue;
        const gf = powTable[FFront][iy.cntLow];
        const gb = powTable[FBack][iy.cntHigh];
        for (let b = 0; b < kNumBands; ++b) gxy[b] = gx[b] * gr[b] * gf[b] * gb[b];
        const xyCount = xCount + iy.cntLow + iy.cntHigh;
        const latNum = ix.offset * rightEar.x + iy.offset * rightEar.y;

        for (let zi = 0; zi < zs.length; ++zi) {
          const zo = zOff[zi];
          const d2 = dxy2 + zo * zo;
          if (d2 > rMax2) continue;
          const iz = zs[zi];
          const d = Math.max(0.1, Math.sqrt(d2));
          const isDirect = xyCount + iz.cntLow + iz.cntHigh === 0;
          if (skipWaterFirst && iz.cntLow === 1 && iz.cntHigh === 0 && xyCount === 0)
            continue; // 水面の1次反射はリアルタイム側

          const gfl = powTable[FFloor][iz.cntLow];
          const gc = powTable[FCeiling][iz.cntHigh];
          const ga = airAmp[Math.min(airSize - 1, Math.floor(d / airStep))];
          const t = d / c;
          const w = specularWeight(t) / d;
          let gmax = 0;
          for (let b = 0; b < kNumBands; ++b) {
            const v = gxy[b] * gfl[b] * gc[b] * ga[b] * w;
            g[b] = v;
            if (v > gmax) gmax = v;
          }
          if (gmax < pruneAmp) continue;
          ++count;

          const lat = latNum / d;
          const itd = itdSeconds(lat);
          const li = Math.round((lat + 1) * latScale);
          const pos = toSample(t, isDirect);
          const posL = pos + itd * halfRate;
          const posR = pos - itd * halfRate;
          const il = ildLeft[li], ir = ildRight[li];
          for (let b = 0; b < kNumBands; ++b) {
            place(band[b][0], posL, g[b] * il[b]);
            place(band[b][1], posR, g[b] * ir[b]);
          }
        }
      }
    }
    stats.imageCount = count;
  }

  //==================================================================
  // レイトレーシング + diffuse rain(散乱成分と、鏡像法の範囲より後ろ全体)
  const numBins = Math.floor(tEnd / kBinSeconds) + 2;
  const hist = [];
  for (let b = 0; b < kNumBands; ++b) hist.push(new Float64Array(numBins));
  {
    const rng = new Rng(seed);
    const maxDist = c * tEnd;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const stopEnergy = 1e-9 / kNumRays;
    const size = [L, W, H];
    const E = new Float64Array(kNumBands);
    const pos = [0, 0, 0], dir = [0, 0, 0], n = [0, 0, 0];

    for (let r = 0; r < kNumRays; ++r) {
      // フィボナッチ球面で方向を均等に配る
      const zz = 1 - 2 * (r + 0.5) / kNumRays;
      const rad = Math.sqrt(Math.max(0, 1 - zz * zz));
      const ph = golden * r;
      dir[0] = rad * Math.cos(ph); dir[1] = rad * Math.sin(ph); dir[2] = zz;
      pos[0] = src.x; pos[1] = src.y; pos[2] = src.z;
      let travelled = 0;
      E.fill(1 / kNumRays);

      for (let bounce = 0; ; ++bounce) {
        let tMin = Number.MAX_VALUE;
        let axis = 0, high = false;
        for (let a = 0; a < 3; ++a) {
          if (dir[a] > 1e-12) {
            const t = (size[a] - pos[a]) / dir[a];
            if (t < tMin) { tMin = t; axis = a; high = true; }
          } else if (dir[a] < -1e-12) {
            const t = -pos[a] / dir[a];
            if (t < tMin) { tMin = t; axis = a; high = false; }
          }
        }
        travelled += tMin;
        if (travelled > maxDist) break;
        for (let a = 0; a < 3; ++a) pos[a] = clamp(pos[a] + dir[a] * tMin, 0, size[a]);
        pos[axis] = high ? size[axis] : 0;

        let al, sc;
        if (axis === 0) { al = alpha[high ? FRight : FLeft]; sc = scatter; }
        else if (axis === 1) { al = alpha[high ? FBack : FFront]; sc = scatter; }
        else if (high) { al = alpha[FCeiling]; sc = scatter; }
        else {
          const onWater = pos[0] >= poolX0 && pos[0] <= poolX1 && pos[1] >= poolY0 && pos[1] <= poolY1;
          al = onWater ? kWater : deckAlpha;
          sc = onWater ? kWaterScattering : scatter;
        }
        for (let b = 0; b < kNumBands; ++b) E[b] *= 1 - al[b];

        // diffuse rain: 反射点から受音点へ散乱で届く分
        n[0] = n[1] = n[2] = 0;
        n[axis] = high ? -1 : 1;
        const tx = lst.x - pos[0], ty = lst.y - pos[1], tz = lst.z - pos[2];
        const dist = Math.sqrt(tx * tx + ty * ty + tz * tz);
        const cosT = (tx * n[0] + ty * n[1] + tz * n[2]) / Math.max(1e-9, dist);
        if (cosT > 0) {
          const tArr = (travelled + dist) / c;
          const bin = Math.floor(tArr / kBinSeconds);
          if (bin < numBins) {
            // 鏡像法の範囲では散乱分だけ、範囲の後ろは反射全体を拾う
            const k = sc + (1 - sc) * (1 - specularWeight(tArr));
            // 鏡像法の振幅 1/d(エネルギー 1/d²)に単位を揃えるため 4 倍
            const coef = 4 * k * cosT / Math.max(1, dist * dist);
            for (let b = 0; b < kNumBands; ++b) hist[b][bin] += E[b] * coef;
          }
        }

        // 次の方向: 散乱ならランバート、そうでなければ鏡面
        if (rng.uniform() < sc) {
          const u1 = rng.uniform(), u2 = rng.uniform();
          const rr = Math.sqrt(u1), phi = 2 * Math.PI * u2;
          dir[axis] = Math.sqrt(Math.max(0, 1 - u1)) * n[axis];
          dir[(axis + 1) % 3] = rr * Math.cos(phi);
          dir[(axis + 2) % 3] = rr * Math.sin(phi);
        } else {
          dir[axis] = -dir[axis];
        }

        if ((bounce & 7) === 7) {
          let maxE = 0;
          for (let b = 0; b < kNumBands; ++b) maxE = Math.max(maxE, E[b] * Math.exp(-airM[b] * travelled));
          if (maxE < stopEnergy) break;
        }
      }
    }
    stats.rayCount = kNumRays;

    // 空気吸収は総経路長だけで決まるので最後にまとめて掛ける
    for (let b = 0; b < kNumBands; ++b)
      for (let i = 0; i < numBins; ++i) hist[b][i] *= Math.exp(-airM[b] * c * (i + 0.5) * kBinSeconds);
  }

  //==================================================================
  // 拡散成分をノイズで合成(左右の相関は耳間距離の拡散音場コヒーレンスに合わせる)
  {
    const rng = new Rng((seed ^ 0xA5A5A5A5) >>> 0);
    const binSamples = kBinSeconds * sampleRate;
    for (let b = 0; b < kNumBands; ++b) {
      const x = 2 * Math.PI * kBandCentres[b] * kEarSpacing / c;
      const rho = clamp(Math.sin(x) / x, 0, 1);
      const gc = Math.sqrt(rho), gi = Math.sqrt(1 - rho);
      const h = hist[b];
      const outL = band[b][0], outR = band[b][1];
      for (let n = offset; n < N; ++n) {
        const t = tDirect + (n - offset - predelay) / sampleRate;
        if (t < tDirect) continue;
        const fb = t / kBinSeconds - 0.5;
        const i0 = Math.floor(Math.max(0, fb));
        if (i0 + 1 >= numBins) break;
        const fr = clamp(fb - i0, 0, 1);
        const e = h[i0] * (1 - fr) + h[i0 + 1] * fr;
        if (e <= 0) continue;
        const env = Math.sqrt(e / binSamples);
        const common = rng.noise() * gc;
        outL[n] += env * (common + rng.noise() * gi);
        outR[n] += env * (common + rng.noise() * gi);
      }
    }
  }

  //==================================================================
  // 帯域フィルター → 実測 RT → 合成
  for (let b = 0; b < kNumBands; ++b) {
    filterBand(band[b][0], b, sampleRate);
    filterBand(band[b][1], b, sampleRate);
    stats.rtMeasured[b] = measureRt(band[b][0], band[b][1], sampleRate);
  }

  const out = [new Float32Array(N), new Float32Array(N)];
  for (let b = 0; b < kNumBands; ++b)
    for (let ch = 0; ch < 2; ++ch) {
      const src = band[b][ch], dst = out[ch];
      for (let n = 0; n < N; ++n) dst[n] += src[n];
    }

  // -70 dB まで減衰したところで切る
  const edc = new Float64Array(N + 1);
  for (let i = N; i-- > 0;) edc[i] = edc[i + 1] + out[0][i] * out[0][i] + out[1][i] * out[1][i];
  const total = edc[0];
  let end = N;
  for (let i = offset; i < N; ++i) if (edc[i] < total * 1e-7) { end = i; break; }
  const fade = Math.min(end - offset, Math.floor(0.05 * sampleRate));
  for (let i = 0; i < fade; ++i) {
    const gg = 0.5 + 0.5 * Math.cos(Math.PI * (i + 1) / fade);
    out[0][end - fade + i] *= gg;
    out[1][end - fade + i] *= gg;
  }

  // エネルギーで正規化(部屋を変えても広帯域の音量がほぼ揃う)
  const energy = Math.max(1e-20, total / 2);
  const norm = 1 / Math.sqrt(energy);
  const ir = [out[0].slice(0, end), out[1].slice(0, end)];
  for (const chan of ir) for (let i = 0; i < chan.length; ++i) chan[i] *= norm;
  water.gain[0] *= norm;
  water.gain[1] *= norm;

  stats.irSeconds = end / sampleRate;
  stats.renderMs = performance.now() - startTime;
  return { ir, offsetSamples: offset, water, stats };
}
