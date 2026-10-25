/** 검사 도우미 — 넷의 배선을 사람이 하듯 점을 찍어 배선기 경로대로 다시 그리는 차례 (src/edit/draw.mjs 로).
 *
 *  edit-draw.mjs (node) 가 셈으로 돌리고, edit-page.mjs (Chromium) 는 같은 차례(steps)를 진짜 마우스·키로 따라 한다.
 *  차례 하나 = { layer, turn, start, end, viaOnly } — 그리기 층과 꺾는 쪽을 맞추고 start 를 클릭한 뒤 end 를 클릭한다
 *  (end 에 이 넷 도형이 있으면 붙어서 끝나고, 없으면 거기서 끝낸다). 좌표는 PnRDB.
 */
import { buildGraph, anchors } from "../../../../src/edit/wires.mjs";
import { DRAW_LAYERS, layerPair, startPoint, planLeg, buildGeometry, pathPlus, netShapes } from "../../../../src/edit/draw.mjs";

export const segKey = (q) => `${q.layer} ${q.t} ${q.lo} ${q.hi}`;
export const viaKey = (v) => `${v.model} ${v.x} ${v.y}`;
/** 두 그래프의 도형이 같나 — 조각(층·트랙·스팬)과 비아(모형·자리)의 집합 */
export function sameShapes(a, b) {
  const s = (g) => [...new Set(g.segs.map(segKey))].sort().join("|"), v = (g) => [...new Set(g.vias.map(viaKey))].sort().join("|");
  return s(a) === s(b) && v(a) === v(b);
}
export const ptOn = (s, a) => (s.dir === "v" ? { x: s.t, y: a, layer: s.layer } : { x: a, y: s.t, layer: s.layer });
export const alongOf = (s, p) => (s.dir === "v" ? p.y : p.x);
export const spanOf = (s) => { const a = anchors(s); return a.length ? [Math.min(...a), Math.max(...a)] : [s.lo, s.hi]; };
export const contains = (q, p) => {
  const perp = q.dir === "v" ? p.x : p.y, along = q.dir === "v" ? p.y : p.x;
  return Math.abs(perp - q.t) < 1 && along >= q.lo - 1e-9 && along <= q.hi + 1e-9;
};
export const li = (layer) => DRAW_LAYERS.indexOf(layer);

/**
 * 넷 하나를 배선기 경로를 따라 다시 그린다 — 사람이 하듯. 조각마다 이미 있는 도형(핀이나 먼저 그린 조각)에서 시작해
 * 반대쪽 끝으로 커서를 옮긴다 (그리기 층 = 그 조각의 층). 끝에 도형이 있으면 붙고 비아가 쌓인다. 비아 스택의 막대
 * (앵커가 한 점인 조각)는 그리지 않는다 — 스택이 만든다. 마지막에 빠진 비아는 "비아만 찍기"(시작 도형 위에서 바로
 * 위·아래 층 도형을 클릭)로 채운다.
 * @returns {{work, g, clicks, drawn, viaOnly, misses: string[], steps}}
 */
export function replay(net, g0, { world, area }) {
  const work = { ...net, path_metal: [], path_via: [] };
  let g = buildGraph(work);
  const misses = [], steps = [];
  let clicks = 0, viaOnly = 0;
  const chain = (p) => {                                       // 배선기에서 p 에 비아로 이어진 층들
    const ls = new Set();
    for (const jv of g0.vias) if (jv.x === p.x && jv.y === p.y) { ls.add(jv.lower); ls.add(jv.upper); }
    return ls;
  };
  const draw = (start, shape, cursor, layer, turn) => {
    steps.push({ layer, turn, start: { x: start.x, y: start.y }, end: { x: cursor.x, y: cursor.y }, viaOnly: false });
    const pair = layerPair(layer, turn);
    const st = startPoint(start, shape, pair);
    if (st.x !== start.x || st.y !== start.y) misses.push(`${net.name}: 시작점 ${start.x},${start.y} -> ${st.x},${st.y}`);
    const shapes = netShapes(work, g);
    const pv = planLeg(st, cursor, { pair, shapes, tol: 2, skip: shape?.key ?? null });
    if (!pv.ok) { misses.push(`${net.name}: ${pv.why}`); return; }
    if (pv.end.x !== cursor.x || pv.end.y !== cursor.y) misses.push(`${net.name}: 끝 ${cursor.x},${cursor.y} -> ${pv.end.x},${pv.end.y}`);
    const geom = buildGeometry([[st, ...pv.nodes]], { mine: shapes, world, area });
    const e = pathPlus(work, geom);
    work.path_metal = e.path_metal; work.path_via = e.path_via;
    g = buildGraph(work);
    clicks += 2;
  };
  /** 조각 s 의 끝 p 에서 시작할 도형 — 배선기가 p 에서 s 와 잇는 층(비아 스택·같은 층 핀)의 도형 가운데 이미 있는 것 */
  const startShape = (s, p) => {
    const ls = chain(p);
    if (s.pinAnchors.some(([a, b]) => alongOf(s, p) >= a - 1e-9 && alongOf(s, p) <= b + 1e-9)) ls.add(s.layer);
    const cands = netShapes(work, g).filter((q) => ls.has(q.layer) && contains(q, p) && !(q.kind === "seg" && q.layer === s.layer));
    cands.sort((a, b) => Math.abs(li(a.layer) - li(s.layer)) - Math.abs(li(b.layer) - li(s.layer)));
    return cands[0] ?? null;
  };
  /** 꺾는 층 — 시작 도형이 나란한 다른 층이면 그쪽으로 (스택이 그 사이 층을 지난다), 아니면 끝에서 비아로 잇는 층 쪽으로 */
  const turnFor = (s, shape, B) => {
    if (shape && shape.dir === s.dir && shape.layer !== s.layer) return li(shape.layer) > li(s.layer) ? "up" : "down";
    const ls = [...chain(B)].filter((l) => l !== s.layer && li(l) >= 0);
    return ls.length && li(ls[0]) < li(s.layer) ? "down" : "up";
  };
  const todo = g0.segs.filter((s) => s.pins.length || new Set(anchors(s)).size > 1);
  const done = new Set();
  for (let guard = 0; done.size < todo.length && guard < 200; guard++) {
    let progress = false;
    for (const s of todo) {
      if (done.has(s)) continue;
      const [lo, hi] = spanOf(s), ends = [ptOn(s, lo), ptOn(s, hi)];
      for (const [A, B] of [[ends[0], ends[1]], [ends[1], ends[0]]]) {
        const sh = startShape(s, A);
        if (!sh) continue;
        draw(A, sh, B, s.layer, turnFor(s, sh, B));
        done.add(s); progress = true;
        break;
      }
    }
    if (!progress) {                                           // 이을 도형이 없다 — 빈 자리에서 (넷을 고른 채) 시작
      const s = todo.find((q) => !done.has(q)), [lo, hi] = spanOf(s);
      draw(ptOn(s, lo), null, ptOn(s, hi), s.layer, turnFor(s, null, ptOn(s, hi)));
      done.add(s);
    }
  }
  // 빠진 비아 — 시작 도형 위에서 그 자리의 다른 층 도형을 클릭하면 비아(스택)가 선다
  for (const jv of g0.vias) {
    if (g.vias.some((q) => q.model === jv.model && q.x === jv.x && q.y === jv.y)) continue;
    const p = { x: jv.x, y: jv.y };
    const here = netShapes(work, g).filter((q) => contains(q, p));
    const lower = here.find((q) => q.layer === jv.lower), upper = here.find((q) => q.layer === jv.upper);
    const from = lower ?? here.find((q) => li(q.layer) < li(jv.lower));
    const to = upper ?? here.find((q) => li(q.layer) > li(jv.upper));
    if (!from || !to) { misses.push(`${net.name}: 비아 ${jv.lower}-${jv.upper} (${p.x},${p.y}) 의 도형이 없다`); continue; }
    const pair = layerPair(from.layer, li(to.layer) > li(from.layer) ? "up" : "down");
    steps.push({ layer: from.layer, turn: pair.turn, start: p, end: p, viaOnly: true });
    const st = startPoint(p, from, pair);
    const pv = planLeg(st, p, { pair, shapes: netShapes(work, g), tol: 2, skip: from.key });
    if (!pv.ok || !pv.target) { misses.push(`${net.name}: 비아만 찍기 실패 ${pv.why ?? "붙을 도형이 없다"}`); continue; }
    const shapes = netShapes(work, g);
    const e = pathPlus(work, buildGeometry([[st, ...pv.nodes]], { mine: shapes, world, area }));
    work.path_metal = e.path_metal; work.path_via = e.path_via;
    g = buildGraph(work);
    clicks += 2; viaOnly++;
  }
  return { work, g, clicks, drawn: done.size, viaOnly, misses, steps };
}

