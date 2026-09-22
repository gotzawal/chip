/** 앞단 출력만으로 배치까지 — ALIGN 배치기 없이.
 *
 *  이 검사가 성립하면 "넷리스트를 주면 브라우저가 배치한다"가 참이 된다.
 *  ALIGN 의 place 결과는 **기준선으로만** 쓴다 (면적/HPWL 비교, 변이·반전 대조).
 *
 *  보는 것:
 *    변이 배정   우리가 고른 것 vs ALIGN 이 고른 것
 *    거울 반전   같은 비교
 *    품질        면적비, HPWL비, 겹침, 대칭 잔차
 *    legalize    상위 후보 중 몇 개가 풀렸나 (영역 후보가 나쁘면 INFEASIBLE)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDesign, alignBaseline } from "./_load.mjs";
import { placeHierarchy, symmetryResidual, orderViolations } from "../../../../src/place.mjs";
import { topIndex } from "../../../../src/design.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DES = path.join(HERE, "..", "fixtures", "design");
const BATCH = Number(process.env.BATCH ?? 96);
const ITERS = Number(process.env.ITERS ?? 600);
// REF=align 이면 점수 정규화에 ALIGN 의 면적/HPWL 을 쓴다 (벤치마크 모드).
// 기본은 설계 자신에서 뽑는다 — 새 넷리스트에는 ALIGN 의 답이 없으니 그게 진짜 경로다.
const REF = process.env.REF ?? "self";
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  실패 " + m); } };

for (const ex of fs.existsSync(DES) ? fs.readdirSync(DES).sort() : []) {
  const dir = path.join(DES, ex);
  if (!fs.statSync(dir).isDirectory()) continue;
  console.log("\n=== " + ex + " ===");
  const { topology, primitives, templates, place } = loadDesign(dir);

  // ALIGN 기준선은 place JSON 에서 **직접** 잰다.
  //
  // fixtures/*.json 을 쓰지 않는다. export-fixtures.py 는 `<예제>_ours` 를 먼저
  // 찾으므로 거기 든 cx_align/cy_align 이 ALIGN 이 아니라 **우리 파이썬 배치기**의
  // 좌표일 수 있다. 실제로 high_speed_comparator 는 고정값 region 이 4320x18816,
  // ALIGN 의 bbox 는 6080x10584 로 아예 다른 레이아웃이었다.
  let refArea = 1, refHpwl = 1, alignTop = null;
  if (place) {
    const topName = topology.modules[topIndex(topology)].name;
    const base = alignBaseline(place, topName);
    refArea = base.area; refHpwl = base.hpwl; alignTop = base.top;
    console.log(`  ALIGN 기준  bbox ${base.bbox[2] - base.bbox[0]}x${base.bbox[3] - base.bbox[1]}  ` +
                `면적 ${base.area.toExponential(3)}  HPWL ${base.hpwl.toFixed(0)}`);
  }

  const t0 = Date.now();
  const hr = placeHierarchy({ topology, primitives, templates },
    { batch: BATCH, iters: ITERS, seed: 1,
      ...(REF === "align" ? { refArea, refHpwl } : {}) });
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
  console.log(`  블록 ${r.names.length}  변이조합 ${r.totalAssignments}  설정 ${r.configs}  ` +
              `legalize ${r.tried - r.legalizeFail}/${r.tried}  ${dt.toFixed(1)}s`);
  console.log(`  면적 ${(r.area / refArea).toFixed(3)}x  HPWL ${(r.hpwl / refHpwl).toFixed(3)}x  ` +
              `겹침 ${(r.overlap / blockArea).toExponential(1)}  대칭잔차 ${resid.toExponential(1)}  ` +
              `bbox ${Math.round(bw)}x${Math.round(bh)}`);
  if (r.hpwlBeforeFlip != null)
    console.log(`  반전 고르기 전 HPWL ${r.hpwlBeforeFlip.toFixed(0)} -> 후 ${r.hpwl.toFixed(0)}  (${(r.hpwl / r.hpwlBeforeFlip).toFixed(3)}x)`);
  ok(r.overlap / blockArea < 1e-9, `겹침 비율 ${r.overlap / blockArea}`);
  ok(resid < 1e-6, `대칭 잔차 ${resid}`);
  const ordBad = orderViolations(r.problem, r.cx, r.cy);
  const nOrder = (r.problem.constraints ?? []).filter((c) => c.constraint === "Order").length;
  if (nOrder) console.log(`  Order 제약 ${nOrder} 개 — 위반 ${ordBad.length} 건` +
                          (ordBad.length ? ": " + ordBad.join(", ") : ""));
  ok(ordBad.length === 0, `Order 위반 ${ordBad.join(", ")}`);
  // 품질은 수치로 보고하되, 구조가 깨졌을 때만 실패로 본다.
  // (면적 3 배는 "다른 절충"이 아니라 무언가 고장난 것이다)
  ok(r.area / refArea < 3, `면적이 기준의 ${(r.area / refArea).toFixed(1)} 배다 — 구조 문제`);

  if (alignTop) {
    const ac = new Map(alignTop.instances.map((i) => [i.instance_name, i.concrete_template_name]));
    const at = new Map(alignTop.instances.map((i) => [i.instance_name, i.transformation]));
    const vAgree = r.names.filter((n, i) => ac.get(n) === r.concrete[i]).length;
    const fAgree = r.names.filter((n, i) =>
      at.get(n) && Math.sign(at.get(n).sX) === Math.sign(r.sx[i])
                && Math.sign(at.get(n).sY) === Math.sign(r.sy[i])).length;
    console.log(`  ALIGN 과 일치 — 변이 ${vAgree}/${r.names.length}, 반전 ${fAgree}/${r.names.length}`);
    const diff = r.names.filter((n, i) => ac.get(n) !== r.concrete[i]);
    if (diff.length) console.log("    변이 다른 블록: " +
      diff.map((n) => `${n} 우리=${r.concrete[r.names.indexOf(n)]} ALIGN=${ac.get(n)}`).join(", "));
  }
}
console.log(fails ? `\n실패 ${fails} 건` : "\n전부 통과");
process.exit(fails ? 1 : 0);
