/** 계층 배선의 부기 — align/pnr/router.py route_bottom_up + route_single_variant 의 JS 판.
 *
 *  입력 만들기(prep.mjs) -> PnRDB 짓기(pnrdb.mjs) -> 배치 심기(place.mjs) 다음, 모듈마다 TraverseHierTree 순으로:
 *
 *    CheckoutHierNode(i, j)            저장된 배치를 덮은 사본 (저장된 노드에도 덮어쓴다)
 *    hierTree[i].n_copy += 1           사본은 이전 값을 가진다
 *    parent = [], UR = (width, height)
 *    자식 블록마다 CheckinChildnodetoBlock (배선이 끝난 자식의 도형) 뒤 blk.child = 새 번호
 *    ExtractPinsToPowerPins
 *    routeModule(job)                  RouteWork 4, 5 (최상위는 2, 3 까지) — Rust 배선기
 *    기록을 노드에 합치고 gdsFile = ./Results/<이름>_<j>.gds, AppendToHierTree, 자식의 parent 에 새 번호
 *
 *  일감(job)은 symplace/alignroute/src/db.rs Job 모양이다: {drc, node, modes, signal, powerGrid, powerRouting, skip}.
 *  기록은 배선기가 모드마다 노드에 쓴 필드다 ({module, mode, ms, out} — symplace/alignroute/src/route.rs,
 *  필드는 applyRecord).
 */
import { readPdkJson } from "./drc.mjs";
import { buildPnRDB, clone } from "./pnrdb.mjs";
import { appendToHierTree, checkoutHierNode, extractPinsToPowerPins, hierarchicalPlace, overlayPlacement, traverseHierTree } from "./place.mjs";
import { prepRoute, scalePlacementVerilog } from "./prep.mjs";
import { readLeaves } from "../leaves.mjs";

// ---------------------------------------------------------------- CheckinChildnodetoBlock (PnRdatabase.cpp:562-669)
/** TransformBbox (Forward) — 방향 먼저, 그 다음 이동 */
function fwdBox(b, W, H, ort, t) {
  const { LL: l, UR: u } = b;
  let r;
  switch (ort) {
    case "S": r = [W - u.x, H - u.y, W - l.x, H - l.y]; break;
    case "W": r = [H - u.y, l.x, H - l.y, u.x]; break;
    case "E": r = [l.y, W - u.x, u.y, W - l.x]; break;
    case "FN": r = [W - u.x, l.y, W - l.x, u.y]; break;
    case "FS": r = [l.x, H - u.y, u.x, H - l.y]; break;
    case "FW": r = [l.y, l.x, u.y, u.x]; break;
    case "FE": r = [H - u.y, W - u.x, H - l.y, W - l.x]; break;
    default: r = [l.x, l.y, u.x, u.y];
  }
  return { LL: { x: r[0] + t.x, y: r[1] + t.y }, UR: { x: r[2] + t.x, y: r[3] + t.y } };
}
/** TransformPoint (Forward) */
function fwdPt(p, W, H, ort, t) {
  const X = p.x, Y = p.y;
  let q;
  switch (ort) {
    case "S": q = [W - X, H - Y]; break;
    case "W": q = [H - Y, X]; break;
    case "E": q = [Y, W - X]; break;
    case "FN": q = [W - X, Y]; break;
    case "FS": q = [X, H - Y]; break;
    case "FW": q = [Y, X]; break;
    case "FE": q = [H - Y, W - X]; break;
    default: q = [X, Y];
  }
  return { x: q[0] + t.x, y: q[1] + t.y };
}
/** Transform*OriginToPlaced — 앞으로 옮긴 origin 이 placed 가 되고, origin 은 자식 좌표 그대로 (앞뒤로 옮겨 제자리) */
function contactToPlaced(c, W, H, ort, t) {
  c.placedBox = fwdBox(c.originBox, W, H, ort, t);
  c.placedCenter = fwdPt(c.originCenter, W, H, ort, t);
}
function viaToPlaced(v, W, H, ort, t) {
  v.placedpos = fwdPt(v.originpos, W, H, ort, t);
  for (const k of ["UpperMetalRect", "LowerMetalRect", "ViaRect"]) contactToPlaced(v[k], W, H, ort, t);
}

/** CheckinChildnodetoBlock(parent, blockID, child, ort) — 배선이 끝난 자식의 핀·장애물을 부모 블록의 고른 인스턴스로.
 *  핀은 이름이 같은 자식 핀 중 첫 것의 도형·비아를 받는다 (못 찾은 핀은 배치 때의 "M1" 도형을 그대로 둔다). */
export function checkinChildnodeToBlock(parent, blockID, child, ortMark) {
  const ort = ortMark.replace(/^Omark\./, "");
  const W = child.UR.x - child.LL.x, H = child.UR.y - child.LL.y;
  const bc = parent.Blocks[blockID];
  const pi = bc.instance[bc.selectedInstance];
  const t = { ...pi.placedBox.LL };
  pi.gdsFile = child.gdsFile;
  const pins = clone(child.blockPins);
  for (const p of pins) {
    for (const c of p.pinContacts) contactToPlaced(c, W, H, ort, t);
    for (const v of p.pinVias) viaToPlaced(v, W, H, ort, t);
  }
  for (const p of pi.blockPins) {
    const q = pins.find((x) => x.name === p.name);
    if (q) { p.pinContacts = clone(q.pinContacts); p.pinVias = clone(q.pinVias); }
  }
  pi.interMetals = clone(child.interMetals);
  for (const c of pi.interMetals) contactToPlaced(c, W, H, ort, t);
  pi.interVias = clone(child.interVias);
  for (const v of pi.interVias) viaToPlaced(v, W, H, ort, t);
  parent.router_report.push(...clone(child.router_report ?? []));
}

// ---------------------------------------------------------------- 일감 (alignroute/src/db.rs)
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const BLOCK_KEYS = ["name", "master", "lefmaster", "type", "width", "height", "isLeaf", "originBox", "originCenter", "gdsFile",
                    "orient", "placedBox", "placedCenter", "blockPins", "interMetals", "interVias", "dummy_power_pin"];
const NET_KEYS = ["name", "shielding", "sink2Terminal", "degree", "symCounterpart", "iter2SNetLsit", "connected", "priority",
                  "axis_dir", "axis_coor", "path_metal", "path_via", "interVias", "segments", "GcellGlobalRouterPath",
                  "connectedTile", "multi_connection"];
const TERM_KEYS = ["name", "type", "netIter", "termContacts"];
const PNET_KEYS = ["name", "power", "Pins", "connected", "dummy_connected", "path_metal", "path_via"];
const PG_KEYS = ["name", "metals", "vias"];

/** 배선기가 읽는 필드만 (db.rs HierNode). 사본이다. */
export function jobNode(n) {
  return clone({
    name: n.name, isTop: n.isTop, isIntelGcellGlobalRouter: n.isIntelGcellGlobalRouter, n_copy: n.n_copy,
    width: n.width, height: n.height, LL: n.LL, UR: n.UR,
    Blocks: n.Blocks.map((bc) => ({ instance: bc.instance.map((b) => pick(b, BLOCK_KEYS)), selectedInstance: bc.selectedInstance, child: bc.child, instNum: bc.instNum })),
    Nets: n.Nets.map((x) => pick(x, NET_KEYS)),
    Terminals: n.Terminals.map((x) => pick(x, TERM_KEYS)),
    PowerNets: n.PowerNets.map((x) => pick(x, PNET_KEYS)),
    Vdd: pick(n.Vdd, PG_KEYS), Gnd: pick(n.Gnd, PG_KEYS),
    blockPins: n.blockPins, interMetals: n.interMetals, interVias: n.interVias, tiles_total: n.tiles_total,
    DoNotRoute: n.DoNotRoute, Routing_Layers: n.Routing_Layers, Multi_connections: n.Multi_connections,
  });
}

/** route_single_variant 의 층 범위: Route 제약의 min_layer/max_layer 가 신호 배선 층을 바꾼다 (마지막 것, None 이면 기본) */
export function routeLayers(drc, pnrConst) {
  let minNm = null, maxNm = null;
  for (const c of pnrConst?.constraints ?? []) {
    if (c.const_name !== "Route") continue;
    if ("min_layer" in c) minNm = c.min_layer ?? null;
    if ("max_layer" in c) maxNm = c.max_layer ?? null;
  }
  const DI = drc.Design_info;
  const conv = (nm, num) => (nm != null && nm in drc.Metalmap ? drc.Metalmap[nm] : num);
  return {
    signal: [conv(minNm, DI.signal_routing_metal_l), conv(maxNm, DI.signal_routing_metal_u)],
    powerGrid: [DI.power_grid_metal_l, DI.power_grid_metal_u],
    powerRouting: [DI.power_routing_metal_l, DI.power_routing_metal_u],
    skip: [DI.h_skip_factor, DI.v_skip_factor],
  };
}

// ---------------------------------------------------------------- 기록 합치기 (배선기가 모드마다 쓴 필드)
function sameNames(a, b, what) {
  if (a.length !== b.length || a.some((x, i) => x.name !== b[i].name))
    throw new Error(`기록의 ${what} 가 노드와 다르다: ${b.map((x) => x.name).join(",")} / ${a.map((x) => x.name).join(",")}`);
}

/** 모드 m 의 기록 out 을 노드에 쓴다 (배선기가 그 모드에서 쓰는 필드 그대로) */
export function applyRecord(node, mode, out) {
  switch (mode) {
    case 4:
      node.tiles_total = clone(out.tiles_total);
      sameNames(node.Nets, out.Nets, "Nets");
      out.Nets.forEach((r, i) => { node.Nets[i].GcellGlobalRouterPath = clone(r.GcellGlobalRouterPath); node.Nets[i].connectedTile = clone(r.connectedTile); });
      break;
    case 5:
      sameNames(node.Nets, out.Nets, "Nets");
      out.Nets.forEach((r, i) => { node.Nets[i].path_metal = clone(r.path_metal); node.Nets[i].path_via = clone(r.path_via); });
      node.blockPins = clone(out.blockPins);
      node.interMetals = clone(out.interMetals);
      node.interVias = clone(out.interVias);
      sameNames(node.Terminals, out.Terminals, "Terminals");
      out.Terminals.forEach((r, i) => { node.Terminals[i].termContacts = clone(r.termContacts); });
      break;
    case 2:
      for (const k of ["Vdd", "Gnd"]) Object.assign(node[k], { name: out[k].name, metals: clone(out[k].metals), vias: clone(out[k].vias) });
      break;
    case 3:
      sameNames(node.PowerNets, out.PowerNets, "PowerNets");
      out.PowerNets.forEach((r, i) => { node.PowerNets[i].path_metal = clone(r.path_metal); node.PowerNets[i].path_via = clone(r.path_via); });
      node.LL = clone(out.LL); node.UR = clone(out.UR); node.width = out.width; node.height = out.height;
      break;
    default: throw new Error(`모드 ${mode} 의 기록은 없다`);
  }
}

// ---------------------------------------------------------------- 한 판
/**
 * 배치된 설계를 ALIGN 과 같은 순서·같은 자료로 모듈마다 배선기에 넘기고, 돌아온 기록을 합친다.
 *
 * @param {object} o
 * @param {{topology, primitives}} o.design    data/<예제>.json
 * @param {object} o.leaves                     리프 도형 ({format: "leaves/1", leaves} 또는 readLeaves 결과)
 * @param {object} o.placement                  페이지 배치 {bbox, instances, subModules}
 * @param {object} o.pdk                        MOCK_PDK (layers.json)
 * @param {(job:object) => Promise<{records:Array}|Array>} o.routeModule   모듈 하나를 배선한다 (alignroute.wasm route 등)
 * @param {string} [o.inputDir]                 리프 gdsFile 경로 앞머리 (기본 /work/<top 소문자>/3_pnr/inputs — ALIGN 하네스와 같다)
 * @param {Function} [o.trace]                  trace(단계, 자료) — 중간 상태를 보려고: "semantic" {db}, "place_in", "place_out"
 * @returns {Promise<{modules: Array<{name, isTop, idx, sel, job, records, node}>, tree: Array, db: object, prep: object}>}
 *   modules 는 배선한 차례 (TraverseHierTree). node 는 기록을 합친 뒤의 hierNode (hierTree 에 붙은 것과 같은 값).
 */
export async function routeBottomUp({ design, leaves, placement, pdk, routeModule, inputDir = null, trace = null }) {
  const lv = leaves?.format ? readLeaves(leaves) : leaves;
  const prep = prepRoute({ design, leaves: lv, placement, pdk, inputDir });
  const drc = readPdkJson(pdk);
  const db = buildPnRDB({ drc, lef: prep.lef, gdsData2: prep.gdsData2, verilog: prep.abstractVerilog, pnrConst: prep.pnrConst, top: prep.top });
  trace?.("semantic", { db });
  hierarchicalPlace(db, prep.scaledPlacement, scalePlacementVerilog, trace);

  // route_bottom_up (router.py:174-245)
  const idx = traverseHierTree(db).at(-1);
  const nroutings = 1;
  const placementsToRun = Array.from({ length: Math.min(nroutings, db.hierTree[idx].numPlacement) }, (_, k) => k);
  const subblocks = new Map();
  const aux = (i, sel) => {
    if (!subblocks.has(i)) subblocks.set(i, new Set());
    subblocks.get(i).add(sel);
    const cur = overlayPlacement(db, i, sel);        // CheckoutHierNode 의 사본은 읽기만 한다 — 덮어쓰기만 남긴다
    for (const blk of cur.Blocks) if (blk.child >= 0) aux(blk.child, blk.selectedInstance);
  };
  for (const lidx of placementsToRun) aux(idx, lidx);

  const order = traverseHierTree(db);
  if (idx !== order.at(-1)) throw new Error("TraverseHierTree 의 끝이 최상위가 아니다");
  const newIdx = new Map();
  const modules = [];
  for (const i of order) {
    newIdx.set(i, new Map());
    for (const j of [...(subblocks.get(i) ?? [])].sort((a, b) => a - b)) {
      const cur = checkoutHierNode(db, i, j);
      db.hierTree[i].n_copy += 1;
      cur.parent = [];
      if (cur.LL.x !== 0 || cur.LL.y !== 0) throw new Error(`${cur.name}: LL 이 (0, 0) 이 아니다`);
      cur.UR = { x: cur.width, y: cur.height };
      if (cur.abs_orient !== "Omark.N") throw new Error(`${cur.name}: abs_orient 가 N 이 아니다`);
      cur.Blocks.forEach((blk, bit) => {
        const c = blk.child, s = blk.selectedInstance;
        if (c < 0) return;
        const ni = newIdx.get(c)?.get(s);
        if (ni == null) throw new Error(`Toporder incorrect ${c} ${i}`);
        checkinChildnodeToBlock(cur, bit, db.hierTree[ni], blk.instance[s].orient);
        blk.child = ni;
      });

      // route_single_variant
      const pc = prep.pnrConst[cur.name];
      if (!pc) throw new Error(`inputs/${cur.name}.pnr.const.json 이 없다 (route_single_variant 의 assert)`);
      extractPinsToPowerPins(cur);
      const lay = routeLayers(drc, pc);
      const job = { drc, node: jobNode(cur), modes: cur.isTop ? [4, 5, 2, 3] : [4, 5], ...lay };
      const res = await routeModule(job);
      const records = Array.isArray(res) ? res : res.records;
      for (const m of job.modes) {
        const r = records.find((x) => x.mode === m);
        if (!r) throw new Error(`${cur.name}: 모드 ${m} 의 기록이 없다`);
        applyRecord(cur, m, r.out);
      }
      cur.gdsFile = `./Results/${cur.name}_${j}.gds`;       // WriteJSON(<이름>_<j>) 이 쓴다

      appendToHierTree(db, cur);
      const mine = db.hierTree.length - 1;
      newIdx.get(i).set(j, mine);
      for (const blk of cur.Blocks) {
        if (blk.child < 0) continue;
        // 파이썬은 list(set(...)) — 작은 정수 몇 개라 오름차순과 같다
        db.hierTree[blk.child].parent = [...new Set([...db.hierTree[blk.child].parent, mine])].sort((a, b) => a - b);
      }
      modules.push({ name: cur.name, isTop: cur.isTop, idx: mine, sel: j, job, records, node: db.hierTree[mine] });
    }
  }
  return { modules, tree: db.hierTree, db, prep };
}
