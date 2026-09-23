/** 브라우저 배선 경로를 node 에서 그대로 재현한다 — 앞단 + 배선.
 *
 *  frontworker.mjs 의 파이썬 원문(FRONT, PYROUTE)을 **그 파일에서 그대로 읽어** 돌린다.
 *  그래서 이 스크립트가 재는 것은 페이지가 지금 실제로 하는 일이다. 달라지는 것은
 *  적재 경로 하나 — CDN 대신 setup.sh 가 받아둔 npm 꾸러미와 휠을 쓴다.
 *  (boot() 의 적재 순서는 아래에 손으로 옮겨 두었다. 워커의 boot() 를 고치면 여기도.)
 *
 *    node route.mjs <예제> [--place=<place.json>] [옵션]
 *
 *    --place=파일   배선할 배치 (기본: place.mjs 가 쓴 ~/.cache/symplace/place-<예제>.json)
 *    --twice        같은 인스턴스에서 배선을 두 번 (페이지에서 배치를 다시 풀고 배선을 또 누른 경우)
 *    --no-blasfix   워커의 lp_solve BLAS 우회책을 끈다 — 예전의 "두 번째 LP 에서 죽음" 재현용
 *    --prof         배선 단계 안의 시간을 단계별로 찍는다 (prof.py)
 *    --dump=<폴더>  Pyodide 안의 작업 디렉터리(/work/<예제>)를 꺼내 둔다
 *    --blob=<파일>  앞단이 페이지에 돌려주는 한 덩이(topology, primitives, templates, leaves)를 쓴다
 *    --no-route     앞단만
 *    --verbose      배선기 로그를 거르지 않는다
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const CACHE = process.env.PYODIDE_CACHE ?? path.join(process.env.HOME, ".cache/symplace/pyodide-0.27.8");
if (!fs.existsSync(path.join(CACHE, "package/pyodide.mjs"))) {
  console.error(`Pyodide 가 없다: ${CACHE}\n  ./setup.sh 를 먼저 돌려라.`);
  process.exit(2);
}
const { loadPyodide } = await import(path.join(CACHE, "package/pyodide.mjs"));

const args = process.argv.slice(2);
const flag = (k) => args.includes("--" + k);
const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || null;
const ex = args.find((a) => !a.startsWith("--"));
if (!ex) { console.error("사용법: node route.mjs <예제> [--place=<place.json>] [옵션]"); process.exit(2); }

// 배치는 부팅 전에 확인한다 (없다는 말을 7 초 기다려 듣지 않게)
const placeFile = opt("place") ?? path.join(process.env.SYMPLACE_CACHE ??
  path.join(process.env.HOME, ".cache/symplace"), `place-${ex}.json`);
if (!flag("no-route") && !fs.existsSync(placeFile)) {
  console.error(`배치가 없다: ${placeFile}\n  node place.mjs ${ex} 를 먼저 돌리거나 --place= 로 준다.`);
  process.exit(2);
}

// node 의 Buffer 는 공용 ArrayBuffer 의 일부일 수 있다. Pyodide 에는 제 것으로 넘긴다.
const rd = (f) => new Uint8Array(fs.readFileSync(f));
const t0 = performance.now();
const el = () => ((performance.now() - t0) / 1000).toFixed(2).padStart(6) + "s";
const log = (...a) => console.log(`[${el()}]`, ...a);

// --- frontworker.mjs 의 파이썬 원문 ---
const fw = fs.readFileSync(path.join(ROOT, "frontworker.mjs"), "utf8");
const grab = (name) => {
  const m = new RegExp("const " + name + " = String\\.raw`([\\s\\S]*?)`;").exec(fw);
  if (!m) throw new Error("frontworker.mjs 에서 " + name + " 를 못 찾았다");
  return m[1];
};
const FRONT = grab("FRONT"), PYROUTE = grab("PYROUTE");

// --- boot(): frontworker.mjs 와 같은 순서 ---
const py = await loadPyodide({ indexURL: path.join(CACHE, "package") + "/", env: { PYTHONHASHSEED: "0" } });
const M = py._module;
const site = "/lib/python3.12/site-packages";
for (const w of fs.readdirSync(path.join(CACHE, "whl")))
  py.unpackArchive(rd(path.join(CACHE, "whl", w)), "zip", { extractDir: site });
log(`Pyodide ${py.version} + networkx · pydantic · gdsii`);

py.FS.mkdirTree("/z3lib");
py.FS.writeFile("/z3lib/libz3.so", rd(path.join(ROOT, "py/z3/libz3.so")));
await py._api.loadDynlib("/z3lib/libz3.so", true);
py.FS.mkdirTree("/zpy/z3");
for (const f of fs.readdirSync(path.join(ROOT, "py/z3/py")))
  py.FS.writeFile("/zpy/z3/" + f, rd(path.join(ROOT, "py/z3/py", f)));
py.runPython("import sys, os; sys.path.insert(0,'/zpy'); os.environ['Z3_LIBRARY_PATH']='/z3lib'");
log("libz3");

const whl = fs.readFileSync(path.join(ROOT, "py/pnr/list.txt"), "utf8").trim().split(/\s+/)[0];
py.unpackArchive(rd(path.join(ROOT, "py/pnr", whl)), "zip", { extractDir: site });
// micropip 이 하는 일과 같다: 확장 모듈은 지역(local) 범위로 미리 적재한다
await py._api.loadDynlib(site + "/PnR.cpython-312-wasm32-emscripten.so", false);
log("PnR 휠");

py.FS.mkdirTree("/align");
py.unpackArchive(rd(path.join(ROOT, "py/front/align-front.zip")), "zip", { extractDir: "/align" });
py.runPython("import sys; sys.path.insert(0,'/align'); sys.path.append('/align/shims')");
py.runPython(String.raw`import sys
open('/align/align/PnR.py', 'w').write(
    'import sys\n'
    'import PnR as _real\n'
    'sys.modules[__name__] = _real\n')
for m in ('PnR', 'align.PnR'):
    sys.modules.pop(m, None)`);
py.runPython("import browser_stubs; browser_stubs.install()");
py.runPython("import align, z3, PnR");
log("import align · z3 · PnR");

// --- lp_solve BLAS 우회책 (워커 boot() 와 같다. --no-blasfix 로 끈다) ---
//
// lp_solve 의 make_lp() 는 LP 를 만들 때마다 load_BLAS("myBLAS") 로
// dlopen("libmyBLAS.so") 를 시도한다. Emscripten 은 적재에 실패한 라이브러리 이름을
// LDSO.loadedLibsByName 에 남겨두므로, 두 번째 dlopen 은 "이미 적재됨" 으로 성공한다.
// 그러면 dlsym 이 전부 NULL 이고, lp_solve 는 mustinitBLAS 가 이미 FALSE 라
// 기본 BLAS 로 되돌리지 않은 채 포인터를 NULL 로 둔다 -> 다음 idamax() 가
// "null function or function signature mismatch".
// 이 이름이 영영 적재되지 않은 것으로 보이게 막으면 매번 제대로 실패한다.
let blasOpens = 0;
if (!flag("no-blasfix")) {
  Object.defineProperty(M.LDSO.loadedLibsByName, "libmyBLAS.so", {
    get() { return undefined; }, set() { blasOpens++; }, configurable: true });
  log("BLAS 우회: libmyBLAS.so 를 적재 안 된 것으로 고정");
}
/** BLAS 함수 포인터 상태. idamax 가 0 이면 다음 LP 에서 죽는다. */
const blasState = () => {
  const G = M.GOT;
  const a = G.BLAS_idamax?.value;
  const stale = M.LDSO.loadedLibsByName["libmyBLAS.so"];
  return `BLAS_idamax=${a ? M.HEAPU32[a >>> 2] : "?"} (my_idamax=${G.my_idamax?.value})` +
         ` mustinitBLAS=${G.mustinitBLAS ? M.HEAPU8[G.mustinitBLAS.value] : "?"}` +
         ` libmyBLAS.so=${stale ? "남아 있음(" + typeof stale.exports + ")" : "없음"}` +
         (flag("no-blasfix") ? "" : ` make_lp 수=${blasOpens}`) +
         `  wasm 힙 ${(M.HEAP8.length / 2 ** 20).toFixed(0)}MB`;
};

// --- 앞단 (index.html 의 topSubckt 와 같은 규칙) ---
const spText = fs.readFileSync(path.join(ROOT, "netlists", ex + ".sp"), "utf8");
const constPath = path.join(ROOT, "netlists", ex + ".const.json");
const constText = fs.existsSync(constPath) ? fs.readFileSync(constPath, "utf8") : "";
function topSubckt(text) {
  const defined = [], used = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    const m = /^\.subckt\s+(\S+)/i.exec(l);
    if (m) { defined.push(m[1]); continue; }
    if (!l || l.startsWith("*") || l.startsWith(".")) continue;
    if (/^x/i.test(l)) {
      const toks = l.split(/\s+/).slice(1).filter((t) => !t.includes("="));
      if (toks.length) used.add(toks[toks.length - 1].toUpperCase());
    }
  }
  const top = defined.find((d) => !used.has(d.toUpperCase()));
  return (top ?? defined[defined.length - 1]).toUpperCase();
}
const top = topSubckt(spText);
const tf = performance.now();
py.runPython(FRONT);
const blob = JSON.parse(py.globals.get("run")(spText, ex, top, constText));
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

// --- 배선 (frontworker.mjs 의 cmd === "route" 와 같다) ---
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
py.runPython(PYROUTE);
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
