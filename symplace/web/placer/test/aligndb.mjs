/** src/route/align/ (ALIGN 배선 단계의 입력 만들기, PnRDB 짓기, 배치 심기, 계층 부기)가 ALIGN 과 같은 자료를 내는가.
 *
 *  5 예제 x (우리 배치, ALIGN 배치) 마다 routeBottomUp 을 돌린다. 배선기 자리에는 가짜를 넣는다:
 *  모듈 #i 에서 ALIGN 이 낸 기록(recordOf(탭 덤프 m*_out, 모드))을 그대로 돌려준다. 그리고 견준다:
 *
 *    drc       일감의 drc == tap drc.json (db.rs DrcInfo 의 필드, maxL 은 빼고)
 *    node      일감의 node == tap m4_in (db.rs HierNode 가 읽는 필드 전부, 블록은 고른 인스턴스)
 *    층        signal / powerGrid / powerRouting == calls.json 의 Lmetal/Hmetal, skip == drc.json, 모드 차례
 *    입력      aligndb 의 inputs_* 와: <TOP>.lef (MACRO 마다 글자 그대로), <TOP>.map, <TOP>.verilog.json,
 *              <모듈>.pnr.const.json, <TOP>.scaled_placement_verilog.json, <TOP>.abstract_verilog.json (JSON 값과 열쇠 순서)
 *    wires     기록을 합친 뒤의 gen_viewer_json 도형 == ALIGN 검사기 입력의 뒷부분 (순서까지), bbox == 기록의 bbox,
 *              블록(이름, master, lefmaster, gdsFile, 방향, 변환) == 기록의 blocks   — 우리 배치만 (~/.cache/symplace/check)
 *              (블록 도형은 compose.mjs 로 합성해 앞부분까지 통째로 견준다)
 *    단계      aligndb 의 HN 덤프와: 01 lefData·gdsData2, 02 semantic 뒤 나무·TraverseHierTree, 04 배치 입력, 05 배치 결과
 *
 *  pybind 가 안 내보내는 DoNotRoute, Routing_Layers, Multi_connections, net.multi_connection 은 ALIGN 이 쓴
 *  pnr.const.json 에서 ReadConstraint.cpp 의 뜻대로 기대값을 만들어 견준다 (constExpect).
 *  5 예제에 없는 경우는 symplace/scripts/route/align-ref/db/refrun.mjs 로 기준을 만들고 SYMPLACE_CACHE, --data 로 돌린다.
 *
 *    node symplace/web/placer/test/aligndb.mjs [--ex=예제] [--tag=ours|align] [--data=<예제 파일 폴더>] [-v]
 *
 *  기준 덤프: ~/.cache/symplace/tap (align-ref/tap/runall.mjs), ~/.cache/symplace/aligndb (align-ref/db/dumphn.mjs),
 *  ~/.cache/symplace/check (node/checkref.mjs capture). 없으면 그 검사는 건너뛴다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeBottomUp } from "../../../../src/route/align/bottomup.mjs";
import { traverseHierTree } from "../../../../src/route/align/place.mjs";
import { recordOf } from "../../../../src/route/align/records.mjs";
import { viewerBbox, viewerBlocks, viewerWires } from "../../../../src/route/align/wires.mjs";
import { composeModule } from "../../../../src/route/compose.mjs";
import { faMapOf, pgHierarchy, placementFromAlign, powerNetsOf } from "../../../../src/route/hier.mjs";
import { readLeaves, unpackLeaf } from "../../../../src/route/leaves.mjs";
import { MOCK_PDK } from "../../../../src/route/pdk.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const verbose = args.includes("-v");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// ---------------------------------------------------------------- 견주기
/** 차이 목록 [{path, a, b}] — 배열 길이가 다르면 그 자리 하나, 객체는 두 쪽 열쇠의 합 */
function diff(a, b, p = "", out = [], limit = 6) {
  if (out.length >= limit) return out;
  if (a === b) return out;
  if (typeof a === "number" && typeof b === "number" && Object.is(a, b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push({ path: p + ".length", a: a.length, b: b.length });
    for (let i = 0; i < Math.min(a.length, b.length) && out.length < limit; i++) {
      const nm = a[i]?.name ?? b[i]?.name;
      diff(a[i], b[i], `${p}[${i}]${typeof nm === "string" ? `(${nm})` : ""}`, out, limit);
    }
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a) || !(k in b)) { out.push({ path: `${p}.${k}`, a: k in a ? "있음" : "없음", b: k in b ? "있음" : "없음" }); continue; }
      diff(a[k], b[k], `${p}.${k}`, out, limit);
      if (out.length >= limit) break;
    }
    return out;
  }
  out.push({ path: p, a, b });
  return out;
}
const brief = (v) => { const s = JSON.stringify(v); return s === undefined ? "없음" : s.length > 90 ? s.slice(0, 87) + "..." : s; };
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));

// db.rs 의 필드들
const METAL_INFO = ["name", "layerNo", "width", "dist_ss", "direct", "grid_unit_x", "grid_unit_y", "minL", "dist_ee", "offset",
                    "unit_R", "unit_C", "unit_CC", "lower_via_index", "upper_via_index"];     // maxL 은 C++ 에서 쓰레기값
const VIA_INFO = ["name", "layerNo", "lower_metal_index", "upper_metal_index", "width", "width_y", "cover_l", "cover_l_P",
                  "cover_u", "cover_u_P", "dist_ss", "dist_ss_y", "R"];
const VIA_MODEL = ["name", "ViaIdx", "LowerIdx", "UpperIdx", "ViaRect", "LowerRect", "UpperRect", "R"];
const DESIGN_INFO = ["Hspace", "Vspace", "signal_routing_metal_l", "signal_routing_metal_u", "power_grid_metal_l", "power_grid_metal_u",
                     "power_routing_metal_l", "power_routing_metal_u", "h_skip_factor", "v_skip_factor", "compact_style"];
const drcView = (d) => ({
  MaxLayer: d.MaxLayer, Metalmap: d.Metalmap, Viamap: d.Viamap, metal_weight: d.metal_weight,
  Metal_info: d.Metal_info.map((m) => pick(m, METAL_INFO)), Via_info: d.Via_info.map((v) => pick(v, VIA_INFO)),
  Via_model: d.Via_model.map((v) => pick(v, VIA_MODEL)), Design_info: pick(d.Design_info, DESIGN_INFO),
});

const BLOCK_KEYS = ["name", "master", "lefmaster", "type", "width", "height", "isLeaf", "originBox", "originCenter", "gdsFile",
                    "orient", "placedBox", "placedCenter", "blockPins", "interMetals", "interVias", "dummy_power_pin"];
const NET_KEYS = ["name", "shielding", "sink2Terminal", "degree", "symCounterpart", "iter2SNetLsit", "connected", "priority",
                  "axis_dir", "axis_coor", "path_metal", "path_via", "interVias", "segments", "GcellGlobalRouterPath", "connectedTile"];
/** pybind 가 안 내보내는 넷 필드 (DoNotRoute, Routing_Layers, Multi_connections, net.multi_connection) 의 기대값 —
 *  ALIGN 이 쓴 pnr.const.json 을 ReadConstraint.cpp 의 뜻대로 읽는다 (src 와 따로 짠 것). 파일이 없으면 기본값. */
function constExpect(cj) {
  const e = { DoNotRoute: [], Routing_Layers: { global_min_layer: "", global_max_layer: "", Routing_per_Net: [] },
              Multi_connections: [], multi: new Map() };
  for (const c of cj?.constraints ?? []) {
    if (c.const_name === "DoNotRoute") e.DoNotRoute = [...c.nets];
    else if (c.const_name === "Route") {
      e.Routing_Layers = { global_min_layer: c.min_layer, global_max_layer: c.max_layer,
        Routing_per_Net: (c.customize ?? []).flatMap((s) => s.nets.map((net) => ({ net_min_layer: s.min_layer, net_max_layer: s.max_layer, net_name: net }))) };
    } else if (c.const_name === "Multi_Connection") {
      e.Multi_connections.push({ net_name: c.net_name, multi_number: c.multi_number });
      e.multi.set(c.net_name, c.multi_number);
    }
  }
  return e;
}

/** db.rs HierNode 가 읽는 것. ex 는 덤프에 없는 필드의 기대값 (constExpect) — 우리 쪽은 null. */
const nodeView = (n, ex = null) => ({
  name: n.name, isTop: n.isTop, isIntelGcellGlobalRouter: n.isIntelGcellGlobalRouter, n_copy: n.n_copy,
  width: n.width, height: n.height, LL: n.LL, UR: n.UR,
  Blocks: n.Blocks.map((bc) => ({ selectedInstance: bc.selectedInstance, child: bc.child, instNum: bc.instNum,
                                  selected: pick(bc.instance[bc.selectedInstance], BLOCK_KEYS) })),
  Nets: n.Nets.map((x) => ({ ...pick(x, NET_KEYS), multi_connection: x.multi_connection ?? ex?.multi.get(x.name) ?? 1 })),
  Terminals: n.Terminals.map((x) => pick(x, ["name", "type", "netIter", "termContacts"])),
  PowerNets: n.PowerNets.map((x) => pick(x, ["name", "power", "Pins", "connected", "dummy_connected", "path_metal", "path_via"])),
  Vdd: pick(n.Vdd, ["name", "metals", "vias"]), Gnd: pick(n.Gnd, ["name", "metals", "vias"]),
  blockPins: n.blockPins, interMetals: n.interMetals, interVias: n.interVias, tiles_total: n.tiles_total,
  DoNotRoute: n.DoNotRoute ?? ex?.DoNotRoute,
  Routing_Layers: n.Routing_Layers ?? ex?.Routing_Layers,
  Multi_connections: n.Multi_connections ?? ex?.Multi_connections,
});

// ---------------------------------------------------------------- PnRDB 중간 단계 (aligndb 의 HN 덤프, align-ref/db/instrument.py 모양)
const P = (p) => [p.x, p.y];
const Bx = (b) => [b.LL.x, b.LL.y, b.UR.x, b.UR.y];
const C = (c) => ({ metal: c.metal, o: Bx(c.originBox), p: Bx(c.placedBox), oc: P(c.originCenter), pc: P(c.placedCenter) });
const V = (v) => ({ model: v.model_index, opos: P(v.originpos), ppos: P(v.placedpos), U: C(v.UpperMetalRect), L: C(v.LowerMetalRect), V: C(v.ViaRect) });
const PIN = (p) => ({ name: p.name, type: p.type, use: p.use, netIter: p.netIter, c: p.pinContacts.map(C), v: p.pinVias.map(V) });
const MET = (m) => ({ idx: m.MetalIdx, pts: m.LinePoint.map(P), w: m.width, r: C(m.MetalRect) });
const CN = (c) => [{ "NType.Block": 0, "NType.Terminal": 1 }[c.type] ?? "?", c.iter, c.iter2];
const DCN = (c) => [c.iter, c.iter2];          // dummy_connected 의 type 은 C++ 에서 초기화 안 된 값 — 뺀다 (build_db.py dconn)
const PN = (n) => ({ name: n.name, power: n.power ? 1 : 0, Pins: n.Pins.map(PIN), connected: n.connected.map(CN),
                     dummy_connected: n.dummy_connected.map(DCN), path_metal: n.path_metal.map(MET), path_via: n.path_via.map(V) });
const OM = (o) => ["N", "S", "W", "E", "FN", "FS", "FW", "FE"].indexOf(o.replace(/^Omark\./, ""));
const SM = (s) => ({ "Smark.H": 0, "Smark.V": 1 }[s]);
const BLK = (b) => ({ name: b.name, master: b.master, lefmaster: b.lefmaster, type: b.type, w: b.width, h: b.height, isLeaf: b.isLeaf,
                      originBox: Bx(b.originBox), originCenter: P(b.originCenter), gdsFile: b.gdsFile, orient: OM(b.orient),
                      placedBox: Bx(b.placedBox), placedCenter: P(b.placedCenter), pins: b.blockPins.map(PIN), interMetals: b.interMetals.map(C),
                      interVias: b.interVias.map(V), dummy_power_pin: b.dummy_power_pin.map(PIN), PowerNets: b.PowerNets.map(PN) });
const BC = (bc) => ({ selectedInstance: bc.selectedInstance, child: bc.child, instNum: bc.instNum, instance: bc.instance.map(BLK) });
const NET = (n) => ({ name: n.name, shielding: n.shielding, sink2Terminal: n.sink2Terminal, degree: n.degree, symCounterpart: n.symCounterpart,
                      iter2SNetLsit: n.iter2SNetLsit, connected: n.connected.map(CN), priority: n.priority, axis_dir: SM(n.axis_dir),
                      axis_coor: n.axis_coor, path_metal: n.path_metal.map(MET), path_via: n.path_via.map(V), n_interVias: n.interVias.length,
                      n_GcellGlobalRouterPath: n.GcellGlobalRouterPath.length });
const TERM = (t) => ({ name: t.name, type: t.type, netIter: t.netIter, termContacts: t.termContacts.map(C) });
const PG = (g) => ({ name: g.name, metals: g.metals.map(MET), vias: g.vias.map(V) });
const HN = (h) => ({
  name: h.name, isTop: h.isTop, width: h.width, height: h.height, LL: P(h.LL), UR: P(h.UR), abs_orient: OM(h.abs_orient),
  n_copy: h.n_copy, numPlacement: h.numPlacement, concrete_name: h.concrete_name, gdsFile: h.gdsFile, parent: [...h.parent],
  Blocks: h.Blocks.map(BC), Nets: h.Nets.map(NET), Terminals: h.Terminals.map(TERM), PowerNets: h.PowerNets.map(PN),
  Vdd: PG(h.Vdd), Gnd: PG(h.Gnd), blockPins: h.blockPins.map(PIN), interMetals: h.interMetals.map(C), interVias: h.interVias.map(V),
  SNets: h.SNets.map((s) => ({ net1: s.net1.name, net2: s.net2.name, iter1: s.iter1, iter2: s.iter2,
                               net1_connected: s.net1.connected.map(CN), net2_connected: s.net2.connected.map(CN) })),
  SPBlocks: h.SPBlocks.map((s) => ({ sympair: s.sympair.map((x) => [...x]), selfsym: s.selfsym.map(([a, b]) => [a, SM(b)]) })),
  Block_name_map: { ...h.Block_name_map }, n_PnRAS: h.PnRAS.length, bias_Hgraph: h.bias_Hgraph, bias_Vgraph: h.bias_Vgraph,
  n_tiles_total: h.tiles_total.length,
});
const LEF = (m) => ({ name: m.name, master: m.master, w: m.width, h: m.height, pins: m.macroPins.map(PIN),
                      interMetals: m.interMetals.map(C), interVias: m.interVias.map(V) });
/** 덤프 쪽 dummy_connected 도 type 을 뺀다 */
const dconn = (x) => (Array.isArray(x) ? x.map(dconn) : x && typeof x === "object"
  ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "dummy_connected" ? v.map((c) => c.slice(1)) : dconn(v)])) : x);

/** trace 로 모은 중간 상태를 aligndb 의 00~05 덤프와 견준다 */
function stageChecks(dbDir, st) {
  const errs = [];
  const say = (what, d) => { if (d.length) errs.push(`${what} ` + d.map((x) => `${x.path}: ${brief(x.a)} / ALIGN ${brief(x.b)}`).join("; ")); };
  const lef = J(path.join(dbDir, "01_lefData.json"));
  say("01_lefData", diff(st.lef, lef));
  const g2 = J(path.join(dbDir, "01_gdsData2.json"));
  say("01_gdsData2", diff(st.gdsData2, g2));
  const sem = J(path.join(dbDir, "02_tree_after_semantic.json"));
  say("02 topidx/traverse", diff([st.topidx, st.traverse], [sem.topidx, sem.traverse]));
  say("02_tree_after_semantic", diff(st.tree, dconn(sem.nodes)));
  const byIdx = (pre) => new Map(fs.readdirSync(dbDir).filter((f) => f.startsWith(pre)).map((f) => { const r = J(path.join(dbDir, f)); return [r.idx, r]; }));
  const pin = byIdx("04_"), pout = byIdx("05_");
  for (const [idx, r] of pin) say(`04_place_input ${r.node_before.name}`, diff(st.placeIn.get(idx), dconn(r.node_before)));
  for (const [idx, r] of pout) {
    const mine = st.placeOut.get(idx);
    const want = { numPlacement: r.numPlacement, n_PnRAS: r.n_PnRAS,
                   PnRAS0: pick(r.PnRAS0, ["width", "height", "LL", "UR", "gdsFile", "Blocks", "Nets", "Terminals"]),
                   base_blockPins: r.base_blockPins, base_PowerNets: r.base_PowerNets };
    say(`05_place_output idx ${idx}`, diff(mine, dconn(want)));
  }
  if (pin.size !== st.placeIn.size || pout.size !== st.placeOut.size) errs.push(`배치 단계 수 ${st.placeIn.size}/${st.placeOut.size} / ALIGN ${pin.size}/${pout.size}`);
  return errs;
}

// ---------------------------------------------------------------- 예제마다
// --data=<폴더>: 예제 파일(<예제>.json, <예제>.leaves.json)을 다른 데서 (앞단을 다른 제약으로 돌린 것 등)
const DATA = opt("data", path.join(ROOT, "data"));
const rows = opt("ex") ? [opt("ex")] : J(path.join(ROOT, "data/index.json")).map((x) => (typeof x === "string" ? x : x.name));
let bad = 0, runs = 0, modCount = 0;
const summary = [];
for (const ex of rows) {
  const lp = path.join(DATA, ex + ".leaves.json");
  if (!fs.existsSync(lp)) continue;
  const design = J(path.join(DATA, ex + ".json"));
  const leavesFile = J(lp);
  const leaves = readLeaves(leavesFile);
  const placements = { ours: path.join(CACHE, `place-${ex}.json`), align: null };
  for (const tag of ["ours", "align"]) {
    if (opt("tag") && opt("tag") !== tag) continue;
    const tapDir = path.join(CACHE, "tap", ex, tag), dbDir = path.join(CACHE, "aligndb", ex, tag);
    if (!fs.existsSync(path.join(tapDir, "calls.json"))) { console.log(`${ex.padEnd(27)} ${tag.padEnd(5)} (기준 덤프 없음: ${tapDir})`); continue; }
    if (tag === "ours" && !fs.existsSync(placements.ours)) { console.log(`${ex.padEnd(27)} ${tag.padEnd(5)} (배치 캐시 없음)`); continue; }
    const placement = tag === "ours" ? J(placements.ours) : placementFromAlign(design.place);
    runs++;
    const calls = J(path.join(tapDir, "calls.json"));
    const drcRef = J(path.join(tapDir, "drc.json"));
    const file = (c, io) => path.join(tapDir, `${String(c.k).padStart(2, "0")}_${c.node}_m${c.mode}_${io}.json`);
    const mods = [];
    for (const c of calls) {
      if (!mods.length || mods.at(-1).name !== c.node || mods.at(-1).calls.some((d) => d.mode === c.mode)) mods.push({ name: c.node, calls: [] });
      mods.at(-1).calls.push(c);
    }
    const lines = new Map();       // 모듈 -> 결과 줄
    let k = 0;
    const routeModule = async (job) => {
      const m = mods[k++];
      const errs = [];
      if (!m) throw new Error(`기준에 없는 배선 호출: ${job.node.name}`);
      if (m.name !== job.node.name) errs.push(`모듈 차례: ALIGN ${m.name} / JS ${job.node.name}`);
      const by = Object.fromEntries(m.calls.map((c) => [c.mode, c]));
      // drc
      const dd = diff(drcView(job.drc), drcView(drcRef));
      if (dd.length) errs.push("drc " + dd.map((x) => `${x.path}: ${brief(x.a)} / ALIGN ${brief(x.b)}`).join("; "));
      // node (덤프에 없는 필드는 ALIGN 의 pnr.const.json 에서 기대값을 만든다)
      const cjPath = path.join(dbDir, `inputs_${job.node.name}.pnr.const.json`);
      const expect = constExpect(fs.existsSync(cjPath) ? J(cjPath) : null);
      const nd = diff(nodeView(job.node), nodeView(J(file(by[4], "in")), expect));
      if (nd.length) errs.push("node\n" + nd.map((x) => `        ${x.path}: ${brief(x.a)}  /  ALIGN ${brief(x.b)}`).join("\n"));
      // 층, 모드
      const wantModes = m.calls.map((c) => c.mode);
      if (JSON.stringify(job.modes) !== JSON.stringify(wantModes)) errs.push(`모드 ${job.modes} / ALIGN ${wantModes}`);
      for (const [mode, key] of [[4, "signal"], [5, "signal"], [2, "powerGrid"], [3, "powerRouting"]]) {
        if (!by[mode]) continue;
        const want = [by[mode].Lmetal, by[mode].Hmetal];
        if (JSON.stringify(job[key]) !== JSON.stringify(want)) errs.push(`모드 ${mode} ${key} ${job[key]} / ALIGN ${want}`);
      }
      const skip = [drcRef.Design_info.h_skip_factor, drcRef.Design_info.v_skip_factor];
      if (JSON.stringify(job.skip) !== JSON.stringify(skip)) errs.push(`skip ${job.skip} / ALIGN ${skip}`);
      lines.set(`${job.node.name}#${k}`, { errs, nets: job.node.Nets.length, blocks: job.node.Blocks.length });
      return { records: job.modes.map((mode) => ({ module: m.name, mode, out: recordOf(J(file(by[mode], "out")), mode) })) };
    };

    // 중간 상태 (HN 모양으로 바로 옮겨 둔다 — db 는 뒤에서 바뀐다)
    const st = { placeIn: new Map(), placeOut: new Map() };
    const trace = (stage, d) => {
      if (stage === "semantic") {
        st.lef = Object.fromEntries(Object.entries(d.db.lefData).map(([nm, v]) => [nm, v.map(LEF)]));
        st.gdsData2 = structuredClone(d.db.gdsData2);
        st.tree = d.db.hierTree.map(HN);
        st.topidx = d.db.topidx;
        st.traverse = traverseHierTree(d.db);
      } else if (stage === "place_in") st.placeIn.set(d.idx, HN(d.node));
      else if (stage === "place_out") {
        const h = d.db.hierTree[d.idx], r = h.PnRAS[0];
        st.placeOut.set(d.idx, {
          numPlacement: h.numPlacement, n_PnRAS: h.PnRAS.length,
          PnRAS0: { width: r.width, height: r.height, LL: P(r.LL), UR: P(r.UR), gdsFile: r.gdsFile,
                    Blocks: r.Blocks.map(BC), Nets: r.Nets.map(NET), Terminals: r.Terminals.map(TERM) },
          base_blockPins: h.blockPins.map(PIN), base_PowerNets: h.PowerNets.map(PN),
        });
      }
    };

    const t0 = performance.now();
    let res;
    try {
      res = await routeBottomUp({ design, leaves: leavesFile, placement, pdk: MOCK_PDK, routeModule, trace });
    } catch (e) {
      bad++;
      console.log(`${ex.padEnd(27)} ${tag.padEnd(5)} 오류  ${e.stack.split("\n").slice(0, 4).join(" | ")}`);
      continue;
    }
    const ms = performance.now() - t0;
    if (k !== mods.length) { bad++; console.log(`${ex.padEnd(27)} ${tag.padEnd(5)} 배선 호출 ${k} / ALIGN ${mods.length}`); }

    // 입력 파일
    const prepErrs = [];
    if (fs.existsSync(dbDir)) {
      const top = res.prep.top;
      const inp = (n) => path.join(dbDir, "inputs_" + n);
      const macros = (t) => new Map(t.split(/(?=^MACRO )/m).filter(Boolean).map((b) => [b.match(/^MACRO (\S+)/)[1], b]));
      const lefText = fs.readFileSync(inp(`${top}.lef`), "utf8");
      const gl = macros(lefText), ml = macros(res.prep.lef);
      const lefBad = [...new Set([...gl.keys(), ...ml.keys()])].filter((n) => gl.get(n) !== ml.get(n));
      if (lefBad.length) prepErrs.push(`lef: MACRO ${lefBad.length} 개 다름 (${lefBad.slice(0, 3).join(", ")})`);
      else if (lefText !== res.prep.lef)
        // ReadLEF 는 MACRO 마다 새로 읽고 lefData(std::map, 이름 열쇠)에 넣으니 차례는 결과에 닿지 않는다
        prepErrs.push(`(lef: MACRO ${ml.size} 개 글자까지 같고 차례만 다르다 — 같은 abstract 안의 primitives 차례가 ALIGN 실행 때와 다르다)`);
      if (fs.readFileSync(inp(`${top}.map`), "utf8") !== res.prep.map) prepErrs.push("map 다름");
      const jsonEq = (name, mine) => {
        const d = diff(mine, J(inp(name)));
        if (d.length) prepErrs.push(`${name}: ` + d.map((x) => `${x.path}: ${brief(x.a)} / ALIGN ${brief(x.b)}`).join("; "));
        else if (JSON.stringify(mine) !== JSON.stringify(J(inp(name)))) prepErrs.push(`${name}: 열쇠 순서가 다르다`);
      };
      jsonEq(`${top}.verilog.json`, res.prep.verilog);
      jsonEq(`${top}.abstract_verilog.json`, res.prep.abstractVerilog);
      jsonEq(`${top}.scaled_placement_verilog.json`, res.prep.scaledPlacement);
      const constFiles = fs.readdirSync(dbDir).filter((f) => /^inputs_.*\.pnr\.const\.json$/.test(f)).map((f) => f.slice(7, -15)).sort();
      const mineConst = Object.keys(res.prep.pnrConst).sort();
      if (JSON.stringify(constFiles) !== JSON.stringify(mineConst)) prepErrs.push(`pnr.const 모듈 ${mineConst} / ALIGN ${constFiles}`);
      for (const nm of constFiles) if (res.prep.pnrConst[nm]) jsonEq(`${nm}.pnr.const.json`, res.prep.pnrConst[nm]);
    } else prepErrs.push(`(inputs 기준 없음: ${dbDir})`);

    // wires — 우리 배치의 검사기 기록
    const capPath = path.join(CACHE, "check", ex + ".json");
    const cap = tag === "ours" && fs.existsSync(capPath) ? J(capPath) : null;
    const hier = cap ? pgHierarchy(design.topology, cap.top) : null;
    // 검사기 기록은 배선한 차례 (results_name_map) — 같은 모듈이 두 번(다른 배치 모양) 나올 수 있어 차례로 짝짓는다
    const caseOfGds = new Map(cap ? res.modules.map((m, i) => [m.node.gdsFile, cap.cases[i]]) : []);
    let n = 0;
    for (const m of res.modules) {
      n++;
      const key = `${m.name}#${n}`;
      const row = lines.get(key) ?? { errs: [`배선 호출 기록이 없다 (${key})`] };
      const errs = row.errs.slice();
      const wires = viewerWires(m.node);
      let wireNote = "wires -";
      if (cap) {
        const c = cap.cases[n - 1];
        if (!c || c.module !== m.name) errs.push(`검사기 기록의 ${n} 번째가 ${c?.module ?? "없음"} 이다 (JS ${m.name})`);
        else {
          // 블록: 이름, 도형 출처, 방향, 변환
          const vb = viewerBlocks(m.node);
          const bd = diff(vb.map((b) => ({ name: b.name, master: b.master, lefmaster: b.lefmaster, gdsFile: b.gdsFile, orient: b.orient,
                                            tr2x: [b.tr2x.oX, b.tr2x.oY, b.tr2x.sX, b.tr2x.sY] })), c.blocks);
          if (bd.length) errs.push("blocks " + bd.map((x) => `${x.path}: ${brief(x.a)} / ALIGN ${brief(x.b)}`).join("; "));
          // 블록 도형 (compose.mjs — test/compose.mjs 와 같은 방법) 다음이 wires
          const mod = hier.modules.find((x) => x.name === m.name);
          const blocks = vb.map((b) => {
            if (b.isLeaf) { const L = unpackLeaf(leaves[b.lefmaster]); return { name: b.name, tr: b.tr, terminals: L.terminals, subinsts: L.subinsts }; }
            const sub = caseOfGds.get(b.gdsFile);
            return { name: b.name, tr: b.tr, terminals: sub?.terminalsOut ?? [] };
          });
          const comp = composeModule({ blocks, faMap: faMapOf(mod), powerNets: powerNetsOf(hier), wires });
          const strip = (t) => ({ netName: t.netName, netType: t.netType, layer: t.layer, rect: t.rect });
          const wd = diff(comp.terminals.map(strip), c.terminals.map(strip), "", [], 4);
          if (wd.length) errs.push(`checker 입력 (블록 도형 ${comp.terminals.length - wires.length} + wires ${wires.length}, ALIGN ${c.terminals.length}) ` +
                                   wd.map((x) => `${x.path}: ${brief(x.a)} / ALIGN ${brief(x.b)}`).join("; "));
          const bb = viewerBbox(m.node);
          if (JSON.stringify(bb) !== JSON.stringify(c.bbox)) errs.push(`bbox ${bb} / ALIGN ${c.bbox}`);
          wireNote = `wires ${String(wires.length).padStart(4)}`;
        }
      }
      modCount++;
      const ok = !errs.length;
      if (!ok) bad++;
      console.log(`${ex.padEnd(27)} ${tag.padEnd(5)} ${m.name.padEnd(30)} 넷 ${String(row.nets ?? "-").padStart(2)} 블록 ${String(row.blocks ?? "-").padStart(2)}  ${wireNote}  ${ok ? "같다" : "다름"}`);
      for (const e of errs) console.log("    " + e);
    }
    const pok = !prepErrs.some((e) => !e.startsWith("("));
    if (!pok) bad++;
    console.log(`${ex.padEnd(27)} ${tag.padEnd(5)} ${"입력 파일 (lef map verilog pnr.const placement abstract)".padEnd(30)} ${pok ? "같다" : "다름"}  ${ms.toFixed(0)} ms (기준 기록 읽기 포함)`);
    for (const e of prepErrs) console.log("    " + e);
    if (fs.existsSync(path.join(dbDir, "02_tree_after_semantic.json"))) {
      const se = stageChecks(dbDir, st);
      if (se.length) bad++;
      console.log(`${ex.padEnd(27)} ${tag.padEnd(5)} ${"PnRDB 단계 (lefData semantic place_in/out)".padEnd(30)} ${se.length ? "다름" : "같다"}`);
      for (const e of se) console.log("    " + e);
    }
    summary.push(`${ex}/${tag} ${ms.toFixed(0)}ms`);
    if (verbose) for (const w of res.db.warnings) console.log("    경고: " + w);
  }
}
console.log(`\n${runs} 판, 모듈 ${modCount} 개 — ${bad ? `다름 ${bad} 건` : "모두 같다"}`);
if (verbose) console.log(summary.join("  "));
if (bad || !runs) process.exit(1);
