// 한 시작점(Adam 600 스텝)의 시간이 어디에 쓰이는지. 설정 하나를 골라 항별로 잰다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
import { readDesign, topIndex, variantGroups, buildProblem, regionCandidates, makeObjective, enumerateAssignments } from "../../../src/design.mjs";
import { wirelength, area, boundary } from "../../../src/energy.mjs";
import { adam, initTheta, rng } from "../../../src/solver.mjs";

for (const name of ["five_transistor_ota", "telescopic_ota", "cascode_current_mirror_ota"]) {
  const blob = JSON.parse(fs.readFileSync(`${ROOT}/data/${name}.json`));
  const topName = blob.topology.modules[topIndex(blob.topology)].name;
  const design = readDesign({ ...blob, top: topName });
  if (design.missing.length) { console.log(name, "skip (hier)"); continue; }
  const groups = variantGroups(design);
  const a = [...enumerateAssignments(groups)][0];
  const problem = buildProblem(design, groups, a);
  const region = regionCandidates(problem)[0];
  const { obj, N } = makeObjective(problem, region, { M: 48 });
  const rand = rng(1);
  const theta = initTheta(obj, rand);
  console.log(`${name}: n=${problem.n} P(theta)=${N.cols} rows=${N.rows} pins=${problem.pinInst.length} nets=${problem.nNet} grid ${obj.dens.Mx}x${obj.dens.My}`);
  // 전체
  let t0 = performance.now();
  const th = Float64Array.from(theta);
  adam(obj, th, { iters: 600, lr: 10, lamRatio: 1 });
  const tAll = performance.now() - t0;
  // 항별 (600 회씩)
  const { cx, cy } = obj.centers(theta);
  const time = (f) => { const s = performance.now(); for (let k = 0; k < 600; k++) f(); return performance.now() - s; };
  const tC = time(() => obj.centers(theta));
  const P = problem.pinInst.length, px = new Float64Array(P), py = new Float64Array(P);
  for (let p = 0; p < P; p++) { px[p] = cx[problem.pinInst[p]] + problem.pinOff[2*p]; py[p] = cy[problem.pinInst[p]] + problem.pinOff[2*p+1]; }
  const tW = time(() => wirelength(px, py, problem.pinNet, problem.nNet, obj.gamma));
  const tD = time(() => obj.dens.eval(cx, cy, obj.w, obj.h));
  const tA = time(() => area(cx, cy, obj.w, obj.h, obj.beta));
  const tB = time(() => boundary(cx, cy, obj.w, obj.h, region));
  const tE = time(() => obj.eval(theta));
  console.log(`   adam600 ${tAll.toFixed(0)} ms | eval x600 ${tE.toFixed(0)} ms = centers ${tC.toFixed(0)} + wire ${tW.toFixed(0)} + density ${tD.toFixed(0)} + area ${tA.toFixed(0)} + boundary ${tB.toFixed(0)} (+ N^T grad)`);
}
