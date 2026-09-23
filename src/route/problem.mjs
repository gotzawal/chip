/** 배선 문제 — 배치가 끝난 설계를 평평하게 펼쳐 배선기(symplace/router)에 넘길 모양으로.
 *
 *    flatten        계층을 펼친다: 리프 인스턴스마다 절대 변환과 경로 이름("XDP/X_M0"),
 *                   리프 핀마다 평평한 넷 이름. 이름 규칙은 ALIGN 이 계층 배선 끝에
 *                   최상위에서 쓰는 이름과 같다 (test/problem.mjs 가 대조한다):
 *                     포트에 물린 넷     부모 쪽 넷
 *                     전역 전원          그대로 (VDD, VSS ...)
 *                     모듈 안에서만 쓰는 넷  "<경로>/<넷>"
 *    buildProblem   펼친 리프 도형을 한데 모으고(compose.mjs) 검사기(check.mjs)로 합친다.
 *                   배선 전의 OPEN 이 곧 배선할 일이다: 넷마다 연결 덩이(component)들을
 *                   잇는다. 배선기에는 배선층(M1~M6, V1~V5)의 합친 도형과 규칙만 넘긴다.
 *
 *  좌표는 PDK 단위 정수. 트랙은 PDK 그대로: M1/M3 는 x = 80k, M2/M4 는 y = 84k ...
 */
import { check, checkerRules } from "./check.mjs";
import { composeModule, IDENTITY, trCompose, trRect } from "./compose.mjs";
import { unpackLeaf } from "./leaves.mjs";

export const PROBLEM_FORMAT = "route-problem/1";
const METALS = ["M1", "M2", "M3", "M4", "M5", "M6"];
const VIAS = ["V1", "V2", "V3", "V4", "V5"];
const isRouteLayer = (l) => METALS.includes(l) || VIAS.includes(l);

/** 아무 데도 인스턴스로 안 쓰이는 모듈이 최상위다. */
export function topModule(topology) {
  const used = new Set(topology.modules.flatMap((m) => m.instances.map((i) => i.abstract_template_name)));
  const tops = topology.modules.filter((m) => !used.has(m.name));
  if (tops.length !== 1) throw new Error(`최상위 모듈이 ${tops.length} 개다: ${tops.map((m) => m.name).join(", ")}`);
  return tops[0];
}

/**
 * @param {{topology:object}} design   data/<예제>.json (또는 앞단 출력)
 * @param {object} leaves              readLeaves() 결과 {concrete: 압축 항목}
 * @param {{instances:Array, subModules?:Array, bbox:number[]}} placement  페이지가 배선에 넘기는 배치
 */
export function flatten(design, leaves, placement) {
  const topo = design.topology;
  const mods = new Map(topo.modules.map((m) => [m.name, m]));
  const power = new Set((topo.global_signals ?? []).map((g) => g.actual));
  const top = topModule(topo);
  const subPl = new Map((placement.subModules ?? []).map((s) => [s.concrete, s]));
  const blocks = [], faMap = new Map(), boxes = new Map(), scopes = [];

  function walk(module, path, tr, instances, portMap) {
    const resolve = (n) => (portMap.has(n) ? portMap.get(n) : power.has(n) ? n : path ? `${path}/${n}` : n);
    scopes.push({ module, path, tr, resolve });
    const byName = new Map(module.instances.map((i) => [i.instance_name, i]));
    const seen = new Set();
    for (const q of instances) {
      const inst = byName.get(q.name);
      if (!inst) throw new Error(`${module.name} 에 인스턴스 ${q.name} 가 없다`);
      if (seen.has(q.name)) throw new Error(`${module.name}: 인스턴스 ${q.name} 가 두 번 배치됐다`);
      seen.add(q.name);
      const p = path ? `${path}/${q.name}` : q.name;
      const t = trCompose(tr, { oX: q.oX, oY: q.oY, sX: q.sX, sY: q.sY });
      if (mods.has(inst.abstract_template_name)) {
        const sm = subPl.get(q.concrete);
        if (!sm) throw new Error(`하위 모듈 배치가 없다: ${q.name} (${q.concrete})`);
        boxes.set(p, trRect(t, sm.bbox));
        const pm = new Map(inst.fa_map.map((c) => [c.formal, resolve(c.actual)]));
        walk(mods.get(inst.abstract_template_name), p, t, sm.instances, pm);
      } else {
        const e = leaves[q.concrete];
        if (!e) throw new Error(`리프 도형이 없다: ${q.concrete} (${p})`);
        const L = unpackLeaf(e);
        boxes.set(p, trRect(t, L.bbox));
        for (const c of inst.fa_map) faMap.set(`${p}/${c.formal}`, resolve(c.actual));
        blocks.push({ name: p, concrete: q.concrete, tr: t, terminals: L.terminals, subinsts: L.subinsts, bbox: trRect(t, L.bbox) });
      }
    }
    const missing = module.instances.filter((i) => !seen.has(i.instance_name));
    if (missing.length) throw new Error(`${module.name}: 배치 안 된 인스턴스 ${missing.map((i) => i.instance_name).join(", ")}`);
  }
  walk(top, "", IDENTITY, placement.instances, new Map());

  // 전원 넷: 전역 신호 + 최상위 PowerPorts / GroundPorts
  for (const c of top.constraints ?? [])
    if (c.constraint === "PowerPorts" || c.constraint === "GroundPorts") for (const p of c.ports ?? []) power.add(p);
  return { top: top.name, blocks, faMap, power, boxes, scopes };
}

/** 대칭 넷 — 모듈마다 SymmetricNets 를 평평한 넷 이름으로, 축은 같은 모듈의 SymmetricBlocks 에서. */
function symmetry(flat) {
  const out = [], warnings = [];
  for (const { module, path, resolve } of flat.scopes) {
    const cons = module.constraints ?? [];
    const axisOf = (dir) => {
      for (const c of cons.filter((k) => k.constraint === "SymmetricBlocks" && k.direction === dir)) {
        const axes = c.pairs.map((pr) => {
          const b = pr.map((n) => flat.boxes.get(path ? `${path}/${n}` : n));
          if (b.some((x) => !x)) return null;
          const k = dir === "V" ? 0 : 1;
          return pr.length === 2 ? (b[0][k] + b[0][k + 2] + b[1][k] + b[1][k + 2]) / 2 : b[0][k] + b[0][k + 2];
        }).filter((a) => a != null);
        if (axes.length) {
          if (axes.some((a) => a !== axes[0])) warnings.push(`${module.name}: SymmetricBlocks 축이 서로 다르다 ${axes.join(",")}`);
          return axes[0];
        }
      }
      return null;
    };
    for (const c of cons.filter((k) => k.constraint === "SymmetricNets")) {
      const axis2 = axisOf(c.direction);
      if (axis2 == null) { warnings.push(`${module.name}: ${c.net1}/${c.net2} 의 축을 모른다`); continue; }
      out.push({ net1: resolve(c.net1), net2: resolve(c.net2), dir: c.direction, axis2 });
    }
  }
  return { pairs: out, warnings };
}

/**
 * @param {object} o
 * @param {object} o.design, o.leaves, o.placement   flatten 과 같다
 * @param {object} o.pdk        MOCK_PDK
 * @param {number} [o.margin=4] 배치 bbox 밖으로 몇 트랙까지 배선하게 둘지
 * @returns {{problem:object, layout:{terminals, subinsts, bbox}, flat:object, pre:object}}
 *   problem 은 배선기 입력 (JSON 으로 넘긴다). layout 은 검사·GDS 에 쓸 리프 도형 전체.
 *   pre 는 배선 전 검사 결과 (SHORT·DRC 가 있으면 배치나 리프가 틀린 것이다).
 */
export function buildProblem({ design, leaves, placement, pdk, margin = 4 }) {
  const flat = flatten(design, leaves, placement);
  const comp = composeModule({ blocks: flat.blocks, faMap: flat.faMap, powerNets: flat.power });
  const rules = checkerRules(pdk);
  const pre = check(comp.terminals, rules, { subinsts: comp.subinsts });

  const L = new Map(pdk.Abstraction.map((x) => [x.Layer, x]));
  const layers = METALS.map((n) => {
    const x = L.get(n);
    return { name: n, dir: x.Direction.toLowerCase(), pitch: x.Pitch, offset: x.Offset, width: x.Width,
             minL: x.MinL, e2e: x.EndToEnd };
  });
  const vias = VIAS.map((n) => {
    const x = L.get(n);
    return { name: n, lower: x.Stack[0], upper: x.Stack[1], wx: x.WidthX, wy: x.WidthY,
             encL: x.VencA_L, encH: x.VencA_H, spaceX: x.SpaceX, spaceY: x.SpaceY };
  });

  // 넷과 연결 덩이
  const netIdx = new Map(), nets = [];
  const netOf = (name) => {
    if (name == null) return -1;
    if (!netIdx.has(name)) { netIdx.set(name, nets.length); nets.push({ name, power: flat.power.has(name), comps: new Set() }); }
    return netIdx.get(name);
  };
  const shapes = [];
  pre.terminals.forEach((t, k) => {
    if (!isRouteLayer(t.layer)) return;
    const n = netOf(t.netName), c = pre.components[k];
    if (n >= 0) nets[n].comps.add(c);
    shapes.push([t.layer, n, c, t.netType === "pin" ? 1 : 0, ...t.rect]);
  });

  const sym = symmetry(flat);
  const netsOut = nets.map((n) => ({ name: n.name, power: n.power, parts: n.comps.size, sym: -1, axis2: null, dir: null }));
  for (const s of sym.pairs) {
    const a = netIdx.get(s.net1), b = netIdx.get(s.net2);
    if (a == null || b == null) { sym.warnings.push(`대칭 넷 ${s.net1}/${s.net2} 의 도형이 없다`); continue; }
    Object.assign(netsOut[a], { sym: b, axis2: s.axis2, dir: s.dir });
    Object.assign(netsOut[b], { sym: a, axis2: s.axis2, dir: s.dir });
  }

  // 배선 영역: 배치 bbox 를 트랙 단위로 넓힌다
  const [bx0, by0, bx1, by1] = placement.bbox;
  const px = 80, py = 84;
  const area = [Math.floor(bx0 / px) * px - margin * px, Math.floor(by0 / py) * py - margin * py,
                Math.ceil(bx1 / px) * px + margin * px, Math.ceil(by1 / py) * py + margin * py];

  const problem = { format: PROBLEM_FORMAT, name: flat.top, bbox: placement.bbox.slice(), area, layers, vias,
                    nets: netsOut, shapes, warnings: sym.warnings };
  return { problem, layout: { terminals: comp.terminals, subinsts: comp.subinsts, bbox: placement.bbox.slice() }, flat, pre };
}

/** ALIGN 의 배치 결과(scaled_placement_verilog — data/<예제>.json 의 place)를 배선이 받는 배치 모양으로.
 *  예제 파일에 늘 들어 있으므로 캐시 없이 배선 경로를 시험할 수 있다. */
export function placementFromAlign(place) {
  const used = new Set(place.modules.flatMap((m) => m.instances.map((i) => i.concrete_template_name)));
  const tops = place.modules.filter((m) => !used.has(m.concrete_name));
  if (tops.length !== 1) throw new Error(`ALIGN 배치의 최상위가 ${tops.length} 개다`);
  const inst = (i) => ({ name: i.instance_name, concrete: i.concrete_template_name,
                         oX: i.transformation.oX, oY: i.transformation.oY, sX: i.transformation.sX, sY: i.transformation.sY });
  return {
    bbox: tops[0].bbox.slice(),
    instances: tops[0].instances.map(inst),
    subModules: place.modules.filter((m) => m !== tops[0]).map((m) => ({
      abstract: m.abstract_name, concrete: m.concrete_name, bbox: m.bbox.slice(), instances: m.instances.map(inst) })),
  };
}
