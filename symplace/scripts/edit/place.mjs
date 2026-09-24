/** 스파이크 (symplace/PLAN-edit.md 3.5 절의 실측): 배치를 편집한 뒤 위상(쌍의 상대 위치)을 유지한 채 정리가 되는가.
 *
 *  src/edit/place.mjs 의 rebuild / dragTheta / settle 을 그대로 부른다 — 페이지의 편집기와 같은 코드다.
 *  1. 예제를 배치한다 (CPU, 시작점, 격자).
 *  2. 편집을 흉내 낸다: 블록 하나를 끌어 옮기기 (축은 고정, 거울 짝은 따라온다), 축 위 블록을 축 방향으로,
 *     축을 그룹째, 두 블록 자리 바꾸기, 아무 데나 겹치게 던지기.
 *  3. 편집 좌표에서 분리 방향을 읽어 정리한다 (관계 하나 / 둘 다 / 압축 없이).
 *  4. 잰다: 겹침, 대칭 잔차, 격자 밖, 편집 좌표에서의 이동량, 쌍 관계 보존, 면적·HPWL 변화, 시간.
 *
 *  실행:  node symplace/scripts/edit/place.mjs <예제> [시작점=48]   (저장소 루트에서)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeHierarchy } from "../../../src/place.mjs";
import { editKit, rebuild, centers, dragTheta, pinRows, dragRows, relations, settle, toRects, GRID } from "../../../src/edit/place.mjs";
import { symmetryResidual } from "../../../src/place.mjs";
import { exactOverlap } from "../../../src/legalize.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const [ex = "telescopic_ota", batchArg = "48"] = process.argv.slice(2);
const blob = JSON.parse(fs.readFileSync(path.join(ROOT, "data", ex + ".json"), "utf8"));

const t0 = performance.now();
const hr = await placeHierarchy(blob, { batch: Number(batchArg), iters: 600, seed: 1, grid: GRID });
if (!hr.ok) { console.log("배치 실패", hr.reason); process.exit(1); }
const top = hr.top, P0 = top.problem;
console.log(`${ex}: 배치 ${((performance.now() - t0) / 1000).toFixed(1)}s  블록 ${P0.n}  bbox ${Math.round(top.box[2] - top.box[0])}x${Math.round(top.box[3] - top.box[1])}  HPWL ${top.hpwl.toFixed(0)}`);

// 페이지가 받는 것과 같은 모양 (done 의 rects + 편집 키트) 으로 문제를 다시 짓는다
const kit = editKit(hr, GRID);
const [ox0, oy0] = [top.box[0], top.box[1]];
const rects = P0.names.map((nm, i) => ({ name: nm, concrete: top.concrete[i],
  x: top.cx[i] - P0.w[i] / 2 - ox0, y: top.cy[i] - P0.h[i] / 2 - oy0, w: P0.w[i], h: P0.h[i], sx: top.sx[i], sy: top.sy[i] }));
const model = rebuild(blob, kit, rects);
const P = model.P, n = model.n;
const { cx: cx0, cy: cy0, ax: ax0 } = centers(model);
console.log(`  자유도 ${model.K} / 변수 ${model.N.rows} (블록 ${n}, 축 ${model.nAxis})  키트 템플릿 ${Object.keys(kit.subTemplates).length} 개`);
let blockArea = 0; for (let i = 0; i < n; i++) blockArea += P.w[i] * P.h[i];
const base = toRects(model, cx0, cy0, model.sx, model.sy);
console.log(`  기준: 면적 ${base.area.toExponential(3)} HPWL ${base.hpwl.toFixed(0)} 점수 ${base.score.toFixed(3)}`);

const pins = pinRows(model);
const drag = (names, dx, dy, opt) => centers(model, dragTheta(model, model.theta,
  opt?.group ? pinRows(model, { lockAxes: false }) : pins, dragRows(model, names, dx, dy, cx0, cy0, ax0, opt)));
const roleOf = (nm) => model.roles.get(nm);
const at = (nm) => model.idx.get(nm);
const cases = [];
{
  const free = P.names.find((nm) => !roleOf(nm)) ?? P.names[0];
  const i = at(free), dx = 0.6 * P.w[i], dy = 0.4 * P.h[i];
  const e = drag([free], dx, dy);
  console.log(`\n편집 1: ${free} 를 (+${dx.toFixed(0)}, +${dy.toFixed(0)}) 끌기 (축 고정) -> 실제 이동 (${(e.cx[i] - cx0[i]).toFixed(0)}, ${(e.cy[i] - cy0[i]).toFixed(0)})  겹침 ${(exactOverlap(e.cx, e.cy, P.w, P.h) / blockArea).toExponential(1)}  잔차 ${symmetryResidual(P, e.cx, e.cy).toExponential(1)}`);
  cases.push(["끌기(자유 블록)", e]);
}
{
  const pairName = P.names.find((nm) => roleOf(nm)?.len === 2);
  if (pairName) {
    const r = roleOf(pairName), i = at(pairName), j = at(r.pair[1 - r.pos]);
    const e = drag([pairName], 0.5 * P.w[i], 1.2 * P.h[i]);
    console.log(`\n편집 2: 거울 쌍 ${pairName} 를 (+${(0.5 * P.w[i]).toFixed(0)}, +${(1.2 * P.h[i]).toFixed(0)}) 끌기 -> 자신 (${(e.cx[i] - cx0[i]).toFixed(0)}, ${(e.cy[i] - cy0[i]).toFixed(0)})  짝 ${r.pair[1 - r.pos]} (${(e.cx[j] - cx0[j]).toFixed(0)}, ${(e.cy[j] - cy0[j]).toFixed(0)})  축 이동 ${(e.ax[r.k] - ax0[r.k]).toFixed(1)}`);
    cases.push(["끌기(거울 쌍 한쪽)", e]);
  }
  const selfName = P.names.find((nm) => roleOf(nm)?.len === 1);
  if (selfName) {
    const r = roleOf(selfName), i = at(selfName);
    const e = drag([selfName], 500, 2 * P.h[i]);
    const others = P.names.filter((nm, k) => k !== i && Math.abs(e.cx[k] - cx0[k]) + Math.abs(e.cy[k] - cy0[k]) > 1e-6);
    console.log(`\n편집 3: 축 위 블록 ${selfName} 를 (+500, +${(2 * P.h[i]).toFixed(0)}) 끌기 (축 고정) -> 자신 (${(e.cx[i] - cx0[i]).toFixed(0)}, ${(e.cy[i] - cy0[i]).toFixed(0)})  같이 움직인 것: ${others.join(" ") || "없음"}`);
    cases.push(["끌기(축 위 블록, 축 방향)", e]);
    const g = drag([selfName], 700, 0, { group: true });
    const moved = P.names.filter((nm, k) => Math.abs(g.cx[k] - cx0[k]) > 1e-6).length;
    console.log(`편집 4: 축 ${r.k} 을 +700 끌기 (그룹째) -> 축 ${(g.ax[r.k] - ax0[r.k]).toFixed(0)}, x 가 움직인 블록 ${moved}/${n}`);
    cases.push(["축 끌기", g]);
  }
}
{
  const selfs = P.names.filter((nm) => roleOf(nm)?.len === 1);
  if (selfs.length >= 2) {
    const [a, b] = [at(selfs[0]), at(selfs[1])];
    const e = centers(model, dragTheta(model, model.theta, pins, [[2 * a + 1, cy0[b]], [2 * b + 1, cy0[a]]]));
    console.log(`\n편집 5: ${selfs[0]} <-> ${selfs[1]} 자리 바꾸기 (y)  겹침 ${(exactOverlap(e.cx, e.cy, P.w, P.h) / blockArea).toExponential(1)}`);
    cases.push(["자리 바꾸기(축 위 둘)", e]);
  }
}
{
  const i = n - 1, j = 0;
  const e = drag([P.names[i]], cx0[j] + 0.3 * P.w[j] - cx0[i], cy0[j] + 0.2 * P.h[j] - cy0[i]);
  console.log(`\n편집 6: ${P.names[i]} 를 ${P.names[j]} 위에 던지기  겹침 ${(exactOverlap(e.cx, e.cy, P.w, P.h) / blockArea).toExponential(1)}`);
  cases.push(["겹치게 던지기", e]);
}

console.log("\n--- 편집 좌표에서 토폴로지 유지 정리 (관계 하나 / 둘 다 / 압축 없이) ---");
function show(label, e, opts) {
  const r = settle(model, e.cx, e.cy, model.sx, model.sy, opts);
  if (r.status !== "OPTIMAL") { console.log(`  ${label.padEnd(34)} ${r.status}${r.orderBad?.length ? " (Order 위반 " + r.orderBad.join(", ") + ")" : ""}  ${r.ms.toFixed(0)} ms`); return; }
  const out = toRects(model, r.cx, r.cy, model.sx, model.sy);
  let move = 0, maxMove = 0;
  for (let i = 0; i < n; i++) { const d = Math.abs(r.cx[i] - e.cx[i]) + Math.abs(r.cy[i] - e.cy[i]); move += d; maxMove = Math.max(maxMove, d); }
  const relE = relations(model, e.cx, e.cy), relF = relations(model, r.cx, r.cy);
  let kept = 0, tot = 0;
  relE.forEach((q, k) => { const f = relF[k]; if (q.x >= 0 || q.y >= 0) { tot++; if ((q.x >= 0 && f.x === q.x) || (q.y >= 0 && f.y === q.y)) kept++; } });
  console.log(`  ${label.padEnd(34)} OPTIMAL${r.slack > 1.6 ? `(slack ${r.slack})` : ""} ${r.ms.toFixed(0).padStart(5)} ms  겹침 ${(out.overlap / blockArea).toExponential(1)}  잔차 ${out.resid.toExponential(1)}  격자밖 ${out.offgrid}  ` +
              `이동 합 ${move.toFixed(0)} 최대 ${maxMove.toFixed(0)}  관계 ${kept}/${tot}  면적 ${(out.area / base.area).toFixed(3)}x  HPWL ${(out.hpwl / base.hpwl).toFixed(3)}x  점수 ${(out.score - base.score).toFixed(3)}`);
}
for (const [label, e] of cases) {
  show(label + " · 하나", e, {});
  show(label + " · 둘 다", e, { both: true });
  show(label + " · 하나, 압축 0", e, { compact: 0 });
}
show("편집 없음 · 하나", { cx: cx0, cy: cy0 }, {});
