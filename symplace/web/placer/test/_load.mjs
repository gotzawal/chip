/** 앞단 출력 폴더(1_topology + 2_primitives 를 한데 모은 것)를 Design 으로 읽는다.
 *  node 전용(fs). 브라우저에서는 fetch 로 같은 JSON 셋을 모아 readDesign 에 준다.
 */
import fs from "node:fs";
import path from "node:path";
import { readDesign } from "../../../../src/design.mjs";

const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

export function loadDesign(dir) {
  const files = fs.readdirSync(dir);
  const vname = files.find((f) => f.endsWith(".verilog.json"));
  if (!vname) throw new Error(dir + ": *.verilog.json 이 없다");
  const topology = J(path.join(dir, vname));
  const primitives = J(path.join(dir, "__primitives__.json"));
  const templates = {};
  for (const c of Object.keys(primitives)) {
    const p = path.join(dir, c + ".json");
    if (fs.existsSync(p)) templates[c] = J(p);
  }
  return {
    topology, primitives, templates,
    design: readDesign({ topology, primitives, templates }),
    // ALIGN 배치 결과는 **대조용**이다. 배치에는 쓰지 않는다.
    place: files.includes("__align_place__.json")
      ? J(path.join(dir, "__align_place__.json")) : null,
  };
}

/** ALIGN 의 place 결과에서 기준선(면적, HPWL)을 직접 잰다.
 *
 *  고정값 파일(fixtures/*.json)에 기대지 않으려고 JS 로 다시 썼다.
 *  gpuplace/placement.py + netlist.py 와 같은 규칙:
 *    - 템플릿 bbox 는 leaves[] 에, 하위 모듈이면 modules[] 에 있다
 *    - 핀은 leaf 면 terminals[] 그대로, 모듈이면 그 안 인스턴스 핀들의 무게중심
 *    - 전원·접지 넷과 핀이 하나뿐인 넷은 뺀다
 */
export function alignBaseline(place, topName) {
  const leafBox = new Map(), leafTerm = new Map();
  for (const l of place.leaves ?? []) {
    leafBox.set(l.concrete_name, l.bbox);
    leafTerm.set(l.concrete_name, l.terminals ?? []);
  }
  const modByConcrete = new Map(place.modules.map((m) => [m.concrete_name, m]));
  const top = place.modules.find((m) => m.abstract_name === topName)
           ?? place.modules[place.modules.length - 1];

  const boxOf = (cn) => leafBox.get(cn) ?? modByConcrete.get(cn)?.bbox ?? null;

  const pinCache = new Map();
  const pinsOf = (cn) => {
    if (pinCache.has(cn)) return pinCache.get(cn);
    const out = new Map();
    pinCache.set(cn, out);                       // 재귀 중 무한루프 방지
    const bb = boxOf(cn);
    if (!bb) return out;
    const cx0 = (bb[0] + bb[2]) / 2, cy0 = (bb[1] + bb[3]) / 2;
    const terms = leafTerm.get(cn);
    if (terms && terms.length) {
      for (const t of terms) {
        const r = t.rect;
        out.set(t.name, [(r[0] + r[2]) / 2 - cx0, (r[1] + r[3]) / 2 - cy0]);
      }
      return out;
    }
    const m = modByConcrete.get(cn);
    if (!m) return out;
    const acc = new Map();
    for (const inst of m.instances ?? []) {
      const child = pinsOf(inst.concrete_template_name);
      const tb = boxOf(inst.concrete_template_name);
      if (!child.size || !tb) continue;
      const tr = inst.transformation;
      const ccx = tr.sX * (tb[0] + tb[2]) / 2 + tr.oX;
      const ccy = tr.sY * (tb[1] + tb[3]) / 2 + tr.oY;
      const fa = new Map((inst.fa_map ?? []).map((f) => [f.formal, f.actual]));
      for (const [formal, off] of child) {
        const net = fa.get(formal);
        if (net == null) continue;
        if (!acc.has(net)) acc.set(net, []);
        acc.get(net).push([ccx + tr.sX * off[0], ccy + tr.sY * off[1]]);
      }
    }
    for (const port of m.parameters ?? []) {
      const pts = acc.get(port);
      if (!pts?.length) continue;
      out.set(port, [pts.reduce((s, p) => s + p[0], 0) / pts.length - cx0,
                     pts.reduce((s, p) => s + p[1], 0) / pts.length - cy0]);
    }
    return out;
  };

  const skip = new Set(["0", "VDD", "GND", "VSS"]);
  for (const c of top.constraints ?? [])
    if (["PowerPorts", "GroundPorts", "ClockPorts"].includes(c.constraint))
      for (const p of c.ports ?? []) skip.add(String(p).toUpperCase());

  const nets = new Map();
  for (const inst of top.instances ?? []) {
    const tb = boxOf(inst.concrete_template_name);
    const pins = pinsOf(inst.concrete_template_name);
    if (!tb || !pins.size) continue;
    const tr = inst.transformation;
    const ccx = tr.sX * (tb[0] + tb[2]) / 2 + tr.oX;
    const ccy = tr.sY * (tb[1] + tb[3]) / 2 + tr.oY;
    const fa = new Map((inst.fa_map ?? []).map((f) => [f.formal, f.actual]));
    for (const [formal, off] of pins) {
      const net = fa.get(formal);
      if (net == null || skip.has(String(net).toUpperCase())) continue;
      if (!nets.has(net)) nets.set(net, []);
      nets.get(net).push([ccx + tr.sX * off[0], ccy + tr.sY * off[1]]);
    }
  }

  let hpwl = 0;
  for (const pts of nets.values()) {
    if (pts.length < 2) continue;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    hpwl += Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
  }
  const b = top.bbox;
  return { area: (b[2] - b[0]) * (b[3] - b[1]), hpwl, bbox: b, top };
}
