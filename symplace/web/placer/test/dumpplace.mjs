/** 배치를 돌려 **배선기에 넘기는 모양 그대로** JSON 으로 떨군다.
 *
 *  index.html 의 runRoute 가 워커로 보내는 것과 같은 모양이다
 *  ({bbox, instances, subModules}). test/flatten.py 가 이걸 먹고
 *  frontworker.mjs 의 펼치기를 검사한다.
 *
 *      node test/dumpplace.mjs <예제> <나갈 파일> [시작점]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeHierarchy, spreadShapes, SUB_VARIANTS } from "../../../../src/place.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [name, out, batch = "48"] = process.argv.slice(2);
if (!name || !out) {
  console.error("쓰기: node test/dumpplace.mjs <예제> <나갈 파일> [시작점]");
  process.exit(2);
}
const blob = JSON.parse(
  fs.readFileSync(path.join(HERE, "..", "..", "..", "..", "data", name + ".json"), "utf8"));
const r = placeHierarchy(blob, { batch: Number(batch), iters: 400, seed: 3, grid: [80, 84] });
if (!r.ok) { console.error("배치 실패:", r.module, r.reason); process.exit(1); }

// job.mjs 의 done 메시지와 같은 규칙으로 편다.
const top = r.top;
const [ox0, oy0] = [top.box[0], top.box[1]];
const topName = r.order[r.order.length - 1];
const subModules = [];
for (const [nm, m] of r.modules) {
  if (nm === topName) continue;
  const used = [...new Set(top.concrete.filter((c) => c === nm || c.startsWith(nm + "__v")))];
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
const placement = {
  bbox: [0, 0, Math.round(top.box[2] - ox0), Math.round(top.box[3] - oy0)],
  instances: top.names.map((n, i) => {
    const x = top.cx[i] - top.w[i] / 2 - ox0, y = top.cy[i] - top.h[i] / 2 - oy0;
    return {
      name: n, concrete: top.concrete[i],
      oX: Math.round(top.sx[i] > 0 ? x : x + top.w[i]),
      oY: Math.round(top.sy[i] > 0 ? y : y + top.h[i]),
      sX: top.sx[i] > 0 ? 1 : -1, sY: top.sy[i] > 0 ? 1 : -1,
    };
  }),
  subModules,
};
fs.writeFileSync(out, JSON.stringify({ placement }, null, 1));
console.log(`  ${name}: 인스턴스 ${placement.instances.length}, 하위 모듈 ${subModules.length}`);
