/** 리프 셀(2_primitives/<concrete>.json)의 전체 도형 — 배선할 때만 쓴다.
 *
 *  배치기는 리프의 bbox 와 핀(netType "pin")만 본다 (data/<예제>.json 의 templates).
 *  배선·도형 합성·DRC·GDS 에는 나머지 도형이 전부 필요하다 — 소자 내부의 M1·V0·V1,
 *  Fin·Poly 같은 소자층까지. 그걸 이 모양으로 싣는다.
 *
 *    { format: "leaves/1",
 *      leaves: { <concrete>: { bbox: [x0,y0,x1,y1],
 *                              t: [[layer, net, pin, x0, y0, x1, y1, terminal?], ...],
 *                              s: [subinst, ...]? } } }
 *
 *    net       netName (없으면 null — 소자층 도형은 넷이 없다)
 *    pin       1 이면 netType "pin", 0 이면 "drawing"
 *    terminal  [subinst, 단자] — V0 접점에만 있다. 검사기가 소자 단자를 가르는 데 쓴다.
 *    s         리프 JSON 의 subinsts 이름들 (그 순서 그대로). 도형 합성이 검사기의 subinsts 를
 *              ALIGN 과 같은 순서로 채우는 데 쓴다 — V0 가 나오는 순서와 다르다. 없으면 [].
 *
 *  리프 LEF 는 이것의 함수다 — 배선 입력을 만들 때 align/prep.mjs 가 짓는다 (cell_fabric/gen_lef.py).
 */

export const LEAVES_FORMAT = "leaves/1";

/** ALIGN 리프 JSON 하나 -> 압축 항목. */
export function packLeaf(d) {
  const e = {
    bbox: d.bbox.map(Number),
    t: (d.terminals ?? []).map((t) => {
      const row = [t.layer, t.netName ?? null, t.netType === "pin" ? 1 : 0, ...t.rect.map(Number)];
      if (t.terminal) row.push(t.terminal);
      return row;
    }),
  };
  const s = Object.keys(d.subinsts ?? {});
  if (s.length) e.s = s;
  return e;
}

/** {concrete: ALIGN 리프 JSON} -> 파일 한 덩이. */
export function packLeaves(byConcrete) {
  const leaves = {};
  for (const cn of Object.keys(byConcrete).sort()) leaves[cn] = packLeaf(byConcrete[cn]);
  return { format: LEAVES_FORMAT, leaves };
}

/** 압축 항목 -> ALIGN 리프 JSON 과 같은 모양 {bbox, terminals, subinsts}. subinsts 는 이름 배열이다. */
export function unpackLeaf(e) {
  return {
    bbox: e.bbox.slice(),
    terminals: e.t.map(([layer, net, pin, x0, y0, x1, y1, terminal]) => {
      const t = { layer, netName: net, netType: pin ? "pin" : "drawing", rect: [x0, y0, x1, y1] };
      if (terminal) t.terminal = terminal.slice();
      return t;
    }),
    subinsts: (e.s ?? []).slice(),
  };
}

/** 파일 한 덩이를 확인하고 {concrete: 압축 항목} 을 돌려준다. */
export function readLeaves(obj) {
  if (!obj || obj.format !== LEAVES_FORMAT || !obj.leaves)
    throw new Error(`리프 도형 형식이 아니다 (format ${obj?.format ?? "없음"}, ${LEAVES_FORMAT} 이어야 한다)`);
  return obj.leaves;
}
