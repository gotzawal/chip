/** 배선 그리기 검사 (src/edit/draw.mjs) — 레이아웃 편집기처럼 점을 찍어 그린 배선이 배선기·검사기와 맞는가.
 *
 *  예제마다 배선 세션을 만든 뒤 (배치는 edit-wires.mjs 와 같은 캐시):
 *    되짓기      넷마다 조각 그래프의 앵커(비아·핀 접속)만으로 buildGeometry 를 돌리면 배선기의 도형이 그대로 나온다 —
 *                최소 길이 늘이기와 비아 스택의 막대까지. 전부 넣고 재검사하면 오류가 기준보다 늘지 않는다
 *    다시 그리기  넷의 배선을 지우고(rip-up) 사람이 하듯 점을 찍어 배선기의 경로를 따라 그린다 — 시작점(startPoint), 토막
 *                (planLeg)과 도형에 붙기, 비아 쌓기, 비아만 찍기. 다 그리면 넷이 한 덩이로 이어지고 재검사 오류가 기준보다
 *                늘지 않으며, 클릭한 자리가 배선기의 점에서 어긋나지 않는다
 *    도형이 배선기와 같은지는 기본 셋에서 검사한다. 다른 예제에는 배선기가 자기 격자의 상태(먼저 깐 넷)로 최소 길이를
 *    늘이는 쪽을 고른 넷이 있어 세기만 한다 — 검사 결과는 같다. 오류가 줄어드는 것은 배선기 경로의 중복 토막이 빠져서다
 *    지우기      조각 하나를 지우면 넷이 열린다 — 연결 덩이(netComponents)가 늘고 검사기가 그 넷의 OPEN 을 낸다.
 *                플라이라인 수 = 덩이 - 1. 넷의 배선을 다 지우면 덩이 = 핀 묶음 수
 *    규칙        다른 넷의 조각 위로 그리면 drdIssues 가 단락을 알리고, 검사기도 SHORT 를 낸다
 *    표식        검사기 오류 줄의 사각형을 읽는다 (errorMarks)
 *
 *  실행:  node symplace/web/placer/test/edit-draw.mjs [예제 ...]     (기본 셋, ALL=1 이면 리프 도형이 있는 예제 전부)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAlignRouter } from "../../../../src/route/alignroute.mjs";
import { routeSession, sessionOutput, recheck } from "../../../../src/route/pipeline.mjs";
import { buildGraph, worldShapes, toNode, LAYERS } from "../../../../src/edit/wires.mjs";
import { buildGeometry, pathPlus, netShapes, deleteSeg, netComponents, netRuleShapes, drdIssues, errorMarks, shapeAt,
         viaShapes } from "../../../../src/edit/draw.mjs";
import { runJob } from "../../../../src/job.mjs";
import { replay, sameShapes, segKey, ptOn, spanOf } from "./_replay.mjs";

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

for (const ex of wanted) {
  console.log("\n=== " + ex + " ===");
  const blob = J(path.join(ROOT, "data", ex + ".json"));
  const leaves = J(path.join(ROOT, "data", ex + ".leaves.json"));
  const placement = await placementOf(ex, blob);
  const design = { topology: blob.topology, primitives: blob.primitives };
  const session = await routeSession({ design, leaves, placement, router });
  const out0 = sessionOutput(session);
  const base = out0.errors.length, model = out0.wires, exact = DEFAULT.includes(ex);
  const graphs = new Map(model.nets.map((n) => [n.name, buildGraph(n)]));
  const routedNets = model.nets.filter((n) => n.path_metal.length);
  console.log(`  넷 ${model.nets.length} (배선 ${routedNets.length})  오류 ${base}`);
  const restoreAll = () => recheck(session, model.nets.map((n) => ({ net: n.name, restore: true })));

  // --- 되짓기: 앵커만으로 ---
  let rebuilt = 0;
  const edits = [];
  for (const n of routedNets) {
    const g0 = graphs.get(n.name), paths = [];
    for (const s of g0.segs) { const [lo, hi] = spanOf(s); paths.push(lo === hi ? [ptOn(s, lo)] : [ptOn(s, lo), ptOn(s, hi)]); }
    for (const jv of g0.vias) paths.push([{ x: jv.x, y: jv.y, layer: jv.lower }, { x: jv.x, y: jv.y, layer: jv.upper }]);
    const geom = buildGeometry(paths, { mine: netShapes(n, null), world: worldShapes(model, graphs, n.name), area: model.area });
    const g1 = buildGraph({ ...n, path_metal: geom.path_metal, path_via: geom.path_via });
    if (sameShapes(g1, g0)) rebuilt++;
    else {
      const a = new Set(g0.segs.map(segKey)), b = new Set(g1.segs.map(segKey));
      console.log(`      ${n.name} 다름: 배선기 ${[...a].filter((k) => !b.has(k)).join(", ") || "-"} / 되짓기 ${[...b].filter((k) => !a.has(k)).join(", ") || "-"}`);
    }
    edits.push({ net: n.name, path_metal: geom.path_metal, path_via: geom.path_via });
  }
  const o1 = recheck(session, edits);
  console.log(`  되짓기: ${rebuilt}/${routedNets.length} 넷의 도형이 배선기와 같다 · 넣고 재검사 오류 ${o1.errors.length} (기준 ${base})`);
  if (exact) ok(rebuilt === routedNets.length, `되짓기 도형이 다른 넷 ${routedNets.length - rebuilt}`);
  ok(o1.errors.length <= base, `되짓기 뒤 오류가 늘었다 ${base} -> ${o1.errors.length}`);
  restoreAll();

  // --- 다시 그리기: 넷마다 지우고 점을 찍어 ---
  let same = 0, clicks = 0, viaOnly = 0, cleanNets = 0;
  const missAll = [];
  for (const n of routedNets) {
    const g0 = graphs.get(n.name);
    const ripped = recheck(session, [{ net: n.name, path_metal: [], path_via: [] }]);
    const comps0 = netComponents(n, buildGraph({ ...n, path_metal: [], path_via: [] }));
    const opened = ripped.errors.filter((e) => e.startsWith("OPEN") && e.includes(`'${n.name}'`)).length;
    const r = replay(n, g0, { world: worldShapes(model, graphs, n.name), area: model.area });
    clicks += r.clicks; viaOnly += r.viaOnly; missAll.push(...r.misses);
    if (sameShapes(r.g, g0)) same++;
    const o = recheck(session, [{ net: n.name, path_metal: r.work.path_metal, path_via: r.work.path_via }]);
    const comps1 = netComponents(r.work, r.g);
    if (o.errors.length <= base && comps1.comps === 1) cleanNets++;
    else console.log(`      ${n.name}: 다시 그린 뒤 오류 ${o.errors.length} (기준 ${base}) 덩이 ${comps1.comps}  ` + o.errors.filter((e) => !out0.errors.includes(e)).slice(0, 2).map((e) => e.slice(0, 120)).join(" | "));
    ok(comps0.comps > 1 ? opened > 0 : true, `${n.name} 을 지웠는데 검사기가 OPEN 을 안 낸다`);
    ok(comps0.lines.length === comps0.comps - 1, `${n.name} 플라이라인 수가 덩이 - 1 이 아니다`);
    restoreAll();
  }
  console.log(`  다시 그리기: ${routedNets.length} 넷, 클릭 ${clicks} (비아만 ${viaOnly})  도형이 배선기와 같은 넷 ${same}  오류 기준 이하·연결 1 덩이 ${cleanNets}`);
  for (const m of missAll.slice(0, 5)) console.log("      " + m);
  if (exact) ok(same === routedNets.length, `다시 그린 도형이 다른 넷 ${routedNets.length - same}`);
  ok(cleanNets === routedNets.length, `다시 그린 뒤 오류가 늘었거나 열린 넷 ${routedNets.length - cleanNets}`);
  ok(!missAll.length, `그리기가 배선기 자리에서 어긋났다 ${missAll.length} 번`);

  // --- 지우기: 조각 하나 ---
  let opens = 0, tried = 0;
  for (const n of routedNets) {
    const g0 = graphs.get(n.name);
    const s = g0.segs.find((q) => q.joints.length || q.pins.length);
    if (!s) continue;
    const d = deleteSeg(g0, s.id);
    const c = netComponents(n, d.graph);
    const o = recheck(session, [{ net: n.name, ...toNode(d.graph) }]);
    const open = o.errors.some((e) => e.startsWith("OPEN") && e.includes(`'${n.name}'`));
    tried++;
    if (c.comps > 1) { opens++; ok(open, `${n.name} 조각을 지워 덩이 ${c.comps} 인데 검사기 OPEN 이 없다`); }
    else ok(!open, `${n.name} 조각을 지워도 1 덩이라 했는데 검사기는 OPEN`);
    ok(c.lines.length === c.comps - 1, `${n.name} 플라이라인 ${c.lines.length} / 덩이 ${c.comps}`);
    ok(d.graph.segs.length < g0.segs.length, `${n.name} 조각이 안 지워졌다`);
    restoreAll();
  }
  console.log(`  지우기: ${tried} 넷에서 조각 하나씩 — 열린 넷 ${opens} (검사기 OPEN 과 맞다)`);

  // --- 규칙: 다른 넷의 조각 위로 ---
  const victim = routedNets.map((n) => [n, graphs.get(n.name).segs.find((q) => !q.pins.length && q.hi - q.lo >= 400)]).find(([, s]) => s);
  const att = victim && routedNets.find((n) => n.name !== victim[0].name);
  if (victim && att) {
    const [vn, vs] = victim;
    const geom = buildGeometry([[ptOn(vs, vs.lo), ptOn(vs, vs.hi)]], { mine: [] });
    const iss = drdIssues(geom, { world: worldShapes(model, graphs, att.name), mine: netRuleShapes(att, graphs.get(att.name)), bbox: model.bbox, regions: model.regions });
    const short = iss.find((q) => q.kind === "단락" && q.msg.includes(vn.name));
    const o = recheck(session, [pathPlus(att, geom)]);
    console.log(`  규칙: ${att.name} 를 ${vn.name} 의 ${vs.layer} 조각 위로 — ${iss.length} 건 (${[...new Set(iss.map((q) => q.kind))].join(" ")}) · 검사기 ${o.errors.length - base >= 0 ? "+" : ""}${o.errors.length - base}`);
    ok(!!short, "단락을 못 알렸다");
    ok(o.errors.some((e) => e.startsWith("SHORT")), "검사기가 SHORT 를 안 냈다");
    restoreAll();
    // 아무 것도 안 겹치는 자리 (모듈 밖 아래) — 경계만
    const free = buildGeometry([[{ x: 0, y: model.bbox[1] - 2000, layer: "M2" }, { x: 2000, y: model.bbox[1] - 2000, layer: "M2" }]]);
    const fi = drdIssues(free, { world: worldShapes(model, graphs, att.name), mine: netRuleShapes(att, graphs.get(att.name)), bbox: model.bbox, regions: model.regions });
    ok(fi.length && fi.every((q) => q.kind === "경계"), `빈 자리에 그렸는데 경계 말고도 알린다: ${fi.map((q) => q.kind).join(" ")}`);
    // 같은 트랙에서 그 조각 끝(비아 둘러싸기까지) 바로 뒤 — EndToEnd 의 반 — 에서 시작하는 토막: 끝단 간격, 검사기는 MinSpace
    const L = LAYERS.get(vs.layer), gap = 2 * Math.round(L.ee / 4);
    const end = Math.max(vs.hi, ...vs.joints.map((jv) => { const v = viaShapes(jv), q = v.lower?.layer === vs.layer ? v.lower : v.upper; return vs.dir === "v" ? q.rect[3] : q.rect[2]; }));
    const e2e = buildGeometry([[ptOn(vs, end + gap), ptOn(vs, end + gap + L.minL)]], { mine: [] });
    const ei = drdIssues(e2e, { world: worldShapes(model, graphs, att.name), mine: netRuleShapes(att, graphs.get(att.name)), bbox: model.bbox, regions: model.regions });
    const oe = recheck(session, [pathPlus(att, e2e)]);
    // 검사기는 리프의 Boundary 영역 안에서는 MinSpace 를 안 본다 — 그리는 동안의 규칙도 같아야 한다 (알리면 검사기도 낸다)
    const said = ei.some((q) => q.kind === "끝단"), minSpace = oe.errors.some((x) => x.includes("MinSpace"));
    console.log(`  규칙: ${vn.name} 조각 끝 ${gap / 2} 뒤에서 — ${ei.map((q) => q.kind).join(" ") || "-"} · 검사기 MinSpace ${oe.errors.filter((x) => x.includes("MinSpace")).length}${said ? "" : " (Boundary 영역 안)"}`);
    ok(said === minSpace, `끝단 알림(${said})과 검사기 MinSpace(${minSpace})가 다르다`);
    if (exact) ok(said, "끝단 간격을 못 알렸다");
    restoreAll();
  }
  // 배선기가 낸 넷을 그린 것으로 보면 — 검사기 오류가 없는 설계에서는 경고도 없어야 한다 (헛경고 없음)
  let falseAlarms = 0;
  for (const n of routedNets) {
    const g0 = graphs.get(n.name), bare = buildGraph({ ...n, path_metal: [], path_via: [] });
    falseAlarms += drdIssues({ legs: g0.segs, vias: g0.vias }, { world: worldShapes(model, graphs, n.name), mine: netRuleShapes(n, bare), bbox: model.bbox, regions: model.regions }).length;
  }
  console.log(`  규칙: 배선기가 낸 넷 ${routedNets.length} 개를 그린 것으로 보면 경고 ${falseAlarms} (검사기 오류 ${base})`);
  if (base === 0) ok(falseAlarms === 0, `검사기는 깨끗한데 경고 ${falseAlarms}`);

  // --- 시작 도형 찾기: 핀 한가운데를 누르면 그 넷의 핀 ---
  const pn = model.nets.find((n) => n.pins.length), pin = pn?.pins[0];
  const hit = pin && shapeAt(model, graphs, (pin.rect[0] + pin.rect[2]) / 2, (pin.rect[1] + pin.rect[3]) / 2, 0);
  ok(!pin || (hit && hit.net === pn.name), `핀을 눌렀는데 ${hit?.net} 이 잡혔다 (${pn?.name})`);

  // --- 표식 ---
  const marks = errorMarks(out0.errors);
  ok(marks.every((m) => m.rects.length > 0), "사각형 없는 표식");
  console.log(`  표식: 오류 ${base} 줄에서 ${marks.length} 개 (${marks.reduce((s, m) => s + m.rects.length, 0)} 사각형)`);
}

// 표식 — 줄 모양마다 (PDK 단위, 격자 문구는 2 배 단위라 반으로)
{
  const lines = [
    "SHORT CONNECTPAIR M2 ([10, 20, 30, 40], 'A', 'drawing') ([30, 20, 50, 40], 'B', 'drawing')",
    "OPEN ('N1', [[('M2', [0, 0, 10, 10])], [('M3', [20, 20, 30, 30])]])",
    "DRC ERROR MinLength violation on M3: N1[100, 0, 140, 50]",
    "DRC ERROR Off grid:path_metal M3 N1 [200, 0, 280, 400] 80 400: 240 (in 2x units) is not divisible by two.",
    "DIFFERENT WIDTH ('Rectangles on layer M1 with the same 2x centerline 64 but different widths {32, 40}:', ([0, 2], [([16, 0, 48, 100], 'N', 'drawing', False), ([12, 200, 52, 300], 'N', 'drawing', False)]))",
  ];
  const m = errorMarks(lines);
  ok(m.length === 4, `표식 ${m.length} 개 (OPEN 은 빼고 4)`);
  ok(m[0].kind === "short" && m[0].rects.length === 2, "SHORT 표식");
  ok(m[2].rects[0].join() === "100,0,140,200", `격자 문구는 반으로 ${m[2].rects[0]}`);
  ok(m[3].kind === "width" && m[3].rects.length === 2, "DIFFERENT WIDTH 표식");
}
console.log(fails ? `\n실패 ${fails} 건` : "\n전부 통과");
process.exit(fails ? 1 : 0);
