/** ALIGN 배선 단계가 읽는 입력을 우리 입력(예제, 리프 도형, 배치)에서 만든다.
 *
 *  ALIGN 에서는 이렇게 흐른다 (align/pnr/main.py generate_pnr, router.py router_driver):
 *
 *    3_pnr:prep   manipulate_hierarchy          -> inputs/<TOP>.verilog.json       manipulatedVerilog
 *                 PnRConstraintWriter           -> inputs/<모듈>.pnr.const.json     pnrConstraints
 *                 리프 .lef 이어 붙이기          -> inputs/<TOP>.lef                 topLef (gen_lef routing)
 *                 primitives 정렬               -> inputs/<TOP>.map                 mapText
 *    (배치)       우리 배치를 덤프에 심는다      -> __placer_dump__.json 의 최상위 대안   placementVerilog
 *    3_pnr:route  connectivity_change_for_partial_routing, change_concrete_names_for_routing
 *                                               -> inputs/<TOP>.scaled_placement_verilog.json
 *                 gen_abstract_verilog_d        -> inputs/<TOP>.abstract_verilog.json
 *                 map_d_in                      -> gdsData2 (리프 concrete 마다 .gds 하나)
 *
 *  JSON 은 파이썬이 쓴 것과 열쇠 순서까지 같게 만든다 (pydantic .dict() 의 필드 순서).
 *  단위는 PDK(layers.json) 단위. PnRDB 단위(x2)는 scalePlacementVerilog(invert) 가 만든다.
 */
import { pgHierarchy, topModule } from "../hier.mjs";
import { unpackLeaf } from "../leaves.mjs";
import { clone } from "./pnrdb.mjs";

// ---------------------------------------------------------------- LEF (cell_fabric/gen_lef.py)
/** Pdk.get_lef_exclude: M 이 아닌 층 전부, 단 위아래 금속이 다 있는 비아는 뺀다 (V0 는 들어간다) */
export function lefExclude(pdk) {
  const res = new Set();
  for (const L of pdk.Abstraction) {
    const x = L.Layer;
    if (x.startsWith("M")) continue;
    if (x.startsWith("V") && L.Stack?.[0] && L.Stack?.[1]) continue;
    res.add(x);
  }
  return res;
}

/** lef_from_layout_d (routing 모드). leaf = 압축 리프 항목(leaves/1). bodyswitch == 0 이면 핀 B 를 뺀다. */
export function genLef(name, leaf, pdk, { bodyswitch = 1, blockM = 0 } = {}) {
  const L = unpackLeaf(leaf);
  const exclude = lefExclude(pdk);
  const bbox = L.bbox;
  const out = [];
  out.push(`MACRO ${name}\n`, "  UNITS \n", `    DATABASE MICRONS UNITS ${1000 * pdk.ScaleFactor};\n`, "  END UNITS \n",
           "  ORIGIN 0 0 ;\n", `  FOREIGN ${name} 0 0 ;\n`, `  SIZE ${bbox[2]} BY ${bbox[3]} ;\n`);
  const pins = [...new Set(L.terminals.filter((t) => t.netType === "pin").map((t) => t.netName))].sort();
  const onNet = new Map();
  for (const t of L.terminals) {
    if (t.netType !== "pin") continue;
    if (exclude.has(t.layer)) continue;             // routing 모드: 배선에 무관한 층은 핀에서 뺀다
    if (!onNet.has(t.netName)) onNet.set(t.netName, []);
    onNet.get(t.netName).push(t);
  }
  for (const pin of pins) {
    if (pin === "B" && bodyswitch === 0) continue;
    out.push(`  PIN ${pin}\n`, "    DIRECTION INOUT ;\n", "    USE SIGNAL ;\n", "    PORT\n");
    for (const t of onNet.get(pin) ?? []) out.push(`      LAYER ${t.layer} ;\n`, `        RECT ${t.rect.join(" ")} ;\n`);
    out.push("    END\n", `  END ${pin}\n`);
  }
  out.push("  OBS\n");
  const pinSet = new Set(pins);
  for (const t of L.terminals) {
    const cond = !pinSet.has(t.netName);
    if ((t.netType !== "pin" || cond) && blockM === 0 && !exclude.has(t.layer)) {
      out.push(`    LAYER ${t.layer} ;\n`, `      RECT ${t.rect.join(" ")} ;\n`);
    } else if (blockM === 1 && t.layer === "Cboundary") {
      for (const capL of ["M1", "M2", "M3"]) out.push(`    LAYER ${capL} ;\n`, `      RECT ${t.rect.join(" ")} ;\n`);
    }
  }
  out.push("  END\n", `END ${name}\n`);
  return out.join("");
}

// ---------------------------------------------------------------- manipulate_hierarchy
/** write_verilog_d 모양 (열쇠 순서 name, parameters, constraints, instances / instance_name, fa_map, abstract_template_name) */
export function manipulatedVerilog(topology, top) {
  const h = pgHierarchy(topology, top);
  return {
    modules: h.modules.map((m) => ({
      name: m.name,
      parameters: m.parameters.slice(),
      constraints: clone(m.constraints ?? []),
      instances: m.instances.map((i) => ({
        instance_name: i.instance_name,
        fa_map: i.fa_map.map((f) => ({ formal: f.formal, actual: f.actual })),
        abstract_template_name: i.abstract_template_name,
      })),
    })),
    global_signals: h.global_signals.map((g) => ({ prefix: g.prefix, formal: g.formal, actual: g.actual })),
  };
}

// ---------------------------------------------------------------- PnRConstraintWriter (write_constraint.py)
/** constraint.expand_user_constraints — yield_constraints 가 있는 제약은 그것들을 먼저 내고,
 *  UserConstraint(AlignInOrder, Floorplan) 가 아니면 자신도 낸다. 여기서 나오는 DoNotIdentify 는 뒤에서 버린다. */
function* expandUserConstraints(list) {
  for (const c of list) {
    const k = c.constraint;
    if (["Order", "Align", "Spread", "PlaceCloser"].includes(k)) {
      yield { constraint: "DoNotIdentify", instances: c.instances };
    } else if (k === "SymmetricBlocks") {
      yield { constraint: "DoNotIdentify", instances: c.pairs.flat() };
    } else if (k === "PlaceOnBoundary") {
      const inst = [];
      for (const a of ["north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"]) {
        const v = c[a];
        if (v) inst.push(...(Array.isArray(v) ? v : [v]));
      }
      yield { constraint: "DoNotIdentify", instances: inst };
    } else if (k === "AlignInOrder") {
      yield { constraint: "Align", instances: c.instances, line: `${c.direction[0]}_${c.line}` };
      yield { constraint: "Order", instances: c.instances, direction: c.direction === "horizontal" ? "left_to_right" : "top_to_bottom", abut: c.abut };
      yield { constraint: "DoNotIdentify", instances: c.instances };
    } else if (k === "Floorplan") {
      const R = c.regions;
      for (let i = 0; i + 1 < R.length; i++)
        for (const above of R[i]) for (const below of R[i + 1])
          yield { constraint: "Order", instances: [above, below], direction: "top_to_bottom", abut: false };
      if (c.order) for (const region of R) if (region.length > 1) yield { constraint: "Order", instances: region, direction: "left_to_right", abut: false };
      if (c.symmetrize) {
        const pairs = [];
        for (const region of R) {
          if (region.length <= 2) pairs.push(region);
          else {
            let i = 0;
            for (i = 0; i < Math.trunc(region.length / 2); i++) pairs.push([region[i], region[region.length - 1 - i]]);
            if (region.length % 2 === 1) pairs.push([region[i]]);
          }
        }
        yield { constraint: "SymmetricBlocks", pairs, direction: "V" };
      }
      if (c.symmetrize && c.order) yield { constraint: "DoNotIdentify", instances: R.flat() };
    }
    if (!["AlignInOrder", "Floorplan"].includes(k)) yield c;
  }
}

const SKIP = new Set(["DoNotIdentify", "GroupBlocks", "DoNotUseLib", "ConfigureCompiler", "SameTemplate", "PlaceOnBoundary"]);

const mapPins = (pins) => pins.map((pin) => (pin.includes("/")
  ? { type: "pin", name: pin.split("/")[0], pin: pin.split("/")[1] }
  : { type: "terminal", name: pin, pin: null }));

/** PnRConstraintWriter.map_valid_const — 모듈 하나의 {constraints: [...]}.
 *  입력 제약은 앞단이 pydantic .dict() 로 쓴 것(필드가 다 있고 순서가 클래스 순서)이라 그대로 딕셔너리로 쓴다.
 *  ChargeFlow 의 변환(파이썬 set 순서에 기대는 것)은 옮기지 않았다 — 그대로 넘긴다 (배치기만 본다). */
export function mapValidConst(allConst) {
  const pnr = [];
  for (const input of expandUserConstraints(allConst)) {
    const c = {};
    for (const [k, v] of Object.entries(input)) if (k !== "constraint" && k !== "_instance_attribute") c[k] = clone(v);
    c.const_name = input.constraint;
    if ("instances" in c) { const b = c.instances; delete c.instances; c.blocks = b; }
    if (SKIP.has(c.const_name)) continue;
    if (!["NetPriority", "NetConst", "PortLocation", "MultiConnection", "PlaceCloser"].includes(c.const_name)) pnr.push(c);

    const pop = (k) => { const v = c[k]; delete c[k]; return v; };
    switch (c.const_name) {
      case "Order":
        c.const_name = "Ordering";
        if (["left_to_right", "horizontal"].includes(c.direction)) c.direction = "H";
        else if (["top_to_bottom", "vertical"].includes(c.direction)) c.direction = "V";
        else throw new Error(`PnR does not support direction ${c.direction} yet`);
        break;
      case "BlockDistance": c.const_name = "bias_graph"; c.distance = pop("abs_distance"); break;
      case "HorizontalDistance": c.const_name = "bias_Hgraph"; c.distance = pop("abs_distance"); break;
      case "VerticalDistance": c.const_name = "bias_Vgraph"; c.distance = pop("abs_distance"); break;
      case "AspectRatio": c.const_name = "Aspect_Ratio"; break;
      case "Boundary":
        for (const k of ["halo_vertical", "halo_horizontal", "max_width", "max_height"]) if (c[k] == null) delete c[k];
        break;
      case "SymmetricBlocks": {
        c.const_name = "SymmBlock";
        c.axis_dir = pop("direction");
        c.pairs = c.pairs.map((b) => (b.length === 1 ? { type: "selfsym", block: b[0] } : { type: "sympair", block1: b[0], block2: b[1] }));
        break;
      }
      case "GroupCaps":
        c.const_name = "CC";
        c.cap_name = String(pop("name")).toUpperCase();
        c.unit_capacitor = String(pop("unit_cap")).toUpperCase();
        c.size = pop("num_units");
        c.nodummy = !c.dummy;
        c.cap_r = c.cap_s = -1;
        delete c.dummy; delete c.blocks;
        break;
      case "Align":
        c.const_name = "AlignBlock";
        if (!["h_bottom", "h_top", "h_center", "v_right", "v_left", "v_center"].includes(c.line)) throw new Error(`PnR does not support edge ${c.line} yet`);
        break;
      case "SymmetricNets": {
        c.const_name = "SymmNet";
        c.axis_dir = pop("direction");
        let pins1, pins2;
        if ("pins1" in c && "pins2" in c) { pins1 = mapPins(c.pins1); pins2 = mapPins(c.pins2); delete c.pins1; delete c.pins2; }
        else { pins1 = [{ type: "dummy", name: "dummy", pin: null }]; pins2 = [{ type: "dummy", name: "dummy", pin: null }]; }
        c.net1 = { name: c.net1, blocks: pins1 };
        c.net2 = { name: c.net2, blocks: pins2 };
        break;
      }
      case "PortLocation":
        for (const port of c.ports) pnr.push({ const_name: "PortLocation", location: c.location, terminal_name: port });
        break;
      case "MultiConnection":
        for (const net of c.nets) pnr.push({ const_name: "Multi_Connection", multi_number: Math.trunc(c.multiplier), net_name: String(net).toUpperCase() });
        break;
      case "NetConst":
        for (const net of c.nets) {
          if (c.shield) pnr.push({ const_name: "ShieldNet", net_name: net, shield_net: c.shield });
          if (c.criticality) pnr.push({ const_name: "CritNet", net_name: net, priority: c.criticality });
        }
        break;
      case "NetPriority":
        for (const net of c.nets) pnr.push({ const_name: "CritNet", net_name: net, priority: c.weight });
        break;
      case "PlaceCloser":
        for (let i = 0; i < c.blocks.length; i++)
          for (let j = i + 1; j < c.blocks.length; j++) pnr.push({ const_name: "MatchBlock", block1: c.blocks[i], block2: c.blocks[j] });
        break;
      default: break;
    }
  }
  // merge_sametemplate_const — 파이썬은 set 을 list 로 바꾼다 (순서는 해시 순). C++ 이 std::set 으로 읽으니 순서는 무관하다.
  const same = [];
  for (const input of expandUserConstraints(allConst)) {
    if (input.constraint !== "SameTemplate") continue;
    let flag = true;
    for (const s of same) if (flag && input.instances.some((x) => s.has(x))) { input.instances.forEach((x) => s.add(x)); flag = false; }
    if (flag) same.push(new Set(input.instances));
  }
  for (const s of same) pnr.push({ const_name: "SameTemplate", blocks: [...s] });
  return { constraints: pnr };
}

/** gen_constraint_files — 모듈마다 {모듈: {constraints}}.
 *  ALIGN 은 `len(constraints) > 0` 으로 거르지만 그 constraints 가 {"constraints": [...]} 딕셔너리라 늘 1 이다 —
 *  제약이 없는 모듈에도 빈 파일을 쓴다. route_single_variant 가 그 파일을 assert 로 요구하므로 같이 맞춘다
 *  (제약 파일이 아예 없는 inverter_v1 에서 걸렸다). */
export function pnrConstraints(verilogD) {
  const out = {};
  for (const m of verilogD.modules) out[m.name] = mapValidConst(m.constraints ?? []);
  return out;
}

// ---------------------------------------------------------------- 리프 LEF, map
/** gen_leaf_cell_info — 인스턴스로 불리는 리프 abstract 이름들 (캐퍼시터 CC, 가드링 몫까지) */
export function leafCellInfo(verilogD, pnrConst) {
  const nonLeaves = new Set(verilogD.modules.map((m) => m.name));
  const called = new Map();
  for (const m of verilogD.modules)
    for (const inst of m.instances) {
      const atn = inst.abstract_template_name;
      if (atn != null && !nonLeaves.has(atn)) {
        if (!called.has(atn)) called.set(atn, []);
        called.get(atn).push([m.name, inst.instance_name]);
      }
    }
  const capConst = {};
  for (const [nm, d] of Object.entries(pnrConst))
    capConst[nm] = Object.fromEntries(d.constraints.filter((c) => c.const_name === "CC").map((c) => [c.cap_name.toUpperCase(), c]));
  const caps = new Set();
  for (const [leaf, v] of called) for (const [parent, instName] of v) if (capConst[parent]?.[instName]) caps.add(leaf);
  const leaves = new Set([...called.keys()].filter((k) => !caps.has(k)));
  for (const v of Object.values(capConst)) for (const c of Object.values(v)) leaves.add(c.unit_capacitor);
  for (const d of Object.values(pnrConst)) for (const c of d.constraints) if (c.const_name === "GuardRing") leaves.add(c.guard_ring_primitives);
  return leaves;
}

/** gen_leaf_collateral 로 고른 리프 concrete 이름들 (primitives 순서) */
export function leafCollateral(primitives, leafSet, leaves) {
  const out = [];
  for (const v of Object.values(primitives)) {
    const atn = v.abstract_template_name;
    if (atn !== "GUARD_RING" && !leafSet.has(atn)) continue;
    // 리프 도형이 없는 것은 뺀다 (ALIGN 은 .lef 가 있으면 넣는다 — 배치에 안 쓰인 리프라면 lefData 에만 없을 뿐)
    if (leaves[v.concrete_template_name]) out.push(v.concrete_template_name);
  }
  return out;
}

/** <TOP>.lef — 고른 리프의 .lef 를 primitives 순서로 이어 붙인다 */
export function topLef(collateral, leaves, pdk, opts) {
  return collateral.map((cn) => genLef(cn, leaves[cn], pdk, opts)).join("");
}

/** <TOP>.map — primitives 를 concrete 이름순으로 "<abstract> <concrete>.gds" */
export function mapText(primitives) {
  return Object.keys(primitives).sort().map((k) => `${primitives[k].abstract_template_name} ${primitives[k].concrete_template_name}.gds\n`).join("");
}

// ---------------------------------------------------------------- 배치 verilog (우리 배치를 __placer_dump__.json 의 최상위 대안으로)
const tr = (q) => ({ oX: Math.trunc(q.oX), oY: Math.trunc(q.oY), sX: Math.trunc(q.sX), sY: Math.trunc(q.sY) });
const placedInst = (instName, fa, atn, ctn, q) => ({
  instance_name: instName, fa_map: clone(fa), abstract_template_name: atn, concrete_template_name: ctn, transformation: tr(q),
});

/** 페이지 배치 -> 최상위 대안 "<TOP>_0" 의 placement verilog (PDK 단위, VerilogJsonTop.dict() 의 열쇠 순서).
 *  하위 모듈 이름은 "<abstract>_<번호>" (같은 abstract 의 다른 모양마다 0, 1, ...), 최상위 인스턴스는 배치 순서,
 *  하위 모듈 인스턴스는 verilog 순서. 리프는 우리 concrete 이름순. */
export function placementVerilog(verilogD, placement, leaves, top) {
  const mods = new Map(verilogD.modules.map((m) => [m.name, m]));
  const gs = clone(verilogD.global_signals ?? []);
  const tmod = mods.get(top);
  const tinst = new Map(tmod.instances.map((i) => [i.instance_name, i]));

  // 하위 모듈 이름 <abstract>_<번호>. 최상위 인스턴스에서 시작해 그 모듈 항목의 인스턴스가 가리키는
  // 모듈까지 **따라 내려가며** 등록한다 (계층이 세 단 이상인 comparator1 의 INVERTER_1, NAND_1 ...).
  // abstract 는 전원 포트를 걷어낸 사본 이름(<이름>_PG<i>)이라 모듈 항목의 인스턴스에서 읽어야 하고,
  // 같은 우리 concrete 가 다른 사본에서 쓰일 수 있어 열쇠는 (abstract, concrete) 다.
  // 같은 모듈을 **다른 모양(variant)** 으로 두 번 쓰면 (vco_type2_65 의 THREE_TERMINAL_INV__v0 / __v2) 각각을
  // 다른 abstract (<이름>, <이름>_V1, ...) 로 낸다. PnRDB 는 abstract 마다 노드 하나를 두고 리프 인스턴스의
  // abstract 를 고른 concrete 로 바꾸므로, 한 abstract 의 두 배치가 리프 variant 를 다르게 고르면 뒤엣것이 앞엣것을 덮는다.
  const key = (ab, concrete) => `${ab}|${concrete}`;
  const subName = new Map(), subAbstract = new Map(), subConcrete = new Map(), aliases = {};
  const smByConcrete = new Map((placement.subModules ?? []).map((sm) => [sm.concrete, sm]));
  const queue = [];
  const register = (concrete, ab) => {
    const k = key(ab, concrete);
    if (!mods.has(ab) || subName.has(k)) return;
    const n = [...subAbstract.values()].filter((v) => v === ab).length;
    const abV = n === 0 ? ab : `${ab}_V${n}`;
    if (n > 0) aliases[abV] = ab;
    subAbstract.set(k, ab);
    subConcrete.set(k, concrete);
    subName.set(k, `${abV}_0`);
    queue.push(k);
  };
  for (const q of placement.instances) register(q.concrete, tinst.get(q.name).abstract_template_name);
  while (queue.length) {
    const k = queue.shift();
    const m = mods.get(subAbstract.get(k)), sm = smByConcrete.get(subConcrete.get(k));
    if (!m || !sm) continue;
    const byName = new Map(m.instances.map((i) => [i.instance_name, i]));
    for (const q of sm.instances) {
      const src = byName.get(q.name);
      if (src) register(q.concrete, src.abstract_template_name);
    }
  }

  const abstractOf = (cn) => cn.replace(/_0$/, "");        // "<abV>_0" -> abV
  const leafUsed = new Map();
  const insts = [];
  for (const q of placement.instances) {
    const src = tinst.get(q.name);
    const ab = src.abstract_template_name;
    const cn = subName.get(key(ab, q.concrete)) ?? q.concrete;
    if (!mods.has(ab)) leafUsed.set(q.concrete, ab);
    insts.push(placedInst(q.name, src.fa_map ?? [], mods.has(ab) ? abstractOf(cn) : ab, cn, q));
  }

  const moduleEntry = (ab, abV, cn, bbox, placed) => {
    const m = mods.get(ab);
    const out = [];
    for (const i of m.instances) {
      const q = placed.get(i.instance_name);
      if (!q) throw new Error(`${ab}: 인스턴스 ${i.instance_name} 의 배치가 없다`);
      const iab = i.abstract_template_name;
      const subCn = subName.get(key(iab, q.concrete)) ?? q.concrete;
      if (!mods.has(iab)) leafUsed.set(q.concrete, iab);
      out.push(placedInst(i.instance_name, i.fa_map ?? [], mods.has(iab) ? abstractOf(subCn) : iab, subCn, q));
    }
    return { parameters: clone(m.parameters ?? []), constraints: clone(m.constraints ?? []), instances: out,
             concrete_name: cn, bbox: bbox.slice(), abstract_name: abV };
  };

  const subEntries = [];
  for (const [k, cn] of subName) {
    const sm = smByConcrete.get(subConcrete.get(k));
    if (!sm) throw new Error(`하위 모듈 ${subConcrete.get(k)} 의 배치가 없다`);
    subEntries.push(moduleEntry(subAbstract.get(k), abstractOf(cn), cn, sm.bbox, new Map(sm.instances.map((i) => [i.name, i]))));
  }

  const leafEntry = (cn, ab) => {
    const e = leaves[cn];
    if (!e) throw new Error(`leaf 정의 없음: ${cn}`);
    const L = unpackLeaf(e);
    return { abstract_name: ab, concrete_name: cn, bbox: L.bbox.slice(),
             terminals: L.terminals.filter((t) => t.netType === "pin" && t.netName).map((t) => ({ name: t.netName, rect: t.rect.slice() })) };
  };
  const topEntry = { parameters: clone(tmod.parameters ?? []), constraints: clone(tmod.constraints ?? []), instances: insts,
                     concrete_name: `${top}_0`, bbox: placement.bbox.slice(), abstract_name: top };
  return {
    modules: [topEntry, ...subEntries],
    leaves: [...leafUsed].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([c, a]) => leafEntry(c, a)),
    global_signals: gs,
    aliases,           // {"<abstract>_V1": "<abstract>"} — 제약 표를 복사할 때 쓴다
  };
}

/** connectivity_change_for_partial_routing — partially_routed_pins 가 있는 리프의 fa_map 을 푼다 (Mock PDK 에는 없다) */
export function connectivityChangeForPartialRouting(spv, primitives) {
  if (!primitives) return;
  for (const m of spv.modules)
    for (const inst of m.instances) {
      const prp = primitives[inst.concrete_template_name]?.metadata?.partially_routed_pins;
      if (!prp) continue;
      const byNet = new Map();
      for (const [entity, net] of Object.entries(prp)) {
        if (!byNet.has(net)) byNet.set(net, []);
        byNet.get(net).push(entity);
      }
      const fa = [];
      for (const { formal, actual } of inst.fa_map) for (const e of byNet.get(formal) ?? [formal]) fa.push({ formal: e, actual });
      inst.fa_map = fa;
    }
}

/** change_concrete_names_for_routing (manipulate_hierarchy.py:138-173) — 모듈 이름을 <abstract>_<k> 로 다시 매기고
 *  리프 인스턴스의 abstract_template_name 을 concrete 이름으로. 제자리에서 바꾸고 tr_tbl 을 돌려준다. */
export function changeConcreteNamesForRouting(spv) {
  const leafCtns = new Set(spv.leaves.map((l) => l.concrete_name));
  const cnTbl = new Map();
  for (const m of spv.modules) {
    const g = /^(.+)_(\d+)$/.exec(m.concrete_name);
    if (!g || g[1] !== m.abstract_name) throw new Error(`concrete 이름이 <abstract>_<번호> 가 아니다: ${m.concrete_name}`);
    if (!cnTbl.has(m.abstract_name)) cnTbl.set(m.abstract_name, []);
    cnTbl.get(m.abstract_name).push(parseInt(g[2], 10));
  }
  const trTbl = {};
  for (const [an, idx] of cnTbl) [...idx].sort((a, b) => a - b).forEach((old, k) => { trTbl[`${an}_${old}`] = `${an}_${k}`; });
  for (const m of spv.modules) {
    m.concrete_name = trTbl[m.concrete_name];
    for (const inst of m.instances) {
      const ctn = inst.concrete_template_name;
      if (leafCtns.has(ctn)) {
        if (ctn in trTbl) throw new Error(`리프와 모듈 이름이 겹친다: ${ctn}`);
        inst.abstract_template_name = ctn;
      } else {
        if (!(ctn in trTbl)) throw new Error(`모르는 concrete 이름: ${ctn}`);
        inst.concrete_template_name = trTbl[ctn];
      }
    }
  }
  for (const leaf of spv.leaves) leaf.abstract_name = leaf.concrete_name;
  return trTbl;
}

/** gen_abstract_verilog_d — bbox, 변환, concrete 이름을 지운다 (열쇠 순서: parameters, constraints, instances, name) */
export function genAbstractVerilog(spv) {
  const d = clone(spv);
  if ("leaves" in d) d.leaves = null;
  for (const m of d.modules) {
    m.name = m.abstract_name;
    delete m.abstract_name; delete m.concrete_name; delete m.bbox;
    for (const inst of m.instances) { delete inst.concrete_template_name; delete inst.transformation; }
  }
  return d;
}

/** render_placement.scale_placement_verilog — invert 면 PDK -> PnRDB (x2 / ScaleFactor). 파이썬 divmod (내림). */
export function scalePlacementVerilog(spv, scaleFactor, invert = false) {
  const d = clone(spv);
  const [mul, div] = invert ? [2, scaleFactor] : [scaleFactor, 2];
  const s = (v) => Math.floor((mul * v) / div);
  for (const m of d.modules) {
    m.bbox = m.bbox.map(s);
    for (const inst of m.instances) { inst.transformation.oX = s(inst.transformation.oX); inst.transformation.oY = s(inst.transformation.oY); }
  }
  for (const leaf of d.leaves ?? []) {
    leaf.bbox = leaf.bbox.map(s);
    leaf.terminals = leaf.terminals.map((t) => ({ name: t.name, rect: t.rect.map(s) }));
  }
  return d;
}

// ---------------------------------------------------------------- 한데 묶기
/**
 * @param {object} o
 * @param {{topology, primitives}} o.design   data/<예제>.json
 * @param {object} o.leaves                    readLeaves() 결과 {concrete: 압축 항목}
 * @param {object} o.placement                 페이지 배치 {bbox, instances, subModules}
 * @param {object} o.pdk                       MOCK_PDK (layers.json)
 * @param {string} [o.inputDir]                gdsData2 의 경로 앞머리 (ALIGN 하네스: /work/<예제>/3_pnr/inputs)
 * @returns {{top, verilog, pnrConst, lef, map, scaledPlacement, abstractVerilog, gdsData2, trTbl}}
 */
export function prepRoute({ design, leaves, placement, pdk, inputDir = null }) {
  const top = topModule(design.topology).name;
  const verilog = manipulatedVerilog(design.topology, top);
  const pnrConst = pnrConstraints(verilog);
  const collateral = leafCollateral(design.primitives ?? {}, leafCellInfo(verilog, pnrConst), leaves);
  const lef = topLef(collateral, leaves, pdk);
  const map = mapText(design.primitives ?? {});
  const spv = placementVerilog(verilog, placement, leaves, top);
  // variant 별로 갈라 낸 모듈(<이름>_V1 ...)은 원래 모듈의 제약을 그대로 쓴다.
  for (const [abV, ab] of Object.entries(spv.aliases ?? {})) pnrConst[abV] = clone(pnrConst[ab]);
  delete spv.aliases;
  connectivityChangeForPartialRouting(spv, design.primitives);
  const trTbl = changeConcreteNamesForRouting(spv);
  const abstractVerilog = genAbstractVerilog(spv);
  // router_driver 의 map_d_in: 리프마다 (concrete, <inputs>/<concrete>.gds) — .json 이 있는 것만
  const dir = inputDir ?? `/work/${top.toLowerCase()}/3_pnr/inputs`;
  const gdsData2 = {};
  for (const leaf of spv.leaves) {
    const ctn = leaf.concrete_name;
    if (!leaves[ctn]) continue;
    (gdsData2[ctn] ??= []).push(`${dir}/${ctn}.gds`);
  }
  return { top, verilog, pnrConst, lef, map, scaledPlacement: spv, abstractVerilog, gdsData2, trTbl };
}
