/** 작은 선형계획 풀이 (2단계 원시 심플렉스, Bland 규칙).
 *
 *  legalization 은 원래 MILP 다 — 쌍마다 "왼/오/아래/위" 넷 중 하나를 고르는
 *  이진변수가 붙는다. 그런데 연속 최적화가 이미 배치를 거의 정해놓았으므로,
 *  각 쌍의 분리 방향을 연속해에서 읽어 고정하면 이진변수가 전부 사라지고
 *  남는 것은 LP 뿐이다. 브라우저에 3MB 짜리 solver wasm 을 싣지 않아도 된다.
 *
 *  Bland 규칙을 쓰는 이유는 순환을 막기 위해서다. 느리지만 우리 크기
 *  (변수 수십, 제약 수백)에서는 문제가 안 되고, 끝난다는 보장이 있다.
 *
 *  형식:  minimize c^T x   subject to   A x <= b,  x >= 0
 *  자유변수는 호출하는 쪽에서 x = x+ - x- 로 쪼개 넣는다.
 */

const TOL = 1e-9;

/**
 * @param {Float64Array} c      목적함수 계수 (길이 n)
 * @param {number[][]}   A      제약 행렬 (m x n)
 * @param {Float64Array} b      우변 (길이 m)
 * @returns {{status: string, x: Float64Array, obj: number}}
 */
export function solveLP(c, A, b) {
  const m = A.length;
  const n = c.length;
  if (m === 0) return { status: "OPTIMAL", x: new Float64Array(n), obj: 0 };

  // --- 표준형으로: 각 행에 여유변수를 붙이고, b < 0 인 행은 부호를 뒤집는다.
  //     뒤집힌 행은 여유변수 계수가 -1 이 되어 기저가 못 되므로 인공변수를 단다.
  const rows = [];
  const needArtificial = [];
  for (let i = 0; i < m; i++) {
    const flip = b[i] < 0;
    const row = new Float64Array(n + m);       // [실변수 | 여유변수]
    for (let j = 0; j < n; j++) row[j] = flip ? -A[i][j] : A[i][j];
    row[n + i] = flip ? -1 : 1;
    rows.push({ row, rhs: flip ? -b[i] : b[i] });
    needArtificial.push(flip);
  }
  const nArt = needArtificial.filter(Boolean).length;
  const total = n + m + nArt;                  // [실 | 여유 | 인공]

  // 표: (m+1) x (total+1). 마지막 행이 목적함수, 마지막 열이 우변.
  const T = [];
  for (let i = 0; i < m; i++) {
    const t = new Float64Array(total + 1);
    t.set(rows[i].row, 0);
    t[total] = rows[i].rhs;
    T.push(t);
  }
  const basis = new Int32Array(m);
  let ai = 0;
  for (let i = 0; i < m; i++) {
    if (needArtificial[i]) {
      T[i][n + m + ai] = 1;
      basis[i] = n + m + ai;
      ai++;
    } else {
      basis[i] = n + i;
    }
  }

  const pivot = (T, basis, mRows, cols, prow, pcol) => {
    const pv = T[prow][pcol];
    for (let j = 0; j <= cols; j++) T[prow][j] /= pv;
    for (let i = 0; i <= mRows; i++) {
      if (i === prow) continue;
      const f = T[i][pcol];
      if (f === 0) continue;
      for (let j = 0; j <= cols; j++) T[i][j] -= f * T[prow][j];
    }
    basis[prow] = pcol;
  };

  /** 목적행(T[m])을 기준으로 최적이 될 때까지 피벗한다.
   *  allowed(j) 가 false 인 열은 절대 기저에 들이지 않는다. */
  const run = (allowed) => {
    for (let guard = 0; guard < 20000; guard++) {
      // Bland: 계수가 음수인 열 중 가장 작은 인덱스
      let pcol = -1;
      for (let j = 0; j < total; j++) {
        if (!allowed(j)) continue;
        if (T[m][j] < -TOL) { pcol = j; break; }
      }
      if (pcol < 0) return "OPTIMAL";
      // 비율 검정, 동률이면 기저변수 인덱스가 가장 작은 행 (Bland)
      let prow = -1, bestRatio = Infinity, bestBasis = Infinity;
      for (let i = 0; i < m; i++) {
        const a = T[i][pcol];
        if (a <= TOL) continue;
        const r = T[i][total] / a;
        if (r < bestRatio - TOL || (Math.abs(r - bestRatio) <= TOL && basis[i] < bestBasis)) {
          bestRatio = r; bestBasis = basis[i]; prow = i;
        }
      }
      if (prow < 0) return "UNBOUNDED";
      pivot(T, basis, m, total, prow, pcol);
    }
    return "ITERLIMIT";
  };

  // --- 1단계: 인공변수의 합을 최소화 ---
  if (nArt > 0) {
    const obj = new Float64Array(total + 1);
    for (let j = n + m; j < total; j++) obj[j] = 1;
    T.push(obj);
    // 기저에 있는 인공변수를 목적행에서 소거한다
    for (let i = 0; i < m; i++) {
      if (basis[i] >= n + m) {
        for (let j = 0; j <= total; j++) T[m][j] -= T[i][j];
      }
    }
    const st1 = run(() => true);
    if (st1 === "ITERLIMIT") return { status: "ITERLIMIT", x: null, obj: NaN };
    if (-T[m][total] > 1e-7) return { status: "INFEASIBLE", x: null, obj: NaN };

    // 기저에 남은 인공변수를 실변수로 밀어낸다 (퇴화 행)
    for (let i = 0; i < m; i++) {
      if (basis[i] < n + m) continue;
      let pcol = -1;
      for (let j = 0; j < n + m; j++) if (Math.abs(T[i][j]) > TOL) { pcol = j; break; }
      if (pcol < 0) continue;               // 중복 제약 행 — 그대로 둔다
      pivot(T, basis, m, total, i, pcol);
    }
    T.pop();
  }

  // --- 2단계: 원래 목적함수 ---
  const obj = new Float64Array(total + 1);
  for (let j = 0; j < n; j++) obj[j] = c[j];
  T.push(obj);
  for (let i = 0; i < m; i++) {
    const cb = basis[i] < n ? c[basis[i]] : 0;
    if (cb === 0) continue;
    for (let j = 0; j <= total; j++) T[m][j] -= cb * T[i][j];
  }
  // 인공변수는 다시 0 밖으로 나오면 안 된다
  const st2 = run((j) => j < n + m);
  if (st2 !== "OPTIMAL") return { status: st2, x: null, obj: NaN };

  const x = new Float64Array(n);
  for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = T[i][total];
  let val = 0;
  for (let j = 0; j < n; j++) val += c[j] * x[j];
  return { status: "OPTIMAL", x, obj: val };
}
