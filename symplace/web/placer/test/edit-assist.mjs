/** 보조 배선 검사 (src/edit/assist.mjs) — 핀을 누르고 끄는 대로 따라오는 배선이 검사기와 맞는가.
 *
 *  예제마다 배선 세션을 만든 뒤 (배치는 edit-wires.mjs 와 같은 캐시), 배선된 넷마다 그 넷의 배선을 다 지우고(rip-up):
 *    따라 긋기   핀을 누른 자리(닻)에서 커서까지 — 처음 끈 쪽(posture)이 첫 토막이고 커서의 격자 점에서 끝난다 (곧장 갈 수
 *                있을 때. 막혔으면 돌아간다). 닻은 누른 자리에 가장 가까운 격자 점이다. 그렇게 그은 것(이어지지 않은
 *                토막도)을 넣고 재검사해도 오류가 지운 뒤보다 늘지 않는다 — 규칙에 맞는 것만 긋는다
 *    끌어 잇기   사람이 플라이라인을 따라 끄는 것 — 선의 한 끝 도형을 눌러(drawStart) 다른 끝으로 커서를 옮기면(drawTo)
 *                클릭 없이 그 덩이의 도형에 붙는다. 넣고 재검사하고, 넷이 한 덩이가 될 때까지 되풀이한다. 넷이 이어지고
 *                재검사 오류가 기준보다 늘지 않는다. 길은 막힌 꼭짓점을 안 지나고, 끝이 붙은 도형 위다
 *    모두 잇기   autoConnect 한 번에 넷의 열린 곳이 다 이어지고 오류가 기준보다 늘지 않는다 (플라이라인 클릭·"열린 곳 잇기")
 *    시간        격자 짓기와 다익스트라 한 번 (ms) — 누르는 순간에 한 번, 커서가 움직이면 거꾸로 따라가기만
 *  single_to_differential_converter 는 같은 중심선에 폭이 다른 도형(리프의 M3 막대)이 있는 트랙을 지나면 검사기가
 *  DIFFERENT WIDTH 를 내는 예제다 — 그 트랙은 격자에서 다 막혀야 한다.
 *
 *  실행:  node symplace/web/placer/test/edit-assist.mjs [예제 ...]     (기본 셋, ALL=1 이면 리프 도형이 있는 예제 전부)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAlignRouter } from "../../../../src/route/alignroute.mjs";
import { routeSession, sessionOutput, recheck } from "../../../../src/route/pipeline.mjs";
import { buildGraph } from "../../../../src/edit/wires.mjs";
import { buildGeometry, pathPlus, netShapes, netComponents, shapeAt, layerPair } from "../../../../src/edit/draw.mjs";
import { routingGrid, drawStart, drawTo, nodePoint, shapeNodes, autoConnect, GRID_LAYERS } from "../../../../src/edit/assist.mjs";
import { runJob } from "../../../../src/job.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const DEFAULT = ["telescopic_ota", "cascode_current_mirror_ota", "high_speed_comparator", "single_to_differential_converter"];
const all = J(path.join(ROOT, "data/index.json")).map((x) => x.name).filter((n) => fs.existsSync(path.join(ROOT, "data", n + ".leaves.json")));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : process.env.ALL ? all : DEFAULT;
const router = await loadAlignRouter(fs.readFileSync(path.join(ROOT, "src/route/alignroute.wasm")));
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  실패 " + m); } };

/** 캐시의 배치, 없으면 지금 배치해서 캐시에 (edit-wires.mjs 와 같은 자리·모양) */
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
const graphsOf = (model) => new Map(model.nets.map((n) => [n.name, buildGraph(n)]));
const PAIR = layerPair("M3", "up");                                // 기본 그리기 층 M3 — 세로 M3, 가로 M4
const inRect = (r, p) => p.x >= r[0] - 1e-6 && p.x <= r[2] + 1e-6 && p.y >= r[1] - 1e-6 && p.y <= r[3] + 1e-6;

for (const ex of wanted) {
  console.log("\n=== " + ex + " ===");
  const blob = J(path.join(ROOT, "data", ex + ".json"));
  const leaves = J(path.join(ROOT, "data", ex + ".leaves.json"));
  const placement = await placementOf(ex, blob);
  const session = await routeSession({ design: { topology: blob.topology, primitives: blob.primitives }, leaves, placement, router });
  const out0 = sessionOutput(session);
  const base = out0.errors.length, model0 = out0.wires;
  const routedNets = model0.nets.filter((n) => n.path_metal.length);
  const restoreAll = () => recheck(session, model0.nets.map((n) => ({ net: n.name, restore: true })));
  let t0 = performance.now();
  const G0 = routingGrid(model0, graphsOf(model0), model0.nets[0].name);
  const tGrid = performance.now() - t0;
  console.log(`  넷 ${model0.nets.length} (배선 ${routedNets.length})  오류 ${base}  격자 ${G0.NX}x${G0.NY}x${G0.NL} (${GRID_LAYERS.join("·")}) ${tGrid.toFixed(1)} ms`);

  // --- 따라 긋기: 핀을 누른 자리에서 커서까지 ㄱ자 (처음 끈 쪽이 첫 토막), 넣어도 오류가 안 는다 ---
  let heads = 0, straight = 0, detours = 0, flipped = 0, exact = 0, committed = 0, cleanCommits = 0;
  const followBad = [];
  for (const n of routedNets) {
    const ripped = recheck(session, [{ net: n.name, path_metal: [], path_via: [] }]);
    const model = ripped.wires, graphs = graphsOf(model);
    const net = model.nets.find((q) => q.name === n.name), g = graphs.get(n.name);
    const G = routingGrid(model, graphs, n.name);
    const pin = netShapes(net, g).find((s) => s.kind === "pin" && shapeNodes(G, s).length);
    if (!pin) continue;
    const at = { x: (pin.rect[0] + pin.rect[2]) / 2, y: (pin.rect[1] + pin.rect[3]) / 2 };
    const D = drawStart(model, graphs, n.name, { shape: pin, at, grid: G });
    if (!D.S) { followBad.push(`${n.name}: 닻을 못 잡음 (${D.why})`); continue; }
    const A0 = nodePoint(G, D.anchor);
    if (!(A0.x >= pin.rect[0] - 1e-6 && A0.x <= pin.rect[2] + 1e-6 && A0.y >= pin.rect[1] - 1e-6 && A0.y <= pin.rect[3] + 1e-6))
      followBad.push(`${n.name}: 닻 (${A0.x}, ${A0.y}) 이 누른 핀 밖`);
    const px = G.X[1] - G.X[0], py = G.Y[1] - G.Y[0];
    let commitsHere = 0;
    for (const [di, dj] of [[5, 0], [-5, 0], [0, 5], [0, -5], [4, 3], [-4, 3], [4, -3], [-4, -3]])
      for (const posture of ["h", "v"]) {
        const c = { x: A0.x + di * px, y: A0.y + dj * py };
        if (c.x < G.X[0] || c.x > G.X[G.NX - 1] || c.y < G.Y[0] || c.y > G.Y[G.NY - 1]) continue;
        const r = drawTo(D, c, { posture, h: PAIR.h, v: PAIR.v, aperture: -1 });   // 붙기는 끄고 (커서가 다른 핀 위일 수도)
        if (!r.ok) continue;
        heads++;
        if (r.detour) { detours++; continue; }
        if (r.flipped) flipped++;
        // 곧장: 닻에서 시작, 처음 움직이는 쪽이 posture (막혀서 꺾는 쪽을 바꿨으면 그쪽), 커서에서 두 칸 안에서 끝 (보통 그 점)
        const pts = r.path, first = pts.find((q) => q.x !== pts[0].x || q.y !== pts[0].y), last = pts[pts.length - 1];
        const want = r.flipped ? (posture === "h" ? "v" : "h") : posture;
        const okStart = pts[0].x === A0.x && pts[0].y === A0.y;
        const okFirst = !first || (want === "h" ? first.y === A0.y : first.x === A0.x) || di === 0 || dj === 0;
        const okEnd = Math.abs(last.x - c.x) <= 2 * px + 1 && Math.abs(last.y - c.y) <= 2 * py + 1;
        if (Math.abs(last.x - c.x) < 1 && Math.abs(last.y - c.y) < 1) exact++;
        if (okStart && okFirst && okEnd) straight++;
        else followBad.push(`${n.name}: ${posture} (${di}, ${dj}) 시작 ${okStart} 첫 토막 ${okFirst} 끝 ${okEnd}`);
        if (commitsHere >= 3 || pts.length < 2) continue;              // 넷마다 셋을 넣어 본다
        commitsHere++; committed++;
        const geom = buildGeometry([pts], { mine: netShapes(net, g), world: G.world, area: model.area });
        const out = recheck(session, [{ net: n.name, ...pathPlus(net, geom) }]);
        if (out.errors.length <= ripped.errors.length) cleanCommits++;
        else followBad.push(`${n.name}: ${posture} (${di}, ${dj}) 넣으니 오류 ${ripped.errors.length} -> ${out.errors.length}: ${out.errors.filter((e) => !ripped.errors.includes(e))[0]?.slice(0, 140)}`);
        recheck(session, [{ net: n.name, path_metal: [], path_via: [] }]);
      }
    restoreAll();
  }
  console.log(`  따라 긋기: 머리 ${heads} 개 — 곧장 ${straight} (커서 점에서 끝 ${exact}, 꺾는 쪽을 바꿈 ${flipped}), 돌아감 ${detours}` +
              ` · 넣어 본 것 ${committed} 개 가운데 오류가 안 는 것 ${cleanCommits}`);
  for (const s of followBad.slice(0, 12)) console.log("    " + s);
  ok(straight === heads - detours, `따라 긋기 — 곧장 간 머리 가운데 어긋난 것 ${heads - detours - straight}`);
  ok(cleanCommits === committed, `따라 긋기 — 넣으니 오류가 는 것 ${committed - cleanCommits}`);

  // --- 끌어 잇기: 플라이라인을 따라 누르고 끌어 놓는다 ---
  let dragged = 0, drags = 0, flyOnly = 0, worse = 0, maxSearch = 0, maxPress = 0;
  const notes = [];
  for (const n of routedNets) {
    let model = recheck(session, [{ net: n.name, path_metal: [], path_via: [] }]).wires, graphs = graphsOf(model);
    let errs = null, comps = Infinity;
    for (let step = 0; step < 24; step++) {
      const net = model.nets.find((q) => q.name === n.name), g = graphs.get(n.name);
      const c = netComponents(net, g);
      comps = c.comps;
      if (comps <= 1) break;
      const ln = c.lines[0];
      const at = { x: ln.a[0], y: ln.a[1] }, to = { x: ln.b[0], y: ln.b[1] };
      // 누르는 자리의 이 넷 도형 (플라이라인 끝은 그 덩이의 도형 위다)
      const sh = netShapes(net, g).filter((s) => inRect(s.rect, at)).sort((a, b) => (a.kind === "pin") - (b.kind === "pin"))[0]
        ?? shapeAt(model, graphs, at.x, at.y, 0, "M3");
      t0 = performance.now();
      const A = drawStart(model, graphs, n.name, { shape: sh, at });
      const tPress = performance.now() - t0;
      maxPress = Math.max(maxPress, tPress);
      let edit = null;
      if (A.S) {
        t0 = performance.now();
        const posture = Math.abs(to.x - at.x) >= Math.abs(to.y - at.y) ? "h" : "v";
        const r = drawTo(A, to, { posture, aperture: 160, h: PAIR.h, v: PAIR.v });
        maxSearch = Math.max(maxSearch, performance.now() - t0);
        if (r.ok && r.target) {
          ok(r.path.every((p, i) => i === 0 || !(p.x === r.path[i - 1].x && p.y === r.path[i - 1].y && p.layer === r.path[i - 1].layer)), `${n.name}: 길에 같은 점이 겹친다`);
          ok(inRect(r.target.rect, r.path[r.path.length - 1]), `${n.name}: 길 끝이 붙은 도형 밖이다`);
          const blocked = r.path.filter((p) => { const l = A.G.layers.findIndex((q) => q.name === p.layer), i = A.G.X.indexOf(p.x), j = A.G.Y.indexOf(p.y); return l < 0 || i < 0 || j < 0 || A.G.nb[l * A.G.NP + j * A.G.NX + i]; });
          ok(!blocked.length, `${n.name}: 막힌 꼭짓점을 지난다 ${JSON.stringify(blocked[0])}`);
          const geom = buildGeometry([r.path], { mine: netShapes(net, g), world: A.G.world, area: model.area });
          edit = { net: n.name, ...pathPlus(net, geom) };
          drags++;
        } else notes.push(`${n.name}: 끌어서 못 붙음 (${r.why ?? "붙을 도형이 격자 밖"}) — 플라이라인 클릭으로`);
      } else notes.push(`${n.name}: 누른 도형에서 못 나감 (${A.why}) — 플라이라인 클릭으로`);
      if (!edit) {                                         // 플라이라인 클릭과 같다 — 그 두 덩이만
        const r = autoConnect(model, graphs, n.name, { only: [ln.ca, ln.cb] });
        if (!r.edit) break;
        edit = r.edit; flyOnly++;
      }
      const out = recheck(session, [edit]);
      model = out.wires; graphs = graphsOf(model); errs = out.errors.length;
    }
    if (comps <= 1 && errs != null && errs <= base) dragged++;
    else notes.push(`${n.name}: 덩이 ${comps} · 오류 ${errs} (기준 ${base})`);
    if (errs != null && errs > base) worse++;
    restoreAll();
  }
  console.log(`  끌어 잇기: ${dragged}/${routedNets.length} 넷이 이어지고 오류가 기준 이하 · 끌기 ${drags} 번 (플라이라인 클릭 ${flyOnly})` +
              ` · 누를 때 ${maxPress.toFixed(1)} ms · 커서 ${maxSearch.toFixed(2)} ms (가장 긴 것)`);
  for (const s of notes) console.log("    " + s);
  ok(dragged === routedNets.length, `끌어 잇기 ${dragged}/${routedNets.length}`);
  ok(worse === 0, `오류가 는 넷 ${worse}`);

  // --- 모두 잇기: autoConnect 한 번 ---
  let joined = 0, more = 0, tMax = 0;
  for (const n of routedNets) {
    const model = recheck(session, [{ net: n.name, path_metal: [], path_via: [] }]).wires;
    t0 = performance.now();
    const r = autoConnect(model, graphsOf(model), n.name);
    tMax = Math.max(tMax, performance.now() - t0);
    const out = r.edit ? recheck(session, [r.edit]) : null;
    if (r.comps === 1 && out && out.errors.length <= base) joined++;
    else console.log(`    ${n.name}: 덩이 ${r.comps} · 오류 ${out?.errors.length ?? "—"} (기준 ${base})`);
    if (out && out.errors.length > base) more++;
    restoreAll();
  }
  console.log(`  모두 잇기: ${joined}/${routedNets.length} 넷 · 오류가 는 넷 ${more} · 가장 긴 것 ${tMax.toFixed(1)} ms`);
  ok(joined === routedNets.length, `모두 잇기 ${joined}/${routedNets.length}`);
  ok(more === 0, `모두 잇기로 오류가 는 넷 ${more}`);
}
console.log(fails ? `\n실패 ${fails} 건` : "\n전부 통과");
process.exit(fails ? 1 : 0);
