/** 배선 편집 — 넷 모델과 조각 그래프.
 *
 *  배선기(alignroute.wasm)는 넷마다 path_metal(층마다 곧은 토막, 층의 선호 방향으로만)과 path_via(층을 바꾸는
 *  자리)를 낸다. ALIGN 은 연결마다 토막을 내고 비아를 두 번씩 덧붙이므로 (PLAN-route-align.md 부록 B) 그대로는
 *  고치기 어렵다. 그래서 넷을 **조각 그래프**로 고쳐 읽는다:
 *
 *    조각(seg)   같은 층·같은 트랙에서 닿는 토막을 하나로 이은 것. t 는 트랙 좌표(세로 층은 x, 가로 층은 y),
 *                lo/hi 는 그 방향의 스팬. 핀에 닿은 것은 pins 에, 비아는 joints 에.
 *    비아(via)   같은 자리의 중복을 하나로. 위·아래 층의 조각(또는 핀)을 잇는다.
 *    확장        조각이 앵커(비아·핀)보다 얼마나 더 뻗어 있나 (extLo, extHi) — ALIGN 이 최소 길이 때문에 늘인 것.
 *                조각의 끝이 움직여도 이 확장은 그대로 따라간다.
 *
 *  위상 = 이 그래프다 (조각의 수·층·차례, 비아, 핀 접속). 편집은 조각의 t 만 바꾼다 (slide): 그 조각의 비아가 같이
 *  옮겨지고 그 비아에 닿은 직교 조각의 끝이 늘거나 준다. 옮길 수 있는 범위(range)는 핀 접속, 이웃의 최소 길이,
 *  같은 층 다른 도형과의 간격, 비아 간격, 모듈 경계로 정한다. 마지막 판정은 검사기(check.mjs)다.
 *
 *  단위는 전부 PnRDB(nm 의 2 배)다 — 배선기가 낸 좌표는 홀수일 수 있어 반으로 줄이면 못 되살린다. 그리기만 2 로 나눈다.
 */
import { readPdkJson } from "../route/align/drc.mjs";
import { MOCK_PDK } from "../route/pdk.mjs";
import { BLOCK, TERMINAL, clone } from "../route/align/pnrdb.mjs";

export const DRC = readPdkJson(MOCK_PDK);

const rectOf = (c) => [c.placedBox.LL.x, c.placedBox.LL.y, c.placedBox.UR.x, c.placedBox.UR.y];
const overlap1 = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);

/** 층 정보 — 이름 -> { li, name, dir, w, ss, minL, ee, pitch, offset } (PnRDB 단위) */
export function layerInfo(drc = DRC) {
  const L = new Map();
  drc.Metal_info.forEach((m, li) => {
    const dir = m.direct === 0 ? "v" : "h";
    L.set(m.name, { li, name: m.name, dir, w: m.width, ss: m.dist_ss, minL: m.minL, ee: m.dist_ee,
                    pitch: dir === "v" ? m.grid_unit_x : m.grid_unit_y, offset: m.offset });
  });
  return L;
}
export const LAYERS = layerInfo();

// ---------------------------------------------------------------- 넷 모델 (hierNode -> JSON)

/** 배선이 끝난 최상위 hierNode 에서 편집기가 쓰는 넷 모델을 뽑는다. 좌표는 PnRDB 그대로, path 는 사본이다. */
export function wireModel(node) {
  const inst = (c) => { const bc = node.Blocks[c.iter2]; return bc.instance[bc.selectedInstance]; };
  const netName = (i) => (i >= 0 && i < node.Nets.length ? node.Nets[i].name : null);
  const nets = node.Nets.map((n) => ({
    name: n.name,
    port: n.connected.some((c) => c.type === TERMINAL),
    pins: n.connected.filter((c) => c.type === BLOCK).flatMap((c) => {
      const b = inst(c), p = b.blockPins[c.iter];
      return (p?.pinContacts ?? []).map((pc) => ({ block: b.name, pin: p.name, layer: pc.metal, rect: rectOf(pc) }));
    }),
    path_metal: clone(n.path_metal), path_via: clone(n.path_via),
  }));
  const power = node.PowerNets.map((p) => ({
    name: p.name, power: p.power,
    pins: p.Pins.flatMap((q) => q.pinContacts.map((pc) => ({ pin: q.name, layer: pc.metal, rect: rectOf(pc) }))),
    path_metal: clone(p.path_metal), path_via: clone(p.path_via),
  }));
  const grid = {
    vdd: { name: node.Vdd.name, metals: clone(node.Vdd.metals), vias: clone(node.Vdd.vias) },
    gnd: { name: node.Gnd.name, metals: clone(node.Gnd.metals), vias: clone(node.Gnd.vias) },
  };
  // 장애물: 블록의 내부 금속·비아와 모든 핀 접점·핀 비아 (핀은 어느 넷의 것인지 적는다 — 그 넷의 조각은 거기 닿아야 한다)
  const obstacles = [];
  const push = (layer, rect, net = null) => { if (layer) obstacles.push({ layer, rect, net }); };
  const via = (v, net) => { push(v.UpperMetalRect.metal, rectOf(v.UpperMetalRect), net); push(v.LowerMetalRect.metal, rectOf(v.LowerMetalRect), net); push(v.ViaRect.metal, rectOf(v.ViaRect), net); };
  const powerOf = new Map();
  for (const p of node.PowerNets) for (const c of p.connected) if (c.type === BLOCK) powerOf.set(`${c.iter2}/${c.iter}`, p.name);
  node.Blocks.forEach((bc, bi) => {
    const b = bc.instance[bc.selectedInstance];
    for (const c of b.interMetals) push(c.metal, rectOf(c));
    for (const v of b.interVias) via(v, null);
    b.blockPins.forEach((p, pi) => {
      const net = p.netIter >= 0 ? netName(p.netIter) : (powerOf.get(`${bi}/${pi}`) ?? null);
      for (const c of p.pinContacts) push(c.metal, rectOf(c), net);
      for (const v of p.pinVias) via(v, net);
    });
  });
  return { module: node.name, bbox: [node.LL.x, node.LL.y, node.UR.x, node.UR.y], nets, power, grid, obstacles };
}

// ---------------------------------------------------------------- 조각 그래프

/** 넷 하나 -> 조각 그래프. L 은 layerInfo(), drc 는 readPdkJson 결과. */
export function buildGraph(net, L = LAYERS, drc = DRC) {
  // 1. 토막 -> 층·트랙별로 잇기 (길이 0 토막은 비아 둘러싸기라 뺀다 — 비아에서 되살린다)
  const pieces = [];
  for (const m of net.path_metal) {
    const li = L.get(m.MetalRect.metal);
    if (!li) continue;
    const r = rectOf(m.MetalRect), v = li.dir === "v";
    const lo = v ? r[1] : r[0], hi = v ? r[3] : r[2];
    const p0 = m.LinePoint?.[0], p1 = m.LinePoint?.[1];
    if (p0 && p1 && p0.x === p1.x && p0.y === p1.y) continue;
    if (hi - lo <= 0) continue;
    pieces.push({ layer: li.name, li, t: v ? (r[0] + r[2]) / 2 : (r[1] + r[3]) / 2, lo, hi, w: v ? r[2] - r[0] : r[3] - r[1] });
  }
  const byTrack = new Map();
  for (const p of pieces) { const k = `${p.layer}|${p.t}`; if (!byTrack.has(k)) byTrack.set(k, []); byTrack.get(k).push(p); }
  const segs = [];
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.lo - b.lo);
    let cur = null;
    for (const p of list) {
      if (cur && p.lo <= cur.hi) { cur.hi = Math.max(cur.hi, p.hi); cur.w = Math.max(cur.w, p.w); }
      else { cur = { id: segs.length, layer: p.layer, li: p.li.li, dir: p.li.dir, t: p.t, lo: p.lo, hi: p.hi, w: p.w, joints: [], pins: [], pinAnchors: [], extLo: 0, extHi: 0 }; segs.push(cur); }
    }
  }
  // 2. 비아 — 같은 자리는 하나
  const vias = [];
  const seenVia = new Set();
  for (const v of net.path_via) {
    const k = `${v.model_index},${v.placedpos.x},${v.placedpos.y}`;
    if (seenVia.has(k)) continue;
    seenVia.add(k);
    const vm = drc.Via_model[v.model_index];
    if (!vm) continue;
    vias.push({ id: vias.length, model: v.model_index, x: v.placedpos.x, y: v.placedpos.y,
                lower: drc.Metal_info[vm.LowerIdx]?.name ?? null, upper: drc.Metal_info[vm.UpperIdx]?.name ?? null,
                segLower: null, segUpper: null, pinLower: null, pinUpper: null });
  }
  // 3. 비아 <-> 조각
  const onSeg = (s, x, y) => {
    const v = s.dir === "v", perp = v ? x : y, along = v ? y : x;
    return Math.abs(perp - s.t) <= s.w / 2 + 1 && along >= s.lo - 1 && along <= s.hi + 1;
  };
  for (const jv of vias) {
    for (const s of segs) {
      if (s.layer === jv.lower && !jv.segLower && onSeg(s, jv.x, jv.y)) { jv.segLower = s; s.joints.push(jv); }
      else if (s.layer === jv.upper && !jv.segUpper && onSeg(s, jv.x, jv.y)) { jv.segUpper = s; s.joints.push(jv); }
    }
  }
  // 4. 핀 — 같은 층·같은 트랙에서 스팬이 닿는 조각에, 그리고 비아 자리를 품는 핀에
  for (const pin of net.pins) {
    const li = L.get(pin.layer);
    if (!li) continue;
    const v = li.dir === "v", r = pin.rect;
    const pt = v ? (r[0] + r[2]) / 2 : (r[1] + r[3]) / 2, plo = v ? r[1] : r[0], phi = v ? r[3] : r[2];
    for (const s of segs) {
      if (s.layer !== pin.layer) continue;
      if (Math.abs(s.t - pt) > (s.w + (v ? r[2] - r[0] : r[3] - r[1])) / 2 - 1) continue;      // 다른 트랙
      const o = overlap1(s.lo, s.hi, plo, phi);
      if (o < 0) continue;                                                                  // 안 닿는다
      s.pins.push(pin);
      s.pinAnchors.push([Math.max(s.lo, plo), Math.min(s.hi, phi)]);
    }
    for (const jv of vias) {
      const inside = jv.x >= r[0] && jv.x <= r[2] && jv.y >= r[1] && jv.y <= r[3];
      if (!inside) continue;
      if (pin.layer === jv.lower && !jv.pinLower) jv.pinLower = pin;
      if (pin.layer === jv.upper && !jv.pinUpper) jv.pinUpper = pin;
    }
  }
  // 5. 확장 — 앵커 밖으로 얼마나 뻗어 있나
  for (const s of segs) {
    const a = anchors(s);
    if (!a.length) continue;
    s.extLo = Math.max(0, Math.min(...a) - s.lo);
    s.extHi = Math.max(0, s.hi - Math.max(...a));
  }
  return { net: net.name, segs, vias, pins: net.pins, L, drc };
}

/** 조각의 앵커 좌표(그 방향으로) — 비아 자리와 핀 겹침 구간의 양 끝. except 를 주면 그 비아는 뺀다. */
export function anchors(s, except = null) {
  const out = [];
  for (const jv of s.joints) { if (jv === except) continue; out.push(s.dir === "v" ? jv.y : jv.x); }
  for (const [a, b] of s.pinAnchors) out.push(a, b);
  return out;
}

const otherSeg = (jv, s) => (jv.segLower === s ? jv.segUpper : jv.segLower);

/** 앵커에서 스팬을 다시 낸다 (확장은 그대로). 앵커가 없으면 그대로. */
function respan(s) {
  const a = anchors(s);
  if (!a.length) return;
  s.lo = Math.min(...a) - s.extLo;
  s.hi = Math.max(...a) + s.extHi;
}

/** 조각을 트랙 t 로 옮긴다 — 그 비아들이 따라가고, 비아에 닿은 직교 조각의 끝이 늘거나 준다. */
export function slide(graph, s, t) {
  s.t = t;
  for (const jv of s.joints) {
    if (s.dir === "v") jv.x = t; else jv.y = t;
    const o = otherSeg(jv, s);
    if (o) respan(o);
  }
}

/** 세상의 도형 — 이 넷 말고 같은 층에서 부딪힐 수 있는 것 전부: 블록 장애물(이 넷의 핀은 뺀다), 다른 넷의 조각·비아,
 *  전원 넷, 전원 격자. graphs 는 넷 이름 -> 그래프 (지금 편집 중인 상태). */
export function worldShapes(model, graphs, netName) {
  const out = [];
  for (const o of model.obstacles) if (o.net !== netName) out.push({ layer: o.layer, rect: o.rect, kind: "block", net: o.net });
  const drc = DRC;
  const viaRects = (jv, net) => {
    const vm = drc.Via_model[jv.model];
    const r = (pts) => [jv.x + pts[0].x, jv.y + pts[0].y, jv.x + pts[1].x, jv.y + pts[1].y];
    out.push({ layer: vm.name, rect: r(vm.ViaRect), kind: "via", net, x: jv.x, y: jv.y, model: jv.model });
    if (jv.lower) out.push({ layer: jv.lower, rect: r(vm.LowerRect), kind: "wire", net });
    if (jv.upper) out.push({ layer: jv.upper, rect: r(vm.UpperRect), kind: "wire", net });
  };
  for (const [name, g] of graphs) {
    if (name === netName) continue;
    for (const s of g.segs) out.push({ layer: s.layer, rect: segRect(s), kind: "wire", net: name });
    for (const jv of g.vias) viaRects(jv, name);
  }
  const rawPath = (p, name) => {
    for (const m of p.path_metal) out.push({ layer: m.MetalRect.metal, rect: rectOf(m.MetalRect), kind: "power", net: name });
    for (const v of p.path_via) { out.push({ layer: v.ViaRect.metal, rect: rectOf(v.ViaRect), kind: "via", net: name, x: v.placedpos.x, y: v.placedpos.y, model: v.model_index }); out.push({ layer: v.LowerMetalRect.metal, rect: rectOf(v.LowerMetalRect), kind: "power", net: name }); out.push({ layer: v.UpperMetalRect.metal, rect: rectOf(v.UpperMetalRect), kind: "power", net: name }); }
  };
  for (const p of model.power) { rawPath(p, p.name); for (const pin of p.pins) out.push({ layer: pin.layer, rect: pin.rect, kind: "block", net: p.name }); }
  for (const g of [model.grid.vdd, model.grid.gnd]) rawPath({ path_metal: g.metals, path_via: g.vias }, g.name);
  return out;
}

export function segRect(s) {
  return s.dir === "v" ? [s.t - s.w / 2, s.lo, s.t + s.w / 2, s.hi] : [s.lo, s.t - s.w / 2, s.hi, s.t + s.w / 2];
}

/** 비아 jv 의 layer 층 둘러싸기 사각형이 dir 방향으로 뻗는 반길이 (그 층의 조각 끝은 이만큼은 늘 덮인다) */
function encHalf(graph, jv, layer, dir) {
  const vm = graph.drc.Via_model[jv.model];
  if (!vm) return 0;
  const pts = layer === jv.lower ? vm.LowerRect : layer === jv.upper ? vm.UpperRect : null;
  if (!pts || pts.length < 2) return 0;
  return dir === "v" ? Math.max(-pts[0].y, pts[1].y) : Math.max(-pts[0].x, pts[1].x);
}

/** 같은 층에서 조각 o 와 같은 트랙(폭이 겹치는)에 있는 도형들의 그 방향 구간 — 세상 것과 이 넷의 다른 조각 */
function colinear(graph, o, world, except) {
  const v = o.dir === "v", out = [];
  const take = (rect) => {
    const c = v ? (rect[0] + rect[2]) / 2 : (rect[1] + rect[3]) / 2;
    const hw = v ? (rect[2] - rect[0]) / 2 : (rect[3] - rect[1]) / 2;
    if (Math.abs(c - o.t) >= (o.w + 2 * hw) / 2 - 1e-9) return;
    out.push(v ? [rect[1], rect[3]] : [rect[0], rect[2]]);
  };
  for (const q of world) if (q.layer === o.layer) take(q.rect);
  for (const q of graph.segs) if (q !== o && !except.includes(q) && q.layer === o.layer) take(segRect(q));
  return out;
}

/**
 * 조각을 옮길 수 있는 범위와 그 안의 트랙들.
 *   { locked, why, lo, hi, tracks: [t...] }   tracks 는 지금 자리를 포함해 오름차순
 *
 * 규칙 (검사기 check.mjs 가 보는 것과 배선기가 장애물을 피하는 방식을 따른다):
 *   핀        같은 층 핀에 닿은 조각은 못 움직인다. 다른 층 핀 위에 앉은 비아는 핀 사각형 안에 남는다
 *   이웃      옮기면 그 비아에 닿은 직교 조각의 끝이 따라온다 — 같은 쪽에 남고(위상), 핀에 안 닿은 조각은 최소 길이를
 *             지키며, 늘어난 끝이 같은 트랙의 다른 도형과 끝단 간격(EndToEnd) 안으로 들어가지 않는다
 *   간격      같은 층에서 스팬이 (끝단 간격만큼 넓혀) 겹치는 다른 도형과 폭/2 + 간격 + 그 폭/2 이상 떨어진다. 지금과 같은 쪽
 *   비아      같은 비아 층의 다른 비아와 같은 중심선에 오면 비아 간격을 지킨다
 *   경계      모듈 안
 */
export function range(graph, s, world, bbox) {
  const L = graph.L.get(s.layer), v = s.dir === "v";
  const perp = v ? 0 : 1;
  const lock = (why) => ({ locked: true, why, lo: s.t, hi: s.t, tracks: [s.t] });
  if (s.pins.length) return lock("같은 층의 핀에 닿아 있다");
  if (!s.joints.length) return lock("비아도 핀도 없는 조각");
  let lo = -Infinity, hi = Infinity;
  const why = [];
  // 비아가 다른 층의 핀 위에 앉은 것 — 비아 중심이 핀 사각형 안에 남아야 한다
  for (const jv of s.joints) {
    const pin = s.layer === jv.lower ? jv.pinUpper : jv.pinLower;
    if (!pin) continue;
    const vi = graph.drc.Via_info[jv.model];
    const half = (v ? vi.width : vi.width_y) / 2;
    lo = Math.max(lo, pin.rect[perp] + half); hi = Math.min(hi, pin.rect[perp + 2] - half);
    why.push(`${pin.block}/${pin.pin} 핀 위의 비아`);
  }
  // 직교 이웃 — 같은 쪽, 최소 길이, 늘어난 끝과 같은 트랙 도형의 끝단 간격
  for (const jv of s.joints) {
    const o = otherSeg(jv, s);
    if (!o) continue;
    const Lo = graph.L.get(o.layer);
    const F = anchors(o, jv);
    const enc = encHalf(graph, jv, o.layer, o.dir);
    const shapes = colinear(graph, o, world, [s]);
    if (!F.length) {
      // 이 비아뿐인 토막 — 통째로 따라온다. 같은 트랙 도형과 겹치거나 끝단 간격 안으로 들지 않게
      for (const [a0, a1] of shapes) {
        if (a0 >= o.hi - 1e-9) hi = Math.min(hi, s.t + (a0 - Lo.ee - o.hi));
        else if (a1 <= o.lo + 1e-9) lo = Math.max(lo, s.t + (a1 + Lo.ee - o.lo));
      }
      continue;
    }
    const Fmin = Math.min(...F), Fmax = Math.max(...F);
    if (s.t < Fmin) {                                          // 아래쪽 끝이 t 를 따라간다
      const ext = Math.max(o.extLo, enc);
      hi = Math.min(hi, Fmin);
      if (!o.pins.length) hi = Math.min(hi, Fmax + o.extHi + ext - Lo.minL);
      for (const [, a1] of shapes.filter(([, a1]) => a1 <= o.lo + 1e-9)) lo = Math.max(lo, a1 + Lo.ee + ext);
    } else if (s.t > Fmax) {                                   // 위쪽 끝이 t 를 따라간다
      const ext = Math.max(o.extHi, enc);
      lo = Math.max(lo, Fmax);
      if (!o.pins.length) lo = Math.max(lo, Fmin - o.extLo - ext + Lo.minL);
      for (const [a0] of shapes.filter(([a0]) => a0 >= o.hi - 1e-9)) hi = Math.min(hi, a0 - Lo.ee - ext);
    } else { lo = Math.max(lo, Fmin); hi = Math.min(hi, Fmax); }   // 가운데 비아 — 스팬 안에서만
  }
  // 같은 층의 다른 도형 — 이 조각의 실제 뻗침(비아 둘러싸기까지)이 끝단 간격만큼 넓혀 겹치면 간격을 지킨다
  let effLo = s.lo, effHi = s.hi;
  for (const jv of s.joints) {
    const e = encHalf(graph, jv, s.layer, s.dir), a = v ? jv.y : jv.x;
    effLo = Math.min(effLo, a - e); effHi = Math.max(effHi, a + e);
  }
  const span = [effLo - L.ee, effHi + L.ee];
  for (const o of world) {
    if (o.layer !== s.layer) continue;
    const along = v ? [o.rect[1], o.rect[3]] : [o.rect[0], o.rect[2]];
    if (along[1] <= span[0] || along[0] >= span[1]) continue;
    const c = v ? (o.rect[0] + o.rect[2]) / 2 : (o.rect[1] + o.rect[3]) / 2;
    const hw = v ? (o.rect[2] - o.rect[0]) / 2 : (o.rect[3] - o.rect[1]) / 2;
    const gap = s.w / 2 + L.ss + hw;
    if (s.t <= c - gap + 1e-9) hi = Math.min(hi, c - gap);
    else if (s.t >= c + gap - 1e-9) lo = Math.max(lo, c + gap);
    else return lock(`같은 층 도형과 이미 붙어 있다 (${o.net ?? "블록"})`);
  }
  // 이 넷의 다른 조각과도 같은 트랙에서 끝단 간격 (검사기는 넷을 안 가린다)
  for (const q of graph.segs) {
    if (q === s || q.layer !== s.layer) continue;
    const along = [q.lo, q.hi];
    if (along[1] <= span[0] || along[0] >= span[1]) continue;
    const gap = s.w / 2 + L.ss + q.w / 2;
    if (s.t <= q.t - gap + 1e-9) hi = Math.min(hi, q.t - gap);
    else if (s.t >= q.t + gap - 1e-9) lo = Math.max(lo, q.t + gap);
  }
  // 비아 간격 — 같은 비아 층의 다른 비아와 (검사기는 같은 중심선의 비아만 본다)
  for (const jv of s.joints) {
    const vi = graph.drc.Via_info[jv.model];
    const vm = graph.drc.Via_model[jv.model];
    for (const o of world) {
      if (o.kind !== "via" || o.layer !== vm.name) continue;
      const ox = o.x ?? (o.rect[0] + o.rect[2]) / 2, oy = o.y ?? (o.rect[1] + o.rect[3]) / 2;
      const alongSame = v ? Math.abs(oy - jv.y) < 1 : Math.abs(ox - jv.x) < 1;         // 같은 가로/세로 중심선
      const alongNear = v ? Math.abs(oy - jv.y) < vi.width_y + vi.dist_ss_y : Math.abs(ox - jv.x) < vi.width + vi.dist_ss;
      const oc = v ? ox : oy, cur = v ? jv.x : jv.y;
      let gap = 0;
      if (alongSame) gap = v ? vi.width + vi.dist_ss : vi.width_y + vi.dist_ss_y;
      else if (alongNear) gap = 1;                                                     // 같은 중심선에 오지만 마라
      if (!gap) continue;
      const d = cur - s.t;                                                              // 비아는 조각과 같이 움직인다
      if (cur <= oc - gap + 1e-9) hi = Math.min(hi, oc - gap - d);
      else if (cur >= oc + gap - 1e-9) lo = Math.max(lo, oc + gap - d);
    }
  }
  // 모듈 안
  if (bbox) { lo = Math.max(lo, bbox[perp] + s.w / 2); hi = Math.min(hi, bbox[perp + 2] - s.w / 2); }
  if (!(lo <= s.t + 1e-9 && s.t <= hi + 1e-9)) return lock("지금 자리가 규칙 밖이다");
  // 트랙 — 층의 피치 배수 (검사기의 색 규칙도 이것이다)
  const pitch = L.pitch, off = L.offset;
  const k0 = Math.ceil((lo - off) / pitch - 1e-9), k1 = Math.floor((hi - off) / pitch + 1e-9);
  const tracks = [];
  for (let k = k0; k <= k1; k++) tracks.push(off + k * pitch);
  if (!tracks.includes(s.t)) tracks.push(s.t), tracks.sort((a, b) => a - b);
  if (tracks.length <= 1) return { locked: true, why: why.join(", ") || "옮길 트랙이 없다", lo, hi, tracks };
  return { locked: false, why: why.join(", "), lo, hi, tracks };
}

// ---------------------------------------------------------------- 되펴기 (그래프 -> path_metal / path_via)

const pt0 = () => ({ x: 0, y: 0 });
const box0 = () => ({ LL: pt0(), UR: pt0() });

/** 비아 모형으로 비아 하나 (path_via 항목) — 배선기의 ConvertToViaPnRDB_Placed_Placed 와 같은 모양 */
export function viaAt(model, x, y, drc = DRC) {
  const vm = drc.Via_model[model];
  const name = (i) => drc.Metal_info[i]?.name ?? "";
  const rect = (pts) => ({ LL: { x: x + pts[0].x, y: y + pts[0].y }, UR: { x: x + pts[1].x, y: y + pts[1].y } });
  const c = (metal, pts) => ({ metal, originBox: box0(), originCenter: pt0(), placedBox: rect(pts), placedCenter: { x, y } });
  return { model_index: model, originpos: pt0(), placedpos: { x, y },
           UpperMetalRect: c(name(vm.UpperIdx), vm.UpperRect), LowerMetalRect: c(name(vm.LowerIdx), vm.LowerRect), ViaRect: c(vm.name, vm.ViaRect) };
}

/** 그래프 -> { path_metal, path_via } (넷에 다시 넣을 모양) */
export function toNode(graph, drc = DRC) {
  const path_metal = graph.segs.map((s) => {
    const r = segRect(s), v = s.dir === "v";
    return {
      MetalIdx: s.li, width: s.w,
      LinePoint: v ? [{ x: s.t, y: s.lo }, { x: s.t, y: s.hi }] : [{ x: s.lo, y: s.t }, { x: s.hi, y: s.t }],
      MetalRect: { metal: s.layer, originBox: box0(), originCenter: pt0(),
                   placedBox: { LL: { x: r[0], y: r[1] }, UR: { x: r[2], y: r[3] } },
                   placedCenter: { x: Math.trunc((r[0] + r[2]) / 2), y: Math.trunc((r[1] + r[3]) / 2) } },
    };
  });
  const path_via = graph.vias.map((jv) => viaAt(jv.model, jv.x, jv.y, drc));
  return { path_metal, path_via };
}

/** 그래프의 사본 (조각·비아의 연결까지) */
export function cloneGraph(g) {
  const segs = g.segs.map((s) => ({ ...s, joints: [], pins: s.pins, pinAnchors: s.pinAnchors.map((a) => a.slice()) }));
  const vias = g.vias.map((jv) => ({ ...jv, segLower: jv.segLower ? segs[jv.segLower.id] : null, segUpper: jv.segUpper ? segs[jv.segUpper.id] : null }));
  for (const jv of vias) { if (jv.segLower) jv.segLower.joints.push(jv); if (jv.segUpper) jv.segUpper.joints.push(jv); }
  return { ...g, segs, vias };
}

/** 조각 길이 합 (PnRDB 단위) */
export function netLength(g) {
  let s = 0;
  for (const q of g.segs) s += q.hi - q.lo;
  return s;
}

/** 위상 요약 — 조각 수·층·차례, 비아 수 (정돈이 위상을 안 바꿨는지 견준다) */
export function topologyKey(g) {
  const segs = g.segs.map((s) => `${s.layer}:${s.joints.length}:${s.pins.length}`);
  return `${segs.join(" ")}|${g.vias.length}`;
}
