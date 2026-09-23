/** node 에서 Pyodide + ALIGN 을 올린다 — 앞단(frontworker.mjs 의 boot 와 같은 순서)과, 비교 기준인
 *  ALIGN 배선 경로(축소 PnR 휠 + pyroute.py).
 *
 *  route.mjs (ALIGN 배선), checkref.mjs (파이썬 검사기 기준값) 가 같이 쓴다.
 *  페이지와 다른 점: CDN 대신 setup.sh 가 받아둔 npm 꾸러미와 휠, 그리고 pnr: true 면
 *  PnR 휠(py/pnr/ — 페이지의 "ALIGN 원본" 배선과 같은 파일)을 싣는다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../../../..");
export const CACHE = process.env.PYODIDE_CACHE ??
  path.join(process.env.HOME, ".cache/symplace/pyodide-0.27.8");
export const WORK_CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME, ".cache/symplace");

// node 의 Buffer 는 공용 ArrayBuffer 의 일부일 수 있다. Pyodide 에는 제 것으로 넘긴다.
const rd = (f) => new Uint8Array(fs.readFileSync(f));

/** 파이썬 원문 — 페이지 워커들과 같은 파일 (py/). FRONT = py/front.py (앞단),
 *  PYROUTE = py/pyroute.py (ALIGN 원본 배선), TAP = py/aligntap.py (RouteWork 마다 기록). */
export function workerPython(name) {
  const file = { FRONT: "front.py", PYROUTE: "pyroute.py", TAP: "aligntap.py" }[name];
  if (!file) throw new Error("모르는 파이썬 원문: " + name);
  return fs.readFileSync(path.join(ROOT, "py", file), "utf8");
}

/**
 * @param {object} o
 * @param {boolean} [o.blasfix=true]  lp_solve BLAS 우회 (끄면 예전의 두 번째 LP 에서 죽음이 재현된다)
 * @param {boolean} [o.pnr=true]      ALIGN 배선기(PnR 휠)를 싣는다. false 면 페이지의 앞단과 같다
 * @param {(msg:string)=>void} [o.log]
 * @returns {Promise<{py:any, M:any, blasOpens:()=>number}>}
 */
export async function bootAlign({ blasfix = true, pnr = true, log = () => {} } = {}) {
  if (!fs.existsSync(path.join(CACHE, "package/pyodide.mjs"))) {
    console.error(`Pyodide 가 없다: ${CACHE}\n  symplace/scripts/route/node/setup.sh 를 먼저 돌려라.`);
    process.exit(2);
  }
  const { loadPyodide } = await import(path.join(CACHE, "package/pyodide.mjs"));
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

  if (pnr) {
    const dir = path.join(ROOT, "py/pnr");
    const whl = fs.readFileSync(path.join(dir, "list.txt"), "utf8").trim().split(/\s+/)[0];
    py.unpackArchive(rd(path.join(dir, whl)), "zip", { extractDir: site });
    // micropip 이 하는 일과 같다: 확장 모듈은 지역(local) 범위로 미리 적재한다
    await py._api.loadDynlib(site + "/PnR.cpython-312-wasm32-emscripten.so", false);
    log("PnR 휠");
  }

  py.FS.mkdirTree("/align");
  py.unpackArchive(rd(path.join(ROOT, "py/front/align-front.zip")), "zip", { extractDir: "/align" });
  py.runPython("import sys; sys.path.insert(0,'/align'); sys.path.append('/align/shims')");
  if (pnr)
    py.runPython(String.raw`import sys
open('/align/align/PnR.py', 'w').write(
    'import sys\n'
    'import PnR as _real\n'
    'sys.modules[__name__] = _real\n')
for m in ('PnR', 'align.PnR'):
    sys.modules.pop(m, None)`);
  py.runPython("import browser_stubs; browser_stubs.install()");
  py.runPython(pnr ? "import align, z3, PnR" : "import align, z3");
  log(pnr ? "import align · z3 · PnR" : "import align · z3 (PnR 없이 — 앞단만)");

  // lp_solve BLAS 우회 (symplace/PLAN-route.md 2 절) — 예전 페이지 워커가 하던 것.
  let opens = 0;
  if (pnr && blasfix) {
    Object.defineProperty(M.LDSO.loadedLibsByName, "libmyBLAS.so", {
      get() { return undefined; }, set() { opens++; }, configurable: true });
  }
  return { py, M, blasOpens: () => opens };
}

/** index.html 의 topSubckt 와 같은 규칙 — 아무 데도 인스턴스로 안 쓰이는 .subckt 가 최상위다. */
export function topSubckt(text) {
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

/** netlists/<예제>.sp 로 앞단을 돌린다 (frontworker 의 FRONT 그대로). */
export function runFront(py, ex) {
  const spText = fs.readFileSync(path.join(ROOT, "netlists", ex + ".sp"), "utf8");
  const constPath = path.join(ROOT, "netlists", ex + ".const.json");
  const constText = fs.existsSync(constPath) ? fs.readFileSync(constPath, "utf8") : "";
  const top = topSubckt(spText);
  py.runPython(workerPython("FRONT"));
  const blob = JSON.parse(py.globals.get("run")(spText, ex, top, constText));
  return { top, blob };
}
