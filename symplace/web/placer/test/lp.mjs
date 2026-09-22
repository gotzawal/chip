/** 심플렉스 검증.
 *
 *  손으로 쓴 심플렉스는 틀리기 쉽다. 두 가지로 확인한다.
 *   1) 답을 아는 작은 문제들
 *   2) 무작위 LP 를 꼭짓점 전수 열거와 대조 (변수 3개, 제약 6개면 가능하다)
 *
 *  실행:  node test/lp.mjs
 */
import { solveLP } from "../../../../src/lp.mjs";

let bad = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "OK  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
};
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

console.log("답을 아는 문제");

// max 3x+2y  s.t. x+y<=4, x+3y<=6, x<=3   ->  x=3,y=1, max=11
{
  const r = solveLP(Float64Array.from([-3, -2]),
                    [[1, 1], [1, 3], [1, 0]],
                    Float64Array.from([4, 6, 3]));
  ok("최대화 3x+2y", r.status === "OPTIMAL" && close(r.obj, -11),
     `obj=${r.obj.toFixed(4)} x=[${Array.from(r.x, (v) => v.toFixed(3))}]`);
}

// 1단계가 필요한 경우: min x+y  s.t. x+y>=2, x<=5, y<=5  -> 2
{
  const r = solveLP(Float64Array.from([1, 1]),
                    [[-1, -1], [1, 0], [0, 1]],
                    Float64Array.from([-2, 5, 5]));
  ok("1단계 필요 (x+y>=2)", r.status === "OPTIMAL" && close(r.obj, 2),
     `obj=${r.obj.toFixed(4)}`);
}

// 실행 불가능: x <= -1, x >= 0
{
  const r = solveLP(Float64Array.from([1]), [[1]], Float64Array.from([-1]));
  ok("실행 불가능 판정", r.status === "INFEASIBLE", r.status);
}

// 무한: min -x  s.t. -x <= 0
{
  const r = solveLP(Float64Array.from([-1]), [[-1]], Float64Array.from([0]));
  ok("무한 판정", r.status === "UNBOUNDED", r.status);
}

// 퇴화 (같은 꼭짓점을 여러 제약이 지난다)
{
  const r = solveLP(Float64Array.from([-1, -1]),
                    [[1, 1], [1, 1], [1, 0], [0, 1]],
                    Float64Array.from([2, 2, 2, 2]));
  ok("퇴화 문제", r.status === "OPTIMAL" && close(r.obj, -2), `obj=${r.obj.toFixed(4)}`);
}

// 자유변수를 x+ - x- 로 쪼갠 경우: min |x-3| 을 min d, d>=x-3, d>=3-x 로
{
  // 변수 [xp, xm, d],  x = xp - xm
  const r = solveLP(Float64Array.from([0, 0, 1]),
                    [[1, -1, -1], [-1, 1, -1], [1, -1, 0], [-1, 1, 0]],
                    Float64Array.from([3, -3, 10, 10]));
  ok("자유변수 분할 |x-3|", r.status === "OPTIMAL" && close(r.obj, 0, 1e-6),
     `obj=${r.obj.toExponential(2)} x=${(r.x[0] - r.x[1]).toFixed(4)}`);
}

console.log("\n무작위 LP 를 꼭짓점 전수 열거와 대조");
{
  // n=3 변수, m 제약 (x>=0 세 개 포함) -> 모든 3개 조합의 교점을 구해
  // 실행 가능한 것 중 최소를 찾는다. 유계가 되도록 상자를 씌운다.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let worst = 0, tested = 0, mismatch = 0;
  for (let trial = 0; trial < 60; trial++) {
    const n = 3, mm = 5;
    const A = [], b = new Float64Array(mm + n);
    for (let i = 0; i < mm; i++) {
      A.push([rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2]);
      b[i] = rnd() * 6 + 1;
    }
    for (let j = 0; j < n; j++) {            // 상자: x_j <= 10
      const r = [0, 0, 0]; r[j] = 1; A.push(r); b[mm + j] = 10;
    }
    const c = Float64Array.from([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]);

    // 전수 열거: A 행 3개 + (x_j = 0) 을 합친 초평면 집합에서 3개 고르기
    const planes = A.map((row, i) => ({ row, rhs: b[i] }));
    for (let j = 0; j < n; j++) {
      const r = [0, 0, 0]; r[j] = -1;
      planes.push({ row: r, rhs: 0 });
    }
    let bestBrute = Infinity;
    const P = planes.length;
    for (let i = 0; i < P; i++) for (let j = i + 1; j < P; j++) for (let k = j + 1; k < P; k++) {
      const M = [planes[i].row.slice(), planes[j].row.slice(), planes[k].row.slice()];
      const v = [planes[i].rhs, planes[j].rhs, planes[k].rhs];
      // 3x3 가우스 소거
      const det3 = (M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
                  - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
                  + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]));
      if (Math.abs(det3) < 1e-9) continue;
      const sol = [0, 0, 0];
      for (let col = 0; col < 3; col++) {
        const Mc = M.map((r, ri) => r.map((val, ci) => (ci === col ? v[ri] : val)));
        const d = (Mc[0][0] * (Mc[1][1] * Mc[2][2] - Mc[1][2] * Mc[2][1])
                 - Mc[0][1] * (Mc[1][0] * Mc[2][2] - Mc[1][2] * Mc[2][0])
                 + Mc[0][2] * (Mc[1][0] * Mc[2][1] - Mc[1][1] * Mc[2][0]));
        sol[col] = d / det3;
      }
      let feas = sol.every((s) => s >= -1e-7);
      if (feas) for (let r = 0; r < A.length; r++) {
        let s = 0;
        for (let q = 0; q < n; q++) s += A[r][q] * sol[q];
        if (s > b[r] + 1e-7) { feas = false; break; }
      }
      if (!feas) continue;
      let val = 0;
      for (let q = 0; q < n; q++) val += c[q] * sol[q];
      if (val < bestBrute) bestBrute = val;
    }

    const r = solveLP(c, A, b);
    tested++;
    if (r.status !== "OPTIMAL") { mismatch++; continue; }
    const d = Math.abs(r.obj - bestBrute) / Math.max(1, Math.abs(bestBrute));
    worst = Math.max(worst, d);
    if (d > 1e-6) mismatch++;
  }
  ok(`무작위 LP ${tested}건`, mismatch === 0, `최대 상대차 ${worst.toExponential(2)}`);
}

console.log(bad === 0 ? "\n전부 통과" : `\n실패 ${bad}건`);
process.exit(bad === 0 ? 0 : 1);
