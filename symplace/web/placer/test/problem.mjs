/** src/route/problem.mjs — 계층 펼치기와 배선 문제가 맞는가. (지운 test/flatten.py 의 검사를 JS 로)
 *
 *  예제마다 ALIGN 의 배치(data/<예제>.json 의 place — 늘 있다)와, 캐시에 있으면 우리 배치
 *  (~/.cache/symplace/place-<예제>.json) 로:
 *    1. 펼친 리프 이름이 안 겹치고, 개수가 계층에서 센 것과 같다
 *    2. 리프가 전부 배치 bbox 안에 있다
 *    3. 배선 전 검사에 SHORT·DRC 가 없다 (DIFFERENT WIDTH 는 소자층의 리프 고유 것만)
 *    4. 리프 핀 도형의 넷 이름이 fa_map 으로 푼 넷과 같다
 *    5. SymmetricNets 의 핀 참조가 그 넷으로 풀린다, 대칭 넷 쌍에 축이 있다
 *    6. 이을 넷의 연결 덩이마다 M2 이상의 도형이 있다 (배선기가 닿을 곳)
 *  캐시에 ALIGN 배선 기록(checkref.mjs capture)이 있으면 우리 배치로 더:
 *    7. 리프 변환이 ALIGN 이 계층으로 읽은 것(최상위 블록 x 하위 블록)과 같다
 *    8. 소자 단자(V0)마다 넷이 ALIGN 이 계층 배선 끝에 최상위에서 쓴 넷과 같다
 *
 *    node symplace/web/placer/test/problem.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trCompose, trRect } from "../../../../src/route/compose.mjs";
import { readLeaves } from "../../../../src/route/leaves.mjs";
import { MOCK_PDK } from "../../../../src/route/pdk.mjs";
import { buildProblem, placementFromAlign, topModule } from "../../../../src/route/problem.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const inside = (a, b) => b[0] <= a[0] && b[1] <= a[1] && a[2] <= b[2] && a[3] <= b[3];

function leafCount(topo, name) {
  const m = topo.modules.find((x) => x.name === name);
  if (!m) return 1;
  return m.instances.reduce((s, i) => s + leafCount(topo, i.abstract_template_name), 0);
}

function checks(ex, design, leaves, placement) {
  const errs = [];
  const { problem, layout, flat, pre } = buildProblem({ design, leaves, placement, pdk: MOCK_PDK });
  // 1
  const names = flat.blocks.map((b) => b.name);
  if (new Set(names).size !== names.length) errs.push("리프 이름이 겹친다");
  const want = leafCount(design.topology, topModule(design.topology).name);
  if (names.length !== want) errs.push(`리프 ${names.length} 개, 계층에서 센 것 ${want} 개`);
  // 2
  for (const b of flat.blocks) if (!inside(b.bbox, placement.bbox)) errs.push(`${b.name} 가 bbox 밖이다 ${b.bbox}`);
  // 3
  if (pre.shorts.length) errs.push(`배선 전 SHORT ${pre.shorts.length}: ${JSON.stringify(pre.shorts[0]).slice(0, 160)}`);
  if (pre.drc.length) errs.push(`배선 전 DRC ${pre.drc.length}: ${pre.drc[0]}`);
  const badW = pre.differentWidths.filter((w) => /^(M\d|V\d)/.test(w.layer));
  if (badW.length) errs.push(`배선층 DIFFERENT WIDTH ${badW.length}: ${badW[0].msg}`);
  // 4
  let pins = 0;
  for (const b of flat.blocks)
    for (const t of b.terminals.filter((t) => t.netType === "pin")) {
      pins++;
      const net = flat.faMap.get(`${b.name}/${t.netName}`);
      const r = trRect(b.tr, t.rect).join();
      const placed = layout.terminals.some((u) => u.layer === t.layer && u.netType === "pin" && u.netName === net && u.rect.join() === r);
      if (net == null) errs.push(`${b.name}/${t.netName}: fa_map 에 없다`);
      else if (!placed) errs.push(`${b.name}/${t.netName}: ${net} 핀 도형이 없다`);
    }
  // 5
  const top = topModule(design.topology);
  const netIdx = new Map(problem.nets.map((n, i) => [n.name, i]));
  for (const c of (top.constraints ?? []).filter((k) => k.constraint === "SymmetricNets")) {
    for (const [net, refs] of [[c.net1, c.pins1], [c.net2, c.pins2]])
      for (const r of refs ?? []) {
        const [inst, pin] = r.includes("/") ? r.split("/") : [null, r];
        if (inst == null) { if (r !== net) errs.push(`${r}: 포트 참조가 ${net} 이 아니다`); continue; }
        const direct = flat.faMap.get(`${inst}/${pin}`);
        const viaSub = flat.scopes.find((s) => s.path === inst)?.resolve(pin);
        if ((direct ?? viaSub) !== net) errs.push(`${r}: ${direct ?? viaSub} 로 풀린다 (${net} 이어야)`);
      }
    const a = problem.nets[netIdx.get(c.net1)], b = problem.nets[netIdx.get(c.net2)];
    if (a && b && (a.sym !== netIdx.get(c.net2) || a.axis2 == null)) errs.push(`${c.net1}/${c.net2}: 대칭 쌍·축이 안 걸렸다`);
  }
  // 6
  const reach = new Map();
  for (const [ly, n, comp] of problem.shapes) if (n >= 0 && ly !== "M1" && ly[0] === "M") reach.set(comp, true);
  const comps = new Map();
  for (const [, n, comp] of problem.shapes) if (n >= 0) { if (!comps.has(n)) comps.set(n, new Set()); comps.get(n).add(comp); }
  for (const [n, cs] of comps)
    if (problem.nets[n].parts > 1) for (const c of cs) if (!reach.get(c)) errs.push(`${problem.nets[n].name}: 덩이 ${c} 에 M2 이상 도형이 없다`);
  return { errs, problem, flat, pre, pins };
}

let bad = 0, n = 0;
const line = (ex, tag, r, extra = "") => {
  const route = r.problem.nets.filter((x) => x.parts > 1);
  console.log(`${ex.padEnd(28)} ${tag.padEnd(6)} 리프 ${String(r.flat.blocks.length).padStart(2)}  핀 ${String(r.pins).padStart(3)}` +
              `  이을 넷 ${String(route.length).padStart(2)} (덩이 ${route.reduce((s, x) => s + x.parts, 0)})` +
              `  대칭 ${r.problem.nets.filter((x) => x.sym >= 0).length / 2}${extra}  ${r.errs.length ? "틀림" : "OK"}`);
  for (const e of r.errs.slice(0, 8)) console.log("    " + e);
  n++; if (r.errs.length) bad++;
};

const rows = J(path.join(ROOT, "data/index.json")).map((x) => (typeof x === "string" ? { name: x } : x));
for (const { name: ex } of rows) {
  const lp = path.join(ROOT, "data", ex + ".leaves.json");
  if (!fs.existsSync(lp)) continue;
  const design = J(path.join(ROOT, "data", ex + ".json"));
  const leaves = readLeaves(J(lp));
  if (design.place) line(ex, "ALIGN", checks(ex, design, leaves, placementFromAlign(design.place)));

  const pf = path.join(CACHE, `place-${ex}.json`);
  if (!fs.existsSync(pf)) continue;
  const placement = J(pf);
  const r = checks(ex, design, leaves, placement);
  const cf = path.join(CACHE, "check", ex + ".json");
  let extra = "";
  if (fs.existsSync(cf)) {
    const cap = J(cf);
    // 7: 최상위 블록 변환 x 하위 모듈 블록 변환
    const byMod = new Map(cap.cases.map((c) => [c.module + "_0", c]));
    const topCase = cap.cases.find((c) => c.isTop);
    const trOf = (b) => ({ oX: b.tr2x[0] / 2, oY: b.tr2x[1] / 2, sX: b.tr2x[2], sY: b.tr2x[3] });
    const want = new Map();
    for (const b of topCase.blocks) {
      const sub = byMod.get(b.lefmaster);
      if (sub) for (const sb of sub.blocks) want.set(`${b.name}/${sb.name}`, trCompose(trOf(b), trOf(sb)));
      else want.set(b.name, trOf(b));
    }
    for (const b of r.flat.blocks) {
      const w = want.get(b.name);
      if (!w) r.errs.push(`${b.name}: ALIGN 기록에 없다`);
      else if (JSON.stringify(w) !== JSON.stringify(b.tr)) r.errs.push(`${b.name}: 변환 ${JSON.stringify(b.tr)} (ALIGN ${JSON.stringify(w)})`);
    }
    // 8: 소자 단자 -> 넷
    const alignNet = new Map(topCase.terminalsOut.filter((t) => t.terminal).map((t) => [t.terminal.join(":"), t.netName]));
    const ours = new Map(r.pre.terminals.filter((t) => t.terminal).map((t) => [t.terminal.join(":"), t.netName]));
    let diff = 0;
    for (const [k, v] of ours) if (alignNet.get(k) !== v) { if (!diff++) r.errs.push(`단자 ${k}: 우리 ${v}, ALIGN ${alignNet.get(k)}`); }
    if (ours.size !== alignNet.size) r.errs.push(`단자 수 우리 ${ours.size}, ALIGN ${alignNet.size}`);
    if (diff > 1) r.errs.push(`… 단자 넷이 다른 것 모두 ${diff} 개`);
    extra = `  단자 ${ours.size} 대조`;
  }
  line(ex, "우리", r, extra);
}
if (bad) { console.error(`\n${n} 건 중 ${bad} 건 틀림`); process.exit(1); }
console.log(`\n${n} 건 모두 맞다`);
