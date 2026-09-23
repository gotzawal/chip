/** JS 최적화기의 처리량과 결과 품질을 잰다.
 *
 *  두 질문에 답하려는 것:
 *   1) 브라우저에서 몇 개 x 몇 회를 돌릴 수 있나 (처리량)
 *   2) 그 예산으로 파이썬 M2 와 비슷한 품질이 나오나 (면적/배선/겹침)
 *
 *  실행:  node test/bench.mjs [예제] [batch] [iters]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mat } from "../../../../src/linalg.mjs";
import { Objective } from "../../../../src/energy.mjs";
import { multiStart } from "../../../../src/solver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "..", "fixtures");

const example = process.argv[2] ?? "telescopic_ota";
const batch = Number(process.argv[3] ?? 32);
const iters = Number(process.argv[4] ?? 600);

const fx = JSON.parse(fs.readFileSync(path.join(FIX, `${example}.json`), "utf8"));
const w = Float64Array.from(fx.w), h = Float64Array.from(fx.h);
const sx = Float64Array.from(fx.sx), sy = Float64Array.from(fx.sy);

const obj = new Objective({
  z0: Float64Array.from(fx.z0), N: Mat.from(fx.N), nInst: fx.n,
  w, h,
  pinInst: Int32Array.from(fx.pin_inst),
  pinOff: Float64Array.from(fx.pin_off.flat()),
  pinNet: Int32Array.from(fx.pin_net),
  nNet: fx.n_net, region: fx.region, M: fx.M,
  gamma: fx.gamma, beta: fx.beta, sx, sy,
});

// 정규화 기준: 영역 면적과 sqrt(면적) x 넷 수 (multiStart 의 옛 점수 꼴 — 처리량을 재는 데만 쓴다)
const refArea = (fx.region[2] - fx.region[0]) * (fx.region[3] - fx.region[1]);
const refHpwl = Math.sqrt(refArea) * fx.n_net;

// 처리량 측정
const t0 = performance.now();
const res = multiStart(obj, { batch, iters, seed: 1, refArea, refHpwl });
const el = (performance.now() - t0) / 1000;

const evals = batch * iters;
console.log(`${example}  블록 ${fx.n} 넷 ${fx.n_net} 자유도 ${fx.N[0].length}`);
console.log(`  밀도격자 ${obj.dens.Mx} x ${obj.dens.My}`);
console.log(`  ${batch} x ${iters} = ${evals} 평가  ${el.toFixed(1)}초  ` +
            `(${(evals / el / 1000).toFixed(1)}k 평가/초)`);

const best = res[0];
const med = res[Math.floor(res.length / 2)];
const fmt = (r) => `면적 ${(r.area / refArea).toFixed(2)}x(영역 대비)  겹침 ${r.overflow.toFixed(3)}  ` +
                   `HPWL ${r.hpwl.toFixed(0)}`;
console.log(`  최선  ${fmt(best)}`);
console.log(`  중앙  ${fmt(med)}`);
console.log(`  면적 최소 ${(Math.min(...res.map((r) => r.area)) / refArea).toFixed(2)}x` +
            `  겹침 최소 ${Math.min(...res.map((r) => r.overflow)).toFixed(3)}`);

