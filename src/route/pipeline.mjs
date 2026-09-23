/** 배선 한 판 — 배치가 끝난 설계를 배선하고, ALIGN 과 같은 잣대로 검사하고, GDS 로 쓴다.
 *
 *  배선 워커(routeworker.mjs), 워커가 안 서는 브라우저의 메인 스레드, node 도구가 같은 것을 부른다.
 *
 *    배선 문제   problem.mjs   계층을 펼치고, 배선 전 OPEN 을 이을 일로
 *    배선        router.wasm   Rust 격자 배선기 (router.mjs 가 부른다)
 *    검사        check.mjs     ALIGN cell_fabric 의 DRC/LVS 를 옮긴 것 (최상위: 색 칠하기까지)
 *    GDS         gds.mjs       ALIGN 의 파이썬 GDS 경로와 같은 바이트
 */
import { check, checkerRules, errorLines } from "./check.mjs";
import { metalGrids, offGrid } from "./compose.mjs";
import { topGds } from "./gds.mjs";
import { readLeaves } from "./leaves.mjs";
import { MOCK_PDK } from "./pdk.mjs";
import { buildProblem } from "./problem.mjs";

const rules = checkerRules(MOCK_PDK);
const grids = metalGrids(MOCK_PDK);

const bounds = (ts) => ts.reduce((a, t) => [Math.min(a[0], t.rect[0]), Math.min(a[1], t.rect[1]),
                                            Math.max(a[2], t.rect[2]), Math.max(a[3], t.rect[3])],
                                  [Infinity, Infinity, -Infinity, -Infinity]);

/**
 * @param {object} o
 * @param {{topology:object}} o.design     예제 파일 또는 앞단 출력 (topology 만 쓴다)
 * @param {object} o.leaves                리프 도형 파일 한 덩이 ({format: "leaves/1", leaves})
 * @param {object} o.placement             {bbox, instances, subModules} — 페이지의 배치
 * @param {object} o.router                loadRouter() 결과
 * @param {object} [o.options]             배선층 범위 등 (router.mjs packProblem)
 * @param {number[]|Date} [o.time]         GDS 에 적을 시각
 */
export function routeDesign({ design, leaves, placement, router, options = {}, time }) {
  const { problem, layout, pre } = buildProblem({ design, leaves: readLeaves(leaves), placement, pdk: MOCK_PDK });
  const r = router.route(problem, options);
  const wires = r.wires.map((w) => ({ netName: w.netName, netType: "drawing", layer: w.layer, rect: w.rect }));
  const result = check([...layout.terminals, ...wires], rules, { subinsts: layout.subinsts, postprocess: true });
  const errors = errorLines(result, wires.flatMap((w) => offGrid(w, grids, "route")));
  const bbox = bounds(result.terminals);
  const gds = topGds({ name: problem.name, terminals: result.terminals, bbox, time }, MOCK_PDK);
  // 그림에는 색 사본을 뺀다 (같은 사각형이 두 번 그려질 뿐이다). 맨 앞의 Outline 은 ALIGN 과 같다.
  const geo = { bbox, terminals: [{ layer: "Outline", netName: null, netType: "drawing", rect: bbox.slice() },
                                   ...result.terminals.filter((t) => !t.color)] };
  return {
    name: problem.name, problem, layout, pre, wires, result, errors, geo, gds,
    stats: { nets: problem.nets.filter((n) => n.parts > 1).length, wires: r.wires.length, failed: r.failed,
             iterations: r.iterations, mirrored: r.mirrored, pairs: r.pairs, routerMs: r.ms },
  };
}

/** 페이지로 보낼 메시지 (워커든 메인 스레드든 같은 모양). gds 는 ArrayBuffer — 워커는 옮겨 보낸다. */
export function routeMessage(out, secs) {
  return { type: "route", ok: true, name: out.name, secs, gds: out.gds.buffer, gdsName: out.name + ".gds",
           errors: out.errors, nerrors: out.errors.length, geo: out.geo, stats: out.stats };
}
