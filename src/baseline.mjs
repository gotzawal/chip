/** 기준선 — ALIGN 이 낸 배치에서 그릴 사각형과 HPWL 을 뽑는다.
 *
 *  배치기 본체와 떼어 둔다. 페이지가 **처음 뜰 때** 바로 쓰는 코드라
 *  (워커를 거치지 않는다) 무거운 모듈을 끌고 오면 안 된다 — design.mjs 하나만
 *  본다. test/_load.mjs 의 alignBaseline 과 같은 규칙인데, 여기서는 그릴
 *  사각형도 같이 낸다.
 */
import { topIndex, moduleOrder } from "./design.mjs";

/** ALIGN 의 place 결과에서 블록 사각형과 기준선을 뽑는다. */
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
    const terms = leafTerm.get(cn);
    if (terms?.length) {
      for (const t of terms) {
        const r = t.rect;
        out.set(t.name, [(r[0] + r[2]) / 2 - cx0, (r[1] + r[3]) / 2 - cy0]);
      }
      return out;
    }
    const m = byConcrete.get(cn);
    if (!m) return out;
    const acc = new Map();
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
        if (!acc.has(net)) acc.set(net, []);
        acc.get(net).push([ccx + tr.sX * off[0], ccy + tr.sY * off[1]]);
      }
    }
    for (const port of m.parameters ?? []) {
      const pts = acc.get(port);
      if (!pts?.length) continue;
      out.set(port, [pts.reduce((s, p) => s + p[0], 0) / pts.length - cx0,
                     pts.reduce((s, p) => s + p[1], 0) / pts.length - cy0]);
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
      nets.get(net).push([ccx + tr.sX * off[0], ccy + tr.sY * off[1]]);
    }
  }
  let hpwl = 0;
  for (const pts of nets.values()) {
    if (pts.length < 2) continue;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    hpwl += Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
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
