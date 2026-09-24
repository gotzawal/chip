/** 회로 — 회로도·묶음 보기가 그리는 자료.
 *
 *  두 길로 만든다.
 *    circuitFromSpice(parsed, top)   .sp 원문 그대로 — 트랜지스터 하나하나. 서브서킷 계층은 펼치되
 *                                    인스턴스는 모듈 묶음으로 남긴다 (XI1/M0 처럼 이름에 남는다)
 *    circuitFromTopology(blob)       앞단 출력(1_topology + 2_primitives) — 앞단이 묶은 대로. 잎 묶음
 *                                    (DP·SCM·CMC …)은 ALIGN 의 기본 템플릿(basic_template.sp)으로
 *                                    트랜지스터를 되살린다. 스택·병렬로 합쳐진 소자는 하나로 보인다
 *  둘 다 같은 모양의 회로를 낸다. layout.mjs 가 그것을 놓고 draw.mjs 가 그린다.
 *
 *  회로
 *    name, ports          최상위 이름과 핀
 *    devices[]            { id, name, kind, pins: [{name, net}], sub, group, short }
 *                         kind: nmos pmos res cap ind diode box
 *    nets: Map            이름 -> { name, port, role: 'vdd' | 'gnd' | null, pins: [{dev, pin}] }
 *    groups[]             { id, name, kind: 'module' | 'leaf', family, gloss, members, children, parent, depth, hull }
 *                         members 는 아래 계층까지 전부. hull 이면 그림에 테두리로 그린다
 *    mirrors[[a, b]]      거울상인 소자 쌍 (제약 SymmetricBlocks 에서)
 *    axis[]               대칭축 위에 놓이는 소자
 *    constraints          최상위 모듈의 제약 원문 (표에 쓴다)
 */
import { parseSpice, mosKind } from "./spice.mjs";

const up = (s) => String(s ?? "").toUpperCase();

// ---------------------------------------------------------------- ALIGN 기본 템플릿
//
// align/config/basic_template.sp 의 생성기(MOS · cap · res) 잎들. 앞단 출력의 잎
// 템플릿 이름은 이 이름 뒤에 해시가 붙은 것이다 (SCM_NMOS_59995622). 여기 없는 것
// (CASCODED_CMC, CMB, INV, PRIMITIVE …)은 앞단이 모듈로 내므로 그 안이 topology 에 있다.
const LIB_TEXT = `
.subckt NMOS_4T D G S B
M1 D G S B NMOS
.ends
.subckt PMOS_4T D G S B
M1 D G S B PMOS
.ends
.subckt CAP_2T PLUS MINUS
C1 PLUS MINUS 1f
.ends
.subckt RES_2T PLUS MINUS
R1 PLUS MINUS 10k
.ends
.subckt NMOS_S D G S
M1 D G S S NMOS
.ends
.subckt PMOS_S D G S
M1 D G S S PMOS
.ends
.subckt NMOS_G D G S
M1 D G S G NMOS
.ends
.subckt PMOS_G D G S
M1 D G S G PMOS
.ends
.subckt DUMMY_NMOS_S D S
M1 D S S S NMOS
.ends
.subckt DUMMY_PMOS_S D S
M1 D S S S PMOS
.ends
.subckt DCAP_NMOS_B G S B
M1 S G S B NMOS
.ends
.subckt DCAP_PMOS_B G S B
M1 S G S B PMOS
.ends
.subckt DCAP_NMOS G S
M1 S G S S NMOS
.ends
.subckt DCAP_PMOS G S
M1 S G S S PMOS
.ends
.subckt DCL_NMOS D S B
M1 D D S B NMOS
.ends
.subckt DCL_PMOS D S B
M1 D D S B PMOS
.ends
.subckt DCL_NMOS_S D S
M1 D D S S NMOS
.ends
.subckt DCL_PMOS_S D S
M1 D D S S PMOS
.ends
.subckt DUMMY_NMOS D S B
M1 D S S B NMOS
.ends
.subckt DUMMY_PMOS D S B
M1 D S S B PMOS
.ends
.subckt DUMMY1_NMOS S B
M1 S S S B NMOS
.ends
.subckt DUMMY1_PMOS S B
M1 S S S B PMOS
.ends
.subckt DUMMY1_NMOS_S S
M1 S S S S NMOS
.ends
.subckt DUMMY1_PMOS_S S
M1 S S S S PMOS
.ends
.subckt SCM_NMOS_B DA DB S B
M1 DA DA S B NMOS
M2 DB DA S B NMOS
.ends
.subckt SCM_PMOS_B DA DB S B
M1 DA DA S B PMOS
M2 DB DA S B PMOS
.ends
.subckt SCM_NMOS DA DB S
M1 DA DA S S NMOS
M2 DB DA S S NMOS
.ends
.subckt SCM_PMOS DA DB S
M1 DA DA S S PMOS
M2 DB DA S S PMOS
.ends
.subckt CMC_S_NMOS_B DA DB SA SB G B
M1 DA G SA B NMOS
M2 DB G SB B NMOS
.ends
.subckt CMC_S_NMOS DA DB SA SB G
M1 DA G SA SA NMOS
M2 DB G SB SB NMOS
.ends
.subckt CMC_S_PMOS_B DA DB SA SB G B
M1 DA G SA B PMOS
M2 DB G SB B PMOS
.ends
.subckt CMC_NMOS DA DB G S
M1 DA G S S NMOS
M2 DB G S S NMOS
.ends
.subckt CMC_PMOS DA DB G S
M1 DA G S S PMOS
M2 DB G S S PMOS
.ends
.subckt CMC_NMOS_B DA DB G S B
M1 DA G S B NMOS
M2 DB G S B NMOS
.ends
.subckt CMC_S_PMOS DA DB G SA SB
M1 DA G SA SA PMOS
M2 DB G SB SB PMOS
.ends
.subckt DP_NMOS_B DA DB GA GB S B
M1 DA GA S B NMOS
M2 DB GB S B NMOS
.ends
.subckt DP_PMOS_B DA DB GA GB S B
M1 DA GA S B PMOS
M2 DB GB S B PMOS
.ends
.subckt DP_NMOS DA DB GA GB S
M1 DA GA S S NMOS
M2 DB GB S S NMOS
.ends
.subckt DP_PMOS DA DB GA GB S
M1 DA GA S S PMOS
M2 DB GB S S PMOS
.ends
.subckt CCP_S_NMOS_B DA DB SA SB B
M1 DA DB SA B NMOS
M2 DB DA SB B NMOS
.ends
.subckt CCP_S_PMOS_B DA DB SA SB B
M1 DA DB SA B PMOS
M2 DB DA SB B PMOS
.ends
.subckt CCP_NMOS DA DB S
M1 DA DB S S NMOS
M2 DB DA S S NMOS
.ends
.subckt CCP_PMOS DA DB S
M1 DA DB S S PMOS
M2 DB DA S S PMOS
.ends
.subckt CCP_NMOS_B DA DB S B
M1 DA DB S B NMOS
M2 DB DA S B NMOS
.ends
.subckt CCP_PMOS_B DA DB S B
M1 DA DB S B PMOS
M2 DB DA S B PMOS
.ends
.subckt LS_S_NMOS_B DA DB SA SB B
M1 DA DA SA B NMOS
M2 DB DA SB B NMOS
.ends
.subckt LS_S_PMOS_B DA DB SA SB B
M1 DA DA SA B PMOS
M2 DB DA SB B PMOS
.ends
`;
export const LIB = parseSpice(LIB_TEXT);

// PDK 쪽 템플릿(align/pdk/finfet/basic_template.sp)의 이름 — 같은 내용이다
const ALIAS = {
  NMOS_3T: "NMOS_S", PMOS_3T: "PMOS_S", NMOS_GB: "NMOS_G", PMOS_GB: "PMOS_G",
  DCAP_NMOS_3T: "DCAP_NMOS_B", DCAP_PMOS_3T: "DCAP_PMOS_B",
  DCL_NMOS_3T: "DCL_NMOS", DCL_PMOS_3T: "DCL_PMOS", DCL_NMOS_2T: "DCL_NMOS_S", DCL_PMOS_2T: "DCL_PMOS_S",
  DUMMY_NMOS_2T: "DUMMY_NMOS_S", DUMMY_PMOS_2T: "DUMMY_PMOS_S", DUMMY_NMOS_3T: "DUMMY_NMOS", DUMMY_PMOS_3T: "DUMMY_PMOS",
  DUMMY_FULL_NMOS: "DUMMY1_NMOS_S", DUMMY_FULL_PMOS: "DUMMY1_PMOS_S",
  DUMMY_FULL_NMOS_2T: "DUMMY1_NMOS", DUMMY_FULL_PMOS_2T: "DUMMY1_PMOS",
};

/** 템플릿 이름에서 해시를 뗀 묶음 종류: SCM_NMOS_59995622 -> SCM_NMOS. */
export function familyOf(abstract) {
  return up(abstract).replace(/_\d{4,}$/, "");
}
/** 기본 템플릿 라이브러리의 정의 (없으면 null). */
export function libOf(abstract) {
  const f = familyOf(abstract);
  return LIB.subckts.get(ALIAS[f] ?? f) ?? null;
}

// 묶음 종류를 우리말로. 긴 이름을 먼저 본다 (CMC_S 가 CMC 보다 먼저).
const GLOSS = [
  ["CASCODED_CMC", "캐스코드 전류 거울"], ["CASCODED_SCM", "캐스코드 전류 거울"],
  ["CASCODED_CMB", "캐스코드 전류 거울 뱅크"], ["DP_PAIR", "차동쌍 둘"], ["DP", "차동쌍"],
  ["SCM", "전류 거울"], ["CMC_S", "공통 게이트 쌍"], ["CMC", "공통 게이트 쌍"],
  ["CCP_S", "교차 결합 쌍"], ["CCP", "교차 결합 쌍"], ["LS_S", "레벨 시프터"], ["LSB", "레벨 시프터 뱅크"],
  ["CMB", "전류 거울 뱅크"], ["DCL", "다이오드 연결"], ["DCAP", "MOS 커패시터"],
  ["DUMMY1", "더미"], ["DUMMY", "더미"], ["NMOS", "NMOS 하나"], ["PMOS", "PMOS 하나"],
  ["CAP_2T", "커패시터"], ["RES_2T", "저항"], ["INV", "인버터"], ["STAGE2_INV", "인버터 둘"],
  ["TGATE", "전송 게이트"], ["PRIMITIVE", "사용자 묶음"], ["ARRAY_HIER", "배열"], ["ARRAY_TEMPLATE", "배열 원소"],
];
export function glossOf(family) {
  const f = up(family);
  for (const [k, g] of GLOSS) if (f === k || f.startsWith(k + "_")) return g;
  return "";
}

// ---------------------------------------------------------------- 회로 만들기 (공통)
function newCircuit(name, ports) {
  return { name, ports: ports.map(up), devices: [], nets: new Map(), groups: [],
           mirrors: [], axis: [], constraints: [] };
}
function addGroup(c, g) {
  const id = c.groups.length;
  const rec = { id, name: g.name, kind: g.kind, family: g.family ?? "", gloss: g.gloss ?? "",
                members: [], children: [], parent: g.parent ?? null, depth: g.depth ?? 0,
                hull: !!g.hull, abstract: g.abstract ?? null };
  c.groups.push(rec);
  if (rec.parent != null) c.groups[rec.parent].children.push(id);
  return rec;
}
function addDevice(c, d) {
  const id = c.devices.length;
  const rec = { id, name: d.name, kind: d.kind, pins: d.pins, sub: d.sub ?? "", group: d.group ?? null,
                short: d.short ?? null, model: d.model ?? "" };
  c.devices.push(rec);
  for (let g = rec.group; g != null; g = c.groups[g].parent) c.groups[g].members.push(id);
  return rec;
}
/** 소자의 핀에서 넷 표를 만든다. */
function finish(c, hints) {
  const ports = new Set(c.ports);
  for (const d of c.devices)
    for (const p of d.pins) {
      if (p.net == null) continue;
      let n = c.nets.get(p.net);
      if (!n) { n = { name: p.net, port: ports.has(p.net), role: null, pins: [] }; c.nets.set(p.net, n); }
      n.pins.push({ dev: d.id, pin: p.name });
    }
  for (const p of c.ports)
    if (!c.nets.has(p)) c.nets.set(p, { name: p, port: true, role: null, pins: [] });
  assignRoles(c, hints);
  return c;
}

// 이름으로 짐작하는 것은 제약이 그 역할을 아무것도 안 줄 때만.
const VDD_RE = /^(VDD|VCC|VPS|VPWR|AVDD|DVDD|VDDA|VDDD|VCCA|VCCD)/;
const GND_RE = /^(VSS|GND|VGND|VEE|AVSS|DVSS|VSSA|VSSD|VNEG)/;
export function assignRoles(c, hints) {
  const vdd = new Set((hints?.vdd ?? []).map(up)), gnd = new Set((hints?.gnd ?? []).map(up));
  for (const n of c.nets.values()) {
    if (vdd.has(n.name)) n.role = "vdd";
    else if (gnd.has(n.name) || n.name === "0") n.role = "gnd";
  }
  for (const n of c.nets.values()) {
    if (n.role || !n.port) continue;
    if (!vdd.size && VDD_RE.test(n.name)) n.role = "vdd";
    else if (!gnd.size && GND_RE.test(n.name)) n.role = "gnd";
  }
}

/** 앞단 출력에서 전원·접지 이름: PowerPorts / GroundPorts 제약과 global_signals. */
export function supplyHints(blob) {
  const vdd = new Set(), gnd = new Set();
  const topo = blob?.topology ?? {};
  for (const m of topo.modules ?? [])
    for (const k of m.constraints ?? []) {
      if (k.constraint === "PowerPorts") for (const p of k.ports ?? []) vdd.add(up(p));
      if (k.constraint === "GroundPorts") for (const p of k.ports ?? []) gnd.add(up(p));
    }
  for (const g of topo.global_signals ?? []) {
    if (/supply0|gnd|vss/i.test(g.formal ?? "")) gnd.add(up(g.actual));
    else if (/supply1|vdd|vcc/i.test(g.formal ?? "")) vdd.add(up(g.actual));
  }
  return { vdd: [...vdd], gnd: [...gnd] };
}

const TWO = { R: "res", C: "cap", L: "ind", D: "diode" };
const mosPins = (n) => [{ name: "D", net: n[0] }, { name: "G", net: n[1] }, { name: "S", net: n[2] }, { name: "B", net: n[3] ?? n[2] }];
const twoPins = (n) => [{ name: "P", net: n[0] }, { name: "N", net: n[1] }];

/** 소자 밑에 적을 파라미터 — 짧게. */
function mosSub(p) {
  const out = [];
  if (p.nfin != null) out.push("nfin=" + p.nfin);
  if (p.nf != null) out.push("nf=" + p.nf);
  if (p.m != null && p.m !== "1") out.push("m=" + p.m);
  if (!out.length) {
    if (p.w != null) out.push("w=" + p.w);
    if (p.l != null) out.push("l=" + p.l);
  }
  return out.join(" ");
}
function valueSub(d) {
  const p = d.params;
  for (const k of ["r", "c", "l"]) if (p[k] != null) return k + "=" + p[k];
  if (d.model && !/^(resistor|capacitor|inductor|diode)$/i.test(d.model)) return d.model;
  const out = [];
  if (p.w != null) out.push("w=" + p.w);
  if (p.l != null) out.push("l=" + p.l);
  return out.join(" ");
}

// ---------------------------------------------------------------- .sp 에서
/** 넷리스트를 최상위 서브서킷부터 펼친 회로. hints: { vdd: [], gnd: [] } (앞단 출력의 전원 이름). */
export function circuitFromSpice(parsed, topName = null, opts = {}) {
  const hints = opts.hints ?? { vdd: [], gnd: [] };
  let top = (topName && parsed.subckts.get(up(topName))) || (parsed.top && parsed.subckts.get(parsed.top)) || null;
  if (!top && parsed.loose.length) top = { name: "TOP", ports: [], devices: parsed.loose };
  const c = newCircuit(top?.name ?? "TOP", top?.ports ?? []);
  const globalNames = new Set([...parsed.globals, ...hints.vdd.map(up), ...hints.gnd.map(up), "0"]);
  const walk = (sc, prefix, map, gid, depth) => {
    for (const d of sc.devices) {
      const nets = d.nets.map((n) => map.get(n) ?? (globalNames.has(n) ? n : prefix + n));
      if (d.type === "X") {
        const child = parsed.subckts.get(d.model);
        if (child && child !== sc && depth < 16) {
          const g = addGroup(c, { name: prefix + d.name, kind: "module", family: child.name,
                                  gloss: glossOf(child.name), parent: gid, depth, hull: true, abstract: child.name });
          const m = new Map();
          child.ports.forEach((p, i) => m.set(p, nets[i] ?? prefix + d.name + "/" + p));
          walk(child, prefix + d.name + "/", m, g.id, depth + 1);
        } else {
          addDevice(c, { name: prefix + d.name, kind: "box", model: d.model, sub: d.model, group: gid,
                         pins: nets.map((n, i) => ({ name: "P" + i, net: n })) });
        }
        continue;
      }
      if (d.type === "M") {
        addDevice(c, { name: prefix + d.name, kind: mosKind(d.model, parsed.models), model: d.model,
                       pins: mosPins(nets), sub: mosSub(d.params), group: gid });
      } else if (TWO[d.type]) {
        addDevice(c, { name: prefix + d.name, kind: TWO[d.type], model: d.model,
                       pins: twoPins(nets), sub: valueSub(d), group: gid });
      } else if (d.type === "Q") {
        addDevice(c, { name: prefix + d.name, kind: "box", model: d.model, sub: d.model, group: gid,
                       pins: ["C", "B", "E", "S"].slice(0, nets.length).map((p, i) => ({ name: p, net: nets[i] })) });
      }
    }
  };
  if (top) walk(top, "", new Map(top.ports.map((p) => [p, p])), null, 0);
  return finish(c, hints);
}

// ---------------------------------------------------------------- 앞단 출력에서
/** 아무도 인스턴스로 쓰지 않는 모듈이 top 이다 (src/design.mjs 의 topIndex 와 같은 규칙). */
export function topModule(topology) {
  const mods = topology?.modules ?? [];
  const used = new Set();
  for (const m of mods) for (const i of m.instances ?? []) used.add(i.abstract_template_name);
  for (let k = mods.length - 1; k >= 0; k--) if (!used.has(mods[k].name)) return mods[k];
  return mods[mods.length - 1] ?? null;
}

/** X_M3_M4 -> [M3, M4] (수가 맞을 때만). 아니면 라이브러리 이름(M1, M2)을 쓴다. */
function memberNames(instName, lib) {
  const parts = up(instName).replace(/^X_?/, "").split("_").filter(Boolean);
  if (parts.length === lib.devices.length && lib.devices.length > 1) return parts;
  return lib.devices.map((d) => d.name);
}
function topoSub(prm, ld, entry) {
  if (ld.type !== "M") {
    const v = entry?.value;
    return Array.isArray(v) ? v.join(" · ") : v != null ? String(v) : "";
  }
  if (!prm) return "";
  const out = [];
  if (prm.NFIN != null) out.push("nfin=" + prm.NFIN);
  if (prm.NF != null) out.push("nf=" + prm.NF);
  if (prm.M != null && String(prm.M) !== "1") out.push("m=" + prm.M);
  if (prm.STACK != null && String(prm.STACK) !== "1") out.push("stack " + prm.STACK);
  if (prm.PARALLEL != null && String(prm.PARALLEL) !== "1") out.push("par " + prm.PARALLEL);
  if (!out.length && prm.W != null) out.push("w=" + prm.W, "l=" + prm.L);
  return out.join(" ");
}

/** 앞단 출력 -> 회로. 최상위 모듈(또는 want)을 계층까지 펼친다. */
export function circuitFromTopology(blob, want = null) {
  const topo = blob?.topology ?? {};
  const mods = topo.modules ?? [];
  const byName = new Map(mods.map((m) => [m.name, m]));
  const topMod = (want && byName.get(up(want))) || topModule(topo);
  if (!topMod) throw new Error("앞단 출력에 모듈이 없습니다");
  const c = newCircuit(topMod.name, topMod.parameters ?? []);
  c.constraints = topMod.constraints ?? [];
  const hints = supplyHints(blob);
  const globalNames = new Set([...hints.vdd, ...hints.gnd, "0"]);
  const prims = blob?.primitives ?? {};
  const entryCache = new Map();
  const entryOf = (abstract) => {
    if (!entryCache.has(abstract)) {
      let e = null;
      for (const v of Object.values(prims)) if (v?.abstract_template_name === abstract) { e = v; break; }
      entryCache.set(abstract, e);
    }
    return entryCache.get(abstract);
  };

  const walk = (mod, prefix, map, gid, depth) => {
    for (const inst of mod.instances ?? []) {
      const fa = new Map((inst.fa_map ?? []).map((f) => [up(f.formal), up(f.actual)]));
      const res = (actual) =>
        actual == null ? null : (map.get(actual) ?? (globalNames.has(actual) ? actual : prefix + actual));
      const iname = prefix + up(inst.instance_name);
      const abstract = inst.abstract_template_name;
      const sub = byName.get(abstract);
      if (sub) {
        const g = addGroup(c, { name: iname, kind: "module", family: familyOf(sub.name), gloss: glossOf(familyOf(sub.name)),
                                parent: gid, depth, hull: true, abstract: sub.name });
        const m = new Map();
        for (const p of sub.parameters ?? []) m.set(up(p), res(fa.get(up(p))) ?? iname + "/" + up(p));
        walk(sub, iname + "/", m, g.id, depth + 1);
        continue;
      }
      const family = familyOf(abstract);
      const lib = libOf(abstract);
      const entry = entryOf(abstract);
      if (lib) {
        const g = addGroup(c, { name: iname, kind: "leaf", family, gloss: glossOf(family), parent: gid, depth,
                                hull: lib.devices.length > 1, abstract });
        const names = memberNames(inst.instance_name, lib);
        lib.devices.forEach((ld, k) => {
          const net = (n) => res(fa.get(n)) ?? (fa.has(n) ? res(fa.get(n)) : iname + "/" + n);
          const nets = ld.nets.map(net);
          const prm = entry?.parameters?.[ld.name] ?? entry?.parameters?.[names[k]] ?? null;
          const one = lib.devices.length === 1;
          const short = one ? up(inst.instance_name) : names[k];
          if (ld.type === "M") {
            const model = entry?.parameters?.model ?? ld.model;
            addDevice(c, { name: one ? iname : iname + "/" + names[k], kind: mosKind(model, LIB.models),
                           model, pins: mosPins(nets), sub: topoSub(prm, ld, entry), group: g.id, short });
          } else {
            addDevice(c, { name: one ? iname : iname + "/" + names[k], kind: TWO[ld.type], model: ld.model,
                           pins: twoPins(nets), sub: topoSub(prm, ld, entry), group: g.id, short });
          }
        });
        continue;
      }
      // 라이브러리에 없는 잎 — 핀만 아는 상자
      const g = addGroup(c, { name: iname, kind: "leaf", family, gloss: glossOf(family), parent: gid, depth, hull: false, abstract });
      addDevice(c, { name: iname, kind: "box", model: abstract, sub: family, group: g.id,
                     pins: [...fa].map(([f, a]) => ({ name: f, net: res(a) })) });
    }
  };
  walk(topMod, "", new Map((topMod.parameters ?? []).map((p) => [up(p), up(p)])), null, 0);
  finish(c, hints);
  symmetryFromConstraints(c, byName, topMod);
  return c;
}

/** SymmetricBlocks 제약 -> 거울 쌍과 축 위 소자.
 *  쌍 [a, b] 는 두 묶음의 소자를 순서대로 짝짓는다 (같은 템플릿이라 순서가 같다).
 *  홑 [a] 는 축 위 — 잎이면 M1·M2 가 서로 거울이고, 모듈이면 그 모듈의 제약을 다시 본다.
 *  제약이 없는 축 위 모듈은 자식이 둘이면 그 둘을 거울로 둔다 (GroupBlocks 로 만든 차동쌍이 그렇다). */
function symmetryFromConstraints(c, byName, topMod) {
  const gByName = new Map(c.groups.map((g) => [g.name, g]));
  const seen = new Set();
  const mirror = (a, b) => {
    const k = Math.min(a, b) + ":" + Math.max(a, b);
    if (a === b || seen.has(k)) return;
    seen.add(k);
    c.mirrors.push([a, b]);
  };
  const pairDevs = (A, B) => {
    const n = Math.min(A.length, B.length);
    for (let k = 0; k < n; k++) mirror(A[k], B[k]);
  };
  const selfSym = (g) => {
    if (g.kind === "module") { visit(byName.get(g.abstract), g.name + "/"); return; }
    const d = g.members;
    if (d.length === 1) { if (!c.axis.includes(d[0])) c.axis.push(d[0]); }
    else for (let k = 0; k + 1 < d.length; k += 2) mirror(d[k], d[k + 1]);
  };
  const visit = (mod, prefix) => {
    if (!mod) return;
    const syms = (mod.constraints ?? []).filter((k) => k.constraint === "SymmetricBlocks");
    for (const k of syms)
      for (const pair of k.pairs ?? []) {
        const gs = pair.map((n) => gByName.get(prefix + up(n))).filter(Boolean);
        if (gs.length >= 2) pairDevs(gs[0].members, gs[1].members);
        else if (gs.length === 1) selfSym(gs[0]);
      }
    if (!syms.length) {
      // 제약이 없는 축 위의 모듈: 자식이 둘이면 거울, 하나면 그 안으로 (최상위가 모듈 하나를 감싼 것도 그렇다)
      const kids = (mod.instances ?? []).map((i) => gByName.get(prefix + up(i.instance_name))).filter(Boolean);
      if (kids.length === 2 && prefix) pairDevs(kids[0].members, kids[1].members);
      else if (kids.length === 1 && (prefix || kids[0].kind === "module")) selfSym(kids[0]);
    }
  };
  visit(topMod, "");
}

// ---------------------------------------------------------------- .sp 소자 <-> 앞단 잎 맞추기
//
// 앞단은 소자를 합친다 — 직렬 스택은 하나로(STACK), 같은 소자 여럿은 하나로(PARALLEL). 그래서 잎의
// 트랜지스터 하나가 .sp 의 여러 소자에 해당할 수 있다. 연결(종류·D·G·S)로 맞추고, 못 맞추면
// 같은 게이트로 D 에서 S 까지 이어지는 직렬 사슬을 찾는다. 앞단이 만든 모듈 안의 넷
// (X_MN1_MN2_MP1_MP2/VM 같은)은 .sp 에 없는 이름이라 **자리 표시**로 두고, 맞는 소자가 나오면
// 그 넷을 .sp 의 넷에 묶어 다음 소자부터 쓴다. 맞춘 결과로 .sp 회로에 앞단의 묶음·거울 쌍을
// 옮겨 심는다 — 회로도 보기가 묶음 보기와 같은 대칭 배열을 쓰게 된다.
const isMos = (d) => d.kind === "nmos" || d.kind === "pmos";
const pinNet = (d, name) => d.pins.find((p) => p.name === name)?.net ?? null;

export function adoptGroups(sp, topo) {
  // 넷의 채널 핀 (D/S, P/N) — 직렬 사슬의 중간 넷은 채널 핀이 정확히 둘이다
  const chan = new Map();
  for (const d of sp.devices) {
    if (d.kind === "box") continue;
    for (const p of d.pins) {
      if (p.name === "G" || p.name === "B") continue;
      (chan.get(p.net) ?? chan.set(p.net, []).get(p.net)).push({ dev: d.id, pin: p.name });
    }
  }
  const taken = new Set();
  const bind = new Map();                       // 앞단 모듈 안의 넷 -> .sp 의 넷
  // .sp 에 같은 이름이 있으면 그 넷이다 (사용자 계층은 양쪽이 같은 이름 XI1/NET1 을 쓴다).
  // 없으면 앞단이 만든 모듈 안의 넷 — 자리 표시.
  const known = (n) => (n == null ? null : sp.nets.has(n) ? n : (bind.get(n) ?? null));
  const internal = (n) => n != null && !sp.nets.has(n) && !bind.has(n);
  const ends = (d) => (isMos(d) ? [pinNet(d, "D"), pinNet(d, "S"), pinNet(d, "G")] : [pinNet(d, "P"), pinNet(d, "N"), null]);

  /** 직렬 사슬: 아는 끝에서 같은 게이트로 다른 끝까지. 다른 끝이 자리 표시면 사슬이 끝나는
   *  넷(채널 핀이 둘이 아닌 곳)에 묶는다. */
  const stack = (t) => {
    const raw = ends(t);
    const [D, S, G] = raw.map(known);
    if (isMos(t) && G == null) return null;
    if (D == null && S == null) return null;
    if (D != null && S != null && D === S) return null;
    const from = D ?? S, to = D != null ? S : D;
    const wild = D == null ? raw[0] : S == null ? raw[1] : null;
    const go = (net, path, depth) => {
      if (depth > 8) return null;
      for (const { dev, pin } of chan.get(net) ?? []) {
        const d = sp.devices[dev];
        if (taken.has(dev) || path.includes(dev) || d.kind !== t.kind) continue;
        if (isMos(t) && pinNet(d, "G") !== G) continue;
        const [a, b] = ends(d);
        const other = (pin === "D" || pin === "P") ? b : a;
        if (to != null) {
          if (other === to && path.length) return { chain: [...path, dev] };
          if (other === to) continue;
          if ((chan.get(other) ?? []).length !== 2) continue;
          const r = go(other, [...path, dev], depth + 1);
          if (r) return r;
        } else {
          // 끝을 모른다: 채널 핀이 둘인 넷을 따라 갈 수 있는 데까지
          if ((chan.get(other) ?? []).length === 2 && !sp.nets.get(other)?.role) {
            const r = go(other, [...path, dev], depth + 1);
            if (r) return r;
          }
          if (path.length) return { chain: [...path, dev], end: other };
        }
      }
      return null;
    };
    const r = go(from, [], 0);
    if (r && wild && r.end != null) bind.set(wild, r.end);
    return r?.chain ?? null;
  };
  /** 아는 넷은 같고 자리 표시는 아무 넷이나 되는 후보들. 자리 표시가 어디에 묶이는지도 돌려준다. */
  const candidates = (t) => {
    const [D, S, G] = ends(t);
    const want = [known(D), known(S), known(G)];
    const out = [];
    for (const d of sp.devices) {
      if (taken.has(d.id) || d.kind !== t.kind) continue;
      const [a, b, g] = ends(d);
      for (const [x, y] of a === b ? [[a, b]] : [[a, b], [b, a]]) {
        const got = [x, y, g];
        let ok = true;
        const binds = [];
        for (let k = 0; k < 3; k++) {
          const w = [D, S, G][k];
          if (w == null && got[k] == null) continue;
          if (want[k] != null) { if (want[k] !== got[k]) { ok = false; break; } }
          else if (internal(w)) binds.push([w, got[k]]);
          else { ok = false; break; }
        }
        if (!ok) continue;
        // 한 소자 안에서 같은 자리 표시는 같은 넷이어야 한다
        const m = new Map();
        for (const [w, g2] of binds) { if (m.has(w) && m.get(w) !== g2) { ok = false; break; } m.set(w, g2); }
        if (!ok) continue;
        out.push({ id: d.id, key: [...m].sort().map((e) => e.join("=")).join(","), binds: m });
        break;
      }
    }
    return out;
  };

  const match = new Map();
  const pending = topo.devices.filter((t) => t.kind !== "box");
  for (let pass = 0; pass < 8 && pending.length; pass++) {
    // 같은 연결의 잎이 여럿이면 (배열의 원소들) 후보를 하나씩만 가져간다
    const dup = new Map();
    for (const t of pending) { const k = t.kind + "|" + ends(t).map(known).join("|"); dup.set(k, (dup.get(k) ?? 0) + 1); }
    let progress = false;
    for (const t of pending.slice()) {
      let cs = candidates(t);
      let ids = [];
      if (cs.length) {
        const groups = new Map();
        for (const c of cs) (groups.get(c.key) ?? groups.set(c.key, []).get(c.key)).push(c);
        if (groups.size > 1 && pass < 7) continue;        // 자리 표시가 여러 넷에 묶일 수 있다 — 다른 소자가 먼저 정해 주길 기다린다
        const pick = [...groups.values()][0];
        const sig = t.kind + "|" + ends(t).map(known).join("|");
        ids = (dup.get(sig) ?? 1) > 1 ? [pick[0].id] : pick.map((c) => c.id);
        for (const [w, g] of pick[0].binds) bind.set(w, g);
      } else {
        for (let chain; (chain = stack(t));) { ids.push(...chain); chain.forEach((id) => taken.add(id)); }
      }
      if (!ids.length) continue;
      for (const id of ids) taken.add(id);
      match.set(t.id, ids);
      pending.splice(pending.indexOf(t), 1);
      progress = true;
    }
    if (!progress && pass >= 7) break;
  }
  // 묶음을 옮긴다 — 그리지는 않고(hull=false) 배열의 힌트로만 쓴다
  const idMap = new Map();
  for (const g of topo.groups) {
    const members = [...new Set(g.members.flatMap((m) => match.get(m) ?? []))];
    if (!members.length) continue;
    const ng = { id: sp.groups.length, name: g.name, kind: g.kind, family: g.family, gloss: g.gloss,
                 members, children: [], parent: g.parent != null ? (idMap.get(g.parent) ?? null) : null,
                 depth: g.depth, hull: false, abstract: g.abstract, adopted: true };
    sp.groups.push(ng);
    idMap.set(g.id, ng.id);
    if (ng.parent != null) sp.groups[ng.parent].children.push(ng.id);
  }
  const byName = (ids) => ids.slice().sort((a, b) => sp.devices[a].name.localeCompare(sp.devices[b].name));
  const seen = new Set(sp.mirrors.map(([a, b]) => Math.min(a, b) + ":" + Math.max(a, b)));
  for (const [a, b] of topo.mirrors) {
    const A = byName(match.get(a) ?? []), B = byName(match.get(b) ?? []);
    const n = Math.min(A.length, B.length);
    for (let k = 0; k < n; k++) {
      const key = Math.min(A[k], B[k]) + ":" + Math.max(A[k], B[k]);
      if (A[k] === B[k] || seen.has(key)) continue;
      seen.add(key);
      sp.mirrors.push([A[k], B[k]]);
    }
  }
  for (const a of topo.axis) for (const id of match.get(a) ?? []) if (!sp.axis.includes(id)) sp.axis.push(id);
  sp.constraints = topo.constraints;
  return { matched: match.size, total: topo.devices.filter((d) => d.kind !== "box").length,
           unmatched: sp.devices.filter((d) => d.kind !== "box" && !taken.has(d.id)).length };
}

// ---------------------------------------------------------------- 표에 쓸 것
/** 최상위 모듈의 블록 하나하나: 이름 · 종류 · 소자 · variant 후보 · 제약. */
export function describeBlocks(blob, circuit) {
  const topo = blob?.topology ?? {};
  const topMod = topModule(topo);
  if (!topMod) return [];
  const mods = new Set((topo.modules ?? []).map((m) => m.name));
  const prims = blob?.primitives ?? {};
  const templates = blob?.templates ?? {};
  const sym = new Map();     // 인스턴스 -> "축" | 짝 이름
  const order = new Map(), align = new Map();
  for (const k of topMod.constraints ?? []) {
    if (k.constraint === "SymmetricBlocks")
      for (const pair of k.pairs ?? []) {
        if (pair.length === 1) sym.set(up(pair[0]), "축 위");
        else { sym.set(up(pair[0]), "↔ " + up(pair[1])); sym.set(up(pair[1]), "↔ " + up(pair[0])); }
      }
    if (k.constraint === "Order") (k.instances ?? []).forEach((n, i) => order.set(up(n), `${k.direction ?? ""} ${i + 1}`.trim()));
    if (k.constraint === "Align") (k.instances ?? []).forEach((n) => align.set(up(n), k.line ?? "align"));
  }
  const gByName = new Map(circuit.groups.map((g) => [g.name, g]));
  return (topMod.instances ?? []).map((inst) => {
    const name = up(inst.instance_name);
    const abstract = inst.abstract_template_name;
    const g = gByName.get(name);
    const family = familyOf(abstract);
    const variants = Object.values(prims)
      .filter((v) => v?.abstract_template_name === abstract)
      .map((v) => {
        const b = templates[v.concrete_template_name]?.bbox;
        return { concrete: v.concrete_template_name, w: b ? b[2] - b[0] : null, h: b ? b[3] - b[1] : null };
      });
    return {
      name, abstract, family, gloss: glossOf(family), isModule: mods.has(abstract),
      devices: g ? g.members.map((m) => circuit.devices[m].short ?? circuit.devices[m].name.replace(/^.*\//, "")) : [],
      count: g ? g.members.length : 0,
      variants,
      sym: sym.get(name) ?? "", order: order.get(name) ?? "", align: align.get(name) ?? "",
    };
  });
}
