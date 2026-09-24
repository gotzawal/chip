/** 스파이크: 배선 편집의 두 길이 되는가 (symplace/PLAN-edit.md 의 실측).
 *
 *  A. 재검사만: 배선된 최상위 노드의 넷 하나에서 금속 조각 하나를 옆 트랙으로 옮기고(이웃 조각·비아를 늘려서)
 *     배선기 없이 compose + DRC/LVS + GDS 를 다시 한다. 시간과 오류 수를 잰다.
 *  B. 넷 고정 재배선: 넷 하나의 경로를 장애물(블록 interMetals)로 심고 DoNotRoute 에 넣어 나머지를 다시 배선한
 *     뒤 그 넷의 경로를 되붙인다. DRC/LVS 가 원래와 같은가, 다른 넷이 얼마나 바뀌나.
 *
 *  실행:  node symplace/scripts/edit/route.mjs <예제>   (저장소 루트에서; 배치는 scripts/route/node 와 같은 캐시를 쓴다)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAlignRouter } from "../../../src/route/alignroute.mjs";
import { routeBottomUp, jobNode, applyRecord } from "../../../src/route/align/bottomup.mjs";
import { checkModule } from "../../../src/route/pipeline.mjs";
import { clone } from "../../../src/route/align/pnrdb.mjs";
import { readLeaves } from "../../../src/route/leaves.mjs";
import { MOCK_PDK } from "../../../src/route/pdk.mjs";
import { topGds } from "../../../src/route/gds.mjs";
import { runJob } from "../../../src/job.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const [ex = "telescopic_ota"] = process.argv.slice(2);
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const design = J(path.join(ROOT, "data", ex + ".json"));
const leaves = readLeaves(J(path.join(ROOT, "data", ex + ".leaves.json")));
const router = await loadAlignRouter(fs.readFileSync(path.join(ROOT, "src/route/alignroute.wasm")));

fs.mkdirSync(CACHE, { recursive: true });
const pfile = path.join(CACHE, `place-${ex}.json`);
let placement;
if (fs.existsSync(pfile)) placement = J(pfile);
else {
  let ours = null;
  await runJob({ name: ex, blob: design, batch: 48, gpu: false }, (m) => { if (m.type === "done") ours = m; if (m.type === "error") throw new Error(m.msg); });
  placement = {
    bbox: [0, 0, Math.round(ours.bbox[2] - ours.bbox[0]), Math.round(ours.bbox[3] - ours.bbox[1])],
    instances: ours.rects.map((r) => ({ name: r.name, concrete: r.concrete, oX: Math.round(r.sx > 0 ? r.x : r.x + r.w), oY: Math.round(r.sy > 0 ? r.y : r.y + r.h), sX: r.sx > 0 ? 1 : -1, sY: r.sy > 0 ? 1 : -1 })),
    subModules: ours.subModules ?? [],
  };
  fs.writeFileSync(pfile, JSON.stringify(placement));
}

/** 한 판: routeBottomUp 을 돌리되 최상위 일감을 손볼 수 있게 routeModule 을 감싼다. */
async function routeAll({ patchTop = null, label }) {
  const t0 = performance.now();
  const res = await routeBottomUp({ design: { topology: design.topology, primitives: design.primitives }, leaves, placement, pdk: MOCK_PDK,
    routeModule: async (job) => {
      if (patchTop && job.node.isTop) patchTop(job);
      return router.route(job);
    } });
  const tr = performance.now() - t0;
  const outs = new Map(); let top = null; const errs = [];
  const t1 = performance.now();
  for (const m of res.modules) {
    const c = checkModule(m.node, { leaves, pnrConst: res.prep.pnrConst, outs });
    outs.set(`${m.name}_${m.sel}`, c.terminals);
    errs.push(...c.errors);
    if (m.isTop) top = { m, c };
  }
  const tc = performance.now() - t1;
  // 비교는 최상위 모듈의 오류로 한다 (하위 모듈의 오류는 편집과 무관하게 그대로다)
  console.log(`${label.padEnd(26)} 배선 ${tr.toFixed(0)} ms  검사 ${tc.toFixed(0)} ms  DRC/LVS ${errs.length} (최상위 ${top.c.errors.length})  도형 ${top.c.terminals.length}`);
  return { res, outs, top, errs: top.c.errors, errsAll: errs };
}

const base = await routeAll({ label: "기준" });
const node = base.top.m.node;
const S = (v) => Math.floor(v / 2);
console.log(`최상위 ${node.name}: 넷 ${node.Nets.length}, 전원 넷 ${node.PowerNets.length}, bbox PDK ${[node.LL.x, node.LL.y, node.UR.x, node.UR.y].map(S).join(",")}`);
for (const nn of node.Nets) {
  const segs = nn.path_metal.map((m) => `${m.MetalRect.metal}[${m.LinePoint.map((p) => `${S(p.x)},${S(p.y)}`).join("->")}]`);
  console.log(`  ${nn.name.padEnd(8)} 핀 ${nn.connected.length}  금속 ${nn.path_metal.length}  비아 ${nn.path_via.length}  ${segs.slice(0, 6).join(" ")}${segs.length > 6 ? " ..." : ""}`);
}

// --- A. 조각 하나 옮기고 재검사 ---
//
// 세로 층(M1·M3·M5)은 x 가 트랙, 가로 층(M2·M4)은 y 가 트랙. 조각을 한 피치 옮기면 그 끝에 닿은 직교 조각을
// 늘리고(줄이고), 비아를 같이 옮긴다. 핀에 직접 닿은 조각은 옮길 수 없다 (여기서는 그런 조각을 피해 고른다).
const pitch = { M1: 80, M2: 84, M3: 80, M4: 84, M5: 144, M6: 144 };
const vertical = new Set(["M1", "M3", "M5"]);
function rectOf(c) { return [c.placedBox.LL.x, c.placedBox.LL.y, c.placedBox.UR.x, c.placedBox.UR.y]; }
const touch = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
function pinRectsOf(nn) {
  const out = [];
  for (const c of nn.connected) {
    if (c.type !== "NType.Block") continue;
    const bc = node.Blocks[c.iter2], inst = bc.instance[bc.selectedInstance];
    for (const pc of inst.blockPins[c.iter].pinContacts) out.push({ layer: pc.metal, rect: rectOf(pc) });
  }
  return out;
}
/** 넷 안에서 조각 k 를 한 트랙 옮길 수 있는가: 끝이 핀에 닿지 않고, 이웃(직교 조각·비아)이 늘어날 수 있으면. */
function slide(nn, k, steps) {
  const m = nn.path_metal[k], L = m.MetalRect.metal, v = vertical.has(L);
  const d = steps * 2 * pitch[L];              // PnRDB 단위(2 배)
  const r = rectOf(m.MetalRect);
  const pins = pinRectsOf(nn);
  if (pins.some((p) => p.layer === L && touch(p.rect, r))) return null;      // 핀에 직접 닿음
  const edited = clone(nn);
  const em = edited.path_metal[k];
  const mv = (c) => { if (v) { c.placedBox.LL.x += d; c.placedBox.UR.x += d; c.placedCenter.x += d; } else { c.placedBox.LL.y += d; c.placedBox.UR.y += d; c.placedCenter.y += d; } };
  mv(em.MetalRect); for (const p of em.LinePoint) { if (v) p.x += d; else p.y += d; }
  // 이 조각의 끝에 닿은 비아를 옮기고, 그 비아에 닿은 직교 조각의 끝을 늘린다
  let moved = 0;
  for (const via of edited.path_via) {
    const vr = rectOf(via.ViaRect);
    if (!touch(vr, r)) continue;
    for (const key of ["UpperMetalRect", "LowerMetalRect", "ViaRect"]) mv(via[key]);
    if (v) via.placedpos.x += d; else via.placedpos.y += d;
    moved++;
    for (const om of edited.path_metal) {
      if (om === em || vertical.has(om.MetalRect.metal) === v) continue;
      const orr = rectOf(om.MetalRect);
      if (!touch(orr, vr)) continue;
      // 직교 조각: 비아 쪽 끝을 d 만큼 옮긴다 (LinePoint 와 사각형)
      const c = om.MetalRect.placedBox;
      if (v) {
        // 가로 조각, 비아가 x = vr 중심에 있었다. 어느 끝이 비아 쪽인가
        const vx = (vr[0] + vr[2]) / 2;
        const leftEnd = Math.abs(c.LL.x - (vx - (vr[2]-vr[0])/2 - 0)) < Math.abs(c.UR.x - vx) ? "LL" : "UR";
        if (Math.abs(c.LL.x + (c.UR.x - c.LL.x) / 2 - vx) < 1) { /* 한 점짜리 */ }
        if (leftEnd === "LL") c.LL.x += d; else c.UR.x += d;
        for (const p of om.LinePoint) if (Math.abs(p.x - vx) <= (vr[2] - vr[0])) p.x += d;
      } else {
        const vy = (vr[1] + vr[3]) / 2;
        const lowEnd = Math.abs(c.LL.y - vy) < Math.abs(c.UR.y - vy) ? "LL" : "UR";
        if (lowEnd === "LL") c.LL.y += d; else c.UR.y += d;
        for (const p of om.LinePoint) if (Math.abs(p.y - vy) <= (vr[3] - vr[1])) p.y += d;
      }
      if (c.LL.x > c.UR.x) [c.LL.x, c.UR.x] = [c.UR.x, c.LL.x];
      if (c.LL.y > c.UR.y) [c.LL.y, c.UR.y] = [c.UR.y, c.LL.y];
      om.MetalRect.placedCenter = { x: Math.trunc((c.LL.x + c.UR.x) / 2), y: Math.trunc((c.LL.y + c.UR.y) / 2) };
    }
  }
  return { edited, moved, layer: L, d };
}
console.log("\n--- A. 조각 하나 옮기고 배선기 없이 재검사 ---");
let tried = 0;
for (const nn of node.Nets) {
  for (let k = 0; k < nn.path_metal.length && tried < 6; k++) {
    for (const steps of [1, -1]) {
      const s = slide(nn, k, steps);
      if (!s || !s.moved) continue;
      tried++;
      const patched = clone(node);
      const ni = patched.Nets.findIndex((q) => q.name === nn.name);
      patched.Nets[ni] = s.edited;
      const t1 = performance.now();
      const c = checkModule(patched, { leaves, pnrConst: base.res.prep.pnrConst, outs: base.outs });
      const tc = performance.now() - t1;
      const t2 = performance.now();
      const gds = topGds({ name: patched.name, terminals: c.terminals, bbox: c.bbox }, MOCK_PDK);
      const tg = performance.now() - t2;
      const kinds = new Map();
      for (const e of c.errors) { const k2 = e.split(" ")[0] + (e.startsWith("DRC") ? " " + e.split(" ").slice(2, 4).join(" ") : ""); kinds.set(k2, (kinds.get(k2) ?? 0) + 1); }
      console.log(`  ${nn.name.padEnd(8)} 조각 ${k} ${s.layer} ${steps > 0 ? "+" : "-"}1 트랙 (비아 ${s.moved} 개 같이)  검사 ${tc.toFixed(0)} ms  GDS ${tg.toFixed(0)} ms ${(gds.length/1024).toFixed(0)}K  오류 ${c.errors.length} (기준 ${base.errs.length}): ${[...kinds].map(([a, b]) => `${a} ${b}`).join(", ") || "-"}`);
      break;
    }
  }
}

// --- B. 넷 하나 고정, 나머지 재배선 ---
console.log("\n--- B. 넷 하나를 고정(장애물 + DoNotRoute)하고 나머지를 다시 배선 ---");
const pick = node.Nets.filter((q) => q.path_metal.length > 0).slice(0, 3);
for (const fixed of pick) {
  const frozen = clone(fixed);
  const out = await routeAll({ label: `고정 ${fixed.name}`, patchTop: (job) => {
    job.node.DoNotRoute = [...(job.node.DoNotRoute ?? []), fixed.name];
    // 경로를 첫 블록의 내부 금속으로 심는다 (배선기는 블록 interMetals 를 장애물로 본다)
    const b0 = job.node.Blocks[0].instance[job.node.Blocks[0].selectedInstance];
    for (const m of frozen.path_metal) b0.interMetals.push(clone(m.MetalRect));
    for (const v of frozen.path_via) { b0.interMetals.push(clone(v.UpperMetalRect)); b0.interMetals.push(clone(v.LowerMetalRect)); b0.interVias.push(clone(v)); }
  } });
  // 되붙이기: 최상위 노드의 그 넷에 원래 경로를 넣고 다시 검사
  const n2 = out.top.m.node;
  const ni = n2.Nets.findIndex((q) => q.name === fixed.name);
  const empty = n2.Nets[ni].path_metal.length;
  n2.Nets[ni].path_metal = clone(frozen.path_metal); n2.Nets[ni].path_via = clone(frozen.path_via);
  const c = checkModule(n2, { leaves, pnrConst: out.res.prep.pnrConst, outs: out.outs });
  // 다른 넷이 얼마나 바뀌었나
  let changed = 0;
  for (const q of n2.Nets) {
    if (q.name === fixed.name) continue;
    const b = node.Nets.find((z) => z.name === q.name);
    if (JSON.stringify(q.path_metal) !== JSON.stringify(b.path_metal)) changed++;
  }
  console.log(`    고정 넷의 배선기 출력 금속 ${empty} (0 이어야 함)  되붙인 뒤 DRC/LVS ${c.errors.length} (기준 ${base.errs.length})  다른 넷 중 바뀐 것 ${changed}/${n2.Nets.length - 1}`);
  for (const e of c.errors.slice(0, 3)) console.log("      " + e.slice(0, 160));
}
