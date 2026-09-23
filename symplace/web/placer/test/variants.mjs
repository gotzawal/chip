/** 변이 선택이 **실제로 결과를 가르는가**를 본다.
 *
 *  test/place.mjs 가 "고른 답이 좋은가"를 본다면, 이쪽은 그 앞 질문을 본다:
 *  배정을 바꾸면 결과가 달라지긴 하는가? 안 달라지면 변이 선택은 애초에
 *  할 이유가 없는 일이다.
 *
 *  그래서 배정을 전수로 돌리고 배정별 최고를 늘어놓는다. 점수 폭이 0 이
 *  아니어야 하고, 우리가 고른 것이 ALIGN 이 고른 것과 어떻게 다른지 보여준다.
 *
 *  평면 설계 전용이다. 계층 설계는 배정이 모듈마다 따로 일어나 한 표에 못 담는다.
 */
import { loadDesign, alignBaseline, exampleNames } from "./_load.mjs";
import { variantGroups, countAssignments, flipPlan, topIndex,
         moduleOrder } from "../../../../src/design.mjs";
import { multiStartVariants, refineFlips, exactArea, hpwl, scoreOf } from "../../../../src/solver.mjs";
import { legalize, exactOverlap } from "../../../../src/legalize.mjs";
import { symmetryResidual } from "../../../../src/place.mjs";

const BATCH = Number(process.env.BATCH ?? 96);
const ITERS = Number(process.env.ITERS ?? 600);

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  실패 " + m); } };

for (const ex of exampleNames()) {
  const { topology, design, place } = loadDesign(ex);
  if (moduleOrder(topology).length > 1) continue;          // 계층은 place.mjs 가 본다
  console.log("\n=== " + ex + " ===");

  const groups = variantGroups(design);
  const nAssign = countAssignments(groups);
  const base = place ? alignBaseline(place, topology.modules[topIndex(topology)].name) : null;
  if (base)
    console.log(`  ALIGN 기준  bbox ${base.bbox[2] - base.bbox[0]}x${base.bbox[3] - base.bbox[1]}  ` +
                `면적 ${base.area.toExponential(3)}  HPWL ${base.hpwl.toFixed(0)}`);

  const alignAssign = base ? (() => {
    const chosen = new Map(base.top.instances.map(
      (i) => [i.instance_name, i.concrete_template_name]));
    return groups.map((g) =>
      Math.max(0, g.choices.indexOf(chosen.get(design.instances[g.members[0]].name))));
  })() : null;

  const t0 = Date.now();
  const res = await multiStartVariants(design, groups, { batch: BATCH, iters: ITERS, seed: 1 });
  console.log(`  변이조합 ${nAssign}, 설정(배정x영역) ${res.configs}, ` +
              `후보 ${res.candidates.length}개, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 배정마다 legalize 까지 간 최선을 잡는다. 연속단계 점수로만 줄 세우면
  // 겹침을 털기 전 값이라 배정 간 비교가 흐려진다.
  const plan = flipPlan(design, groups);
  const best = new Map();
  for (const c of res.candidates) {
    const k = c.assignment.join(",");
    const r = legalize({ z0: c.z0, N: c.N, n: c.problem.n, w: c.problem.w,
                         h: c.problem.h, cxRef: c.cx, cyRef: c.cy, region: c.region });
    if (r.status !== "OPTIMAL") continue;
    const fr = refineFlips(c.problem, plan, r.cx, r.cy);
    const ea = exactArea(r.cx, r.cy, c.problem.w, c.problem.h);
    // 핀 경계로 잰 HPWL (ALIGN 의 HPWL_extend) 과 핀 중심으로 잰 것을 둘 다 남긴다.
    // 점수는 배치기와 같은 scoreOf (경계 HPWL).
    const hp = hpwl(r.cx, r.cy, c.problem.pinInst, c.problem.pinOff,
                    c.problem.pinNet, c.problem.nNet, fr.sx, fr.sy, c.problem.pinExt);
    const hpC = hpwl(r.cx, r.cy, c.problem.pinInst, c.problem.pinOff,
                     c.problem.pinNet, c.problem.nNet, fr.sx, fr.sy);
    let tot = 0;
    for (let i = 0; i < c.problem.n; i++) tot += c.problem.w[i] * c.problem.h[i];
    const sc = scoreOf(ea.area, hp);
    if (!best.has(k) || sc < best.get(k).sc)
      best.set(k, { sc, c, r, fr, ea, hp, hpC, tot,
                    ov: exactOverlap(r.cx, r.cy, c.problem.w, c.problem.h) });
  }
  ok(best.size > 0, "legalize 된 배정이 하나도 없다");
  if (!best.size) continue;

  const ranked = [...best.entries()].sort((a, b) => a[1].sc - b[1].sc);
  const rA = base?.area ?? 1, rW = base?.hpwl ?? 1;
  console.log(`  배정별 최고 (legalize 후) — 면적비 / HPWL비(핀 중심) / HPWL 경계 / 점수` +
              `   [legalize 성공 ${best.size}/${nAssign} 배정]`);
  // 60 줄을 다 찍으면 읽을 수 없다. 위아래와 ALIGN 의 것만 남긴다.
  const alignKey = alignAssign?.join(",");
  const keep = new Set([...ranked.slice(0, 6), ...ranked.slice(-3)].map(([k]) => k));
  if (alignKey) keep.add(alignKey);
  let skipped = 0;
  for (const [k, v] of ranked) {
    if (!keep.has(k)) { skipped++; continue; }
    if (skipped) { console.log(`      ... ${skipped} 개 생략 ...`); skipped = 0; }
    const mark = alignAssign && k === alignAssign.join(",") ? "  <- ALIGN 의 선택" : "";
    console.log(`    [${k.padEnd(11)}] ` +
                `${v.c.concrete.map((n) => n.split("_").pop()).join(" ").padEnd(18)} ` +
                `${(v.ea.area / rA).toFixed(3)}  ${(v.hpC / rW).toFixed(3)}  ${v.hp.toFixed(0).padStart(6)}  ` +
                `${v.sc.toFixed(4)}${mark}  (${ranked.findIndex(([q]) => q === k) + 1}위)`);
  }
  if (skipped) console.log(`      ... ${skipped} 개 생략 ...`);
  const spread = ranked[ranked.length - 1][1].sc - ranked[0][1].sc;
  console.log(`  점수 폭 ${spread.toFixed(4)}   (0 이면 변이 선택이 무의미하다는 뜻)`);
  ok(spread > 1e-6, "배정이 달라도 점수가 같다 — 변이 선택이 무의미해진다");

  const win = ranked[0][1];
  console.log(`  고른 배정 [${ranked[0][0]}]  ${win.c.concrete.join(" ")}`);
  if (alignAssign)
    console.log(`  ALIGN 의 배정 [${alignAssign.join(",")}] — ` +
                (ranked[0][0] === alignAssign.join(",") ? "같다" : "다르다"));
  const resid = symmetryResidual(win.c.problem, win.r.cx, win.r.cy);
  console.log(`  겹침 ${(win.ov / win.tot).toExponential(1)}  대칭잔차 ${resid.toExponential(1)}  ` +
              `반전 고르기 HPWL ${win.fr.before.toFixed(0)} -> ${win.fr.hpwl.toFixed(0)}`);
  ok(win.ov / win.tot < 1e-9, `겹침 비율 ${win.ov / win.tot}`);
  ok(resid < 1e-6, `대칭 잔차 ${resid}`);
}

console.log(fails ? `\n실패 ${fails} 건` : "\n전부 통과");
process.exit(fails ? 1 : 0);
