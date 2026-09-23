/** 배선 한 판 — ALIGN 의 배선 단계(align/pnr: route_bottom_up 다음 _generate_json)를 그대로 따른다.
 *
 *  배선 워커(routeworker.mjs), 워커가 안 서는 브라우저의 메인 스레드, node 시험이 같은 것을 부른다.
 *
 *    입력·PnRDB·배치·계층   align/bottomup.mjs      ALIGN 이 배선기에 넘기는 hierNode 를 비트까지 같게
 *    배선                   alignroute.wasm         ALIGN C++ 배선기(RouteWork 4·5, 최상위는 2·3 까지)를 Rust 로
 *    도형 모으기             align/wires.mjs, compose.mjs   gen_viewer_json (모듈마다, 배선한 차례로)
 *    검사                   check.mjs               ALIGN cell_fabric 의 DRC/LVS (최상위는 색 칠하기까지)
 *    GDS                    gds.mjs                 ALIGN 의 파이썬 GDS 경로와 같은 바이트
 *
 *  모듈마다 _generate_json 처럼 한다: 블록 도형(리프는 리프 도형, 하위 모듈은 먼저 검사한 그 모듈의 결과)을
 *  배치 변환으로 옮기고 배선 도형을 붙여 검사한다. 하위 모듈은 전원 넷이 열려도 되고, 최상위만 색을 칠하고
 *  GDS 를 쓴다. 오류 문구는 모듈마다 ALIGN 의 <모듈>_<j>.errors 와 같고, 그 파일 이름 순으로 잇는다.
 */
import { routeBottomUp } from "./align/bottomup.mjs";
import { viewerBbox, viewerBlocks, viewerFaMap, viewerWires } from "./align/wires.mjs";
import { check, checkerRules, errorLines, pyList, pyStr } from "./check.mjs";
import { composeModule, metalGrids, offGrid } from "./compose.mjs";
import { topGds } from "./gds.mjs";
import { readLeaves, unpackLeaf } from "./leaves.mjs";
import { MOCK_PDK } from "./pdk.mjs";

const rules = checkerRules(MOCK_PDK);
const grids = metalGrids(MOCK_PDK);
// gen_viewer_json 은 PnRDB(2 배) 단위를 rational_scaling(mul=ScaleFactor, div=2) 로 줄인다. 격자 검사도 1 을 가정한다.
if (MOCK_PDK.ScaleFactor !== 1) throw new Error(`PDK ScaleFactor ${MOCK_PDK.ScaleFactor} — 1 만 다룬다`);
const RESULTS = /^(\.\/|)Results\/(\S+)\.gds$/;

/** rational_scaling 의 문구에 찍히는 파이썬 dict (add_terminal 이 만든 열쇠 순서, PnRDB 단위) */
const termRepr = (w) => `{'netName': ${pyStr(w.netName)}, 'netType': 'drawing', 'layer': ${pyStr(w.layer)}, 'rect': ${pyList(w.raw)}}`;

const doNotRoute = (pc) => (pc?.constraints ?? []).filter((c) => c.const_name === "DoNotRoute").flatMap((c) => c.nets);

/**
 * gen_viewer_json + gen_data — 배선이 끝난 모듈 하나.
 * @param {object} node          기록을 합친 hierNode (routeBottomUp 의 modules[].node)
 * @param {object} o
 * @param {object} o.leaves      readLeaves() 결과
 * @param {object} o.pnrConst    모듈 -> pnr.const.json (DoNotRoute 넷은 열려도 된다)
 * @param {Map<string,Array>} o.outs   먼저 검사한 모듈의 도형 (<모듈>_<j> -> 도형) — 하위 모듈 블록이 읽는다
 * @returns {{terminals:Array, bbox:number[], errors:string[], result:object, wires:Array}}
 */
export function checkModule(node, { leaves, pnrConst, outs }) {
  const power = new Set(node.PowerNets.map((n) => n.name));
  const faMap = viewerFaMap(node);
  const blocks = [];
  for (const b of viewerBlocks(node)) {
    if (!b.tr) throw new Error(`${node.name}: 블록 ${b.name} 의 변환이 2 로 안 나뉜다 ${JSON.stringify(b.tr2x)}`);
    if (b.isLeaf) {
      const leaf = leaves[b.lefmaster];
      if (!leaf) throw new Error(`${node.name}: 리프 도형이 없다 — ${b.lefmaster}`);
      const L = unpackLeaf(leaf);
      blocks.push({ name: b.name, tr: b.tr, terminals: L.terminals, subinsts: L.subinsts });
    } else {
      const m = RESULTS.exec(b.gdsFile ?? "");
      const sub = m && outs.get(m[2]);
      if (!sub) throw new Error(`${node.name}: 하위 모듈 블록 ${b.name} 의 도형이 없다 (${b.gdsFile})`);
      blocks.push({ name: b.name, tr: b.tr, terminals: sub });
    }
  }
  const wires = viewerWires(node);
  const comp = composeModule({ blocks, faMap, powerNets: power, wires });

  // add_terminal 의 격자 검사, 그 다음 rational_scaling — 둘 다 PnRDB 단위에서 본다 (블록 도형은 늘 짝수다)
  const viewerErrors = [];
  for (const w of wires) viewerErrors.push(...offGrid(w, grids, w.tag, w.raw));
  for (const w of wires) if (w.raw.some((v) => v % 2 !== 0)) viewerErrors.push(`Terminal ${termRepr(w)} not a multiple of 2 (mul=1).`);
  const raw = [node.LL.x, node.LL.y, node.UR.x, node.UR.y];
  if (raw.some((v) => v % 2 !== 0)) throw new Error(`${node.name}: bbox 가 2 의 배수가 아니다 (rational_scaling 의 assert) ${raw}`);

  const allowed = new Set(doNotRoute(pnrConst[node.name]));
  if (!node.isTop) for (const p of power) allowed.add(p);
  const result = check(comp.terminals, rules, { netsAllowedToBeOpen: [...allowed], postprocess: node.isTop, subinsts: comp.subinsts });
  return { terminals: result.terminals, bbox: viewerBbox(node), errors: errorLines(result, viewerErrors), result, wires };
}

/**
 * @param {object} o
 * @param {{topology, primitives}} o.design   예제 파일 또는 앞단 출력
 * @param {object} o.leaves                  리프 도형 ({format: "leaves/1", leaves} 또는 readLeaves 결과)
 * @param {object} o.placement               {bbox, instances, subModules} — 페이지의 배치
 * @param {{route(job:object): Promise<{records:Array, warnings?:string[]}>}} o.router
 *        loadAlignRouter() 결과 (시험에서는 기준 기록을 돌려주는 가짜)
 * @param {number[]|Date} [o.time]           GDS 에 적을 시각
 * @param {(text:string) => void} [o.say]    진행 (모듈마다 한 줄)
 */
export async function routeDesign({ design, leaves, placement, router, time, say }) {
  const lv = leaves?.format ? readLeaves(leaves) : leaves;
  const warnings = [];
  const routeModule = async (job) => {
    say?.(`${job.node.name} — RouteWork ${job.modes.join("·")}`);
    const r = await router.route(job);
    for (const w of r.warnings ?? []) warnings.push(`${job.node.name}: ${w}`);
    return r;
  };
  const res = await routeBottomUp({ design, leaves: lv, placement, pdk: MOCK_PDK, routeModule });

  // _generate_json — results_name_map 의 차례(배선한 차례)로. 하위 모듈이 먼저라 부모가 그 결과를 읽는다.
  const outs = new Map(), outputs = new Map();
  let top = null;
  for (const m of res.modules) {
    const variant = `${m.name}_${m.sel}`;
    const c = checkModule(m.node, { leaves: lv, pnrConst: res.prep.pnrConst, outs });
    outs.set(variant, c.terminals);
    outputs.set(variant, c);
    if (m.isTop) top = { m, c };
  }
  if (!top) throw new Error("최상위 모듈을 배선하지 않았다");

  // pyroute.py 처럼 3_pnr/*.errors 를 파일 이름 순으로
  const errors = [...outputs.keys()].sort((a, b) => ((a + ".errors") < (b + ".errors") ? -1 : 1))
    .flatMap((v) => outputs.get(v).errors);
  const { bbox, terminals } = top.c;
  const gds = topGds({ name: top.m.name, terminals, bbox, time }, MOCK_PDK);
  // <TOP>_0.json 과 같은 모양: 맨 앞에 Outline, 색 사본까지
  const geo = { bbox, terminals: [{ layer: "Outline", netName: null, netType: "drawing", rect: bbox.slice() }, ...terminals] };
  const records = res.modules.flatMap((m) => m.records);
  return {
    name: top.m.name, geo, gds, errors, records, warnings, outputs, res,
    stats: {
      modules: res.modules.length, nets: top.m.node.Nets.length, wires: top.c.wires.length,
      routerMs: records.reduce((s, r) => s + (r.ms ?? 0), 0),
    },
  };
}

/** 페이지로 보낼 메시지 (워커든 메인 스레드든 같은 모양). gds 는 ArrayBuffer — 워커는 옮겨 보낸다. */
export function routeMessage(out, secs) {
  return { type: "route", ok: true, name: out.name, secs, gds: out.gds.buffer, gdsName: out.name + ".gds",
           errors: out.errors, nerrors: out.errors.length, geo: out.geo, stats: out.stats,
           records: out.records, warnings: out.warnings };
}
