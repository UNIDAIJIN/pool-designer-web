// 部屋の立体図(Source/RoomScene.cpp の移植)。
// L / W / H ラベルのドラッグで寸法、音源・聴く位置の点のドラッグで位置を変える

import { Surface } from './model.js';

export const materialStyles = [
  { japanese: 'タイル', colour: '#c2d5ce', pattern: 'grid', spacing: 2.0 },
  { japanese: 'ガラス', colour: '#7dbbc9', pattern: 'vertical', spacing: 4.0 },
  { japanese: 'コンクリート', colour: '#939c9a', pattern: 'horizontal', spacing: 3.0 },
  { japanese: 'しっくい', colour: '#d9d2c3', pattern: 'none', spacing: 0 },
  { japanese: 'レンガ', colour: '#b0675a', pattern: 'horizontal', spacing: 1.2 },
  { japanese: '木パネル', colour: '#b99262', pattern: 'vertical', spacing: 1.2 },
  { japanese: '金属屋根', colour: '#929fae', pattern: 'vertical', spacing: 1.0 },
  { japanese: '吸音デッキ', colour: '#6f7b86', pattern: 'dots', spacing: 1.0 },
  { japanese: '吸音天井板', colour: '#e3e6e1', pattern: 'grid', spacing: 1.2 },
  { japanese: 'カーテン', colour: '#8e3b46', pattern: 'vertical', spacing: 0.8 },
  { japanese: '観客', colour: '#7a6aa8', pattern: 'dots', spacing: 0.9 },
];

const C = {
  ink: '#e9f2f0', muted: '#8da5aa', aqua: '#6bdbc8', gold: '#f4d18c', deepInk: '#142e36', edge: '#c3e8e0',
};
const kEarHeight = 1.6;
const HandleL = 0, HandleW = 1, HandleH = 2, SourceDot = 3, ListenerDot = 4;

function hex(c) { return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); }
function mixColour(a, b, t) {
  const x = hex(a), y = hex(b);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
}
function rgba(c, a) { return `rgba(${hex(c).join(',')},${a})`; }

export class RoomScene {
  constructor(canvas, state, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = state;
    this.onChange = onChange;
    this.selectedSurface = -1;
    this.wavePhase = 0;
    this.dragTarget = -1;
    this.hoverTarget = -1;

    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.pointerUp(e));
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  projection() {
    const s = this.state;
    const p = { l: s.length, w: s.width, h: s.height };
    const narrow = this.width < 480;
    const sideRoom = narrow ? 90 : 170;
    p.s = Math.min((this.width - sideRoom) / (0.866 * (p.l + p.w)), (this.height - 80) / (0.38 * (p.l + p.w) + p.h));
    p.origin = { x: this.width / 2 - (p.l - p.w) * 0.866 * p.s / 2, y: 30 + p.h * p.s };
    p.point = (x, y, z = 0) => ({ x: p.origin.x + (x - y) * 0.866 * p.s, y: p.origin.y + (x + y) * 0.38 * p.s - z * p.s });
    p.unproject = (pt, z) => {
      const u = (pt.x - p.origin.x) / (0.866 * p.s);
      const v = (pt.y - p.origin.y + z * p.s) / (0.38 * p.s);
      return { x: 0.5 * (u + v), y: 0.5 * (v - u) };
    };
    return p;
  }

  // ラベルが画面からはみ出さないように寄せる
  handlePosition(g, id) {
    const p = this.rawHandlePosition(g, id);
    return { x: Math.min(this.width - 42, Math.max(42, p.x)), y: Math.min(this.height - 15, Math.max(15, p.y)) };
  }

  rawHandlePosition(g, id) {
    const narrow = this.width < 480;
    if (id === HandleL) {
      const q = g.point(g.l * 0.56, g.w);
      return { x: q.x + 15, y: q.y + 26 };
    }
    const q = g.point(0, g.w * 0.58);
    const w = { x: q.x - (narrow ? 34 : 50), y: q.y + 26 };
    if (id === HandleW) return w;
    const p = g.point(0, g.w, g.h * 0.68);
    return { x: p.x - (narrow ? 30 : 40), y: Math.min(p.y - 9, w.y - 40) }; // 低く広い部屋でも H を掴めるように
  }

  // 掴む点は床の上。耳の高さは描画でだけ示す
  sourcePoint(g) { return g.point(this.state.sourceX * g.l, this.state.sourceY * g.w); }
  listenerPoint(g) { return g.point(this.state.listenerX * g.l, this.state.listenerY * g.w); }

  quad(a, b, c, d) {
    const path = new Path2D();
    path.moveTo(a.x, a.y); path.lineTo(b.x, b.y); path.lineTo(c.x, c.y); path.lineTo(d.x, d.y);
    path.closePath();
    return path;
  }

  line(a, b, colour, width, dashed = false) {
    const g = this.ctx;
    g.save();
    g.strokeStyle = colour;
    g.lineWidth = width;
    if (dashed) g.setLineDash([4, 5]);
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    g.restore();
  }

  // 原点 p0 と辺 u, v で張られる面を、その面の素材の色と模様で塗る
  drawSurface(pr, p0, u, v, surface, shade) {
    const g = this.ctx;
    const sf = this.state.surfaces[surface];
    const style = materialStyles[sf.materialA];
    const colour = mixColour(style.colour, materialStyles[sf.materialB].colour, sf.mixB);
    const at = (a, b) => pr.point(p0[0] + u[0] * a + v[0] * b, p0[1] + u[1] * a + v[1] * b, p0[2] + u[2] * a + v[2] * b);
    const path = this.quad(at(0, 0), at(1, 0), at(1, 1), at(0, 1));
    g.fillStyle = colour;
    g.fill(path);
    g.fillStyle = rgba(C.deepInk, shade);
    g.fill(path);
    if (style.pattern === 'none') return;

    // 模様は実寸(m)に結びつけ、細かすぎるときだけ間引く
    let spacing = style.spacing;
    while (spacing * pr.s < 6) spacing *= 2;
    const lu = Math.hypot(...u), lv = Math.hypot(...v);
    g.save();
    g.clip(path);
    if (style.pattern === 'dots') {
      g.fillStyle = rgba(C.deepInk, 0.45);
      for (let a = spacing * 0.5; a < lu; a += spacing)
        for (let b = spacing * 0.5; b < lv; b += spacing) {
          const p = at(a / lu, b / lv);
          g.beginPath(); g.arc(p.x, p.y, 1, 0, Math.PI * 2); g.fill();
        }
      g.restore();
      return;
    }
    const ink = rgba(C.deepInk, 0.28);
    if (style.pattern === 'grid' || style.pattern === 'vertical')
      for (let a = spacing; a < lu; a += spacing) this.line(at(a / lu, 0), at(a / lu, 1), ink, 0.7);
    if (style.pattern === 'grid' || style.pattern === 'horizontal')
      for (let b = spacing; b < lv; b += spacing) this.line(at(0, b / lv), at(1, b / lv), ink, 0.7);
    g.restore();
  }

  draw() {
    const g = this.ctx;
    const s = this.state;
    g.clearRect(0, 0, this.width, this.height);
    if (this.width <= 0) return;
    const pr = this.projection();
    const L = pr.l, W = pr.w, H = pr.h;
    const deck = Math.min(Math.max(0, s.deckWidth), Math.min(L, W) / 2 - 0.5);

    const a = pr.point(0, 0), b = pr.point(L, 0), c = pr.point(L, W), d = pr.point(0, W);
    const at0 = pr.point(0, 0, H), bt = pr.point(L, 0, H), ct = pr.point(L, W, H), dt = pr.point(0, W, H);

    // 奥の2面(x=0 と y=0)と床。手前の2面と天井は切り取って見せる
    this.drawSurface(pr, [0, 0, 0], [0, W, 0], [0, 0, H], Surface.WallLeft, 0.25);
    this.drawSurface(pr, [0, 0, 0], [L, 0, 0], [0, 0, H], Surface.WallFront, 0.12);
    this.drawSurface(pr, [0, 0, 0], [L, 0, 0], [0, W, 0], Surface.Deck, 0.2);

    // 水面
    {
      const w0 = pr.point(deck, deck), w1 = pr.point(L - deck, deck);
      const w2 = pr.point(L - deck, W - deck), w3 = pr.point(deck, W - deck);
      const water = this.quad(w0, w1, w2, w3);
      g.save();
      g.clip(water);
      const xs = [w0.x, w1.x, w2.x, w3.x], ys = [w0.y, w1.y, w2.y, w3.y];
      const grad = g.createLinearGradient(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
      grad.addColorStop(0, '#2f9fa3');
      grad.addColorStop(1, '#0b6b85');
      g.fillStyle = grad;
      g.fill(water);

      const waves = Math.min(1, Math.max(0, s.waveHeight / 10));
      const wl = L - 2 * deck, ww = W - 2 * deck;
      for (let row = 1; row < 13; ++row) {
        g.beginPath();
        for (let i = 0; i <= 55; ++i) {
          const x = deck + wl * i / 55;
          const y = deck + ww * (row / 13 + (0.006 + 0.012 * waves) * Math.sin(i * 0.38 + row + this.wavePhase));
          const p = pr.point(x, y, 0.025);
          if (i === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y);
        }
        g.strokeStyle = `rgba(189,245,229,${row % 3 === 0 ? 0.38 : 0.17})`;
        g.lineWidth = row % 3 === 0 ? 1.5 : 0.7;
        g.stroke();
      }
      g.restore();
    }

    // 部屋の輪郭
    for (const [p, q] of [[at0, bt], [at0, dt], [at0, a], [bt, b], [dt, d], [b, c], [c, d]])
      this.line(p, q, rgba(C.edge, 0.65), 1.2);
    this.line(bt, ct, rgba(C.edge, 0.25), 1, true);
    this.line(dt, ct, rgba(C.edge, 0.25), 1, true);
    this.line(ct, c, rgba(C.edge, 0.22), 1, true);

    // 選択中の面
    const outline = (path, cutaway) => {
      g.save();
      if (cutaway) {
        g.fillStyle = rgba(C.aqua, 0.10);
        g.fill(path);
        g.setLineDash([5, 4]);
        g.strokeStyle = rgba(C.aqua, 0.9);
        g.lineWidth = 1.6;
      } else {
        g.strokeStyle = C.aqua;
        g.lineWidth = 2.2;
      }
      g.stroke(path);
      g.restore();
    };
    switch (this.selectedSurface) {
      case Surface.Deck: outline(this.quad(a, b, c, d), false); break;
      case Surface.Ceiling: outline(this.quad(at0, bt, ct, dt), true); break;
      case Surface.WallFront: outline(this.quad(at0, bt, b, a), false); break;
      case Surface.WallLeft: outline(this.quad(at0, dt, d, a), false); break;
      case Surface.WallBack: outline(this.quad(dt, ct, c, d), true); break;
      case Surface.WallRight: outline(this.quad(bt, ct, c, b), true); break;
      default: break;
    }

    // 音源・聴く位置と、水面での1次反射の経路(DSP と同じ幾何)
    const sx = s.sourceX * L, sy = s.sourceY * W, lx = s.listenerX * L, ly = s.listenerY * W;
    const ear = Math.min(kEarHeight, H - 0.1);
    const srcFloor = this.sourcePoint(pr), lstFloor = this.listenerPoint(pr);
    const src = pr.point(sx, sy, ear), lst = pr.point(lx, ly, ear);
    this.line(srcFloor, src, rgba(C.gold, 0.55), 1.2);
    this.line(lstFloor, lst, rgba(C.aqua, 0.55), 1.2);
    for (const [p, col] of [[src, C.gold], [lst, C.aqua]]) {
      g.fillStyle = col;
      g.beginPath(); g.arc(p.x, p.y, 2.5, 0, Math.PI * 2); g.fill();
    }
    this.line(src, lst, 'rgba(255,255,255,0.18)', 1, true);
    {
      const rx = 0.5 * (sx + lx), ry = 0.5 * (sy + ly);
      if (rx >= deck && rx <= L - deck && ry >= deck && ry <= W - deck) {
        const r = pr.point(rx, ry);
        this.line(src, r, rgba(C.gold, 0.85), 1.1, true);
        this.line(r, lst, rgba(C.gold, 0.85), 1.1, true);
        g.fillStyle = 'rgba(255,255,255,0.7)';
        g.beginPath(); g.arc(r.x, r.y, 2, 0, Math.PI * 2); g.fill();
      }
    }
    const dot = (p, colour, label, hot) => {
      g.fillStyle = 'rgba(13,32,40,0.8)';
      g.beginPath(); g.arc(p.x, p.y, 8, 0, Math.PI * 2); g.fill();
      if (hot) {
        g.strokeStyle = rgba(colour, 0.6);
        g.lineWidth = 1.5;
        g.beginPath(); g.arc(p.x, p.y, 10, 0, Math.PI * 2); g.stroke();
      }
      g.fillStyle = colour;
      g.beginPath(); g.arc(p.x, p.y, 3.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = C.ink;
      g.font = 'bold 10px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, p.x, p.y + 17);
    };
    dot(srcFloor, C.gold, '音源', this.dragTarget === SourceDot || this.hoverTarget === SourceDot);
    dot(lstFloor, C.aqua, '聴く位置', this.dragTarget === ListenerDot || this.hoverTarget === ListenerDot);

    // 寸法ラベル
    const names = ['L', 'W', 'H'], values = [L, W, H];
    for (let id = HandleL; id <= HandleH; ++id) {
      const p = this.handlePosition(pr, id);
      const hot = this.dragTarget === id || this.hoverTarget === id;
      g.beginPath();
      g.roundRect(p.x - 40, p.y - 13, 80, 26, 13);
      g.fillStyle = hot ? '#285751' : '#172f36';
      g.fill();
      g.strokeStyle = hot ? C.ink : '#4c8d86';
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = C.aqua;
      g.font = 'bold 12px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(`${names[id]}  ${values[id].toFixed(1)} m`, p.x, p.y + 0.5);
    }
  }

  targetAt(p) {
    const pr = this.projection();
    const near = (q, r) => Math.hypot(p.x - q.x, p.y - q.y) < r;
    const touch = this.lastPointerType === 'touch' ? 18 : 11;
    if (near(this.sourcePoint(pr), touch)) return SourceDot;
    if (near(this.listenerPoint(pr), touch)) return ListenerDot;
    for (let id = HandleL; id <= HandleH; ++id) {
      const h = this.handlePosition(pr, id);
      if (p.x >= h.x - 42 && p.x <= h.x + 42 && p.y >= h.y - 15 && p.y <= h.y + 15) return id;
    }
    return -1;
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  pointerMove(e) {
    this.lastPointerType = e.pointerType;
    if (this.dragTarget >= 0) { this.drag(e); return; }
    const t = this.targetAt(this.pos(e));
    if (t !== this.hoverTarget) {
      this.hoverTarget = t;
      this.canvas.style.cursor = t < 0 ? 'default' : t === HandleH ? 'ns-resize' : 'grab';
      this.draw();
    }
  }

  pointerDown(e) {
    this.lastPointerType = e.pointerType;
    const p = this.pos(e);
    this.dragTarget = this.targetAt(p);
    if (this.dragTarget < 0) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.dragOrigin = p;
    const keys = ['length', 'width', 'height'];
    if (this.dragTarget <= HandleH) this.dragStart = this.state[keys[this.dragTarget]];
    this.draw();
  }

  drag(e) {
    const pr = this.projection();
    const p = this.pos(e);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    if (this.dragTarget <= HandleH) {
      const dx = p.x - this.dragOrigin.x, dy = p.y - this.dragOrigin.y;
      const delta = this.dragTarget === HandleH
        ? -dy / pr.s
        : ((this.dragTarget === HandleL ? 0.866 : -0.866) * dx + 0.38 * dy) / ((0.866 * 0.866 + 0.38 * 0.38) * pr.s);
      const [key, lo, hi] = [['length', 5, 100], ['width', 4, 60], ['height', 2.5, 30]][this.dragTarget];
      this.state[key] = clamp(Math.round((this.dragStart + delta) * 2) / 2, lo, hi);
      this.onChange(true);
    } else {
      const q = pr.unproject(p, 0);
      const isSource = this.dragTarget === SourceDot;
      this.state[isSource ? 'sourceX' : 'listenerX'] = clamp(Math.round(q.x / pr.l * 100) / 100, 0, 1);
      this.state[isSource ? 'sourceY' : 'listenerY'] = clamp(Math.round(q.y / pr.w * 100) / 100, 0, 1);
      this.onChange(true);
    }
    this.draw();
  }

  pointerUp() {
    if (this.dragTarget < 0) return;
    this.dragTarget = -1;
    this.draw();
  }
}
