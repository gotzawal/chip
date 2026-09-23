/** 새 배선 경로 전체 — 배선 문제 -> Rust 배선기(src/route/router.wasm) -> 도형 합성 -> DRC/LVS.
 *
 *  예제마다 ALIGN 배치(늘 있다)와 캐시의 우리 배치(있으면)로 배선하고:
 *    - 못 이은 넷이 없다
 *    - SHORT · OPEN · DRC · 후처리 · 격자 오류가 0 이다
 *    - DIFFERENT WIDTH 는 소자층(리프 안)의 것뿐이다 — ALIGN 결과에도 똑같이 있다
 *  배선이 더한 금속 길이(층별)와 비아 수를 찍는다 — 배선 뒤와 배선 전을 검사기로 합친 도형의 차.
 *  캐시에 ALIGN 배선 기록(checkref.mjs capture)이 있으면 같은 배치의 ALIGN 배선도 같은 잣대로
 *  나란히 찍는다 (ALIGN 은 M5/M6 전원 격자까지 친다).
 *
 *    node symplace/web/placer/test/route.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, checkerRules, errorLines } from "../../../../src/route/check.mjs";
import { metalGrids, offGrid } from "../../../../src/route/compose.mjs";
import { readLeaves } from "../../../../src/route/leaves.mjs";
import { MOCK_PDK } from "../../../../src/route/pdk.mjs";
import { buildProblem, placementFromAlign } from "../../../../src/route/problem.mjs";
import { loadRouter } from "../../../../src/route/router.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const rules = checkerRules(MOCK_PDK), grids = metalGrids(MOCK_PDK);
const router = await loadRouter(fs.readFileSync(path.join(ROOT, "src/route/router.wasm")));
const DIR = Object.fromEntries(MOCK_PDK.Abstraction.filter((l) => /^M\d+$/.test(l.Layer)).map((l) => [l.Layer, l.Direction.toLowerCase()]));

/** 층별 금속 길이(트랙 방향 합)와 비아 수 — 검사기가 합친 도형에서, 색 사본은 빼고 */
function measure(shapes) {
  const len = {}, vias = {};
  for (const t of shapes) {
    if (t.color) continue;
    if (DIR[t.layer]) len[t.layer] = (len[t.layer] ?? 0) + (DIR[t.layer] === "v" ? t.rect[3] - t.rect[1] : t.rect[2] - t.rect[0]);
    else if (/^V\d+$/.test(t.layer)) vias[t.layer] = (vias[t.layer] ?? 0) + 1;
  }
  return { len, vias };
}
/** 배선이 더한 것 = 배선 뒤 - 배선 전 (둘 다 검사기가 합친 도형). 같은 배치면 ALIGN 과 견줄 수 있다. */
function added(after, before) {
  const a = measure(after), b = measure(before);
  const len = {};
  for (const l of Object.keys(a.len)) { const d = a.len[l] - (b.len[l] ?? 0); if (d) len[l] = d; }
  const nv = Object.keys(a.vias).reduce((s, l) => s + a.vias[l] - (b.vias[l] ?? 0), 0);
  const um = Object.values(len).reduce((x, y) => x + y, 0) / 1000;
  const by = Object.keys(len).sort().map((l) => `${l} ${(len[l] / 1000).toFixed(1)}`).join(" ");
  return `금속 ${um.toFixed(1).padStart(5)} µm (${by}), 비아 ${nv}`;
}

let bad = 0, n = 0;
const rows = J(path.join(ROOT, "data/index.json")).map((x) => (typeof x === "string" ? { name: x } : x));
for (const { name: ex } of rows) {
  const lp = path.join(ROOT, "data", ex + ".leaves.json");
  if (!fs.existsSync(lp)) continue;
  const design = J(path.join(ROOT, "data", ex + ".json"));
  const leaves = readLeaves(J(lp));
  const runs = [["ALIGN", design.place && placementFromAlign(design.place)]];
  const pf = path.join(CACHE, `place-${ex}.json`);
  if (fs.existsSync(pf)) runs.push(["우리", J(pf)]);
  for (const [tag, placement] of runs) {
    if (!placement) continue;
    const t0 = performance.now();
    const { problem, layout, pre } = buildProblem({ design, leaves, placement, pdk: MOCK_PDK });
    const r = router.route(problem);
    const wires = r.wires.map((w) => ({ netName: w.netName, netType: "drawing", layer: w.layer, rect: w.rect }));
    const res = check([...layout.terminals, ...wires], rules, { subinsts: layout.subinsts, postprocess: true });
    const ms = performance.now() - t0;
    const grid = wires.flatMap((w) => offGrid(w, grids, "route"));
    const wide = res.differentWidths.filter((w) => /^(M|V)\d/.test(w.layer));
    const errs = [];
    if (r.failed.length) errs.push(`못 이은 넷: ${r.failed.join(", ")}`);
    const lines = errorLines({ ...res, differentWidths: wide }, grid);
    if (lines.length) errs.push(`${lines.length} 오류: ${lines.slice(0, 4).join("\n      ")}`);
    console.log(`${ex.padEnd(28)} ${tag.padEnd(5)} 넷 ${String(problem.nets.filter((x) => x.parts > 1).length).padStart(2)}` +
                `  ${added(res.terminals, pre.terminals)}  배선기 ${r.ms.toFixed(0)}ms 전체 ${ms.toFixed(0)}ms  ${errs.length ? "틀림" : "OK"}`);
    if (tag === "우리") {
      const cf = path.join(CACHE, "check", ex + ".json");
      if (fs.existsSync(cf)) {
        const top = J(cf).cases.find((c) => c.isTop);
        console.log(`${"".padEnd(28)} ALIGN 배선기, 같은 배치  ${added(top.terminalsOut, pre.terminals)}  (M5/M6 은 전원 격자)`);
      }
    }
    for (const e of errs) console.log("    " + e);
    n++; if (errs.length) bad++;
  }
}
if (bad) { console.error(`\n${n} 건 중 ${bad} 건 틀림`); process.exit(1); }
console.log(`\n${n} 건 모두 DRC/LVS 0`);
