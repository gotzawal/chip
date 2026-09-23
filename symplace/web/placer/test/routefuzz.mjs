/** 배선기 흔들어 보기 — 빽빽한 합성 배치를 여럿 만들어 배선하고 검사기로 잰다.
 *
 *  예제 다섯은 한 번에 풀려서 협상(겹친 넷 다시 잇기)과 최소 길이 늘리기의 어려운 길을 안 탄다.
 *  여기서는 좁은 영역에 M2·M3 핀과 다른 넷의 막는 도형을 흩어 놓고:
 *    - 배선기가 "다 이었고 규칙 위반 없음" 이라고 하면, 검사기 오류가 반드시 0 이어야 한다 (어기면 틀림)
 *    - 못 이었거나 위반을 남겼다고 하면 그 수를 센다 (틀림은 아니다 — 풀 수 없는 배치도 있다)
 *
 *    node symplace/web/placer/test/routefuzz.mjs [사례 수=200] [씨앗=1]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, checkerRules, errorLines } from "../../../../src/route/check.mjs";
import { MOCK_PDK } from "../../../../src/route/pdk.mjs";
import { problemFromLayout } from "../../../../src/route/problem.mjs";
import { loadRouter } from "../../../../src/route/router.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const rules = checkerRules(MOCK_PDK);
const router = await loadRouter(fs.readFileSync(path.join(ROOT, "src/route/router.wasm")));
const N = Number(process.argv[2] ?? 200);
let seed = Number(process.argv[3] ?? 1) >>> 0;
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

/** 트랙 위 도형: M2 는 가로 (y = 84 j), M3 는 세로 (x = 80 i) */
const m2 = (net, j, i0, i1, pin) => ({ layer: "M2", netName: net, netType: pin ? "pin" : "drawing", rect: [80 * i0 - 36, 84 * j - 16, 80 * i1 + 36, 84 * j + 16] });
const m3 = (net, i, j0, j1, pin) => ({ layer: "M3", netName: net, netType: pin ? "pin" : "drawing", rect: [80 * i - 20, 84 * j0 - 40, 80 * i + 20, 84 * j1 + 40] });

function makeCase() {
  const W = ri(10, 28), H = ri(10, 28);
  const nNets = ri(3, 10), nObs = ri(0, 25);
  const shapes = [];
  const place = (s) => {
    // 같은 트랙의 도형과 겹치거나 e2e 안이면 버린다 (배치가 처음부터 맞아야 한다)
    const e2e = 48;
    const tr = (t) => (t.layer === "M2" ? t.rect[1] + t.rect[3] : t.rect[0] + t.rect[2]);
    const span = (t) => (t.layer === "M2" ? [t.rect[0], t.rect[2]] : [t.rect[1], t.rect[3]]);
    const [a0, a1] = span(s);
    for (const u of shapes) {
      if (u.layer !== s.layer || tr(u) !== tr(s)) continue;
      const [b0, b1] = span(u);
      if (a0 < b1 + e2e && b0 < a1 + e2e) return false;
    }
    shapes.push(s);
    return true;
  };
  const randShape = (net, pin) => {
    const len = ri(2, 5);
    if (rnd() < 0.6) { const j = ri(0, H), i0 = ri(0, Math.max(0, W - len)); return m2(net, j, i0, Math.min(W, i0 + len), pin); }
    const i = ri(0, W), j0 = ri(0, Math.max(0, H - len)); return m3(net, i, j0, Math.min(H, j0 + len), pin);
  };
  for (let n = 0; n < nNets; n++) {
    const k = ri(2, 4);
    for (let q = 0, tries = 0; q < k && tries < 50; tries++) if (place(randShape(`N${n}`, true))) q++;
  }
  for (let o = 0, tries = 0; o < nObs && tries < 200; tries++) if (place(randShape(`OBS${o}`, false))) o++;
  return { shapes, bbox: [0, 0, 80 * W, 84 * H] };
}

let bugs = 0, ok = 0, failedCases = 0, iters = [], ms = 0;
for (let c = 0; c < N; c++) {
  const { shapes, bbox } = makeCase();
  const { problem, pre } = problemFromLayout({ terminals: shapes, bbox, pdk: MOCK_PDK, margin: ri(0, 2) });
  if (pre.shorts.length || pre.drc.length) { c--; continue; }
  const layers = rnd() < 0.5 ? ["M2", "M4"] : ["M2", "M3"];
  let r;
  try {
    r = router.route(problem, { minLayer: layers[0], maxLayer: layers[1], maxIter: Number(process.env.ITER ?? 60), flags: Number(process.env.FLAGS ?? 0) });
  } catch (e) {
    bugs++;
    console.log(`#${c} 배선기가 죽음: ${e.message}`);
    continue;
  }
  ms += r.ms;
  iters.push(r.iterations);
  const wires = r.wires.map((w) => ({ netName: w.netName, netType: "drawing", layer: w.layer, rect: w.rect }));
  const res = check([...shapes, ...wires], rules, { postprocess: true });
  const lines = errorLines(res);
  const claimed = !r.failed.length && !r.violations;
  if (claimed && lines.length) {
    bugs++;
    if (bugs <= 5) {
      console.log(`#${c} 배선기는 성공이라는데 검사기 오류 ${lines.length} (${layers.join("-")}, 넷 ${problem.nets.length}, 반복 ${r.iterations}):`);
      for (const l of lines.slice(0, 4)) console.log("    " + l.slice(0, 200));
      fs.writeFileSync(`/tmp/routefuzz-${c}.json`, JSON.stringify({ shapes, bbox, layers }));
    }
  } else if (claimed) ok++;
  else failedCases++;
}
iters.sort((a, b) => a - b);
console.log(`${N} 사례: 성공 ${ok}, 배선기가 실패를 알린 것 ${failedCases}, 틀림 ${bugs}` +
            `  | 반복 중앙값 ${iters[iters.length >> 1]} 최대 ${iters[iters.length - 1]}  | 배선기 평균 ${(ms / N).toFixed(1)}ms`);
if (bugs) process.exit(1);
