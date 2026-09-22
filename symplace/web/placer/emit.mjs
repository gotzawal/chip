/** JS 배치 결과를 ALIGN 배선기가 읽을 수 있는 형태로 내보낸다.
 *
 *  ALIGN 의 인수인계는 Results/*.json 이 아니라 3_pnr/__placer_dump__.json 으로
 *  이뤄진다. 여기서는 그 안에 심을 값만 JSON 으로 뱉고, 실제로 심는 일은
 *  web/spikes/inject.py 가 한다 (덤프 구조를 다루려면 파이썬 쪽이 편하다).
 *
 *  내보내는 것
 *    top          최상위 모듈 이름
 *    bbox         [0, 0, W, H]  — 격자에 맞춰 올림한 값
 *    instances[]  { name, abstract, concrete, oX, oY, sX, sY }
 *                 oX = cx - sX * (tx0+tx1)/2   (ALIGN 의 transformation 역산)
 *    needLeaves[] 이 배치가 쓰는 concrete 이름들 — 덤프의 leaves 를 다시 짜야 한다
 *                 (우리가 ALIGN 과 다른 변이를 고를 수 있으므로)
 *
 *  사용법:
 *    node emit.mjs <예제> [--batch 96] [--out 파일] [--grid 80,84]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDesign, alignBaseline } from "./test/_load.mjs";
import { placeHierarchy, symmetryResidual, gridOffgrid,
         orderViolations, spreadShapes, SUB_VARIANTS } from "../../../src/place.mjs";
import { topIndex, moduleOrder } from "../../../src/design.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ex = args[0];
const opt = (k, d) => {
  const i = args.indexOf("--" + k);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
if (!ex) { console.error("사용법: node emit.mjs <예제> [--batch 96] [--out f] [--grid 80,84]"); process.exit(2); }

const grid = opt("grid", "80,84").split(",").map(Number);
const batch = Number(opt("batch", 96));
const out = opt("out", path.join(HERE, "out", `${ex}.place.json`));

const dir = path.join(HERE, "fixtures", "design", ex);
const d = loadDesign(dir);
const topName = d.topology.modules[topIndex(d.topology)].name;
const order = moduleOrder(d.topology);
const base = d.place ? alignBaseline(d.place, topName) : null;

console.log(`${ex}  top=${topName}  모듈 ${order.length}  시작점 ${batch}  격자 ${grid}`);
const t0 = Date.now();
const hr = placeHierarchy(d, { batch, iters: 600, seed: 1, grid });
if (!hr.ok) { console.error(`실패 [${hr.module}] ${hr.reason}`); process.exit(1); }
const r = hr.top, P = r.problem;

const off = gridOffgrid(P, r.cx, r.cy, r.sx, r.sy, grid);
const resid = symmetryResidual(P, r.cx, r.cy);
const ordBad = orderViolations(P, r.cx, r.cy).length;

// 원점을 0 으로 당긴다. ALIGN 은 음수 좌표를 받지 않는다.
//
// 이동량 -bx0 는 격자의 배수다: oX = cx - sX*w/2 가 qx 의 배수이고 w/2 도
// qx 의 배수이므로 cx 가 qx 의 배수이고, 따라서 cx +- w/2 도 그렇다.
// 그러니 당겨도 격자가 깨지지 않는다.
const [bx0, by0, bx1, by1] = r.box;
const sh = (v, q) => Math.ceil(v / q) * q;
const shiftX = -bx0, shiftY = -by0;
const W = sh(Math.round(bx1 - bx0), grid[0]);
const H = sh(Math.round(by1 - by0), grid[1]);

const abstractOf = new Map(
  d.topology.modules.find((m) => m.name === topName).instances
    .map((i) => [i.instance_name, i.abstract_template_name]));

const instances = P.names.map((nm, i) => {
  const oX = r.cx[i] - r.sx[i] * (P.w[i] / 2) + shiftX;
  const oY = r.cy[i] - r.sy[i] * (P.h[i] / 2) + shiftY;
  return {
    name: nm, abstract: abstractOf.get(nm) ?? null, concrete: r.concrete[i],
    oX: Math.round(oX), oY: Math.round(oY),
    sX: r.sx[i] > 0 ? 1 : -1, sY: r.sy[i] > 0 ? 1 : -1,
  };
});

// --- 하위 모듈 ---
//
// 계층 설계는 최상위만 심어선 안 된다. ALIGN 덤프의 최상위 대안은 하위 모듈의
// module 항목까지 품고 있고(bbox + 인스턴스), 배선기가 그걸 읽는다.
// 그래서 우리가 배치한 모든 모듈을 같이 내보낸다.
//
// 우리 배치기는 하위 모듈을 여러 모양으로 올리므로 concrete 이름이
// "<모듈>__v0" 같은 꼴이 된다. ALIGN 쪽 이름(_PG0_n)으로 바꾸는 일은
// inject-js.py 가 한다 — 덤프에 어떤 이름들이 있는지는 거기서만 안다.
const subModules = [];
for (const [nm, m] of hr.modules) {
  if (nm === topName) continue;
  // 최상위가 실제로 쓰는 이 모듈의 concrete 이름들
  const used = [...new Set(r.concrete.filter((c) => c === nm || c.startsWith(nm + "__v")))];
  for (const cn of used) {
    // 그 이름을 만든 배치를 되찾는다.
    //
    // **__v{k} 는 alternatives[k] 가 아니다.** placeHierarchy 는
    // spreadShapes(alternatives, subVariants) 로 **종횡비를 퍼뜨려** 고른 목록에
    // 번호를 매긴다. 여기서 같은 선택을 다시 해야 한다 — 안 그러면 엉뚱한
    // 배치를 내보내고, 상위가 가정한 크기와 어긋나 하위 모듈 내용이 상위에서
    // 겹친다 (배선기가 "Leaves ... intersect" 로 거부했다).
    const picks = spreadShapes(m.alternatives ?? [m], SUB_VARIANTS);
    const vi = cn.includes("__v") ? Number(cn.split("__v")[1]) : 0;
    const pl = picks[Math.min(vi, picks.length - 1)] ?? m;
    const pp = pl.problem;
    const [sx0, sy0] = [pl.box[0], pl.box[1]];
    subModules.push({
      abstract: nm, concrete: cn,
      bbox: [0, 0, Math.round(pl.box[2] - sx0), Math.round(pl.box[3] - sy0)],
      instances: pp.names.map((inm, k) => ({
        name: inm, concrete: pp.concrete[k],
        abstract: null,
        oX: Math.round(pl.cx[k] - pl.sx[k] * (pp.w[k] / 2) - sx0),
        oY: Math.round(pl.cy[k] - pl.sy[k] * (pp.h[k] / 2) - sy0),
        sX: pl.sx[k] > 0 ? 1 : -1, sY: pl.sy[k] > 0 ? 1 : -1,
      })),
    });
  }
}

const payload = {
  example: ex, top: topName, bbox: [0, 0, W, H],
  grid, instances, subModules,
  needLeaves: [...new Set(r.concrete)],
  quality: {
    area: r.area, hpwl: r.hpwl, overlap: r.overlap, resid, offgrid: off,
    orderViolations: ordBad,
    alignArea: base?.area ?? null, alignHpwl: base?.hpwl ?? null,
    alignBbox: base?.bbox ?? null,
  },
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(payload, null, 1));

console.log(`  bbox ${W}x${H}` + (base
  ? `  면적 ${(r.area / base.area).toFixed(3)}x  HPWL ${(r.hpwl / base.hpwl).toFixed(3)}x` : ""));
console.log(`  겹침 ${r.overlap.toExponential(1)}  대칭잔차 ${resid.toExponential(1)}  ` +
            `격자밖 ${off}/${P.n}  Order위반 ${ordBad}`);
console.log(`  변이: ${[...new Set(r.concrete)].join(" ")}`);
if (subModules.length)
  console.log(`  하위 모듈 ${subModules.length} 개: ` +
    subModules.map((m) => `${m.concrete} ${m.bbox[2]}x${m.bbox[3]} (블록 ${m.instances.length})`).join(", "));
console.log(`  -> ${out}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (off > 0) { console.error("격자 밖 블록이 있다 — 배선기가 거부한다"); process.exit(1); }
