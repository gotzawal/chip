/** ALIGN 앞단 출력(1_topology + 2_primitives)에서 배치 문제를 만든다.
 *
 *  ## 왜 이 파일이 생겼나
 *
 *  원래 이 배치기는 ALIGN 의 **place 단계 출력**
 *  (3_pnr/Results/*.scaled_placement_verilog.json)에서 블록 크기와 핀을 읽었다.
 *  편했지만 대가가 컸다. 그 파일을 만들려면 ALIGN 배치기를 먼저 돌려야 하고,
 *  ALIGN 배치기는 ILP 솔버가 필요해 브라우저에 못 싣는다. 즉 "넷리스트를 주면
 *  브라우저가 배치한다"가 성립하지 않았다.
 *
 *  더 중요한 건 그 파일이 **variant 선택의 답까지** 담고 있었다는 것이다.
 *  2_primitives 는 같은 소자를 여러 종횡비로 만들어 둔다:
 *
 *      CMC_PMOS_51983143   X1_Y2    800 x 3528   (1열 2행, 홀쭉)
 *                          X2_Y1   1120 x 2352   (2열 1행, 넓적)
 *
 *  트랜지스터도 파라미터도 같고 **모양만** 다르다. 어느 쪽을 쓰느냐는 장식이
 *  아니라 배치 문제의 일부다 — 홀쭉한 것들을 세로로 쌓는 것과 넓적한 것들을
 *  가로로 붙이는 것은 전혀 다른 레이아웃이 되고, 영역 종횡비·대칭축 위치·
 *  배선길이가 전부 따라 바뀐다. ALIGN 은 그걸 SA 탐색 안에서 같이 골랐다
 *  (sp.selected[block_id]). 우리는 그 답을 받아 쓰고 있었을 뿐이다.
 *
 *  이 파일은 그 의존을 끊는다. 앞단 출력만 읽고, variant 는 **고르지 않고 남겨둔다**.
 *  고르는 일은 solver.mjs 의 multiStartVariants 가 다중 시작점과 함께 한다.
 *
 *  ## 단위 (실측 확인)
 *
 *  2_primitives 의 좌표와 place 단계 leaf 좌표는 **같은 단위**다. telescopic_ota
 *  5 개 템플릿의 bbox 배율이 전부 정확히 1.0 이고, 핀 중심도 0.0 차이로 같다.
 *  (파일 이름의 "scaled" 는 상위 모듈 좌표계 얘기지 템플릿 좌표가 아니다.)
 *
 *  ## 입력 세 가지
 *
 *    1_topology/<top>.verilog.json    인스턴스 -> abstract 템플릿, fa_map, 제약
 *    2_primitives/__primitives__.json concrete -> abstract, x_cells, y_cells
 *    2_primitives/<concrete>.json     bbox, terminals
 */

import { ALIGN_EQ, build as buildSystem, nullspace as nullspaceOf,
         particular as particularOf } from "./subspace.mjs";
import { Objective } from "./energy.mjs";


/** 배선길이 최소화에서 빼는 넷. 전원·접지는 배선 단계가 별도 그리드로 깔아서
 *  HPWL 대상이 아니다. gpuplace/netlist.py 와 같은 규칙. */
export function powerGroundNets(constraints) {
  const out = new Set(["0", "VDD", "GND", "VSS"]);
  for (const c of constraints ?? []) {
    if (["PowerPorts", "GroundPorts", "ClockPorts"].includes(c.constraint))
      for (const p of c.ports ?? []) out.add(String(p).toUpperCase());
  }
  return out;
}

/** 제약 등록 — 배치기가 어느 제약을 어떻게 다루는지 한 곳에 적는다.
 *
 *  PLACER   배치기가 직접 처리한다.
 *  ELSEWHERE 앞단이나 배선기의 것이라 배치기는 볼 일이 없다 (전원·클럭 넷 거르기만 여기서).
 *            CompactPlacement 는 ALIGN 배치기의 옵션이고 우리 기본 동작(면적·배선 최소화)이 그것이다.
 *            ChargeFlow 는 ALIGN 도 PnRDB 에 읽기만 하고 배치·배선에 쓰지 않는다.
 *  그 밖의 것(Boundary, Spread, SameTemplate, PlaceOnGrid, Floorplan, GroupCaps, GuardRing ...)은
 *  배치기가 **무시한다** — ignoredConstraints 가 그 이름을 돌려주고, 페이지가 그것을 보여준다.
 */
export const PLACER_CONSTRAINTS = new Set([
  "SymmetricBlocks", "Align", "Order", "AspectRatio",
  "HorizontalDistance", "VerticalDistance", "BlockDistance",
]);
export const ELSEWHERE_CONSTRAINTS = new Set([
  "PowerPorts", "GroundPorts", "ClockPorts",
  "GroupBlocks", "DoNotUseLib", "DoNotIdentify", "ConfigureCompiler", "Generator",
  "CompactPlacement", "ChargeFlow",
  "SymmetricNets", "NetPriority", "NetConst", "PortLocation", "MultiConnection", "ShieldNet", "CritNet",
]);
export function ignoredConstraints(constraints) {
  const out = new Set();
  for (const c of constraints ?? [])
    if (!PLACER_CONSTRAINTS.has(c.constraint) && !ELSEWHERE_CONSTRAINTS.has(c.constraint)) out.add(c.constraint);
  return [...out];
}

/** 블록 사이의 최소 간격 [가로, 세로] — HorizontalDistance / VerticalDistance / BlockDistance 의
 *  abs_distance 중 가장 큰 것. legalize 의 분리 부등식에 그만큼을 더한다 (ALIGN 의 bias_*graph).
 *  지금 예제들은 전부 0 이다. */
export function blockSpacing(constraints) {
  let gx = 0, gy = 0;
  for (const c of constraints ?? []) {
    const d = Number(c.abs_distance ?? 0);
    if (!(d > 0)) continue;
    if (c.constraint === "HorizontalDistance" || c.constraint === "BlockDistance") gx = Math.max(gx, d);
    if (c.constraint === "VerticalDistance" || c.constraint === "BlockDistance") gy = Math.max(gy, d);
  }
  return [gx, gy];
}

/** concrete 템플릿 JSON 에서 크기와 핀을 뽑는다.
 *
 *  핀은 terminals 중 netType === "pin" 인 것들이다. 같은 넷에 여러 조각이
 *  걸쳐 있어서(M3 스트라이프가 층마다 하나씩) 넷별로 합집합 사각형을 잡고
 *  그 중심을 쓴다. place 단계 leaf 의 terminals 와 대조해 중심이 정확히
 *  일치함을 확인했다.
 */
export function templateInfo(tjson) {
  const [x0, y0, x1, y1] = tjson.bbox;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const acc = new Map();
  for (const t of tjson.terminals ?? []) {
    if (t.netType !== "pin" || !t.netName) continue;
    const r = t.rect;
    const cur = acc.get(t.netName);
    if (!cur) acc.set(t.netName, [r[0], r[1], r[2], r[3]]);
    else {
      cur[0] = Math.min(cur[0], r[0]); cur[1] = Math.min(cur[1], r[1]);
      cur[2] = Math.max(cur[2], r[2]); cur[3] = Math.max(cur[3], r[3]);
    }
  }
  // 넷마다 [중심 오프셋 x, y, 반폭 x, y]. 반폭은 ALIGN 의 HPWL_extend 가 재는
  // 핀 경계 사각형이다 — 폭 5,000 짜리 핀 막대를 점으로 보면 길쭉한 variant 가
  // 공짜로 보인다 (energy.mjs wirelength 의 설명).
  const pins = new Map();
  for (const [net, r] of acc)
    pins.set(net, [(r[0] + r[2]) / 2 - cx, (r[1] + r[3]) / 2 - cy,
                   (r[2] - r[0]) / 2, (r[3] - r[1]) / 2]);
  return { w: x1 - x0, h: y1 - y0, pins, bbox: [x0, y0, x1, y1] };
}

/** 앞단 출력 셋을 하나의 Design 으로 묶는다.
 *
 *  topology   : 1_topology/<top>.verilog.json 을 파싱한 객체
 *  primitives : 2_primitives/__primitives__.json
 *  templates  : { concrete_name: <concrete>.json } — 필요한 것만 있어도 된다
 *  top        : 모듈 이름 (없으면 마지막 모듈)
 */
export function readDesign({ topology, primitives, templates, top = null }) {
  const mods = topology.modules ?? [];
  const module = (top && mods.find((m) => m.name === top)) || mods[topIndex(topology)];
  if (!module) throw new Error("모듈이 없다");

  // abstract -> concrete 후보. x_cells * y_cells 오름차순으로 두어
  // 같은 입력이면 늘 같은 순서가 나오게 한다 (재현성).
  const byAbstract = new Map();
  for (const [name, d] of Object.entries(primitives)) {
    const a = d.abstract_template_name;
    if (!byAbstract.has(a)) byAbstract.set(a, []);
    byAbstract.get(a).push({ name, xCells: d.x_cells ?? 1, yCells: d.y_cells ?? 1 });
  }
  for (const list of byAbstract.values())
    list.sort((p, q) => (p.xCells - q.xCells) || (p.yCells - q.yCells)
                     || (p.name < q.name ? -1 : 1));

  const all = (module.instances ?? []).map((i) => ({
    name: i.instance_name,
    abstract: i.abstract_template_name,
    fa: new Map((i.fa_map ?? []).map((f) => [f.formal, f.actual])),
  }));
  const instances = all.filter((i) => byAbstract.has(i.abstract));
  // 빠진 인스턴스는 조용히 넘기면 안 된다. 계층 설계에서 하위 모듈을 가리키는
  // 인스턴스가 여기 걸리는데, 그걸 모르고 지나가면 블록 10 개짜리 설계가
  // 2 개짜리로 줄어든 채 "성공"한다 (실제로 그랬다).
  const missing = all.filter((i) => !byAbstract.has(i.abstract)).map((i) => i.abstract);

  const info = new Map();
  for (const [name, t] of Object.entries(templates ?? {})) info.set(name, templateInfo(t));

  return { module, instances, byAbstract, info, missing: [...new Set(missing)],
           ports: module.parameters ?? [],
           constraints: module.constraints ?? [] };
}

/** 아무도 인스턴스로 쓰지 않는 모듈이 top 이다.
 *  "마지막 모듈"로 잡으면 계층 설계에서 하위 모듈을 top 으로 착각한다
 *  (high_speed_comparator 에서 PRIMITIVE_8231979 를 골라 블록이 2 개가 됐다).
 */
export function topIndex(topology) {
  const mods = topology.modules ?? [];
  const used = new Set();
  for (const m of mods)
    for (const i of m.instances ?? []) used.add(i.abstract_template_name);
  for (let k = mods.length - 1; k >= 0; k--)
    if (!used.has(mods[k].name)) return k;
  return mods.length - 1;
}

/** 모듈을 의존 순서로 (하위 먼저, top 마지막) 나열한다. */
export function moduleOrder(topology) {
  const mods = topology.modules ?? [];
  const byName = new Map(mods.map((m) => [m.name, m]));
  const out = [], seen = new Set();
  const visit = (name) => {
    if (seen.has(name) || !byName.has(name)) return;
    seen.add(name);
    for (const i of byName.get(name).instances ?? []) visit(i.abstract_template_name);
    out.push(name);
  };
  visit(mods[topIndex(topology)]?.name);
  for (const m of mods) visit(m.name);        // 고아 모듈도 빠뜨리지 않는다
  return out;
}

/** variant 를 고를 **단위**를 정한다.
 *
 *  블록 하나가 단위인 게 기본이지만, SymmetricBlocks 의 2 원소 쌍은 서로
 *  거울상이라 **같은 variant**를 써야 한다. 모양이 다르면 거울이 아니다.
 *  그래서 그런 쌍은 한 그룹으로 묶는다. 홑원소(자기대칭)는 자유다.
 *
 *  반환: [{ members:[인스턴스 번호...], abstract, choices:[concrete 이름...] }]
 *        choices 가 1 개인 그룹은 선택의 여지가 없다 (그래도 남겨둔다 —
 *        assignment 색인이 그룹 번호와 일치해야 읽기 쉽다).
 */
export function variantGroups(design) {
  const idx = new Map(design.instances.map((v, i) => [v.name, i]));
  const parent = design.instances.map((_, i) => i);
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  for (const c of design.constraints) {
    if (c.constraint !== "SymmetricBlocks") continue;
    for (const pair of c.pairs ?? []) {
      const ids = pair.map((p) => idx.get(p)).filter((v) => v !== undefined);
      // 거울 쌍만 묶는다. 홑원소는 묶을 상대가 없다.
      if (ids.length === 2) union(ids[0], ids[1]);
    }
  }

  const groups = new Map();
  design.instances.forEach((inst, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { members: [], abstract: inst.abstract });
    groups.get(r).members.push(i);
  });

  const out = [];
  for (const g of groups.values()) {
    // 한 그룹 안의 인스턴스는 같은 abstract 여야 같은 variant 를 공유할 수 있다.
    const abs = new Set(g.members.map((i) => design.instances[i].abstract));
    if (abs.size !== 1) {
      // 서로 다른 abstract 가 대칭 쌍으로 묶인 경우(있을 수 있다) — 각자 고른다.
      for (const i of g.members)
        out.push({ members: [i], abstract: design.instances[i].abstract,
                   choices: design.byAbstract.get(design.instances[i].abstract).map((c) => c.name) });
      continue;
    }
    out.push({ members: g.members.slice().sort((a, b) => a - b),
               abstract: g.abstract,
               choices: design.byAbstract.get(g.abstract).map((c) => c.name) });
  }
  out.sort((a, b) => a.members[0] - b.members[0]);
  return out;
}

export function countAssignments(groups) {
  return groups.reduce((s, g) => s * Math.max(1, g.choices.length), 1);
}

/** 조합을 전부 나열한다. 실측: 예제 5 개가 2 / 4 / 8 / 8 / 60 개다.
 *  (커지면 sampleAssignment 로 뽑는다) */
export function* enumerateAssignments(groups) {
  const k = groups.map((g) => Math.max(1, g.choices.length));
  const a = new Array(groups.length).fill(0);
  for (;;) {
    yield a.slice();
    let i = groups.length - 1;
    while (i >= 0 && ++a[i] >= k[i]) { a[i] = 0; i--; }
    if (i < 0) return;
  }
}

export function sampleAssignment(groups, rand) {
  return groups.map((g) => Math.floor(rand() * Math.max(1, g.choices.length)));
}

/** 사용자가 고정한 variant 를 그룹에 박는다 — 그 그룹의 후보를 그것 하나로 줄인다.
 *
 *  fixed = { 인스턴스 이름: concrete }. 편집기의 "variant 고정" 이 만들고, 배치기(placeDesign 의 fixedVariants)와
 *  편집기의 variant 다시 고르기가 같이 쓴다. 후보에 없는 이름은 무시한다 (예: 다른 모듈의 인스턴스). 거울 쌍은
 *  한 그룹이라 한쪽만 고정해도 둘 다 그 variant 다. 고정이 없으면 그룹을 그대로 돌려준다 — 배치기 길은 안 바뀐다.
 */
export function restrictGroups(groups, fixed, design) {
  if (!fixed || !Object.keys(fixed).length) return groups;
  return groups.map((g) => {
    for (const m of g.members) {
      const c = fixed[design.instances[m].name];
      if (c && g.choices.includes(c)) return { ...g, choices: [c], fixed: true };
    }
    return g;
  });
}

/** 배정 하나를 실제 배치 문제로 편다.
 *
 *  flips 를 주면 인스턴스별 [sx, sy] 를 쓴다 (거울 반전). 크기는 안 변하고
 *  핀 오프셋의 부호만 바뀐다. 안 주면 전부 +1.
 */
export function buildProblem(design, groups, assignment, { flips = null } = {}) {
  const n = design.instances.length;
  const concrete = new Array(n);
  groups.forEach((g, gi) => {
    const pick = g.choices[Math.min(assignment[gi] ?? 0, g.choices.length - 1)];
    for (const m of g.members) concrete[m] = pick;
  });

  const names = [], w = [], h = [], sx = [], sy = [];
  const keep = [];
  design.instances.forEach((inst, i) => {
    const t = design.info.get(concrete[i]);
    if (!t) return;                       // 템플릿 JSON 이 없으면 뺀다
    keep.push(i);
    names.push(inst.name); w.push(t.w); h.push(t.h);
    sx.push(flips ? flips[i][0] : 1); sy.push(flips ? flips[i][1] : 1);
  });

  const skip = powerGroundNets(design.constraints);
  const pinInst = [], pinOffPairs = [], pinNetRaw = [];
  const netId = new Map(), netNames = [];
  keep.forEach((i, k) => {
    const t = design.info.get(concrete[i]);
    const fa = design.instances[i].fa;
    for (const [formal, off] of t.pins) {
      const net = fa.get(formal);
      if (net == null || skip.has(String(net).toUpperCase())) continue;
      if (!netId.has(net)) { netId.set(net, netNames.length); netNames.push(net); }
      pinInst.push(k); pinOffPairs.push(off); pinNetRaw.push(netId.get(net));
    }
  });

  // 핀이 하나뿐인 넷은 길이가 0 이라 기여가 없다. 빼서 계산을 줄인다.
  const cnt = new Array(netNames.length).fill(0);
  for (const e of pinNetRaw) cnt[e]++;
  const remap = cnt.map(() => -1);
  let nNet = 0;
  cnt.forEach((c, e) => { if (c >= 2) remap[e] = nNet++; });

  const pi = [], po = [], pe = [], pn = [];
  pinNetRaw.forEach((e, p) => {
    if (remap[e] < 0) return;
    pi.push(pinInst[p]); po.push(pinOffPairs[p][0], pinOffPairs[p][1]); pn.push(remap[e]);
    pe.push(pinOffPairs[p][2] ?? 0, pinOffPairs[p][3] ?? 0);
  });

  return {
    names, keep, concrete: keep.map((i) => concrete[i]),
    n: names.length,
    w: Float64Array.from(w), h: Float64Array.from(h),
    sx: Float64Array.from(sx), sy: Float64Array.from(sy),
    pinInst: Int32Array.from(pi), pinOff: Float64Array.from(po),
    pinExt: Float64Array.from(pe),
    pinNet: Int32Array.from(pn), nNet,
    netNames: netNames.filter((_, e) => remap[e] >= 0),
    constraints: design.constraints,
    assignment: assignment.slice(),
  };
}

/** AspectRatio 제약의 [하한, 상한]. 없으면 null.
 *  ALIGN 은 폭/높이 비로 쓴다.
 */
export function arBounds(constraints) {
  for (const c of constraints ?? []) {
    if (c.constraint !== "AspectRatio") continue;
    const lo = Number(c.ratio_low), hi = Number(c.ratio_high);
    if (lo > 0 && hi >= lo) return [lo, hi];
  }
  return null;
}

/** 제약 구조에서 영역의 종횡비 힌트를 뽑는다.
 *
 *  두 가지를 함께 본다.
 *
 *  **(1) `Align h_*` 은 블록을 가로줄로 묶는다.** 같은 y 선을 공유하면 겹치지
 *  않는 한 옆으로 늘어설 수밖에 없다. 그래서 줄 안에서는 폭이 더해지고 높이는
 *  하나다. 이 줄을 하나의 **단위**로 본다. (`Align v_*` 은 세로줄이라 폭 최대·
 *  높이 합인데, 그건 아래 (2) 의 기본 동작과 같아서 따로 묶지 않는다.)
 *
 *  **(2) `SymmetricBlocks(V)` 의 자기대칭(홑원소)은 쌓인다.** 중심이 전부 같은
 *  세로축 위에 놓이므로 x 로 반드시 겹치고, 따라서 y 로 쌓인다.
 *  **거울 쌍은 쌓이지 않는다** — 축 좌우로 벌어져 나란히 설 수 있으므로 폭에만
 *  기여한다. (H 축 대칭이면 x 와 y 의 역할이 뒤바뀐다.)
 *
 *  쌓이는 것은 블록이 아니라 **단위**다. 이게 핵심이다.
 *
 *  ## 왜 이렇게까지 하나 — 실측
 *
 *  high_speed_comparator 는 `Align h_bottom` 이 두 줄을 만든다:
 *      X_MP9 X_MP7 XDP X_MP8 X_MP10  ->  6080 x 3528
 *      XINV_N XCCP XINV_P            ->  4800 x 2352
 *  그리고 XCCN, X_MN0 이 단독. 대칭 홑원소는 X_MN0/XDP/XCCN/XCCP 인데, XDP 는
 *  첫 줄에, XCCP 는 둘째 줄에 있다. 단위로 쌓으면
 *      폭 max(1760, 6080, 3520, 4800) = 6080
 *      높이 2352 + 3528 + 2352 + 2352  = 10584
 *  **ALIGN 이 낸 bbox 가 정확히 6080 x 10584 다.**
 *
 *  블록 단위로 쌓던 예전 식은 2560 x 25872 (ar 0.099) 를 냈다. ALIGN 의 0.574 는
 *  사다리(x1, x2, x4 = 0.099 ~ 0.396) 밖이라 **아예 닿지도 않았다.**
 *
 *  Align 이 없는 설계(telescopic_ota, current_mirror_ota, cascode)에서는 단위가
 *  블록 하나씩이라 예전 식과 같은 값이 나온다.
 *
 *  그래도 이건 정답이 아니라 **힌트**다. 대칭 그룹이 둘 이상이면 서로 옆에
 *  설 수도 있는데 이 식은 그걸 모른다. regionCandidates 가 힌트에서 출발해
 *  넓히는 쪽으로 사다리를 놓고, 어느 것이 좋은지는 점수가 고른다.
 */
export function structuralBound(problem) {
  const idx = new Map(problem.names.map((nm, i) => [nm, i]));
  const n = problem.n;

  // --- 가로줄 단위 만들기 (Align h_*) ---
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent[y] = x; };
  for (const c of problem.constraints) {
    if (c.constraint !== "Align") continue;
    const eq = ALIGN_EQ[c.line];
    if (!eq || eq[0] !== "y") continue;                 // h_* 만 (같은 y 선 = 가로줄)
    const ids = (c.instances ?? []).map((p) => idx.get(p)).filter((v) => v !== undefined);
    for (let k = 1; k < ids.length; k++) union(ids[0], ids[k]);
  }
  const uW = new Map(), uH = new Map();
  for (let i = 0; i < n; i++) {
    const u = find(i);
    uW.set(u, (uW.get(u) ?? 0) + problem.w[i]);         // 줄 안에서는 폭이 더해진다
    uH.set(u, Math.max(uH.get(u) ?? 0, problem.h[i]));  // 높이는 하나
  }
  const unitOf = (name) => {
    const i = idx.get(name);
    return i === undefined ? null : find(i);
  };

  // --- 대칭 논리를 단위 위에서 ---
  let bw = 0, bh = 0;
  for (const c of problem.constraints) {
    if (c.constraint !== "SymmetricBlocks") continue;
    const vert = (c.direction ?? "V") === "V";
    const cross = (u) => (vert ? uW.get(u) : uH.get(u));   // 거울축에 수직인 방향
    const span = (u) => (vert ? uH.get(u) : uW.get(u));    // 축 방향

    const stacked = new Set();
    const pairs = [];
    for (const pair of c.pairs ?? []) {
      const us = pair.map(unitOf).filter((u) => u !== null);
      if (!us.length) continue;
      if (us.length === 1) stacked.add(us[0]);
      else pairs.push([...new Set(us)]);
    }
    let gSpan = 0, gCross = 0;
    for (const u of stacked) { gSpan += span(u); gCross = Math.max(gCross, cross(u)); }
    for (const us of pairs) {
      // 쌍이 한 단위 안에 있으면 그 단위 폭에 이미 포함돼 있다. 두 단위로
      // 갈라져 있으면 축 좌우에 하나씩 서므로 폭이 더해진다. 높이는 한 층.
      const fresh = us.filter((u) => !stacked.has(u));
      if (!fresh.length) continue;
      gCross = Math.max(gCross, fresh.reduce((s, u) => s + cross(u), 0));
      gSpan = Math.max(gSpan, Math.max(...fresh.map(span)));
    }
    if (vert) { bw = Math.max(bw, gCross); bh = Math.max(bh, gSpan); }
    else { bw = Math.max(bw, gSpan); bh = Math.max(bh, gCross); }
  }
  return [bw, bh];
}

/** 영역 후보들. variant 배정마다 블록 크기가 달라지므로 영역도 같이 달라진다.
 *
 *  면적은 (블록 합계 면적 x slack) 이상으로 맞추고 **종횡비만** 바꿔 후보를 낸다.
 *
 *  종횡비는 구조 힌트에서 출발해 **넓히는 쪽으로만** 사다리를 놓는다.
 *  힌트가 "다 쌓인다"고 가정하므로 높이는 늘 과대평가, 폭은 과소평가이기
 *  때문이다. 실측으로도 ALIGN 의 종횡비는 힌트보다 항상 넓거나 같았다:
 *    telescopic_ota 힌트 0.153 / ALIGN 0.122    (거의 같다)
 *    five_transistor_ota  0.517 / 0.707
 *    cascode_..._ota      0.544 / 0.571
 *    high_speed_comparator 0.099 / 0.230        (힌트가 2.3 배 좁다)
 *
 *  ## 왜 아무 종횡비나 넣으면 안 되는가 (실측)
 *
 *  처음엔 [0.5, 1.0, 2.0] 을 고정으로 넣었다. telescopic_ota 에서 legalize 가
 *  후보 96 개 중 66 개에서 INFEASIBLE 이 났고, 실패가 **정사각·가로형에 전부**
 *  몰려 있었다:
 *      ar 0.10~0.15 (구조 힌트)   성공 3/3, 연속단계 겹침 0.12~0.25
 *      ar 0.92~2.00               성공 0/3, 겹침 0.49~0.84
 *  대칭이 블록을 한 축에 묶어 세로로 쌓게 만드는데 영역이 정사각이면 연속해가
 *  뭉개지고, 거기서 읽은 분리 방향은 실현 불가능해진다. 힌트 주변만 보는 게 맞다.
 */
export function regionCandidates(problem, { slack = 1.25, aspects = null,
                                            ladder = [1, 2, 4] } = {}) {
  let tot = 0;
  for (let i = 0; i < problem.n; i++) tot += problem.w[i] * problem.h[i];
  const want = tot * slack;

  const [bw, bh] = structuralBound(problem);
  let cand;
  if (aspects) cand = aspects.slice();
  else if (bw > 0 && bh > 0) cand = ladder.map((k) => (bw / bh) * k);
  else cand = [0.5, 1.0, 2.0];
  // 대칭이 하나도 없어 힌트가 안 나오는 설계에만 정사각을 넣는다.
  // 힌트가 있는데 정사각을 끼워 넣으면 legalize 가 전부 실패하는 후보를
  // 만들어 시간만 버린다 (telescopic_ota 에서 ar>=0.4 는 0/3 이었다).
  if (!aspects && bw <= 0) cand.push(1.0);

  // AspectRatio 제약이 있으면 그게 곧 영역 종횡비의 정답 범위다. 추측할 이유가 없다.
  // (cascode_current_mirror_ota 가 ratio_low 0.5 / ratio_high 2 를 건다.
  //  ALIGN 은 이걸 PlacementCoreAspectRatio_ILP 라는 전용 ILP 로 푼다.)
  const ar = arBounds(problem.constraints);
  if (ar) {
    const [lo, hi] = ar;
    cand = cand.map((v) => Math.min(hi, Math.max(lo, v)));
    for (const v of [lo, Math.sqrt(lo * hi), hi]) cand.push(v);
  }

  const maxW = Math.max(...problem.w), maxH = Math.max(...problem.h);
  const seen = new Set();
  const out = [];
  for (const ar of cand) {
    if (!(ar > 0) || !Number.isFinite(ar)) continue;
    let W = Math.sqrt(want * ar), H = want / W;
    W = Math.max(W, maxW); H = Math.max(H, maxH);   // 블록이 못 들어가면 무의미
    const key = `${Math.round(W)}x${Math.round(H)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([0, 0, W, H]);
  }
  return out;
}

/** 문제 + 영역 -> 최적화 목적함수. subspace 와 Objective 를 엮는 자리다.
 *
 *  대칭 계 A z = b 는 **블록 크기에 의존한다** (Align 의 모서리 정렬이 w/2, h/2 를
 *  쓴다). 그래서 variant 가 바뀌면 z0 와 N 도 다시 만들어야 한다. 배정마다
 *  이 함수를 새로 부르는 이유다.
 */
export function makeObjective(problem, region, { M = 48 } = {}) {
  const sizes = new Map(problem.names.map((n, i) => [n, [problem.w[i], problem.h[i]]]));
  const { sysm, skipped } = buildSystem(problem.constraints, problem.names, sizes);
  const { A, b } = sysm.matrices();
  const { N, rank } = nullspaceOf(A);
  const z0 = particularOf(A, b);
  const obj = new Objective({
    z0, N, nInst: problem.n, w: problem.w, h: problem.h,
    pinInst: problem.pinInst, pinOff: problem.pinOff, pinNet: problem.pinNet,
    pinExt: problem.pinExt ?? null,
    nNet: problem.nNet, region, M, sx: problem.sx, sy: problem.sy,
  });
  return { obj, z0, N, A, b, rank, skipped };
}

/** 거울 반전(flip)의 자유도를 제약에서 읽어낸다.
 *
 *  블록은 자기 중심에 대해 x / y 로 뒤집힐 수 있다 (transformation 의 sX, sY).
 *  크기는 안 변하고 **핀 위치만** 바뀌므로, 영공간도 밀도도 면적도 그대로고
 *  배선길이만 달라진다. variant 와 같은 종류의 이산 선택인데 훨씬 싸다.
 *
 *  ALIGN 의 telescopic_ota 결과를 보면 sX 는 전부 +1 인데 sY 는 PMOS 두 개가
 *  -1 이다. 우연이 아니다 — 세로축 대칭 아래서는 x 반전이 제약에 묶인다:
 *
 *    자기대칭(홑원소): 블록 자체가 x 대칭이므로 x 반전은 자기 자신.
 *                      건드리면 핀만 엉뚱하게 움직인다 -> sX 고정.
 *    거울 쌍(A,B)   : B 는 A 의 x 거울이어야 하므로 sX_B = -sX_A (한 비트).
 *                      y 는 둘이 **같아야** 거울이 유지된다 (또 한 비트).
 *    대칭 밖 블록    : x, y 둘 다 자유.
 *
 *  가로축 대칭(H)이면 x 와 y 의 역할이 뒤바뀐다.
 *
 *  반환: 그룹마다 { members, xFree, yFree, xSign[], ySign[] }.
 *  자유 비트 bx, by (+-1) 를 주면 sx[member_k] = (xFree ? bx : 1) * xSign[k].
 */
export function flipPlan(design, groups) {
  const roleOf = new Map();            // 인스턴스 -> {vert, pairIdx, pairLen}
  const idx = new Map(design.instances.map((v, i) => [v.name, i]));
  for (const c of design.constraints) {
    if (c.constraint !== "SymmetricBlocks") continue;
    const vert = (c.direction ?? "V") === "V";
    for (const pair of c.pairs ?? []) {
      const ids = pair.map((p) => idx.get(p)).filter((v) => v !== undefined);
      ids.forEach((i, k) => roleOf.set(i, { vert, k, len: ids.length }));
    }
  }

  return groups.map((g) => {
    const xSign = [], ySign = [];
    let xFree = true, yFree = true;
    g.members.forEach((m, k) => {
      const r = roleOf.get(m);
      if (!r) { xSign.push(1); ySign.push(1); return; }      // 대칭 밖 — 둘 다 자유
      if (r.len === 1) {
        // 자기대칭: 거울축 방향의 반전은 의미가 없고 핀만 망친다
        if (r.vert) { xFree = false; xSign.push(1); ySign.push(1); }
        else { yFree = false; xSign.push(1); ySign.push(1); }
      } else {
        // 거울 쌍: 거울축 방향은 서로 반대, 나머지 축은 같아야 한다
        if (r.vert) { xSign.push(k === 0 ? 1 : -1); ySign.push(1); }
        else { xSign.push(1); ySign.push(k === 0 ? 1 : -1); }
      }
    });
    return { members: g.members.slice(), xFree, yFree, xSign, ySign };
  });
}

/** \`Order\` 제약을 legalize 가 쓸 "강제 방향" 표로 바꾼다.
 *
 *  Order 는 등식이 아니라 **부등식**이라 영공간 매개화에 못 넣는다. 대신
 *  legalize 가 이미 쌍마다 분리 방향(왼/오/아래/위)을 고르고 있으므로,
 *  그 선택을 **연속해에서 읽는 대신 제약이 정해주게** 하면 된다.
 *  새 솔버도, 새 변수도 필요 없다 — 이미 있는 LP 에 방향만 박는다.
 *
 *  legalize 의 방향 부호 (src/legalize.mjs):
 *      0: i 가 j 의 왼쪽   1: i 가 j 의 오른쪽
 *      2: i 가 j 의 아래   3: i 가 j 의 위
 *
 *  순서는 추이적이므로 이웃 쌍만이 아니라 **모든 쌍**을 박는다
 *  (A 가 B 위, B 가 C 위 -> A 가 C 위). LP 에 줄이 몇 개 더 늘지만
 *  탐색 공간은 그만큼 줄고, 연속해가 순서를 어겨도 바로잡힌다.
 *
 *  \`abut: true\` (맞닿아야 함) 는 아직 안 다룬다 — 그건 분리 부등식이 아니라
 *  등식이라 영공간 쪽 일이다. 지금 예제에서는 전부 false 다.
 *
 *  반환: Map<"i,j", dir>  (i < j 로 정규화된 키)
 */
export function orderDirections(constraints, names) {
  const idx = new Map(names.map((n, i) => [n, i]));
  const out = new Map();
  for (const c of constraints ?? []) {
    if (c.constraint !== "Order") continue;
    const dir = String(c.direction ?? "left_to_right");
    // 가로냐 세로냐, 그리고 목록 순서가 증가 방향이냐
    let axis, firstIsLow;
    if (dir === "left_to_right" || dir === "horizontal") { axis = "x"; firstIsLow = true; }
    else if (dir === "right_to_left") { axis = "x"; firstIsLow = false; }
    else if (dir === "top_to_bottom" || dir === "vertical") { axis = "y"; firstIsLow = false; }
    else if (dir === "bottom_to_top") { axis = "y"; firstIsLow = true; }
    else continue;                                   // 모르는 방향은 건드리지 않는다

    const ids = (c.instances ?? []).map((n) => idx.get(n));
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const p = ids[a], q = ids[b];                // p 가 목록에서 앞
        if (p === undefined || q === undefined || p === q) continue;
        // p 가 q 보다 "낮은 쪽"(firstIsLow) 인가
        const pLow = firstIsLow;
        const i = Math.min(p, q), j = Math.max(p, q);
        // 키는 (i,j) 로 정규화하되 방향은 p/q 기준으로 뒤집어 맞춘다
        const pIsI = p === i;
        let d;
        if (axis === "x") d = (pLow === pIsI) ? 0 : 1;   // 0: i 가 j 의 왼쪽
        else d = (pLow === pIsI) ? 2 : 3;                // 2: i 가 j 의 아래
        out.set(`${i},${j}`, d);
      }
    }
  }
  return out;
}
