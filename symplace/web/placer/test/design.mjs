/** 앞단 출력에서 만든 문제가, 고정값(fixtures/<예제>.json)의 문제와 같은가.
 *
 *  이게 변이 선택의 근거가 되는 검사다. 고정값은 변이가 이미 정해진 배치 문제(블록 크기·핀·넷)다.
 *  design.mjs 는 그 앞 단계(2_primitives)에서 읽어 변이를 고르지 않고 남긴다 — 그러려면 먼저
 *  "같은 변이를 고르면 같은 문제가 나온다"가 성립해야 한다.
 *
 *  그래서 고정값의 블록 크기와 같은 변이를 배정해 놓고 고정값과 맞대 본다.
 *  블록 순서와 핀 순서는 자료구조 순회 순서라 의미가 없으므로 이름으로 맞춘다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDesign, exampleNames } from "./_load.mjs";
import { variantGroups, buildProblem, countAssignments, enumerateAssignments,
         regionCandidates, structuralBound, moduleOrder } from "../../../../src/design.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "..", "fixtures");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log("  실패 " + msg); } };


for (const ex of exampleNames()) {
  console.log("\n=== " + ex + " ===");
  const { topology, design } = loadDesign(ex);
  const groups = variantGroups(design);

  console.log("  인스턴스 %d, 변이 그룹 %d, 조합 %d",
              design.instances.length, groups.length, countAssignments(groups));
  for (const g of groups)
    console.log("    [%s] %s -> %d : %s",
                g.members.map((i) => design.instances[i].name).join(","),
                g.abstract, g.choices.length, g.choices.join(" "));

  // 이 검사는 **평면 설계** 전용이다. 계층 설계는 최상위 인스턴스가 하위 모듈을
  // 가리켜서 leaf 템플릿 대조가 성립하지 않고, 고정값 파일도 계층을 거쳐
  // 만들어진 것이라 블록 수부터 다르다. 계층 경로는 test/place.mjs 가 본다.
  if (moduleOrder(topology).length > 1) {
    console.log("  (계층 설계 — 평면 대조 생략. test/place.mjs 가 본다)");
    continue;
  }

  // --- 고정값의 블록 크기와 같은 변이를 배정으로 되찾는다 ---
  const fp = path.join(FIX, ex + ".json");
  if (!fs.existsSync(fp)) { console.log("  (고정값 없음 — 배정 생성만 본다)"); }
  const fx = fs.existsSync(fp) ? J(fp) : null;
  const fxSize = new Map((fx?.names ?? []).map((n, i) => [n, [fx.w[i], fx.h[i]]]));
  const assign = groups.map((g) => {
    const nm = design.instances[g.members[0]].name;
    const want = fxSize.get(nm);
    const k = want ? g.choices.findIndex((c) => {
      const t = design.info.get(c);
      return t && Math.abs(t.w - want[0]) < 1e-9 && Math.abs(t.h - want[1]) < 1e-9;
    }) : -1;
    if (want) ok(k >= 0, `${nm}: 고정값 크기 ${want.join("x")} 의 변이가 후보에 없다`);
    return Math.max(0, k);
  });
  console.log("  고정값의 변이 = 배정 [%s]  (%s)", assign.join(","),
              groups.map((g, i) => g.choices[assign[i]]).join(" "));

  const prob = buildProblem(design, groups, assign);
  if (!fx) continue;

  ok(prob.n === fx.n, `블록 수 ${prob.n} vs ${fx.n}`);
  const fi = new Map(fx.names.map((n, i) => [n, i]));
  ok(prob.names.every((n) => fi.has(n)), "블록 이름 집합이 다르다");

  let dwh = 0;
  prob.names.forEach((n, i) => {
    const j = fi.get(n);
    if (j === undefined) return;
    dwh = Math.max(dwh, Math.abs(prob.w[i] - fx.w[j]), Math.abs(prob.h[i] - fx.h[j]));
  });
  ok(dwh === 0, `크기 최대차 ${dwh}`);
  console.log("  크기 최대차 %s", dwh);

  // 핀: (블록이름, 넷이름, dx, dy) 의 다중집합으로 비교한다
  const key = (inst, net, x, y) => `${inst}|${net}|${x}|${y}`;
  const mine = new Map(), theirs = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  for (let p = 0; p < prob.pinInst.length; p++)
    bump(mine, key(prob.names[prob.pinInst[p]], prob.netNames[prob.pinNet[p]],
                   prob.pinOff[2 * p], prob.pinOff[2 * p + 1]));
  for (let p = 0; p < fx.pin_inst.length; p++)
    bump(theirs, key(fx.names[fx.pin_inst[p]], fx.net_names[fx.pin_net[p]],
                     fx.pin_off[p][0], fx.pin_off[p][1]));

  const onlyMine = [...mine].filter(([k, v]) => theirs.get(k) !== v);
  const onlyTheirs = [...theirs].filter(([k, v]) => mine.get(k) !== v);
  ok(onlyMine.length === 0 && onlyTheirs.length === 0,
     `핀 불일치 — 우리만 ${onlyMine.length}, 저쪽만 ${onlyTheirs.length}`);
  for (const [k] of [...onlyMine.slice(0, 4), ...onlyTheirs.slice(0, 4)])
    console.log("    핀 차이  " + k);
  console.log("  핀 %d 개 / 넷 %d 개 (고정값 %d / %d)",
              prob.pinInst.length, prob.nNet, fx.pin_inst.length, fx.n_net);
  ok(prob.nNet === fx.n_net, `넷 수 ${prob.nNet} vs ${fx.n_net}`);

  // --- 영역 ---
  const [bw, bh] = structuralBound(prob);
  const fw = fx.region[2] - fx.region[0], fh = fx.region[3] - fx.region[1];
  console.log("  구조 하한 %d x %d   ALIGN region %d x %d", bw, bh, fw, fh);
  const regs = regionCandidates(prob);
  console.log("  영역 후보 %d 개: %s", regs.length,
              regs.map((r) => `${Math.round(r[2])}x${Math.round(r[3])}`).join("  "));

  // --- 다른 배정도 문제가 만들어지는가 ---
  let made = 0;
  for (const a of enumerateAssignments(groups)) {
    const p2 = buildProblem(design, groups, a);
    ok(p2.n === prob.n, "배정이 달라지니 블록 수가 변한다");
    ok(p2.nNet === prob.nNet, "배정이 달라지니 넷 수가 변한다");
    made++;
  }
  console.log("  배정 %d 개 전부 문제 생성 OK (블록/넷 수 불변)", made);
}

console.log(fails ? `\n실패 ${fails} 건` : "\n전부 통과");
process.exit(fails ? 1 : 0);
