/** 등식 제약을 A z = b 로 모으고, 영공간 매개화 z = z0 + N·theta 를 만든다.
 *  gpuplace/subspace.py 의 이식.
 *
 *  변수 순서: [cx_0, cy_0, cx_1, cy_1, ..., axis_0, axis_1, ...]
 *
 *  파이썬은 영공간을 SVD 로 구하지만 여기서는 Gram-Schmidt 로 구한다.
 *  영공간 기저는 유일하지 않으므로(같은 부분공간의 아무 정규직교 기저나 된다)
 *  두 결과가 원소까지 같을 필요는 없다. 검사는 값 비교가 아니라 성질로 한다:
 *    A (z0 + N theta) = b  (임의의 theta 에 대해),  N^T N = I,  dim = n - rank.
 */
import { Mat, matmul, matvec, matTvec, orthonormalize, solveDense } from "./linalg.mjs";

// Align 의 *_any 는 "겹치기만 하면 된다"는 부등식이라 등식 계에 넣으면 안 된다.
export const ALIGN_EQ = {
  h_top:    ["y", "max"],
  h_bottom: ["y", "min"],
  h_center: ["y", "center"],
  v_left:   ["x", "min"],
  v_right:  ["x", "max"],
  v_center: ["x", "center"],
};

export class System {
  constructor(instNames, nAxis) {
    this.inst = new Map(instNames.map((n, i) => [n, i]));
    this.nInst = instNames.length;
    this.nAxis = nAxis;
    this.n = 2 * this.nInst + nAxis;
    this.rows = [];
    this.rhs = [];
    this.why = [];
  }
  cx(name) { return 2 * this.inst.get(name); }
  cy(name) { return 2 * this.inst.get(name) + 1; }
  axis(k) { return 2 * this.nInst + k; }

  add(terms, rhs, why) {
    const r = new Float64Array(this.n);
    for (const [c, v] of terms) r[c] += v;
    this.rows.push(r);
    this.rhs.push(rhs);
    this.why.push(why);
  }
  matrices() {
    const A = new Mat(this.rows.length, this.n);
    for (let i = 0; i < this.rows.length; i++) A.data.set(this.rows[i], i * this.n);
    return { A, b: Float64Array.from(this.rhs) };
  }
}

/** 제약 목록에서 등식 계를 만든다.
 *  sizes: Map<name, [w, h]> — 배치된 크기(상수).
 */
export function build(constraints, instNames, sizes) {
  const sym = constraints.filter((c) => c.constraint === "SymmetricBlocks");
  const sysm = new System(instNames, sym.length);
  const skipped = [];

  sym.forEach((c, k) => {
    const v = (c.direction ?? "V") === "V";        // V: 세로축(x 가 거울)
    const mirror = v ? (n) => sysm.cx(n) : (n) => sysm.cy(n);
    const same = v ? (n) => sysm.cy(n) : (n) => sysm.cx(n);
    const a = sysm.axis(k);

    for (let pair of c.pairs) {
      pair = pair.filter((p) => sysm.inst.has(p));
      if (pair.length === 1) {
        // 자기대칭: 중심이 축 위에 있어야 한다
        sysm.add([[mirror(pair[0]), 1.0], [a, -1.0]], 0.0,
                 `SymmetricBlocks[${k}] self ${pair[0]}`);
      } else if (pair.length === 2) {
        const [A_, B_] = pair;
        // 거울 쌍: 축에서 같은 거리, 반대편
        sysm.add([[mirror(A_), 1.0], [mirror(B_), 1.0], [a, -2.0]], 0.0,
                 `SymmetricBlocks[${k}] pair ${A_}~${B_}`);
        sysm.add([[same(A_), 1.0], [same(B_), -1.0]], 0.0,
                 `SymmetricBlocks[${k}] same ${A_}~${B_}`);
      }
    }
  });

  for (const c of constraints) {
    if (c.constraint !== "Align") continue;
    const line = c.line;
    if (!(line in ALIGN_EQ)) {
      skipped.push([c.constraint, String(line), "등식이 아님(겹침 조건)"]);
      continue;
    }
    const [axisXY, kind] = ALIGN_EQ[line];
    const names = c.instances.filter((i) => sysm.inst.has(i));
    if (names.length < 2) continue;
    const col = axisXY === "x" ? (n) => sysm.cx(n) : (n) => sysm.cy(n);
    const dim = axisXY === "x" ? 0 : 1;

    // 중심 기준 상수 오프셋. 중심이면 0, 최소variant 면 -w/2, 최대variant 면 +w/2
    const edgeOffset = (n) => {
      const half = sizes.get(n)[dim] / 2;
      return kind === "center" ? 0.0 : kind === "min" ? -half : +half;
    };

    const ref = names[0];
    for (const n of names.slice(1)) {
      // c_ref + off_ref = c_n + off_n  ->  c_ref - c_n = off_n - off_ref
      sysm.add([[col(ref), 1.0], [col(n), -1.0]],
               edgeOffset(n) - edgeOffset(ref),
               `Align(${line}) ${ref}~${n}`);
    }
  }
  return { sysm, skipped };
}

/** A 의 영공간 기저 N (n x (n-rank)) 과 랭크.
 *  A 의 행들을 정규직교화해 행공간 Q 를 얻고, 표준기저를 Q 에서 떼어내
 *  남는 방향을 모은다.
 */
export function nullspace(A, tol = 1e-10) {
  const n = A.cols;
  if (A.rows === 0) return { N: Mat.eye(n), rank: 0 };

  const rows = [];
  for (let i = 0; i < A.rows; i++) rows.push(A.row(i));
  const { basis: Q } = orthonormalize(rows, tol);
  const rank = Q.length;

  const cand = [];
  for (let j = 0; j < n; j++) {
    const e = new Float64Array(n);
    e[j] = 1;
    cand.push(e);
  }
  // Q 를 먼저 넣고 표준기저를 이어 붙이면, 살아남는 것이 곧 영공간 기저다.
  const { basis } = orthonormalize([...Q, ...cand], tol);
  const nullBasis = basis.slice(rank);

  const N = new Mat(n, nullBasis.length);
  for (let j = 0; j < nullBasis.length; j++)
    for (let i = 0; i < n; i++) N.data[i * N.cols + j] = nullBasis[j][i];
  return { N, rank };
}

/** A z = b 의 최소노름 해.
 *  독립인 행들만 남기면 A_S z = b_S 의 해집합이 같고(계가 무모순일 때),
 *  최소노름 해는 z = A_S^T (A_S A_S^T)^{-1} b_S 다.
 */
export function particular(A, b) {
  const n = A.cols;
  if (A.rows === 0) return new Float64Array(n);

  const rows = [];
  for (let i = 0; i < A.rows; i++) rows.push(A.row(i));
  const { kept } = orthonormalize(rows, 1e-10);
  if (kept.length === 0) return new Float64Array(n);

  const As = new Mat(kept.length, n);
  const bs = new Float64Array(kept.length);
  kept.forEach((r, i) => { As.data.set(A.row(r), i * n); bs[i] = b[r]; });

  const G = matmul(As, As.transpose());       // (k x k), 대칭 양정치
  const y = solveDense(G, bs);
  return matTvec(As, y);                       // z = A_S^T y
}

/** z = z0 + N theta */
export function toZ(z0, N, theta) {
  const z = Float64Array.from(z0);
  const Nt = matvec(N, theta);
  for (let i = 0; i < z.length; i++) z[i] += Nt[i];
  return z;
}
