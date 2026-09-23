/** 도형 합성 — ALIGN gen_viewer_json (align/pnr/checkers.py) 의 JS 판.
 *
 *  모듈 하나의 도형을 모은다. 검사기(check.mjs)와 GDS(gds.mjs)가 이 목록을 읽는다.
 *
 *    블록    리프(data/<예제>.leaves.json) 또는 배선이 끝난 하위 모듈의 도형을 배치 변환으로
 *            옮기고, 넷 이름을 모듈의 넷으로 바꾼다:
 *              핀 넷      "<블록>/<핀>" 이 모듈 fa_map 에 있으면 그 넷
 *              전원 넷    전역 전원 이름이면 그대로
 *              그 밖      "<블록>/<넷>" (블록 안에서만 쓰는 넷)
 *              V0 접점    "<블록>/<소자>:<단자>" — 검사기가 소자 단자로 읽는다
 *    배선    배선기가 낸 금속·비아. M1~M6 은 트랙 위에 있는지 본다 (격자 밖이면 오류 문구).
 *
 *  ALIGN 과 다른 점은 단위 하나다. ALIGN 은 PnRDB 의 2 배 단위로 옮긴 뒤 반으로 줄이고,
 *  홀수가 되면 오류를 낸다. 여기서는 처음부터 PDK 단위로 다룬다 — 변환이 정수면 결과가
 *  같고, 배치기의 변환은 늘 정수다 (정수가 아니면 여기서 멈춘다).
 */

// ---------------------------------------------------------------- 변환
/** ALIGN transformation (회전 없음): x' = oX + sX x, y' = oY + sY y. sX, sY 는 1 또는 -1. */
export function trRect(tr, r) {
  const x0 = tr.oX + tr.sX * r[0], x1 = tr.oX + tr.sX * r[2];
  const y0 = tr.oY + tr.sY * r[1], y1 = tr.oY + tr.sY * r[3];
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** outer(inner(x)) */
export const trCompose = (outer, inner) => ({
  oX: outer.oX + outer.sX * inner.oX, oY: outer.oY + outer.sY * inner.oY,
  sX: outer.sX * inner.sX, sY: outer.sY * inner.sY,
});

export const IDENTITY = Object.freeze({ oX: 0, oY: 0, sX: 1, sY: 1 });

function checkTr(tr, what) {
  if (![tr.oX, tr.oY].every(Number.isInteger) || ![tr.sX, tr.sY].every((s) => s === 1 || s === -1))
    throw new Error(`${what}: 변환이 정수 이동 + 거울이 아니다 ${JSON.stringify(tr)}`);
}

// ---------------------------------------------------------------- 격자
const pyList = (a) => "[" + a.join(", ") + "]";

/** 금속 층의 중심선 격자 — DefaultCanvas._create_metal 의 clg (색이 있으면 색 수만큼 한 주기). */
export function metalGrids(pdk) {
  const grids = new Map();
  for (const L of pdk.Abstraction) {
    if (!/^M\d+$/.test(L.Layer)) continue;
    const first = (v) => (Array.isArray(v) ? v[0] : v);
    const pitch = first(L.Pitch), offset = first(L.Offset);
    const n = L.Color?.length ? L.Color.length : 1;
    grids.set(L.Layer, { lines: Array.from({ length: n + 1 }, (_, i) => offset + i * pitch), dir: L.Direction.toLowerCase() });
  }
  return grids;
}

/** Grid.inverseBounds -> [[q, lo], [q, hi]] */
function inverseBounds(lines, v) {
  const offset = lines[0], period = lines[lines.length - 1] - offset;
  const q = Math.floor((v - offset) / period), r = v - offset - q * period;
  const mono = lines.map((x, i) => [i, x]).sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < mono.length; i++) {
    const [idx, val] = mono[i];
    if (val - offset === r) return [[q, idx], [q, idx]];
    if (val - offset > r) return [[q, mono[i - 1][0]], [q, idx]];
  }
  return null;
}

/** add_terminal 의 격자 검사. M1/M3/M5 는 x 중심, M2/M4/M6 은 y 중심이 트랙 위여야 한다.
 *  문구는 ALIGN 과 같다 (사각형은 2 배 단위로 찍힌다). raw 는 PnRDB(2 배) 단위 사각형 — 주면 그것을 본다
 *  (배선기가 낸 도형은 홀수 좌표일 수 있어 반으로 줄인 뒤에는 되살릴 수 없다). */
export function offGrid(t, grids, tag = null, raw = null) {
  const layer = t.layer;
  let axis = null;
  if (["M1", "M3", "M5"].includes(layer)) axis = 0;
  else if (["M2", "M4", "M6"].includes(layer)) axis = 1;
  if (axis == null) return [];
  const r = raw ?? t.rect.map((v) => 2 * v);
  const center = Math.floor((r[axis] + r[axis + 2]) / 2);
  const head = `Off grid:${tag ?? "None"} ${layer} ${t.netName ?? "None"} ${pyList(r)} ${r[2] - r[0]} ${r[3] - r[1]}: `;
  if (center % 2 !== 0) return [head + `${center} (in 2x units) is not divisible by two.`];
  const value = Math.floor(center / 2);
  const p = inverseBounds(grids.get(layer).lines, value);
  if (p[0][1] !== p[1][1]) return [head + `${value} doesn't land on grid, lb and ub are: ((${p[0][0]}, ${p[0][1]}), (${p[1][0]}, ${p[1][1]}))`];
  return [];
}

// ---------------------------------------------------------------- 합성
/**
 * 블록 하나의 도형을 모듈 좌표·모듈 넷 이름으로.
 * @param {{name:string, tr:object, terminals:Array, subinsts?:string[]}} block
 * @param {Map<string,string>} faMap  "<블록>/<핀>" -> 모듈 넷
 * @param {Set<string>} powerNets
 */
export function placeBlock(block, faMap, powerNets) {
  checkTr(block.tr, block.name);
  const out = [];
  for (const t0 of block.terminals) {
    if (t0.layer === "boundary") continue;
    const t = { ...t0, rect: trRect(block.tr, t0.rect) };
    delete t.pin;
    if (t.netName != null) {
      const formal = `${block.name}/${t.netName}`;
      t.netName = faMap.get(formal) ?? (powerNets.has(t.netName) ? t.netName : formal);
    }
    if (t.terminal) {
      if (t.terminal.length !== 2) throw new Error(`단자가 이상하다: ${JSON.stringify(t.terminal)}`);
      t.netName = `${block.name}/${t.terminal.join(":")}`;
      t.terminal = [`${block.name}/${t.terminal[0]}`, t.terminal[1]];
    }
    out.push(t);
  }
  return out;
}

/**
 * 모듈 하나 — 블록 도형 다음에 배선 도형 (gen_viewer_json 과 같은 순서).
 * @param {object} o
 * @param {Array<{name, tr, terminals, subinsts?}>} o.blocks
 * @param {Map<string,string>} o.faMap
 * @param {Set<string>} o.powerNets
 * @param {Array<{netName, layer, rect, tag?}>} [o.wires]  배선기 출력 (PDK 단위)
 * @param {Map} [o.grids]  metalGrids(pdk) — 주면 배선 도형의 격자를 본다
 * @returns {{terminals:Array, subinsts:string[], errors:string[]}}
 */
export function composeModule({ blocks, faMap, powerNets, wires = [], grids = null }) {
  const terminals = [], subinsts = [], seen = new Set(), errors = [];
  for (const b of blocks) {
    terminals.push(...placeBlock(b, faMap, powerNets));
    for (const s of b.subinsts ?? []) {
      const k = `${b.name}/${s}`;
      if (!seen.has(k)) { seen.add(k); subinsts.push(k); }
    }
  }
  for (const w of wires) {
    const t = { netName: w.netName, netType: "drawing", layer: w.layer, rect: w.rect.slice() };
    terminals.push(t);
    if (grids) errors.push(...offGrid(t, grids, w.tag ?? null));
  }
  return { terminals, subinsts, errors };
}
