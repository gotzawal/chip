/** 끊어 돌린 Adam 이 한 번에 돌린 것과 같은가.
 *
 *  화면을 갱신하려면 최적화를 프레임 사이로 쪼개야 한다. 그때 모멘트와
 *  스텝 수를 넘기지 않으면 매 조각마다 Adam 이 처음부터 시작하고
 *  t % 50 어닐링이 아예 발동하지 않는다 — 실제로 그렇게 틀렸었고,
 *  브라우저에서 겹침이 0.03 대신 0.53 으로 나왔다.
 *
 *  실행:  node test/chunk.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mat } from "../../../../src/linalg.mjs";
import { Objective } from "../../../../src/energy.mjs";
import { adam, adamState, initTheta, rng } from "../../../../src/solver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(
  path.join(here, "..", "fixtures", "telescopic_ota.json"), "utf8"));

function makeObj() {
  return new Objective({
    z0: Float64Array.from(fx.z0), N: Mat.from(fx.N), nInst: fx.n,
    w: Float64Array.from(fx.w), h: Float64Array.from(fx.h),
    pinInst: Int32Array.from(fx.pin_inst),
    pinOff: Float64Array.from(fx.pin_off.flat()),
    pinNet: Int32Array.from(fx.pin_net),
    nNet: fx.n_net, region: fx.region, M: fx.M,
    gamma: fx.gamma, beta: fx.beta,
    sx: Float64Array.from(fx.sx), sy: Float64Array.from(fx.sy),
  });
}

const ITERS = 400;
const span = Math.max(fx.region[2] - fx.region[0], fx.region[3] - fx.region[1]);
const lr = span / 400;

// 같은 시작점
const th0 = initTheta(makeObj(), rng(7));

// (1) 한 번에
const o1 = makeObj();
const t1 = Float64Array.from(th0);
o1.calibrate(t1);
adam(o1, t1, { iters: ITERS, lr, calibrate: false, state: adamState(t1.length) });

// (2) 40 스텝씩 끊어서, 상태를 넘기며
const o2 = makeObj();
const t2 = Float64Array.from(th0);
o2.calibrate(t2);
const st = adamState(t2.length);
for (let d = 0; d < ITERS; d += 40)
  adam(o2, t2, { iters: Math.min(40, ITERS - d), lr, calibrate: false, state: st });

let worst = 0;
for (let i = 0; i < t1.length; i++)
  worst = Math.max(worst, Math.abs(t1[i] - t2[i]) / Math.max(Math.abs(t1[i]), 1e-9));

const e1 = o1.eval(t1), e2 = o2.eval(t2);
const ok = worst < 1e-12 && Math.abs(o1.lam - o2.lam) / o1.lam < 1e-12;
console.log(`theta 상대차 ${worst.toExponential(2)}`);
console.log(`lambda  한번 ${o1.lam.toExponential(3)}  끊어서 ${o2.lam.toExponential(3)}`);
console.log(`에너지  한번 ${e1.E.toExponential(6)}  끊어서 ${e2.E.toExponential(6)}`);
console.log(ok ? "통과 — 끊어 돌려도 동일" : "실패 — 상태가 이어지지 않는다");
process.exit(ok ? 0 : 1);
