/** 배선기가 모드마다 hierNode 에 쓰는 필드("기록")와 그 대조.
 *
 *  ALIGN 쪽(기준 덤프, 페이지의 ALIGN 원본 경로)은 pybind 로 뜬 hierNode 에서 recordOf 로 뽑고,
 *  Rust 쪽(alignroute.wasm)은 같은 모양을 바로 돌려준다 (symplace/alignroute/src/route.rs 의 record).
 *  둘을 diffRecord 로 견주면 어느 모듈의 어느 단계에서, 어느 넷이 갈라졌는지 나온다.
 *
 *    모드 4 (전역 배선)   tiles_total, 넷마다 GcellGlobalRouterPath·connectedTile
 *    모드 5 (상세 배선)   넷마다 path_metal·path_via, 모듈 blockPins·interMetals·interVias, 단자 접점
 *    모드 2 (전원 격자)   Vdd, Gnd (metals, vias)
 *    모드 3 (전원 배선)   전원 넷마다 path_metal·path_via, 모듈 LL·UR·width·height
 */
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]));

export const MODES = { 4: "전역 배선", 5: "상세 배선", 2: "전원 격자", 3: "전원 배선" };

/** pybind 모양 hierNode 에서 모드 m 의 기록을 뽑는다 */
export function recordOf(node, mode) {
  switch (mode) {
    case 4: return {
      tiles_total: node.tiles_total,
      Nets: node.Nets.map((n) => pick(n, ["name", "GcellGlobalRouterPath", "connectedTile"])),
    };
    case 5: return {
      Nets: node.Nets.map((n) => pick(n, ["name", "path_metal", "path_via"])),
      blockPins: node.blockPins, interMetals: node.interMetals, interVias: node.interVias,
      Terminals: node.Terminals.map((t) => pick(t, ["name", "termContacts"])),
    };
    case 2: return {
      Vdd: pick(node.Vdd, ["name", "metals", "vias"]),
      Gnd: pick(node.Gnd, ["name", "metals", "vias"]),
    };
    case 3: return {
      PowerNets: node.PowerNets.map((p) => pick(p, ["name", "path_metal", "path_via"])),
      LL: node.LL, UR: node.UR, width: node.width, height: node.height,
    };
    default: throw new Error(`모드 ${mode} 의 기록은 없다`);
  }
}

/** 두 기록의 차이 — [{path, a, b}] (최대 limit 개) 와 전체 개수.
 *  배열 길이가 다르면 그 자리 하나로 센다. 넷·전원 넷은 이름을 경로에 붙인다. */
export function diffRecord(a, b, limit = 20) {
  const out = [];
  let count = 0;
  const add = (path, x, y) => { count++; if (out.length < limit) out.push({ path, a: brief(x), b: brief(y) }); };
  const walk = (x, y, path) => {
    if (x === y) return;
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) add(path + ".length", x.length, y.length);
      const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) {
        const nm = x[i]?.name ?? y[i]?.name;
        walk(x[i], y[i], `${path}[${i}]${nm !== undefined && typeof x[i] === "object" ? `(${nm})` : ""}`);
      }
      return;
    }
    if (x && y && typeof x === "object" && typeof y === "object") {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], path ? `${path}.${k}` : k);
      return;
    }
    add(path, x, y);
  };
  walk(a, b, "");
  return { count, first: out };
}

const brief = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? "없음" : s.length > 80 ? s.slice(0, 77) + "..." : s;
};

/** 기록 줄들(모듈, 모드 순)을 짝지어 견준다. 같은 모듈 이름이 여러 번이면 나온 순서로 짝짓는다. */
export function compareRuns(recsA, recsB) {
  const key = (r, seen) => { const k = `${r.module}|${r.mode}`; const i = seen.get(k) ?? 0; seen.set(k, i + 1); return `${k}|${i}`; };
  const sa = new Map(), sb = new Map();
  const A = new Map(recsA.map((r) => [key(r, sa), r]));
  const B = new Map(recsB.map((r) => [key(r, sb), r]));
  const rows = [];
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const a = A.get(k), b = B.get(k);
    const [module, mode] = k.split("|");
    if (!a || !b) { rows.push({ module, mode: +mode, same: false, missing: a ? "B" : "A", count: 1, first: [] }); continue; }
    const d = diffRecord(a.out, b.out);
    rows.push({ module, mode: +mode, same: d.count === 0, count: d.count, first: d.first });
  }
  return rows;
}
