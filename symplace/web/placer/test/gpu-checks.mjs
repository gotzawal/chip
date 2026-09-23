/** GPU runner 대조 검사의 본체 — node(dawn) 에서도 브라우저(Chromium) 에서도 같은 코드가 돈다.
 *
 *  fs 를 안 쓴다. 설계는 밖에서 읽어 blobs 로 넘긴다:
 *      blobs[i] = { name, topology, primitives, templates }
 *  반환: { lines: string[], fails: number }
 *
 *  세 가지를 본다 (test/gpu.mjs 의 설명).
 *   1) calibrate 한 번 — W, D, B, lam0, mu0 를 무차원 CPU 문제와 대조 (상대오차 1e-4~1e-3)
 *   2) Adam 600 스텝 — 끝점 이동, 최선·중앙값 점수 (2% / 5%)
 *   3) 끊어 돌리기 — chunk 40 과 600 이 비트까지 같은가
 */
import { readDesign, variantGroups, buildProblem, regionCandidates, makeObjective,
         enumerateAssignments, moduleOrder } from "../../../../src/design.mjs";
import { Objective } from "../../../../src/energy.mjs";
import { adam, initTheta, rng, exactArea, hpwl, scoreOf } from "../../../../src/solver.mjs";
import { exactOverlap } from "../../../../src/legalize.mjs";
import { createGpuRunner, cpuRunner } from "../../../../src/gpu/runner.mjs";

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12);

/** obj 를 영역 긴 변으로 나눈 무차원 문제로 다시 만든다 (GPU 가 푸는 것과 같은 문제). */
function normalized(p) {
  const { obj, z0, N } = p;
  const span = Math.max(obj.region[2] - obj.region[0], obj.region[3] - obj.region[1]);
  const s = 1 / span;
  const o = new Objective({
    z0: Float64Array.from(z0, (v) => v * s), N, nInst: obj.n,
    w: Float64Array.from(obj.w, (v) => v * s), h: Float64Array.from(obj.h, (v) => v * s),
    pinInst: obj.pinInst, pinOff: Float64Array.from(obj.pinOff, (v) => v * s),
    pinNet: obj.pinNet, nNet: obj.nNet, region: obj.region.map((v) => v * s),
    M: Math.max(obj.dens.Mx, obj.dens.My), sx: obj.sx, sy: obj.sy,
    pinExt: obj.pinExt ? Float64Array.from(obj.pinExt, (v) => v * s) : null,
  });
  return { o, span };
}

export async function runChecks(gpu, blobs, { iters = 600, startsPer = 4, assignments = 3 } = {}) {
  const lines = [];
  let fails = 0;
  const say = (s) => lines.push(s);
  const ok = (c, m) => { if (!c) { fails++; say("  실패 " + m); } };

  const runner = await createGpuRunner(gpu);
  if (!runner) { say("WebGPU 어댑터가 없다"); return { lines, fails: 1, noGpu: true }; }
  const cpu = cpuRunner({ adam });

  for (const blob of blobs) {
    const design = readDesign({ topology: blob.topology, primitives: blob.primitives, templates: blob.templates });
    if (moduleOrder(blob.topology).length > 1 || design.missing.length) continue;   // 평면 설계만
    say("\n=== " + blob.name + " ===");
    const groups = variantGroups(design);
    const prep = [];
    let ai = 0;
    for (const a of enumerateAssignments(groups)) {
      if (ai++ >= assignments) break;
      const problem = buildProblem(design, groups, a);
      for (const region of regionCandidates(problem)) {
        const { obj, z0, N } = makeObjective(problem, region, { M: 48 });
        if (N.cols === 0) continue;
        prep.push({ obj, z0, N, problem, region });
      }
    }
    const rand = rng(11);
    const jobs = [];
    prep.forEach((p, pi) => { for (let s = 0; s < startsPer; s++) jobs.push({ p: pi, theta0: initTheta(p.obj, rand) }); });
    say(`  설정 ${prep.length} 개, 시작점 ${jobs.length} 개  (n ${prep.map((p) => p.obj.n).join("/")}, ` +
        `격자 ${[...new Set(prep.map((p) => p.obj.dens.Mx + "x" + p.obj.dens.My))].join(" ")})`);

    // ---- 1) calibrate
    const g0 = await runner.runMany(prep, jobs, { iters: 0 });
    const worst = { W: 0, D: 0, B: 0, lam: 0, mu: 0 };
    const norm = prep.map(normalized);
    jobs.forEach((j, b) => {
      const { o, span } = norm[j.p];
      const th = Float64Array.from(j.theta0, (v) => v / span);
      const cal = o.calibrate(th, 1.0, 4.0);
      const r = o.eval(th);
      worst.W = Math.max(worst.W, rel(r.W, g0[b].W / span));
      worst.D = Math.max(worst.D, rel(r.D, g0[b].D));
      worst.B = Math.max(worst.B, r.B === 0 && g0[b].B === 0 ? 0 : rel(r.B, g0[b].B));
      worst.lam = Math.max(worst.lam, rel(cal.lam, g0[b].lam0));
      worst.mu = Math.max(worst.mu, rel(cal.mu, g0[b].mu0));
    });
    say(`  calibrate  상대오차  W ${worst.W.toExponential(1)}  D ${worst.D.toExponential(1)}  ` +
        `B ${worst.B.toExponential(1)}  lam ${worst.lam.toExponential(1)}  mu ${worst.mu.toExponential(1)}`);
    ok(worst.W < 1e-4, `W 상대오차 ${worst.W}`);
    ok(worst.D < 1e-3, `D 상대오차 ${worst.D}`);
    ok(worst.B < 1e-3, `B 상대오차 ${worst.B}`);
    ok(worst.lam < 1e-3, `lam 상대오차 ${worst.lam}`);
    ok(worst.mu < 1e-3, `mu 상대오차 ${worst.mu}`);

    // ---- 2) iters 스텝
    const t0 = performance.now();
    const gg = await runner.runMany(prep, jobs, { iters });
    const tG = performance.now() - t0;
    const t1 = performance.now();
    const cc = await cpu.runMany(prep, jobs, { iters });
    const tC = performance.now() - t1;
    let maxMove = 0;
    const scG = [], scC = [];
    jobs.forEach((j, b) => {
      const { obj } = prep[j.p];
      const span = Math.max(obj.region[2] - obj.region[0], obj.region[3] - obj.region[1]);
      const rg = obj.eval(gg[b].theta), rc = obj.eval(cc[b].theta);
      for (let i = 0; i < obj.n; i++)
        maxMove = Math.max(maxMove, Math.hypot(rg.cx[i] - rc.cx[i], rg.cy[i] - rc.cy[i]) / span);
      const sc = (r) => {
        const ea = exactArea(r.cx, r.cy, obj.w, obj.h);
        const hp = hpwl(r.cx, r.cy, obj.pinInst, obj.pinOff, obj.pinNet, obj.nNet, obj.sx, obj.sy, obj.pinExt);
        let tot = 0; for (let i = 0; i < obj.n; i++) tot += obj.w[i] * obj.h[i];
        return scoreOf(ea.area, hp, 1, exactOverlap(r.cx, r.cy, obj.w, obj.h) / tot);
      };
      scG.push(sc(rg)); scC.push(sc(rc));
    });
    const bestG = Math.min(...scG), bestC = Math.min(...scC);
    const medG = scG.slice().sort((a, b) => a - b)[scG.length >> 1];
    const medC = scC.slice().sort((a, b) => a - b)[scC.length >> 1];
    say(`  ${iters} 스텝   끝점 최대 이동 ${(maxMove * 100).toFixed(2)}% (영역 긴변 대비)  ` +
        `GPU ${(tG / 1000).toFixed(2)}s  CPU ${(tC / 1000).toFixed(2)}s`);
    say(`  점수  최선 GPU ${bestG.toFixed(4)} / CPU ${bestC.toFixed(4)}   중앙값 GPU ${medG.toFixed(4)} / CPU ${medC.toFixed(4)}`);
    ok(rel(bestG, bestC) < 0.02, "최선 점수가 2% 넘게 다르다");
    ok(rel(medG, medC) < 0.05, "중앙값 점수가 5% 넘게 다르다");

    // ---- 3) 끊어 돌리기
    const few = jobs.slice(0, Math.min(8, jobs.length));
    const g40 = await runner.runMany(prep, few, { iters, chunk: 40 });
    let dif = 0;
    few.forEach((_, b) => { for (let k = 0; k < g40[b].theta.length; k++)
      dif = Math.max(dif, Math.abs(g40[b].theta[k] - gg[b].theta[k])); });
    say(`  chunk 40 대 ${iters}  theta 최대차 ${dif.toExponential(1)}`);
    ok(dif === 0, "끊어 돌린 결과가 다르다");
  }
  say(fails ? `\n실패 ${fails} 건` : "\n전부 통과");
  return { lines, fails };
}
