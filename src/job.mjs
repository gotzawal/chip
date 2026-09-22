/** 배치 한 판 — 워커에서도, 메인 스레드에서도 같은 코드가 돈다.
 *
 *  예제 하나가 8~107 초 걸린다. 그래서 보통은 워커에서 돈다 (worker.mjs 가
 *  이 파일을 감싼다). 다만 **모듈 워커가 없는 브라우저**가 있어 —
 *  구형 사파리에서 조용히 죽는다 — index.html 은 워커가 안 서면 이 함수를
 *  메인 스레드에서 직접 부른다. 그래서 워커 전용 API(self, postMessage)를
 *  쓰지 않고, 내보낼 것은 인자로 받은 post 로 넘긴다.
 *
 *  받는 것: { name, blob, batch, previewOnly }  blob = {topology, primitives, templates, place}
 *  post 로 보내는 것:
 *    {type:"baseline", ...}  ALIGN 이 낸 배치 — 즉시
 *    {type:"progress", ...}  후보 진행
 *    {type:"frame", ...}     설정 하나가 끝날 때의 최선 — 재배치 과정이 보인다
 *    {type:"done", ...}      우리 배치
 *    {type:"error", ...}
 */
import { readDesign, topIndex, moduleOrder, variantGroups,
         countAssignments } from "./design.mjs";
import { baseline, axes } from "./baseline.mjs";
import { placeHierarchy, symmetryResidual, orderViolations,
         spreadShapes, SUB_VARIANTS } from "./place.mjs";

export async function runJob(data, post) {
  const { name, blob, batch, previewOnly, grid = [80, 84] } = data;
  try {
    const topName = blob.topology.modules[topIndex(blob.topology)].name;
    const order = moduleOrder(blob.topology);
    const base = blob.place ? baseline(blob.place, topName) : null;

    // 변이 조합이 몇 개인지 미리 알려준다 (최상위 기준, 하위 모듈 변이 전)
    const d0 = readDesign({ ...blob, top: order[0] });
    post({ type: "baseline", base, topName, order,
                  modules: order.length,
                  leafCombos: countAssignments(variantGroups(d0)) });
    if (previewOnly) return;          // 기준선만 뽑고 끝 — 배치는 안 돌린다

    const t0 = performance.now();
    let seen = 0, frames = 0, lastFrame = 0;
    const r = placeHierarchy(blob, {
      batch, iters: 600, seed: 1, grid,
      onProgress: (done, total) => {
        seen++;
        if (seen % 8 === 0)
          post({ type: "progress", done, total,
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
    // 기준이 달라져 나란히 비교가 어긋난다. (emit.mjs 도 같은 이유로 당긴다.)
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
    // emit.mjs 와 같은 규칙으로 고른다: __v{k} 는 alternatives[k] 가 아니라
    // spreadShapes(alternatives, SUB_VARIANTS)[k] 다 (place.mjs 와 같은 상수).
    const subModules = [];
    for (const [nm, m] of r.modules) {
      if (nm === topName) continue;
      const used = [...new Set(top.concrete.filter(
        (c) => c === nm || c.startsWith(nm + "__v")))];
      for (const cn of used) {
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
      }
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
      starts: top.starts, rounds: top.rounds,
      tried: top.tried, legalFail: top.legalizeFail,
      legalFailBy: top.legalizeFailBy, legalRescued: top.legalizeRescued,
      hpwlBeforeFlip: top.hpwlBeforeFlip,
      subs, subModules,
      secs: (performance.now() - t0) / 1000,
    });
  } catch (err) {
    post({ type: "error", msg: String(err && err.stack || err).slice(0, 1200) });
  }
}
