/** 파이썬 구현과 JS 이식을 대조한다.
 *
 *  두 가지를 나눠 본다.
 *   1) 값 대조 — 파이썬이 뽑아둔 z0/N/lam/mu 를 그대로 써서 같은 매개화 위에서
 *      E, grad, W, D, B, 면적, box, overflow 가 일치하는지.
 *   2) 성질 검사 — 영공간 기저는 유일하지 않으므로 JS 가 스스로 만든 N 은
 *      값이 아니라 성질로 확인한다: A(z0+N theta)=b, N^T N=I, dim=n-rank.
 *
 *  실행:  node test/parity.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mat, matmul, matvec } from "../../../../src/linalg.mjs";
import { build, nullspace, particular, toZ } from "../../../../src/subspace.mjs";
import { Objective, area, boundary, wirelength, checkGrad } from "../../../../src/energy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "..", "fixtures");

let failures = 0;
const fmt = (x) => (Number.isFinite(x) ? x.toExponential(2) : String(x));

function rel(a, b) {
  const s = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return Math.abs(a - b) / s;
}
function relVec(a, b) {
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, rel(a[i], b[i]));
  return worst;
}
function check(name, got, tol) {
  const ok = got <= tol;
  if (!ok) failures++;
  console.log(`    ${ok ? "OK  " : "FAIL"} ${name.padEnd(34)} ${fmt(got)}  (허용 ${fmt(tol)})`);
  return ok;
}

for (const file of fs.readdirSync(FIX).filter((f) => f.endsWith(".json"))) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, file), "utf8"));
  console.log(`\n### ${fx.example}  블록 ${fx.n} 넷 ${fx.n_net} 핀 ${fx.pin_inst.length}`);

  // ---------- 1) subspace: 값 대조(A, b) + 성질 검사(N) ----------
  const sizes = new Map(fx.names.map((nm, i) => [nm, [fx.w[i], fx.h[i]]]));
  const { sysm } = build(fx.constraints, fx.names, sizes);
  const { A, b } = sysm.matrices();
  const Apy = Mat.from(fx.A.length ? fx.A : [[]]);

  if (A.rows !== fx.A.length || (A.rows && A.cols !== fx.A[0].length)) {
    console.log(`    FAIL A 크기  JS ${A.rows}x${A.cols} vs PY ${fx.A.length}x${fx.A[0]?.length}`);
    failures++;
  } else {
    check("A 원소", A.rows ? relVec(A.data, Apy.data) : 0, 1e-12);
    check("b 원소", b.length ? relVec(b, Float64Array.from(fx.b)) : 0, 1e-12);
  }

  const { N, rank } = nullspace(A);
  const z0 = particular(A, b);
  check("rank 일치", Math.abs(rank - fx.rank), 0);
  check("자유도 일치", Math.abs(N.cols - fx.N[0].length), 0);

  // N^T N = I
  const NtN = matmul(N.transpose(), N);
  let offI = 0;
  for (let i = 0; i < NtN.rows; i++)
    for (let j = 0; j < NtN.cols; j++)
      offI = Math.max(offI, Math.abs(NtN.get(i, j) - (i === j ? 1 : 0)));
  check("N^T N = I", offI, 1e-10);

  // A (z0 + N theta) = b, 임의의 theta 에서
  if (A.rows) {
    let worst = 0;
    for (let t = 0; t < 3; t++) {
      const th = new Float64Array(N.cols);
      for (let i = 0; i < th.length; i++) th[i] = Math.sin(1 + i * 7.3 + t * 2.1) * 100;
      const res = matvec(A, toZ(z0, N, th));
      for (let i = 0; i < res.length; i++) worst = Math.max(worst, Math.abs(res[i] - b[i]));
    }
    const scale = Math.max(1, ...Array.from(b, Math.abs));
    check("A(z0+N theta) = b", worst / scale, 1e-9);
  }

  // ---------- 2) energy: 파이썬의 z0/N 을 그대로 써서 값 대조 ----------
  const Npy = Mat.from(fx.N);
  const obj = new Objective({
    z0: Float64Array.from(fx.z0), N: Npy, nInst: fx.n,
    w: Float64Array.from(fx.w), h: Float64Array.from(fx.h),
    pinInst: Int32Array.from(fx.pin_inst),
    pinOff: Float64Array.from(fx.pin_off.flat()),
    pinNet: Int32Array.from(fx.pin_net),
    nNet: fx.n_net, region: fx.region, M: fx.M,
    gamma: fx.gamma, beta: fx.beta,
    sx: Float64Array.from(fx.sx), sy: Float64Array.from(fx.sy),
  });
  obj.lam = fx.lam; obj.mu = fx.mu;

  check("밀도격자 Mx", Math.abs(obj.dens.Mx - fx.dens.Mx), 0);
  check("밀도격자 My", Math.abs(obj.dens.My - fx.dens.My), 0);
  check("격자 간격 hx", rel(obj.dens.hx, fx.dens.hx), 1e-14);
  check("격자 간격 hy", rel(obj.dens.hy, fx.dens.hy), 1e-14);

  fx.cases.forEach((c, ci) => {
    const th = Float64Array.from(c.theta);
    const r = obj.eval(th);
    console.log(`  -- case ${ci}`);
    check("중심 cx", relVec(r.cx, Float64Array.from(c.cx)), 1e-12);
    check("중심 cy", relVec(r.cy, Float64Array.from(c.cy)), 1e-12);
    check("배선 W", rel(r.W, c.W), 1e-11);
    check("밀도 D", rel(r.D, c.D), 1e-10);
    check("경계 B", rel(r.B, c.B), 1e-11);
    check("에너지 E", rel(r.E, c.E), 1e-10);
    check("기울기 grad", relVec(r.grad, Float64Array.from(c.grad)), 1e-8);
    const ar = area(r.cx, r.cy, Float64Array.from(fx.w), Float64Array.from(fx.h), fx.beta);
    check("면적 A", rel(ar.A, c.area), 1e-11);
    check("box", relVec(Float64Array.from(ar.box), Float64Array.from(c.box)), 1e-12);
    const of = obj.dens.overflow(r.cx, r.cy, Float64Array.from(fx.w), Float64Array.from(fx.h));
    check("overflow", rel(of, c.overflow), 1e-11);
  });

  // ---------- 3) JS 자체 기울기 검증 (유한차분) ----------
  const th0 = Float64Array.from(fx.cases[0].theta);
  check("유한차분 대조", checkGrad(obj, th0, 1e-3, 6), 1e-4);
}

console.log(failures === 0 ? "\n전부 통과" : `\n실패 ${failures}건`);
process.exit(failures === 0 ? 0 : 1);
