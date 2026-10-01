import { Material as M, NumSurfaces } from './model.js';

const s = (materialA, materialB = materialA, mixB = 0) => ({ materialA, materialB, mixB });

function makeSpec(L, W, H, deck, deckS, ceiling, front, back, sides, sx, sy, lx, ly) {
  // 面の並びは Deck, Ceiling, WallFront, WallBack, WallLeft, WallRight
  return {
    length: L, width: W, height: H, deckWidth: deck,
    surfaces: [deckS, ceiling, front, back, { ...sides }, { ...sides }],
    sourceX: sx, sourceY: sy, listenerX: lx, listenerY: ly,
  };
}

// 0 番がデフォルト
export const presets = [
  { name: 'School 25m', label: '学校の25mプール',
    spec: makeSpec(30, 18, 7, 2.5, s(M.Tile), s(M.MetalRoof, M.PerforatedDeck, 0.3),
      s(M.Tile, M.Glass, 0.6), s(M.Tile), s(M.Tile, M.Concrete, 0.5), 0.10, 0.17, 0.67, 0.67) },
  { name: 'Hotel Pool', label: 'ホテルのプール',
    spec: makeSpec(15, 8, 3.5, 2.0, s(M.Tile), s(M.Plaster, M.AcousticTile, 0.3),
      s(M.Tile, M.Glass, 0.5), s(M.Tile), s(M.Tile, M.Plaster, 0.4), 0.23, 0.25, 0.73, 0.75) },
  { name: 'Olympic 50m', label: 'オリンピック50mプール',
    spec: makeSpec(64, 34, 12, 5.0, s(M.Tile), s(M.MetalRoof, M.PerforatedDeck, 0.4),
      s(M.Concrete, M.Glass, 0.7), s(M.Concrete), s(M.Concrete, M.Glass, 0.3), 0.125, 0.15, 0.625, 0.735) },
];

// パラメータの既定値(Source/Parameters.h と同じ)
export function defaultState() {
  const p = presets[0].spec;
  return {
    length: p.length, width: p.width, height: p.height, deckWidth: p.deckWidth,
    surfaces: p.surfaces.map((x) => ({ ...x })),
    scattering: 0.3, temperatureC: 30, humidity: 60,
    sourceX: p.sourceX, sourceY: p.sourceY, listenerX: p.listenerX, listenerY: p.listenerY,
    predelayMs: 0,
    waveHeight: 2.0, waveSpeed: 0.4, lowCut: 20, mix: 1.0, output: 0,
  };
}

export function applyPreset(state, index) {
  const p = presets[index].spec;
  Object.assign(state, {
    length: p.length, width: p.width, height: p.height, deckWidth: p.deckWidth,
    surfaces: p.surfaces.map((x) => ({ ...x })),
    sourceX: p.sourceX, sourceY: p.sourceY, listenerX: p.listenerX, listenerY: p.listenerY,
  });
  // Parameters.h の既定値に合わせる(プリセットは散乱・気温・湿度も既定に戻す)
  Object.assign(state, { scattering: 0.3, temperatureC: 30, humidity: 60 });
}

export function roomSpecOf(state) {
  return {
    length: state.length, width: state.width, height: state.height, deckWidth: state.deckWidth,
    surfaces: state.surfaces.slice(0, NumSurfaces).map((x) => ({ ...x })),
    scattering: state.scattering, temperatureC: state.temperatureC, humidity: state.humidity,
    sourceX: state.sourceX, sourceY: state.sourceY, listenerX: state.listenerX, listenerY: state.listenerY,
    predelayMs: state.predelayMs,
  };
}
