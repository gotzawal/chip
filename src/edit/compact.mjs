/** 정돈 — 위상을 유지한 채 배선을 짧게.
 *
 *  넷의 조각 그래프(src/edit/wires.mjs)를 두고 조각의 트랙 좌표만 다시 고른다. 조각의 수·층·차례, 비아, 핀 접속은
 *  그대로다 (topologyKey 가 같다). 조각마다 옮길 수 있는 범위(range — 핀, 이웃의 최소 길이와 끝단 간격, 같은 층 간격,
 *  비아 간격, 경계)를 구해 그 안의 트랙 가운데 넷의 길이 합이 가장 짧아지는 곳으로 미끄러뜨리고, 아무 조각도 안
 *  움직일 때까지 되풀이한다 — 좌표하강이다. 조각이 수십 개라 ms 단위다.
 *
 *  LP 로 한 번에 푸는 판(PLAN-edit.md 4.6 절)은 조각이 트랙을 바꾸면 같은 트랙의 도형이 바뀌어 간격 제약이 선형이
 *  아니다. 좌표하강은 조각마다 range 를 다시 재므로 그 문제가 없고, 옮길 수 있다고 판정한 자리만 간다. 마지막 판정은
 *  검사기다 — 부르는 쪽(편집기)이 오류가 늘면 되돌린다.
 */
import { range, slide, cloneGraph, worldShapes, netLength, topologyKey } from "./wires.mjs";

/**
 * 넷 하나를 정돈한다. 다른 넷은 지금 그래프(graphs)대로 고정이다.
 * @returns {{ nets: [{net, g, moves, before, after}], before, after }}
 */
export function compactNet(model, graphs, net, { passes = 12 } = {}) {
  const g0 = graphs.get(net);
  const g = cloneGraph(g0);
  const world = worldShapes(model, graphs, net);
  const before = netLength(g0);
  let moves = 0;
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (const s of g.segs) {
      const r = range(g, s, world, model.bbox);
      if (r.locked) continue;
      let bestT = s.t, bestL = netLength(g);
      for (const t of r.tracks) {
        if (t === s.t) continue;
        const g2 = cloneGraph(g);
        slide(g2, g2.segs[s.id], t);
        const L = netLength(g2);
        if (L < bestL - 1e-9) { bestL = L; bestT = t; }
      }
      if (bestT !== s.t) { slide(g, s, bestT); moves++; changed = true; }
    }
    if (!changed) break;
  }
  const after = netLength(g);
  if (topologyKey(g) !== topologyKey(g0)) throw new Error(`정돈이 ${net} 의 위상을 바꿨다`);
  return { nets: [{ net, g, moves, before, after }], before, after };
}

/** 넷 전부를 차례로 — 앞 넷의 결과가 뒤 넷의 세상이 된다 */
export function compactAll(model, graphs, opts = {}) {
  const cur = new Map(graphs);
  const nets = [];
  let before = 0, after = 0;
  for (const name of cur.keys()) {
    if (!cur.get(name).segs.length) continue;
    const r = compactNet(model, cur, name, opts);
    const q = r.nets[0];
    cur.set(name, q.g);
    nets.push(q);
    before += q.before; after += q.after;
  }
  return { nets, before, after };
}
