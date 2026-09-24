/** 스파이크 (symplace/PLAN-edit.md 의 실측): 배치를 편집한 뒤 토폴로지(쌍의 상대 위치)를 유지한 채 legalize 가 되는가.
 *
 *  1. 예제를 배치한다 (CPU, 시작점 48, 격자).
 *  2. 편집을 흉내 낸다: 블록 하나를 끌어 옮기기 (제약 투영 — 축은 고정, 거울 짝은 따라온다),
 *     두 블록 자리 바꾸기, 축 위 블록을 한 칸 위로 (축 방향 순서 바꾸기).
 *  3. 편집된 좌표에서 분리 방향을 읽어 legalize (격자·앵커·Order·간격) 한다.
 *  4. 잰다: 겹침, 대칭 잔차, 격자 밖, 편집 좌표에서의 이동량, 면적·HPWL 변화, 쌍 관계 보존, 시간.
 *
 *  실행:  node symplace/scripts/edit/place.mjs <예제> [시작점=48]   (저장소 루트에서)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeHierarchy, symmetryResidual, axes } from "../../../src/place.mjs";
import { readDesign, variantGroups, buildProblem, flipPlan, orderDirections, blockSpacing } from "../../../src/design.mjs";
import { build as buildSystem, nullspace, particular } from "../../../src/subspace.mjs";
import { legalize, chooseDirections, exactOverlap } from "../../../src/legalize.mjs";
import { exactArea, hpwl, refineFlips, scoreOf } from "../../../src/solver.mjs";
import { gridOffgrid } from "../../../src/place.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const [ex = "telescopic_ota", batchArg = "48"] = process.argv.slice(2);
const GRID = [80, 84];
const blob = JSON.parse(fs.readFileSync(path.join(ROOT, "data", ex + ".json"), "utf8"));

const t0 = performance.now();
const hr = await placeHierarchy(blob, { batch: Number(batchArg), iters: 600, seed: 1, grid: GRID });
if (!hr.ok) { console.log("배치 실패", hr.reason); process.exit(1); }
const top = hr.top;
console.log(`${ex}: 배치 ${((performance.now() - t0) / 1000).toFixed(1)}s  블록 ${top.names.length}  bbox ${Math.round(top.box[2]-top.box[0])}x${Math.round(top.box[3]-top.box[1])}  HPWL ${top.hpwl.toFixed(0)}`);

// --- 편집기가 페이지에서 다시 짓는 것: design -> groups -> problem(assignment) -> z0, N ---
// (워커의 done 메시지에는 z0/N 이 없다. concrete 이름에서 배정을 되찾아 다시 만든다.)
const design = top.design ?? readDesign({ ...blob, top: hr.order.at(-1) });
const groups = top.groups ?? variantGroups(design);
const assignment = groups.map((g) => Math.max(0, g.choices.indexOf(top.concrete[g.members[0]])));
const P = buildProblem(design, groups, assignment);
const sizes = new Map(P.names.map((n, i) => [n, [P.w[i], P.h[i]]]));
const { sysm } = buildSystem(P.constraints, P.names, sizes);
const { A, b } = sysm.matrices();
const { N } = nullspace(A);
const z0 = particular(A, b);
const n = P.n, K = N.cols, nAxis = sysm.nAxis;
console.log(`  자유도 ${K} / 변수 ${N.rows} (블록 ${n}, 축 ${nAxis}), 제약행 ${A.rows}`);

const cx0 = Float64Array.from(top.cx), cy0 = Float64Array.from(top.cy);
// 현재 z (축 좌표까지) — theta 를 최소제곱으로 되찾는다: theta = N^T (z - z0)
function zOf(cx, cy, axisVals) {
  const z = Float64Array.from(z0);
  for (let i = 0; i < n; i++) { z[2 * i] = cx[i]; z[2 * i + 1] = cy[i]; }
  for (let k = 0; k < nAxis; k++) z[2 * n + k] = axisVals[k];
  return z;
}
function thetaOf(z) {
  const th = new Float64Array(K);
  for (let r = 0; r < N.rows; r++) { const d = z[r] - z0[r]; if (d === 0) continue; for (let k = 0; k < K; k++) th[k] += N.data[r * K + k] * d; }
  return th;
}
function zFromTheta(th) {
  const z = Float64Array.from(z0);
  for (let r = 0; r < N.rows; r++) { let s = 0; for (let k = 0; k < K; k++) s += N.data[r * K + k] * th[k]; z[r] += s; }
  return z;
}
const axisNow = axes(P, cx0, cy0).map((a) => a.at);
let theta = thetaOf(zOf(cx0, cy0, axisNow));
{ const z = zFromTheta(theta); let e = 0; for (let i = 0; i < n; i++) e = Math.max(e, Math.abs(z[2*i]-cx0[i]), Math.abs(z[2*i+1]-cy0[i])); console.log(`  theta 되찾기 오차 ${e.toExponential(1)}`); }

/** 끌기 = 고정 좌표(축, 잠근 블록)는 **반드시** 지키고, 지정 좌표는 최소제곱으로 — theta 의 최소 노름 보정.
 *  1) 고정 행들의 N 행을 정규직교화해 "고정 좌표를 바꾸는 방향" Q 를 얻고, 끌기 행에서 그 성분을 뺀다.
 *  2) 남은 방향으로 목표에 가장 가깝게 (행마다 차례로 Gram-Schmidt). 성분이 0 인 좌표는 못 움직인다 —
 *     축 위 블록을 축에 수직으로 끌면 그 성분이 0 이라 축을 따라서만 미끄러진다. */
function dragTheta(theta, pins, drags) {
  const row = (r) => Float64Array.from({ length: K }, (_, k) => N.data[r * K + k]);
  const dot = (a, b) => a.reduce((s, v, k) => s + v * b[k], 0);
  const Q = [];
  for (const [r] of pins) {
    const v = row(r);
    for (const q of Q) { const c = dot(v, q); for (let k = 0; k < K; k++) v[k] -= c * q[k]; }
    const nn = Math.sqrt(dot(v, v));
    if (nn > 1e-9) Q.push(v.map((x) => x / nn));
  }
  const zc = zFromTheta(theta);
  const out = Float64Array.from(theta);
  const B = [];                                   // 끌기 방향 (고정 성분 제거, 서로 정규직교)
  for (const [r, target] of drags) {
    const v = row(r);
    for (const q of [...Q, ...B]) { const c = dot(v, q); for (let k = 0; k < K; k++) v[k] -= c * q[k]; }
    const nn = Math.sqrt(dot(v, v));
    if (nn < 1e-9) continue;                      // 이 좌표는 잠겨 있다
    const u = v.map((x) => x / nn);
    // 현재 out 에서 이 좌표가 어디 있나 -> 남은 차이를 u 방향으로 (u 는 앞 방향들과 직교라 앞 목표를 안 깨뜨린다)
    const rowN = row(r);
    let cur = zc[r]; for (let k = 0; k < K; k++) cur += rowN[k] * (out[k] - theta[k]);
    const step = (target - cur) / dot(rowN, u);
    for (let k = 0; k < K; k++) out[k] += step * u[k];
    B.push(u);
  }
  return out;
}
const cxcy = (th) => { const z = zFromTheta(th); return { cx: z.slice(0, 2 * n).filter((_, i) => i % 2 === 0), cy: z.slice(0, 2 * n).filter((_, i) => i % 2 === 1), ax: z.slice(2 * n) }; };

/** 쌍의 관계 (0 왼 1 오 2 아래 3 위, 겹치면 -1) */
function relations(cx, cy) {
  const out = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const sepx = cx[i] + P.w[i] / 2 <= cx[j] - P.w[j] / 2 + 1e-6 ? 0 : cx[j] + P.w[j] / 2 <= cx[i] - P.w[i] / 2 + 1e-6 ? 1 : -1;
    const sepy = cy[i] + P.h[i] / 2 <= cy[j] - P.h[j] / 2 + 1e-6 ? 2 : cy[j] + P.h[j] / 2 <= cy[i] - P.h[i] / 2 + 1e-6 ? 3 : -1;
    out.push({ i, j, x: sepx, y: sepy });
  }
  return out;
}
const plan = flipPlan(design, groups);
const forced = orderDirections(design.constraints, P.names);
const gap = blockSpacing(design.constraints);
function measure(cx, cy) {
  const fr = refineFlips(P, plan, cx, cy);
  const ea = exactArea(cx, cy, P.w, P.h);
  const ov = exactOverlap(cx, cy, P.w, P.h);
  return { area: ea.area, box: ea.box, hpwl: fr.hpwl, overlap: ov, sx: fr.sx, sy: fr.sy, resid: symmetryResidual(P, cx, cy), score: scoreOf(ea.area, fr.hpwl, 1) };
}
const base = measure(cx0, cy0);
let blockArea = 0; for (let i = 0; i < n; i++) blockArea += P.w[i] * P.h[i];
console.log(`  기준: 면적 ${base.area.toExponential(3)} HPWL ${base.hpwl.toFixed(0)} 점수 ${base.score.toFixed(3)}`);

/** 편집 좌표 -> 토폴로지 유지 legalize. both 면 x·y 로 다 떨어진 쌍에 두 관계를 다 박는다. */
function settle(cxE, cyE, { both = false, bboxWeight = 0.5, label }) {
  const t1 = performance.now();
  const ea = exactArea(cxE, cyE, P.w, P.h);
  const region = ea.box.slice();
  const dirs = chooseDirections(cxE, cyE, P.w, P.h, z0, N, forced);
  let extra = [];
  if (both) {
    const rel = relations(cxE, cyE);
    for (const d of dirs) {
      const r = rel.find((q) => q.i === d.i && q.j === d.j);
      if (r.x >= 0 && r.y >= 0 && !d.forced) extra.push({ i: d.i, j: d.j, dir: d.dir < 2 ? r.y : r.x });
    }
  }
  const sx = base.sx, sy = base.sy;   // 앵커 부호는 반전에서 (편집 뒤 refineFlips 로 다시 고른다)
  const anchors = [Array.from(P.w, (v, i) => (sx[i] > 0 ? 1 : -1) * v / 2), Array.from(P.h, (v, i) => (sy[i] > 0 ? 1 : -1) * v / 2)];
  const args = { z0, N, n, w: P.w, h: P.h, cxRef: cxE, cyRef: cyE, region, forced, gap, bboxWeight, grid: GRID, anchors, slack: 1.6 };
  let r = legalize({ ...args, dirs: [...dirs, ...extra] });
  let st = r.status;
  if (st !== "OPTIMAL") { r = legalize({ ...args, dirs: [...dirs, ...extra], slack: 3 }); st = r.status + (r.status === "OPTIMAL" ? "(slack 3)" : ""); }
  const dt = performance.now() - t1;
  if (r.status !== "OPTIMAL") { console.log(`  ${label.padEnd(34)} ${st}  ${dt.toFixed(0)} ms`); return null; }
  const m = measure(r.cx, r.cy);
  let move = 0, maxMove = 0;
  for (let i = 0; i < n; i++) { const d = Math.abs(r.cx[i] - cxE[i]) + Math.abs(r.cy[i] - cyE[i]); move += d; maxMove = Math.max(maxMove, d); }
  const relE = relations(cxE, cyE), relF = relations(r.cx, r.cy);
  let kept = 0, tot = 0;
  relE.forEach((q, k) => { const f = relF[k]; if (q.x >= 0 || q.y >= 0) { tot++; if ((q.x >= 0 && f.x === q.x) || (q.y >= 0 && f.y === q.y)) kept++; } });
  const off = gridOffgrid(P, r.cx, r.cy, m.sx, m.sy, GRID);
  console.log(`  ${label.padEnd(34)} ${st.padEnd(8)} ${dt.toFixed(0).padStart(5)} ms  겹침 ${(m.overlap / blockArea).toExponential(1)}  잔차 ${m.resid.toExponential(1)}  격자밖 ${off}  ` +
              `이동 합 ${move.toFixed(0)} 최대 ${maxMove.toFixed(0)}  관계 ${kept}/${tot}  면적 ${(m.area / base.area).toFixed(3)}x  HPWL ${(m.hpwl / base.hpwl).toFixed(3)}x  점수 ${(m.score - base.score).toFixed(3)}`);
  return { r, m };
}

// --- 편집 1: 대칭 밖(자유) 블록, 없으면 아무 블록을 오른쪽·위로 끌기 (축 고정) ---
const roleOf = new Map();
for (const c of design.constraints) if (c.constraint === "SymmetricBlocks") for (const pr of c.pairs ?? []) pr.forEach((nm, k) => roleOf.set(nm, { len: pr.length, k, pair: pr }));
const pinAxes = Array.from({ length: nAxis }, (_, k) => [2 * n + k, axisNow[k]]);
const idx = (nm) => P.names.indexOf(nm);
const cases = [];
{
  const free = P.names.findIndex((nm) => !roleOf.has(nm));
  const i = free >= 0 ? free : 0;
  const dx = 0.6 * P.w[i], dy = 0.4 * P.h[i];
  const th = dragTheta(theta, pinAxes, [[2 * i, cx0[i] + dx], [2 * i + 1, cy0[i] + dy]]);
  const e = cxcy(th);
  console.log(`\n편집 1: ${P.names[i]} 를 (+${dx.toFixed(0)}, +${dy.toFixed(0)}) 끌기 (축 고정)  -> 실제 이동 (${(e.cx[i]-cx0[i]).toFixed(0)}, ${(e.cy[i]-cy0[i]).toFixed(0)})  겹침 ${(exactOverlap(e.cx, e.cy, P.w, P.h)/blockArea).toExponential(1)}  잔차 ${symmetryResidual(P, e.cx, e.cy).toExponential(1)}`);
  cases.push(["끌기(자유 블록)", e]);
}
// --- 편집 2: 거울 쌍의 한쪽을 위로 끌기 -> 짝이 따라오는가; 축 위 블록을 x 로 끌면? ---
{
  const pairName = [...roleOf].find(([, r]) => r.len === 2)?.[0];
  if (pairName) {
    const i = idx(pairName), j = idx(roleOf.get(pairName).pair[1 - roleOf.get(pairName).k]);
    const th = dragTheta(theta, pinAxes, [[2 * i, cx0[i] + 0.5 * P.w[i]], [2 * i + 1, cy0[i] + 1.2 * P.h[i]]]);
    const e = cxcy(th);
    console.log(`\n편집 2: 거울 쌍 ${pairName} 를 (+${(0.5*P.w[i]).toFixed(0)}, +${(1.2*P.h[i]).toFixed(0)}) 끌기 -> 자신 (${(e.cx[i]-cx0[i]).toFixed(0)}, ${(e.cy[i]-cy0[i]).toFixed(0)})  짝 ${P.names[j]} (${(e.cx[j]-cx0[j]).toFixed(0)}, ${(e.cy[j]-cy0[j]).toFixed(0)})  축 이동 ${(e.ax[0]-axisNow[0]).toFixed(1)}`);
    cases.push(["끌기(거울 쌍 한쪽)", e]);
  }
  const selfName = [...roleOf].find(([, r]) => r.len === 1)?.[0];
  if (selfName) {
    const i = idx(selfName);
    const th = dragTheta(theta, pinAxes, [[2 * i, cx0[i] + 500], [2 * i + 1, cy0[i] + 2.0 * P.h[i]]]);
    const e = cxcy(th);
    const others = P.names.map((nm, k) => k !== i && Math.abs(e.cy[k] - cy0[k]) + Math.abs(e.cx[k] - cx0[k]) > 1e-6 ? `${nm}(${(e.cx[k]-cx0[k]).toFixed(0)},${(e.cy[k]-cy0[k]).toFixed(0)})` : null).filter(Boolean);
    console.log(`\n편집 3: 축 위 블록 ${selfName} 를 (+500, +${(2*P.h[i]).toFixed(0)}) 끌기 (축 고정) -> 자신 (${(e.cx[i]-cx0[i]).toFixed(0)}, ${(e.cy[i]-cy0[i]).toFixed(0)})  같이 움직인 것: ${others.join(" ") || "없음"}`);
    cases.push(["끌기(축 위 블록, 축 방향 순서 바꿈)", e]);
    // 축 자체를 끌면 (축 고정 없이 축 행만 목표)
    const th2 = dragTheta(theta, [], [[2 * n, axisNow[0] + 700]]);
    const e2 = cxcy(th2);
    const moved = P.names.filter((_, k) => Math.abs(e2.cx[k] - cx0[k]) > 1e-6).length;
    console.log(`편집 4: 축을 +700 끌기 -> 축 ${(e2.ax[0]-axisNow[0]).toFixed(0)}, x 가 움직인 블록 ${moved}/${n}`);
    cases.push(["축 끌기", e2]);
  }
}
// --- 편집 5: 두 블록 자리 바꾸기 (같은 역할끼리) ---
{
  const selfs = P.names.map((nm, k) => [nm, k]).filter(([nm]) => roleOf.get(nm)?.len === 1);
  if (selfs.length >= 2) {
    const [[na, a], [nb, bb]] = selfs;
    const th = dragTheta(theta, pinAxes, [[2 * a + 1, cy0[bb]], [2 * bb + 1, cy0[a]]]);
    const e = cxcy(th);
    console.log(`\n편집 5: ${na} <-> ${nb} 자리 바꾸기 (y)  겹침 ${(exactOverlap(e.cx, e.cy, P.w, P.h)/blockArea).toExponential(1)}`);
    cases.push(["자리 바꾸기(축 위 둘)", e]);
  }
}
// --- 편집 6: 아무 데나 던지기 (겹치게) ---
{
  const i = n - 1, j = 0;
  const th = dragTheta(theta, pinAxes, [[2 * i, cx0[j] + 0.3 * P.w[j]], [2 * i + 1, cy0[j] + 0.2 * P.h[j]]]);
  const e = cxcy(th);
  console.log(`\n편집 6: ${P.names[i]} 를 ${P.names[j]} 위에 던지기  겹침 ${(exactOverlap(e.cx, e.cy, P.w, P.h)/blockArea).toExponential(1)}`);
  cases.push(["겹치게 던지기", e]);
}

console.log("\n--- 편집 좌표에서 토폴로지 유지 legalize (관계 하나 / 둘 다 / 압축 없이) ---");
console.log(`  ${"편집".padEnd(34)} 상태     시간  ...`);
for (const [label, e] of cases) {
  settle(e.cx, e.cy, { label: label + " · 하나" });
  settle(e.cx, e.cy, { label: label + " · 둘 다", both: true });
  settle(e.cx, e.cy, { label: label + " · 하나, 압축 0", bboxWeight: 0 });
}
// 편집 없이 원래 배치에 걸면 그대로인가 (항등)
settle(cx0, cy0, { label: "편집 없음 · 하나" });
