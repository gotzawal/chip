/** 페이지와 같은 배치를 node 에서 돌리고, 배선 워커에 넘기는 모양 그대로 저장한다.
 *
 *  index.html 의 run() 은 src/job.mjs 의 runJob 을 부르고, runRoute() 는 그 결과를
 *  {bbox, instances[{name, concrete, oX, oY, sX, sY}], subModules} 로 바꿔
 *  routeworker.mjs 에 넘긴다. 여기서도 **같은 함수, 같은 변환**을 쓴다.
 *
 *    node place.mjs <예제> [시작점=96] [--out=파일]
 *
 *  기본 출력은 저장소 밖이다 (SYMPLACE_CACHE, 기본 ~/.cache/symplace/place-<예제>.json).
 *  newroute.mjs --place=ours 가 같은 자리를 읽는다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const { runJob } = await import(path.join(ROOT, "src/job.mjs"));

const args = process.argv.slice(2);
const ex = args.find((a) => !a.startsWith("--"));
if (!ex) { console.error("사용법: node place.mjs <예제> [시작점] [--out=파일]"); process.exit(2); }
const batch = Number(args.filter((a) => !a.startsWith("--"))[1] ?? 96);
const cache = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME, ".cache/symplace");
const out = (args.find((a) => a.startsWith("--out=")) ?? "").slice(6) || path.join(cache, `place-${ex}.json`);
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

const blob = JSON.parse(fs.readFileSync(path.join(ROOT, "data", ex + ".json"), "utf8"));
const t0 = performance.now();
let ours = null;
await runJob({ name: ex, blob, batch, hpwlWeight: 2, lamRatio: 1 }, (m) => {
  if (m.type === "done") ours = m;
  if (m.type === "error") { console.error("배치 실패:", m.msg); process.exit(1); }
});

// index.html routePlacement() 와 같은 변환 (oX 는 transformation 의 원점)
const placement = {
  bbox: [0, 0, Math.round(ours.bbox[2] - ours.bbox[0]), Math.round(ours.bbox[3] - ours.bbox[1])],
  instances: ours.rects.map((r) => ({
    name: r.name, concrete: r.concrete,
    oX: Math.round(r.sx > 0 ? r.x : r.x + r.w),
    oY: Math.round(r.sy > 0 ? r.y : r.y + r.h),
    sX: r.sx > 0 ? 1 : -1, sY: r.sy > 0 ? 1 : -1,
  })),
  subModules: ours.subModules ?? [],
};
fs.writeFileSync(out, JSON.stringify(placement));
console.log(`${ex}: ${((performance.now() - t0) / 1000).toFixed(1)}s  bbox ${placement.bbox.slice(2).join("x")}` +
            `  하위 모듈 ${placement.subModules.length}  -> ${out}`);
