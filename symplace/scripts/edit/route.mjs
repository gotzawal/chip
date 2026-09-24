/** 실측 (symplace/PLAN-edit.md 4.7 절, 8.2 절): 배선 편집의 두 길을 페이지와 같은 세션 API 로 잰다.
 *
 *  A. 재검사만: 옮길 수 있는 조각마다 범위 안의 옆 트랙으로 옮기고(이웃 조각·비아가 따라온다) 배선기 없이
 *     compose + DRC/LVS + GDS 를 다시 한다. 시간과 오류 수를 넷마다 찍는다.
 *  B. 넷 고정 재배선: 넷 하나를 고정하고(경로를 장애물로 심고 DoNotRoute) 나머지를 다시 배선한 뒤 되붙인다.
 *     DRC/LVS 가 기준과 같은가, 다른 넷이 얼마나 바뀌나.
 *
 *  합격선은 검사(test/edit-wires.mjs, test/edit-compact.mjs)가 쥔다 — 이 스크립트는 수치를 보여 주는 쪽이다.
 *
 *  실행:  node symplace/scripts/edit/route.mjs <예제> [고정할 넷 수=3]   (저장소 루트에서; 배치는 scripts/route/node 와 같은 캐시)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAlignRouter } from "../../../src/route/alignroute.mjs";
import { routeSession, sessionOutput, recheck } from "../../../src/route/pipeline.mjs";
import { buildGraph, range, slide, toNode, worldShapes, cloneGraph, netLength } from "../../../src/edit/wires.mjs";
import { runJob } from "../../../src/job.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const [ex = "telescopic_ota", nFreeze = "3"] = process.argv.slice(2);
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const blob = J(path.join(ROOT, "data", ex + ".json"));
const leaves = J(path.join(ROOT, "data", ex + ".leaves.json"));
const design = { topology: blob.topology, primitives: blob.primitives };
const router = await loadAlignRouter(fs.readFileSync(path.join(ROOT, "src/route/alignroute.wasm")));

fs.mkdirSync(CACHE, { recursive: true });
const pfile = path.join(CACHE, `place-${ex}.json`);
let placement;
if (fs.existsSync(pfile)) placement = J(pfile);
else {
  let ours = null;
  await runJob({ name: ex, blob, batch: 48, gpu: false }, (m) => { if (m.type === "done") ours = m; if (m.type === "error") throw new Error(m.msg); });
  placement = {
    bbox: [0, 0, Math.round(ours.bbox[2] - ours.bbox[0]), Math.round(ours.bbox[3] - ours.bbox[1])],
    instances: ours.rects.map((r) => ({ name: r.name, concrete: r.concrete, oX: Math.round(r.sx > 0 ? r.x : r.x + r.w), oY: Math.round(r.sy > 0 ? r.y : r.y + r.h), sX: r.sx > 0 ? 1 : -1, sY: r.sy > 0 ? 1 : -1 })),
    subModules: ours.subModules ?? [],
  };
  fs.writeFileSync(pfile, JSON.stringify(placement));
}

const kinds = (errs) => { const k = new Map(); for (const e of errs) { const t = e.split(" ")[0]; k.set(t, (k.get(t) ?? 0) + 1); } return [...k].map(([a, b]) => `${a} ${b}`).join(", ") || "-"; };
const S = (v) => v / 2;      // PnRDB -> PDK

let t0 = performance.now();
const session = await routeSession({ design, leaves, placement, router });
const out0 = sessionOutput(session);
const base = out0.errors.length;
const model = out0.wires;
console.log(`${ex}: 배선 ${(performance.now() - t0).toFixed(0)} ms  넷 ${model.nets.length}  DRC/LVS ${base} (${kinds(out0.errors)})  도형 ${out0.geo.terminals.length}  GDS ${(out0.gds.length / 1024).toFixed(0)}K`);
const graphs = new Map(model.nets.map((n) => [n.name, buildGraph(n)]));
for (const n of model.nets) {
  const g = graphs.get(n.name);
  console.log(`  ${n.name.padEnd(8)} 핀 ${n.pins.length}  토막 ${n.path_metal.length} -> 조각 ${g.segs.length}  비아 ${n.path_via.length} -> ${g.vias.length}  길이 ${S(netLength(g))}`);
}

// --- A. 조각을 옆 트랙으로 옮기고 배선기 없이 재검사 ---
console.log("\n--- A. 옮길 수 있는 조각마다 옆 트랙으로 옮기고 배선기 없이 재검사 ---");
let locked = 0, movable = 0;
for (const n of model.nets) {
  const g0 = graphs.get(n.name);
  if (!g0.segs.length) continue;
  const world = worldShapes(model, graphs, n.name);
  for (const s0 of g0.segs) {
    const r = range(g0, s0, world, model.bbox);
    if (r.locked) { locked++; continue; }
    movable++;
    const i = r.tracks.indexOf(s0.t);
    const t = r.tracks[i + 1] ?? r.tracks[i - 1];
    if (t === undefined) continue;
    const g = cloneGraph(g0);
    slide(g, g.segs[s0.id], t);
    t0 = performance.now();
    const o = recheck(session, [{ net: n.name, ...toNode(g) }]);
    const ms = performance.now() - t0;
    console.log(`  ${n.name.padEnd(8)} 조각 ${s0.id} ${s0.layer} ${S(s0.t)} -> ${S(t)} (범위 ${S(r.lo)}~${S(r.hi)}, 트랙 ${r.tracks.length})  재검사+GDS ${ms.toFixed(0)} ms  오류 ${o.errors.length} (기준 ${base})${o.errors.length > base ? "  " + o.errors.filter((x) => !out0.errors.includes(x)).slice(0, 2).map((x) => x.slice(0, 100)).join(" | ") : ""}`);
    recheck(session, [{ net: n.name, restore: true }]);
  }
}
console.log(`  옮길 수 있는 조각 ${movable}, 잠긴 조각 ${locked}`);

// --- B. 넷 고정, 나머지 재배선 ---
console.log("\n--- B. 넷 하나를 고정(장애물 + DoNotRoute)하고 나머지를 다시 배선, 되붙인 뒤 검사 ---");
for (const n of model.nets.filter((q) => q.path_metal.length).slice(0, Number(nFreeze))) {
  const frozen = [{ net: n.name, path_metal: n.path_metal, path_via: n.path_via }];
  t0 = performance.now();
  const s2 = await routeSession({ design, leaves, placement, router, frozen });
  const o = sessionOutput(s2);
  const ms = performance.now() - t0;
  const got = o.wires.nets.find((q) => q.name === n.name);
  const same = JSON.stringify(got.path_metal) === JSON.stringify(n.path_metal) && JSON.stringify(got.path_via) === JSON.stringify(n.path_via);
  const changed = o.wires.nets.filter((q) => q.name !== n.name && JSON.stringify(q.path_metal) !== JSON.stringify(model.nets.find((z) => z.name === q.name).path_metal)).length;
  console.log(`  고정 ${n.name.padEnd(8)} 배선 ${ms.toFixed(0)} ms  DRC/LVS ${o.errors.length} (기준 ${base})  경로 그대로 ${same}  다른 넷 바뀜 ${changed}/${model.nets.length - 1}`);
}
