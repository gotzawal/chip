/** 배선 경로(ALIGN 배선 단계의 이식)를 node 에서 끝까지 — 페이지의 "배선 실행" 과 같은 길이다:
 *  src/route/pipeline.mjs = 입력·PnRDB·배치·계층(JS) -> alignroute.wasm (RouteWork 4·5, 최상위 2·3) ->
 *  도형 모으기 -> DRC/LVS -> GDS.
 *
 *    node newroute.mjs <예제|all> [--place=align|ours|<파일>] [옵션]
 *
 *    --place=align   예제에 든 ALIGN 배치 (기본 — 캐시가 없어도 된다)
 *    --place=ours    place.mjs 가 쓴 ~/.cache/symplace/place-<예제>.json
 *    --gds=<파일>    GDS 를 쓴다
 *    --json=<파일>   최종 도형 (ALIGN 의 <TOP>_0.json 과 같은 모양)
 *    --errors=N      오류 문구를 몇 줄 찍을지 (기본 8)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAlignRouter } from "../../../../src/route/alignroute.mjs";
import { placementFromAlign } from "../../../../src/route/hier.mjs";
import { routeDesign } from "../../../../src/route/pipeline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const WORK_CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const MODES = { 4: "전역 배선", 5: "상세 배선", 2: "전원 격자", 3: "전원 배선" };

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const which = args.find((a) => !a.startsWith("--"));
if (!which) { console.error("사용법: node newroute.mjs <예제|all> [--place=align|ours|<파일>]"); process.exit(2); }
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const router = await loadAlignRouter(fs.readFileSync(path.join(ROOT, "src/route/alignroute.wasm")));
const nErr = Number(opt("errors", 8));

const names = which === "all"
  ? J(path.join(ROOT, "data/index.json")).map((x) => (typeof x === "string" ? x : x.name)).filter((n) => fs.existsSync(path.join(ROOT, "data", n + ".leaves.json")))
  : [which];
let total = 0;
for (const ex of names) {
  const design = J(path.join(ROOT, "data", ex + ".json"));
  const leaves = J(path.join(ROOT, "data", ex + ".leaves.json"));
  const pl = opt("place", "align");
  const placement = pl === "align" ? placementFromAlign(design.place)
    : pl === "ours" ? J(path.join(WORK_CACHE, `place-${ex}.json`)) : J(pl);
  const t0 = performance.now();
  let out;
  try {
    out = await routeDesign({ design: { topology: design.topology, primitives: design.primitives }, leaves, placement, router });
  } catch (e) {
    console.log(`${ex.padEnd(28)} ${pl.padEnd(5)} 실패: ${e.message}`);
    total++;
    continue;
  }
  const secs = (performance.now() - t0) / 1000;
  total += out.errors.length;
  console.log(`${ex.padEnd(28)} ${pl.padEnd(5)} 모듈 ${out.stats.modules}  넷 ${out.stats.nets}  DRC/LVS ${out.errors.length}` +
              `  배선기 ${out.stats.routerMs.toFixed(0)} ms  전체 ${secs.toFixed(2)} s  GDS ${(out.gds.length / 1024).toFixed(0)}K`);
  for (const r of out.records) console.log(`    ${r.module.padEnd(30)} ${r.mode} ${(MODES[r.mode] ?? "").padEnd(6)} ${(r.ms ?? 0).toFixed(0).padStart(6)} ms`);
  for (const l of out.errors.slice(0, nErr)) console.log("    " + l.slice(0, 220));
  for (const w of out.warnings.slice(0, nErr)) console.log("    경고: " + w.slice(0, 220));
  const file = (o) => (names.length > 1 ? o.replace(/(\.[a-z]+)?$/, `-${ex}$1`) : o);
  if (opt("gds")) fs.writeFileSync(file(opt("gds")), out.gds);
  if (opt("json")) fs.writeFileSync(file(opt("json")), JSON.stringify(out.geo));
}
if (names.length > 1) console.log(`\n오류 합계 ${total}`);
