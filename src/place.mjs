/** 앞단 출력 -> 배치 결과. 브라우저가 부르는 입구 하나.
 *
 *  ALIGN 의 place 단계를 **대신한다**. 입력은 1_topology 와 2_primitives 뿐이고
 *  ALIGN 배치기 출력은 쓰지 않는다. 그래서 변이(어느 종횡비의 소자를 쓸지)와
 *  거울 반전(sX, sY)을 우리가 직접 골라야 한다 — 이 파일이 그 순서를 엮는다.
 *
 *      readDesign          앞단 JSON 셋을 읽는다
 *      variantGroups       변이를 고를 단위 (대칭 쌍은 묶인다)
 *      multiStartVariants  (변이 배정 x 영역 후보) x 시작점 을 굴린다
 *      legalize            겹침을 정확히 0 으로 (LP)
 *      refineFlips         거울 반전을 좌표하강으로 고른다
 *
 *  ## legalize 가 실패할 수 있다
 *
 *  legalize 는 각 쌍의 분리 방향을 연속해에서 읽어 고정한 뒤 LP 를 푼다.
 *  연속해가 나쁘면(영역 모양이 대칭 구조와 싸우면) 고정한 방향이 실현 불가능해
 *  INFEASIBLE 이 난다. 영역 후보를 여러 개 굴리는 이상 이건 정상이다 —
 *  나쁜 영역은 나쁜 연속해를 낳고, 그건 버려야 할 후보다. 점수 순으로
 *  상위 몇 개를 legalize 해 보고 **성공한 것들 중에서** 다시 고른다.
 *  실패율 자체는 진단용으로 같이 돌려준다.
 */
import { readDesign, variantGroups, flipPlan, moduleOrder,
         orderDirections, blockSpacing } from "./design.mjs";
import { multiStartVariants, refineFlips, exactArea, hpwl, scoreOf } from "./solver.mjs";
import { legalize, exactOverlap, refineDirections } from "./legalize.mjs";

/** 앞단 JSON 셋에서 배치까지 한 번에.
 *
 *  input: { topology, primitives, templates } — readDesign 과 같은 형태
 *  반환 : { ok, names, concrete, cx, cy, w, h, sx, sy, box, area, hpwl,
 *           overlap, assignment, region, tried, legalizeFail, design, groups }
 */
export async function placeDesign(input, {
  batch = 96, iters = 600, seed = 0, M = 48,
  slack = 1.25, aspects = null, maxConfigs = null,
  // 면적 대 배선의 무게. 점수는 `log(면적) + hpwlWeight x log(HPWL)` (solver.mjs
  // scoreOf) — ALIGN 배치기의 비용과 같은 꼴이고, 1 이 ALIGN 의 LAMBDA 다.
  // HPWL 은 핀 경계 사각형으로 잰다 (ALIGN 의 HPWL_extend). 예전의
  // `면적/refArea + w x HPWL/refHpwl` 에서는 refHpwl 이 저울을 흔들어 2 로
  // 보정해 두었는데, 그 보정이 필요 없어졌다.
  hpwlWeight = 1,
  // 연속 단계의 저울. calibrate 가 lam 을 "밀도 기울기 = lamRatio x 배선
  // 기울기" 로 잡는다. hpwlWeight 가 **다 나온 해 중에서 고르는** 저울이라면
  // 이건 **어떤 해가 나오는지**를 바꾸는 저울이다.
  lamRatio = 1.0,
  // PDK 금속 pitch. [qx, qy] 를 주면 블록 원점이 그 배수가 되도록 legalize 가
  // 정수 제약으로 푼다. ALIGN 배선기가 이걸 요구한다 (FinFET14nm Mock: 80, 84).
  // null 이면 격자 없이 — 배선기로 넘길 수 없다.
  grid = null,
  flips = true, maxTries = 0, onProgress = null,
  // legalize 가 실패하면 이 여유들로 다시 풀어본다 (아래 설명).
  retrySlack = [3, 6],
  // legalize 뒤 점수 상위 이만큼에 대해 분리 방향을 뒤집어 본다 (refineDirections).
  refineTop = 4, refineFlips: refineFlipsMax = 6,
  // 설정(변이 배정 x 영역) 하나가 끝날 때마다 불린다. 화면에 중간 과정을
  // 보여주려고 뚫어뒀다 — 좌표가 들어 있어 그대로 그릴 수 있다.
  onConfig = null,
  // WebGPU runner (src/gpu/runner.mjs) 와 설정당 시작점 수. 없으면 CPU, 총 batch 개.
  runner = null, perConfig = null,
} = {}) {
  const t0 = performance.now();
  const design = input.design ?? readDesign(input);
  if (design.missing?.length)
    return { ok: false, reason: `템플릿을 못 찾은 인스턴스: ${design.missing.join(", ")}`,
             design };
  const groups = variantGroups(design);
  const res = await multiStartVariants(design, groups, {
    batch, iters, seed, M, slack, aspects, maxConfigs,
    // 후보를 고르는 저울과 legalize 뒤 저울을 같게 둔다.
    hpwlWeight, lamRatio, runner, perConfig,
    onProgress, onConfig,
  });

  // 점수 순으로 내려가며 legalize 한다. **legalize 뒤에** 다시 점수를 매긴다 —
  // 연속단계 점수는 겹침을 3 배 벌점으로 근사할 뿐이고, 실제 면적은 겹침을
  // 털어내고 나서야 정해진다. 실측: 연속단계 1 위가 legalize 뒤 면적 1.42x 였고
  // 상위 16 개를 legalize 해서 다시 고르니 0.99x 가 나왔다.
  // legalize 는 후보당 0.00~0.12 초라 Adam 에 비하면 공짜다.
  // --- 상위 후보를 legalize 하고, **그중에서** 고른다 ---
  //
  // 연속단계 점수는 겹침을 3 배 벌점으로 근사할 뿐이고, 실제 면적은 겹침을
  // 털어내고 나서야 정해진다. 그래서 여기서 다시 잰다 — 같은 scoreOf 로.
  // 점수가 절대량(로그)이라 후보 집합에 따라 저울이 흔들릴 자리가 없다.
  // 연속 단계가 얼마나 "무르게" 풀었는지. lamRatio 를 낮추면 넷이 더 세게
  // 당겨 겹침이 많이 남고, 높이면 퍼뜨려 겹침이 적게 남는다. legalize 가
  // 어차피 0 으로 만들지만, 남은 양이 많을수록 legalize 가 배치를 더 많이
  // 흔든다 — 이 값이 그 저울의 눈금이다.
  const ovs = res.candidates.map((c) => c.overlap).sort((a, b) => a - b);
  const medOverlap = ovs.length ? ovs[ovs.length >> 1] : 0;
  const plan = flipPlan(design, groups);
  // Order 제약이 있으면 그 쌍의 분리 방향을 박는다 (부등식이라 영공간엔 못 넣는다).
  const forced = res.candidates.length
    ? orderDirections(design.constraints, res.candidates[0].problem.names) : null;
  // 블록 간격 제약 (HorizontalDistance 등) — 분리 부등식에 더한다.
  const gap = blockSpacing(design.constraints);
  const limit = maxTries > 0 ? maxTries
              : Math.min(res.candidates.length, Math.max(16, Math.ceil(res.configs / 2)));

  // legalize 예산을 **반은 깊이, 반은 너비**로 쓴다.
  //
  // 너비가 필요한 이유: 그냥 점수 상위 N 개만 legalize 하면 예산에 따라 결과가
  // 널뛴다. 예산이 늘면 후보 풀은 커지는데 N 은 고정이라 잘 수렴한 것들끼리
  // 몰려 **모양이 좁아진다**. 실측(hsc 의 PRIMITIVE_98739713):
  //     batch  96   모양 후보 6 개   종횡비 0.27~1.50
  //     batch 288   모양 후보 4 개   종횡비 0.37~1.50
  // 모양은 영역 후보가 정하므로 설정을 고루 훑으면 예산과 무관하게 퍼진다.
  //
  // 깊이도 필요한 이유: 너비만 쓰면 점수 상위가 밀려난다. 전부 설정 순회로
  // 바꿨더니 telescopic_ota 의 HPWL 이 0.987 -> 1.079 로 나빠졌다.
  // (평면 설계라 모양 다양성은 필요 없고 손해만 본다.)
  const half = Math.max(1, Math.floor(limit / 2));
  const ordered = [];
  const inSet = new Set();
  const push = (c) => { if (!inSet.has(c)) { inSet.add(c); ordered.push(c); } };
  for (let i = 0; i < Math.min(half, res.candidates.length); i++) push(res.candidates[i]);
  const seenCfg = new Set(ordered.map(
    (c) => `${c.assignment.join(",")}|${c.region.join(",")}`));
  for (const c of res.candidates) {
    const k = `${c.assignment.join(",")}|${c.region.join(",")}`;
    if (seenCfg.has(k)) continue;
    seenCfg.add(k); push(c);
  }
  for (const c of res.candidates) push(c);

  let tried = 0, fail = 0, rescued = 0, best = null;
  const tSearch = (performance.now() - t0) / 1000;
  // 왜 실패했는지 세어둔다. "legalize 12/96 성공" 만으로는 고칠 데를 못 찾는다 —
  // 방향 조합이 안 맞는 것(INFEASIBLE)과 격자 정수를 못 맞춘 것(GRID_*)은
  // 처방이 다르다.
  const failBy = new Map();
  // 모양(종횡비)별로도 최선을 하나씩 남긴다. 계층에서 상위 모듈이 고를 수 있게
  // **여러 모양**을 내보내기 위해서다 — 하위 모듈은 면적이 같아도 모양이 다르면
  // 위층에서 전혀 다른 레이아웃이 된다. ALIGN 도 하위 모듈을 여러 개 만들어
  // 둔다 (PRIMITIVE_..._PG0_0 ~ _PG0_3).
  /** legalize 결과 하나의 점수 — 반전까지 정한 뒤에 잰다. 반전은 좌표를 안 건드리고
   *  배선길이만 바꾸니 여기서 정해도 늦지 않고, 정하지 않고 재면 내보낼 것과 다른
   *  값으로 고르게 된다. */
  const measure = (c, r) => {
    const fr = flips ? refineFlips(c.problem, plan, r.cx, r.cy) : null;
    const sx = fr ? fr.sx : c.problem.sx, sy = fr ? fr.sy : c.problem.sy;
    const ea = exactArea(r.cx, r.cy, c.problem.w, c.problem.h);
    const hp = hpwl(r.cx, r.cy, c.problem.pinInst, c.problem.pinOff,
                    c.problem.pinNet, c.problem.nNet, sx, sy, c.problem.pinExt);
    return { sc: scoreOf(ea.area, hp, hpwlWeight), r, fr, sx, sy, ea, hp };
  };
  /** 종횡비를 로그 눈금으로 묶는다 (1.25 배 간격). 모양이 비슷하면 한 칸. */
  const shapeKey = (ea) => {
    const ar = (ea.box[2] - ea.box[0]) / Math.max(1e-9, ea.box[3] - ea.box[1]);
    return Math.round(Math.log(ar) / Math.log(1.25));
  };

  // --- 1) 격자 없이 legalize — 후보를 줄 세우는 단계 ---
  //
  // 격자(정수 분기)는 LP 를 수십 번 다시 푼다. 후보 144 개에 다 걸면 hsc 에서
  // 마지막 단계가 1 분이 된다. 순위는 격자 없는 LP 로 거의 정해지므로 (격자는
  // 좌표를 pitch 배수로 몇십 nm 옮길 뿐이다) 먼저 격자 없이 전부 풀어 줄을 세우고,
  // 격자는 내보낼 것들(최선 + 모양별 최선)에만 건다.
  const pool = [];
  for (const c of ordered) {
    if (tried >= limit) break;
    tried++;
    // legalize 가 INFEASIBLE 이면 **여유 영역을 넓혀 다시 푼다.**
    //
    // 영역 제약은 X_i in [rx0+w/2, rx1-w/2] 라 slack 을 키우면 실행가능
    // 집합이 **커지기만 한다** — 되던 것이 안 되는 일은 없다. 목적함수에
    // 반둘레가 들어 있어 넓혀줘도 알아서 좁게 푼다.
    //
    // 왜 필요한가: 계층 설계에서 실패가 후보의 대부분이었다 (hsc 120/144,
    // cascode 28/34 — 전부 INFEASIBLE). 실패한 후보는 그냥 버려지므로
    // "변이를 고른다"가 사실상 살아남은 스무 개 안에서만 일어났다.
    const args = { z0: c.z0, N: c.N, n: c.problem.n, w: c.problem.w,
                   h: c.problem.h, cxRef: c.cx, cyRef: c.cy, region: c.region, forced, gap };
    let r = legalize(args);
    let usedSlack = null;
    for (const sl of retrySlack) {
      if (r.status === "OPTIMAL" || r.status === "NODIRECTION") break;
      r = legalize({ ...args, slack: sl });
      if (r.status === "OPTIMAL") { rescued++; usedSlack = sl; }
    }
    if (r.status !== "OPTIMAL") {
      fail++;
      failBy.set(r.status, (failBy.get(r.status) ?? 0) + 1);
      continue;
    }
    pool.push({ ...measure(c, r), c, args: usedSlack ? { ...args, slack: usedSlack } : args });
    if (onProgress) onProgress(tried, limit, null, "legalize");
  }
  pool.sort((a, b) => a.sc - b.sc);

  // --- 2) 점수 상위 몇 개는 분리 방향을 뒤집어 본다 ---
  //
  // 연속해가 나란히 놓은 쌍을 LP 는 못 뒤집는다. 침범량이 비슷했던 쌍부터
  // 방향을 바꿔 다시 풀고 점수가 좋아지면 받는다 (legalize.mjs refineDirections).
  let refined = 0;
  if (refineTop > 0 && pool.length) {
    const seenKey = new Set();
    const top = [];
    for (const k of pool) {                       // 최선 + 모양별 최선, 점수 순
      const key = shapeKey(k.ea);
      if (top.length && seenKey.has(key)) continue;
      seenKey.add(key); top.push(k);
      if (top.length >= refineTop) break;
    }
    for (const k of top) {
      const rr = refineDirections(k.args, k.r.dirs,
        (r) => measure(k.c, r).sc, { maxFlips: refineFlipsMax });
      if (!rr || !rr.flips) continue;
      refined += rr.flips;
      pool.push({ ...measure(k.c, rr.r), c: k.c, args: k.args });
    }
    pool.sort((a, b) => a.sc - b.sc);
  }

  // --- 3) 격자 — 내보낼 것들에만 ---
  //
  // 앵커: oX = cx - sX*(tx0+tx1)/2 가 pitch 의 배수여야 한다. 우리 템플릿은
  // bbox 가 [0,0,w,h] 라 (tx0+tx1)/2 = w/2 다. 반전 부호는 무시해도 되는데,
  // 예제 PDK 의 59 개 템플릿 전부 w/2 와 h/2 가 pitch 의 배수라 sX 를 곱해도
  // 격자 조건이 같기 때문이다 (아래 gridOff 로 결과를 검증한다).
  // 모양 칸마다 점수 순으로 첫 성공을 남긴다. 실패하면 그 칸의 다음 후보로.
  const byShape = new Map();
  let gridTried = 0;
  const maxGrid = 24;
  for (const k of pool) {
    const key = shapeKey(k.ea);
    if (byShape.has(key)) continue;
    let cand = k;
    if (grid) {
      if (gridTried >= maxGrid) break;
      gridTried++;
      const anchors = [Array.from(k.c.problem.w, (v) => v / 2), Array.from(k.c.problem.h, (v) => v / 2)];
      const r = legalize({ ...k.args, grid, anchors, dirs: k.r.dirs });
      if (r.status !== "OPTIMAL") {
        failBy.set(r.status, (failBy.get(r.status) ?? 0) + 1);
        continue;
      }
      cand = { ...measure(k.c, r), c: k.c, args: k.args };
    }
    byShape.set(key, cand);
    if (!best || cand.sc < best.sc) best = cand;
  }
  const tLegal = (performance.now() - t0) / 1000 - tSearch;

  if (!best)
    return { ok: false,
             reason: `legalize 가 ${tried} 후보에서 모두 실패했다 ` +
                     `(${[...failBy].map(([k, v]) => `${k} ${v}`).join(", ")})`,
             tried, legalizeFail: fail, legalizeRescued: rescued,
             legalizeFailBy: Object.fromEntries(failBy),
             design, groups, candidates: res.candidates };

  /** 후보 하나를 바깥에 내보낼 모양으로 편다. */
  const shape = (k) => {
    const P = k.c.problem;
    return {
      ok: true,
      names: P.names, concrete: P.concrete,
      cx: k.r.cx, cy: k.r.cy, w: P.w, h: P.h, sx: k.sx, sy: k.sy,
      box: k.ea.box, area: k.ea.area, hpwl: k.hp,
      hpwlBeforeFlip: k.fr ? k.fr.before : null,
      overlap: exactOverlap(k.r.cx, k.r.cy, P.w, P.h),
      flipBits: k.fr ? k.fr.bits : null,
      assignment: k.c.assignment, region: k.c.region,
      legalScore: k.sc, problem: P, design, groups,
    };
  };

  // 모양별 최선을 점수 순으로. 첫 번째는 전체 최선과 같다.
  const alts = [...byShape.values()].sort((a, b) => a.sc - b.sc).map(shape);

  const { c: picked, r: lg, fr, sx, sy, ea, hp } = best;
  const P = picked.problem;
  const ov = exactOverlap(lg.cx, lg.cy, P.w, P.h);

  return {
    ok: true,
    names: P.names, concrete: P.concrete,
    cx: lg.cx, cy: lg.cy, w: P.w, h: P.h, sx, sy,
    box: ea.box, area: ea.area, hpwl: hp, hpwlBeforeFlip: fr ? fr.before : null,
    overlap: ov, flipBits: fr ? fr.bits : null,
    grid, gridOff: grid ? gridOffgrid(P, lg.cx, lg.cy, sx, sy, grid) : null,
    assignment: picked.assignment, region: picked.region,
    tried, legalizeFail: fail, legalizeFailBy: Object.fromEntries(failBy),
    legalizeRescued: rescued, dirFlips: refined, gridTried,
    secs: { search: tSearch, legalize: tLegal },
    legalScore: best.sc,
    alternatives: alts,
    configs: res.configs, assignments: res.assignments,
    starts: res.starts, rounds: res.rounds, medOverlap, runner: res.runner,
    totalAssignments: res.totalAssignments,
    design, groups, problem: P, candidates: res.candidates,
  };
}

/** 격자에서 벗어난 블록 수. 0 이어야 ALIGN 배선기가 받는다.
 *  oX = cx - sX*w/2 가 qx 의 배수인지 본다 (oY 도 같은 식).
 */
export function gridOffgrid(problem, cx, cy, sx, sy, [qx, qy], tol = 1e-6) {
  let bad = 0;
  for (let i = 0; i < problem.n; i++) {
    const oX = cx[i] - sx[i] * (problem.w[i] / 2);
    const oY = cy[i] - sy[i] * (problem.h[i] / 2);
    const rx = Math.abs(oX / qx - Math.round(oX / qx));
    const ry = Math.abs(oY / qy - Math.round(oY / qy));
    if (rx > tol || ry > tol) bad++;
  }
  return bad;
}

/** 후보들 중 **종횡비가 고르게 퍼지도록** k 개를 고른다.
 *
 *  점수 최선은 무조건 넣고, 나머지는 로그 종횡비 범위에 균등한 목표점을 잡아
 *  가장 가까운 것을 집는다. 결과는 점수 순으로 되돌려준다.
 */
export function spreadShapes(alts, k) {
  if (alts.length <= k) return alts.slice();
  const ar = (a) => Math.log((a.box[2] - a.box[0]) / Math.max(1e-9, a.box[3] - a.box[1]));
  const sorted = alts.slice().sort((a, b) => ar(a) - ar(b));
  const lo = ar(sorted[0]), hi = ar(sorted[sorted.length - 1]);

  // 먼저 종횡비 범위에 균등한 목표점 k 개를 잡고 가장 가까운 것을 집는다.
  // (점수 최선을 미리 넣으면 목표점 하나가 잘려서 한쪽 끝이 빠진다 — 실제로
  //  가장 넓은 모양이 통째로 누락됐었다.)
  const chosen = new Set();
  for (let t = 0; t < k; t++) {
    const target = hi === lo ? lo : lo + ((hi - lo) * t) / (k - 1);
    let pick = null, best = Infinity;
    for (const a of sorted) {
      if (chosen.has(a)) continue;
      const dd = Math.abs(ar(a) - target);
      if (dd < best) { best = dd; pick = a; }
    }
    if (pick) chosen.add(pick);
  }
  // 점수 최선(alts[0])이 빠졌으면, 종횡비가 가장 가까운 것과 바꿔 넣는다.
  if (!chosen.has(alts[0])) {
    let drop = null, best = Infinity;
    for (const a of chosen) {
      const dd = Math.abs(ar(a) - ar(alts[0]));
      if (dd < best) { best = dd; drop = a; }
    }
    chosen.delete(drop);
    chosen.add(alts[0]);
  }
  return alts.filter((a) => chosen.has(a));        // 점수 순 유지
}

/** 대칭 잔차 — 같은 대칭 그룹의 블록들이 정말 한 축 위에 있는가.
 *  legalize 가 theta 공간에서 풀므로 기계 정밀도로 0 이어야 한다.
 */
/** 대칭축 위치 (세로축이면 x). 그림에 점선으로 그린다. */
export function axes(problem, cx, cy) {
  const idx = new Map(problem.names.map((n, i) => [n, i]));
  const out = [];
  for (const c of problem.constraints ?? []) {
    if (c.constraint !== "SymmetricBlocks") continue;
    const vert = (c.direction ?? "V") === "V";
    const vals = [];
    for (const pr of c.pairs ?? []) {
      const ids = pr.map((p) => idx.get(p)).filter((v) => v !== undefined);
      if (!ids.length) continue;
      vals.push(ids.reduce((s, i) => s + (vert ? cx[i] : cy[i]), 0) / ids.length);
    }
    if (vals.length) out.push({ vert, at: vals[0] });
  }
  return out;
}

export function symmetryResidual(problem, cx, cy) {
  const idx = new Map(problem.names.map((n, i) => [n, i]));
  let worst = 0;
  for (const c of problem.constraints) {
    if (c.constraint !== "SymmetricBlocks") continue;
    const vert = (c.direction ?? "V") === "V";
    const mids = [];
    for (const pr of c.pairs ?? []) {
      const ids = pr.map((p) => idx.get(p)).filter((v) => v !== undefined);
      if (!ids.length) continue;
      mids.push(ids.reduce((s, i) => s + (vert ? cx[i] : cy[i]), 0) / ids.length);
    }
    for (const m of mids) worst = Math.max(worst, Math.abs(m - mids[0]));
  }
  return worst;
}

// ------------------------------------------------------------------ 계층

/** 배치가 끝난 모듈을 상위에서 쓸 **템플릿**으로 굳힌다.
 *
 *  상위 모듈이 보기에 하위 모듈은 그냥 블록 하나다 — 크기와 포트 위치만 있으면
 *  된다. 포트 위치는 그 포트에 붙은 자식 핀들의 무게중심으로 잡는다
 *  (gpuplace/placement.py 의 template_pins 가 모듈에 대해 하던 것과 같다).
 *
 *  반환은 2_primitives 의 <concrete>.json 과 **같은 모양**이라, 상위 모듈은
 *  leaf 인지 하위 모듈인지 구분하지 않고 그대로 읽을 수 있다.
 */
export function synthesizeTemplate(design, result, grid = null) {
  const [x0, y0, x1, y1] = result.box;
  // 하위 모듈의 bbox 도 pitch 의 배수여야 한다. 위층에서 이 모듈의 앵커가
  // W/2, H/2 가 되는데 그게 격자 위에 있어야 하기 때문이다. 위로 올림한다
  // (줄이면 블록이 밖으로 나간다).
  let W = x1 - x0, H = y1 - y0;
  if (grid) {
    const [qx, qy] = grid;
    W = Math.ceil(W / (2 * qx)) * 2 * qx;
    H = Math.ceil(H / (2 * qy)) * 2 * qy;
  }
  // 포트의 사각형은 그 포트에 붙은 자식 핀 사각형들의 **합집합**이다. ALIGN 의
  // 하위 모듈 핀 경계와 같은 뜻이고, 상위의 HPWL_extend 가 그 폭을 그대로 본다.
  // (예전에는 무게중심 한 점이었다 — 핀 반폭을 재기 시작하면서 바꿨다.)
  const acc = new Map();
  design.instances.forEach((inst, di) => {
    const pi = result.problem.keep.indexOf(di);
    if (pi < 0) return;
    const t = design.info.get(result.concrete[pi]);
    if (!t) return;
    for (const [formal, off] of t.pins) {
      const net = inst.fa.get(formal);
      if (net == null) continue;
      const px = result.cx[pi] + result.sx[pi] * off[0] - x0;   // 원점을 bbox 왼아래로
      const py = result.cy[pi] + result.sy[pi] * off[1] - y0;
      const ex = off[2] ?? 0, ey = off[3] ?? 0;
      const r = acc.get(net);
      if (!r) acc.set(net, [px - ex, py - ey, px + ex, py + ey]);
      else {
        r[0] = Math.min(r[0], px - ex); r[1] = Math.min(r[1], py - ey);
        r[2] = Math.max(r[2], px + ex); r[3] = Math.max(r[3], py + ey);
      }
    }
  });

  const terminals = [];
  for (const port of design.ports) {
    const r = acc.get(port);
    if (!r) continue;
    terminals.push({ netName: port, netType: "pin", layer: "M1", rect: r.slice() });
  }
  return { bbox: [0, 0, W, H], terminals, subinsts: {}, globalRoutes: [], globalRouteGrid: [] };
}

/** 계층 설계를 아래에서 위로 배치한다.
 *
 *  ALIGN 도 같은 순서다. 하위 모듈을 먼저 배치해 크기와 포트 위치를 굳히고,
 *  상위는 그걸 블록 하나로 본다. 변이 선택은 모듈마다 따로 일어난다 —
 *  하위의 변이 선택이 그 모듈의 bbox 를 정하고, 그 bbox 가 상위 문제의 입력이 된다.
 *  (전 계층을 한꺼번에 최적화하는 것은 아니다. ALIGN 도 그렇게 하지 않는다.)
 *
 *  high_speed_comparator 가 이 경로를 탄다: 최상위 10 인스턴스 중 5 개가
 *  PRIMITIVE_* 하위 모듈을 가리킨다.
 *
 *  ## 하위 모듈은 **여러 모양**으로 내보낸다
 *
 *  하위 모듈을 하나로 굳혀 올리면 상위가 그 모양에 갇힌다. 실측:
 *
 *      모듈                  우리          ALIGN         면적비  종횡비
 *      PRIMITIVE_38447703    2240x5880     3520x3528     1.06x   0.38 vs 1.00
 *      PRIMITIVE_98739713    2240x3528     3520x2352     0.95x   0.63 vs 1.50
 *      PRIMITIVE_8946161     1600x3528     2240x2352     1.07x   0.45 vs 0.95
 *
 *  **면적은 이미 ALIGN 급인데 모양이 다르다.** 하위 모듈의 점수에는 종횡비가
 *  없기 때문이다 — 면적과 배선만 본다. 그런데 하위 모듈에서는 모양이 곧
 *  상위의 입력이다. 그게 최상위 구조 하한을 4800x15288 (ar 0.31) 로 만들고
 *  (ALIGN 은 6080x10584, ar 0.57), 영역 후보가 전부 그 주변에서만 나온다.
 *
 *  고치는 방법은 점수에 종횡비 벌점을 넣는 게 아니라 **고르지 않는 것**이다.
 *  하위 모듈을 종횡비별로 몇 개 내어 상위의 **변이**로 등록하면, 이미 있는
 *  변이 선택 기계가 그대로 고른다. ALIGN 도 같은 구조다 —
 *  PRIMITIVE_38447703_PG0_0 ~ _PG0_3 을 만들어 두고 상위가 고른다.
 */
/** 하위 모듈을 몇 가지 모양으로 상위에 올릴지.
 *
 *  job.mjs 가 배선용 덤프를 만들 때 **같은 수**로 spreadShapes 를 다시 돌려
 *  `__v{k}` 가 어느 후보였는지 되찾는다. 두 곳이 어긋나면 배선기에 엉뚱한
 *  모양이 간다. 그래서 상수를 한 곳에 둔다.
 */
export const SUB_VARIANTS = 3;

export async function placeHierarchy({ topology, primitives, templates }, opts = {}) {
  // subBatch: 하위 모듈에만 주는 시작점 예산. 하위 모듈은 블록이 두세 개라
  // 설정 수가 적고 한 번이 싸다 — 같은 예산을 줘도 최상위보다 훨씬 깊이 판다.
  // 그리고 하위의 모양이 곧 상위의 입력이라 여기 쓰는 돈이 제일 남는다.
  // 실측(hsc): batch 96 -> 1.053/1.333, batch 288 -> 1.000/1.000 인데
  // 최상위는 설정이 192 개라 둘 다 설정당 1 개다. 좋아진 건 하위 쪽이다.
  const { subVariants = SUB_VARIANTS, subBatch = null, ...rest } = opts;
  const order = moduleOrder(topology);
  const prim = { ...primitives };
  const tpl = { ...templates };
  const results = new Map();

  for (const name of order) {
    const design = readDesign({ topology, primitives: prim, templates: tpl, top: name });
    if (design.missing.length)
      return { ok: false, module: name,
               reason: `템플릿을 못 찾은 인스턴스: ${design.missing.join(", ")}` };
    const isTop = name === order[order.length - 1];
    const opt = isTop || !subBatch ? { ...rest } : { ...rest, batch: subBatch };
    // 중간 과정 콜백에 모듈 이름을 얹는다 (계층이면 어느 층인지 알아야 한다)
    if (rest.onConfig)
      opt.onConfig = (i, total, best, phase) =>
        rest.onConfig(name, isTop, i, total, best, phase);
    const r = await placeDesign({ design }, opt);
    if (!r.ok) return { ok: false, module: name, reason: r.reason, detail: r };
    results.set(name, r);
    if (isTop) break;                                     // top 은 굳힐 필요가 없다

    // 모양별 최선을 몇 개 골라 상위의 변이로 등록한다.
    //
    // **점수 순으로 자르면 안 된다.** 그러면 종횡비가 한쪽으로 쏠린다.
    // 실측(hsc, PRIMITIVE_98739713): 점수 상위 3 개가 0.63 / 0.27 / 0.37 로
    // 전부 홀쭉한 쪽이었고, ALIGN 이 쓰는 1.50 (3520x2352) 은 6 개 중 4 위라
    // 상위 모듈이 **아예 보지 못했다**.
    //
    // 상위가 필요한 건 "좋은 것 몇 개"가 아니라 "모양이 서로 다른 몇 개"다.
    // 그래서 종횡비 범위를 고르게 덮도록 고른다. 이게 없으면 예산을 늘릴수록
    // 올라가는 모양이 통째로 바뀌어 결과가 요동친다 — 실제로 hsc 가
    // batch 96 -> 1.053, 288 -> 1.000, 864 -> 1.140 으로 널뛰었다.
    const picks = spreadShapes(r.alternatives ?? [r], Math.max(1, subVariants));
    picks.forEach((pl, k) => {
      const cname = picks.length === 1 ? name : `${name}__v${k}`;
      prim[cname] = { abstract_template_name: name, concrete_template_name: cname,
                      x_cells: 1, y_cells: 1 };
        tpl[cname] = synthesizeTemplate(design, pl, rest.grid ?? null);
    });
  }

  return { ok: true, order, modules: results,
           top: results.get(order[order.length - 1]) };
}

/** \`Order\` 제약이 실제로 지켜졌는가. 어긴 개수를 돌려준다.
 *  legalize 가 방향을 박아 풀었으니 0 이어야 한다 — 0 이 아니면 박는 쪽이 샌 것이다.
 */
export function orderViolations(problem, cx, cy) {
  const idx = new Map(problem.names.map((n, i) => [n, i]));
  const bad = [];
  for (const c of problem.constraints ?? []) {
    if (c.constraint !== "Order") continue;
    const dir = String(c.direction ?? "left_to_right");
    const ids = (c.instances ?? []).map((n) => idx.get(n)).filter((v) => v !== undefined);
    const val = (i) => (dir.startsWith("left") || dir.startsWith("right") || dir === "horizontal")
      ? cx[i] : cy[i];
    const asc = dir === "left_to_right" || dir === "horizontal" || dir === "bottom_to_top";
    for (let k = 1; k < ids.length; k++) {
      const a = val(ids[k - 1]), b = val(ids[k]);
      if (asc ? !(a < b) : !(a > b))
        bad.push(`${problem.names[ids[k - 1]]} -> ${problem.names[ids[k]]}`);
    }
  }
  return bad;
}
