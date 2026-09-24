/** 배선 한 판 — ALIGN 의 배선 단계(align/pnr: route_bottom_up 다음 _generate_json)를 그대로 따른다.
 *
 *  배선 워커(routeworker.mjs), 워커가 안 서는 브라우저의 메인 스레드, node 하네스(newroute.mjs)가 같은 것을 부른다.
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
import { clone } from "./align/pnrdb.mjs";
import { wireModel } from "../edit/wires.mjs";

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
 * @returns {{terminals:Array, bbox:number[], errors:string[]}}
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
  return { terminals: result.terminals, bbox: viewerBbox(node), errors: errorLines(result, viewerErrors) };
}

/** 고정 넷을 최상위 일감에 심는다 (편집기의 넷 고정, symplace/PLAN-edit.md 4.5 절).
 *
 *  DoNotRoute 에 넣어 상세 배선이 그 넷을 건너뛰게 하고, 경로의 금속·비아 사각형을 첫 블록의 내부 금속·비아로 붙인다 —
 *  배선기는 블록 내부 금속을 전역 배선의 용량과 상세·전원 배선의 장애물로 본다. 배선 뒤에 경로를 넷에 되붙인다
 *  (routeSession). 편법이다 — 다음에 wasm 을 빌드할 때 Job 에 obstacles 를 더해 옮긴다. 고정이 없으면 아무것도 안 한다. */
function freezeNets(job, frozen) {
  if (!frozen.length) return;
  job.node.DoNotRoute = [...new Set([...(job.node.DoNotRoute ?? []), ...frozen.map((f) => f.net)])];
  const bc = job.node.Blocks[0];
  if (!bc) return;
  const inst = bc.instance[bc.selectedInstance];
  for (const f of frozen) {
    for (const m of f.path_metal ?? []) inst.interMetals.push(clone(m.MetalRect));
    for (const v of f.path_via ?? []) {
      inst.interMetals.push(clone(v.UpperMetalRect), clone(v.LowerMetalRect));
      inst.interVias.push(clone(v));
    }
  }
}

/**
 * 배선 한 판을 돌리고 **세션**을 돌려준다 — 모듈마다의 hierNode 와 검사 도형. 편집기가 배선기 없이 다시 검사하거나
 * (recheck) 넷을 고정한 채 다시 배선하려면 이것이 있어야 한다. routeDesign 은 이것의 출력만 낸다.
 *
 * @param {object} o
 * @param {{topology, primitives}} o.design   예제 파일 또는 앞단 출력
 * @param {object} o.leaves                  리프 도형 ({format: "leaves/1", leaves} 또는 readLeaves 결과)
 * @param {object} o.placement               {bbox, instances, subModules} — 페이지의 배치
 * @param {{route(job:object): Promise<{records:Array, warnings?:string[]}>}} o.router
 *        loadAlignRouter() 결과
 * @param {Array<{net, path_metal, path_via}>} [o.frozen]   고정할 넷 (최상위) — 그 경로 그대로, 나머지만 배선한다
 * @param {number[]|Date} [o.time]           GDS 에 적을 시각
 * @param {(text:string) => void} [o.say]    진행 (모듈마다 한 줄)
 */
export async function routeSession({ design, leaves, placement, router, frozen = [], time, say }) {
  const lv = leaves?.format ? readLeaves(leaves) : leaves;
  const warnings = [];
  const routeModule = async (job) => {
    if (job.node.isTop) freezeNets(job, frozen);
    say?.(`${job.node.name} — RouteWork ${job.modes.join("·")}`);
    const r = await router.route(job);
    for (const w of r.warnings ?? []) warnings.push(`${job.node.name}: ${w}`);
    return r;
  };
  const res = await routeBottomUp({ design, leaves: lv, placement, pdk: MOCK_PDK, routeModule });
  const topM = res.modules.find((m) => m.isTop);
  if (!topM) throw new Error("최상위 모듈을 배선하지 않았다");
  // 고정 넷의 경로를 되붙인다 — 배선기는 그 넷을 비워서 돌려준다
  for (const f of frozen) {
    const n = topM.node.Nets.find((q) => q.name === f.net);
    if (n) { n.path_metal = clone(f.path_metal ?? []); n.path_via = clone(f.path_via ?? []); }
  }
  const session = { design, placement, lv, res, warnings, time, outs: new Map(), outputs: new Map(), top: null,
                    frozen: frozen.map((f) => f.net), orig: new Map() };
  // _generate_json — results_name_map 의 차례(배선한 차례)로. 하위 모듈이 먼저라 부모가 그 결과를 읽는다.
  for (const m of res.modules) {
    const variant = `${m.name}_${m.sel}`;
    const c = checkModule(m.node, { leaves: lv, pnrConst: res.prep.pnrConst, outs: session.outs });
    session.outs.set(variant, c.terminals);
    session.outputs.set(variant, c);
    if (m.isTop) session.top = { m, c, variant };
  }
  // 넷마다 배선기가 낸(또는 고정한) 경로 — 편집을 "원래대로" 되돌릴 때 쓴다
  for (const n of topM.node.Nets) session.orig.set(n.name, { path_metal: clone(n.path_metal), path_via: clone(n.path_via) });
  return session;
}

/** 세션의 지금 상태 -> 페이지가 받는 출력 (geo, gds, errors, wires ...) */
export function sessionOutput(session) {
  const { res, outputs, top, warnings, time } = session;
  // ALIGN 이 쓰는 3_pnr/<모듈>_<j>.errors 를 파일 이름 순으로 이은 것
  const errors = [...outputs.keys()].sort((a, b) => ((a + ".errors") < (b + ".errors") ? -1 : 1))
    .flatMap((v) => outputs.get(v).errors);
  const { bbox, terminals } = top.c;
  const gds = topGds({ name: top.m.name, terminals, bbox, time }, MOCK_PDK);
  // <TOP>_0.json 과 같은 모양: 맨 앞에 Outline, 색 사본까지
  const geo = { bbox, terminals: [{ layer: "Outline", netName: null, netType: "drawing", rect: bbox.slice() }, ...terminals] };
  const records = res.modules.flatMap((m) => m.records);
  return {
    name: top.m.name, geo, gds, errors, records, warnings,
    stats: {
      modules: res.modules.length, nets: top.m.node.Nets.length,
      routerMs: records.reduce((s, r) => s + (r.ms ?? 0), 0),
    },
    // 편집기의 넷 모델 (최상위, PnRDB 단위) 과 고정 넷
    wires: wireModel(top.m.node), frozen: session.frozen.slice(),
  };
}

/**
 * 편집한 넷의 경로를 최상위 노드에 넣고 **배선기 없이** 다시 검사한다 — 도형 합성, DRC/LVS, GDS.
 * edits: [{ net, path_metal, path_via }] 또는 { net, restore: true } (배선기가 낸 경로로). 비어 있으면 그대로 다시 검사.
 */
export function recheck(session, edits = []) {
  const node = session.top.m.node;
  for (const e of edits) {
    const n = node.Nets.find((q) => q.name === e.net);
    if (!n) throw new Error(`넷이 없다: ${e.net}`);
    const src = e.restore ? session.orig.get(e.net) : e;
    n.path_metal = clone(src.path_metal ?? []); n.path_via = clone(src.path_via ?? []);
  }
  const c = checkModule(node, { leaves: session.lv, pnrConst: session.res.prep.pnrConst, outs: session.outs });
  session.outs.set(session.top.variant, c.terminals);
  session.outputs.set(session.top.variant, c);
  session.top.c = c;
  return sessionOutput(session);
}

/** 배선 한 판 — 세션 없이 출력만 (지금까지의 입구, 그대로) */
export async function routeDesign(args) {
  return sessionOutput(await routeSession(args));
}

/** 페이지로 보낼 메시지 (워커든 메인 스레드든 같은 모양). gds 는 ArrayBuffer — 워커는 옮겨 보낸다. */
export function routeMessage(out, secs) {
  return { type: "route", ok: true, name: out.name, secs, gds: out.gds.buffer, gdsName: out.name + ".gds",
           errors: out.errors, nerrors: out.errors.length, geo: out.geo, stats: out.stats,
           warnings: out.warnings, wires: out.wires, frozen: out.frozen };
}
