/** 배선 경로(ALIGN 배선 단계의 이식)를 node 에서 끝까지 — 페이지의 "배선 실행" 과 같은 길이다:
 *  src/route/pipeline.mjs = 입력·PnRDB·배치·계층(JS) -> alignroute.wasm (RouteWork 4·5, 최상위 2·3) ->
 *  도형 모으기 -> DRC/LVS -> GDS.
 *
 *    node newroute.mjs <예제|all> [--place=<파일>] [--batch=48] [옵션]
 *
 *    배치는 place.mjs 가 쓴 ~/.cache/symplace/place-<예제>.json 을 쓰고, 없으면 그 자리에서
 *    배치기를 돌려(시작점 --batch, 기본 48) 그 캐시를 만든다. --place=<파일> 이면 그 배치를 쓴다
 *    --gds=<파일>    GDS 를 쓴다
 *    --json=<파일>   최종 도형 (ALIGN 의 <TOP>_0.json 과 같은 모양)
 *    --errors=N      오류 문구를 몇 줄 찍을지 (기본 8)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAlignRouter } from "../../../../src/route/alignroute.mjs";
import { routeDesign } from "../../../../src/route/pipeline.mjs";
import { runJob } from "../../../../src/job.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const WORK_CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const MODES = { 4: "전역 배선", 5: "상세 배선", 2: "전원 격자", 3: "전원 배선" };

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const which = args.find((a) => !a.startsWith("--"));
if (!which) { console.error("사용법: node newroute.mjs <예제|all> [--place=<파일>] [--batch=48]"); process.exit(2); }
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const router = await loadAlignRouter(fs.readFileSync(path.join(ROOT, "src/route/alignroute.wasm")));
const nErr = Number(opt("errors", 8));

/** 캐시의 우리 배치, 없으면 지금 배치해서 캐시에 쓴다 (scripts/route/node/place.mjs 와 같은 변환). */
async function ourPlacement(ex, blob) {
  const file = path.join(WORK_CACHE, `place-${ex}.json`);
  if (fs.existsSync(file)) return J(file);
  let ours = null;
  await runJob({ name: ex, blob, batch: Number(opt("batch", 48)), gpu: false }, (m) => {
    if (m.type === "done") ours = m;
    if (m.type === "error") throw new Error(m.msg);
  });
  const placement = {
    bbox: [0, 0, Math.round(ours.bbox[2] - ours.bbox[0]), Math.round(ours.bbox[3] - ours.bbox[1])],
    instances: ours.rects.map((r) => ({
      name: r.name, concrete: r.concrete,
      oX: Math.round(r.sx > 0 ? r.x : r.x + r.w), oY: Math.round(r.sy > 0 ? r.y : r.y + r.h),
      sX: r.sx > 0 ? 1 : -1, sY: r.sy > 0 ? 1 : -1,
    })),
    subModules: ours.subModules ?? [],
  };
  fs.mkdirSync(WORK_CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(placement));
  return placement;
}

const names = which === "all"
  ? J(path.join(ROOT, "data/index.json")).map((x) => (typeof x === "string" ? x : x.name)).filter((n) => fs.existsSync(path.join(ROOT, "data", n + ".leaves.json")))
  : [which];
let total = 0;
for (const ex of names) {
  const design = J(path.join(ROOT, "data", ex + ".json"));
  const leaves = J(path.join(ROOT, "data", ex + ".leaves.json"));
  const pl = opt("place", "ours");
  const placement = pl === "ours" ? await ourPlacement(ex, design) : J(pl);
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
