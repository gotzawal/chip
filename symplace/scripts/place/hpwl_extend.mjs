// ALIGN 식 HPWL(핀 중심들) / HPWL_extend(핀 경계) 와 우리 식 HPWL(넷별 합집합 중심) 을
// 같은 배치에 대해 잰다. 배치 두 개: ALIGN 기준선, 우리 placeDesign 결과.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
import { readDesign, topIndex, variantGroups, powerGroundNets } from "../../../src/design.mjs";
import { placeDesign } from "../../../src/place.mjs";

const name = process.argv[2] ?? "five_transistor_ota";
const blob = JSON.parse(fs.readFileSync(`${ROOT}/data/${name}.json`));
const topName = blob.topology.modules[topIndex(blob.topology)].name;
const design = readDesign({ ...blob, top: topName });
const skip = powerGroundNets(design.constraints);

// 블록 목록 [{name, concrete, oX, oY, sX, sY}] -> 세 가지 HPWL
function measure(blocks, { includePower = false } = {}) {
  const nets = new Map();   // net -> { centers: [[x,y]], rects: [[llx,lly,urx,ury]], ours: [[x,y]] }
  for (const b of blocks) {
    const t = blob.templates[b.concrete];
    const inst = design.instances.find((i) => i.name === b.name);
    const [x0, y0, x1, y1] = t.bbox;
    const W = x1 - x0, H = y1 - y0;
    const byNet = new Map();
    for (const q of t.terminals) {
      if (q.netType !== "pin" || !q.netName) continue;
      const net = inst.fa.get(q.netName);
      if (net == null) continue;
      if (!includePower && skip.has(String(net).toUpperCase())) continue;
      if (!byNet.has(net)) byNet.set(net, []);
      byNet.get(net).push(q.rect);
    }
    for (const [net, rects] of byNet) {
      if (!nets.has(net)) nets.set(net, { centers: [], rects: [], ours: [] });
      const e = nets.get(net);
      let ux0 = Infinity, uy0 = Infinity, ux1 = -Infinity, uy1 = -Infinity;
      for (const r of rects) {
        // ALIGN: H_flip 이면 x -> W - x (블록 좌표계), 그 뒤 원점 더함
        let [llx, lly, urx, ury] = r;
        if (b.sX < 0) [llx, urx] = [W - urx, W - llx];
        if (b.sY < 0) [lly, ury] = [H - ury, H - lly];
        // b.oX/oY 는 ALIGN transformation 의 oX/oY 가 아니라 블록 왼아래 좌표로 정규화해 둔다
        llx += b.llx; urx += b.llx; lly += b.lly; ury += b.lly;
        e.rects.push([llx, lly, urx, ury]);
        e.centers.push([(llx + urx) / 2, (lly + ury) / 2]);
        ux0 = Math.min(ux0, r[0]); uy0 = Math.min(uy0, r[1]); ux1 = Math.max(ux1, r[2]); uy1 = Math.max(uy1, r[3]);
      }
      // 우리 식: 합집합 사각형의 중심 (템플릿 중심 기준 오프셋에 sX, sY 를 곱함)
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const off = [(ux0 + ux1) / 2 - cx, (uy0 + uy1) / 2 - cy];
      e.ours.push([b.llx + W / 2 + b.sX * off[0], b.lly + H / 2 + b.sY * off[1]]);
    }
  }
  let hpwlC = 0, hpwlE = 0, hpwlO = 0;
  const perNet = [];
  for (const [net, e] of nets) {
    if (e.ours.length < 2) continue;
    const span = (pts) => Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]))
                        + Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
    const c = span(e.centers), o = span(e.ours);
    const ex = Math.max(...e.rects.map((r) => r[2])) - Math.min(...e.rects.map((r) => r[0]))
             + Math.max(...e.rects.map((r) => r[3])) - Math.min(...e.rects.map((r) => r[1]));
    hpwlC += c; hpwlE += ex; hpwlO += o;
    perNet.push([net, o, c, ex]);
  }
  return { ours: hpwlO, alignCenter: hpwlC, alignExtend: hpwlE, perNet };
}

function fromAlign() {
  const top = blob.place.modules.find((m) => m.abstract_name === topName);
  const blocks = top.instances.map((i) => {
    const t = blob.templates[i.concrete_template_name];
    const [x0, y0, x1, y1] = t.bbox, tr = i.transformation;
    const xs = [tr.sX * x0 + tr.oX, tr.sX * x1 + tr.oX].sort((a, b) => a - b);
    const ys = [tr.sY * y0 + tr.oY, tr.sY * y1 + tr.oY].sort((a, b) => a - b);
    return { name: i.instance_name, concrete: i.concrete_template_name, llx: xs[0], lly: ys[0], sX: tr.sX, sY: tr.sY };
  });
  const bb = top.bbox;
  return { blocks, area: (bb[2] - bb[0]) * (bb[3] - bb[1]), bbox: bb };
}

function fromOurs(opts) {
  const r = placeDesign({ design }, { batch: 96, iters: 600, seed: 1, grid: [80, 84], ...opts });
  if (!r.ok) throw new Error(r.reason);
  const blocks = r.names.map((nm, k) => ({ name: nm, concrete: r.concrete[k],
    llx: r.cx[k] - r.w[k] / 2, lly: r.cy[k] - r.h[k] / 2, sX: r.sx[k], sY: r.sy[k] }));
  return { blocks, area: r.area, bbox: r.box, r };
}

const fmt = (m) => `ours(center of union) ${m.ours.toFixed(0)}  ALIGN HPWL(centers) ${m.alignCenter.toFixed(0)}  ALIGN HPWL_extend ${m.alignExtend.toFixed(0)}`;
const A = fromAlign();
const mA = measure(A.blocks);
console.log(`ALIGN placement  ${A.blocks.map((b) => b.concrete.split("_").slice(-2).join("_")).join(" ")}  area ${A.area.toExponential(3)}`);
console.log("   " + fmt(mA));
for (const [n, o, c, e] of mA.perNet) console.log(`      ${n.padEnd(8)} ours ${o.toFixed(0).padStart(6)}  center ${c.toFixed(0).padStart(6)}  extend ${e.toFixed(0).padStart(6)}`);
const O = fromOurs({});
const mO = measure(O.blocks);
console.log(`OUR placement    ${O.blocks.map((b) => b.concrete.split("_").slice(-2).join("_")).join(" ")}  area ${O.area.toExponential(3)}  bbox ${(O.bbox[2]-O.bbox[0])}x${(O.bbox[3]-O.bbox[1])}`);
console.log("   " + fmt(mO));
for (const [n, o, c, e] of mO.perNet) console.log(`      ${n.padEnd(8)} ours ${o.toFixed(0).padStart(6)}  center ${c.toFixed(0).padStart(6)}  extend ${e.toFixed(0).padStart(6)}`);
console.log("\nALIGN cost log(area)+log(HPWL_extend):");
console.log(`   ALIGN placement  ${(Math.log(A.area) + Math.log(mA.alignExtend)).toFixed(4)}`);
console.log(`   our placement    ${(Math.log(O.area) + Math.log(mO.alignExtend)).toFixed(4)}`);
console.log("our score area/refA + 2*hpwl/refW with ALIGN refs (ours-HPWL):");
console.log(`   ALIGN placement  ${(1 + 2 * mA.ours / mA.ours).toFixed(4)}   our placement ${(O.area / A.area + 2 * mO.ours / mA.ours).toFixed(4)}`);
