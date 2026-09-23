/** node 에서 Pyodide + ALIGN 을 frontworker.mjs 의 boot() 와 같은 순서로 올린다.
 *
 *  route.mjs (배선 경로 재현)와 checkref.mjs (파이썬 검사기 기준값)가 같이 쓴다.
 *  적재 경로만 다르다 — CDN 대신 setup.sh 가 받아둔 npm 꾸러미와 휠.
 *  워커의 boot() 를 고치면 여기도 고친다.
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

/** frontworker.mjs 안의 파이썬 원문 (FRONT, PYROUTE) 을 그 파일에서 그대로 읽는다. */
export function workerPython(name) {
  const fw = fs.readFileSync(path.join(ROOT, "frontworker.mjs"), "utf8");
  const m = new RegExp("const " + name + " = String\\.raw`([\\s\\S]*?)`;").exec(fw);
  if (!m) throw new Error("frontworker.mjs 에서 " + name + " 를 못 찾았다");
  return m[1];
}

/**
 * @param {object} o
 * @param {boolean} [o.blasfix=true]  워커의 lp_solve BLAS 우회 (끄면 예전의 두 번째 LP 에서 죽음이 재현된다)
 * @param {(msg:string)=>void} [o.log]
 * @returns {Promise<{py:any, M:any, blasOpens:()=>number}>}
 */
export async function bootAlign({ blasfix = true, log = () => {} } = {}) {
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

  // lp_solve BLAS 우회 — 워커 boot() 와 같다 (symplace/PLAN-route.md 2 절).
  let opens = 0;
  if (blasfix) {
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
