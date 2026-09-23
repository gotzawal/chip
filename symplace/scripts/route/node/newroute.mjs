/** 새 배선 경로를 node 에서 끝까지 — 배선 문제 -> Rust 배선기(wasm) -> 도형 합성 -> DRC/LVS -> GDS.
 *
 *    node newroute.mjs <예제|all> [--place=align|ours|<파일>] [옵션]
 *
 *    --place=align   예제에 든 ALIGN 배치 (기본 — 캐시가 없어도 된다)
 *    --place=ours    place.mjs 가 쓴 ~/.cache/symplace/place-<예제>.json
 *    --layers=M2-M4  배선층 범위
 *    --bin=<파일>    배선 문제를 i32 파일로 쓴다 (cargo run --release -- <파일> 로 네이티브 디버깅)
 *    --gds=<파일>    GDS 를 쓴다
 *    --svg=<파일>    배선 그림
 *    --errors=N      오류 문구를 몇 줄 찍을지 (기본 8)
 *    --fixture=<폴더> 최종 도형(리프 + 배선)을 검사기 고정 사례 꼴로 <폴더>/route-<예제>.json 에 쓴다.
 *                    node checkref.mjs check <파일> <파일> 로 ALIGN 파이썬 검사기의 판정을 채우고
 *                    node ../../../web/placer/test/check.mjs <파일> 로 JS 와 맞춘다.
 */
import fs from "node:fs";
import path from "node:path";
import { WORK_CACHE, ROOT } from "./align.mjs";
import { check, checkerRules, errorLines } from "../../../../src/route/check.mjs";
import { metalGrids, offGrid } from "../../../../src/route/compose.mjs";
import { topGds } from "../../../../src/route/gds.mjs";
import { readLeaves } from "../../../../src/route/leaves.mjs";
import { MOCK_PDK } from "../../../../src/route/pdk.mjs";
import { buildProblem, placementFromAlign } from "../../../../src/route/problem.mjs";
import { loadRouter, packProblem } from "../../../../src/route/router.mjs";
import { FIXTURE_FORMAT, toRow } from "../../../web/placer/test/checkcases.mjs";

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const which = args.find((a) => !a.startsWith("--"));
if (!which) { console.error("사용법: node newroute.mjs <예제|all> [--place=align|ours|<파일>]"); process.exit(2); }
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const [minLayer, maxLayer] = opt("layers", "M2-M4").split("-");
const rules = checkerRules(MOCK_PDK), grids = metalGrids(MOCK_PDK);
const router = await loadRouter(fs.readFileSync(path.join(ROOT, "src/route/router.wasm")));
const nErr = Number(opt("errors", 8));

const names = which === "all"
  ? J(path.join(ROOT, "data/index.json")).map((x) => (typeof x === "string" ? x : x.name)).filter((n) => fs.existsSync(path.join(ROOT, "data", n + ".leaves.json")))
  : [which];
let total = 0;
for (const ex of names) {
  const design = J(path.join(ROOT, "data", ex + ".json"));
  const leaves = readLeaves(J(path.join(ROOT, "data", ex + ".leaves.json")));
  const pl = opt("place", "align");
  const placement = pl === "align" ? placementFromAlign(design.place)
    : pl === "ours" ? J(path.join(WORK_CACHE, `place-${ex}.json`)) : J(pl);
  const t0 = performance.now();
  const { problem, layout } = buildProblem({ design, leaves, placement, pdk: MOCK_PDK });
  const t1 = performance.now();
  if (opt("bin")) {
    const b = packProblem(problem, { minLayer, maxLayer });
    fs.writeFileSync(names.length > 1 ? opt("bin").replace(/(\.bin)?$/, `-${ex}.bin`) : opt("bin"), Buffer.from(b.buffer));
  }
  const r = router.route(problem, { minLayer, maxLayer });
  const t2 = performance.now();
  const wires = r.wires.map((w) => ({ netName: w.netName, netType: "drawing", layer: w.layer, rect: w.rect }));
  const res = check([...layout.terminals, ...wires], rules, { subinsts: layout.subinsts, postprocess: true });
  const grid = wires.flatMap((w) => offGrid(w, grids, "route"));
  const t3 = performance.now();
  const lines = errorLines(res, grid);
  const known = res.differentWidths.filter((w) => !/^(M|V)\d/.test(w.layer)).length;
  const errors = lines.length - known;
  total += errors;
  const want = problem.nets.filter((n) => n.parts > 1).length;
  console.log(`${ex.padEnd(28)} ${pl.padEnd(5)} 넷 ${want}  사각형 ${String(r.wires.length).padStart(4)}  못 이음 ${r.failed.length}` +
              `  반복 ${String(r.iterations).padStart(2)}  배선기 위반 ${r.violations}` +
              `  | SHORT ${res.shorts.length} OPEN ${res.opens.length} DRC ${res.drc.length} 후처리 ${res.post.length} 격자 ${grid.length}` +
              ` 폭 ${res.differentWidths.length}(소자층 ${known})` +
              `  | 문제 ${(t1 - t0).toFixed(0)}ms 배선 ${r.ms.toFixed(0)}ms 검사 ${(t3 - t2).toFixed(0)}ms`);
  if (r.failed.length) console.log("    못 이은 넷:", r.failed.join(", "));
  for (const l of lines.filter((l) => !/DIFFERENT WIDTH \('Rectangles on layer (Rvt|Lvt|Hvt|Slvt|Fin|Poly|Active)/.test(l)).slice(0, nErr))
    console.log("    " + l.slice(0, 220));
  if (opt("fixture")) {
    fs.mkdirSync(opt("fixture"), { recursive: true });
    const fx = { format: FIXTURE_FORMAT, source: `${ex} ${problem.name} (새 배선, ${pl} 배치)`,
                 base: { rows: [...layout.terminals, ...wires].map(toRow), subinsts: layout.subinsts, netsAllowedToBeOpen: [], postprocess: true },
                 cases: [{ label: "배선 결과", ops: [] }], results: [] };
    fs.writeFileSync(path.join(opt("fixture"), `route-${ex}.json`), JSON.stringify(fx));
  }
  if (opt("gds")) {
    const bb = res.terminals.reduce((a, t) => [Math.min(a[0], t.rect[0]), Math.min(a[1], t.rect[1]), Math.max(a[2], t.rect[2]), Math.max(a[3], t.rect[3])],
                                    [Infinity, Infinity, -Infinity, -Infinity]);
    fs.writeFileSync(opt("gds"), topGds({ name: problem.name, terminals: res.terminals, bbox: bb }, MOCK_PDK));
  }
  if (opt("svg")) fs.writeFileSync(names.length > 1 ? opt("svg").replace(/(\.svg)?$/, `-${ex}.svg`) : opt("svg"), svg(layout.terminals, wires, placement.bbox));
}
if (names.length > 1) console.log(`\n오류 합계 ${total} (소자층 DIFFERENT WIDTH 제외)`);

function svg(fixed, wires, bbox) {
  const col = { M1: "#1f77b4", M2: "#d62728", M3: "#2ca02c", M4: "#9467bd", M5: "#8c564b", M6: "#e377c2", V1: "#000", V2: "#000", V3: "#000", V4: "#000", V5: "#000" };
  const [x0, y0, x1, y1] = [bbox[0] - 400, bbox[1] - 400, bbox[2] + 400, bbox[3] + 400];
  const rect = (t, op) => `<rect x="${t.rect[0]}" y="${-t.rect[3]}" width="${t.rect[2] - t.rect[0]}" height="${t.rect[3] - t.rect[1]}" fill="${col[t.layer]}" fill-opacity="${op}"><title>${t.layer} ${t.netName}</title></rect>`;
  const body = [
    ...fixed.filter((t) => col[t.layer] && !/^V/.test(t.layer)).map((t) => rect(t, 0.18)),
    ...wires.map((t) => rect(t, /^V/.test(t.layer) ? 0.9 : 0.6)),
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${-y1} ${x1 - x0} ${y1 - y0}" width="${Math.round((x1 - x0) / 8)}" height="${Math.round((y1 - y0) / 8)}"><rect x="${x0}" y="${-y1}" width="${x1 - x0}" height="${y1 - y0}" fill="#fff"/>${body.join("")}</svg>`;
}
