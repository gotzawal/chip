/** 배선이 끝난 hierNode 에서 gen_viewer_json (align/pnr/checkers.py:157-213) 이 더하는 도형 ("wires").
 *
 *  src/route/compose.mjs composeModule 의 wires 로 그대로 넘긴다 (블록 도형 다음에 붙는다):
 *
 *    Nets 다음 PowerNets 의 넷마다
 *      연결된 블록 핀의 pinContacts (고른 인스턴스)           "blockPin"
 *      path_metal 의 MetalRect                               "path_metal"
 *      path_via 의 UpperMetalRect, LowerMetalRect, ViaRect   "path_via"   (ViaRect.metal = "V1" ...)
 *      interVias (늘 비어 있다)                               "intervia"
 *    Gnd, Vdd 순 (GND 먼저) 전원 격자의 금속, 비아            "power grid metal" / "power grid via"
 *
 *  단자 접점은 내지 않는다 (ALIGN 에서 주석 처리). 좌표는 placedBox 를 PnRDB 단위에서 PDK 단위로:
 *  rational_scaling(mul=ScaleFactor, div=2) — 파이썬 // 라 내림이다.
 */
import { BLOCK, TERMINAL } from "./pnrdb.mjs";

const scaleOf = (sf) => (v) => Math.floor((sf * v) / 2);

/** @returns {Array<{netName, netType:"drawing", layer, rect:number[], tag, raw:number[]}>}
 *  raw 는 PnRDB 단위 사각형 — gen_viewer_json 의 격자 검사(add_terminal)와 rational_scaling 이 이것을 본다. */
export function viewerWires(hN, scaleFactor = 1) {
  const s = scaleOf(scaleFactor);
  const out = [];
  const add = (net, con, tag) => {
    const b = con.placedBox;
    const raw = [b.LL.x, b.LL.y, b.UR.x, b.UR.y];
    out.push({ netName: net, netType: "drawing", layer: con.metal, rect: raw.map(s), tag, raw });
  };
  const via = (net, v, tag) => { for (const k of ["UpperMetalRect", "LowerMetalRect", "ViaRect"]) add(net, v[k], tag); };
  for (const n of [...hN.Nets, ...hN.PowerNets]) {
    for (const c of n.connected) {
      if (c.type === BLOCK) {
        const bc = hN.Blocks[c.iter2];
        const blk = bc.instance[bc.selectedInstance];
        for (const con of blk.blockPins[c.iter].pinContacts) add(n.name, con, "blockPin");
      } else if (c.type !== TERMINAL) throw new Error(`gen_viewer_json: ${n.name} 의 연결 종류가 이상하다 ${c.type}`);
    }
    for (const m of n.path_metal) add(n.name, m.MetalRect, "path_metal");
    for (const v of n.path_via) via(n.name, v, "path_via");
    for (const v of n.interVias ?? []) via(n.name, v, "intervia");
  }
  for (const pg of [hN.Gnd, hN.Vdd]) {
    for (const m of pg.metals) add(pg.name, m.MetalRect, "power grid metal");
    for (const v of pg.vias) via(pg.name, v, "power grid via");
  }
  return out;
}

/** gen_viewer_json 의 fa_map — 넷(Nets 다음 PowerNets)에 물린 블록 핀 "<블록>/<핀>" -> 넷 이름.
 *  모듈 계층(1_topology)이 아니라 배선한 노드에서 짓는다. 한 핀이 두 넷에 물리면 ALIGN 처럼 멈춘다. */
export function viewerFaMap(hN) {
  const m = new Map();
  for (const n of [...hN.Nets, ...hN.PowerNets]) {
    for (const c of n.connected) {
      if (c.type !== BLOCK) continue;
      const bc = hN.Blocks[c.iter2];
      const blk = bc.instance[bc.selectedInstance];
      const formal = `${blk.name}/${blk.blockPins[c.iter].name}`;
      if (m.has(formal)) throw new Error(`gen_viewer_json: ${formal} 가 두 넷에 물려 있다 (${m.get(formal)}, ${n.name})`);
      m.set(formal, n.name);
    }
  }
  return m;
}

/** 모듈의 bbox (배선 뒤 LL/UR) — PDK 단위 */
export function viewerBbox(hN, scaleFactor = 1) {
  const s = scaleOf(scaleFactor);
  return [hN.LL.x, hN.LL.y, hN.UR.x, hN.UR.y].map(s);
}

const REFLECT = { N: [1, 1], FN: [-1, 1], FS: [1, -1], S: [-1, -1] };

/** 블록마다 gen_transformation (render_placement.py) — 고른 인스턴스의 방향과 자리로 만든 변환.
 *  tr2x 는 PnRDB 단위, tr 은 PDK 단위 (composeModule 의 블록 변환; 2 로 안 나뉘면 null).
 *  도형의 출처: 리프(child < 0)는 lefmaster 의 리프 도형, 하위 모듈은 gdsFile(./Results/<이름>.gds) 의 배선 결과. */
export function viewerBlocks(hN) {
  return hN.Blocks.map((bc) => {
    const blk = bc.instance[bc.selectedInstance];
    const o = blk.orient.replace(/^Omark\./, "");
    const r = REFLECT[o];
    if (!r) throw new Error(`gen_transformation: ${blk.name} 의 방향 ${o} 는 orient_map 에 없다`);
    const [sX, sY] = r;
    const tr2x = {
      oX: blk.placedBox.LL.x - blk.originBox.LL.x + (sX === 1 ? 0 : blk.width),
      oY: blk.placedBox.LL.y - blk.originBox.LL.y + (sY === 1 ? 0 : blk.height),
      sX, sY,
    };
    const tr = tr2x.oX % 2 || tr2x.oY % 2 ? null : { oX: tr2x.oX / 2, oY: tr2x.oY / 2, sX, sY };
    return { name: blk.name, master: blk.master, lefmaster: blk.lefmaster, gdsFile: blk.gdsFile, orient: blk.orient,
             isLeaf: bc.child < 0, tr2x, tr };
  });
}
