/** 겹침 제거 (legalization) — theta 공간에서 푼다.
 *  gpuplace/legalize.py 의 이식이되, MILP 가 아니라 LP 로 푼다.
 *
 *  핵심은 파이썬과 같다: 변수를 x 가 아니라 theta 로 둔다.
 *  x 공간에서 블록을 밀면 대칭이 깨지지만, theta 공간에서는 어떻게 움직여도
 *  x = z0 + N theta 가 제약을 만족한다.
 *
 *  다른 점 하나. 파이썬은 쌍마다 "왼/오/아래/위" 넷 중 하나를 고르는
 *  이진변수를 두어 MILP 로 푼다. 여기서는 그 방향을 연속해에서 읽어 고정한다.
 *  연속 최적화가 이미 배치를 거의 정해놓았으므로, 각 쌍에서 가장 적게
 *  밀어도 되는 방향을 고르면 그게 연속해가 의도한 배치다. 이진변수가
 *  사라지고 남는 것은 LP 뿐이라 브라우저에 solver wasm 을 싣지 않아도 된다.
 *
 *  대신 파이썬과 같은 답이 나오지는 않는다 — MILP 는 쌍의 관계를 뒤집을 수도
 *  있기 때문이다. 그래서 검사는 값 비교가 아니라 성질로 한다:
 *  겹침 정확히 0, 대칭 잔차 ~0, 이동거리가 크지 않을 것.
 */
import { solveLP } from "./lp.mjs";

/** 블록 쌍의 실제 겹침 면적 합. density overflow 와 달리 근사가 아니다. */
export function exactOverlap(cx, cy, w, h) {
  let tot = 0;
  for (let i = 0; i < cx.length; i++)
    for (let j = i + 1; j < cx.length; j++) {
      const ox = Math.min(cx[i] + w[i] / 2, cx[j] + w[j] / 2)
               - Math.max(cx[i] - w[i] / 2, cx[j] - w[j] / 2);
      const oy = Math.min(cy[i] + h[i] / 2, cy[j] + h[j] / 2)
               - Math.max(cy[i] - h[i] / 2, cy[j] - h[j] / 2);
      if (ox > 0 && oy > 0) tot += ox * oy;
    }
  return tot;
}

/** 두 블록의 좌표차가 theta 로 움직일 수 있는지 본다.
 *  대칭 쌍은 축에 대한 거울이라 세로 대칭이면 cy 가 항상 정확히 같다.
 *  그런 쌍에 "위/아래" 분리를 걸면 어떤 theta 로도 만족할 수 없어
 *  LP 가 통째로 INFEASIBLE 이 된다 (실제로 12건 중 7건이 그랬다).
 *  계수행이 0 이면 그 차이는 상수이므로, 상수만 보고 가부를 판정한다.
 *  반환: {movable, constDiff}
 */
function diffRow(z0, N, P, a, b) {
  let nz = 0;
  for (let k = 0; k < P; k++) {
    const d = N.data[a * P + k] - N.data[b * P + k];
    if (Math.abs(d) > 1e-12) { nz = 1; break; }
  }
  return { movable: nz === 1, constDiff: z0[a] - z0[b] };
}

/** 각 쌍의 분리 방향을 연속해에서 고른다.
 *  네 방향의 "침범량"을 재서 가장 작은 것을 고르되,
 *  theta 로 실현할 수 없는 방향은 후보에서 뺀다.
 *  0: i 가 j 의 왼쪽, 1: 오른쪽, 2: 아래, 3: 위
 *
 *  forced 가 있으면(`Order` 제약에서 온다) 그 쌍은 고르지 않고 박는다.
 *  Order 는 부등식이라 영공간에 못 넣지만, 여기서는 이미 방향을 고르고 있으므로
 *  **연속해에서 읽는 대신 제약이 정해주게** 하면 된다. 새 변수도 솔버도 없다.
 *  박은 방향이 실현 불가능하면 -1 로 두어 legalize 가 NODIRECTION 으로
 *  실패하게 한다 — 조용히 무시하면 제약을 어긴 배치가 나간다.
 */
export function chooseDirections(cx, cy, w, h, z0 = null, N = null, forced = null) {
  const n = cx.length, dirs = [];
  const P = N ? N.cols : 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const need = [(w[i] + w[j]) / 2, (w[i] + w[j]) / 2, (h[i] + h[j]) / 2, (h[i] + h[j]) / 2];
      const v = [
        (cx[i] + w[i] / 2) - (cx[j] - w[j] / 2),
        (cx[j] + w[j] / 2) - (cx[i] - w[i] / 2),
        (cy[i] + h[i] / 2) - (cy[j] - h[j] / 2),
        (cy[j] + h[j] / 2) - (cy[i] - h[i] / 2),
      ];
      // 실현 가능성: dir 0/1 은 X_i - X_j, dir 2/3 은 Y_i - Y_j 를 쓴다
      const feasible = [true, true, true, true];
      if (z0 && N) {
        const dx = diffRow(z0, N, P, 2 * i, 2 * j);
        const dy = diffRow(z0, N, P, 2 * i + 1, 2 * j + 1);
        if (!dx.movable) {
          feasible[0] = dx.constDiff <= -need[0] + 1e-9;
          feasible[1] = -dx.constDiff <= -need[1] + 1e-9;
        }
        if (!dy.movable) {
          feasible[2] = dy.constDiff <= -need[2] + 1e-9;
          feasible[3] = -dy.constDiff <= -need[3] + 1e-9;
        }
      }
      const fix = forced?.get(`${i},${j}`);
      if (fix !== undefined) {
        dirs.push({ i, j, dir: feasible[fix] ? fix : -1, forced: true });
        continue;
      }
      let k = -1;
      for (let q = 0; q < 4; q++) if (feasible[q] && (k < 0 || v[q] < v[k])) k = q;
      if (k < 0) { dirs.push({ i, j, dir: -1 }); continue; }   // 어느 방향도 불가
      // 두 번째로 적게 미는 방향도 남긴다 — refineDirections 가 뒤집어 볼 후보다.
      // gap 은 "그쪽으로 가면 얼마나 더 밀어야 하나" 를 그 방향의 필요 거리로 나눈 것.
      let alt = -1;
      for (let q = 0; q < 4; q++) if (q !== k && feasible[q] && (alt < 0 || v[q] < v[alt])) alt = q;
      dirs.push({ i, j, dir: k, alt, gap: alt < 0 ? Infinity : (v[alt] - v[k]) / need[alt] });
    }
  return dirs;
}

/** 분리 방향을 몇 개 뒤집어 보며 더 나은 legalize 를 찾는다.
 *
 *  legalize 는 연속해에서 읽은 방향을 **박고** LP 를 푼다. 연속해가 두 블록을
 *  나란히 놓았으면 LP 는 그 둘을 위아래로 못 옮긴다 — 그래서 후보의 면적이
 *  "그 배정의 면적" 이 아니라 "그 표본이 우연히 도달한 면적" 이 된다
 *  (symplace/PLAN-place-variants-gpu.md 2.3 절). ALIGN 은 위상(수열쌍)마다
 *  ILP 로 압축해 이 문제가 없다. 여기서는 그 값싼 대체로, 침범량이 비슷했던
 *  쌍(gap 이 작은 순)의 방향을 하나씩 뒤집어 LP 를 다시 풀고, evaluate 가 준
 *  점수가 좋아지면 받는다. 상위 후보 몇 개에만 쓴다 — LP 가 후보당 수십 ms 다.
 *
 *  args 는 legalize 의 인자 (dirs 는 여기서 넣는다). evaluate(r) 은 OPTIMAL 인
 *  결과의 점수 (낮을수록 좋다). 반환 { r, score, dirs, flips } — flips 는 받은 뒤집기 수.
 */
export function refineDirections(args, dirs, evaluate, { maxFlips = 6 } = {}) {
  let cur = legalize({ ...args, dirs });
  if (cur.status !== "OPTIMAL") return null;
  let curScore = evaluate(cur);
  let flips = 0;
  const order = dirs.map((d, idx) => ({ idx, gap: d.gap ?? Infinity }))
    .filter((c) => dirs[c.idx].alt >= 0 && !dirs[c.idx].forced && Number.isFinite(c.gap))
    .sort((a, b) => a.gap - b.gap).slice(0, maxFlips);
  for (const c of order) {
    const trial = dirs.map((d) => ({ ...d }));
    const d = trial[c.idx];
    [d.dir, d.alt] = [d.alt, d.dir];
    const r = legalize({ ...args, dirs: trial });
    if (r.status !== "OPTIMAL") continue;
    const s = evaluate(r);
    if (s < curScore - 1e-9) { cur = r; curScore = s; dirs = trial; flips++; }
  }
  return { r: cur, score: curScore, dirs, flips };
}

/**
 * 연속해를 겹치지 않는 배치로 옮긴다.
 *
 * 목적함수 = 연속해로부터의 이동거리(L1) + bboxWeight * n * 반둘레
 * 이동거리를 줄이는 이유는 연속 최적화가 찾아낸 배선 구조를 지키기 위해서다.
 * 반둘레는 선형이라 LP 에 그대로 들어간다 (면적은 쌍선형이라 못 쓴다).
 *
 * @returns {{status, theta, cx, cy}}  실패하면 theta 는 null
 */
export function legalize({ z0, N, n, w, h, cxRef, cyRef, region,
                           bboxWeight = 0.5, slack = 1.6, dirs = null,
                           forced = null, grid = null, anchors = null,
                           gridTries = 60, gap = [0, 0] }) {
  const [gx, gy] = gap;                 // 블록 사이 최소 간격 (design.mjs blockSpacing)
  const P = N.cols;
  const [x0, y0, x1, y1] = region;
  const W = x1 - x0, H = y1 - y0;
  // 원래 영역만 고집하면 풀 수 없을 수 있다. 여유를 주고, 대신 반둘레를
  // 목적함수에 넣어 알아서 줄이게 한다.
  const ex = ((slack - 1) * W) / 2, ey = ((slack - 1) * H) / 2;
  const rx0 = x0 - ex, rx1 = x1 + ex, ry0 = y0 - ey, ry1 = y1 + ey;
  const span = Math.max(W, H);
  const TH = 8 * span;

  // 변수 배치: [theta+ (P) | theta- (P) | dx (n) | dy (n) | uxlo uxhi uylo uyhi
  //             | kx+ (n) kx- (n) ky+ (n) ky- (n)]   <- 격자를 쓸 때만
  //
  // 격자는 ALIGN 배선기가 요구한다. 블록 원점 oX 가 금속 pitch 의 배수여야
  // 하고(M1 80, M2 84), 아니면 "Wire to color is offgrid" 로 배선을 거부한다.
  //     X_i - ax_i = qx * kx_i,   kx_i 정수      (ax = sX * (tx0+tx1)/2)
  // 풀고 나서 반올림하면 안 된다 — 대칭이 깨지고 없앴던 겹침이 되살아난다.
  // theta 는 계속 연속 변수라 z = z0 + N theta 가 대칭을 그대로 지킨다.
  // k 는 부호가 있으므로 k+ - k- 로 쪼갠다 (심플렉스는 x >= 0 만 다룬다).
  const useGrid = !!(grid && anchors);
  const nk = useGrid ? n : 0;
  const iTp = 0, iTm = P, iDx = 2 * P, iDy = 2 * P + n, iBox = 2 * P + 2 * n;
  const iKxp = iBox + 4, iKxm = iKxp + nk, iKyp = iKxm + nk, iKym = iKyp + nk;
  const nv = 2 * P + 2 * n + 4 + 4 * nk;

  // X_i = z0[2i] + sum_k N[2i][k] (theta+_k - theta-_k)
  const coefXY = (i, xy) => {
    const r = new Float64Array(nv);
    const row = 2 * i + xy;
    for (let k = 0; k < P; k++) {
      const a = N.data[row * P + k];
      r[iTp + k] = a;
      r[iTm + k] = -a;
    }
    return { r, c: z0[row] };
  };
  const CX = [], CY = [];
  for (let i = 0; i < n; i++) { CX.push(coefXY(i, 0)); CY.push(coefXY(i, 1)); }

  const D = dirs ?? chooseDirections(cxRef, cyRef, w, h, z0, N, forced);
  for (const d of D)
    if (d.dir < 0) return { status: "NODIRECTION", theta: null, cx: null, cy: null };

  let A = [], b = [];
  /** sum(terms) <= rhs 를 추가한다. terms 는 [계수행, 상수] 목록과 스칼라 항. */
  const add = (build, rhs) => {
    const row = new Float64Array(nv);
    let cst = 0;
    build((src, s) => {
      if (typeof src === "number") { row[src] += s; return; }
      for (let k = 0; k < nv; k++) row[k] += s * src.r[k];
      cst += s * src.c;
    });
    A.push(Array.from(row));
    b.push(rhs - cst);
  };
  /** 등식은 부등식 두 개로. */
  const eq = (build, rhs) => {
    add(build, rhs);
    add((t) => build((src, s) => t(src, -s)), -rhs);
  };

  /** 제약계를 처음부터 다시 만든다. fixed 는 "x3"/"y7" -> 정수. */
  const buildAll = (fixed) => {
  A = []; b = [];

  // 1) 영역 안에
  for (let i = 0; i < n; i++) {
    add((t) => t(CX[i], -1), -(rx0 + w[i] / 2));      // X_i >= rx0 + w/2
    add((t) => t(CX[i], +1), rx1 - w[i] / 2);
    add((t) => t(CY[i], -1), -(ry0 + h[i] / 2));
    add((t) => t(CY[i], +1), ry1 - h[i] / 2);
  }

  // 2) 쌍마다 분리 — 방향은 연속해에서 고정
  for (const { i, j, dir } of D) {
    if (dir === 0)      add((t) => { t(CX[i], +1); t(CX[j], -1); }, -(w[i] + w[j]) / 2 - gx);
    else if (dir === 1) add((t) => { t(CX[j], +1); t(CX[i], -1); }, -(w[i] + w[j]) / 2 - gx);
    else if (dir === 2) add((t) => { t(CY[i], +1); t(CY[j], -1); }, -(h[i] + h[j]) / 2 - gy);
    else                add((t) => { t(CY[j], +1); t(CY[i], -1); }, -(h[i] + h[j]) / 2 - gy);
  }

  // 3) 이동거리 (L1): dx_i >= |X_i - cxRef_i|
  for (let i = 0; i < n; i++) {
    add((t) => { t(CX[i], +1); t(iDx + i, -1); }, cxRef[i]);
    add((t) => { t(CX[i], -1); t(iDx + i, -1); }, -cxRef[i]);
    add((t) => { t(CY[i], +1); t(iDy + i, -1); }, cyRef[i]);
    add((t) => { t(CY[i], -1); t(iDy + i, -1); }, -cyRef[i]);
  }

  // 4) 반둘레. xlo = rx0 + uxlo 등으로 두어 모든 변수를 >= 0 으로 만든다.
  for (let i = 0; i < n; i++) {
    add((t) => { t(iBox + 0, +1); t(CX[i], -1); }, -w[i] / 2 - rx0);   // xlo <= X-w/2
    add((t) => { t(CX[i], +1); t(iBox + 1, -1); }, -w[i] / 2 + rx0);   // X+w/2 <= xhi
    add((t) => { t(iBox + 2, +1); t(CY[i], -1); }, -h[i] / 2 - ry0);
    add((t) => { t(CY[i], +1); t(iBox + 3, -1); }, -h[i] / 2 + ry0);
  }
  add((t) => t(iBox + 0, 1), rx1 - rx0);
  add((t) => t(iBox + 1, 1), rx1 - rx0);
  add((t) => t(iBox + 2, 1), ry1 - ry0);
  add((t) => t(iBox + 3, 1), ry1 - ry0);

  // 5) theta 범위 (유계 보장)
  for (let k = 0; k < P; k++) {
    add((t) => t(iTp + k, 1), TH);
    add((t) => t(iTm + k, 1), TH);
  }

  // 6) 격자: X_i - ax_i = qx (kx+_i - kx-_i)
  if (useGrid) {
    const [qx, qy] = grid, [ax, ay] = anchors;
    const KB = Math.ceil((Math.abs(rx0) + Math.abs(rx1) + Math.abs(ry0) + Math.abs(ry1))
                         / Math.min(qx, qy)) + 10;
    for (let i = 0; i < n; i++) {
      const fx = fixed?.get("x" + i), fy = fixed?.get("y" + i);
      if (fx === undefined)
        eq((t) => { t(CX[i], 1); t(iKxp + i, -qx); t(iKxm + i, qx); }, ax[i]);
      else                                   // 가지치기로 고정된 k
        eq((t) => t(CX[i], 1), ax[i] + qx * fx);
      if (fy === undefined)
        eq((t) => { t(CY[i], 1); t(iKyp + i, -qy); t(iKym + i, qy); }, ay[i]);
      else
        eq((t) => t(CY[i], 1), ay[i] + qy * fy);
      add((t) => t(iKxp + i, 1), KB); add((t) => t(iKxm + i, 1), KB);
      add((t) => t(iKyp + i, 1), KB); add((t) => t(iKym + i, 1), KB);
    }
  }
  };  // buildAll 끝

  const c = new Float64Array(nv);
  for (let i = 0; i < n; i++) { c[iDx + i] = 1; c[iDy + i] = 1; }
  const bw = bboxWeight * n;
  c[iBox + 0] = -bw; c[iBox + 1] = bw;      // xhi - xlo
  c[iBox + 2] = -bw; c[iBox + 3] = bw;      // yhi - ylo

  const solve = (fixed) => { buildAll(fixed); return solveLP(c, A, Float64Array.from(b)); };

  let r = solve(null);
  if (r.status !== "OPTIMAL") return { status: r.status, theta: null, cx: null, cy: null };

  // --- 격자: 분기한정(다이빙) ---
  //
  // LP 완화해의 k 는 대체로 정수에서 멀지 않다. 가장 분수적인 것부터 반올림해
  // 고정하고 다시 푼다. 막히면 반대쪽으로 한 번 더 시도하고, 그것도 막히면
  // 한 단계 되짚는다. 블록 11 개면 정수 22 개라 몇 번이면 끝난다.
  if (useGrid) {
    const [qx, qy] = grid, [ax, ay] = anchors;
    const kOf = (x, i, axis) => (axis === "x"
      ? x[iKxp + i] - x[iKxm + i] : x[iKyp + i] - x[iKym + i]);
    const fixed = new Map();
    const stack = [];                      // [key, 시도한 값들]
    let ok = false;
    for (let it = 0; it < gridTries; it++) {
      // 가장 분수적인 자유 변수
      let key = null, val = 0, worst = 1e-7;
      for (let i = 0; i < n; i++)
        for (const axis of ["x", "y"]) {
          const k = axis + i;
          if (fixed.has(k)) continue;
          const v = kOf(r.x, i, axis);
          const f = Math.abs(v - Math.round(v));
          if (f > worst) { worst = f; key = k; val = v; }
        }
      if (!key) { ok = true; break; }      // 전부 정수 — 끝
      const near = Math.round(val);
      fixed.set(key, near);
      stack.push([key, [near]]);
      let rr = solve(fixed);
      while (rr.status !== "OPTIMAL" && stack.length) {
        const [k2, tried] = stack[stack.length - 1];
        const alt = tried[0] + (tried.length === 1
          ? (val > tried[0] ? 1 : -1) : (tried.length === 2 ? -2 : 0));
        if (tried.length >= 3) { stack.pop(); fixed.delete(k2); }
        else { tried.push(alt); fixed.set(k2, alt); }
        rr = solve(fixed);
        if (!stack.length) break;
      }
      if (rr.status !== "OPTIMAL") return { status: "GRID_INFEASIBLE", theta: null, cx: null, cy: null };
      r = rr;
    }
    if (!ok) return { status: "GRID_TRIES", theta: null, cx: null, cy: null };
  }

  const theta = new Float64Array(P);
  for (let k = 0; k < P; k++) theta[k] = r.x[iTp + k] - r.x[iTm + k];
  const cx = new Float64Array(n), cy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sx = z0[2 * i], sy = z0[2 * i + 1];
    for (let k = 0; k < P; k++) {
      sx += N.data[(2 * i) * P + k] * theta[k];
      sy += N.data[(2 * i + 1) * P + k] * theta[k];
    }
    cx[i] = sx; cy[i] = sy;
  }
  return { status: "OPTIMAL", theta, cx, cy, dirs: D };
}
