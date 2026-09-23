/** 워커 안에 Pyodide + ALIGN 파이썬을 올린다 — 앞단 워커(frontworker.mjs)와 ALIGN 원본 배선 워커
 *  (alignworker.mjs)가 같이 쓴다. node 하네스(symplace/scripts/route/node/align.mjs)는 같은 순서를
 *  CDN 대신 로컬 파일로 밟는다.
 *
 *  올리는 것 (원본 크기, 첫 방문에만 — 브라우저가 캐시한다)
 *    Pyodide 0.27.8  13.9 MB   CPython 을 wasm 으로
 *    networkx, pydantic 1.10.13, python-gdsii  2.1 MB
 *    libz3 22.4 MB             앞단의 제약 검증 (직접 빌드한 side module)
 *    align-front.zip 0.2 MB    align 파이썬 소스 + PDK
 *    PnR 휠 0.8 MB             pnr: true 일 때만 — ALIGN C++ 배선기 (py/pnr/)
 *
 *  메인 스레드가 아니라 워커에서 불러야 한다: libz3 가 22 MB 라 메인 스레드에서는
 *  "WebAssembly.Compile is disallowed on the main thread" 가 난다.
 */
const CDN = "https://cdn.jsdelivr.net/pyodide/v0.27.8/full/";
const here = (p) => new URL("../" + p, import.meta.url).href;

async function bytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** py/<name> 의 원문 (front.py, pyroute.py, aligntap.py) */
export async function pyText(name) {
  const r = await fetch(here("py/" + name));
  if (!r.ok) throw new Error(`py/${name} -> ${r.status}`);
  return r.text();
}

/**
 * @param {object} o
 * @param {boolean} [o.pnr=false]  ALIGN C++ 배선기(PnR 휠)를 싣고 align.PnR 을 진짜로 잇는다
 * @param {(text:string, step:number)=>void} [o.say]  진행 (단계 번호는 부르는 쪽이 이어 쓴다)
 */
export async function bootAlignPy({ pnr = false, say = () => {} } = {}) {
  const t0 = performance.now();
  const el = () => ((performance.now() - t0) / 1000).toFixed(1) + "s";
  let step = 0;
  const next = (text) => say(text, ++step);

  next("Pyodide 받는 중…");
  // 모듈 워커에는 importScripts 가 없다 — 동적 import 로 가져온다.
  const mod = await import(CDN + "pyodide.mjs");
  // PYTHONHASHSEED 를 고정한다. ALIGN 의 2_primitives 는 이것 없이는 **네이티브에서도**
  // 실행마다 달라진다 (M2 사각형 두 개의 순서가 뒤바뀐다).
  const py = await mod.loadPyodide({ indexURL: CDN, env: { PYTHONHASHSEED: "0" } });
  say(`Pyodide ${py.version}  ${el()}`, step);

  next("파이썬 패키지…");
  await py.loadPackage(["micropip", "networkx"]);
  const mp = py.pyimport("micropip");
  for (const s of ["pydantic==1.10.13", "python-gdsii"]) await mp.install(s);
  say(`networkx · pydantic · gdsii  ${el()}`, step);

  next("libz3 22MB…");
  py.FS.mkdirTree("/z3lib");
  py.FS.writeFile("/z3lib/libz3.so", await bytes(here("py/z3/libz3.so")));
  // 동적 적재 API 가 버전마다 다르다. 0.27 에서 Module 쪽을 부르면
  // "Didn't expect to load any more file_packager files!" 로 막힌다.
  if (py._api?.loadDynlib) await py._api.loadDynlib("/z3lib/libz3.so", true);
  else await py._module.loadDynamicLibrary("/z3lib/libz3.so", { global: true, nodelete: true });
  py.FS.mkdirTree("/zpy/z3");
  for (const f of ["__init__.py", "z3.py", "z3core.py", "z3consts.py", "z3num.py",
                   "z3poly.py", "z3printer.py", "z3rcf.py", "z3regex.py",
                   "z3types.py", "z3util.py"]) {
    try { py.FS.writeFile("/zpy/z3/" + f, await bytes(here("py/z3/py/" + f))); } catch { /* 없으면 넘긴다 */ }
  }
  py.runPython("import sys, os; sys.path.insert(0,'/zpy'); os.environ['Z3_LIBRARY_PATH']='/z3lib'");
  say(`libz3 적재  ${el()}`, step);

  if (pnr) {
    next("ALIGN 배선기 (PnR 휠)…");
    const whl = (await (await fetch(here("py/pnr/list.txt"))).text()).trim().split(/\s+/)[0];
    await mp.install(here("py/pnr/" + whl));
    say(`PnR  ${el()}`, step);
  }

  next("align 소스 + PDK…");
  const zip = await bytes(here("py/front/align-front.zip"));
  py.FS.mkdirTree("/align");
  py.unpackArchive(zip.buffer, "zip", { extractDir: "/align" });
  // shims 는 align 보다 뒤에 둔다 (진짜 모듈이 있으면 그쪽이 이긴다)
  py.runPython("import sys; sys.path.insert(0,'/align'); sys.path.append('/align/shims')");
  if (pnr) {
    // align/PnR.py 는 앞단용 스텁이다. align/pnr/*.py 는 `from .. import PnR` 로 상대 임포트하므로
    // **align.PnR** 이 진짜 확장이어야 배선이 된다 — 스텁 파일을 진짜 모듈의 별칭으로 바꾼다.
    py.runPython(String.raw`import sys
open('/align/align/PnR.py', 'w').write(
    'import sys\n'
    'import PnR as _real\n'
    'sys.modules[__name__] = _real\n')
for m in ('PnR', 'align.PnR'):
    sys.modules.pop(m, None)`);
  }
  py.runPython("import browser_stubs; browser_stubs.install()");
  py.runPython(pnr ? "import align, z3, PnR" : "import align, z3");
  if (pnr) {
    // lp_solve 의 make_lp() 는 LP 를 만들 때마다 dlopen("libmyBLAS.so") 로 외부 BLAS 를 찾는다.
    // Emscripten 은 적재에 실패한 이름을 LDSO 에 남겨 두어서, 두 번째 dlopen 이 "이미 적재됨" 으로
    // 성공하고 dlsym 이 전부 NULL 이 된다 — 계층 설계의 두 번째 모듈에서 "null function" 으로 죽던
    // 원인이다. 이 이름이 영영 적재되지 않은 것으로 보이게 막는다 (symplace/PLAN-route.md 2 절).
    Object.defineProperty(py._module.LDSO.loadedLibsByName, "libmyBLAS.so",
      { get() { return undefined; }, set() {}, configurable: true });
    const f = String(py.runPython("import align.PnR as P; getattr(P, '__file__', '?')"));
    if (f.includes("/align/align/PnR.py")) throw new Error("PnR 스텁이 아직 잡힌다: " + f);
  }
  say(`align ${py.runPython("import align; align.__version__")} · ` +
      `z3 ${py.runPython("import z3; z3.get_version_string()")}${pnr ? " · PnR" : ""}  ${el()}`, step);
  return { py, steps: step };
}
