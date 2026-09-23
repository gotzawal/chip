/** Rust 배선기(src/route/router.wasm, 소스 symplace/router)를 부른다 — 페이지와 node 공용.
 *
 *    const router = await loadRouter(wasmBytes)
 *    const out = router.route(problem, { minLayer: "M2", maxLayer: "M4" })
 *      -> { wires: [{netName, layer, rect}], failed: [넷 이름], iterations, violations,
 *           mirrored, pairs (대칭 넷 쌍 중 거울 경로 그대로인 수 / 쌍 수), ms }
 *
 *  문제(problem.mjs 의 buildProblem().problem)는 i32 배열 하나로 넘긴다 (symplace/router/src/model.rs).
 */

const MAGIC = 0x52544531;
const VIA_BASE = 16;
const HEAD = 16;

/** 배선 문제 -> Int32Array */
export function packProblem(problem, { minLayer = "M2", maxLayer = "M4", maxIter = 80, flags = 0 } = {}) {
  const L = problem.layers, V = problem.vias;
  const li = new Map(L.map((l, k) => [l.name, k])), vi = new Map(V.map((v, k) => [v.name, k]));
  const code = (layer) => (li.has(layer) ? li.get(layer) : vi.has(layer) ? VIA_BASE + vi.get(layer) : -1);
  if (!li.has(minLayer) || !li.has(maxLayer)) throw new Error(`배선층 범위가 틀렸다: ${minLayer}..${maxLayer}`);
  const shapes = problem.shapes.filter((s) => code(s[0]) >= 0);
  const n = HEAD + L.length * 6 + V.length * 8 + problem.nets.length * 5 + shapes.length * 8;
  const b = new Int32Array(n);
  b.set([MAGIC, L.length, V.length, problem.nets.length, shapes.length, ...problem.area,
         li.get(minLayer), li.get(maxLayer), maxIter, flags, 0, 0, 0]);
  let p = HEAD;
  for (const l of L) { b.set([l.dir === "v" ? 1 : 0, l.pitch, l.offset, l.width, l.minL, l.e2e], p); p += 6; }
  for (const v of V) { b.set([li.get(v.lower) ?? -1, li.get(v.upper) ?? -1, v.wx, v.wy, v.encL, v.encH, v.spaceX, v.spaceY], p); p += 8; }
  for (const t of problem.nets) {
    b.set([t.power ? 1 : 0, t.sym, t.axis2 ?? 0, t.dir === "V" ? 1 : t.dir === "H" ? 2 : 0, t.parts], p); p += 5;
  }
  for (const [layer, net, comp, pin, x0, y0, x1, y1] of shapes) { b.set([code(layer), net, comp, pin, x0, y0, x1, y1], p); p += 8; }
  return b;
}

/** 결과 Int32Array -> 사각형 목록 */
export function unpackSolution(out, problem) {
  if (out[0] < 0) {
    const bytes = Uint8Array.from(out.subarray(8, 8 + out[1]));
    throw new Error("배선기: " + new TextDecoder().decode(bytes));
  }
  const [, nWires, nFailed, iterations, violations, mirrored, pairs] = out;
  const layerName = (c) => (c >= VIA_BASE ? problem.vias[c - VIA_BASE].name : problem.layers[c].name);
  const wires = [];
  let p = 8;
  for (let k = 0; k < nWires; k++, p += 6)
    wires.push({ layer: layerName(out[p]), netName: problem.nets[out[p + 1]].name, rect: [out[p + 2], out[p + 3], out[p + 4], out[p + 5]] });
  const failed = Array.from(out.subarray(p, p + nFailed), (k) => problem.nets[k].name);
  return { wires, failed, iterations, violations, mirrored, pairs };
}

/** wasm 바이트 -> 배선기 */
export async function loadRouter(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  return {
    route(problem, opts = {}) {
      const t0 = performance.now();
      const input = packProblem(problem, opts);
      const ptr = ex.alloc(input.length);
      new Int32Array(ex.memory.buffer, ptr, input.length).set(input);
      const optr = ex.route(input.length);
      const out = new Int32Array(ex.memory.buffer, optr, ex.out_len()).slice();
      const res = unpackSolution(out, problem);
      res.ms = performance.now() - t0;
      return res;
    },
  };
}
