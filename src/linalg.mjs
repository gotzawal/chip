/** 작은 조밀행렬 몇 가지. 여기서 다루는 크기는
 *  제약행렬 A 가 수십 x 수십, 밀도격자가 48 x 48 정도라
 *  외부 라이브러리 없이 충분하다. 행 우선(row-major) Float64Array.
 *
 *  나중에 WebGPU 로 옮길 때 이 표현이 그대로 버퍼가 된다.
 */

export class Mat {
  constructor(rows, cols, data) {
    this.rows = rows;
    this.cols = cols;
    this.data = data ?? new Float64Array(rows * cols);
  }
  static from(arr2d) {
    const r = arr2d.length, c = r ? arr2d[0].length : 0;
    const m = new Mat(r, c);
    for (let i = 0; i < r; i++) m.data.set(arr2d[i], i * c);
    return m;
  }
  static zeros(r, c) { return new Mat(r, c); }
  static eye(n) {
    const m = new Mat(n, n);
    for (let i = 0; i < n; i++) m.data[i * n + i] = 1;
    return m;
  }
  get(i, j) { return this.data[i * this.cols + j]; }
  set(i, j, v) { this.data[i * this.cols + j] = v; }
  row(i) { return this.data.subarray(i * this.cols, (i + 1) * this.cols); }
  toArray() {
    const out = [];
    for (let i = 0; i < this.rows; i++) out.push(Array.from(this.row(i)));
    return out;
  }
  transpose() {
    const t = new Mat(this.cols, this.rows);
    for (let i = 0; i < this.rows; i++)
      for (let j = 0; j < this.cols; j++) t.data[j * this.rows + i] = this.data[i * this.cols + j];
    return t;
  }
}

/** C = A B */
export function matmul(A, B) {
  if (A.cols !== B.rows) throw new Error(`matmul 크기 불일치 ${A.rows}x${A.cols} * ${B.rows}x${B.cols}`);
  const C = new Mat(A.rows, B.cols);
  const { rows: n, cols: k } = A, m = B.cols;
  for (let i = 0; i < n; i++) {
    const ai = i * k, ci = i * m;
    for (let p = 0; p < k; p++) {
      const a = A.data[ai + p];
      if (a === 0) continue;
      const bp = p * m;
      for (let j = 0; j < m; j++) C.data[ci + j] += a * B.data[bp + j];
    }
  }
  return C;
}

/** y = A x  (x, y 는 평범한 Float64Array) */
export function matvec(A, x) {
  const y = new Float64Array(A.rows);
  for (let i = 0; i < A.rows; i++) {
    let s = 0;
    const ai = i * A.cols;
    for (let j = 0; j < A.cols; j++) s += A.data[ai + j] * x[j];
    y[i] = s;
  }
  return y;
}

/** y = A^T x */
export function matTvec(A, x) {
  const y = new Float64Array(A.cols);
  for (let i = 0; i < A.rows; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    const ai = i * A.cols;
    for (let j = 0; j < A.cols; j++) y[j] += A.data[ai + j] * xi;
  }
  return y;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a) { return Math.sqrt(dot(a, a)); }

/** 수정 Gram-Schmidt 로 벡터 목록을 정규직교화한다.
 *  norm 이 tol 아래로 떨어지면 종속으로 보고 버린다.
 *  반환: {basis: Float64Array[], kept: number[]}
 */
export function orthonormalize(vectors, tol = 1e-10) {
  const basis = [], kept = [];
  let scale = 0;
  for (const v of vectors) scale = Math.max(scale, norm(v));
  const cut = tol * Math.max(scale, 1);
  for (let idx = 0; idx < vectors.length; idx++) {
    const v = Float64Array.from(vectors[idx]);
    // 두 번 빼면 직교성이 훨씬 안정적이다 (재직교화)
    for (let pass = 0; pass < 2; pass++)
      for (const q of basis) {
        const c = dot(v, q);
        for (let i = 0; i < v.length; i++) v[i] -= c * q[i];
      }
    const nv = norm(v);
    if (nv <= cut) continue;
    for (let i = 0; i < v.length; i++) v[i] /= nv;
    basis.push(v);
    kept.push(idx);
  }
  return { basis, kept };
}

/** 대칭 양정치 작은 계를 가우스 소거로 푼다 (부분 피벗). */
export function solveDense(Ain, bin) {
  const n = Ain.rows;
  const A = Float64Array.from(Ain.data);
  const b = Float64Array.from(bin);
  for (let col = 0; col < n; col++) {
    let piv = col, best = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * n + col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-300) continue;             // 특이 — 해당 자유도는 0 으로 둔다
    if (piv !== col) {
      for (let j = 0; j < n; j++) {
        const t = A[col * n + j]; A[col * n + j] = A[piv * n + j]; A[piv * n + j] = t;
      }
      const t = b[col]; b[col] = b[piv]; b[piv] = t;
    }
    const d = A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] / d;
      if (f === 0) continue;
      for (let j = col; j < n; j++) A[r * n + j] -= f * A[col * n + j];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const d = A[i * n + i];
    if (Math.abs(d) < 1e-300) { x[i] = 0; continue; }
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i * n + j] * x[j];
    x[i] = s / d;
  }
  return x;
}
