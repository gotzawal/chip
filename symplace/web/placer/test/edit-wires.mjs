/** 배선 편집 검사 (src/edit/wires.mjs, src/route/pipeline.mjs 의 세션) — 넷 모델, 조각 그래프, 옮기기, 재검사, 넷 고정.
 *
 *  예제마다 (캐시의 배치로, 없으면 시작점 48 로 배치해서) 배선 세션을 만든 뒤:
 *    재검사    편집 없이 recheck 하면 route 결과와 오류·GDS 바이트·도형 수가 같다
 *    되펴기    넷마다 그래프로 읽고 그대로 되펴 넣어도 오류 수가 같다 (중복 비아·길이 0 토막이 빠질 뿐이다)
 *    옮기기    옮길 수 있는 조각마다 범위 안의 양옆 트랙으로 옮기고 재검사 — 오류가 늘지 않는다. 늘면 실패 (몇 건인지 센다)
 *    고정      넷 하나를 고정하고 다시 배선 — 되붙인 경로가 그대로고 오류가 늘지 않는다
 *
 *  실행:  node symplace/web/placer/test/edit-wires.mjs [예제 ...]     (기본 셋, ALL=1 이면 리프 도형이 있는 예제 전부)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAlignRouter } from "../../../../src/route/alignroute.mjs";
import { routeSession, sessionOutput, recheck } from "../../../../src/route/pipeline.mjs";
import { buildGraph, range, slide, toNode, worldShapes, cloneGraph, netLength, topologyKey } from "../../../../src/edit/wires.mjs";
import { runJob } from "../../../../src/job.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const DEFAULT = ["telescopic_ota", "cascode_current_mirror_ota", "high_speed_comparator"];
const all = J(path.join(ROOT, "data/index.json")).map((x) => x.name).filter((n) => fs.existsSync(path.join(ROOT, "data", n + ".leaves.json")));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : process.env.ALL ? all : DEFAULT;
const router = await loadAlignRouter(fs.readFileSync(path.join(ROOT, "src/route/alignroute.wasm")));
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  실패 " + m); } };

/** 캐시의 배치, 없으면 지금 배치해서 캐시에 (scripts/route/node/newroute.mjs 와 같은 자리·모양) */
async function placementOf(ex, blob) {
  const file = path.join(CACHE, `place-${ex}.json`);
  if (fs.existsSync(file)) return J(file);
  let ours = null;
  await runJob({ name: ex, blob, batch: 48, gpu: false }, (m) => { if (m.type === "done") ours = m; if (m.type === "error") throw new Error(m.msg); });
  const placement = {
    bbox: [0, 0, Math.round(ours.bbox[2] - ours.bbox[0]), Math.round(ours.bbox[3] - ours.bbox[1])],
    instances: ours.rects.map((r) => ({ name: r.name, concrete: r.concrete, oX: Math.round(r.sx > 0 ? r.x : r.x + r.w), oY: Math.round(r.sy > 0 ? r.y : r.y + r.h), sX: r.sx > 0 ? 1 : -1, sY: r.sy > 0 ? 1 : -1 })),
    subModules: ours.subModules ?? [],
  };
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(placement));
  return placement;
}
const sig = (o) => `${o.errors.length}|${o.geo.terminals.length}|${Buffer.from(o.gds).toString("base64").length}`;
const kinds = (o) => { const k = new Map(); for (const e of o.errors) { const t = e.split(" ")[0]; k.set(t, (k.get(t) ?? 0) + 1); } return [...k].map(([a, b]) => `${a} ${b}`).join(" "); };

for (const ex of wanted) {
  console.log("\n=== " + ex + " ===");
  const blob = J(path.join(ROOT, "data", ex + ".json"));
  const leaves = J(path.join(ROOT, "data", ex + ".leaves.json"));
  const placement = await placementOf(ex, blob);
  const design = { topology: blob.topology, primitives: blob.primitives };
  let t0 = performance.now();
  const session = await routeSession({ design, leaves, placement, router });
  const out0 = sessionOutput(session);
  const base = out0.errors.length;
  console.log(`  배선 ${(performance.now() - t0).toFixed(0)} ms  넷 ${out0.wires.nets.length}  오류 ${base} (${kinds(out0) || "-"})  도형 ${out0.geo.terminals.length}`);

  // --- 재검사만 (편집 없이) ---
  t0 = performance.now();
  const o1 = recheck(session, []);
  console.log(`  재검사 ${(performance.now() - t0).toFixed(0)} ms`);
  ok(sig(o1) === sig(out0) && Buffer.from(o1.gds).equals(Buffer.from(out0.gds)), `편집 없는 재검사가 다르다 (${sig(o1)} / ${sig(out0)})`);

  // --- 그래프로 읽고 그대로 되펴기 ---
  const model = out0.wires;
  const graphs = new Map(model.nets.map((n) => [n.name, buildGraph(n)]));
  let segs = 0, viasRaw = 0, viasG = 0;
  for (const n of model.nets) { const g = graphs.get(n.name); segs += g.segs.length; viasRaw += n.path_via.length; viasG += g.vias.length; }
  const edits = model.nets.filter((n) => n.path_metal.length).map((n) => ({ net: n.name, ...toNode(graphs.get(n.name)) }));
  const o2 = recheck(session, edits);
  console.log(`  그래프: 조각 ${segs} (토막 ${model.nets.reduce((s, n) => s + n.path_metal.length, 0)}), 비아 ${viasG} (원래 ${viasRaw})  되펴서 재검사 오류 ${o2.errors.length} (${kinds(o2) || "-"})`);
  ok(o2.errors.length === base, `되펴기가 오류를 바꿨다: ${base} -> ${o2.errors.length}`);
  for (const e of o2.errors.filter((x) => !out0.errors.includes(x)).slice(0, 3)) console.log("      새 오류: " + e.slice(0, 160));
  recheck(session, model.nets.map((n) => ({ net: n.name, restore: true })));

  // --- 옮기기: 조각마다 범위 안 양옆 트랙으로 ---
  let movable = 0, tried = 0, worse = 0, locked = 0, tMs = 0;
  const whyLocked = new Map();
  for (const n of model.nets) {
    const g0 = graphs.get(n.name);
    if (!g0.segs.length) continue;
    const world = worldShapes(model, graphs, n.name);
    for (const s0 of g0.segs) {
      const r = range(g0, s0, world, model.bbox);
      if (r.locked) { locked++; whyLocked.set(r.why, (whyLocked.get(r.why) ?? 0) + 1); continue; }
      movable++;
      const i = r.tracks.indexOf(s0.t);
      for (const t of [r.tracks[i - 1], r.tracks[i + 1]]) {
        if (t === undefined) continue;
        const g = cloneGraph(g0);
        const s = g.segs[s0.id];
        slide(g, s, t);
        tried++;
        const t1 = performance.now();
        const o = recheck(session, [{ net: n.name, ...toNode(g) }]);
        tMs += performance.now() - t1;
        if (o.errors.length > base) {
          worse++;
          if (worse <= 4) {
            console.log(`      늘었다: ${n.name} 조각 ${s0.id} ${s0.layer} ${s0.t} -> ${t}: ${o.errors.length - base} 건  ` + o.errors.filter((x) => !out0.errors.includes(x)).slice(0, 2).map((x) => x.slice(0, 110)).join(" | "));
          }
        }
        ok(topologyKey(g) === topologyKey(g0), "옮기기가 위상을 바꿨다");
        recheck(session, [{ net: n.name, restore: true }]);
      }
    }
  }
  console.log(`  옮기기: 조각 ${segs} 중 옮길 수 있는 것 ${movable}, 잠긴 것 ${locked} (${[...whyLocked].map(([k, v]) => `${k} ${v}`).join(", ") || "-"})  시도 ${tried}  오류가 는 것 ${worse}  재검사 평균 ${tried ? (tMs / tried).toFixed(0) : "-"} ms`);
  ok(worse === 0, `범위 안으로 옮겼는데 오류가 늘었다: ${worse}/${tried}`);

  // --- 넷 고정 재배선 ---
  const pick = model.nets.filter((n) => n.path_metal.length).slice(0, 2);
  for (const n of pick) {
    const frozen = [{ net: n.name, path_metal: n.path_metal, path_via: n.path_via }];
    t0 = performance.now();
    const s2 = await routeSession({ design, leaves, placement, router, frozen });
    const o = sessionOutput(s2);
    const got = o.wires.nets.find((q) => q.name === n.name);
    const same = JSON.stringify(got.path_metal) === JSON.stringify(n.path_metal) && JSON.stringify(got.path_via) === JSON.stringify(n.path_via);
    const changed = o.wires.nets.filter((q) => q.name !== n.name && JSON.stringify(q.path_metal) !== JSON.stringify(model.nets.find((z) => z.name === q.name).path_metal)).length;
    console.log(`  고정 ${n.name}: ${(performance.now() - t0).toFixed(0)} ms  오류 ${o.errors.length} (기준 ${base})  경로 그대로 ${same}  다른 넷 바뀜 ${changed}/${model.nets.length - 1}  frozen ${JSON.stringify(o.frozen)}`);
    ok(same, "고정한 넷의 경로가 바뀌었다");
    ok(o.errors.length <= base, `고정 뒤 오류가 늘었다 ${base} -> ${o.errors.length}`);
    ok(o.frozen.length === 1 && o.frozen[0] === n.name, "출력에 고정 넷이 없다");
  }
  void netLength;
}
console.log(fails ? `\n실패 ${fails} 건` : "\n전부 통과");
process.exit(fails ? 1 : 0);
