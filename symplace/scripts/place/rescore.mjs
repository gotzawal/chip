// 배정을 전수로 돌려 legalize 까지 간 배정별 최선을, 세 가지 저울로 다시 줄 세운다.
//   (a) 우리 점수      area/refA + 2*HPWL_center/refW
//   (b) ALIGN 저울     log(area) + log(HPWL_extend)      (핀 경계 사각형 기준)
//   (c) 절충           area/refA + 2*HPWL_extend/refW'   (우리 식에 HPWL_extend 만 바꿔 끼움)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
import { readDesign, topIndex, variantGroups, countAssignments, flipPlan, powerGroundNets } from "../../../src/design.mjs";
import { multiStartVariants, refineFlips, exactArea, hpwl } from "../../../src/solver.mjs";
import { legalize } from "../../../src/legalize.mjs";

const name = process.argv[2] ?? "five_transistor_ota";
const BATCH = Number(process.argv[3] ?? 96);
const blob = JSON.parse(fs.readFileSync(`${ROOT}/data/${name}.json`));
const topName = blob.topology.modules[topIndex(blob.topology)].name;
const design = readDesign({ ...blob, top: topName });
const skip = powerGroundNets(design.constraints);
const groups = variantGroups(design);

function extend(problem, cx, cy, sx, sy) {
  const nets = new Map();
  problem.names.forEach((nm, k) => {
    const t = blob.templates[problem.concrete[k]];
    const inst = design.instances.find((i) => i.name === nm);
    const [x0, y0, x1, y1] = t.bbox, W = x1 - x0, H = y1 - y0;
    const llx = cx[k] - W / 2, lly = cy[k] - H / 2;
    for (const q of t.terminals) {
      if (q.netType !== "pin" || !q.netName) continue;
      const net = inst.fa.get(q.netName);
      if (net == null || skip.has(String(net).toUpperCase())) continue;
      let [a, b, c, d] = q.rect;
      if (sx[k] < 0) [a, c] = [W - c, W - a];
      if (sy[k] < 0) [b, d] = [H - d, H - b];
      if (!nets.has(net)) nets.set(net, { r: [Infinity, Infinity, -Infinity, -Infinity], n: 0, blocks: new Set() });
      const e = nets.get(net);
      e.r[0] = Math.min(e.r[0], llx + a); e.r[1] = Math.min(e.r[1], lly + b);
      e.r[2] = Math.max(e.r[2], llx + c); e.r[3] = Math.max(e.r[3], lly + d);
      e.blocks.add(k);
    }
  });
  let s = 0;
  for (const e of nets.values()) if (e.blocks.size >= 2) s += (e.r[2] - e.r[0]) + (e.r[3] - e.r[1]);
  return s;
}

const alignTop = blob.place?.modules.find((m) => m.abstract_name === topName);
const alignKey = alignTop ? groups.map((g) => {
  const chosen = new Map(alignTop.instances.map((i) => [i.instance_name, i.concrete_template_name]));
  return Math.max(0, g.choices.indexOf(chosen.get(design.instances[g.members[0]].name)));
}).join(",") : null;

const res = multiStartVariants(design, groups, { batch: BATCH, iters: 600, seed: 1, hpwlWeight: 2 });
const plan = flipPlan(design, groups);
const best = new Map();
for (const c of res.candidates) {
  const k = c.assignment.join(",");
  const r = legalize({ z0: c.z0, N: c.N, n: c.problem.n, w: c.problem.w, h: c.problem.h,
                       cxRef: c.cx, cyRef: c.cy, region: c.region });
  if (r.status !== "OPTIMAL") continue;
  const fr = refineFlips(c.problem, plan, r.cx, r.cy);
  const ea = exactArea(r.cx, r.cy, c.problem.w, c.problem.h);
  const hc = hpwl(r.cx, r.cy, c.problem.pinInst, c.problem.pinOff, c.problem.pinNet, c.problem.nNet, fr.sx, fr.sy);
  const he = extend(c.problem, r.cx, r.cy, fr.sx, fr.sy);
  const ours = ea.area / res.refArea + 2 * hc / res.refHpwl;
  const cur = best.get(k);
  if (!cur || ours < cur.ours) best.set(k, { k, concrete: c.problem.concrete, area: ea.area, hc, he, ours, box: ea.box,
    align: Math.log(ea.area) + Math.log(he), mixed: ea.area / res.refArea + 2 * he / (res.refHpwl * 2) });
}
const rows = [...best.values()];
const show = (key, label) => {
  rows.sort((a, b) => a[key] - b[key]);
  const pos = rows.findIndex((r) => r.k === alignKey);
  console.log(`\n--- ${label}: ALIGN 의 배정이 ${pos + 1} 위 / ${rows.length}`);
  rows.slice(0, 5).forEach((r, i) => console.log(
    `  ${i + 1}. [${r.k}] ${r.concrete.map((n) => n.split("_").slice(-2).join("_")).join(" ").padEnd(28)} ` +
    `bbox ${(r.box[2]-r.box[0]).toFixed(0)}x${(r.box[3]-r.box[1]).toFixed(0)}  area ${(r.area/1e6).toFixed(2)}M  ` +
    `hpwl_center ${r.hc.toFixed(0)}  hpwl_extend ${r.he.toFixed(0)}  ${key} ${r[key].toFixed(4)}${r.k === alignKey ? "  <- ALIGN" : ""}`));
};
console.log(`${name}: 배정 ${rows.length}/${countAssignments(groups)} legalize 됨, ALIGN 배정 [${alignKey}]`);
show("ours", "(a) 우리 점수 (핀 중심 HPWL)");
show("align", "(b) ALIGN 저울 log(area)+log(HPWL_extend)");
show("mixed", "(c) 우리 점수에 HPWL_extend 를 끼움");
