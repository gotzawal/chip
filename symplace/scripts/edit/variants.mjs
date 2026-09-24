/** 스파이크 (symplace/PLAN-edit.md 3.1·3.5 절의 실측).
 *  (1) 계층 설계에서 페이지가 워커의 done 메시지 + 편집 키트만으로 최상위 문제를 다시 지으면 배치기 안의 문제와
 *      같은가 (크기·핀).
 *  (2) 위상(분리 방향)을 유지한 채 variant 배정을 전수로 바꿔 정리하면 점수가 좋아지는 배정이 있는가.
 *
 *  src/edit/place.mjs 의 editKit / rebuild / retryVariants 를 그대로 부른다 — 페이지의 편집기와 같은 코드다.
 *
 *  실행:  node symplace/scripts/edit/variants.mjs <예제> [시작점=48]   (저장소 루트에서)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeHierarchy } from "../../../src/place.mjs";
import { editKit, rebuild, centers, toRects, retryVariants, GRID } from "../../../src/edit/place.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const [ex = "high_speed_comparator", batchArg = "48"] = process.argv.slice(2);
const blob = JSON.parse(fs.readFileSync(path.join(ROOT, "data", ex + ".json"), "utf8"));
const t0 = performance.now();
const hr = await placeHierarchy(blob, { batch: Number(batchArg), iters: 600, seed: 1, grid: GRID });
if (!hr.ok) { console.log("배치 실패", hr.reason); process.exit(1); }
const top = hr.top, P0 = top.problem;
console.log(`${ex}: 배치 ${((performance.now() - t0) / 1000).toFixed(1)}s  모듈 ${hr.order.length}  최상위 블록 ${P0.n}`);

// --- (1) 편집 키트로 문제를 다시 짓는다 ---
const kit = editKit(hr, GRID);
const [ox0, oy0] = [top.box[0], top.box[1]];
const rects = P0.names.map((nm, i) => ({ name: nm, concrete: top.concrete[i],
  x: top.cx[i] - P0.w[i] / 2 - ox0, y: top.cy[i] - P0.h[i] / 2 - oy0, w: P0.w[i], h: P0.h[i], sx: top.sx[i], sy: top.sy[i] }));
const model = rebuild(blob, kit, rects);
const P = model.P;
let dw = 0, dp = 0;
for (let i = 0; i < P.n; i++) dw = Math.max(dw, Math.abs(P.w[i] - P0.w[i]), Math.abs(P.h[i] - P0.h[i]));
for (let p = 0; p < Math.min(P.pinOff.length, P0.pinOff.length); p++) dp = Math.max(dp, Math.abs(P.pinOff[p] - P0.pinOff[p]));
const same = P.names.join() === P0.names.join() && P.n === P0.n && P.pinInst.length === P0.pinInst.length;
console.log(`(1) 키트로 다시 지은 문제: 이름·수 같음 ${same}  크기 차 ${dw}  핀 오프셋 차 ${dp}  핀 ${P.pinInst.length}/${P0.pinInst.length}  키트 템플릿 ${Object.keys(kit.subTemplates).length} 개 (${JSON.stringify(kit).length} 바이트)`);

// --- (2) 위상 유지 variant 재선택 ---
const { cx, cy } = centers(model);
const base = toRects(model, cx, cy, model.sx, model.sy);
const rv = retryVariants(model, cx, cy, model.sx, model.sy, { cap: 128 });
console.log(`(2) 배정 ${rv.total} 개 (본 것 ${rv.tried}, 풀린 것 ${rv.ranking.length}) 를 같은 분리 방향으로 정리: ${rv.ms.toFixed(0)} ms (배정당 ${(rv.ms / rv.tried).toFixed(0)} ms)` +
            `  기준 점수 ${base.score.toFixed(3)}, bbox ${Math.round(base.bbox[2])}x${Math.round(base.bbox[3])}, HPWL ${base.hpwl.toFixed(0)}`);
for (const r of rv.ranking.slice(0, 5))
  console.log(`    ${r.assignment.join(",").padEnd(14)} 점수 ${r.score.toFixed(3)} (${r.score - base.score >= 0 ? "+" : ""}${(r.score - base.score).toFixed(3)})  bbox ${Math.round(r.bbox[2])}x${Math.round(r.bbox[3])}  HPWL ${r.hpwl.toFixed(0)}  겹침 ${r.out.overlap.toExponential(1)} 잔차 ${r.out.resid.toExponential(1)} 격자밖 ${r.out.offgrid}` + (r.current ? "  <- 지금 배정" : ""));
console.log(`    지금 배정의 순위 ${rv.current + 1}/${rv.ranking.length}` +
            (rv.current > 0 ? `  (1 위와 점수 차 ${(rv.ranking[0].score - base.score).toFixed(3)} = 면적x배선 ${Math.exp(rv.ranking[0].score - base.score).toFixed(3)} 배)` : ""));
