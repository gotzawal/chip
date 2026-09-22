/** legalization 검사.
 *
 *  파이썬 MILP 와 같은 답을 요구하지 않는다 — 쌍의 관계를 뒤집을 수 있는
 *  MILP 와 방향을 고정한 LP 는 다른 꼭짓점에 도달할 수 있다. 대신 성질을 본다:
 *
 *    겹침 정확히 0           (연속 최적화가 못 하던 것)
 *    대칭 잔차 |A z - b| ~ 0  (theta 공간이 보장해야 하는 것)
 *    면적/배선이 망가지지 않을 것
 *
 *  실행:  node test/legalize.mjs [예제]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mat, matvec } from "../../../../src/linalg.mjs";
import { Objective } from "../../../../src/energy.mjs";
import { adam, adamState, initTheta, rng, exactArea, hpwl } from "../../../../src/solver.mjs";
import { legalize, exactOverlap } from "../../../../src/legalize.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "..", "fixtures");
const names = process.argv.slice(2);
const files = (names.length ? names.map((n) => `${n}.json`)
                            : fs.readdirSync(FIX).filter((f) => f.endsWith(".json")));

let bad = 0;
const ok = (cond, label, extra) => {
  if (!cond) bad++;
  console.log(`    ${cond ? "OK  " : "FAIL"} ${label.padEnd(26)} ${extra}`);
};

for (const file of files) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, file), "utf8"));
  const w = Float64Array.from(fx.w), h = Float64Array.from(fx.h);
  const sx = Float64Array.from(fx.sx), sy = Float64Array.from(fx.sy);
  const N = Mat.from(fx.N), z0 = Float64Array.from(fx.z0);
  const obj = new Objective({
    z0, N, nInst: fx.n, w, h,
    pinInst: Int32Array.from(fx.pin_inst),
    pinOff: Float64Array.from(fx.pin_off.flat()),
    pinNet: Int32Array.from(fx.pin_net),
    nNet: fx.n_net, region: fx.region, M: fx.M,
    gamma: fx.gamma, beta: fx.beta, sx, sy,
  });
  const refArea = (fx.region[2] - fx.region[0]) * (fx.region[3] - fx.region[1]);
  const refHpwl = hpwl(Float64Array.from(fx.cx_align), Float64Array.from(fx.cy_align),
                       obj.pinInst, obj.pinOff, obj.pinNet, fx.n_net, sx, sy);
  const A = fx.A.length ? Mat.from(fx.A) : null;
  const bvec = Float64Array.from(fx.b);

  console.log(`\n### ${fx.example}  블록 ${fx.n}  자유도 ${N.cols}  제약행 ${fx.A.length}`);

  // 연속 최적화로 후보를 몇 개 만들고, 각각 legalize 한 뒤 최선을 고른다
  const span = Math.max(fx.region[2] - fx.region[0], fx.region[3] - fx.region[1]);
  const lr = span / 400;
  const rand = rng(3);
  const cands = [];
  const t0 = performance.now();
  for (let b = 0; b < 12; b++) {
    obj.lam = 1; obj.mu = 1;
    const th = initTheta(obj, rand);
    adam(obj, th, { iters: 600, lr, state: adamState(th.length) });
    const r = obj.eval(th);
    cands.push({ th, cx: r.cx, cy: r.cy });
  }
  const tOpt = performance.now() - t0;

  const t1 = performance.now();
  let best = null, fails = 0;
  for (const cd of cands) {
    const lg = legalize({ z0, N, n: fx.n, w, h, cxRef: cd.cx, cyRef: cd.cy, region: fx.region });
    if (lg.status !== "OPTIMAL") { fails++; continue; }
    const ea = exactArea(lg.cx, lg.cy, w, h);
    const hp = hpwl(lg.cx, lg.cy, obj.pinInst, obj.pinOff, obj.pinNet, fx.n_net, sx, sy);
    const score = ea.area / refArea + hp / refHpwl;
    let move = 0;
    for (let i = 0; i < fx.n; i++)
      move = Math.max(move, Math.hypot(lg.cx[i] - cd.cx[i], lg.cy[i] - cd.cy[i]));
    if (!best || score < best.score) best = { ...lg, area: ea.area, hpwl: hp, score, move };
  }
  const tLeg = performance.now() - t1;

  if (!best) { ok(false, "legalize 성공", `12건 전부 실패`); continue; }

  // --- 성질 검사 ---
  const ov = exactOverlap(best.cx, best.cy, w, h);
  ok(ov < 1e-6, "겹침 = 0", `${ov.toExponential(2)}`);

  if (A) {
    const z = Float64Array.from(z0);
    for (let i = 0; i < N.rows; i++) {
      let s = 0;
      for (let k = 0; k < N.cols; k++) s += N.data[i * N.cols + k] * best.theta[k];
      z[i] += s;
    }
    const res = matvec(A, z);
    let worst = 0;
    for (let i = 0; i < res.length; i++) worst = Math.max(worst, Math.abs(res[i] - bvec[i]));
    ok(worst < 1e-6, "대칭 잔차 |Az-b|", `${worst.toExponential(2)}`);
  }

  ok(best.area / refArea < 1.6, "면적", `${(best.area / refArea).toFixed(2)}x`);
  ok(best.hpwl / refHpwl < 1.6, "배선 HPWL", `${(best.hpwl / refHpwl).toFixed(2)}x`);
  ok(fails === 0, "LP 실패 없음", `${fails}/12`);
  console.log(`    최대 이동 ${best.move.toFixed(0)} (영역 긴변 ${span.toFixed(0)})`);
  console.log(`    시간: 연속 ${(tOpt / 1000).toFixed(1)}s  legalize ${(tLeg / 1000).toFixed(2)}s (12건)`);
}

console.log(bad === 0 ? "\n전부 통과" : `\n실패 ${bad}건`);
process.exit(bad === 0 ? 0 : 1);
