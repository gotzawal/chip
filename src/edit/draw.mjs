/** 배선 그리기 — 레이아웃 편집기(Synopsys Custom Compiler 의 Create Wire)처럼 층을 골라 점을 찍어 배선을 긋는다.
 *
 *  이 PDK 는 층마다 방향이 하나다 (M1·M3·M5 세로, M2·M4 가로 — 검사기도 그렇게 본다). 그래서 그리기는 **층 짝**으로 한다:
 *  고른 층(그리기 층)의 방향으로 긋는 토막은 그 층에, 수직으로 긋는 토막은 위나 아래 이웃 층(꺾는 층)에 놓고, 층이
 *  바뀌는 점에는 비아를 쌓는다. 사이 층에는 최소 길이 막대가 든다 — 배선기가 비아를 쌓을 때와 같다.
 *
 *    점        모든 점은 트랙 위다 — 토막은 그 층의 트랙에, 끝은 다음에 꺾을 층의 트랙에 (비아가 설 수 있게)
 *    붙기      커서가 이 넷의 도형(핀·조각)에 닿으면 그 위로 붙고, 층이 다르면 비아를 쌓는다 (연결을 아는 그리기)
 *    최소 길이  같은 트랙의 이 넷 도형과 이어도 MinL 에 못 미치는 토막은 늘인다 — 배선기처럼 양쪽 반씩, 안 되면 한쪽으로
 *    규칙      그리는 동안 단락·간격·끝단 간격·폭·비아 간격·경계를 바로 본다 (drdIssues). 마지막 판정은 검사기다
 *
 *  그린 것은 넷의 path_metal / path_via 에 더해져 배선 워커의 재검사(recheck)로 간다 — 조각 옮기기와 같은 길이다.
 *  조각 지우기(deleteSeg), 넷의 연결 덩이와 플라이라인(netComponents), 검사기 오류 줄의 사각형(errorMarks)도 여기 있다.
 *
 *  단위는 PnRDB(nm 의 2 배) — src/edit/wires.mjs 와 같다.
 */
import { LAYERS, DRC, segRect, cloneGraph, toNode } from "./wires.mjs";
import { MOCK_PDK } from "../route/pdk.mjs";

const byLi = new Map([...LAYERS.values()].map((l) => [l.li, l]));
const other = (d) => (d === "h" ? "v" : "h");
const even = (v) => 2 * Math.round(v / 2);

/** 그릴 수 있는 층 — PDK 의 신호 배선 층 (design_info 의 bottom ~ top_signal_routing_layer, M1~M5) */
export const DRAW_LAYERS = (() => {
  const d = MOCK_PDK.design_info;
  const lo = LAYERS.get(d.bottom_signal_routing_layer).li, hi = LAYERS.get(d.top_signal_routing_layer).li;
  return [...LAYERS.values()].filter((l) => l.li >= lo && l.li <= hi).map((l) => l.name);
})();

// ---------------------------------------------------------------- 트랙

export function onTrack(layer, v) {
  const l = LAYERS.get(layer), k = (v - l.offset) / l.pitch;
  return Math.abs(k - Math.round(k)) < 1e-9;
}
export function snapTrack(layer, v) {
  const l = LAYERS.get(layer);
  return l.offset + Math.round((v - l.offset) / l.pitch) * l.pitch;
}
/** [lo, hi] 안에서 v 에 가장 가까운 트랙 — 없으면 null */
function snapIn(layer, v, lo, hi) {
  const l = LAYERS.get(layer);
  const k0 = Math.ceil((lo - l.offset) / l.pitch - 1e-9), k1 = Math.floor((hi - l.offset) / l.pitch + 1e-9);
  if (k0 > k1) return null;
  return l.offset + Math.min(k1, Math.max(k0, Math.round((v - l.offset) / l.pitch))) * l.pitch;
}

/** 층 짝 — { base, turn, h, v }: 가로·세로 토막을 놓을 층. base 의 방향은 base 에, 수직은 위(turn "up") 또는 아래 이웃에.
 *  그 이웃이 그릴 수 있는 층이 아니면 반대쪽 이웃 (M5 는 위가 전원 격자 층이라 아래로 꺾는다). */
export function layerPair(base, turn = "up", allowed = DRAW_LAYERS) {
  const l = LAYERS.get(base);
  const ok = (q) => q && allowed.includes(q.name);
  const up = byLi.get(l.li + 1), down = byLi.get(l.li - 1);
  const partner = turn === "down" ? (ok(down) ? down : ok(up) ? up : null) : (ok(up) ? up : ok(down) ? down : null);
  return { base, turn, [l.dir]: base, [other(l.dir)]: partner?.name ?? null };
}

// ---------------------------------------------------------------- 비아

/** Mk 와 Mk+1 사이 비아 (Via_model 의 번호) */
const viaUp = (li) => DRC.Metal_info[li].upper_via_index;

/** 점 (x, y) 에서 층 a 와 b 를 잇는 비아들과 그 사이 층들 */
export function stackAt(x, y, a, b) {
  const la = LAYERS.get(a).li, lb = LAYERS.get(b).li, lo = Math.min(la, lb), hi = Math.max(la, lb);
  const vias = [], mids = [];
  for (let li = lo; li < hi; li++) vias.push({ model: viaUp(li), x, y });
  for (let li = lo + 1; li < hi; li++) mids.push(byLi.get(li).name);
  return { vias, mids };
}
/** 비아를 쌓을 수 있나 — 점이 거치는 층(양 끝 포함)마다 그 층의 트랙 위여야 한다. 안 되면 까닭 */
export function stackOk(x, y, a, b) {
  const la = LAYERS.get(a).li, lb = LAYERS.get(b).li;
  for (let li = Math.min(la, lb); li <= Math.max(la, lb); li++) {
    const l = byLi.get(li);
    if (!onTrack(l.name, l.dir === "v" ? x : y)) return `${l.name} 트랙이 아니다`;
  }
  return null;
}
/** 비아 하나의 사각형들 — 비아 층의 자름(cut)과 아래·위 금속 둘러싸기 */
export function viaShapes(v) {
  const vm = DRC.Via_model[v.model];
  const r = (pts) => [v.x + pts[0].x, v.y + pts[0].y, v.x + pts[1].x, v.y + pts[1].y];
  return { cut: { layer: vm.name, rect: r(vm.ViaRect) },
           lower: vm.LowerIdx >= 0 ? { layer: DRC.Metal_info[vm.LowerIdx].name, rect: r(vm.LowerRect) } : null,
           upper: vm.UpperIdx >= 0 ? { layer: DRC.Metal_info[vm.UpperIdx].name, rect: r(vm.UpperRect) } : null };
}

// ---------------------------------------------------------------- 넷의 도형

/** 넷의 도형 — 핀(블록 핀 접점)과 조각. { kind, layer, dir, t, lo, hi, w, rect, key } — 트랙 t, 스팬 lo~hi */
export function netShapes(net, graph) {
  const out = [];
  for (const p of net.pins) {
    const l = LAYERS.get(p.layer);
    if (!l) continue;
    const r = p.rect, v = l.dir === "v";
    out.push({ kind: "pin", layer: p.layer, dir: l.dir, t: v ? (r[0] + r[2]) / 2 : (r[1] + r[3]) / 2,
               lo: v ? r[1] : r[0], hi: v ? r[3] : r[2], w: v ? r[2] - r[0] : r[3] - r[1], rect: r, pin: p,
               key: `pin ${p.block}/${p.pin} ${r.join(",")}` });
  }
  for (const s of graph?.segs ?? [])
    out.push({ kind: "seg", layer: s.layer, dir: s.dir, t: s.t, lo: s.lo, hi: s.hi, w: s.w, rect: segRect(s), seg: s,
               key: `seg ${s.layer} ${s.t} ${s.lo} ${s.hi}` });
  return out;
}

/** (x, y) 에서 tol 안에 있는 신호 넷 도형 — 그리기를 어느 넷, 어느 도형에서 시작하나. 도형의 중심선(트랙 위 스팬)에
 *  가장 가까운 것, 같으면 그리기 층(prefer)에 가까운 층, 그다음 작은 것. 트랙이 촘촘해 이웃 넷이 tol 안에 들어도 누른
 *  도형이 잡힌다. */
export function shapeAt(model, graphs, x, y, tol = 0, prefer = null) {
  const pl = prefer && LAYERS.has(prefer) ? LAYERS.get(prefer).li : null;
  const less = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  let best = null, bestK = null;
  for (const n of model.nets) {
    for (const s of netShapes(n, graphs.get(n.name))) {
      const r = s.rect;
      if (x < r[0] - tol || x > r[2] + tol || y < r[1] - tol || y > r[3] + tol) continue;
      const along = s.dir === "v" ? y : x, perp = s.dir === "v" ? x : y;
      const k = [Math.round(Math.hypot(perp - s.t, Math.max(0, s.lo - along, along - s.hi))),
                 pl == null ? 0 : Math.abs(LAYERS.get(s.layer).li - pl), (r[2] - r[0]) * (r[3] - r[1])];
      if (!bestK || less(k, bestK) < 0) { bestK = k; best = { ...s, net: n.name }; }
    }
  }
  return best;
}

// ---------------------------------------------------------------- 점 찍기

/** 그리기 시작점. 도형 위면 그 트랙 위에서 — 따라가는 좌표는 수직으로 꺾을 층의 트랙에 맞추고 도형의 스팬 안에서
 *  (도형이 짧아 못 맞추면 커서 자리). 비아 중심은 도형 끝까지 갈 수 있다 — 배선기도 핀·조각의 끝에 비아를 둔다 (둘러싸기는
 *  비아의 금속이 채운다). 빈 자리면 짝의 두 층 트랙이 만나는 점, 층은 그리기 층. */
export function startPoint(cursor, shape, pair) {
  if (shape) {
    const cross = pair[other(shape.dir)], want = shape.dir === "h" ? cursor.x : cursor.y;
    let a = null;
    if (cross) a = snapIn(cross, want, shape.lo, shape.hi);
    if (a == null) a = even(Math.min(shape.hi, Math.max(shape.lo, want)));
    return shape.dir === "h" ? { x: a, y: shape.t, layer: shape.layer } : { x: shape.t, y: a, layer: shape.layer };
  }
  return { x: pair.v ? snapTrack(pair.v, cursor.x) : even(cursor.x), y: pair.h ? snapTrack(pair.h, cursor.y) : even(cursor.y),
           layer: pair.base };
}

/** 토막의 선(방향 dir, 트랙 c, 층 layer) 위에서 커서 가까이 붙을 이 넷의 도형 — { along, layer, key, shape } */
function snapOnLine(dir, c, layer, cursor, shapes, tol, skip) {
  const want = dir === "h" ? cursor.x : cursor.y, side = Math.abs((dir === "h" ? cursor.y : cursor.x) - c);
  let best = null, bestD = Infinity;
  for (const s of shapes) {
    if (skip && s.key === skip) continue;
    let along;
    if (s.dir !== dir) {
      // 수직 도형 — 선이 그 도형을 지나는 자리
      if (c < s.lo - 1e-9 || c > s.hi + 1e-9) continue;
      along = s.t;
    } else {
      if (Math.abs(s.t - c) > 1) continue;                                   // 다른 트랙
      if (s.layer === layer) along = even(Math.min(s.hi, Math.max(s.lo, want)));   // 같은 층 — 닿으면 이어진다
      else {
        // 나란한 다른 층 — 도형 쪽 이웃 층(수직 방향)의 트랙에서 비아를 쌓는다
        const ls = LAYERS.get(s.layer).li, mid = byLi.get(ls + Math.sign(LAYERS.get(layer).li - ls));
        along = snapIn(mid.name, want, s.lo, s.hi);
        if (along == null) continue;
      }
    }
    const r = s.rect, dAlong = Math.abs(along - want);
    const over = cursor.x >= r[0] - tol && cursor.x <= r[2] + tol && cursor.y >= r[1] - tol && cursor.y <= r[3] + tol;
    if (!over && Math.hypot(dAlong, side) > tol) continue;
    // 가까운 자리, 같으면 비아가 적게 드는 도형 (같은 층이 먼저)
    const d = dAlong + 0.5 * Math.abs(LAYERS.get(s.layer).li - LAYERS.get(layer).li);
    if (d < bestD) { bestD = d; best = { along, layer: s.layer, key: s.key, shape: s }; }
  }
  return best;
}

/**
 * 마지막 점 cur 에서 커서 쪽으로 곧은 토막 하나 — 많이 움직인 쪽(가로나 세로)으로. 놓을 층은 짝이 정하고, cur 의 층과
 * 다르면 cur 에 비아를 쌓는다. 커서가 이 넷의 도형에 닿으면 그 위로 붙는다 (target): 수직 도형은 선이 지나는 자리,
 * 나란한 도형은 같은 트랙일 때 그 스팬 안. 층이 다르면 끝에서 그 도형의 층까지 비아를 쌓는다.
 * 안 붙으면 끝은 다음에 꺾을 층의 트랙에 맞춘다.
 *
 * @param {{x,y,layer}} cur
 * @param {{x,y}} cursor
 * @param {{pair, shapes?, tol?, skip?}} o   shapes 는 netShapes 의 것, skip 은 붙지 않을 도형 열쇠 (시작 도형)
 * @returns {{ok, why, dir, layer, nodes: Array<{x,y,layer}>, end, target}}   nodes 는 cur 뒤에 붙일 점들
 */
export function planLeg(cur, cursor, { pair, shapes = [], tol = 0, skip = null }) {
  const dir = Math.abs(cursor.x - cur.x) >= Math.abs(cursor.y - cur.y) ? "h" : "v";
  const layer = pair[dir];
  const fail = (why) => ({ ok: false, why, dir, layer, nodes: [], end: null, target: null });
  if (!layer) return fail(`${dir === "h" ? "가로" : "세로"}로 놓을 층이 없다`);
  const c = dir === "h" ? cur.y : cur.x, from = dir === "h" ? cur.x : cur.y;
  if (!onTrack(layer, c)) return fail(`이 점은 ${layer} 트랙 위가 아니다`);
  // 붙는 거리는 다음 꺾을 층 트랙 간격의 반까지 — 격자에 맞추는 것과 같은 칸 안에서만 붙는다 (작게 보면 화면 몇 px 가 트랙 여럿이다)
  const nx = pair[other(dir)];
  const target = snapOnLine(dir, c, layer, cursor, shapes, Math.min(tol, LAYERS.get(nx ?? layer).pitch / 2), skip);
  let a;
  if (target) a = target.along;
  else a = nx ? snapTrack(nx, dir === "h" ? cursor.x : cursor.y) : even(dir === "h" ? cursor.x : cursor.y);
  const end = dir === "h" ? { x: a, y: c } : { x: c, y: a };
  const nodes = [];
  if (a !== from) {
    if (cur.layer !== layer) {
      const bad = stackOk(cur.x, cur.y, cur.layer, layer);
      if (bad) return fail(`여기서 ${cur.layer} -> ${layer} 비아를 못 쌓는다 (${bad})`);
      nodes.push({ x: cur.x, y: cur.y, layer });
    }
    nodes.push({ ...end, layer });
    if (target && target.layer !== layer) {
      const bad = stackOk(end.x, end.y, layer, target.layer);
      if (bad) return fail(`${target.layer} 도형에 비아를 못 쌓는다 (${bad})`);
      nodes.push({ ...end, layer: target.layer });
    }
  } else if (target && target.layer !== cur.layer) {
    const bad = stackOk(cur.x, cur.y, cur.layer, target.layer);
    if (bad) return fail(`${target.layer} 도형에 비아를 못 쌓는다 (${bad})`);
    nodes.push({ x: cur.x, y: cur.y, layer: target.layer });
  }
  return { ok: true, why: null, dir, layer, nodes, end: { ...end, layer: target ? target.layer : layer }, target };
}

// ---------------------------------------------------------------- 도형 만들기

/** 같은 층·트랙에서 s 와 (줄줄이) 닿는 도형들까지 합친 스팬 */
function mergedSpan(s, others) {
  const same = others.filter((o) => o !== s && o.layer === s.layer && Math.abs(o.t - s.t) < 1);
  let lo = s.lo, hi = s.hi, grew = true;
  while (grew) {
    grew = false;
    for (const o of same)
      if (o.lo <= hi && o.hi >= lo && (o.lo < lo || o.hi > hi)) { lo = Math.min(lo, o.lo); hi = Math.max(hi, o.hi); grew = true; }
  }
  return [lo, hi];
}

/**
 * 최소 길이로 늘이기 — 배선기(dr/astar.rs 의 CheckExendable_*)처럼 양쪽으로 반씩, 안 되면 위(오른)쪽, 그것도 안 되면
 * 아래(왼)쪽으로 한 번에. 안 되는 것: 배치 영역(area — 배선기 격자) 밖, 같은 트랙에서 다른 도형(world)과 겹치거나 끝단 간격
 * 안, 이 넷 도형(mine)과 끝단 간격 안 (닿으면 이어지니 괜찮다). 셋 다 안 되면 양쪽으로 — 규칙 검사가 알린다.
 */
function extendLeg(s, { mine, world, area }) {
  const L = LAYERS.get(s.layer), v = s.dir === "v";
  const m = even((s.lo + s.hi) / 2);
  const cands = [[Math.min(s.lo, m - L.minL / 2), Math.max(s.hi, m + L.minL / 2)], [s.lo, s.lo + L.minL], [s.hi - L.minL, s.hi]];
  const track = (o) => {
    const r = o.rect, c = v ? (r[0] + r[2]) / 2 : (r[1] + r[3]) / 2, w = v ? r[2] - r[0] : r[3] - r[1];
    return Math.abs(c - s.t) < (w + s.w) / 2 ? (v ? [r[1], r[3]] : [r[0], r[2]]) : null;
  };
  const near = (a, b, [lo, hi]) => lo < b + L.ee && hi > a - L.ee;
  const blocked = ([a, b]) => {
    if (area && (a < area[v ? 1 : 0] || b > area[v ? 3 : 2])) return true;
    for (const o of world ?? []) {
      if (o.layer !== s.layer) continue;
      const sp = track(o);
      if (sp && near(a, b, sp) && !near(s.lo, s.hi, sp)) return true;      // 늘인 자리에서 새로 부딪힌다
    }
    for (const o of mine) {
      if (o.layer !== s.layer || Math.abs(o.t - s.t) >= 1) continue;
      const gap = Math.max(o.lo - b, a - o.hi);
      if (gap > 0 && gap < L.ee) return true;
    }
    return false;
  };
  const [a, b] = cands.find((c) => !blocked(c)) ?? cands[0];
  s.lo = a; s.hi = b;
}

/**
 * 그린 점들 -> 넷에 더할 도형. paths 는 점 줄의 배열이다 (그리기 하나가 줄 하나).
 *   같은 층의 이웃한 두 점은 토막, 같은 자리의 두 층은 비아 스택 (사이 층에는 길이 0 토막). 점 하나뿐인 줄도 길이 0 토막.
 *   같은 층·트랙에서 닿는 토막은 잇고, 같은 트랙의 이 넷 도형(mine: 핀·조각)과 이어서도 MinL 에 못 미치면 토막을
 *   MinL 로 늘인다 — 배선기의 규칙이다 (비아 둘러싸기는 길이에 안 친다, 늘이는 쪽은 extendLeg). 늘일 것 없는 길이 0 토막은 뺀다.
 * @param {object} [o]  { mine: netShapes, world: worldShapes (늘이는 쪽을 고를 때), area: 배치 영역 }
 * @returns {{legs, vias, path_metal, path_via}}   legs 는 조각 모양 (layer, li, dir, t, lo, hi, w)
 */
export function buildGeometry(paths, { mine = [], world = null, area = null } = {}) {
  const raw = [], vias = [];
  const dot = (p, layer) => {
    const l = LAYERS.get(layer), v = l.dir === "v", a = v ? p.y : p.x;
    raw.push({ layer, li: l.li, dir: l.dir, t: v ? p.x : p.y, lo: a, hi: a, w: l.w });
  };
  for (const nodes of paths) {
    if (nodes.length === 1) dot(nodes[0], nodes[0].layer);
    for (let i = 1; i < nodes.length;) {
      const a = nodes[i - 1], b = nodes[i];
      if (a.layer === b.layer) {
        i++;
        if (a.x === b.x && a.y === b.y) continue;
        const l = LAYERS.get(a.layer), v = l.dir === "v";
        if (v ? a.x !== b.x : a.y !== b.y) throw new Error(`${a.layer} 토막이 층 방향(${v ? "세로" : "가로"})이 아니다`);
        const p = v ? a.y : a.x, q = v ? b.y : b.x;
        raw.push({ layer: l.name, li: l.li, dir: l.dir, t: v ? a.x : a.y, lo: Math.min(p, q), hi: Math.max(p, q), w: l.w });
      } else {
        if (a.x !== b.x || a.y !== b.y) throw new Error(`층이 바뀌는 자리가 어긋났다 (${a.layer} -> ${b.layer})`);
        // 같은 자리에서 층이 잇달아 바뀌면 (M2 -> M3 -> M4) 스택 하나 — 지나가기만 하는 층에 막대가 든다
        let k = i;
        while (k + 1 < nodes.length && nodes[k + 1].x === a.x && nodes[k + 1].y === a.y && nodes[k + 1].layer !== nodes[k].layer) k++;
        const st = stackAt(a.x, a.y, a.layer, nodes[k].layer);
        vias.push(...st.vias);
        for (const m of st.mids) dot(a, m);
        i = k + 1;
      }
    }
  }
  // 같은 층·트랙에서 닿는 토막은 하나로
  const legs = [], byTrack = new Map();
  for (const s of raw) { const k = `${s.layer}|${s.t}`; if (!byTrack.has(k)) byTrack.set(k, []); byTrack.get(k).push(s); }
  for (const list of byTrack.values()) {
    list.sort((p, q) => p.lo - q.lo);
    let cur = null;
    for (const s of list) {
      if (cur && s.lo <= cur.hi) cur.hi = Math.max(cur.hi, s.hi);
      else { cur = { ...s }; legs.push(cur); }
    }
  }
  // 최소 길이 — 이어진 스팬이 MinL 에 못 미치면 토막을 늘인다
  const keep = [];
  for (const s of legs) {
    const [lo, hi] = mergedSpan(s, [...mine, ...legs]);
    if (hi - lo < LAYERS.get(s.layer).minL) extendLeg(s, { mine, world, area });
    if (s.hi > s.lo) keep.push(s);
  }
  const seen = new Set(), vs = [];
  for (const v of vias) { const k = `${v.model},${v.x},${v.y}`; if (!seen.has(k)) { seen.add(k); vs.push(v); } }
  keep.forEach((s, i) => { s.id = i; });
  const { path_metal, path_via } = toNode({ segs: keep, vias: vs });
  return { legs: keep, vias: vs, path_metal, path_via };
}

/** 넷의 지금 경로에 그린 도형을 더한 편집 { net, path_metal, path_via } — 넷에 이미 있는 비아는 다시 넣지 않는다 */
export function pathPlus(net, geom) {
  const k = (v) => `${v.model_index},${v.placedpos.x},${v.placedpos.y}`;
  const has = new Set(net.path_via.map(k));
  return { net: net.name, path_metal: [...net.path_metal, ...geom.path_metal],
           path_via: [...net.path_via, ...geom.path_via.filter((v) => !has.has(k(v)))] };
}

/** 그린 도형의 길이 합 (PnRDB) */
export function geomLength(geom) {
  return geom.legs.reduce((s, q) => s + q.hi - q.lo, 0);
}

// ---------------------------------------------------------------- 지우기

/**
 * 조각 하나를 지운 그래프. 그 조각에 닿은 비아와, 그 때문에 한쪽이 비게 된 비아(쌓인 비아를 따라), 아무 데도 안 닿게 된
 * 조각까지 같이 지운다 — 혼자 남은 비아의 둘러싸기는 최소 길이 오류일 뿐이다. 한쪽 끝만 남은 조각은 둔다 (다시 그려 잇는다).
 * @returns {{graph, segs: number, vias: number}}   지운 조각·비아 수
 */
export function deleteSeg(graph, segId) {
  const g = cloneGraph(graph);
  const gone = new Set(), dead = new Set();
  const side = (jv, layer, seg, pin) => (seg && !gone.has(seg)) || !!pin ||
    g.vias.some((o) => o !== jv && !dead.has(o) && o.x === jv.x && o.y === jv.y && (o.lower === layer || o.upper === layer));
  const held = (jv) => side(jv, jv.lower, jv.segLower, jv.pinLower) && side(jv, jv.upper, jv.segUpper, jv.pinUpper);
  const live = (s) => s.pins.length || s.joints.some((jv) => !dead.has(jv));
  // 지우기 전부터 한쪽이 빈 비아·떠 있던 조각은 이 지우기와 상관없다 — 건드리지 않는다
  const loose = new Set([...g.vias.filter((jv) => !held(jv)), ...g.segs.filter((s) => !live(s))]);
  gone.add(g.segs[segId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const jv of g.vias) if (!dead.has(jv) && !loose.has(jv) && !held(jv)) { dead.add(jv); changed = true; }
    for (const s of g.segs) if (!gone.has(s) && !loose.has(s) && !live(s)) { gone.add(s); changed = true; }
  }
  const segs = g.segs.filter((s) => !gone.has(s)), vias = g.vias.filter((jv) => !dead.has(jv));
  segs.forEach((s, i) => { s.id = i; s.joints = s.joints.filter((jv) => !dead.has(jv)); });
  vias.forEach((jv, i) => { jv.id = i; });
  return { graph: { ...g, segs, vias }, segs: gone.size, vias: dead.size };
}

// ---------------------------------------------------------------- 연결 덩이와 플라이라인

/** 두 사각형의 가장 가까운 두 점과 맨해튼 거리 */
function closest(r, q) {
  const span = (a0, a1, b0, b1) => {
    if (a1 < b0) return [a1, b0];
    if (b1 < a0) return [a0, b1];
    const m = (Math.max(a0, b0) + Math.min(a1, b1)) / 2;
    return [m, m];
  };
  const [x1, x2] = span(r[0], r[2], q[0], q[2]), [y1, y2] = span(r[1], r[3], q[1], q[3]);
  return { a: [x1, y1], b: [x2, y2], d: Math.abs(x2 - x1) + Math.abs(y2 - y1) };
}

/**
 * 넷의 연결 덩이 — 핀(같은 블록·같은 핀의 접점은 블록 안에서 이어져 있다), 조각, 비아를 잇는다. 같은 층·같은 중심선에서
 * 닿는 핀끼리도 (붙어 놓인 블록). 덩이가 둘 이상이면 열려 있다 (검사기의 OPEN).
 * 플라이라인은 덩이끼리 가장 가까운 도형을 잇는 최소 신장 트리다 — 덩이 수 - 1 개.
 * @returns {{comps: number, lines: Array<{a:number[], b:number[], d:number, ca:number, cb:number}>, pinComp: number[], segComp: number[]}}
 *          좌표는 PnRDB. pinComp / segComp 는 graph.pins / graph.segs 차례로 덩이 번호, ca / cb 는 선 양 끝의 덩이
 */
export function netComponents(net, graph) {
  const rects = [], parent = [];
  const add = (r) => { rects.push(r); parent.push(parent.length); return rects.length - 1; };
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const pins = graph?.pins ?? net.pins;
  const pinIdx = new Map(), byKey = new Map();
  for (const p of pins) {
    const i = add(p.rect);
    pinIdx.set(p, i);
    const k = `${p.block}/${p.pin}`;
    if (byKey.has(k)) union(i, byKey.get(k)); else byKey.set(k, i);
  }
  for (let i = 0; i < pins.length; i++)
    for (let j = i + 1; j < pins.length; j++) {
      const a = pins[i], b = pins[j], l = LAYERS.get(a.layer);
      if (a.layer !== b.layer || !l) continue;
      const v = l.dir === "v", ra = a.rect, rb = b.rect;
      const same = v ? ra[0] + ra[2] === rb[0] + rb[2] : ra[1] + ra[3] === rb[1] + rb[3];
      const touch = v ? ra[1] <= rb[3] && rb[1] <= ra[3] : ra[0] <= rb[2] && rb[0] <= ra[2];
      if (same && touch) union(pinIdx.get(a), pinIdx.get(b));
    }
  const segs = graph?.segs ?? [], vias = graph?.vias ?? [];
  const segIdx = segs.map((s) => add(segRect(s)));
  segs.forEach((s, k) => { for (const p of s.pins) if (pinIdx.has(p)) union(segIdx[k], pinIdx.get(p)); });
  const real = rects.length;                                 // 핀과 조각까지 — 비아만 있는 덩이는 덩이로 안 센다
  const viaIdx = vias.map((jv) => add([jv.x, jv.y, jv.x, jv.y]));
  vias.forEach((jv, k) => {
    const i = viaIdx[k];
    for (const s of [jv.segLower, jv.segUpper]) if (s && segs[s.id] === s) union(i, segIdx[s.id]);
    for (const p of [jv.pinLower, jv.pinUpper]) if (p && pinIdx.has(p)) union(i, pinIdx.get(p));
    for (let q = k + 1; q < vias.length; q++) {
      const o = vias[q];
      if (o.x === jv.x && o.y === jv.y && [o.lower, o.upper].some((ly) => ly === jv.lower || ly === jv.upper)) union(i, viaIdx[q]);
    }
  });
  const groups = new Map();
  for (let i = 0; i < real; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  const comps = [...groups.values()];
  const compOf = new Map();
  comps.forEach((c, k) => { for (const i of c) compOf.set(i, k); });
  // Prim — 덩이 사이 거리는 가장 가까운 도형 쌍
  const lines = [];
  if (comps.length > 1) {
    const pair = (A, B) => {
      let best = null;
      for (const i of A) for (const j of B) { const c = closest(rects[i], rects[j]); if (!best || c.d < best.d) best = c; }
      return best;
    };
    const inTree = [0], rest = comps.map((_, i) => i).slice(1);
    while (rest.length) {
      let best = null, bk = -1, bt = -1;
      for (const t of inTree)
        for (let k = 0; k < rest.length; k++) { const c = pair(comps[t], comps[rest[k]]); if (!best || c.d < best.d) { best = c; bk = k; bt = t; } }
      lines.push({ ...best, ca: bt, cb: rest[bk] });
      inTree.push(rest[bk]); rest.splice(bk, 1);
    }
  }
  return { comps: comps.length, lines, pinComp: pins.map((p) => compOf.get(pinIdx.get(p))), segComp: segIdx.map((i) => compOf.get(i)) };
}

// ---------------------------------------------------------------- 그리는 동안의 규칙

/** 넷의 다른 도형 (규칙 검사용) — 핀, 조각, 비아의 둘러싸기 금속과 자름 */
export function netRuleShapes(net, graph) {
  const metals = netShapes(net, graph).map((s) => ({ layer: s.layer, rect: s.rect }));
  const cuts = [];
  for (const jv of graph?.vias ?? []) {
    const vs = viaShapes(jv);
    cuts.push(vs.cut);
    for (const m of [vs.lower, vs.upper]) if (m) metals.push(m);
  }
  return { metals, cuts };
}

/** 세상 도형을 이 넷 것과 남의 것으로 — 블록 내부 금속은 넷 이름이 없다. 이 넷 도형(metals)과 같은 중심선에서 닿는 것은
 *  그 도형의 일부다: 리프의 핀 막대가 핀 접점과 넷 이름 없는 내부 금속으로 겹쳐 들어 있다 (검사기에서는 같은 넷 이름이다). */
export function splitWorld(world, metals) {
  const shape = (layer, r) => {
    const v = LAYERS.get(layer).dir === "v";
    return { c: v ? (r[0] + r[2]) / 2 : (r[1] + r[3]) / 2, lo: v ? r[1] : r[0], hi: v ? r[3] : r[2] };
  };
  const sameLine = (a, b) => {
    if (a.layer !== b.layer || !LAYERS.has(a.layer)) return false;
    const A = shape(a.layer, a.rect), B = shape(b.layer, b.rect);
    return Math.abs(A.c - B.c) < 1 && B.lo <= A.hi && A.lo <= B.hi;
  };
  const ours = [], others = [];
  for (const o of world) (o.net == null && metals.some((p) => sameLine(p, o)) ? ours : others).push(o);
  return { ours, others };
}

/**
 * 그리는 동안의 규칙 — 검사기(check.mjs)가 볼 것 가운데 자리에서 바로 아는 것. 그린 도형(geom: buildGeometry 의 것)의
 * 금속·비아를 세상(world: worldShapes 의 것 — 이 넷 말고 전부)과 이 넷의 다른 도형(mine: netRuleShapes)에 댄다.
 *   단락   다른 넷(또는 블록 내부 금속)의 같은 층 도형과 겹치거나 닿는다
 *   간격   같은 층에서 나란히 있으며 폭/2 + 간격 + 폭/2 보다 가깝다
 *   끝단   같은 중심선의 도형을 검사기처럼 이어 붙인 뒤, 내 도형이 낀 사이가 EndToEnd 보다 좁다 (넷을 안 가린다).
 *          뒤쪽 도형이 리프의 Boundary 영역(regions) 안이면 안 본다 — 검사기와 같다
 *   폭     같은 중심선에 폭이 다른 도형이 있다 (검사기의 DIFFERENT WIDTH 는 떨어져 있어도 본다)
 *   비아   같은 비아 층의 같은 중심선에서 비아 간격이 모자란다
 *   경계   모듈 밖
 * 블록 내부 금속 가운데 이 넷 도형의 일부인 것은 이 넷 것으로 본다 (splitWorld).
 * @returns {Array<{kind, msg, at: number[], rect: number[]|null}>}   at 은 내 사각형, rect 는 부딪힌 것 (PnRDB)
 */
export function drdIssues(geom, { world = [], mine = { metals: [], cuts: [] }, bbox = null, regions = [] } = {}) {
  const out = [], seen = new Set();
  const push = (kind, msg, at, rect) => {
    const k = `${kind} ${(rect ?? at).join(",")}`;
    if (!seen.has(k)) { seen.add(k); out.push({ kind, msg, at, rect }); }
  };
  const metals = geom.legs.map((s) => ({ layer: s.layer, rect: segRect(s) })), cuts = [];
  for (const v of geom.vias) {
    const vs = viaShapes(v);
    cuts.push({ ...vs.cut, model: v.model });
    for (const m of [vs.lower, vs.upper]) if (m) metals.push(m);
  }
  const shape = (layer, r) => {
    const v = LAYERS.get(layer).dir === "v";
    return { c: v ? (r[0] + r[2]) / 2 : (r[1] + r[3]) / 2, w: v ? r[2] - r[0] : r[3] - r[1], lo: v ? r[1] : r[0], hi: v ? r[3] : r[2] };
  };
  const nm = (v) => v / 2;                                   // PnRDB -> PDK (문구)
  const split = splitWorld(world, mine.metals), ours = [...mine.metals, ...split.ours], others = split.others;
  for (const me of metals) {
    const L = LAYERS.get(me.layer), A = shape(me.layer, me.rect);
    if (bbox && (me.rect[0] < bbox[0] || me.rect[1] < bbox[1] || me.rect[2] > bbox[2] || me.rect[3] > bbox[3]))
      push("경계", `${me.layer} 모듈 밖`, me.rect, null);
    for (const o of others) {
      if (o.layer !== me.layer) continue;
      const B = shape(o.layer, o.rect), same = Math.abs(A.c - B.c) < 1;
      const perp = Math.abs(A.c - B.c) - (A.w + B.w) / 2, along = Math.max(B.lo - A.hi, A.lo - B.hi);
      const who = o.net ?? "블록";
      if (same && A.w !== B.w) push("폭", `${me.layer} 같은 중심선에 폭이 다른 도형 (${who})`, me.rect, o.rect);
      if (perp <= 0 && along <= 0) push("단락", o.net ? `${me.layer} ${o.net} 와 단락` : `${me.layer} 블록 도형과 닿는다`, me.rect, o.rect);
      else if (!same && along < 0 && perp < L.ss) push("간격", `${me.layer} 간격 ${nm(perp)} < ${nm(L.ss)} (${who})`, me.rect, o.rect);
    }
    for (const o of ours) {
      if (o.layer !== me.layer) continue;
      const B = shape(o.layer, o.rect);
      if (Math.abs(A.c - B.c) < 1 && A.w !== B.w) push("폭", `${me.layer} 같은 중심선에 폭이 다른 이 넷 도형`, me.rect, o.rect);
    }
  }
  // 끝단 간격 — 중심선마다 도형을 이어 붙이고 (이 넷 도형이 다리를 놓으면 사이가 없다) 내 도형이 낀 사이를 잰다
  const lines = new Map();
  const add = (o, fresh) => {
    const A = shape(o.layer, o.rect), k = `${o.layer}|${A.c}`;
    if (!fresh && !lines.has(k)) return;
    if (!lines.has(k)) lines.set(k, []);
    lines.get(k).push({ lo: A.lo, hi: A.hi, fresh, rect: o.rect, who: o.net ?? null });
  };
  for (const me of metals) add(me, true);
  for (const o of [...ours, ...others]) if (LAYERS.has(o.layer)) add(o, false);
  const inRegion = (r) => regions.some((g) => g[0] <= r[0] && r[2] <= g[2] && g[1] <= r[1] && r[3] <= g[3]);
  for (const [k, list] of lines) {
    const L = LAYERS.get(k.split("|")[0]);
    list.sort((p, q) => p.lo - q.lo);
    const groups = [];
    for (const it of list) {
      const g = groups[groups.length - 1];
      if (g && it.lo <= g.hi) { g.hi = Math.max(g.hi, it.hi); g.items.push(it); }
      else groups.push({ lo: it.lo, hi: it.hi, items: [it] });
    }
    for (let i = 0; i + 1 < groups.length; i++) {
      const a = groups[i], b = groups[i + 1], gap = b.lo - a.hi;
      if (!(gap > 0 && gap < L.ee)) continue;
      const rb = b.items.map((q) => q.rect).reduce((p, q) => [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[2], q[2]), Math.max(p[3], q[3])]);
      if (inRegion(rb)) continue;
      const fa = a.items.find((q) => q.fresh), fb = b.items.find((q) => q.fresh);
      if (!fa && !fb) continue;
      const near = fa ? b.items.reduce((p, q) => (q.lo < p.lo ? q : p)) : a.items.reduce((p, q) => (q.hi > p.hi ? q : p));
      push("끝단", `${L.name} 끝단 간격 ${nm(gap)} < ${nm(L.ee)} (${near.fresh ? "그린 것" : near.who ?? "블록·이 넷"})`, (fa ?? fb).rect, near.rect);
    }
  }
  for (const cu of cuts) {
    const vi = DRC.Via_info[cu.model], r = cu.rect;
    for (const o of [...world, ...mine.cuts]) {
      if (o.layer !== cu.layer) continue;
      const q = o.rect;
      if (q[0] === r[0] && q[1] === r[1] && q[2] === r[2] && q[3] === r[3]) continue;   // 같은 비아
      if (r[0] + r[2] === q[0] + q[2]) {
        const g = Math.max(q[1] - r[3], r[1] - q[3]);
        if (g > 0 && g < vi.dist_ss_y) push("비아", `${cu.layer} 세로 간격 ${nm(g)} < ${nm(vi.dist_ss_y)}`, r, q);
      }
      if (r[1] + r[3] === q[1] + q[3]) {
        const g = Math.max(q[0] - r[2], r[0] - q[2]);
        if (g > 0 && g < vi.dist_ss) push("비아", `${cu.layer} 가로 간격 ${nm(g)} < ${nm(vi.dist_ss)}`, r, q);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 검사기 오류의 자리

/**
 * 검사기 오류 줄(errorLines 의 글자) -> 그림에 그릴 표식. 줄에 찍힌 사각형 [x0, y0, x1, y1] 을 모은다 (PDK 단위 —
 * 격자 문구는 2 배 단위로 찍히므로 반으로). OPEN 은 뺀다 — 플라이라인이 보인다.
 * @returns {Array<{kind: "short"|"width"|"drc", rects: number[][], text}>}
 */
export function errorMarks(lines) {
  const out = [];
  for (const text of lines ?? []) {
    if (text.startsWith("OPEN ")) continue;
    const twice = /Off grid|not a multiple of 2/.test(text);
    const rects = [];
    for (const m of text.matchAll(/\[(-?\d+), (-?\d+), (-?\d+), (-?\d+)\]/g)) {
      const r = m.slice(1, 5).map(Number);
      rects.push(twice ? r.map((v) => v / 2) : r);
    }
    if (!rects.length) continue;
    out.push({ kind: text.startsWith("SHORT") ? "short" : text.startsWith("DIFFERENT WIDTH") ? "width" : "drc", rects, text });
  }
  return out;
}
