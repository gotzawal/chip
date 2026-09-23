/** 기준선 — ALIGN 이 낸 배치에서 그릴 사각형과 HPWL 을 뽑는다.
 *
 *  배치기 본체와 떼어 둔다. 페이지가 **처음 뜰 때** 바로 쓰는 코드라
 *  (워커를 거치지 않는다) 무거운 모듈을 끌고 오면 안 된다 — design.mjs 하나만
 *  본다. test/_load.mjs 의 alignBaseline 과 같은 규칙인데, 여기서는 그릴
 *  사각형도 같이 낸다.
 */
import { topIndex, moduleOrder } from "./design.mjs";

/** ALIGN 의 place 결과에서 블록 사각형과 기준선을 뽑는다.
 *  HPWL 은 배치기와 같은 자 — 넷마다 핀 경계 사각형의 bbox 반둘레 — 로 잰다.
 */
export function baseline(place, topName) {
  const leafBox = new Map(), leafTerm = new Map();
  for (const l of place.leaves ?? []) {
    leafBox.set(l.concrete_name, l.bbox);
    leafTerm.set(l.concrete_name, l.terminals ?? []);
  }
  const byConcrete = new Map(place.modules.map((m) => [m.concrete_name, m]));
  const top = place.modules.find((m) => m.abstract_name === topName)
           ?? place.modules[place.modules.length - 1];
  const boxOf = (cn) => leafBox.get(cn) ?? byConcrete.get(cn)?.bbox ?? null;

  const cache = new Map();
  const pinsOf = (cn) => {
    if (cache.has(cn)) return cache.get(cn);
    const out = new Map();
    cache.set(cn, out);
    const bb = boxOf(cn);
    if (!bb) return out;
    const cx0 = (bb[0] + bb[2]) / 2, cy0 = (bb[1] + bb[3]) / 2;
    // 핀은 [중심 오프셋 x, y, 반폭 x, y] — 배치기(design.mjs templateInfo)와 같은 꼴.
    // HPWL 은 핀 경계 사각형으로 잰다 (ALIGN 의 HPWL_extend). 배치기의 값과
    // 같은 자로 재야 "ALIGN 대비" 가 비교가 된다.
    const terms = leafTerm.get(cn);
    if (terms?.length) {
      for (const t of terms) {
        const r = t.rect;
        const cur = out.get(t.name);
        const rr = cur ? [cur[0] - cur[2] + cx0, cur[1] - cur[3] + cy0, cur[0] + cur[2] + cx0, cur[1] + cur[3] + cy0]
                       : [r[0], r[1], r[2], r[3]];
        const u = [Math.min(rr[0], r[0]), Math.min(rr[1], r[1]), Math.max(rr[2], r[2]), Math.max(rr[3], r[3])];
        out.set(t.name, [(u[0] + u[2]) / 2 - cx0, (u[1] + u[3]) / 2 - cy0, (u[2] - u[0]) / 2, (u[3] - u[1]) / 2]);
      }
      return out;
    }
    const m = byConcrete.get(cn);
    if (!m) return out;
    const acc = new Map();          // 포트 -> 자식 핀 사각형들의 합집합
    for (const inst of m.instances ?? []) {
      const child = pinsOf(inst.concrete_template_name);
      const tb = boxOf(inst.concrete_template_name);
      if (!child.size || !tb) continue;
      const tr = inst.transformation;
      const ccx = (tr.sX * (tb[0] + tb[2])) / 2 + tr.oX;
      const ccy = (tr.sY * (tb[1] + tb[3])) / 2 + tr.oY;
      const fa = new Map((inst.fa_map ?? []).map((f) => [f.formal, f.actual]));
      for (const [formal, off] of child) {
        const net = fa.get(formal);
        if (net == null) continue;
        const px = ccx + tr.sX * off[0], py = ccy + tr.sY * off[1];
        const r = acc.get(net);
        if (!r) acc.set(net, [px - off[2], py - off[3], px + off[2], py + off[3]]);
        else {
          r[0] = Math.min(r[0], px - off[2]); r[1] = Math.min(r[1], py - off[3]);
          r[2] = Math.max(r[2], px + off[2]); r[3] = Math.max(r[3], py + off[3]);
        }
      }
    }
    for (const port of m.parameters ?? []) {
      const r = acc.get(port);
      if (!r) continue;
      out.set(port, [(r[0] + r[2]) / 2 - cx0, (r[1] + r[3]) / 2 - cy0, (r[2] - r[0]) / 2, (r[3] - r[1]) / 2]);
    }
    return out;
  };

  const skip = new Set(["0", "VDD", "GND", "VSS"]);
  for (const c of top.constraints ?? [])
    if (["PowerPorts", "GroundPorts", "ClockPorts"].includes(c.constraint))
      for (const p of c.ports ?? []) skip.add(String(p).toUpperCase());

  const rects = [], nets = new Map();
  for (const inst of top.instances ?? []) {
    const tb = boxOf(inst.concrete_template_name);
    if (!tb) continue;
    const tr = inst.transformation;
    const xs = [tr.sX * tb[0] + tr.oX, tr.sX * tb[2] + tr.oX].sort((a, b) => a - b);
    const ys = [tr.sY * tb[1] + tr.oY, tr.sY * tb[3] + tr.oY].sort((a, b) => a - b);
    rects.push({ name: inst.instance_name, concrete: inst.concrete_template_name,
                 x: xs[0], y: ys[0], w: xs[1] - xs[0], h: ys[1] - ys[0],
                 sx: Math.sign(tr.sX) || 1, sy: Math.sign(tr.sY) || 1 });
    const pins = pinsOf(inst.concrete_template_name);
    const ccx = (tr.sX * (tb[0] + tb[2])) / 2 + tr.oX;
    const ccy = (tr.sY * (tb[1] + tb[3])) / 2 + tr.oY;
    const fa = new Map((inst.fa_map ?? []).map((f) => [f.formal, f.actual]));
    for (const [formal, off] of pins) {
      const net = fa.get(formal);
      if (net == null || skip.has(String(net).toUpperCase())) continue;
      if (!nets.has(net)) nets.set(net, []);
      const px = ccx + tr.sX * off[0], py = ccy + tr.sY * off[1];
      nets.get(net).push([px - off[2], py - off[3], px + off[2], py + off[3]]);
    }
  }
  let hpwl = 0;
  for (const rs of nets.values()) {
    if (rs.length < 2) continue;
    hpwl += Math.max(...rs.map((r) => r[2])) - Math.min(...rs.map((r) => r[0]))
          + Math.max(...rs.map((r) => r[3])) - Math.min(...rs.map((r) => r[1]));
  }
  const b = top.bbox;
  return { rects, bbox: b, hpwl,
           area: (b[2] - b[0]) * (b[3] - b[1]) };
}

/** 대칭축 위치 (세로축이면 x). 그림에 점선으로 그린다. */
export function axes(problem, cx, cy) {
  const idx = new Map(problem.names.map((n, i) => [n, i]));
  const out = [];
  for (const c of problem.constraints ?? []) {
    if (c.constraint !== "SymmetricBlocks") continue;
    const vert = (c.direction ?? "V") === "V";
    const vals = [];
    for (const pr of c.pairs ?? []) {
      const ids = pr.map((p) => idx.get(p)).filter((v) => v !== undefined);
      if (!ids.length) continue;
      vals.push(ids.reduce((s, i) => s + (vert ? cx[i] : cy[i]), 0) / ids.length);
    }
    if (vals.length) out.push({ vert, at: vals[0] });
  }
  return out;
}

/** 그리기에 필요한 것만 — 배치는 안 돌린다.
 *  워커가 서지 않는 브라우저에서도 첫 화면이 나와야 해서 메인 스레드에서 부른다.
 */
export function previewOf(blob) {
  const topName = blob.topology.modules[topIndex(blob.topology)].name;
  const order = moduleOrder(blob.topology);
  return { base: blob.place ? baseline(blob.place, topName) : null,
           topName, order, modules: order.length };
}
