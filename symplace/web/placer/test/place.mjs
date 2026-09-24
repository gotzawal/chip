/** 앞단 출력만으로 배치까지 — 예제 전부를 돌려 구조를 검사한다.
 *
 *  이 검사가 성립하면 "넷리스트를 주면 브라우저가 배치한다"가 참이 된다.
 *
 *  보는 것:
 *    겹침 정확히 0, 대칭 잔차 ~0, Order 위반 0, (GRID=1 이면) 격자 밖 블록 0
 *    면적이 블록 합계 면적의 3 배 안쪽 (구조가 깨졌는지)
 *    variant 배정·반전·bbox·HPWL 은 보고만 한다
 *    legalize    상위 후보 중 몇 개가 풀렸나 (영역 후보가 나쁘면 INFEASIBLE)
 *
 *  실행:  node test/place.mjs [예제 ...]     (BATCH=, ITERS=, GRID=1, GPU=<설정당 시작점>)
 */
import { loadDesign, exampleNames } from "./_load.mjs";
import { placeHierarchy, symmetryResidual, orderViolations } from "../../../../src/place.mjs";

const BATCH = Number(process.env.BATCH ?? 96);
const ITERS = Number(process.env.ITERS ?? 600);
// GPU=<설정당 시작점> 이면 WebGPU runner (dawn — test/gpu.mjs 의 설명) 로 돈다.
let runner = null, perConfig = null;
if (process.env.GPU) {
  const { createRequire } = await import("node:module");
  const mod = createRequire(import.meta.url)(process.env.WEBGPU_NODE ?? "webgpu");
  Object.assign(globalThis, mod.globals);
  const { createGpuRunner } = await import("../../../../src/gpu/runner.mjs");
  runner = await createGpuRunner(mod.create([]));
  if (!runner) { console.log("WebGPU 어댑터가 없다"); process.exit(2); }
  perConfig = Number(process.env.GPU);
}
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  실패 " + m); } };

const wanted = process.argv.slice(2);          // 예제 이름을 주면 그것만
for (const ex of exampleNames()) {
  if (wanted.length && !wanted.includes(ex)) continue;
  console.log("\n=== " + ex + " ===");
  const { topology, primitives, templates } = loadDesign(ex);

  const t0 = Date.now();
  const hr = await placeHierarchy({ topology, primitives, templates },
    { batch: BATCH, iters: ITERS, seed: 1, ...(runner ? { runner, perConfig } : {}),
      // GRID=1 이면 페이지와 같이 배선 격자(M1 80, M2 84)까지 건다
      ...(process.env.GRID ? { grid: [80, 84] } : {}) });
  const dt = (Date.now() - t0) / 1000;
  if (!hr.ok) { fails++; console.log(`  실패 [${hr.module}] ${hr.reason}`); continue; }
  if (hr.order.length > 1)
    console.log(`  계층 ${hr.order.length} 모듈: ${hr.order.map((n) =>
      `${n}(${hr.modules.get(n).names.length})`).join(" -> ")}`);
  const r = hr.top;

  const bw = r.box[2] - r.box[0], bh = r.box[3] - r.box[1];
  let blockArea = 0;
  for (let i = 0; i < r.w.length; i++) blockArea += r.w[i] * r.h[i];
  const resid = symmetryResidual(r.problem, r.cx, r.cy);
  console.log(`  블록 ${r.names.length}  variant 조합 ${r.totalAssignments}  설정 ${r.configs}  방향뒤집기 ${r.dirFlips ?? 0}  ` +
              `시작점 ${r.starts} (${r.runner})  legalize ${r.tried - r.legalizeFail}/${r.tried} 격자 ${r.gridTried}  ${dt.toFixed(1)}s (탐색 ${r.secs.search.toFixed(1)} legalize ${r.secs.legalize.toFixed(1)})`);
  console.log(`  bbox ${Math.round(bw)}x${Math.round(bh)}  채움 ${(blockArea / Math.max(1, r.area)).toFixed(3)}  HPWL ${r.hpwl.toFixed(0)}  ` +
              `겹침 ${(r.overlap / blockArea).toExponential(1)}  대칭잔차 ${resid.toExponential(1)}` +
              (r.grid ? `  격자밖 ${r.gridOff}` : ""));
  if (r.grid) ok(r.gridOff === 0, `격자 밖 블록 ${r.gridOff}`);
  if (r.hpwlBeforeFlip != null)
    console.log(`  반전 고르기 전 HPWL ${r.hpwlBeforeFlip.toFixed(0)} -> 후 ${r.hpwl.toFixed(0)}` +
                (r.hpwlBeforeFlip > 0 ? `  (${(r.hpwl / r.hpwlBeforeFlip).toFixed(3)}x)` : ""));
  ok(r.overlap / blockArea < 1e-9, `겹침 비율 ${r.overlap / blockArea}`);
  ok(resid < 1e-6, `대칭 잔차 ${resid}`);
  const ordBad = orderViolations(r.problem, r.cx, r.cy);
  const nOrder = (r.problem.constraints ?? []).filter((c) => c.constraint === "Order").length;
  if (nOrder) console.log(`  Order 제약 ${nOrder} 개 — 위반 ${ordBad.length} 건` +
                          (ordBad.length ? ": " + ordBad.join(", ") : ""));
  ok(ordBad.length === 0, `Order 위반 ${ordBad.join(", ")}`);
  // 품질은 수치로 보고하되, 구조가 깨졌을 때만 실패로 본다.
  // (블록 합계 면적의 3 배는 "다른 절충"이 아니라 무언가 고장난 것이다)
  ok(r.area < 3 * blockArea, `면적이 블록 합계의 ${(r.area / blockArea).toFixed(1)} 배다 — 구조 문제`);
  console.log(`  variant ${r.concrete.map((c) => c.replace(/^.*_(X\d+_Y\d+)$/, "$1")).join(" ")}  ` +
              `반전 ${r.names.map((_, i) => (r.sx[i] > 0 ? "+" : "-") + (r.sy[i] > 0 ? "+" : "-")).join(" ")}`);
}
console.log(fails ? `\n실패 ${fails} 건` : "\n전부 통과");
process.exit(fails ? 1 : 0);
