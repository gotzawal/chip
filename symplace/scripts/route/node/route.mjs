/** ALIGN 배선 경로를 node 에서 끝까지 — 앞단 + ALIGN 배선기 (비교 기준).
 *
 *  페이지는 이제 이 경로를 안 쓴다 (배선은 src/route/ 의 JS + Rust wasm — newroute.mjs).
 *  이 스크립트는 같은 배치를 ALIGN 의 C++ 배선기(축소 PnR 휠)로 배선해 기준값을 낸다.
 *  앞단은 frontworker.mjs 의 FRONT 원문을 그 파일에서 그대로 읽고, 배선은 pyroute.py
 *  (예전에 페이지 워커에 있던 PYROUTE) 를 쓴다. 적재는 align.mjs (CDN 대신 setup.sh 가
 *  받아둔 npm 꾸러미와 휠).
 *
 *    node route.mjs <예제> [--place=<place.json>] [옵션]
 *
 *    --place=파일   배선할 배치 (기본: place.mjs 가 쓴 ~/.cache/symplace/place-<예제>.json)
 *    --twice        같은 인스턴스에서 배선을 두 번 (예전 페이지에서 배치를 다시 풀고 배선을 또 누른 경우)
 *    --no-blasfix   lp_solve BLAS 우회책을 끈다 — 예전의 "두 번째 LP 에서 죽음" 재현용
 *    --prof         배선 단계 안의 시간을 단계별로 찍는다 (prof.py)
 *    --dump=<폴더>  Pyodide 안의 작업 디렉터리(/work/<예제>)를 꺼내 둔다
 *    --blob=<파일>  앞단이 페이지에 돌려주는 한 덩이(topology, primitives, templates, leaves)를 쓴다
 *    --no-route     앞단만
 *    --verbose      배선기 로그를 거르지 않는다
 */
import fs from "node:fs";
import path from "node:path";
import { HERE, WORK_CACHE, bootAlign, runFront, workerPython } from "./align.mjs";

const args = process.argv.slice(2);
const flag = (k) => args.includes("--" + k);
const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || null;
const ex = args.find((a) => !a.startsWith("--"));
if (!ex) { console.error("사용법: node route.mjs <예제> [--place=<place.json>] [옵션]"); process.exit(2); }

// 배치는 부팅 전에 확인한다 (없다는 말을 7 초 기다려 듣지 않게)
const placeFile = opt("place") ?? path.join(WORK_CACHE, `place-${ex}.json`);
if (!flag("no-route") && !fs.existsSync(placeFile)) {
  console.error(`배치가 없다: ${placeFile}\n  node place.mjs ${ex} 를 먼저 돌리거나 --place= 로 준다.`);
  process.exit(2);
}

const t0 = performance.now();
const el = () => ((performance.now() - t0) / 1000).toFixed(2).padStart(6) + "s";
const log = (...a) => console.log(`[${el()}]`, ...a);

const { py, M, blasOpens } = await bootAlign({ blasfix: !flag("no-blasfix"), log });
if (!flag("no-blasfix")) log("BLAS 우회: libmyBLAS.so 를 적재 안 된 것으로 고정");

/** BLAS 함수 포인터 상태. idamax 가 0 이면 다음 LP 에서 죽는다. */
const blasState = () => {
  const G = M.GOT;
  const a = G.BLAS_idamax?.value;
  const stale = M.LDSO.loadedLibsByName["libmyBLAS.so"];
  return `BLAS_idamax=${a ? M.HEAPU32[a >>> 2] : "?"} (my_idamax=${G.my_idamax?.value})` +
         ` mustinitBLAS=${G.mustinitBLAS ? M.HEAPU8[G.mustinitBLAS.value] : "?"}` +
         ` libmyBLAS.so=${stale ? "남아 있음(" + typeof stale.exports + ")" : "없음"}` +
         (flag("no-blasfix") ? "" : ` make_lp 수=${blasOpens()}`) +
         `  wasm 힙 ${(M.HEAP8.length / 2 ** 20).toFixed(0)}MB`;
};

// --- 앞단 ---
const tf = performance.now();
const { top, blob } = runFront(py, ex);
log(`앞단 ${((performance.now() - tf) / 1000).toFixed(2)}s  모듈 ${blob.topology.modules.length}` +
    `  소자 ${Object.keys(blob.primitives).length} 종`);
if (opt("blob")) fs.writeFileSync(opt("blob"), JSON.stringify(blob));

function dumpWork(dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  const walk = (dir, rel) => {
    for (const n of py.FS.readdir(dir)) {
      if (n === "." || n === "..") continue;
      const p = dir + "/" + n;
      if (py.FS.isDir(py.FS.stat(p).mode)) {
        fs.mkdirSync(path.join(dst, rel, n), { recursive: true });
        walk(p, path.join(rel, n));
      } else fs.writeFileSync(path.join(dst, rel, n), py.FS.readFile(p));
    }
  };
  fs.mkdirSync(dst, { recursive: true });
  walk("/work/" + ex, "");
  log("작업 디렉터리 ->", dst);
}
if (flag("no-route")) { if (opt("dump")) dumpWork(opt("dump")); process.exit(0); }

// --- 배선 (예전 페이지 워커의 cmd === "route" 와 같다) ---
const placement = JSON.parse(fs.readFileSync(placeFile, "utf8"));
let where = "", quiet = 0;
globalThis.routeLog = (t) => {
  for (const raw of String(t).split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    where = l;
    if (!flag("verbose") && /feasible path might not be found/.test(l)) { quiet++; continue; }
    if (flag("verbose") || /bottom up routing|error|fail|Traceback/i.test(l)) console.log("         |", l.slice(0, 200));
  }
};
py.setStdout({ batched: globalThis.routeLog });
py.setStderr({ batched: globalThis.routeLog });
py.runPython(workerPython("PYROUTE"));
if (flag("prof")) py.runPython(fs.readFileSync(path.join(HERE, "prof.py"), "utf8"));

for (let k = 1; k <= (flag("twice") ? 2 : 1); k++) {
  const tr = performance.now();
  let r;
  try {
    r = JSON.parse(py.globals.get("route")("/work/" + ex, ex, top, JSON.stringify(placement)));
  } catch (e) {
    log(`배선 #${k} 죽음 (${((performance.now() - tr) / 1000).toFixed(2)}s): ${String(e.message ?? e).split("\n")[0]}`);
    log(`  마지막 로그: ${where.slice(0, 160)}`);
    log(`  ${blasState()}`);
    process.exit(4);
  }
  const secs = ((performance.now() - tr) / 1000).toFixed(2);
  if (!r.ok) {
    log(`배선 #${k} 실패 ${secs}s\n` + r.error.split("\n").slice(-8).join("\n"));
    process.exit(3);
  }
  log(`배선 #${k} 성공 ${secs}s  GDS ${r.gds.map((g) => `${g.name} ${(g.bytes / 1024).toFixed(0)}K`).join(", ")}` +
      `  DRC/LVS ${r.nerrors}  사각형 ${r.geo?.terminals?.length}` + (quiet ? `  (경고 ${quiet} 줄 생략)` : ""));
  log(`  ${blasState()}`);
  if (flag("prof")) console.log(py.runPython("report()"));
  quiet = 0;
}
if (opt("dump")) dumpWork(opt("dump"));
