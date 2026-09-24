/** 배치 한 판 — 워커에서도, 메인 스레드에서도 같은 코드가 돈다.
 *
 *  예제 하나가 8~107 초 걸린다. 그래서 보통은 워커에서 돈다 (worker.mjs 가
 *  이 파일을 감싼다). 다만 **모듈 워커가 없는 브라우저**가 있어 —
 *  구형 사파리에서 조용히 죽는다 — index.html 은 워커가 안 서면 이 함수를
 *  메인 스레드에서 직접 부른다. 그래서 워커 전용 API(self, postMessage)를
 *  쓰지 않고, 내보낼 것은 인자로 받은 post 로 넘긴다.
 *
 *  받는 것: { name, blob, batch }  blob = {topology, primitives, templates}
 *  post 로 보내는 것:
 *    {type:"start", ...}     설계 요약(블록·모듈·변이 조합·어디서 도는지) — 즉시
 *    {type:"progress", ...}  후보 진행
 *    {type:"frame", ...}     설정 하나가 끝날 때의 최선 — 재배치 과정이 보인다
 *    {type:"done", ...}      우리 배치
 *    {type:"error", ...}
 */
import { readDesign, topIndex, moduleOrder, variantGroups,
         countAssignments, ignoredConstraints } from "./design.mjs";
import { placeHierarchy, symmetryResidual, orderViolations,
         spreadShapes, SUB_VARIANTS, axes } from "./place.mjs";
import { createGpuRunner } from "./gpu/runner.mjs";
import { editKit, rebuild, centers, retryVariants } from "./edit/place.mjs";

export async function runJob(data, post) {
  const { name, blob, batch, grid = [80, 84],
          hpwlWeight, lamRatio, gpu = true, perConfig = 32, fixedVariants = null } = data;
  try {
    // WebGPU 가 있으면 연속 단계(Adam)를 거기서 돈다 — 시작점을 설정마다 perConfig 개.
    // 없으면 CPU 로, 총 시작점 batch 개 (예전과 같다). 어느 쪽인지 화면에 알린다.
    let runner = null;
    if (gpu && globalThis.navigator?.gpu)
      runner = await createGpuRunner(globalThis.navigator.gpu).catch(() => null);
    const topName = blob.topology.modules[topIndex(blob.topology)].name;
    const order = moduleOrder(blob.topology);

    // 변이 조합이 몇 개인지 미리 알려준다 (최상위 기준, 하위 모듈 변이 전)
    const d0 = readDesign({ ...blob, top: order[0] });
    // 배치기가 모르는 제약은 조용히 넘기지 않고 이름을 알린다 (모듈 전부).
    const ignored = [...new Set(blob.topology.modules.flatMap((m) => ignoredConstraints(m.constraints)))];
    post({ type: "start", topName, order, ignored,
                  blocks: d0.instances.length + d0.missing.length,
                  modules: order.length,
                  leafCombos: countAssignments(variantGroups(d0)),
                  runner: runner ? "gpu" : "cpu" });

    const t0 = performance.now();
    let seen = 0, frames = 0, lastFrame = 0;
    const r = await placeHierarchy(blob, {
      batch, iters: 600, seed: 1, grid,
      ...(runner ? { runner, perConfig } : {}),
      ...(hpwlWeight ? { hpwlWeight } : {}),
      ...(lamRatio ? { lamRatio } : {}),
      // 편집기에서 고정한 변이 — 최상위 인스턴스의 것만 (placeHierarchy 가 하위에는 안 준다)
      ...(fixedVariants && Object.keys(fixedVariants).length ? { fixedVariants } : {}),
      onProgress: (done, total, cand, phase) => {
        seen++;
        // 후보 하나마다 오는 것은 8 개에 한 번만. GPU 조각(cand 없음)과 legalize 진행은 그대로.
        if (cand && seen % 8 !== 0) return;
        post({ type: "progress", done, total, phase: phase ?? "후보",
                      t: (performance.now() - t0) / 1000 });
      },
      // 설정 하나가 끝날 때마다 그때의 최선을 보낸다. 너무 자주 보내면
      // 메인 스레드가 그리느라 밀리므로 120ms 간격으로 솎는다.
      onConfig: (mod, isTop, i, total, best, phase) => {
        if (!best || !best.cx) return;
        const now = performance.now();
        if (now - lastFrame < 120 && i < total) return;
        lastFrame = now;
        frames++;
        const pr = best.problem;
        post({
          type: "frame", module: mod, isTop, i, total, frame: frames,
          phase: phase ?? "설정",
          t: (now - t0) / 1000,
          score: best.score,
          bbox: [0, 0, best.box[2] - best.box[0], best.box[3] - best.box[1]],
          rects: pr.names.map((nm, k) => ({
            name: nm,
            x: best.cx[k] - pr.w[k] / 2 - best.box[0],
            y: best.cy[k] - pr.h[k] / 2 - best.box[1],
            w: pr.w[k], h: pr.h[k],
          })),
          concrete: pr.concrete,
        });
      },
    });
    if (!r.ok) { post({ type: "error", msg: `${r.module}: ${r.reason}` }); return; }

    const top = r.top, P = top.problem;
    // 원점을 0 으로 당긴다. legalize 는 여유 영역에서 풀어서 bbox 가
    // (80, -168) 처럼 0 이 아닌 데서 시작할 수 있다. 그대로 그리면 ALIGN 패널과
    // 기준이 달라져 나란히 비교가 어긋난다.
    const [ox0, oy0] = [top.box[0], top.box[1]];
    const rects = top.names.map((n, i) => ({
      name: n, concrete: top.concrete[i],
      x: top.cx[i] - top.w[i] / 2 - ox0, y: top.cy[i] - top.h[i] / 2 - oy0,
      w: top.w[i], h: top.h[i],
      sx: top.sx[i], sy: top.sy[i],
    }));
    const box0 = [0, 0, top.box[2] - ox0, top.box[3] - oy0];
    // 하위 모듈의 **실제 배치**. 배선기는 최상위만으로는 못 돈다 — 덤프의
    // 최상위 대안이 하위 모듈의 module 항목(bbox + 인스턴스)까지 품어야 한다.
    // __v{k} 는 alternatives[k] 가 아니라 spreadShapes(alternatives, SUB_VARIANTS)[k] 다
    // (place.mjs 와 같은 상수).
    const subModules = [];
    // 최상위가 쓰는 것부터 시작해 그 하위 모듈이 쓰는 것까지 **재귀로** 모은다 — comparator1 처럼
    // 계층이 세 단 이상이면 최상위의 직접 하위만 넘겨서는 배선기가 "모르는 concrete 이름" 으로 멈춘다.
    const queue = [...new Set(top.concrete)], seenSub = new Set();
    while (queue.length) {
      const cn = queue.shift();
      if (seenSub.has(cn)) continue;
      seenSub.add(cn);
      const nm = cn.includes("__v") ? cn.split("__v")[0] : cn;
      const m = r.modules.get(nm);
      if (!m || nm === topName) continue;           // 리프거나 최상위
      const picks = spreadShapes(m.alternatives ?? [m], SUB_VARIANTS);
      const vi = cn.includes("__v") ? Number(cn.split("__v")[1]) : 0;
      const pl = picks[Math.min(vi, picks.length - 1)] ?? m;
      const pp = pl.problem, [sx0, sy0] = [pl.box[0], pl.box[1]];
      subModules.push({
        abstract: nm, concrete: cn,
        bbox: [0, 0, Math.round(pl.box[2] - sx0), Math.round(pl.box[3] - sy0)],
        instances: pp.names.map((inm, k) => ({
          name: inm, concrete: pp.concrete[k],
          oX: Math.round(pl.cx[k] - pl.sx[k] * (pp.w[k] / 2) - sx0),
          oY: Math.round(pl.cy[k] - pl.sy[k] * (pp.h[k] / 2) - sy0),
          sX: pl.sx[k] > 0 ? 1 : -1, sY: pl.sy[k] > 0 ? 1 : -1,
        })),
      });
      for (const c of pp.concrete) queue.push(c);
    }

    // 하위 모듈이 어떤 모양들을 올렸는지 (표에 쓴다)
    const subs = [];
    for (const [nm, m] of r.modules) {
      if (nm === topName) continue;
      subs.push({ name: nm, blocks: m.names.length,
                  box: [Math.round(m.box[2] - m.box[0]), Math.round(m.box[3] - m.box[1])],
                  shapes: (m.alternatives ?? []).map((a) =>
                    [Math.round(a.box[2] - a.box[0]), Math.round(a.box[3] - a.box[1])]) });
    }
    post({
      type: "done",
      rects, bbox: box0,
      area: top.area, hpwl: top.hpwl, overlap: top.overlap,
      resid: symmetryResidual(P, top.cx, top.cy),
      orderBad: orderViolations(P, top.cx, top.cy).length,
      offgrid: top.gridOff, grid,
      nOrder: (P.constraints ?? []).filter((c) => c.constraint === "Order").length,
      axes: axes(P, top.cx, top.cy).map((a) => ({ ...a, at: a.at - (a.vert ? ox0 : oy0) })),
      combos: top.totalAssignments, configs: top.configs,
      hpwlWeight, lamRatio, medOverlap: top.medOverlap,
      starts: top.starts, rounds: top.rounds, runner: runner ? "gpu" : "cpu",
      perConfig: runner ? perConfig : null,
      tried: top.tried, legalFail: top.legalizeFail, gridTried: top.gridTried,
      phaseSecs: top.secs,
      legalFailBy: top.legalizeFailBy, legalRescued: top.legalizeRescued,
      hpwlBeforeFlip: top.hpwlBeforeFlip,
      subs, subModules,
      // 편집 키트 — 페이지가 이 배치의 문제(영공간·변이 후보·반전 자유도)를 다시 짓는 데 필요한 것 (src/edit/place.mjs)
      edit: editKit(r, grid), fixedVariants,
      secs: (performance.now() - t0) / 1000,
    });
  } catch (err) {
    // 첫 줄이 메시지다 — Safari·Firefox 의 stack 에는 메시지 없이 자리만 있다
    post({ type: "error", msg: `${err?.message ?? err}\n${err?.stack ?? ""}`.slice(0, 1200) });
  }
}

/** 편집 — 위상을 유지한 채 변이를 다시 고른다 (페이지의 "위상 유지 최적화"). 워커에서도 메인 스레드에서도 같다.
 *
 *  받는 것: { kind: "retry", blob, kit, rects, fixed, compact, hpwlWeight, cap }
 *    blob 은 {topology, primitives, templates}, kit 은 done 의 edit, rects 는 지금 좌표(done 과 같은 모양),
 *    fixed 는 사용자가 고정한 변이 { 인스턴스: concrete }.
 *  보내는 것: {type:"progress"} 몇 번, 그 다음 {type:"retry", ranking, current, total, tried, ms} —
 *    ranking 의 out 이 done 과 같은 모양의 rects·bbox·axes·지표라 그대로 덮어쓸 수 있다.
 */
export function runEdit(data, post) {
  const t0 = performance.now();
  try {
    const { blob, kit, rects, fixed = null, compact = 0.5, hpwlWeight = 1, cap = 128 } = data;
    const model = rebuild(blob, kit, rects);
    const { cx, cy } = centers(model);
    const r = retryVariants(model, cx, cy, model.sx, model.sy, {
      fixed, cap, hpwlWeight, compact,
      onProgress: (done, total) => { if (done % 4 === 0 || done === total) post({ type: "progress", done, total, phase: "변이", t: (performance.now() - t0) / 1000 }); },
    });
    post({ type: "retry", ranking: r.ranking, current: r.current, total: r.total, tried: r.tried, ms: r.ms });
  } catch (err) {
    post({ type: "error", msg: `${err?.message ?? err}\n${err?.stack ?? ""}`.slice(0, 1200) });
  }
}
