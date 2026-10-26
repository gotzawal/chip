/** 보조 배선 — Synopsys Custom Compiler 의 routing assistant 처럼: 시작점(핀·배선)을 누르고 커서를 옮기면 그 자리까지
 *  규칙에 맞는 배선이 실시간으로 따라오고, 이 넷의 다른 덩이(핀·배선)에 가까이 가면 클릭 없이 그리로 붙는다 (pin tap).
 *  꺾는 자리마다 클릭하고 층을 고르는 일은 길찾기가 한다. 열린 곳(플라이라인)은 한 번에 이을 수도 있다 (autoConnect).
 *
 *  격자: M1~M4 는 트랙이 한 격자에 맞는다 (세로 층 M1·M3 의 x, 가로 층 M2·M4 의 y — 피치와 원점이 같다). M5 는 피치가 달라
 *  넣지 않는다. 꼭짓점은 (층, i, j) — 층의 방향으로만 이웃 꼭짓점으로 가고, 같은 (i, j) 에서 위·아래 층으로 비아.
 *
 *  막힘은 세상 도형(다른 넷·블록·전원 — splitWorld 로 이 넷의 핀 막대는 뺀다)으로 미리 칠한다. 검사기가 볼 것 그대로:
 *    꼭짓점   거기 설 비아의 둘러싸기까지가 같은 층 도형과 간격(폭/2 + 간격 + 폭/2) 안이거나, 같은 트랙에서 끝단 간격 안
 *    변       토막 몸통이 같은 층 도형과 겹치거나 (같은 트랙이면 끝단 간격 안)
 *    트랙     같은 중심선에 폭이 다른 도형이 있으면 그 층의 꼭짓점을 다 (DIFFERENT WIDTH 는 떨어져 있어도 본다)
 *    비아     같은 비아 층의 다른 비아와 간격 안 (이 넷의 같은 자리 비아는 괜찮다)
 *  그리기(drawStart · drawTo)는 누른 자리(닻)에서 커서를 따라간다 — 첫 토막은 사용자가 처음 움직인 쪽(posture), 다음은
 *  수직으로 꺾어 커서까지 (ㄱ자, 가로 토막은 짝의 가로 층, 세로 토막은 세로 층, 꺾는 자리에 비아). 그 ㄱ자가 막힌 자리를
 *  지나면 닻에서의 다익스트라 길 나무로 돌아간다. 이 넷의 다른 덩이 도형 가까이 가면 그 위로 붙는다 (pin tap).
 *  비용은 길이(층마다 무게 — 그리기 층 짝이 가장 싸고 M1 이 가장 비싸다) + 비아. 나온 경로는 수동 그리기와 같은 점 줄이라
 *  buildGeometry 가 최소 길이를 늘이고 재검사로 간다.
 *
 *  단위는 PnRDB.
 */
import { LAYERS, DRC, buildGraph, worldShapes } from "./wires.mjs";
import { DRAW_LAYERS, layerPair, netShapes, netRuleShapes, netComponents, splitWorld, buildGeometry, pathPlus } from "./draw.mjs";

/** 격자에 드는 층 — 그릴 수 있는 층 가운데 트랙이 가장 아래 세로·가로 층과 같은 것 (M1~M4) */
export const GRID_LAYERS = (() => {
  const ls = DRAW_LAYERS.map((n) => LAYERS.get(n));
  const v0 = ls.find((l) => l.dir === "v"), h0 = ls.find((l) => l.dir === "h");
  const out = [];
  for (const l of ls) {
    const ref = l.dir === "v" ? v0 : h0;
    if (l.pitch !== ref.pitch || l.offset !== ref.offset) break;     // 층이 이어져야 비아로 오간다
    out.push(l.name);
  }
  return out;
})();
const VIA_COST = 400;                     // 비아 하나 = 트랙 두어 칸 (꺾을 때마다 비아라 꺾기도 이만큼)

/** 층 L 의 비아 둘러싸기가 L 의 방향으로 뻗는 반길이 가운데 가장 긴 것 (격자 층 사이 비아만) */
function encOf(li, dir) {
  const ok = new Set(GRID_LAYERS.map((n) => LAYERS.get(n).li));
  let e = 0;
  for (const vm of DRC.Via_model) {
    if (!ok.has(vm.LowerIdx) || !ok.has(vm.UpperIdx)) continue;
    for (const [idx, pts] of [[vm.LowerIdx, vm.LowerRect], [vm.UpperIdx, vm.UpperRect]])
      if (idx === li) e = Math.max(e, dir === "v" ? Math.max(-pts[0].y, pts[1].y) : Math.max(-pts[0].x, pts[1].x));
  }
  return e;
}

/**
 * 넷 하나를 그릴 격자 — 꼭짓점·변·비아의 막힘과 비용.
 * @param {object} o  { world: worldShapes(...) (주면 다시 안 모은다), prefer: 그리기 층 (짝이 가장 싸다), turn }
 */
export function routingGrid(model, graphs, netName, { world = null, prefer = "M3", turn = "up" } = {}) {
  const net = model.nets.find((q) => q.name === netName);
  const graph = graphs.get(netName) ?? buildGraph(net);
  const area = model.area ?? model.bbox;
  const L = GRID_LAYERS.map((n) => LAYERS.get(n));
  const pv = L.find((l) => l.dir === "v"), ph = L.find((l) => l.dir === "h");
  const i0 = Math.ceil((area[0] - pv.offset) / pv.pitch), i1 = Math.floor((area[2] - pv.offset) / pv.pitch);
  const j0 = Math.ceil((area[1] - ph.offset) / ph.pitch), j1 = Math.floor((area[3] - ph.offset) / ph.pitch);
  const NX = Math.max(0, i1 - i0 + 1), NY = Math.max(0, j1 - j0 + 1), NL = L.length, NP = NX * NY, N = NL * NP;
  if (N > 4e6) throw new Error(`격자가 너무 크다 (${NX} x ${NY} x ${NL})`);
  const X = Float64Array.from({ length: NX }, (_, i) => pv.offset + (i0 + i) * pv.pitch);
  const Y = Float64Array.from({ length: NY }, (_, j) => ph.offset + (j0 + j) * ph.pitch);
  const layers = L.map((l) => ({ name: l.name, li: l.li, dir: l.dir, w: l.w, ss: l.ss, ee: l.ee, enc: encOf(l.li, l.dir), f: 1 }));
  const nb = new Uint8Array(N), eb = new Uint8Array(N), vb = new Uint8Array(N);
  const G = { model, netName, net, graph, area, X, Y, NX, NY, NL, NP, N, layers, nb, eb, vb };
  reweight(G, prefer, turn);
  const w0 = world ?? worldShapes(model, graphs, netName);
  const mine = netRuleShapes(net, graph);
  const { others } = splitWorld(w0, mine.metals);
  G.world = w0;

  // 정수 범위 [lo, hi] 에 드는 격자 번호 (열린 구간은 부르는 쪽이 1e-9 로 좁힌다)
  const span = (T, lo, hi) => {
    const p = T.length > 1 ? T[1] - T[0] : 1;
    let a = Math.ceil((lo - T[0]) / p - 1e-9), b = Math.floor((hi - T[0]) / p + 1e-9);
    return [Math.max(0, a), Math.min(T.length - 1, b)];
  };
  const idx = (l, i, j) => l * NP + j * NX + i;
  layers.forEach((ly, l) => {
    const v = ly.dir === "v", Tt = v ? X : Y, Ta = v ? Y : X;        // 트랙 좌표(수직), 따라가는 좌표
    const node = (k, a) => (v ? idx(l, k, a) : idx(l, a, k));
    for (const o of others) {
      if (o.layer !== ly.name) continue;
      const r = o.rect;
      const c = v ? (r[0] + r[2]) / 2 : (r[1] + r[3]) / 2, ws = v ? r[2] - r[0] : r[3] - r[1];
      const lo = v ? r[1] : r[0], hi = v ? r[3] : r[2];
      const reach = (ws + ly.w) / 2 + ly.ss;
      const [k0, k1] = span(Tt, c - reach + 1e-6, c + reach - 1e-6);
      for (let k = k0; k <= k1; k++) {
        const d = Math.abs(c - Tt[k]), perp = d - (ws + ly.w) / 2;
        if (perp >= ly.ss) continue;
        const marg = perp < 0 ? ly.ee : 0;                          // 같은 트랙(겹침): 끝단 간격, 옆 트랙: 겹치지만 않게
        // 꼭짓점 — 비아 둘러싸기까지: a 가 (lo - enc - marg, hi + enc + marg) 안이면 막힘
        const [a0, a1] = span(Ta, lo - ly.enc - marg + 1e-6, hi + ly.enc + marg - 1e-6);
        for (let a = a0; a <= a1; a++) nb[node(k, a)] = 1;
        // 변 (a, a+1) — 몸통이 (lo - marg, hi + marg) 와 겹치면 막힘
        const [b0, b1] = span(Ta, lo - marg + 1e-6 - (Ta.length > 1 ? Ta[1] - Ta[0] : 0), hi + marg - 1e-6);
        for (let a = b0; a <= b1 && a + 1 < Ta.length; a++) if (Ta[a + 1] > lo - marg && Ta[a] < hi + marg) eb[node(k, a)] = 1;
      }
    }
    // DIFFERENT WIDTH — 같은 중심선에 폭이 다른 도형(어느 넷이든, 이 넷 핀도)이 있는 트랙에는 떨어져 있어도 이 층 도형을
    // 못 둔다. 비아 둘러싸기도 이 층 도형이라 그 트랙의 꼭짓점을 다 막는다 (지나가는 비아 스택도)
    for (const o of [...w0, ...mine.metals]) {
      if (o.layer !== ly.name) continue;
      const r = o.rect, c = v ? (r[0] + r[2]) / 2 : (r[1] + r[3]) / 2, ws = v ? r[2] - r[0] : r[3] - r[1];
      if (ws === ly.w) continue;
      const p = Tt.length > 1 ? Tt[1] - Tt[0] : 1, k = Math.round((c - Tt[0]) / p);
      if (k < 0 || k >= Tt.length || Math.abs(Tt[k] - c) >= 1) continue;
      for (let a = 0; a < Ta.length; a++) nb[node(k, a)] = 1;
    }
  });
  // 비아 — 같은 비아 층의 다른 비아와 간격 (이 넷 비아는 같은 자리만 괜찮다)
  for (let l = 0; l + 1 < NL; l++) {
    const vm = DRC.Via_model.find((m) => m.LowerIdx === layers[l].li && m.UpperIdx === layers[l + 1].li);
    if (!vm) { vb.fill(1, l * NP, (l + 1) * NP); continue; }
    const vi = DRC.Via_info[vm.ViaIdx], hx = vi.width / 2, hy = vi.width_y / 2;
    const cuts = [...others.filter((o) => o.layer === vm.name).map((o) => ({ r: o.rect, own: false })),
                  ...mine.cuts.filter((o) => o.layer === vm.name).map((o) => ({ r: o.rect, own: true }))];
    for (const { r, own } of cuts) {
      const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, rx = hx + (r[2] - r[0]) / 2 + vi.dist_ss, ry = hy + (r[3] - r[1]) / 2 + vi.dist_ss_y;
      const [xa, xb] = span(X, cx - rx + 1e-6, cx + rx - 1e-6), [ya, yb] = span(Y, cy - ry + 1e-6, cy + ry - 1e-6);
      for (let j = ya; j <= yb; j++)
        for (let i = xa; i <= xb; i++) if (!(own && X[i] === cx && Y[j] === cy)) vb[idx(l, i, j)] = 1;
    }
  }
  return G;
}

/** 층 무게 — 그리기 층과 꺾는 층(짝)이 가장 싸고, 다른 층은 조금, M1 (소자 안쪽이 빽빽하다) 은 많이 비싸다 */
export function reweight(G, prefer, turn = "up") {
  const pair = layerPair(prefer, turn);
  for (const ly of G.layers) ly.f = ly.name === pair.h || ly.name === pair.v ? 1 : ly.name === "M1" ? 2.5 : 1.3;
  G.prefer = prefer; G.turn = turn;
}

// ---------------------------------------------------------------- 꼭짓점

export function nodePoint(G, n) {
  const l = Math.floor(n / G.NP), r = n - l * G.NP, j = Math.floor(r / G.NX), i = r - j * G.NX;
  return { x: G.X[i], y: G.Y[j], layer: G.layers[l].name };
}
/** 점 가까이의 (i, j) — 격자 밖이면 가장자리 */
function cell(G, x, y) {
  const px = G.NX > 1 ? G.X[1] - G.X[0] : 1, py = G.NY > 1 ? G.Y[1] - G.Y[0] : 1;
  return [Math.min(G.NX - 1, Math.max(0, Math.round((x - G.X[0]) / px))), Math.min(G.NY - 1, Math.max(0, Math.round((y - G.Y[0]) / py)))];
}
const layerIdx = (G, name) => G.layers.findIndex((q) => q.name === name);
const nodeOf = (G, l, i, j) => l * G.NP + j * G.NX + i;
function nodeLIJ(G, n) { const l = Math.floor(n / G.NP), r = n - l * G.NP, j = Math.floor(r / G.NX); return [l, r - j * G.NX, j]; }
/** 도형(netShapes 의 것) 위의 꼭짓점들 — 그 층·그 트랙·스팬 안. 트랙이 격자에 안 맞거나 격자 층이 아니면 없다 */
export function shapeNodes(G, s) {
  const l = G.layers.findIndex((q) => q.name === s.layer);
  if (l < 0) return [];
  const v = s.dir === "v", Tt = v ? G.X : G.Y, Ta = v ? G.Y : G.X;
  const p = Tt.length > 1 ? Tt[1] - Tt[0] : 1, k = Math.round((s.t - Tt[0]) / p);
  if (k < 0 || k >= Tt.length || Math.abs(Tt[k] - s.t) > 1e-6) return [];
  const out = [];
  for (let a = 0; a < Ta.length; a++) {
    if (Ta[a] < s.lo - 1e-6 || Ta[a] > s.hi + 1e-6) continue;
    const n = v ? l * G.NP + a * G.NX + k : l * G.NP + k * G.NX + a;
    if (!G.nb[n]) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------- 길찾기

/** 다익스트라 — sources [{n, c}] 에서. stop(n) 이 참인 꼭짓점을 처음 꺼내면 거기서 멈춘다 (hit) */
export function search(G, sources, stop = null) {
  const { N, NP, NX, NL, X, Y, layers, nb, eb, vb } = G;
  const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
  let hk = new Float64Array(1024), hv = new Int32Array(1024), size = 0;
  const push = (k, v) => {
    if (size === hk.length) { const a = new Float64Array(size * 2), b = new Int32Array(size * 2); a.set(hk); b.set(hv); hk = a; hv = b; }
    let i = size++;
    while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; }
    hk[i] = k; hv[i] = v;
  };
  const pop = () => {
    const v = hv[0], k = hk[--size], x = hv[size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= size) break;
      if (c + 1 < size && hk[c + 1] < hk[c]) c++;
      if (hk[c] >= k) break;
      hk[i] = hk[c]; hv[i] = hv[c]; i = c;
    }
    hk[i] = k; hv[i] = x;
    return v;
  };
  for (const { n, c = 0 } of sources) if (!nb[n] && c < dist[n]) { dist[n] = c; prev[n] = -1; push(c, n); }
  let hit = -1;
  while (size) {
    const d0 = hk[0], n = pop();
    if (d0 > dist[n]) continue;
    if (stop && stop(n)) { hit = n; break; }
    const l = Math.floor(n / NP), r = n - l * NP, j = Math.floor(r / NX), i = r - j * NX, ly = layers[l];
    const relax = (m, w) => { if (!nb[m] && d0 + w < dist[m]) { dist[m] = d0 + w; prev[m] = n; push(dist[m], m); } };
    if (ly.dir === "h") {
      if (i + 1 < NX && !eb[n]) relax(n + 1, (X[i + 1] - X[i]) * ly.f);
      if (i > 0 && !eb[n - 1]) relax(n - 1, (X[i] - X[i - 1]) * ly.f);
    } else {
      if (j + 1 < G.NY && !eb[n]) relax(n + NX, (Y[j + 1] - Y[j]) * ly.f);
      if (j > 0 && !eb[n - NX]) relax(n - NX, (Y[j] - Y[j - 1]) * ly.f);
    }
    if (l + 1 < NL && !vb[n]) relax(n + NP, VIA_COST);
    if (l > 0 && !vb[n - NP]) relax(n - NP, VIA_COST);
  }
  return { dist, prev, hit };
}
/** 꼭짓점 n 까지의 경로 — 그리기의 점 줄 ({x, y, layer}) */
export function pathTo(G, S, n) {
  const ids = [];
  for (let m = n; m !== -1; m = S.prev[m]) ids.push(m);
  return ids.reverse().map((m) => nodePoint(G, m));
}

// ---------------------------------------------------------------- 그리기 — 닻에서 커서를 따라

const rectDist = (r, p) => Math.hypot(Math.max(0, r[0] - p.x, p.x - r[2]), Math.max(0, r[1] - p.y, p.y - r[3]));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 붙을 곳 — 이 넷의 다른 덩이 도형들 (꼭짓점이 있는 것). 시작 도형이 없으면(빈 자리) 이 넷 도형 전부 */
function targetsOf(G, shape) {
  const shapes = netShapes(G.net, G.graph), comp = netComponents(G.net, G.graph);
  const compOf = (s) => (s.kind === "pin" ? comp.pinComp[G.net.pins.indexOf(s.pin)] : comp.segComp[s.seg.id]);
  const startComp = shape ? compOf(shapes.find((s) => s.key === shape.key) ?? shape) ?? -1 : -1;
  const out = [];
  for (const s of shapes) {
    const c = compOf(s);
    if (shape && c === startComp) continue;
    const nodes = shapeNodes(G, s);
    if (nodes.length) out.push({ shape: s, comp: c, nodes });
  }
  return out;
}
/** 커서 가까이(세 칸 고리까지)에서 길 나무가 닿는 가장 싼 꼭짓점 — 없으면 -1 */
function nearestReach(G, S, cursor) {
  const [ci, cj] = cell(G, cursor.x, cursor.y);
  for (let r = 0; r <= 3; r++) {
    let best = -1, bc = Infinity;
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= G.NX || j >= G.NY) continue;
        for (let l = 0; l < G.NL; l++) { const n = nodeOf(G, l, i, j), c = S.dist[n]; if (c < bc) { bc = c; best = n; } }
      }
    if (best >= 0) return best;
  }
  return -1;
}

/**
 * 닻 n0 에서 격자 점 (i1, j1) 까지 ㄱ자 — 첫 토막은 posture 축 ("h" 가로 먼저, "v" 세로 먼저), 가로 토막은 h 층, 세로 토막은
 * v 층, 층이 바뀌는 자리에는 비아를 쌓는다. endLayer 를 주면 끝에서 그 층까지 (붙을 도형의 층). 길이 0 인 토막은 건너뛴다.
 * 막힌 꼭짓점·변·비아 자리를 하나라도 지나면 null — 막힘이 검사기 규칙이라 안 막혔으면 규칙에 맞는다.
 * @returns {{path: Array<{x,y,layer}>, end: number}|null}   path 는 닻부터, 꺾는 자리와 쌓는 자리만
 */
export function lPath(G, n0, i1, j1, { posture, h, v, endLayer = null }) {
  const lh = layerIdx(G, h), lv = layerIdx(G, v);
  if (lh < 0 || lv < 0 || G.layers[lh].dir !== "h" || G.layers[lv].dir !== "v") return null;
  const { nb, eb, vb, NX } = G;
  let [l, i, j] = nodeLIJ(G, n0);
  const path = [nodePoint(G, n0)];
  const here = () => path.push({ x: G.X[i], y: G.Y[j], layer: G.layers[l].name });
  const stackTo = (lt) => {
    if (l === lt) return true;
    while (l !== lt) {
      const s = lt > l ? 1 : -1;
      if (vb[nodeOf(G, Math.min(l, l + s), i, j)] || nb[nodeOf(G, l + s, i, j)]) return false;
      l += s;
    }
    here();
    return true;
  };
  const walk = (axis, to) => {
    for (;;) {
      const at = axis === "h" ? i : j;
      if (at === to) break;
      const s = to > at ? 1 : -1, n = nodeOf(G, l, i, j);
      if (eb[axis === "h" ? (s > 0 ? n : n - 1) : (s > 0 ? n : n - NX)]) return false;
      if (axis === "h") i += s; else j += s;
      if (nb[nodeOf(G, l, i, j)]) return false;
    }
    here();
    return true;
  };
  for (const [axis, to] of posture === "h" ? [["h", i1], ["v", j1]] : [["v", j1], ["h", i1]]) {
    if ((axis === "h" ? i : j) === to) continue;
    if (!stackTo(axis === "h" ? lh : lv) || !walk(axis, to)) return null;
  }
  if (endLayer != null) { const le = layerIdx(G, endLayer); if (le < 0 || !stackTo(le)) return null; }
  return { path, end: nodeOf(G, l, i, j) };
}

/**
 * 그리기 시작 — 닻(누른 도형 위에서 누른 자리에 가장 가까운 꼭짓점, 빈 자리면 그 자리)과 거기서의 길 나무 (막혀서 돌아갈 때와
 * 붙을 때 쓴다). 붙을 곳(targets)은 이 넷의 다른 덩이의 도형들이다.
 * @param {object} o  { shape: 누른 도형 (netShapes 의 것) | null, at: 누른 점, prefer, turn, grid: 이미 지은 격자 }
 * @returns {{G, anchor, S, targets, why?}}   못 잡으면 S 가 null 이고 why
 */
export function drawStart(model, graphs, netName, { shape = null, at, prefer = "M3", turn = "up", grid = null } = {}) {
  const G = grid ?? routingGrid(model, graphs, netName, { prefer, turn });
  const targets = targetsOf(G, shape);
  let anchor = -1;
  if (shape) {
    let bd = Infinity;
    for (const n of shapeNodes(G, shape)) { const d = dist(nodePoint(G, n), at); if (d < bd) { bd = d; anchor = n; } }
  } else {
    const [i, j] = cell(G, at.x, at.y), l0 = Math.max(0, layerIdx(G, prefer));
    for (const l of [l0, ...G.layers.map((_, k) => k).filter((k) => k !== l0)]) { const n = nodeOf(G, l, i, j); if (!G.nb[n]) { anchor = n; break; } }
  }
  if (anchor < 0) return { G, anchor, S: null, targets, why: shape ? `${shape.layer} 도형이 격자(${GRID_LAYERS.join("·")}) 트랙 위가 아니거나 막혀 있다` : "여기는 막혀 있다" };
  return { G, anchor, S: search(G, [{ n: anchor, c: 0 }]), targets };
}
/** 닻을 옮긴다 — 클릭이나 꺾기로 거기까지 고정했을 때. 같은 닻이면 층 무게를 바꾼 뒤 다시 찾는 것 */
export function drawMove(D, anchor) {
  return { ...D, anchor, S: search(D.G, [{ n: anchor, c: 0 }]) };
}

/**
 * 커서까지 — 닻에서 ㄱ자로 (첫 토막은 posture 축 — 사용자가 처음 움직인 쪽, h·v 는 가로·세로 토막의 층). 이 넷의 다른 덩이
 * 도형이 tapAt(진짜 커서)에서 aperture 안이면 그 위로 붙는다 — 커서를 도형에 내린 자리 가까운 꼭짓점부터 ㄱ자로. ㄱ자가 막혔으면
 * 커서의 둘레 두 칸 안 점까지, 그다음 꺾는 쪽을 바꿔(flipped) 다시 보고, 그래도 막혔으면 길 나무로 돌아간다 (detour). posture 가
 * 없으면 (커서가 아직 닻 가까이) 닻 그대로다.
 * @returns {{ok, why, path: Array<{x,y,layer}>, end: number, target, detour, flipped?}}   path 는 닻부터
 */
export function drawTo(D, cursor, { posture = null, aperture = 0, h, v, tapAt = cursor } = {}) {
  const { G, S } = D;
  const fail = (why) => ({ ok: false, why, path: [], end: -1, target: null, detour: false });
  if (!S) return fail(D.why ?? "시작점이 없다");
  let tap = null;
  for (const t of D.targets) { const d = rectDist(t.shape.rect, tapAt); if (d <= aperture && (!tap || d < tap.d)) tap = { t, d }; }
  if (tap) {
    const s = tap.t.shape, r = s.rect;
    const proj = { x: Math.min(r[2], Math.max(r[0], tapAt.x)), y: Math.min(r[3], Math.max(r[1], tapAt.y)) };
    const near = tap.t.nodes.map((n) => ({ n, d: dist(nodePoint(G, n), proj) })).sort((a, b) => a.d - b.d).slice(0, 6);
    for (const p of posture ? [posture, posture === "h" ? "v" : "h"] : ["h", "v"])
      for (const { n } of near) {
        const [l, i, j] = nodeLIJ(G, n);
        const L = lPath(G, D.anchor, i, j, { posture: p, h, v, endLayer: G.layers[l].name });
        if (L) return { ok: true, why: null, path: L.path, end: L.end, target: s, detour: false };
      }
    let best = -1, bc = Infinity;
    for (const n of tap.t.nodes) { const c = S.dist[n] + 0.3 * dist(nodePoint(G, n), tapAt); if (c < bc) { bc = c; best = n; } }
    if (best >= 0 && Number.isFinite(S.dist[best])) return { ok: true, why: null, path: pathTo(G, S, best), end: best, target: s, detour: true };
    return fail(`${s.layer} ${s.kind === "pin" ? "핀" : "배선"} 까지 막혀 있다`);
  }
  if (!posture) return { ok: true, why: null, path: [nodePoint(G, D.anchor)], end: D.anchor, target: null, detour: false };
  // 곧장 (ㄱ자) — 커서의 격자 점, 막혔으면 그 둘레 한두 칸 (커서에 가까운 것부터), 그래도 안 되면 꺾는 쪽을 바꿔서.
  // 토막이 둘뿐인 길이라 손이 간 대로다. 다 막혔을 때만 길 나무로 돌아간다
  const [ci, cj] = cell(G, cursor.x, cursor.y);
  const ring = [[0, 0]];
  for (let r = 1; r <= 2; r++)
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) if (Math.max(Math.abs(di), Math.abs(dj)) === r) ring.push([di, dj]);
  const cand = ring.map(([di, dj]) => [ci + di, cj + dj]).filter(([i, j]) => i >= 0 && j >= 0 && i < G.NX && j < G.NY)
    .map(([i, j]) => ({ i, j, d: Math.hypot(G.X[i] - cursor.x, G.Y[j] - cursor.y) })).sort((a, b) => a.d - b.d);
  for (const p of [posture, posture === "h" ? "v" : "h"])
    for (const { i, j } of p === posture ? cand : cand.slice(0, 9)) {
      const L = lPath(G, D.anchor, i, j, { posture: p, h, v });
      if (L) return { ok: true, why: null, path: L.path, end: L.end, target: null, detour: false, flipped: p !== posture };
    }
  const n = nearestReach(G, S, cursor);
  if (n >= 0) return { ok: true, why: null, path: pathTo(G, S, n), end: n, target: null, detour: true };
  return fail("커서 근처까지 길이 없다");
}

// ---------------------------------------------------------------- 옛 보조 (덩이 전체에서 가장 싼 길) — 캐시에 남은 옛 편집기가 부른다

/**
 * 보조 그리기 시작 — 시작 도형(또는 빈 자리의 점)에서 다익스트라 한 번. 붙을 곳(targets)은 이 넷의 다른 덩이의 도형들이다.
 * @param {object} o  { shape: 시작 도형 (netShapes 의 것) | null, at: 누른 점, prefer, turn, world, grid: 이미 지은 격자 }
 * @returns {{G, S, targets, sources, why?}}   sources 는 시작 꼭짓점과 출발 비용 (없으면 why)
 */
export function assistStart(model, graphs, netName, { shape = null, at, prefer = "M3", turn = "up", world = null, grid = null } = {}) {
  const G = grid ?? routingGrid(model, graphs, netName, { world, prefer, turn });
  const shapes = netShapes(G.net, G.graph), comp = netComponents(G.net, G.graph);
  const compOf = (s) => (s.kind === "pin" ? comp.pinComp[G.net.pins.indexOf(s.pin)] : comp.segComp[s.seg.id]);
  let from = [], startComp = -1;
  if (shape) {
    const me = shapes.find((s) => s.key === shape.key) ?? shape;
    startComp = compOf(me) ?? -1;
    // 같은 덩이의 도형 전부에서 나갈 수 있다 — 누른 자리에서 멀수록 조금 비싸게 (누른 곳 가까이에서 나가게)
    for (const s of shapes) {
      if (compOf(s) !== startComp) continue;
      for (const n of shapeNodes(G, s)) { const p = nodePoint(G, n); from.push({ n, c: (s.key === me.key ? 0.25 : 1) * Math.hypot(p.x - at.x, p.y - at.y) }); }
    }
  } else {
    const [i, j] = cell(G, at.x, at.y), l = Math.max(0, G.layers.findIndex((q) => q.name === prefer));
    for (const ll of [l, ...G.layers.map((_, k) => k).filter((k) => k !== l)]) {
      const n = ll * G.NP + j * G.NX + i;
      if (!G.nb[n]) { from = [{ n, c: 0 }]; break; }
    }
  }
  const targets = targetsOf(G, shape);
  if (!from.length) return { G, S: null, targets, sources: [], why: shape ? `${shape.layer} 도형이 격자(${GRID_LAYERS.join("·")}) 트랙 위가 아니거나 막혀 있다` : "여기는 막혀 있다" };
  return { G, S: search(G, from), targets, sources: from };
}

/** 이어 그리기 — 지난 끝 꼭짓점에서 다시 (endNode 가 없으면 처음 시작점들에서 — 층 무게를 바꿨을 때) */
export function assistContinue(A, endNode = null) {
  const sources = endNode == null ? A.sources : [{ n: endNode, c: 0 }];
  return { ...A, S: sources.length ? search(A.G, sources) : null, sources };
}

/**
 * 커서까지 — 이 넷의 다른 덩이 도형이 aperture 안이면 그리로 붙는다 (tap: 그 도형의 꼭짓점 가운데 길과 커서 거리가 가장 짧은 곳).
 * 아니면 커서에 가장 가까운 격자 점까지 (층은 가장 싼 것).
 * @returns {{ok, why, path: Array<{x,y,layer}>, end: number, target}}   path 는 시작 꼭짓점부터
 */
export function assistTo(A, cursor, { aperture = 0 } = {}) {
  const { G, S } = A;
  if (!S) return { ok: false, why: A.why ?? "시작점이 없다", path: [], end: -1, target: null };
  let tap = null;
  for (const t of A.targets) {
    const d = rectDist(t.shape.rect, cursor);
    if (d <= aperture && (!tap || d < tap.d)) tap = { t, d };
  }
  if (tap) {
    let best = -1, bc = Infinity;
    for (const n of tap.t.nodes) {
      const p = nodePoint(G, n), c = S.dist[n] + 0.3 * Math.hypot(p.x - cursor.x, p.y - cursor.y);
      if (c < bc) { bc = c; best = n; }
    }
    if (best >= 0 && Number.isFinite(S.dist[best])) return { ok: true, why: null, path: pathTo(G, S, best), end: best, target: tap.t.shape };
    return { ok: false, why: `${tap.t.shape.layer} ${tap.t.shape.kind === "pin" ? "핀" : "배선"} 까지 막혀 있다`, path: [], end: -1, target: null };
  }
  const n = nearestReach(G, S, cursor);
  if (n >= 0) return { ok: true, why: null, path: pathTo(G, S, n), end: n, target: null };
  return { ok: false, why: "커서 근처까지 길이 없다", path: [], end: -1, target: null };
}

/**
 * 열린 곳을 잇는다 — 넷의 덩이가 하나가 될 때까지, 첫 핀의 덩이에서 가장 싸게 닿는 다른 덩이로 길을 찾아 더한다
 * (안 닿으면 다른 덩이에서). 플라이라인 하나만 이으려면 only: [덩이 a, 덩이 b].
 * @returns {{edit: {net, path_metal, path_via}|null, paths, joined, failed, comps}}   edit 는 넷에 넣을 경로 (못 이었으면 null)
 */
export function autoConnect(model, graphs, netName, { prefer = "M3", turn = "up", world = null, only = null, maxSteps = 32 } = {}) {
  const G = routingGrid(model, graphs, netName, { world, prefer, turn });
  let work = { ...G.net, path_metal: G.net.path_metal.slice(), path_via: G.net.path_via.slice() };
  let g = G.graph;
  const paths = [];
  let joined = 0, failed = 0;
  const tried = new Set();
  for (let step = 0; step < maxSteps; step++) {
    const c = netComponents(work, g);
    if (c.comps <= 1) break;
    const shapes = netShapes(work, g);
    const compOf = (s) => (s.kind === "pin" ? c.pinComp[work.pins.indexOf(s.pin)] : c.segComp[s.seg.id]);
    const nodesOf = new Map();                                   // 덩이 -> 꼭짓점들
    for (const s of shapes) {
      const k = compOf(s);
      if (!nodesOf.has(k)) nodesOf.set(k, []);
      nodesOf.get(k).push(...shapeNodes(G, s));
    }
    let src;
    if (only && step === 0) src = only[0];
    else src = [...nodesOf.keys()].find((k) => !tried.has(k) && nodesOf.get(k).length) ?? -1;
    if (src < 0 || src === undefined) break;
    const goal = new Map();
    for (const [k, ns] of nodesOf) if (k !== src && (!only || step > 0 || k === only[1])) for (const n of ns) goal.set(n, k);
    const S = search(G, nodesOf.get(src).map((n) => ({ n, c: 0 })), (n) => goal.has(n));
    if (S.hit < 0) { tried.add(src); failed++; if (only) break; continue; }
    const path = pathTo(G, S, S.hit);
    const geom = buildGeometry([path], { mine: shapes, world: G.world, area: G.area });
    const e = pathPlus(work, geom);
    work = { ...work, path_metal: e.path_metal, path_via: e.path_via };
    g = buildGraph(work);
    G.net = work; G.graph = g;
    paths.push(path); joined++;
    tried.clear();
    if (only) break;
  }
  const comps = netComponents(work, g).comps;
  return { edit: joined ? { net: netName, path_metal: work.path_metal, path_via: work.path_via } : null, paths, joined, failed, comps };
}
