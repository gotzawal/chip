/** 외부 배치를 PnRDB 에 심는다 — placer.py hierarchical_place(placement_verilog_d=...) 가 도는 길:
 *
 *    모듈마다 (TraverseHierTree 순)
 *      CheckoutHierNode(idx, -1)  ->  AddingPowerPins  ->  PlacerIfc
 *        (Placer::setPlacementInfoFromJson -> ILP_solver::UpdateHierNode / UpdateBlockinHierNode /
 *         UpdateTerminalinHierNode)
 *      ->  Extract_RemovePowerPins  ->  CheckinHierNode (부모 갱신과 전원 핀 폭포까지)
 *
 *  배치 좌표는 PnRDB 단위 (scale_placement_verilog(invert) 가 x2 한 것). 스냅도 무작위도 없다.
 *  배치 결과의 비용 칸(HPWL, cost ...)은 셈하지 않는다 — 배선기가 읽지 않는다.
 */
import { NTYPE_UNSET, TERMINAL, clone, newPin, pt } from "./pnrdb.mjs";

const lastInst = (bc) => bc.instance[bc.instance.length - 1];

// ---------------------------------------------------------------- 계층 나무 (PnRdatabase.cpp:17-118)
/** TraverseHierTree — 최상위에서 블록 순으로 깊이 우선, 자식이 먼저 (post-order) */
export function traverseHierTree(db) {
  const order = [], color = db.hierTree.map(() => "white");
  const dfs = (i) => {
    color[i] = "gray";
    for (const bc of db.hierTree[i].Blocks) if (bc.child !== -1 && color[bc.child] === "white") dfs(bc.child);
    color[i] = "black";
    order.push(i);
  };
  dfs(db.topidx);
  return order;
}

const LAYOUT_KEYS = ["gdsFile", "width", "height", "constraint_penalty", "cost", "HPWL", "HPWL_extend", "HPWL_norm", "area_norm",
                     "Blocks", "Terminals", "Nets", "LL", "UR", "PowerNets", "GuardRings"];

/** CheckoutHierNode 의 덮어쓰기 — 저장된 배치 sel 을 저장된 노드 자신에 쓴다 (C++ 이 참조로 쓰는 부작용) */
export function overlayPlacement(db, idx, sel) {
  const hN = db.hierTree[idx];
  if (sel >= 0 && hN.PnRAS.length > 0) {
    const p = hN.PnRAS[sel];
    for (const k of LAYOUT_KEYS) hN[k] = clone(p[k]);
  }
  return hN;
}

/** CheckoutHierNode(id, sel) — 저장된 배치 sel 을 덮은 사본. 덮어쓰기는 저장된 노드에도 남는다. */
export function checkoutHierNode(db, idx, sel) {
  return clone(overlayPlacement(db, idx, sel));
}

export function appendToHierTree(db, hN) {
  db.hierTree.push(clone(hN));
}

// ---------------------------------------------------------------- 전원 핀 (PnRdatabase.cpp:1418-1510, 671-681)
/** AddingPowerPins — 가짜 전원 연결마다 그 dummy_power_pin 사본(netIter -2)을 인스턴스마다 핀 끝에 붙인다 */
export function addingPowerPins(node) {
  for (const pn of node.PowerNets) {
    for (const dc of pn.dummy_connected) {
      const iter2 = dc.iter2, iter = dc.iter;
      for (const inst of node.Blocks[iter2].instance) {
        const p = clone(inst.dummy_power_pin[iter] ?? newPin());   // assert 는 NDEBUG 로 빠져 있다
        p.netIter = -2;
        dc.iter = inst.blockPins.length;
        inst.blockPins.push(p);
      }
    }
  }
}

/** Extract_RemovePowerPins — PowerNets[].Pins = 진짜 전원 핀 사본 + 가짜 핀 사본. 핀 도형은 전부 장애물로 붙이고,
 *  첫 가짜 핀(netIter -2)에서 멈춰 그것과 그 뒤를 버린다 (그 핀의 도형은 이미 붙었다). */
export function extractRemovePowerPins(node) {
  for (const pn of node.PowerNets) {
    pn.Pins = [];
    for (const c of pn.connected) {
      const bc = node.Blocks[c.iter2];
      pn.Pins.push(clone(bc.instance[bc.selectedInstance].blockPins[c.iter]));
    }
    for (const c of pn.dummy_connected) {
      const bc = node.Blocks[c.iter2];
      const pins = bc.instance[bc.selectedInstance].blockPins;
      pn.Pins.push(c.iter < pins.length ? clone(pins[c.iter]) : newPin());
    }
  }
  // 가드링 안의 전원 핀 (GuardRings 가 비어 있으면 아무 일 없다)
  const g = node.GuardRings[0]?.blockPins?.[0];
  if (g && g.pinContacts.length > 0) {
    const tp = newPin(g.name);
    tp.pinContacts.push(clone(g.pinContacts[0]));
    const gnd = node.PowerNets.find((p) => !p.power);
    if (gnd) gnd.Pins.push(tp);
  }
  for (const bc of node.Blocks) {
    for (const inst of bc.instance) {
      const keep = [];
      for (const p of inst.blockPins) {
        for (const c of p.pinContacts) inst.interMetals.push(clone(c));
        if (p.netIter !== -2) keep.push(p);
        else break;
      }
      inst.blockPins = keep;
    }
  }
}

/** ExtractPinsToPowerPins — 진짜 전원 핀 사본을 블록에서 다시 (몇 번 해도 같다) */
export function extractPinsToPowerPins(node) {
  for (const pn of node.PowerNets) {
    pn.connected.forEach((c, j) => {
      const bc = node.Blocks[c.iter2];
      pn.Pins[j] = clone(bc.instance[bc.selectedInstance].blockPins[c.iter]);
    });
  }
}

// ---------------------------------------------------------------- 배치 심기 (Placer.cpp:70-208, ILP_solver.cpp:5545-5749, design.cpp:1066-1296)
/** GetPlacedPosition — 회전 없는 네 방향 (W/E/FW/FE 도 식은 옮겨 둔다) */
function placedPos(X, Y, W, H, ort) {
  switch (ort) {
    case "S": return [W - X, H - Y];
    case "W": return [H - Y, X];
    case "E": return [Y, W - X];
    case "FN": return [W - X, Y];
    case "FS": return [X, H - Y];
    case "FW": return [Y, X];
    case "FE": return [H - Y, W - X];
    default: return [X, Y];
  }
}
const absPoint = (p, W, H, ort, L) => { const [x, y] = placedPos(p.x, p.y, W, H, ort); return pt(x + L.x, y + L.y); };
/** GetPlacedBlockInterMetalAbsBox — 두 꼭짓점을 옮겨 min/max (핀 사각형의 네 꼭짓점 min/max 와 같은 값) */
function absBox(b, W, H, ort, L) {
  const [ax, ay] = placedPos(b.LL.x, b.LL.y, W, H, ort), [cx, cy] = placedPos(b.UR.x, b.UR.y, W, H, ort);
  return { LL: pt(Math.min(ax, cx) + L.x, Math.min(ay, cy) + L.y), UR: pt(Math.max(ax, cx) + L.x, Math.max(ay, cy) + L.y) };
}
/** 핀 사각형: design 은 originBox 의 네 꼭짓점을 옮기고 ConvertBoundaryData 가 min/max */
function absBoundary(b, W, H, ort, L) {
  const ps = [[b.LL.x, b.LL.y], [b.LL.x, b.UR.y], [b.UR.x, b.UR.y], [b.UR.x, b.LL.y]].map(([x, y]) => placedPos(x, y, W, H, ort));
  const xs = ps.map((p) => p[0] + L.x), ys = ps.map((p) => p[1] + L.y);
  return { LL: pt(Math.min(...xs), Math.min(...ys)), UR: pt(Math.max(...xs), Math.max(...ys)) };
}
function placeVia(v, W, H, ort, L) {
  v.placedpos = absPoint(v.originpos, W, H, ort, L);
  for (const k of ["UpperMetalRect", "LowerMetalRect", "ViaRect"]) {
    v[k].placedBox = absBox(v[k].originBox, W, H, ort, L);
    v[k].placedCenter = absPoint(v[k].originCenter, W, H, ort, L);
  }
}

/** UpdateBlockinHierNode — 고른 인스턴스 하나만: 방향, 자리, 핀·비아·장애물의 placed (origin 은 그대로) */
function updateBlockInHierNode(node, i, sel, ort, x, y, dsg) {
  const L = pt(x, y);
  const nd = node.Blocks[i].instance[sel];
  const { width: W, height: H } = dsg;        // design 의 크기 (placer 가 만든 노드 사본의 값)
  nd.orient = "Omark." + ort;
  nd.placedBox = absBoundary(dsg.originBox, W, H, ort, L);
  const [ow, oh] = ["W", "E", "FW", "FE"].includes(ort) ? [H, W] : [W, H];
  nd.placedCenter = pt(Math.trunc(ow / 2) + x, Math.trunc(oh / 2) + y);     // GetBlockAbsCenter
  dsg.blockPins.forEach((dp, j) => {
    const p = nd.blockPins[j];
    p.pinContacts.forEach((c, k) => {
      c.placedBox = absBoundary(dp.pinContacts[k].originBox, W, H, ort, L);
      c.placedCenter = absPoint(dp.pinContacts[k].originCenter, W, H, ort, L);
    });
    for (const v of p.pinVias) placeVia(v, W, H, ort, L);
  });
  for (const c of nd.interMetals) {
    c.placedBox = absBox(c.originBox, W, H, ort, L);
    c.placedCenter = absPoint(c.originCenter, W, H, ort, L);
  }
  for (const v of nd.interVias) placeVia(v, W, H, ort, L);
}

/** UpdateTerminalinHierNode — 포트 넷에 닿는 블록 핀 도형의 사본이 단자 접점 (origin := placed),
 *  노드 핀은 포트마다 하나, 도형은 그 접점이고 금속은 Metal_info[0] ("M1") 으로 바꾼다 */
function updateTerminalInHierNode(node, drc) {
  const t2n = new Map();
  node.Nets.forEach((n, i) => {
    const c = n.connected.find((x) => x.type === TERMINAL);
    if (c) t2n.set(c.iter, i);
  });
  node.Terminals.forEach((t, i) => {
    if (t.netIter === -1) return;
    if (!t2n.has(i)) t2n.set(i, 0);              // std::map::operator[]
    const tc = [];
    for (const c of node.Nets[t2n.get(i)].connected) {
      if (c.type === TERMINAL) continue;
      const bc = node.Blocks[c.iter2];
      for (const con of bc.instance[bc.selectedInstance].blockPins[c.iter].pinContacts) {
        const x = clone(con);
        x.originBox = clone(x.placedBox);
        x.originCenter = clone(x.placedCenter);
        tc.push(x);
      }
    }
    t.termContacts = tc;
  });
  for (const t of node.Terminals) {
    const p = newPin(t.name);
    p.type = t.type;
    p.netIter = t.netIter;
    p.pinContacts = t.termContacts.map((c) => ({ ...clone(c), metal: drc.Metal_info[0].name }));
    node.blockPins.push(p);
  }
}

/** 이름 끝의 _<번호> (find_last_of('_') 뒤를 atoi) */
function suffixIndex(name) {
  const k = name.lastIndexOf("_");
  const n = parseInt(name.substring(k >= 0 ? k + 1 : 0), 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Placer::setPlacementInfoFromJson + ILP_solver::UpdateHierNode.
 * @param {object} node     AddingPowerPins 를 마친 노드 (바뀌지 않는다)
 * @param {Array} modules   이 모듈의 abstract 이름을 가진 placement verilog 모듈들 (PnRDB 단위)
 * @returns {Array} nodeVec — 배치마다 노드 하나 (concrete 이름 끝 번호 자리)
 */
export function placeFromJson(node, modules, drc) {
  const nodeVec = [clone(node)];
  const mine = modules.filter((m) => m.abstract_name === node.name);
  for (const m of mine) {
    const idx = suffixIndex(m.concrete_name);
    while (idx >= nodeVec.length) nodeVec.push(clone(nodeVec[nodeVec.length - 1]));
  }
  const nodeSize = nodeVec.length;
  // design designData(nodeVec.back()) — 배치 전에 한 번 만든 사본. 크기, 핀 도형(origin), halo 는 여기서 읽는다.
  const back = clone(nodeVec[nodeVec.length - 1]);
  const nameMap = { ...back.Block_name_map };
  for (const m of mine) {
    const idx = suffixIndex(m.concrete_name);
    if (idx >= nodeSize) continue;
    const nd = nodeVec[idx];
    nd.concrete_name = m.concrete_name;
    const pos = new Map();
    for (const inst of m.instances) {
      if (!(inst.instance_name in nameMap)) nameMap[inst.instance_name] = 0;   // 모르는 이름은 조용히 0 번 블록
      const bid = nameMap[inst.instance_name];
      const insts = back.Blocks[bid].instance;
      const sel = insts.findIndex((b) => b.lefmaster === inst.concrete_template_name);
      if (sel < 0) throw new Error(`instance_name: ${inst.instance_name} concrete_template_name: ${inst.concrete_template_name} not found. (블록 ${bid} 의 후보: ${insts.map((b) => b.lefmaster).join(", ")})`);
      const t = inst.transformation;
      let x = Math.trunc(t.oX), y = Math.trunc(t.oY), hf = false, vf = false;
      if (t.sX === -1) { hf = true; x -= insts[sel].width; }
      if (t.sY === -1) { vf = true; y -= insts[sel].height; }
      pos.set(bid, { sel, x, y, hf, vf });
    }
    if (pos.size !== back.Blocks.length) {
      const miss = back.Blocks.filter((_, i) => !pos.has(i)).map((bc) => lastInst(bc).name);
      throw new Error(`${node.name}: 배치 안 된 블록 ${miss.join(", ")} (C++ 은 SeqPair 의 초기 선택을 쓴다 — 재현하지 않는다)`);
    }
    // sol.UR: 모든 블록의 x + 폭, y + 높이의 최대 (JSON 의 bbox 는 안 본다)
    let URx = -Infinity, URy = -Infinity;
    for (let i = 0; i < back.Blocks.length; i++) {
      const p = pos.get(i), b = back.Blocks[i].instance[p.sel];
      URx = Math.max(URx, p.x + b.width);
      URy = Math.max(URy, p.y + b.height);
    }
    // UpdateHierNode: int + double(halo) 를 int 에 넣는다
    nd.width = Math.trunc(URx + back.boundary.halo_horizontal);
    nd.height = Math.trunc(URy + back.boundary.halo_vertical);
    for (let i = 0; i < back.Blocks.length; i++) {
      const p = pos.get(i);
      nd.Blocks[i].selectedInstance = p.sel;
      const ort = p.hf ? (p.vf ? "S" : "FN") : (p.vf ? "FS" : "N");
      if (p.sel >= back.Blocks[i].instNum) throw new Error(`${node.name}: 블록 ${i} 의 변이 ${p.sel} 가 design 에 없다`);
      updateBlockInHierNode(nd, i, p.sel, ort, p.x, p.y, back.Blocks[i].instance[p.sel]);
    }
    updateTerminalInHierNode(nd, drc);
    // UpdateSymmetryNetInfo: SNets 의 SBidx 를 세우는 코드가 주석 처리돼 있어 불리지 않는다 (axis_coor 는 -1 그대로)
  }
  return nodeVec;
}

// ---------------------------------------------------------------- CheckinHierNode (PnRdatabase.cpp:684-1038)
/** updatePowerPins — origin := placed */
function updatePowerPins(p) {
  for (const c of p.pinContacts) { c.originBox = clone(c.placedBox); c.originCenter = clone(c.placedCenter); }
  for (const v of p.pinVias) {
    v.originpos = clone(v.placedpos);
    for (const k of ["ViaRect", "UpperMetalRect", "LowerMetalRect"]) { v[k].originBox = clone(v[k].placedBox); v[k].originCenter = clone(v[k].placedCenter); }
  }
  return p;
}

export function checkinHierNode(db, nodeID, upd) {
  const base = db.hierTree[nodeID];
  base.PnRAS.push({
    gdsFile: upd.gdsFile, width: upd.width, height: upd.height, constraint_penalty: upd.constraint_penalty, cost: upd.cost,
    HPWL: upd.HPWL, HPWL_extend: upd.HPWL_extend, HPWL_norm: upd.HPWL_norm, area_norm: upd.area_norm,
    Blocks: clone(upd.Blocks), Terminals: clone(upd.Terminals), Nets: clone(upd.Nets), LL: clone(upd.LL), UR: clone(upd.UR),
    GuardRings: clone(upd.GuardRings), PowerNets: [],
  });
  base.isCompleted = true;
  base.gdsFile = upd.gdsFile;
  base.GuardRings = clone(upd.GuardRings);
  base.Blocks.forEach((bc, i) => {
    const ubc = upd.Blocks[i];
    const sel = ubc.selectedInstance;
    if (sel < 0 || sel >= ubc.instNum) return;               // "unselected block"
    if (bc.instNum < ubc.instNum) { bc.instance = clone(ubc.instance); bc.instNum = ubc.instNum; }
    bc.selectedInstance = sel;
    for (let w = 0; w < ubc.instNum; w++) {
      const l = bc.instance[w], r = ubc.instance[w];
      l.orient = r.orient;
      l.placedBox = clone(r.placedBox);
      l.placedCenter = clone(r.placedCenter);
      l.blockPins.forEach((p, j) => {       // 바탕의 개수까지만 원소별로
        for (let k = 0; k < p.pinContacts.length; k++) p.pinContacts[k] = clone(r.blockPins[j].pinContacts[k]);
        for (let k = 0; k < p.pinVias.length; k++) p.pinVias[k] = clone(r.blockPins[j].pinVias[k]);
      });
      for (let j = 0; j < l.interMetals.length; j++) l.interMetals[j] = clone(r.interMetals[j]);
      for (let j = 0; j < l.interVias.length; j++) l.interVias[j] = clone(r.interVias[j]);
    }
  });
  base.router_report = clone(upd.router_report);
  base.Terminals.forEach((t, i) => { t.termContacts = clone(upd.Terminals[i].termContacts); });
  const un = new Map(upd.Nets.map((n) => [n.name, n]));
  for (const n of base.Nets) {
    const u = un.get(n.name);
    if (u) { n.path_metal = clone(u.path_metal); n.path_via = clone(u.path_via); n.axis_coor = u.axis_coor; }
  }
  for (const pn of base.PowerNets) {
    const q = upd.PowerNets.find((x) => x.name === pn.name);
    if (q) for (const k of ["path_metal", "path_via", "connected", "dummy_connected", "Pins"]) pn[k] = clone(q[k]);
  }
  base.PnRAS[base.PnRAS.length - 1].PowerNets = clone(upd.PowerNets);
  base.blockPins = clone(upd.blockPins);
  base.interMetals = clone(upd.interMetals);
  base.interVias = clone(upd.interVias);

  // 부모 갱신
  for (const pidx of base.parent) {
    const par = db.hierTree[pidx];
    par.router_report.push(...clone(upd.router_report));
    for (const bc of par.Blocks) {
      if (lastInst(bc).master !== upd.name) continue;
      if (bc.instNum > 0) bc.instance.push(clone(lastInst(bc)));
      const b = lastInst(bc);
      bc.instNum++;
      b.gdsFile = upd.gdsFile;
      b.lefmaster = b.master + "_" + (bc.instNum - 1);
      b.HPWL_extend_wo_terminal = upd.HPWL_extend_wo_terminal;
      for (const p of b.blockPins) {
        const q = upd.blockPins.find((x) => x.name === p.name);
        if (q) { p.pinContacts = clone(q.pinContacts); p.pinVias = clone(q.pinVias); }
      }
      b.interMetals = clone(upd.interMetals);
      b.interVias = clone(upd.interVias);
      b.width = upd.width;
      b.height = upd.height;
      b.originCenter = pt(Math.trunc(upd.width / 2), Math.trunc(upd.height / 2));
      b.originBox = { LL: pt(0, 0), UR: pt(upd.width, upd.height) };
    }
    // 전원 핀 폭포: 블록의 가짜 전원 핀을 자식의 전원 넷 핀 전부로 다시
    par.Blocks.forEach((bc, j) => {
      const b = lastInst(bc);
      if (b.master !== upd.name) return;
      b.dummy_power_pin = [];
      for (const q of upd.PowerNets) {
        let found = false;
        for (const bp of b.PowerNets) {
          if (bp.name !== q.name) continue;
          found = true;
          bp.dummy_connected = [];
          for (const p of q.Pins) {
            bp.dummy_connected.push({ type: NTYPE_UNSET, iter: b.dummy_power_pin.length, iter2: j });
            b.dummy_power_pin.push(updatePowerPins(clone(p)));
          }
        }
        if (!found) {
          const tp = { ...clone(q), connected: [], dummy_connected: [], Pins: [] };
          for (const p of q.Pins) {
            tp.dummy_connected.push({ type: NTYPE_UNSET, iter: b.dummy_power_pin.length, iter2: j });
            b.dummy_power_pin.push(updatePowerPins(clone(p)));
          }
          b.PowerNets.push(tp);
        }
      }
    });
    for (const pn of par.PowerNets) pn.dummy_connected = [];
    for (const bc of par.Blocks) {
      const b = lastInst(bc);
      for (const bp of b.PowerNets) {
        let found = false;
        for (const pn of par.PowerNets) {
          if (bp.name !== pn.name) continue;
          found = true;
          pn.dummy_connected.push(...clone(bp.dummy_connected));
        }
        if (!found) par.PowerNets.push({ ...clone(bp), connected: [], Pins: [] });
      }
    }
  }
}

// ---------------------------------------------------------------- hierarchical_place (placer.py:20-67, 299-335)
/**
 * @param {object} db        buildPnRDB 결과 (바뀐다)
 * @param {object} spv       scaled placement verilog (PDK 단위) — 여기서 x2 한다
 * @param {Function} scalePlacementVerilog   prep.mjs 의 것
 * @param {Function} [trace] trace(단계, 자료) — "place_in" {idx, node, modules}, "place_out" {idx, db}
 */
export function hierarchicalPlace(db, spv, scalePlacementVerilog, trace = null) {
  const hack = scalePlacementVerilog(spv, db.drc.ScaleFactor, true);
  const modules = new Map();
  for (const m of hack.modules) {
    if (!modules.has(m.abstract_name)) modules.set(m.abstract_name, []);
    modules.get(m.abstract_name).push(m);
  }
  const order = traverseHierTree(db);
  for (const idx of order) {
    const cur = checkoutHierNode(db, idx, -1);
    trace?.("place_in", { idx, node: clone(cur), modules: modules.get(db.hierTree[idx].name) ?? [] });
    addingPowerPins(cur);
    const nodeVec = placeFromJson(cur, modules.get(db.hierTree[idx].name) ?? [], db.drc);
    for (const node of nodeVec) {
      extractRemovePowerPins(node);
      checkinHierNode(db, idx, node);
    }
    db.hierTree[idx].numPlacement = nodeVec.length;
    trace?.("place_out", { idx, db });
    // update_grid_constraints / process_placements 는 CheckoutHierNode(idx, sel) 를 부른다 (덮어쓰기 부작용만 남는다)
    for (let sel = 0; sel < db.hierTree[idx].numPlacement; sel++) overlayPlacement(db, idx, sel);
  }
  for (const idx of order) for (let sel = 0; sel < db.hierTree[idx].numPlacement; sel++) overlayPlacement(db, idx, sel);
  return order;
}
