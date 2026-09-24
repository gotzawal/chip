/** Adam 하강과 다중 시작점 구동. gpuplace/batch.py 의 adam 이식.
 *
 *  lambda / mu 를 50 스텝마다 키우는 것이 핵심이다. 처음에는 블록이 서로
 *  뚫고 지나갈 수 있는 무른 유체로 두고, 서서히 굳혀 겹침을 없앤다.
 *  (담금질에서 온도를 내리는 것과 같은 역할)
 *
 *  파이썬은 B 개 시작점을 numpy 축으로 한꺼번에 굴린다. 여기서는 먼저
 *  검증된 단일 Objective 를 B 번 도는 쪽을 택했다 — 정확성이 먼저고,
 *  진짜 배치화는 WebGPU 로 갈 때 한다.
 */
import { area } from "./energy.mjs";
import { exactOverlap } from "./legalize.mjs";
import { buildProblem, countAssignments, enumerateAssignments, flipPlan,
         makeObjective, regionCandidates, sampleAssignment } from "./design.mjs";

/** 결정론적 난수 (mulberry32). 시드를 주면 파이썬 쪽과 별개로 재현된다. */
export function rng(seed = 0) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adam 의 상태. 끊어 돌릴 때 이어붙이려면 모멘트와 스텝 수가 살아 있어야 한다.
 *  (화면을 갱신하려고 40 스텝씩 끊어 부르면서 이걸 놓치면, 모멘트가 매번
 *   초기화되고 t % 50 어닐링이 아예 발동하지 않는다. 실제로 그렇게 틀렸었다.)
 */
export function adamState(n) {
  return { m: new Float64Array(n), v: new Float64Array(n), t: 0 };
}

/** 한 시작점을 Adam 으로 내린다. theta 는 제자리에서 갱신된다.
 *  state 를 주고받으면 여러 번 나눠 불러도 한 번에 돌린 것과 같다.
 */
export function adam(obj, theta, { iters = 1200, lr, lamGrow = 1.3, muGrow = 1.25,
                                   calibrate = true, lamRatio = 1.0, muRatio = 4.0,
                                   state = null, onStep = null } = {}) {
  const n = theta.length;
  const st = state ?? adamState(n);
  // lamRatio 는 **연속 단계의 저울**이다. calibrate 가 lam 을
  // "밀도 기울기 = lamRatio x 배선 기울기" 가 되게 잡으므로,
  //   낮추면  넷이 더 세게 당긴다 -> 배선은 짧고 겹침은 많이 남는다
  //   높이면  더 퍼뜨린다        -> 겹침은 적고 배선은 길어진다
  // legalize 가 겹침을 어차피 0 으로 만들므로 "얼마나 무른 유체로 둘 것인가" 다.
  if (calibrate) obj.calibrate(theta, lamRatio, muRatio);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  let last = null;
  for (let k = 0; k < iters; k++) {
    const t = ++st.t;
    const r = obj.eval(theta);
    last = r;
    const c1 = 1 - Math.pow(b1, t), c2 = 1 - Math.pow(b2, t);
    for (let i = 0; i < n; i++) {
      const g = r.grad[i];
      st.m[i] = b1 * st.m[i] + (1 - b1) * g;
      st.v[i] = b2 * st.v[i] + (1 - b2) * g * g;
      theta[i] -= (lr * (st.m[i] / c1)) / (Math.sqrt(st.v[i] / c2) + eps);
    }
    if (t % 50 === 0) { obj.lam *= lamGrow; obj.mu *= muGrow; }
    if (onStep && t % 25 === 0) onStep(t, r);
  }
  return { theta, last, state: st };
}

/** 영역 안 무작위 위치를 제약 부분공간에 사영해 시작 theta 를 만든다.
 *  z_target 은 제약을 안 지키므로, N 이 정규직교인 점을 써서
 *  theta = N^T (z_target - z0) 로 최소제곱 사영한다.
 */
export function initTheta(obj, rand) {
  const { z0, N, n, region } = obj;
  const [x0, y0, x1, y1] = region;
  const d = new Float64Array(z0.length);
  for (let i = 0; i < n; i++) {
    d[2 * i] = x0 + rand() * (x1 - x0) - z0[2 * i];
    d[2 * i + 1] = y0 + rand() * (y1 - y0) - z0[2 * i + 1];
  }
  for (let i = 2 * n; i < z0.length; i++) d[i] = 0;
  const theta = new Float64Array(N.cols);
  for (let i = 0; i < N.rows; i++) {
    const di = d[i];
    if (di === 0) continue;
    const base = i * N.cols;
    for (let j = 0; j < N.cols; j++) theta[j] += N.data[base + j] * di;
  }
  return theta;
}

/** 실제 바운딩 박스 면적 (log-sum-exp 로 부풀린 값이 아닌 정확한 값). */
export function exactArea(cx, cy, w, h) {
  let xl = Infinity, xh = -Infinity, yl = Infinity, yh = -Infinity;
  for (let i = 0; i < cx.length; i++) {
    xl = Math.min(xl, cx[i] - w[i] / 2); xh = Math.max(xh, cx[i] + w[i] / 2);
    yl = Math.min(yl, cy[i] - h[i] / 2); yh = Math.max(yh, cy[i] + h[i] / 2);
  }
  return { area: (xh - xl) * (yh - yl), box: [xl, yl, xh, yh] };
}

/** 정확한 HPWL (넷마다 핀 사각형들의 bbox 반둘레 합). 최종 비교용.
 *  ext 는 핀 반폭 [ex, ey] (핀당 2 개) — 주면 ALIGN 의 HPWL_extend 와 같은 양이고,
 *  안 주면 핀 중심 한 점으로 잰다.
 */
export function hpwl(cx, cy, pinInst, pinOff, pinNet, nNet, sx, sy, ext = null) {
  const xl = new Float64Array(nNet).fill(Infinity), xh = new Float64Array(nNet).fill(-Infinity);
  const yl = new Float64Array(nNet).fill(Infinity), yh = new Float64Array(nNet).fill(-Infinity);
  for (let p = 0; p < pinInst.length; p++) {
    const i = pinInst[p], e = pinNet[p];
    const x = cx[i] + sx[i] * pinOff[2 * p];
    const y = cy[i] + sy[i] * pinOff[2 * p + 1];
    const dx = ext ? ext[2 * p] : 0, dy = ext ? ext[2 * p + 1] : 0;
    if (x - dx < xl[e]) xl[e] = x - dx; if (x + dx > xh[e]) xh[e] = x + dx;
    if (y - dy < yl[e]) yl[e] = y - dy; if (y + dy > yh[e]) yh[e] = y + dy;
  }
  let s = 0;
  for (let e = 0; e < nNet; e++) if (Number.isFinite(xl[e])) s += xh[e] - xl[e] + (yh[e] - yl[e]);
  return s;
}

/** 여러 시작점을 굴리고 후보를 모은다.
 *  점수는 m2.py 와 같게 면적비 + 배선비 + 3 * 겹침으로 둔다.
 *  (겹침에 과한 가중을 주면 배선이 좋은 해를 버린다 — 실측으로 확인된 값)
 */
export function multiStart(obj, {
  batch = 64, iters = 800, seed = 0, lamGrow = 1.3, muGrow = 1.25,
  lamRatio = 1.0, refArea = 1, refHpwl = 1, onProgress = null,
} = {}) {
  const rand = rng(seed);
  const span = Math.max(obj.region[2] - obj.region[0], obj.region[3] - obj.region[1]);
  const lr = span / 400;
  const lam0 = obj.lam, mu0 = obj.mu;
  const out = [];
  for (let b = 0; b < batch; b++) {
    obj.lam = lam0; obj.mu = mu0;
    const theta = initTheta(obj, rand);
    adam(obj, theta, { iters, lr, lamGrow, muGrow, lamRatio });
    const r = obj.eval(theta);
    const ea = exactArea(r.cx, r.cy, obj.w, obj.h);
    const of = obj.dens.overflow(r.cx, r.cy, obj.w, obj.h);
    const hp = hpwl(r.cx, r.cy, obj.pinInst, obj.pinOff, obj.pinNet, obj.nNet, obj.sx, obj.sy,
                    obj.pinExt);
    out.push({
      theta: Float64Array.from(theta), cx: r.cx, cy: r.cy,
      area: ea.area, box: ea.box, overflow: of, hpwl: hp,
      score: ea.area / refArea + hp / refHpwl + 3 * of,
    });
    if (onProgress) onProgress(b + 1, batch, out[out.length - 1]);
  }
  out.sort((a, b2) => a.score - b2.score);
  return out;
}

// ------------------------------------------------- variant 선택을 포함한 다중 시작

/** 후보 점수. ALIGN 배치기의 비용과 같은 꼴이다:
 *
 *      log(면적) + hpwlWeight x log(HPWL) + 3 x 겹침
 *
 *  로그라 기준값이 필요 없다 — 면적 10% 와 배선 10% 가 같은 값이고, 무게 1 이
 *  ALIGN 의 `LAMBDA = 1` 이다. 예전의 `면적/refArea + w x HPWL/refHpwl` 은
 *  refHpwl 을 어떻게 잡느냐에 따라 저울이 통째로 움직여서 (README 의 "무게가
 *  틀려 있었다") 무게 2 로 보정해 두고 있었다. 겹침 벌점은 연속단계 후보에만
 *  붙는다 (legalize 뒤에는 0 이다). 넷이 없어 HPWL 이 0 이면 1 로 막는다.
 */
export function scoreOf(area, hp, hpwlWeight = 1, overlap = 0) {
  return Math.log(Math.max(area, 1)) + hpwlWeight * Math.log(Math.max(hp, 1)) + 3 * overlap;
}

/** variant 배정까지 **추첨에 포함시킨** 다중 시작.
 *
 *  ## 왜 이게 필요한가
 *
 *  2_primitives 는 같은 소자를 여러 종횡비로 만들어 둔다 (X1_Y2 는 800x3528,
 *  X2_Y1 은 1120x2352). 어느 쪽을 쓰느냐는 연속 최적화로는 못 정하는 **이산
 *  선택**이고, 배치 결과를 크게 바꾼다. ALIGN 은 SA 탐색 안에서 같이 골랐지만
 *  그 배치기는 ILP 솔버가 필요해 브라우저에 못 싣는다.
 *
 *  다행히 고를 것이 적다. 실측 조합 수:
 *    current_mirror_ota 2, high_speed_comparator 4, telescopic_ota 8,
 *    cascode_current_mirror_ota 8, five_transistor_ota 60.
 *  블록이 11 개여도 조합은 8 개다 — 대부분의 인스턴스는 variant 가 하나뿐이다.
 *  그래서 작으면 전수, 크면 추첨으로 덮을 수 있다.
 *
 *  ## 구조
 *
 *  이미 시작점을 수십~수천 개 굴려 점수로 고르고 있으므로, 배정을 그 추첨의
 *  한 축으로 넣으면 끝난다. 설정 하나 = (variant 배정, 영역 후보) 이고,
 *  설정마다 배정에 맞는 A z = b 와 영공간을 새로 만든다 — 대칭 계가 블록
 *  크기에 의존하기 때문에 재사용할 수 없다.
 *
 *  ## 설정 간 점수 비교
 *
 *  multiStart 의 점수는 density overflow 를 쓰는데, 그건 영역 격자 크기에
 *  의존해서 영역이 다른 설정끼리 비교하면 안 된다. 여기서는 격자와 무관한
 *  exactOverlap(실제 겹침 면적)을 블록 총면적으로 나눠 쓴다.
 *
 *  ## 점수는 배정 전체에 걸쳐 **한 저울**이어야 한다
 *
 *  점수는 `log(면적) + w x log(HPWL) + 3 x 겹침` (scoreOf) 이다. 절대량이라
 *  배정 간 비교가 그대로 성립한다. 예전에 배정마다 그 배정의 블록 합계 면적으로
 *  나눈 적이 있는데 **틀렸다** — 면적비가 "채움률"이 되어, variant 에 따라 블록
 *  면적이 2 배 차이나는 것(NMOS_4T_85599263 X1_Y16 12.79M 대 X8_Y2 6.21M)을
 *  못 봤고 high_speed_comparator 최상위가 3840 x 42336 이 됐다. 로그 점수는
 *  기준값 자체가 없어 그 실수를 할 자리가 없다.
 */
export async function multiStartVariants(design, groups, {
  batch = 64, iters = 800, seed = 0, M = 48,
  lamGrow = 1.3, muGrow = 1.25,
  // 연속 단계의 저울 (adam 의 설명 참고). 1 이면 시작점에서 밀도와 배선의
  // 기울기가 같다. 낮추면 배선 쪽으로, 높이면 퍼뜨리는 쪽으로 기운다.
  lamRatio = 1.0,
  slack = 1.25, aspects = null,
  // null 이면 예산에서 정한다 (아래). 배정이 이보다 많으면 전수가 아니라 추첨이다.
  maxConfigs = null,
  // 면적 대 배선의 무게 (scoreOf). placeDesign 이 legalize 뒤 점수에 쓰는 것과
  // **같은 값**을 여기서도 써야 한다 — 후보를 고르는 저울과 최종 저울이 다르면,
  // 여기서 고른 상위 후보가 정작 최종 점수로는 상위가 아니다.
  hpwlWeight = 1,
  // 후보 점수를 **거울 반전을 고른 뒤**의 배선길이로 매긴다.
  // 반전은 좌표를 안 건드리고 핀 위치만 바꾸므로 여기서 골라도 공짜에 가깝고,
  // 실측으로 HPWL 이 0.64~0.77 배로 줄어든다. 반전 전 값으로 줄을 세우면
  // 그 30% 가 후보마다 다르게 붙어 순위가 통째로 흔들린다.
  flipAware = true,
  // runner: src/gpu/runner.mjs 의 GPU runner. 있으면 Adam 을 시작점 묶음으로 GPU 에서 돈다.
  // perConfig: 설정마다 줄 시작점 수 (GPU 일 때). 없으면 batch 가 총 시작점 수다.
  runner = null, perConfig = null,
  onProgress = null, onConfig = null,
} = {}) {
  const rand = rng(seed);
  const total = countAssignments(groups);

  // 배정 목록: 작으면 전수, 크면 추첨(중복 제거).
  //
  // 상한을 예산에 묶는다. 64 로 고정해두면 예산을 아무리 올려도 배정은 64 개만
  // 보고, **ALIGN 이 고른 조합이 추첨에 아예 안 들어오는** 일이 생긴다
  // (high_speed_comparator 는 조합이 108 개다 — 64 면 40% 를 못 본다).
  // 상한은 예산과 느슨하게만 묶는다. GPU (perConfig) 면 예산이 설정 수에 비례하므로
  // 전수를 본다 (512 까지). CPU 도 128 까지는 전수다 — hsc 의 108 개를 96 으로
  // 추첨하면 ALIGN 이 고른 조합이 빠져 시작점 96 과 288 의 답이 달라졌다
  // (XCCP 의 하위 모듈 variant). 1 라운드가 설정마다 하나씩은 보므로 배정 108 개면
  // 시작점 324 개가 하한이 되어 96 보다 12% 더 든다.
  const cap = maxConfigs ?? (perConfig ? Math.max(512, batch) : Math.max(128, batch));
  let assigns;
  if (total <= cap) {
    assigns = [...enumerateAssignments(groups)];
  } else {
    const seen = new Set();
    assigns = [];
    for (let g = 0; g < cap * 20 && assigns.length < cap; g++) {
      const a = sampleAssignment(groups, rand);
      const k = a.join(",");
      if (seen.has(k)) continue;
      seen.add(k); assigns.push(a);
    }
  }

  // 설정 = 배정 x 영역 후보
  const configs = [];
  for (const a of assigns) {
    const problem = buildProblem(design, groups, a);
    for (const region of regionCandidates(problem, { slack, aspects }))
      configs.push({ assignment: a, problem, region });
  }

  // --- 예산을 **라운드로 나눠 쓴다** ---
  //
  // 예전에는 per = floor(batch / 설정수) 를 설정마다 똑같이 흩뿌리고 끝이었다.
  // 설정이 batch 보다 많으면 per 가 1 로 깔려서 두 가지가 깨졌다.
  //   (1) 예산 설정이 아무 일도 안 한다 — high_speed_comparator 는 설정이
  //       192 개라 48 을 고르든 288 을 고르든 똑같이 192 번을 돌았다.
  //   (2) 예산을 늘려도 **깊이가 안 깊어진다** — 좋은 설정을 더 파볼 길이 없다.
  //
  // 이제 batch 는 진짜 총 시작점 수다 (설정 수가 하한이다 — 설정마다 최소
  // 하나는 봐야 하므로).
  //   1 라운드 (너비)     설정마다 하나씩. 모든 설정을 한 번은 본다.
  //   2 라운드 이후 (깊이) 점수 상위 설정에만 하나씩 더. 볼 설정 수를 라운드마다
  //                       반으로 줄여 잘 되는 쪽으로 예산을 몬다.
  // 담금질에서 온도를 내리는 것과 같은 자리다 — 다만 여기서 식는 것은
  // 좌표가 아니라 **어느 설정을 더 파볼지** 다.
  const prep = [];
  for (const cfg of configs) {
    const { obj, z0, N, rank, skipped } = makeObjective(cfg.problem, cfg.region, { M });
    if (N.cols === 0) continue;                     // 자유도 0 — 배치가 이미 결정됐다
    // 겹침은 "이 배정의 블록들이 서로 얼마나 파고들었나" 라 배정 자신의
    // 면적으로 나누는 게 맞다. 면적·배선과 달리 배정 간 절대 비교가 아니다.
    let tot = 0;
    for (let i = 0; i < cfg.problem.n; i++) tot += cfg.problem.w[i] * cfg.problem.h[i];
    const span = Math.max(cfg.region[2] - cfg.region[0], cfg.region[3] - cfg.region[1]);
    prep.push({ cfg, obj, z0, N, rank, skipped, tot, lr: span / 400, best: null });
  }

  const out = [];
  // perConfig 가 있으면 (GPU) 예산은 "설정마다 perConfig 개" 다. 없으면 총 시작점 batch.
  const per = perConfig && perConfig > 0 ? perConfig : 1;
  const budget = Math.max(batch, prep.length * per);
  let spent = 0;
  const plan = flipAware ? flipPlan(design, groups) : null;
  prep.forEach((p, i) => { p.index = i; });

  /** 내려온 theta 하나를 후보로 굳힌다 (정확한 면적·겹침·반전 뒤 배선). */
  const finish = (p, theta) => {
    const { obj, cfg } = p;
    const r = obj.eval(theta);
    const ea = exactArea(r.cx, r.cy, obj.w, obj.h);
    const ov = exactOverlap(r.cx, r.cy, obj.w, obj.h) / p.tot;
    const fr = plan ? refineFlips(cfg.problem, plan, r.cx, r.cy) : null;
    const hp = fr ? fr.hpwl
                  : hpwl(r.cx, r.cy, obj.pinInst, obj.pinOff, obj.pinNet,
                         obj.nNet, obj.sx, obj.sy, obj.pinExt);
    const cand = {
      theta: Float64Array.from(theta), cx: r.cx, cy: r.cy,
      area: ea.area, box: ea.box, overlap: ov, hpwl: hp,
      score: scoreOf(ea.area, hp, hpwlWeight, ov),
      assignment: cfg.assignment, region: cfg.region,
      concrete: cfg.problem.concrete, problem: cfg.problem,
      obj, z0: p.z0, N: p.N, rank: p.rank, skipped: p.skipped,
    };
    out.push(cand);
    spent++;
    if (!p.best || cand.score < p.best.score) p.best = cand;
    if (onProgress) onProgress(spent, budget, cand);
    return cand;
  };

  /** 시작점 한 묶음을 돌린다. runner 가 있으면 (GPU) 한꺼번에, 없으면 차례로.
   *  시작 theta 는 어느 쪽이든 같은 순서로 같은 난수에서 뽑으므로, 같은 씨앗이면
   *  CPU 경로는 예전과 비트까지 같다.
   */
  const runBatch = async (ps) => {
    const jobs = ps.map((p) => ({ p: p.index, theta0: initTheta(p.obj, rand) }));
    if (runner) {
      const rr = await runner.runMany(prep, jobs, { iters, lamGrow, muGrow, lamRatio,
        onChunk: onProgress ? (t, T) => onProgress(spent + Math.floor(jobs.length * t / T), budget, null, "adam") : null });
      ps.forEach((p, j) => finish(p, rr[j].theta));
    } else {
      ps.forEach((p, j) => {
        p.obj.lam = 1.0; p.obj.mu = 1.0;
        adam(p.obj, jobs[j].theta0, { iters, lr: p.lr, lamGrow, muGrow, lamRatio });
        finish(p, jobs[j].theta0);
      });
    }
  };
  const times = (ps, m) => ps.flatMap((p) => Array.from({ length: m }, () => p));

  // 1 라운드 — 너비 (설정마다 per 개)
  if (runner) {
    await runBatch(times(prep, per));
    if (onConfig) onConfig(prep.length, prep.length, prep.filter((p) => p.best)
                     .sort((a, b) => a.best.score - b.best.score)[0]?.best, "설정");
  } else {
    for (let ci = 0; ci < prep.length; ci++) {
      await runBatch(times([prep[ci]], per));
      if (onConfig) onConfig(ci + 1, prep.length, prep[ci].best, "설정");
    }
  }

  // 2 라운드 이후 — 깊이
  let rounds = 1;
  let k = Math.max(1, Math.floor(prep.length / 2));
  while (spent < budget && prep.length) {
    const top = prep.filter((p) => p.best)
                    .sort((a, b) => a.best.score - b.best.score).slice(0, k);
    if (!top.length) break;
    rounds++;
    const room = Math.max(0, Math.floor((budget - spent) / per));
    await runBatch(times(top.slice(0, Math.max(1, Math.min(top.length, room))), per));
    if (onConfig) onConfig(spent, budget, top[0].best, `심화 ${rounds - 1}`);
    // 반씩 좁히다가 하나까지 가면 다시 절반에서 시작한다. 안 그러면 남은 예산이
    // 전부 **설정 하나**에 쏟아진다 — 같은 설정에 무작위 시작점을 수십 개 더
    // 넣어봐야 금방 포화된다. 상위권을 여러 번 훑는 쪽이 낫다.
    k = k > 1 ? Math.max(1, Math.floor(k / 2)) : Math.max(1, Math.floor(prep.length / 2));
  }

  out.sort((a, b) => a.score - b.score);
  return { candidates: out, configs: prep.length, assignments: assigns.length,
           totalAssignments: total, starts: spent, rounds,
           runner: runner ? runner.kind : "cpu" };
}

/** 거울 반전을 좌표 고정 상태에서 좌표하강으로 고른다.
 *
 *  반전은 크기·밀도·면적에 영향이 없고 **핀 위치만** 바꾼다. 그래서 배치가
 *  끝난 뒤에 따로 고를 수 있고, 고를 것도 그룹마다 최대 2 비트뿐이다.
 *  제약에 묶인 비트는 flipPlan 이 이미 빼놨으므로 여기서는 자유 비트만 돈다.
 *
 *  **주의** — 이건 HPWL 만 본다. ALIGN 이 고른 반전에는 배선 단계 사정
 *  (전원 레일이 어느 쪽을 보는지 등)이 섞여 있을 수 있다. 최종 판정은
 *  GDS 를 내서 DRC 로 해야 한다.
 */
export function refineFlips(problem, plan, cx, cy, { rounds = 6 } = {}) {
  const pidx = new Map(problem.keep.map((di, pi) => [di, pi]));
  const bits = plan.map(() => [1, 1]);
  const sx = Float64Array.from(problem.sx), sy = Float64Array.from(problem.sy);

  const apply = () => {
    plan.forEach((p, gi) => {
      const [bx, by] = bits[gi];
      p.members.forEach((m, k) => {
        const pi = pidx.get(m);
        if (pi === undefined) return;
        sx[pi] = (p.xFree ? bx : 1) * p.xSign[k];
        sy[pi] = (p.yFree ? by : 1) * p.ySign[k];
      });
    });
  };
  const score = () => {
    apply();
    return hpwl(cx, cy, problem.pinInst, problem.pinOff, problem.pinNet,
                problem.nNet, sx, sy, problem.pinExt ?? null);
  };

  const before = score();
  let cur = before;
  for (let r = 0; r < rounds; r++) {
    let moved = false;
    plan.forEach((p, gi) => {
      const cands = [];
      for (const bx of p.xFree ? [1, -1] : [1])
        for (const by of p.yFree ? [1, -1] : [1]) cands.push([bx, by]);
      if (cands.length < 2) return;
      const keep = bits[gi];
      let bestB = keep, bestV = cur;
      for (const c of cands) {
        bits[gi] = c;
        const v = score();
        if (v < bestV - 1e-9) { bestV = v; bestB = c; }
      }
      bits[gi] = bestB;
      if (bestV < cur - 1e-9) { cur = bestV; moved = true; }
    });
    if (!moved) break;
  }
  apply();
  return { bits, sx, sy, hpwl: cur, before };
}
