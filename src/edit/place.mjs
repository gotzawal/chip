/** 배치 편집 — 워커가 낸 배치를 페이지에서 고치고, 사용자가 정한 위상 안에서 다시 최적화한다.
 *
 *  배치기(src/place.mjs)는 좌표만 내보낸다. 편집에는 그 좌표를 낳은 **문제**가 필요하다 — 제약의 영공간
 *  z = z0 + N theta (끌기와 정리를 그 위에서 한다), variant 후보(variant 바꾸기), 반전 자유도(반전). 워커에서
 *  통째로 보내지 않고 앞단 출력과 편집 키트(계층 설계의 하위 모듈 variant 템플릿)로 **다시 짓는다** (rebuild).
 *  실측: 다시 지은 문제가 배치기 안의 문제와 이름·크기·핀이 같고, theta 를 되찾은 좌표 오차가 1e-12 아래다.
 *
 *  세 가지 일.
 *    끌기       dragTheta — 고정 좌표(대칭축, 잠근 블록)는 반드시 지키고, 끌 좌표는 최소제곱으로 맞춘다.
 *               theta 의 최소 노름 보정이라 거울 쌍은 거울로 따라오고 축 위 블록은 축을 따라서만 미끄러진다.
 *    정리       settle — 편집 좌표에서 쌍의 분리 방향을 읽어(그것이 위상이다) legalize 를 그대로 돌린다:
 *               겹침 0, 대칭 잔차 0, 격자, Order, 간격. 편집 좌표에서 덜 움직이고 반둘레를 줄인다.
 *    variant 다시  retryVariants — 같은 방향표로 배정을 전수 legalize 해 점수로 고른다. 사용자가 고정한 variant 는 그대로.
 *
 *  편집이 없으면 아무것도 안 한다 — 페이지의 배치·배선 길은 그대로다 (symplace/PLAN-edit.md).
 */
import { readDesign, topIndex, variantGroups, buildProblem, flipPlan, orderDirections, blockSpacing,
         enumerateAssignments, countAssignments, sampleAssignment, restrictGroups } from "../design.mjs";
import { build as buildSystem, nullspace, particular } from "../subspace.mjs";
import { legalize, chooseDirections, exactOverlap } from "../legalize.mjs";
import { exactArea, hpwl, refineFlips, scoreOf, rng } from "../solver.mjs";
import { axes, symmetryResidual, orderViolations, gridOffgrid, synthesizeTemplate, spreadShapes,
         SUB_VARIANTS } from "../place.mjs";

export const GRID = [80, 84];

// ---------------------------------------------------------------- 편집 키트

/** placeHierarchy 결과에서 편집 키트를 만든다 — job.mjs 가 done 메시지에 싣는다.
 *
 *  최상위 문제를 페이지에서 다시 지으려면 하위 모듈 variant(`<모듈>__v<k>`)의 템플릿이 필요하다. placeHierarchy 가
 *  상위에 등록한 것과 **같은 규칙**(spreadShapes, SUB_VARIANTS)으로 전부 다시 만든다 — 쓰인 것만이 아니라 후보
 *  전부를 넣어야 편집기가 variant 를 바꿔 볼 수 있다. 평면 설계는 비어 있다. hsc 에서 템플릿 4 개, 1.8 KB.
 */
export function editKit(hr, grid = GRID) {
  const topName = hr.order[hr.order.length - 1];
  const subPrimitives = {}, subTemplates = {};
  for (const [nm, m] of hr.modules) {
    if (nm === topName) continue;
    const picks = spreadShapes(m.alternatives ?? [m], SUB_VARIANTS);
    picks.forEach((pl, k) => {
      const cn = picks.length === 1 ? nm : `${nm}__v${k}`;
      subPrimitives[cn] = { abstract_template_name: nm, concrete_template_name: cn, x_cells: 1, y_cells: 1 };
      subTemplates[cn] = synthesizeTemplate(m.design, pl, grid);
    });
  }
  return { top: topName, grid, subPrimitives, subTemplates };
}

// ---------------------------------------------------------------- 문제 다시 짓기

/** 대칭 역할 — 이름 -> { k: 축 번호, vert, len: 1 자기대칭 / 2 거울 쌍, pos, pair } */
function roleMap(design) {
  const roles = new Map();
  let k = 0;
  for (const c of design.constraints ?? []) {
    if (c.constraint !== "SymmetricBlocks") continue;
    const vert = (c.direction ?? "V") === "V";
    for (const pair of c.pairs ?? []) pair.forEach((nm, pos) => roles.set(nm, { k, vert, len: pair.length, pos, pair }));
    k++;
  }
  return roles;
}

/**
 * 앞단 출력 + 편집 키트 + 지금 좌표(rects: done 메시지의 것과 같은 모양) -> 편집 모델.
 *
 * rects 의 concrete 로 variant 배정을 되찾고, 그 배정의 문제(크기·핀·넷)와 제약 영공간을 짓고, 좌표에서 theta 를
 * 되찾는다. 모델의 진실은 theta 와 반전(sx, sy)이고 rects 는 그것에서 다시 낸다 (toRects).
 */
export function rebuild(blob, kit, rects) {
  const top = kit?.top ?? blob.topology.modules[topIndex(blob.topology)].name;
  const design = readDesign({
    topology: blob.topology,
    primitives: { ...blob.primitives, ...(kit?.subPrimitives ?? {}) },
    templates: { ...blob.templates, ...(kit?.subTemplates ?? {}) },
    top,
  });
  if (design.missing.length) throw new Error(`편집 키트에 템플릿이 없는 인스턴스: ${design.missing.join(", ")}`);
  const groups = variantGroups(design);
  const byName = new Map(rects.map((r) => [r.name, r]));
  const assignment = groups.map((g) => {
    const r = byName.get(design.instances[g.members[0]].name);
    const i = r ? g.choices.indexOf(r.concrete) : -1;
    return i < 0 ? 0 : i;
  });
  const P = buildProblem(design, groups, assignment);
  const n = P.n;
  const cx = new Float64Array(n), cy = new Float64Array(n);
  const sx = new Float64Array(n), sy = new Float64Array(n);
  P.names.forEach((nm, i) => {
    const r = byName.get(nm);
    if (!r) throw new Error(`좌표가 없는 블록: ${nm}`);
    // 크기는 문제의 것 (variant 를 바꿨으면 rects 의 w/h 는 낡았다) — 중심은 그대로
    cx[i] = r.x + (r.w ?? P.w[i]) / 2; cy[i] = r.y + (r.h ?? P.h[i]) / 2;
    sx[i] = (r.sx ?? 1) > 0 ? 1 : -1; sy[i] = (r.sy ?? 1) > 0 ? 1 : -1;
  });
  const sizes = new Map(P.names.map((nm, i) => [nm, [P.w[i], P.h[i]]]));
  const { sysm } = buildSystem(P.constraints, P.names, sizes);
  const { A, b } = sysm.matrices();
  const { N } = nullspace(A);
  const z0 = particular(A, b);
  const model = {
    design, groups, assignment, P, N, z0, K: N.cols, n, nAxis: sysm.nAxis,
    names: P.names, idx: new Map(P.names.map((nm, i) => [nm, i])),
    forced: orderDirections(design.constraints, P.names), gap: blockSpacing(design.constraints),
    plan: flipPlan(design, groups), roles: roleMap(design), grid: kit?.grid ?? GRID,
    kit, sx, sy, theta: null,
  };
  model.theta = thetaOf(model, cx, cy, axes(P, cx, cy).map((a) => a.at));
  return model;
}

/** z = z0 + N theta */
export function zFromTheta(model, theta) {
  const { N, z0, K } = model;
  const z = Float64Array.from(z0);
  for (let r = 0; r < N.rows; r++) {
    let s = 0;
    const base = r * K;
    for (let k = 0; k < K; k++) s += N.data[base + k] * theta[k];
    z[r] += s;
  }
  return z;
}

/** 좌표(와 축 위치) -> theta. N 이 정규직교라 theta = N^T (z - z0) 가 최소제곱 사영이다.
 *  좌표가 제약을 지키면 정확히 되돌아온다 (실측 오차 1e-12 아래). */
export function thetaOf(model, cx, cy, axisAt = null) {
  const { N, z0, K, n, nAxis } = model;
  const z = Float64Array.from(z0);
  for (let i = 0; i < n; i++) { z[2 * i] = cx[i]; z[2 * i + 1] = cy[i]; }
  const ax = axisAt ?? axes(model.P, cx, cy).map((a) => a.at);
  for (let k = 0; k < nAxis; k++) z[2 * n + k] = ax[k] ?? z0[2 * n + k];
  const th = new Float64Array(K);
  for (let r = 0; r < N.rows; r++) {
    const d = z[r] - z0[r];
    if (d === 0) continue;
    const base = r * K;
    for (let k = 0; k < K; k++) th[k] += N.data[base + k] * d;
  }
  return th;
}

/** theta -> 중심 좌표와 축 위치 */
export function centers(model, theta = model.theta) {
  const z = zFromTheta(model, theta);
  const { n, nAxis } = model;
  const cx = new Float64Array(n), cy = new Float64Array(n), ax = new Float64Array(nAxis);
  for (let i = 0; i < n; i++) { cx[i] = z[2 * i]; cy[i] = z[2 * i + 1]; }
  for (let k = 0; k < nAxis; k++) ax[k] = z[2 * n + k];
  return { cx, cy, ax };
}

// ---------------------------------------------------------------- 끌기

/**
 * 끌기 = 고정 좌표는 **반드시** 지키고, 끌 좌표는 최소제곱으로 — theta 의 최소 노름 보정.
 *
 *   pins  : [행 번호, ...]          고정할 z 의 행 (축 2n+k, 잠근 블록의 2i, 2i+1). 값은 지금 그대로.
 *   drags : [[행 번호, 목표값], ...]  끌 좌표
 *
 *   1) 고정 행들의 N 행을 정규직교화해 "고정 좌표를 바꾸는 방향" Q 를 얻는다.
 *   2) 끌기 행에서 Q 성분(과 앞선 끌기 방향)을 뺀다. 남는 것이 없으면 그 좌표는 잠겨 있다 —
 *      축 위 블록을 축에 수직으로 끌면 그렇다. 그때는 그 성분을 버리고 나머지(축 방향)만 따라간다.
 *   3) 남은 방향으로 목표에 맞춘다.
 *
 * 왜 최소제곱을 두 단계로 하나: 한 번에 풀면 고정 행과 끌기 행이 어긋날 때(축 위 블록을 옆으로 끌기) 어느 쪽을
 * 지킬지가 반올림에 달렸다. 실측으로 그 순서가 뒤집혀 축이 끌려간 적이 있다.
 */
export function dragTheta(model, theta, pins, drags) {
  const { N, K } = model;
  const row = (r) => Float64Array.from({ length: K }, (_, k) => N.data[r * K + k]);
  const dot = (a, b) => { let s = 0; for (let k = 0; k < K; k++) s += a[k] * b[k]; return s; };
  const Q = [];
  for (const r of pins) {
    const v = row(r);
    for (const q of Q) { const c = dot(v, q); for (let k = 0; k < K; k++) v[k] -= c * q[k]; }
    const nn = Math.sqrt(dot(v, v));
    if (nn > 1e-9) Q.push(v.map((x) => x / nn));
  }
  const zc = zFromTheta(model, theta);
  const out = Float64Array.from(theta);
  const B = [];
  for (const [r, target] of drags) {
    const v = row(r);
    for (const q of Q) { const c = dot(v, q); for (let k = 0; k < K; k++) v[k] -= c * q[k]; }
    for (const q of B) { const c = dot(v, q); for (let k = 0; k < K; k++) v[k] -= c * q[k]; }
    const nn = Math.sqrt(dot(v, v));
    if (nn < 1e-9) continue;                      // 잠긴 좌표
    const u = v.map((x) => x / nn);
    const rowN = row(r);
    let cur = zc[r];
    for (let k = 0; k < K; k++) cur += rowN[k] * (out[k] - theta[k]);
    const denom = dot(rowN, u);
    if (Math.abs(denom) < 1e-12) continue;
    const step = (target - cur) / denom;
    for (let k = 0; k < K; k++) out[k] += step * u[k];
    B.push(u);
  }
  return out;
}

/** 고정 행: 대칭축 전부(lockAxes) + 잠근 블록의 두 좌표 */
export function pinRows(model, { lockAxes = true, locked = null } = {}) {
  const rows = [];
  if (lockAxes) for (let k = 0; k < model.nAxis; k++) rows.push(2 * model.n + k);
  for (const nm of locked ?? []) {
    const i = model.idx.get(nm);
    if (i !== undefined) rows.push(2 * i, 2 * i + 1);
  }
  return rows;
}

/** 블록들을 (dx, dy) 만큼 끄는 목표 행. group 이면 그 블록이 속한 대칭 그룹의 축도 같이 (그룹째 옮기기). */
export function dragRows(model, names, dx, dy, cx, cy, ax, { group = false } = {}) {
  const drags = [];
  const seenAxis = new Set();
  for (const nm of names) {
    const i = model.idx.get(nm);
    if (i === undefined) continue;
    drags.push([2 * i, cx[i] + dx], [2 * i + 1, cy[i] + dy]);
    const role = model.roles.get(nm);
    if (group && role && !seenAxis.has(role.k)) {
      seenAxis.add(role.k);
      drags.push([2 * model.n + role.k, ax[role.k] + (role.vert ? dx : dy)]);
    }
  }
  return drags;
}

// ---------------------------------------------------------------- 편집 좌표의 성질

/** 쌍의 관계 (x: 0 왼 / 1 오 / -1 겹침, y: 2 아래 / 3 위 / -1 겹침) */
export function relations(model, cx, cy) {
  const { P, n } = model;
  const out = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const x = cx[i] + P.w[i] / 2 <= cx[j] - P.w[j] / 2 + 1e-6 ? 0 : cx[j] + P.w[j] / 2 <= cx[i] - P.w[i] / 2 + 1e-6 ? 1 : -1;
      const y = cy[i] + P.h[i] / 2 <= cy[j] - P.h[j] / 2 + 1e-6 ? 2 : cy[j] + P.h[j] / 2 <= cy[i] - P.h[i] / 2 + 1e-6 ? 3 : -1;
      out.push({ i, j, x, y });
    }
  return out;
}

/** 겹치는 블록 이름들과 겹친 쌍 수 */
export function overlapping(model, cx, cy) {
  const { P, n } = model;
  const names = new Set();
  let pairs = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const ox = Math.min(cx[i] + P.w[i] / 2, cx[j] + P.w[j] / 2) - Math.max(cx[i] - P.w[i] / 2, cx[j] - P.w[j] / 2);
      const oy = Math.min(cy[i] + P.h[i] / 2, cy[j] + P.h[j] / 2) - Math.max(cy[i] - P.h[i] / 2, cy[j] - P.h[j] / 2);
      if (ox > 1e-6 && oy > 1e-6) { names.add(P.names[i]); names.add(P.names[j]); pairs++; }
    }
  return { names, pairs };
}

/** 지표 — 배치기가 done 에 싣는 것과 같은 자로 */
export function measure(model, cx, cy, sx, sy, hpwlWeight = 1) {
  const { P } = model;
  const ea = exactArea(cx, cy, P.w, P.h);
  const hp = hpwl(cx, cy, P.pinInst, P.pinOff, P.pinNet, P.nNet, sx, sy, P.pinExt ?? null);
  const ov = exactOverlap(cx, cy, P.w, P.h);
  const orderBad = orderViolations(P, cx, cy);
  return { area: ea.area, box: ea.box, hpwl: hp, overlap: ov, resid: symmetryResidual(P, cx, cy),
           offgrid: gridOffgrid(P, cx, cy, sx, sy, model.grid), orderBad, score: scoreOf(ea.area, hp, hpwlWeight) };
}

/** 좌표 -> 페이지의 rects (원점을 0 으로 당긴다) + bbox + 축 + 지표. done 메시지에 덮어쓸 모양이다. */
export function toRects(model, cx, cy, sx, sy) {
  const { P } = model;
  const m = measure(model, cx, cy, sx, sy);
  const [ox0, oy0] = [m.box[0], m.box[1]];
  const rects = P.names.map((nm, i) => ({
    name: nm, concrete: P.concrete[i],
    x: cx[i] - P.w[i] / 2 - ox0, y: cy[i] - P.h[i] / 2 - oy0, w: P.w[i], h: P.h[i], sx: sx[i], sy: sy[i],
  }));
  return {
    rects, bbox: [0, 0, m.box[2] - ox0, m.box[3] - oy0],
    axes: axes(P, cx, cy).map((a) => ({ ...a, at: a.at - (a.vert ? ox0 : oy0) })),
    area: m.area, hpwl: m.hpwl, overlap: m.overlap, resid: m.resid, offgrid: m.offgrid,
    orderBad: m.orderBad.length, orderBadPairs: m.orderBad,
    nOrder: (P.constraints ?? []).filter((c) => c.constraint === "Order").length,
    score: m.score, grid: model.grid,
  };
}

// ---------------------------------------------------------------- 정리 (토폴로지 유지 최적화)

/** x·y 로 다 떨어진 쌍에 남은 관계도 박는다 (both). 더 엄격하고 덜 움직이지만 압축을 막는다. */
function secondRelations(model, dirs, cx, cy) {
  const rel = relations(model, cx, cy);
  const extra = [];
  rel.forEach((r, k) => {
    const d = dirs[k];
    if (r.x >= 0 && r.y >= 0 && !d.forced) extra.push({ i: d.i, j: d.j, dir: d.dir < 2 ? r.y : r.x });
  });
  return extra;
}

/**
 * 편집 좌표에서 쌍 관계를 읽어 박고 legalize 한다.
 *
 *   both     x·y 로 다 떨어진 쌍에 두 관계를 다 박는다 (기본 false — 하나만, 배치기와 같다)
 *   compact  반둘레의 무게 (legalize 의 bboxWeight). 0 이면 손댄 것만 고치고, 0.5 가 배치기 기본
 *   slack    영역 여유. INFEASIBLE 이면 retrySlack 으로 넓혀 다시, 그래도 안 되면 both 를 끄고 다시
 *
 * 반환 { status, cx, cy, theta, dirs, ms, orderBad, pairs }. NODIRECTION 이면 pairs 가 방향이 없는 쌍 이름.
 */
export function settle(model, cx, cy, sx, sy, { both = false, compact = 0.5, slack = 1.6, retrySlack = [3, 6] } = {}) {
  const t0 = performance.now();
  const { P, N, z0, n, forced, gap, grid } = model;
  const orderBad = orderViolations(P, cx, cy);
  const ea = exactArea(cx, cy, P.w, P.h);
  const region = ea.box.slice();
  // 블록 하나거나 한 줄이면 영역의 한 variant 0 일 수 있다 — legalize 의 여유가 0 이 되지 않게
  const span = Math.max(region[2] - region[0], region[3] - region[1], 1);
  if (region[2] - region[0] < 1e-9) region[2] = region[0] + span;
  if (region[3] - region[1] < 1e-9) region[3] = region[1] + span;
  const dirs = chooseDirections(cx, cy, P.w, P.h, z0, N, forced);
  const bad = dirs.filter((d) => d.dir < 0);
  if (bad.length)
    return { status: "NODIRECTION", pairs: bad.map((d) => [P.names[d.i], P.names[d.j]]), orderBad,
             ms: performance.now() - t0 };
  const all = both ? [...dirs, ...secondRelations(model, dirs, cx, cy)] : dirs;
  const anchors = [Array.from(P.w, (v, i) => (sx[i] > 0 ? 1 : -1) * v / 2),
                   Array.from(P.h, (v, i) => (sy[i] > 0 ? 1 : -1) * v / 2)];
  const args = { z0, N, n, w: P.w, h: P.h, cxRef: cx, cyRef: cy, region, forced, gap,
                 bboxWeight: compact, grid, anchors, dirs: all, slack };
  let r = legalize(args), used = slack, usedBoth = both;
  for (const sl of retrySlack) {
    if (r.status === "OPTIMAL") break;
    r = legalize({ ...args, slack: sl }); used = sl;
  }
  if (r.status !== "OPTIMAL" && both) {
    r = legalize({ ...args, dirs, slack: retrySlack[retrySlack.length - 1] }); usedBoth = false;
  }
  const ms = performance.now() - t0;
  if (r.status !== "OPTIMAL") return { status: r.status, orderBad, ms };
  return { status: "OPTIMAL", cx: r.cx, cy: r.cy, theta: r.theta, dirs: all, slack: used, both: usedBoth, orderBad, ms };
}

/** 반전을 다시 고른다 (좌표 고정, HPWL 만 본다) */
export function chooseFlips(model, cx, cy) {
  return refineFlips(model.P, model.plan, cx, cy);
}

/** 블록이 속한 반전 그룹의 한 비트를 뒤집는다. 제약에 묶여 못 뒤집으면 null. */
export function flipGroup(model, name, axis, sx, sy) {
  const i = model.idx.get(name);
  if (i === undefined) return null;
  const g = model.plan.find((p) => p.members.includes(i));
  if (!g) return null;
  if (axis === "x" && !g.xFree) return null;
  if (axis === "y" && !g.yFree) return null;
  const nsx = Float64Array.from(sx), nsy = Float64Array.from(sy);
  for (const m of g.members) {
    const pi = model.P.keep.indexOf(m);
    if (pi < 0) continue;
    if (axis === "x") nsx[pi] = -nsx[pi]; else nsy[pi] = -nsy[pi];
  }
  return { sx: nsx, sy: nsy, members: g.members.map((m) => model.design.instances[m].name) };
}

/** 블록의 반전 자유도 { xFree, yFree } */
export function flipFreedom(model, name) {
  const i = model.idx.get(name);
  const g = i === undefined ? null : model.plan.find((p) => p.members.includes(i));
  return g ? { xFree: g.xFree, yFree: g.yFree } : { xFree: false, yFree: false };
}

/** 블록의 variant 후보 { group, members, choices: [{concrete, w, h}], current } */
export function variantChoices(model, name) {
  const di = model.design.instances.findIndex((v) => v.name === name);
  const gi = model.groups.findIndex((g) => g.members.includes(di));
  if (gi < 0) return null;
  const g = model.groups[gi];
  const pi = model.idx.get(name);
  return {
    group: gi, members: g.members.map((m) => model.design.instances[m].name),
    choices: g.choices.map((c) => { const t = model.design.info.get(c); return { concrete: c, w: t?.w ?? 0, h: t?.h ?? 0 }; }),
    current: pi === undefined ? null : model.P.concrete[pi],
  };
}

/** variant 를 바꾼 rects — 그룹 구성원 전부, 중심은 그대로. 부르는 쪽이 rebuild 한다. */
export function withVariant(model, rects, name, concrete) {
  const vc = variantChoices(model, name);
  if (!vc || !vc.choices.some((c) => c.concrete === concrete)) return null;
  const t = model.design.info.get(concrete);
  return rects.map((r) => {
    if (!vc.members.includes(r.name)) return { ...r };
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    return { ...r, concrete, w: t.w, h: t.h, x: cx - t.w / 2, y: cy - t.h / 2 };
  });
}

// ---------------------------------------------------------------- variant 다시 고르기 (위상 유지)

function systemOf(P) {
  const sizes = new Map(P.names.map((nm, i) => [nm, [P.w[i], P.h[i]]]));
  const { sysm } = buildSystem(P.constraints, P.names, sizes);
  const { A, b } = sysm.matrices();
  return { N: nullspace(A).N, z0: particular(A, b) };
}

/**
 * 같은 위상(분리 방향표)에서 variant 배정을 전수로 legalize 해 줄 세운다.
 *
 *   fixed      { 인스턴스 이름: concrete } — 사용자가 고정한 variant. 그 그룹은 그것만 본다
 *   cap        배정이 이보다 많으면 추첨 (배치기와 같이 128)
 *   onProgress (done, total)
 *
 * 배정마다: 문제를 새로 짓고(z0 가 바뀐다, N 은 같다), 같은 쌍 번호의 방향을 박고, 격자 없이 legalize ->
 * 반전 고르기 -> 격자 legalize -> 점수. 지금 배정은 항등이라 지금 점수가 그대로 나온다.
 * 반환 { ranking: [{assignment, concrete, score, area, hpwl, bbox, out}], current, total, ms }
 */
export function retryVariants(model, cx, cy, sx, sy, { fixed = null, cap = 128, hpwlWeight = 1, compact = 0.5,
                                                        seed = 1, onProgress = null } = {}) {
  const t0 = performance.now();
  const { design, P, forced, gap, grid, plan } = model;
  const groups = restrictGroups(model.groups, fixed, design);
  const dirs0 = chooseDirections(cx, cy, P.w, P.h, model.z0, model.N, forced);
  const total = countAssignments(groups);
  let list;
  if (total <= cap) list = [...enumerateAssignments(groups)];
  else {
    const rand = rng(seed), seen = new Set();
    list = [];
    for (let g = 0; g < cap * 20 && list.length < cap; g++) {
      const a = sampleAssignment(groups, rand), k = a.join(",");
      if (!seen.has(k)) { seen.add(k); list.push(a); }
    }
  }
  // 지금 배정을 restrict 된 그룹의 색인으로
  const curKey = groups.map((g) => g.choices.indexOf(P.concrete[model.P.keep.indexOf(g.members[0])])).join(",");
  if (!list.some((a) => a.join(",") === curKey)) list.unshift(curKey.split(",").map(Number));
  const ranking = [];
  list.forEach((a, k) => {
    const Pq = buildProblem(design, groups, a);
    const { N, z0 } = systemOf(Pq);
    const dq = chooseDirections(cx, cy, Pq.w, Pq.h, z0, N, forced)
      .map((d, i) => ({ ...d, dir: dirs0[i].dir, forced: dirs0[i].forced }));
    if (dq.some((d) => d.dir < 0)) return;
    const ea = exactArea(cx, cy, Pq.w, Pq.h);
    const base = { z0, N, n: Pq.n, w: Pq.w, h: Pq.h, cxRef: cx, cyRef: cy, region: ea.box, forced, gap,
                   bboxWeight: compact, dirs: dq };
    let r = legalize({ ...base, slack: 1.6 });
    if (r.status !== "OPTIMAL") r = legalize({ ...base, slack: 3 });
    if (r.status !== "OPTIMAL") return;
    const fr = refineFlips(Pq, plan, r.cx, r.cy);
    const anchors = [Array.from(Pq.w, (v, i) => (fr.sx[i] > 0 ? 1 : -1) * v / 2),
                     Array.from(Pq.h, (v, i) => (fr.sy[i] > 0 ? 1 : -1) * v / 2)];
    const rg = legalize({ ...base, slack: 3, grid, anchors });
    if (rg.status !== "OPTIMAL") return;
    const mq = { ...model, P: Pq, N, z0 };
    const out = toRects(mq, rg.cx, rg.cy, fr.sx, fr.sy);
    ranking.push({ assignment: a, concrete: Pq.concrete.slice(), score: scoreOf(out.area, out.hpwl, hpwlWeight),
                   area: out.area, hpwl: out.hpwl, bbox: out.bbox, out, current: a.join(",") === curKey });
    if (onProgress) onProgress(k + 1, list.length);
  });
  ranking.sort((p, q) => p.score - q.score);
  return { ranking, current: ranking.findIndex((r) => r.current), total, tried: list.length,
           ms: performance.now() - t0 };
}
