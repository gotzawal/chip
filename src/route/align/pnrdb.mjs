/** PnRDB 짓기 — build_pnr_model.py PnRdatabase() 가 부르는 순서 그대로:
 *
 *    ReadPDKJSON (drc.mjs) -> ReadLEFFromString -> gdsData2 -> _ReadVerilogJson -> _attach_constraint_files
 *    (ReadConstraint_Json) -> semantic0 (+MergeLEFMapData) -> semantic1 -> semantic2
 *
 *  자료는 pybind 덤프 모양(walk)이다 — 필드 이름이 C++ 과 같고 열거형은 문자열 ("Omark.N", "NType.Block",
 *  "Smark.V"). 좌표는 PnRDB 단위 (layers.json x 2). C++ 의 정수 나눗셈은 Math.trunc.
 *  제약은 semantic1 이 전원 넷을 PowerNets 로 옮기기 **전에** 읽는다 — 그래서 SNets 의 iter1/iter2 는
 *  낡을 수 있고, Nets[].symCounterpart 만 semantic2 가 이름으로 다시 맞춘다.
 */

/** 깊은 복사 — C++ 의 값 복사. 자료가 JSON 모양(객체, 배열, 원시값)뿐이라 structuredClone 보다 몇 배 빠르다. */
export function clone(x) {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) {
    const n = x.length, a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = clone(x[i]);
    return a;
  }
  const o = {};
  for (const k in x) o[k] = clone(x[k]);
  return o;
}

// ---------------------------------------------------------------- 자료형 (datatype.h 의 기본값)
export const OMARK = ["N", "S", "W", "E", "FN", "FS", "FW", "FE"];
export const BLOCK = "NType.Block", TERMINAL = "NType.Terminal";
/** CheckinHierNode 가 만드는 dummy_connected 의 type 은 C++ 에서 초기화하지 않는다 (pybind 덤프: "NType.???") */
export const NTYPE_UNSET = "NType.???";

export const pt = (x = 0, y = 0) => ({ x, y });
export const bbox = (llx = 0, lly = 0, urx = 0, ury = 0) => ({ LL: { x: llx, y: lly }, UR: { x: urx, y: ury } });
export const contact = (metal = "") => ({ metal, originBox: bbox(), originCenter: pt(), placedBox: bbox(), placedCenter: pt() });
export const newVia = () => ({ model_index: 0, originpos: pt(), placedpos: pt(), UpperMetalRect: contact(), LowerMetalRect: contact(), ViaRect: contact() });
export const newPin = (name = "") => ({ name, type: "", use: "", netIter: -1, pinContacts: [], pinVias: [] });
export const connectNode = (type, iter, iter2) => ({ type, iter, iter2 });

/** PnR.block() — 파이썬이 만든 것은 값 초기화라 orient = N */
export const newBlock = () => ({
  name: "", master: "", lefmaster: "", type: "", width: 0, height: 0, isLeaf: true,
  originBox: bbox(), originCenter: pt(), gdsFile: "", orient: "Omark.N", placedBox: bbox(), placedCenter: pt(),
  PowerNets: [], blockPins: [], interMetals: [], interVias: [], dummy_power_pin: [], GuardRings: [], HPWL_extend_wo_terminal: 0,
});

export const newNet = (name = "") => ({
  name, shielding: false, sink2Terminal: false, degree: 0, symCounterpart: -1, iter2SNetLsit: -1, connected: [],
  priority: "", segments: [], interVias: [], path_metal: [], GcellGlobalRouterPath: [], path_via: [],
  axis_dir: "Smark.V", axis_coor: -1, connectedTile: [], multi_connection: 1, weight: 1,
});

export const newPowerNet = (name = "", power = false) => ({ name, power, Pins: [], connected: [], dummy_connected: [], path_metal: [], path_via: [] });
export const newPowerGrid = () => ({ name: "", metals: [], vias: [] });

export const newNode = () => ({
  name: "", isTop: false, isCompleted: false, isIntelGcellGlobalRouter: false, width: 0, height: 0,
  LL: pt(), UR: pt(), abs_orient: "Omark.N", n_copy: 0, numPlacement: 0, concrete_name: "", gdsFile: "",
  parent: [], Blocks: [], Block_name_map: {}, tiles_total: [], Nets: [], Terminals: [],
  Vdd: newPowerGrid(), Gnd: newPowerGrid(), PowerNets: [], GuardRings: [],
  blockPins: [], interMetals: [], interVias: [], PnRAS: [], SNets: [], SPBlocks: [],
  bias_Hgraph: 0, bias_Vgraph: 0, compact_style: "left",
  HPWL: -1, HPWL_extend: -1, HPWL_extend_wo_terminal: -1, HPWL_norm: -1, area_norm: -1, constraint_penalty: -1, cost: -1,
  DoNotRoute: [], Routing_Layers: { global_min_layer: "", global_max_layer: "", Routing_per_Net: [] }, Multi_connections: [],
  boundary: { halo_horizontal: 0, halo_vertical: 0 }, placement_box: [Number.MAX_VALUE, Number.MAX_VALUE],
  Aspect_Ratio_weight: 1000, Aspect_Ratio: [0, 100], router_report: [],
});

// ---------------------------------------------------------------- ReadLEF (PnRDB/ReadLEF.cpp)
/** get_true_word — ';' 에서 멈추고 ' ' 와 '\n' 으로만 가른다 (탭은 글자다) */
function trueWords(text, start) {
  const out = [];
  let rec = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === ";") break;
    if (ch !== " " && ch !== "\n") {
      if (!rec) { out.push(""); rec = true; }
      out[out.length - 1] += ch;
    } else rec = false;
  }
  return out;
}

/** C 의 round (0.5 는 0 에서 먼 쪽) */
const cRound = (v) => Math.sign(v) * Math.round(Math.abs(v));
/** parse_and_scale — stod(s) * unitScale 을 반올림 */
const scale = (s, units) => cRound(parseFloat(s) * units);

/** 비아 모델을 가운데 c 에 놓은 비아 (LEF 사각형이 아니라 모델의 세 사각형) */
function placeViaModel(via, drc, c) {
  const vm = drc.Via_model[via.model_index];
  const add = (p) => ({ x: p.x + c.x, y: p.y + c.y });
  via.originpos = { ...c };
  via.ViaRect.originCenter = { ...c };
  via.ViaRect.originBox = { LL: add(vm.ViaRect[0]), UR: add(vm.ViaRect[1]) };
  via.ViaRect.metal = vm.name;
  if (vm.LowerIdx >= 0) {
    via.LowerMetalRect.originCenter = { ...c };
    via.LowerMetalRect.originBox = { LL: add(vm.LowerRect[0]), UR: add(vm.LowerRect[1]) };
    via.LowerMetalRect.metal = drc.Metal_info[vm.LowerIdx].name;
  }
  if (vm.UpperIdx >= 0) {
    via.UpperMetalRect.originCenter = { ...c };
    via.UpperMetalRect.originBox = { LL: add(vm.UpperRect[0]), UR: add(vm.UpperRect[1]) };
    via.UpperMetalRect.metal = drc.Metal_info[vm.UpperIdx].name;
  }
}

const viamapAt = (drc, name) => { if (!(name in drc.Viamap)) drc.Viamap[name] = 0; return drc.Viamap[name]; };

/**
 * _ReadLEF — 줄 단위, 열쇠말은 줄 어디에 있어도 (string::find). 버릇까지 그대로:
 *   - OBS 에서 LAYER 줄 뒤 첫 RECT 만 쓴다 (RECT 가 temp 를 덮어써 다음 RECT 의 종류가 숫자가 된다)
 *   - OBS 의 V* 는 이름이 '0' 으로 끝나면 버린다 (V10 도)
 *   - PORT 에서 LAYER M* 뒤 첫 RECT 만 핀 도형, LAYER V* 는 핀 비아. 깃발은 PORT 에서 새로 세우지 않는다
 *   - 비아는 LEF 사각형의 가운데에 비아 모델의 세 사각형으로
 * @returns {Object<string, Array>} lefData: 이름 -> [lefMacro {name, master, width, height, macroPins, interMetals, interVias}]
 */
export function readLef(text, drc, unitScale = 2000) {
  const lefData = {};
  let stage = 0, skipRest = false;
  let temp = [];
  let units = 2.0;
  let macroName = "", macroEnd = "", pinEnd = "", unitsEnd = "";
  let width = -1, height = -1;
  let macroPins = [], interMetals = [], interVias = [];
  let metalFlag = false, viaFlag = false;   // C++ 에서는 초기화 안 된 bool
  const portEnd = "END", obsEnd = "END";
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();   // getline: 마지막 줄바꿈 뒤에는 줄이 없다
  for (const def of lines) {
    let f;
    if (stage === 0) {
      if ((f = def.indexOf("MACRO")) >= 0) {
        temp = trueWords(def, f);
        macroName = temp[1];
        macroEnd = "END " + macroName;
        width = 0; height = 0;
        macroPins = []; interMetals = []; interVias = [];
        stage = 1;
      }
    } else if (stage === 5) {
      if (def.indexOf(unitsEnd) >= 0) stage = 1;
      else if ((f = def.indexOf("DATABASE")) >= 0) {
        temp = trueWords(def, f);
        units = unitScale / parseFloat(temp[3]);
      }
    } else if (stage === 1) {
      if ((f = def.indexOf("SIZE")) >= 0) {
        temp = trueWords(def, f);
        width = scale(temp[1], units);
        height = scale(temp[3], units);
      } else if (def.indexOf("UNITS") >= 0) {
        stage = 5;
        unitsEnd = "END UNITS";
      } else if ((f = def.indexOf("PIN")) >= 0) {
        temp = trueWords(def, f);
        macroPins.push(newPin(temp[1]));
        pinEnd = "END " + temp[1];
        stage = 2;
      } else if (def.indexOf("OBS") >= 0) {
        stage = 4;
      } else if (def.indexOf(macroEnd) >= 0) {
        const m = { name: macroName, master: macroName, width, height, macroPins, interMetals, interVias };
        (lefData[m.master] ??= []).push(clone(m));
        stage = 0;
      }
    } else if (stage === 4) {
      if ((f = def.indexOf("LAYER")) >= 0) {
        skipRest = false;
        temp = trueWords(def, f);
        const nm = temp[1];
        if (nm[0] === "M") interMetals.push(contact(nm));
        else if (nm[0] === "V" && nm[nm.length - 1] !== "0") {
          const v = newVia();
          v.model_index = viamapAt(drc, nm);
          v.ViaRect.metal = nm;
          interVias.push(v);
        } else skipRest = true;
      } else if ((f = def.indexOf("RECT")) >= 0) {
        const rectType = temp[1]?.[0];
        temp = trueWords(def, f);
        const LLx = scale(temp[1], units), LLy = scale(temp[2], units), URx = scale(temp[3], units), URy = scale(temp[4], units);
        if (!skipRest) {
          if (rectType === "M") {
            const m = interMetals[interMetals.length - 1];
            m.originBox = bbox(LLx, LLy, URx, URy);
            m.originCenter = pt(Math.trunc((LLx + URx) / 2), Math.trunc((LLy + URy) / 2));
          } else if (rectType === "V") {
            placeViaModel(interVias[interVias.length - 1], drc, pt(Math.trunc((LLx + URx) / 2), Math.trunc((LLy + URy) / 2)));
          }
        }
      } else if (def.indexOf(obsEnd) >= 0) {
        stage = 1;
      }
    } else if (stage === 2) {
      if ((f = def.indexOf("USE")) >= 0) {
        temp = trueWords(def, f);
        macroPins[macroPins.length - 1].use = temp[1];
      } else if ((f = def.indexOf("DIRECTION")) >= 0) {
        temp = trueWords(def, f);
        macroPins[macroPins.length - 1].type = temp[1];
      } else if ((f = def.indexOf("PORT")) >= 0) {
        temp = trueWords(def, f);
        stage = 3;
      } else if (def.indexOf(pinEnd) >= 0) {
        stage = 1;
      }
    } else if (stage === 3) {
      const pin = macroPins[macroPins.length - 1];
      if ((f = def.indexOf("LAYER")) >= 0) {
        temp = trueWords(def, f);
        const rt = temp[1][0];
        if (rt === "M") {
          metalFlag = true;
          pin.pinContacts.push(contact(temp[1]));
        } else if (rt === "V") {
          viaFlag = true;
          const v = newVia();
          v.model_index = viamapAt(drc, temp[1]);
          pin.pinVias.push(v);
        } else {
          viaFlag = false;
          metalFlag = false;
        }
      } else if ((f = def.indexOf("RECT")) >= 0 && metalFlag) {
        metalFlag = false;
        temp = trueWords(def, f);
        const LLx = scale(temp[1], units), LLy = scale(temp[2], units), URx = scale(temp[3], units), URy = scale(temp[4], units);
        const c = pin.pinContacts[pin.pinContacts.length - 1];
        c.originBox = bbox(LLx, LLy, URx, URy);
        c.originCenter = pt(Math.trunc((LLx + URx) / 2), Math.trunc((LLy + URy) / 2));
      } else if ((f = def.indexOf("RECT")) >= 0 && viaFlag) {
        viaFlag = false;
        temp = trueWords(def, f);
        const LLx = scale(temp[1], units), LLy = scale(temp[2], units), URx = scale(temp[3], units), URy = scale(temp[4], units);
        placeViaModel(pin.pinVias[pin.pinVias.length - 1], drc, pt(Math.trunc((LLx + URx) / 2), Math.trunc((LLy + URy) / 2)));
      } else if (def.indexOf(portEnd) >= 0) {
        stage = 2;
      }
    }
  }
  return lefData;
}

// ---------------------------------------------------------------- _ReadVerilogJson (build_pnr_model.py:17-107)
/** 모듈마다 hierNode 하나. 넷은 (인스턴스 순, fa_map 순)으로 처음 나온 차례 — 이것이 배선 순서다. */
export function readVerilogJson(vd) {
  const hierTree = [];
  for (const module of vd.modules) {
    const node = newNode();
    node.name = module.name ?? module.abstract_name;
    node.Terminals = module.parameters.map((p) => ({ name: p, type: "input", netIter: -1, termContacts: [] }));
    const netMap = new Map();
    for (const inst of module.instances) {
      const b = newBlock();
      if ("template_name" in inst) b.master = inst.template_name;
      else if ("abstract_template_name" in inst) b.master = inst.abstract_template_name;
      else throw new Error(`Missing template_name (abstract or otherwise) in instance ${inst.instance_name}`);
      b.name = inst.instance_name;
      node.Block_name_map[b.name] = node.Blocks.length;
      inst.fa_map.forEach((fa, i) => {
        let ni = netMap.get(fa.actual);
        if (ni == null) { ni = node.Nets.length; node.Nets.push(newNet(fa.actual)); netMap.set(fa.actual, ni); }
        node.Nets[ni].connected.push(connectNode(BLOCK, i, node.Blocks.length));
        const p = newPin(fa.formal);
        p.netIter = ni;
        b.blockPins.push(p);
      });
      node.Blocks.push({ instance: [b], selectedInstance: -1, child: -1, instNum: 0 });
    }
    for (const n of node.Nets) n.degree = n.connected.length;
    hierTree.push(node);
  }
  const globalSignals = (vd.global_signals ?? []).map((g) => [g.prefix, g.formal, g.actual]);
  return { hierTree, globalSignals };
}

// ---------------------------------------------------------------- ReadConstraint_Json (PnRDB/ReadConstraint.cpp)
const lastInst = (bc) => bc.instance[bc.instance.length - 1];
const axisOf = (c) => (c.axis_dir === "H" ? "Smark.H" : "Smark.V");

function symmNetConnected(node, netc) {
  const out = [];
  for (const pin of netc.blocks) {
    if (pin.type === "pin") {
      for (let i = 0; i < node.Blocks.length; i++) {
        const b = lastInst(node.Blocks[i]);
        if (b.name === pin.name) {
          const j = b.blockPins.findIndex((p) => p.name === pin.pin);
          if (j >= 0) out.push(connectNode(BLOCK, j, i));
          break;
        }
      }
    } else {
      const i = node.Terminals.findIndex((t) => t.name === pin.name);
      if (i >= 0) out.push(connectNode(TERMINAL, i, -1));
    }
  }
  return out;
}

/** 배선기가 보는 것(SymmNet, ShieldNet, Multi_Connection, DoNotRoute, Route)과 그 입력에 닿는 것(bias, Boundary,
 *  CompactPlacement), 배치기만 보는 것은 모양만 (SymmBlock 등). */
export function readConstraintJson(node, cj, { scaleFactor = 1, unitScale = 2000 } = {}) {
  for (const c of cj.constraints ?? []) {
    switch (c.const_name) {
      case "SymmNet": {
        const net1 = { name: c.net1.name, connected: symmNetConnected(node, c.net1) };
        const net2 = { name: c.net2.name, connected: symmNetConnected(node, c.net2) };
        let iter1 = -1, iter2 = -1;
        for (let i = 0; i < node.Nets.length && (iter1 === -1 || iter2 === -1); i++) {
          if (node.Nets[i].name === net1.name) iter1 = i;
          if (node.Nets[i].name === net2.name) iter2 = i;
        }
        if (iter1 < 0 || iter2 < 0) throw new Error(`${node.name}: SymmNet ${net1.name}/${net2.name} 의 넷이 없다 (C++ 은 Nets.at 에서 죽는다)`);
        const ax = axisOf(c);
        Object.assign(node.Nets[iter1], { symCounterpart: iter2, axis_dir: ax, iter2SNetLsit: node.SNets.length });
        Object.assign(node.Nets[iter2], { symCounterpart: iter1, axis_dir: ax, iter2SNetLsit: node.SNets.length });
        node.SNets.push({ net1, net2, iter1, iter2, axis_dir: ax });
        break;
      }
      case "CritNet": {
        const n = node.Nets.find((x) => x.name === c.net_name);
        if (n) n.weight = c.priority;
        break;
      }
      case "SymmBlock": {
        const sp = { sympair: [], selfsym: [], axis_dir: axisOf(c) };
        for (const p of c.pairs) {
          if (p.type === "sympair") {
            let f = -1, s = -1;
            node.Blocks.forEach((bc, k) => { if (lastInst(bc).name === p.block1) f = k; if (lastInst(bc).name === p.block2) s = k; });
            sp.sympair.push(f > s ? [s, f] : [f, s]);
          } else {
            const j = node.Blocks.findIndex((bc) => lastInst(bc).name === p.block);
            if (j >= 0) sp.selfsym.push([j, axisOf(c)]);
          }
        }
        node.SPBlocks.push(sp);
        break;
      }
      case "bias_graph": node.bias_Hgraph = node.bias_Vgraph = Math.trunc((Math.trunc(c.distance) * 2) / scaleFactor); break;
      case "bias_Hgraph": node.bias_Hgraph = Math.trunc((Math.trunc(c.distance) * 2) / scaleFactor); break;
      case "bias_Vgraph": node.bias_Vgraph = Math.trunc((Math.trunc(c.distance) * 2) / scaleFactor); break;
      case "ShieldNet": {
        const n = node.Nets.find((x) => x.name === c.net_name);
        if (n) n.shielding = true;
        break;
      }
      case "Aspect_Ratio":
        node.Aspect_Ratio_weight = c.weight;
        node.Aspect_Ratio = [c.ratio_low, c.ratio_high];
        break;
      case "Multi_Connection": {
        node.Multi_connections.push({ net_name: c.net_name, multi_number: c.multi_number });
        const n = node.Nets.find((x) => x.name === c.net_name);
        if (n) n.multi_connection = c.multi_number;
        break;
      }
      case "Boundary":
        node.placement_box = [c.max_width * unitScale, c.max_height * unitScale];
        if ("halo_horizontal" in c) node.boundary.halo_horizontal = c.halo_horizontal * unitScale;
        if ("halo_vertical" in c) node.boundary.halo_vertical = c.halo_vertical * unitScale;
        break;
      case "CompactPlacement": node.compact_style = c.style; break;
      case "DoNotRoute": node.DoNotRoute = [...c.nets]; break;
      case "Route": {
        // C++ 은 min_layer/max_layer 를 string 으로 받는다 (null 이면 json type_error 로 죽는다)
        if (typeof c.min_layer !== "string" || typeof c.max_layer !== "string")
          throw new Error(`${node.name}: Route 의 min_layer/max_layer 가 문자열이 아니다 (C++ 에서 죽는다)`);
        const r = { global_min_layer: c.min_layer, global_max_layer: c.max_layer, Routing_per_Net: [] };
        for (const ns of c.customize ?? [])
          for (const net of ns.nets) r.Routing_per_Net.push({ net_min_layer: ns.min_layer, net_max_layer: ns.max_layer, net_name: net });
        node.Routing_Layers = r;
        break;
      }
      default: break;       // Ordering, AlignBlock, MatchBlock, PortLocation, CC, GuardRing ... 배치기 몫
    }
  }
}

/** _attach_constraint_files — bias 는 Design_info 의 Vspace/Hspace, compact_style, 그 다음 제약 파일 */
export function attachConstraints(hierTree, drc, pnrConst) {
  for (const node of hierTree) {
    node.bias_Vgraph = drc.Design_info.Vspace;
    node.bias_Hgraph = drc.Design_info.Hspace;
    node.compact_style = drc.Design_info.compact_style;
    const cj = pnrConst[node.name];
    if (cj) readConstraintJson(node, cj, { scaleFactor: drc.ScaleFactor });
  }
}

// ---------------------------------------------------------------- semantic0/1/2 (PnRdatabase.cpp:1533-1847)
const stem = (s) => {
  const slash = s.lastIndexOf("/");
  const start = slash >= 0 ? slash + 1 : 0;
  const dot = s.lastIndexOf(".");
  return s.substring(start, dot >= 0 ? dot : s.length);
};

/** MergeLEFMapData — 리프 블록은 gds 파일마다 변이 하나 (LEF 도형, 크기, 핀을 이름으로) */
function mergeLefMapData(node, gdsData2, lefData) {
  for (const bc of node.Blocks) {
    const atn = bc.instance[0].master;
    if (!(atn in gdsData2)) {
      if (atn.includes("Cap") || atn.includes("CAP") || atn.includes("cap") || !lastInst(bc).isLeaf) continue;
      gdsData2[atn] = [];     // std::map::operator[] 이 빈 목록을 넣는다
    }
    const files = gdsData2[atn];
    const base = bc.instance[0];
    bc.instance = files.map((_, j) => (j === 0 ? base : clone(base)));
    bc.instNum = files.length;
    files.forEach((file, j) => {
      const b = bc.instance[j];
      b.gdsFile = file;
      const lefs = lefData[stem(file)];
      if (!lefs) throw new Error(`No LEF file for ${stem(file)}`);
      const lef = lefs[0];
      b.interMetals = clone(lef.interMetals);
      b.interVias = clone(lef.interVias);
      b.width = lef.width;
      b.height = lef.height;
      b.lefmaster = lef.name;
      b.originBox = bbox(0, 0, lef.width, lef.height);
      b.originCenter = pt(Math.trunc(lef.width / 2), Math.trunc(lef.height / 2));
      for (const p of b.blockPins) {
        const m = lef.macroPins.find((q) => q.name === p.name);
        if (!m) continue;
        p.type = m.type;
        p.pinContacts = clone(m.pinContacts);
        p.pinVias = clone(m.pinVias);
        p.use = m.use;
      }
    });
  }
}

/** 부모/자식 연결, 최상위, 포트 넷의 단자 연결, 리프 표시, LEF 합치기. topidx 를 돌려준다. */
export function semantic0(hierTree, topcell, gdsData2, lefData) {
  let topidx = -1;
  for (const n of hierTree) for (const bc of n.Blocks) bc.child = -1;
  hierTree.forEach((ni, i) => {
    hierTree.forEach((nj, j) => {
      for (const bc of nj.Blocks) {
        if (lastInst(bc).master === ni.name) {
          bc.child = i;
          if (!ni.parent.includes(j)) ni.parent.push(j);
        }
      }
    });
    if (ni.name === topcell) { topidx = i; ni.isTop = true; }
    ni.Nets.forEach((net, l) => {
      ni.Terminals.forEach((t, m) => {
        if (net.name === t.name) {
          net.degree++;
          net.connected.push(connectNode(TERMINAL, m, -1));
          net.sink2Terminal = true;
          t.netIter = l;
        }
      });
    });
  });
  for (const n of hierTree) for (const bc of n.Blocks) lastInst(bc).isLeaf = bc.child === -1;
  for (const n of hierTree) mergeLefMapData(n, gdsData2, lefData);
  return topidx;
}

/** 전역 신호마다, 모듈마다: 이름이 맞는 넷을 PowerNets 로 옮긴다 (없으면 빈 PowerNet) */
export function semantic1(hierTree, globalSignals) {
  for (const [prefix, formal, actual] of globalSignals) {
    let power;
    if (formal === "supply0") power = false;
    else if (formal === "supply1") power = true;
    else throw new Error(`global signal ${actual}: ${formal}`);
    const full = prefix + "." + actual;
    for (const n of hierTree) {
      const keep = [];
      let found = false;
      for (const net of n.Nets) {
        if (net.name === full || net.name === actual) {
          found = true;
          const pn = newPowerNet(net.name, power);
          pn.connected = clone(net.connected);
          n.PowerNets.push(pn);
        } else keep.push(net);
      }
      if (!found) n.PowerNets.push(newPowerNet(actual, power));
      n.Nets = keep;
    }
  }
}

/** 핀·단자의 netIter 를 넷 번호로, 전원 핀은 -1 로 하고 PowerNets[].Pins 에 복사, 대칭 짝을 이름으로 다시 */
export function semantic2(hierTree, warnings = []) {
  for (const n of hierTree) {
    n.Nets.forEach((net, j) => {
      for (const c of net.connected) {
        if (c.type === BLOCK) for (const b of n.Blocks[c.iter2].instance) b.blockPins[c.iter].netIter = j;
        else n.Terminals[c.iter].netIter = j;
      }
    });
    for (const pn of n.PowerNets) {
      for (const c of pn.connected) {
        if (c.type === BLOCK) {
          for (const b of n.Blocks[c.iter2].instance) b.blockPins[c.iter].netIter = -1;
          pn.Pins.push(clone(lastInst(n.Blocks[c.iter2]).blockPins[c.iter]));
        } else {
          const t = n.Terminals[c.iter];
          t.netIter = -1;
          pn.Pins.push({ ...newPin(t.name), pinContacts: clone(t.termContacts) });
        }
      }
    }
    // "adjust symmetry net iter" — C++ 은 이 고리를 모듈마다 모든 모듈에 대해 돈다 (몇 번 돌아도 같다)
    for (const nn of hierTree) {
      for (const s of nn.SNets) {
        const i1 = nn.Nets.findIndex((x) => x.name === s.net1.name);
        const i2 = nn.Nets.findIndex((x) => x.name === s.net2.name);
        if (i1 < 0 || i2 < 0) {           // C++ 은 Nets[-1] 에 쓴다 (정의되지 않은 동작) — 건너뛰고 적는다
          warnings.push(`${nn.name}: 대칭 넷 ${s.net1.name}/${s.net2.name} 이 Nets 에 없다`);
          continue;
        }
        nn.Nets[i1].symCounterpart = i2;
        nn.Nets[i2].symCounterpart = i1;
      }
    }
  }
}

/**
 * PnRdatabase(...) — 입력 파일들에서 hierTree 까지.
 * @param {object} o
 * @param {object} o.drc          readPdkJson 결과
 * @param {string} o.lef          <TOP>.lef 글
 * @param {object} o.gdsData2     {concrete: [gds 경로]}
 * @param {object} o.verilog      abstract verilog (gen_abstract_verilog_d)
 * @param {object} o.pnrConst     {모듈: {constraints}}
 * @param {string} o.top
 * @returns {{drc, lefData, gdsData2, hierTree, topidx, globalSignals, warnings}}
 */
export function buildPnRDB({ drc, lef, gdsData2, verilog, pnrConst, top }) {
  const warnings = [];
  const lefData = readLef(lef, drc);
  const g2 = clone(gdsData2);
  const { hierTree, globalSignals } = readVerilogJson(verilog);
  attachConstraints(hierTree, drc, pnrConst);
  const topidx = semantic0(hierTree, top, g2, lefData);
  semantic1(hierTree, globalSignals);
  semantic2(hierTree, warnings);
  return { drc, lefData, gdsData2: g2, hierTree, topidx, globalSignals, warnings };
}
