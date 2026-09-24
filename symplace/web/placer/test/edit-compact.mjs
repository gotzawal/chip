/** 정돈 검사 (src/edit/compact.mjs) — 위상을 유지한 채 배선을 짧게.
 *
 *  예제마다 배선 세션을 만든 뒤 넷마다 정돈한다: 위상 요약(조각 수·층·차례, 비아 수)이 같고, 길이가 늘지 않으며,
 *  되펴 재검사한 오류가 기준을 넘지 않는다. 전부 정돈도 같은 것을 본다.
 *
 *  실행:  node symplace/web/placer/test/edit-compact.mjs [예제 ...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAlignRouter } from "../../../../src/route/alignroute.mjs";
import { routeSession, sessionOutput, recheck } from "../../../../src/route/pipeline.mjs";
import { buildGraph, toNode, netLength, topologyKey, range, slide, cloneGraph, worldShapes } from "../../../../src/edit/wires.mjs";
import { compactNet, compactAll } from "../../../../src/edit/compact.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const DEFAULT = ["telescopic_ota", "cascode_current_mirror_ota", "high_speed_comparator"];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
const router = await loadAlignRouter(fs.readFileSync(path.join(ROOT, "src/route/alignroute.wasm")));
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  실패 " + m); } };

for (const ex of wanted) {
  console.log("\n=== " + ex + " ===");
  const file = path.join(CACHE, `place-${ex}.json`);
  if (!fs.existsSync(file)) { console.log(`  배치 캐시가 없다 (${file}) — edit-wires.mjs 를 먼저 돌리면 생긴다`); continue; }
  const blob = J(path.join(ROOT, "data", ex + ".json"));
  const leaves = J(path.join(ROOT, "data", ex + ".leaves.json"));
  const design = { topology: blob.topology, primitives: blob.primitives };
  const session = await routeSession({ design, leaves, placement: J(file), router });
  const out0 = sessionOutput(session);
  const base = out0.errors.length;
  const model = out0.wires;
  const graphs = new Map(model.nets.map((n) => [n.name, buildGraph(n)]));
  let tot0 = 0, tot1 = 0, moved = 0;
  const t0 = performance.now();
  for (const n of model.nets) {
    const g0 = graphs.get(n.name);
    if (!g0.segs.length) continue;
    const r = compactNet(model, graphs, n.name);
    const q = r.nets[0];
    tot0 += q.before; tot1 += q.after;
    ok(topologyKey(q.g) === topologyKey(g0), `${n.name}: 위상이 바뀌었다`);
    ok(q.after <= q.before + 1e-9, `${n.name}: 길이가 늘었다 ${q.before} -> ${q.after}`);
    if (q.moves) {
      moved++;
      const o = recheck(session, [{ net: n.name, ...toNode(q.g) }]);
      ok(o.errors.length <= base, `${n.name}: 정돈 뒤 오류 ${base} -> ${o.errors.length}`);
      for (const e of o.errors.filter((x) => !out0.errors.includes(x)).slice(0, 2)) console.log("      새 오류: " + e.slice(0, 150));
      recheck(session, [{ net: n.name, restore: true }]);
    }
  }
  const ms = performance.now() - t0;
  console.log(`  넷마다: 길이 ${tot0 / 2} -> ${tot1 / 2} (${tot0 ? ((1 - tot1 / tot0) * 100).toFixed(1) : 0} % 줄음)  움직인 넷 ${moved}/${model.nets.length}  ${ms.toFixed(0)} ms`);
  // 배선기 결과는 대개 이미 최단이라 안 움직인다. 사용자가 조각을 범위 끝까지 밀어 우회를 만든 뒤 정돈하면 원래 길이로 돌아와야 한다.
  let pushed = 0, longer = 0, back = 0, stuck = 0;
  for (const n of model.nets) {
    const g0 = graphs.get(n.name);
    if (!g0.segs.length) continue;
    const world = worldShapes(model, graphs, n.name);
    for (const s0 of g0.segs) {
      const r = range(g0, s0, world, model.bbox);
      if (r.locked) continue;
      for (const t of [r.tracks[0], r.tracks[r.tracks.length - 1]]) {
        if (t === s0.t) continue;
        const g = cloneGraph(g0);
        slide(g, g.segs[s0.id], t);
        pushed++;
        const L1 = netLength(g);
        if (L1 > netLength(g0) + 1e-9) longer++;
        const cur = new Map(graphs); cur.set(n.name, g);
        const q = compactNet(model, cur, n.name).nets[0];
        ok(topologyKey(q.g) === topologyKey(g0), `${n.name}: 밀었다 정돈하니 위상이 바뀌었다`);
        ok(q.after <= netLength(g0) + 1e-9, `${n.name} 조각 ${s0.id} ${s0.t}->${t}: 밀었다 정돈해도 원래보다 길다 ${netLength(g0)} -> ${q.after}`);
        if (q.after <= netLength(g0) + 1e-9) back++; else stuck++;
        if (q.moves) {
          const o = recheck(session, [{ net: n.name, ...toNode(q.g) }]);
          ok(o.errors.length <= base, `${n.name}: 밀었다 정돈한 뒤 오류 ${base} -> ${o.errors.length}`);
          recheck(session, [{ net: n.name, restore: true }]);
        }
      }
    }
  }
  console.log(`  밀고 정돈: 밀어 본 것 ${pushed} (길어진 것 ${longer})  원래 길이로 돌아온 것 ${back}  못 돌아온 것 ${stuck}`);
  // 전부 — 앞 넷의 결과가 뒤 넷의 세상
  const all = compactAll(model, graphs);
  const edits = all.nets.filter((q) => q.moves).map((q) => ({ net: q.net, ...toNode(q.g) }));
  const o = recheck(session, edits);
  console.log(`  전부: 길이 ${all.before / 2} -> ${all.after / 2}  움직인 넷 ${edits.length}  오류 ${o.errors.length} (기준 ${base})`);
  ok(all.after <= all.before + 1e-9, "전부 정돈이 길이를 늘렸다");
  ok(o.errors.length <= base, `전부 정돈 뒤 오류 ${base} -> ${o.errors.length}`);
  for (const e of o.errors.filter((x) => !out0.errors.includes(x)).slice(0, 3)) console.log("      새 오류: " + e.slice(0, 150));
  void netLength;
}
console.log(fails ? `\n실패 ${fails} 건` : "\n전부 통과");
process.exit(fails ? 1 : 0);
