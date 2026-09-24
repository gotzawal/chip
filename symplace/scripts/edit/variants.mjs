/** 스파이크 2 (symplace/PLAN-edit.md 의 실측).
 *  (1) 계층 설계에서 페이지가 워커의 done 메시지 + "편집 키트"(하위 모듈 변이의 합성 템플릿)만으로 최상위 문제를
 *      다시 지으면 배치기 안의 문제와 같은가 (크기·핀).
 *  (2) 토폴로지(분리 방향)를 유지한 채 변이 배정을 전수로 바꿔 legalize 하면 점수가 좋아지는 배정이 있는가.
 *
 *  실행:  node symplace/scripts/edit/variants.mjs <예제> [시작점=48]   (저장소 루트에서)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeHierarchy, synthesizeTemplate, spreadShapes, SUB_VARIANTS, symmetryResidual, gridOffgrid } from "../../../src/place.mjs";
import { readDesign, variantGroups, buildProblem, flipPlan, orderDirections, blockSpacing, enumerateAssignments, countAssignments, topIndex, moduleOrder } from "../../../src/design.mjs";
import { build as buildSystem, nullspace, particular } from "../../../src/subspace.mjs";
import { legalize, chooseDirections, exactOverlap } from "../../../src/legalize.mjs";
import { exactArea, hpwl, refineFlips, scoreOf } from "../../../src/solver.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const [ex = "high_speed_comparator", batchArg = "48"] = process.argv.slice(2);
const GRID = [80, 84];
const blob = JSON.parse(fs.readFileSync(path.join(ROOT, "data", ex + ".json"), "utf8"));
const t0 = performance.now();
const hr = await placeHierarchy(blob, { batch: Number(batchArg), iters: 600, seed: 1, grid: GRID });
if (!hr.ok) { console.log("배치 실패", hr.reason); process.exit(1); }
const top = hr.top;
const topName = hr.order.at(-1);
console.log(`${ex}: 배치 ${((performance.now() - t0) / 1000).toFixed(1)}s  모듈 ${hr.order.length}  최상위 블록 ${top.names.length}`);

// --- (1) 편집 키트: job.mjs 가 subModules 를 만드는 것과 같은 규칙으로 하위 모듈 변이의 템플릿을 모은다 ---
const kitPrim = {}, kitTpl = {};
const queue = [...new Set(top.concrete)], seen = new Set();
while (queue.length) {
  const cn = queue.shift();
  if (seen.has(cn)) continue; seen.add(cn);
  const nm = cn.includes("__v") ? cn.split("__v")[0] : cn;
  const m = hr.modules.get(nm);
  if (!m || nm === topName) continue;
  const picks = spreadShapes(m.alternatives ?? [m], SUB_VARIANTS);
  const vi = cn.includes("__v") ? Number(cn.split("__v")[1]) : 0;
  const pl = picks[Math.min(vi, picks.length - 1)] ?? m;
  kitPrim[cn] = { abstract_template_name: nm, concrete_template_name: cn, x_cells: 1, y_cells: 1 };
  kitTpl[cn] = synthesizeTemplate(m.design, pl, GRID);
  for (const c of pl.problem.concrete) queue.push(c);
}
const design = readDesign({ topology: blob.topology, primitives: { ...blob.primitives, ...kitPrim }, templates: { ...blob.templates, ...kitTpl }, top: topName });
const groups = variantGroups(design);
const assignment = groups.map((g) => Math.max(0, g.choices.indexOf(top.concrete[g.members[0]])));
const P = buildProblem(design, groups, assignment);
const P0 = top.problem;
let same = P.names.join() === P0.names.join() && P.n === P0.n;
let dw = 0, dp = 0;
for (let i = 0; i < P.n; i++) dw = Math.max(dw, Math.abs(P.w[i] - P0.w[i]), Math.abs(P.h[i] - P0.h[i]));
same = same && P.pinInst.length === P0.pinInst.length;
for (let p = 0; p < Math.min(P.pinOff.length, P0.pinOff.length); p++) dp = Math.max(dp, Math.abs(P.pinOff[p] - P0.pinOff[p]));
console.log(`(1) 키트로 다시 지은 문제: 이름·수 같음 ${same}  크기 차 ${dw}  핀 오프셋 차 ${dp}  핀 ${P.pinInst.length}/${P0.pinInst.length}  키트 템플릿 ${Object.keys(kitTpl).length} 개 (${JSON.stringify(kitTpl).length} 바이트)`);

// --- (2) 토폴로지 유지 변이 재선택 ---
const sizes = new Map(P.names.map((n, i) => [n, [P.w[i], P.h[i]]]));
const mk = (Pq) => {
  const sz = new Map(Pq.names.map((n, i) => [n, [Pq.w[i], Pq.h[i]]]));
  const { sysm } = buildSystem(Pq.constraints, Pq.names, sz);
  const { A, b } = sysm.matrices();
  return { N: nullspace(A).N, z0: particular(A, b) };
};
const plan = flipPlan(design, groups);
const forced = orderDirections(design.constraints, P.names);
const gap = blockSpacing(design.constraints);
const cx0 = Float64Array.from(top.cx), cy0 = Float64Array.from(top.cy);
const { N, z0 } = mk(P);
const dirs = chooseDirections(cx0, cy0, P.w, P.h, z0, N, forced);
const measure = (Pq, cx, cy) => {
  const fr = refineFlips(Pq, plan, cx, cy);
  const ea = exactArea(cx, cy, Pq.w, Pq.h);
  return { area: ea.area, box: ea.box, hpwl: fr.hpwl, sx: fr.sx, sy: fr.sy, score: scoreOf(ea.area, fr.hpwl, 1) };
};
const base = measure(P, cx0, cy0);
const total = countAssignments(groups);
console.log(`(2) 배정 ${total} 개를 같은 분리 방향으로 legalize (기준 점수 ${base.score.toFixed(3)}, bbox ${Math.round(base.box[2]-base.box[0])}x${Math.round(base.box[3]-base.box[1])}, HPWL ${base.hpwl.toFixed(0)})`);
const t1 = performance.now();
const rows = [];
let tried = 0;
for (const a of enumerateAssignments(groups)) {
  if (tried++ >= 128) break;
  const Pq = buildProblem(design, groups, a);
  const { N: Nq, z0: zq } = mk(Pq);
  // 같은 쌍 관계를 박는다. 크기가 바뀌어 실현 불가능해진 방향(상수 차)은 chooseDirections 의 규칙으로 걸러진다.
  const dq = chooseDirections(cx0, cy0, Pq.w, Pq.h, zq, Nq, forced).map((d, k) => ({ ...d, dir: dirs[k].dir }));
  const feas = dq.every((d) => d.dir >= 0);
  const ea = exactArea(cx0, cy0, Pq.w, Pq.h);
  const sx = Array.from(Pq.w, () => 1), sy = Array.from(Pq.h, () => 1);
  const anchors = [Array.from(Pq.w, (v) => v / 2), Array.from(Pq.h, (v) => v / 2)];
  let r = legalize({ z0: zq, N: Nq, n: Pq.n, w: Pq.w, h: Pq.h, cxRef: cx0, cyRef: cy0, region: ea.box, forced, gap, grid: GRID, anchors, dirs: dq, slack: 1.6 });
  if (r.status !== "OPTIMAL") r = legalize({ z0: zq, N: Nq, n: Pq.n, w: Pq.w, h: Pq.h, cxRef: cx0, cyRef: cy0, region: ea.box, forced, gap, grid: GRID, anchors, dirs: dq, slack: 3 });
  if (r.status !== "OPTIMAL") { rows.push({ a, status: r.status }); continue; }
  const m = measure(Pq, r.cx, r.cy);
  rows.push({ a, status: "OPTIMAL", score: m.score, area: m.area, hpwl: m.hpwl, box: m.box, off: gridOffgrid(Pq, r.cx, r.cy, m.sx, m.sy, GRID), resid: symmetryResidual(Pq, r.cx, r.cy), ov: exactOverlap(r.cx, r.cy, Pq.w, Pq.h) });
}
const dt = performance.now() - t1;
const okRows = rows.filter((r) => r.status === "OPTIMAL").sort((p, q) => p.score - q.score);
console.log(`    ${rows.length} 배정, 풀린 것 ${okRows.length}, ${dt.toFixed(0)} ms (배정당 ${(dt / rows.length).toFixed(0)} ms)`);
for (const r of okRows.slice(0, 5))
  console.log(`    ${r.a.join(",").padEnd(12)} 점수 ${r.score.toFixed(3)} (${(r.score - base.score) >= 0 ? "+" : ""}${(r.score - base.score).toFixed(3)})  bbox ${Math.round(r.box[2]-r.box[0])}x${Math.round(r.box[3]-r.box[1])}  HPWL ${r.hpwl.toFixed(0)}  겹침 ${r.ov.toExponential(1)} 잔차 ${r.resid.toExponential(1)} 격자밖 ${r.off}` + (r.a.join(",") === assignment.join(",") ? "  <- 지금 배정" : ""));
const cur = okRows.findIndex((r) => r.a.join(",") === assignment.join(","));
console.log(`    지금 배정의 순위 ${cur + 1}/${okRows.length}` + (cur > 0 ? `  (1 위와 점수 차 ${(okRows[0].score - okRows[cur].score).toFixed(3)} = 면적x배선 ${Math.exp(okRows[0].score - okRows[cur].score).toFixed(3)} 배)` : ""));
