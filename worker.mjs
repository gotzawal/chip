/** 배치를 워커에서 돌린다.
 *
 *  예제 하나가 8~95 초 걸린다. 메인 스레드에서 돌리면 그동안 페이지가 통째로
 *  얼어붙는다 (스크롤도, 버튼도 안 먹는다). 그래서 워커여야 한다.
 *
 *  받는 것: { name, blob, batch }   blob = {topology, primitives, templates, place}
 *  보내는 것:
 *    {type:"baseline", ...}  ALIGN 이 낸 배치 — 즉시. 페이지가 쉴 때 보여줄 것
 *    {type:"progress", ...}  후보 진행
 *    {type:"frame", ...}     설정(변이 배정 x 영역) 하나가 끝날 때의 최선 —
 *                            화면에서 블록이 재배치되는 과정을 보여준다
 *    {type:"module", ...}    계층 설계에서 모듈 하나가 끝날 때
 *    {type:"done", ...}      우리 배치
 *    {type:"error", ...}
 */
import { readDesign, topIndex, moduleOrder, variantGroups,
         countAssignments } from "./src/design.mjs";
import { placeHierarchy, symmetryResidual, orderViolations,
         spreadShapes } from "./src/place.mjs";

/** ALIGN 의 place 결과에서 블록 사각형과 기준선을 뽑는다.
 *  test/_load.mjs 의 alignBaseline 과 같은 규칙인데, 여기서는 그릴 사각형도 같이 낸다.
 */
function baseline(place, topName) {
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
function axes(problem, cx, cy) {
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

self.onmessage = async (e) => {
  const { name, blob, batch, previewOnly, grid = [80, 84] } = e.data;
  try {
    const topName = blob.topology.modules[topIndex(blob.topology)].name;
    const order = moduleOrder(blob.topology);
    const base = blob.place ? baseline(blob.place, topName) : null;

    // 변이 조합이 몇 개인지 미리 알려준다 (최상위 기준, 하위 모듈 변이 전)
    const d0 = readDesign({ ...blob, top: order[0] });
    postMessage({ type: "baseline", base, topName, order,
                  modules: order.length,
                  leafCombos: countAssignments(variantGroups(d0)) });
    if (previewOnly) return;          // 기준선만 뽑고 끝 — 배치는 안 돌린다

    const t0 = performance.now();
    let seen = 0, frames = 0, lastFrame = 0;
    const r = placeHierarchy(blob, {
      batch, iters: 600, seed: 1, grid,
      onProgress: (done, total) => {
        seen++;
        if (seen % 8 === 0)
          postMessage({ type: "progress", done, total,
                        t: (performance.now() - t0) / 1000 });
      },
      // 설정 하나가 끝날 때마다 그때의 최선을 보낸다. 너무 자주 보내면
      // 메인 스레드가 그리느라 밀리므로 120ms 간격으로 솎는다.
      onConfig: (mod, isTop, i, total, best) => {
        if (!best || !best.cx) return;
        const now = performance.now();
        if (now - lastFrame < 120 && i < total) return;
        lastFrame = now;
        frames++;
        const pr = best.problem;
        postMessage({
          type: "frame", module: mod, isTop, i, total, frame: frames,
          t: (now - t0) / 1000,
          score: best.score,
          bbox: [0, 0, best.box[2] - best.box[0], best.box[3] - best.box[1]],
          rects: pr.names.map((nm, k) => ({
            name: nm,
            x: best.cx[k] - pr.w[k] / 2 - best.box[0],
            y: best.cy[k] - pr.h[k] / 2 - best.box[1],
            w: pr.w[k], h: pr.h[k],
          })),
          concrete: pr.concrete,
        });
      },
    });
    if (!r.ok) { postMessage({ type: "error", msg: `${r.module}: ${r.reason}` }); return; }

    const top = r.top, P = top.problem;
    // 원점을 0 으로 당긴다. legalize 는 여유 영역에서 풀어서 bbox 가
    // (80, -168) 처럼 0 이 아닌 데서 시작할 수 있다. 그대로 그리면 ALIGN 패널과
    // 기준이 달라져 나란히 비교가 어긋난다. (emit.mjs 도 같은 이유로 당긴다.)
    const [ox0, oy0] = [top.box[0], top.box[1]];
    const rects = top.names.map((n, i) => ({
      name: n, concrete: top.concrete[i],
      x: top.cx[i] - top.w[i] / 2 - ox0, y: top.cy[i] - top.h[i] / 2 - oy0,
      w: top.w[i], h: top.h[i],
      sx: top.sx[i], sy: top.sy[i],
    }));
    const box0 = [0, 0, top.box[2] - ox0, top.box[3] - oy0];
    // 하위 모듈의 **실제 배치**. 배선기는 최상위만으로는 못 돈다 — 덤프의
    // 최상위 대안이 하위 모듈의 module 항목(bbox + 인스턴스)까지 품어야 한다.
    // emit.mjs 와 같은 규칙으로 고른다: __v{k} 는 alternatives[k] 가 아니라
    // spreadShapes(alternatives, 3)[k] 다.
    const subModules = [];
    for (const [nm, m] of r.modules) {
      if (nm === topName) continue;
      const used = [...new Set(top.concrete.filter(
        (c) => c === nm || c.startsWith(nm + "__v")))];
      for (const cn of used) {
        const picks = spreadShapes(m.alternatives ?? [m], 3);
        const vi = cn.includes("__v") ? Number(cn.split("__v")[1]) : 0;
        const pl = picks[Math.min(vi, picks.length - 1)] ?? m;
        const pp = pl.problem, [sx0, sy0] = [pl.box[0], pl.box[1]];
        subModules.push({
          abstract: nm, concrete: cn,
          bbox: [0, 0, Math.round(pl.box[2] - sx0), Math.round(pl.box[3] - sy0)],
          instances: pp.names.map((inm, k) => ({
            name: inm, concrete: pp.concrete[k],
            oX: Math.round(pl.cx[k] - pl.sx[k] * (pp.w[k] / 2) - sx0),
            oY: Math.round(pl.cy[k] - pl.sy[k] * (pp.h[k] / 2) - sy0),
            sX: pl.sx[k] > 0 ? 1 : -1, sY: pl.sy[k] > 0 ? 1 : -1,
          })),
        });
      }
    }

    // 하위 모듈이 어떤 모양들을 올렸는지 (표에 쓴다)
    const subs = [];
    for (const [nm, m] of r.modules) {
      if (nm === topName) continue;
      subs.push({ name: nm, blocks: m.names.length,
                  box: [Math.round(m.box[2] - m.box[0]), Math.round(m.box[3] - m.box[1])],
                  shapes: (m.alternatives ?? []).map((a) =>
                    [Math.round(a.box[2] - a.box[0]), Math.round(a.box[3] - a.box[1])]) });
    }
    postMessage({
      type: "done",
      rects, bbox: box0,
      area: top.area, hpwl: top.hpwl, overlap: top.overlap,
      resid: symmetryResidual(P, top.cx, top.cy),
      orderBad: orderViolations(P, top.cx, top.cy).length,
      offgrid: top.gridOff, grid,
      nOrder: (P.constraints ?? []).filter((c) => c.constraint === "Order").length,
      axes: axes(P, top.cx, top.cy).map((a) => ({ ...a, at: a.at - (a.vert ? ox0 : oy0) })),
      combos: top.totalAssignments, configs: top.configs,
      tried: top.tried, legalFail: top.legalizeFail,
      hpwlBeforeFlip: top.hpwlBeforeFlip,
      subs, subModules,
      secs: (performance.now() - t0) / 1000,
    });
  } catch (err) {
    postMessage({ type: "error", msg: String(err && err.stack || err).slice(0, 1200) });
  }
};
