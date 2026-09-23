/** SPICE 넷리스트 -> ALIGN 앞단(1_topology + 2_primitives)을 브라우저에서.
 *
 *  배치기의 입력은 앞단 출력이다. 회로(.sp)부터 시작하려면 ALIGN 의 앞단을
 *  브라우저에서 돌려야 하고, 그게 이 워커다. **.sp 를 올릴 때만 뜬다** — 예제를 고르고
 *  배치·배선하는 데는 안 쓴다 (배선은 routeworker.mjs: JS + Rust wasm).
 *
 *  올리는 것 (원본 크기 합계 약 39 MB, 첫 방문에만 — 브라우저가 캐시한다)
 *    Pyodide 0.27.8  13.9 MB   CPython 을 wasm 으로
 *    networkx, pydantic 1.10.13, python-gdsii  2.1 MB    앞단이 실제로 쓰는 것만
 *    libz3 22.4 MB             직접 빌드한 side module.
 *                              **사용자가 쓴 제약을 받으려면 진짜로 필요하다**
 *                              (제약이 없으면 no-op 이지만 그건 목표가 아니다)
 *    align-front.zip 0.2 MB    align 파이썬 소스 + PDK (PDK 의 PDF·PPT 와 예제는 뺐다)
 *
 *  ALIGN 의 C++ 배선기(PnR 휠)는 안 싣는다. 앞단은 align/PnR.py 스텁으로 충분하다
 *  (5 예제에서 휠이 있을 때와 출력이 바이트까지 같다). 앞단 원문은 py/front.py.
 *
 *  메인 스레드가 아니라 워커여야 한다: libz3 가 22 MB 라
 *  "RangeError: WebAssembly.Compile is disallowed on the main thread" 가 난다.
 */
const CDN = "https://cdn.jsdelivr.net/pyodide/v0.27.8/full/";
const here = (p) => new URL(p, import.meta.url).href;

let py = null;
const say = (text, step) => postMessage({ type: "log", text, step });

async function bytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Pyodide 스택을 올리고 앞단(py/front.py)을 정의한다. 한 번만. */
async function boot() {
  if (py) return py;
  const t0 = performance.now();
  const el = () => ((performance.now() - t0) / 1000).toFixed(1) + "s";

  say("Pyodide 받는 중…", 1);
  // 모듈 워커에는 importScripts 가 없다 — 동적 import 로 가져온다.
  const mod = await import(CDN + "pyodide.mjs");
  // PYTHONHASHSEED 를 고정한다. ALIGN 의 2_primitives 는 이것 없이는 **네이티브에서도**
  // 실행마다 달라진다 (M2 사각형 두 개의 순서가 뒤바뀐다).
  const p = await mod.loadPyodide({ indexURL: CDN, env: { PYTHONHASHSEED: "0" } });
  say(`Pyodide ${p.version}  ${el()}`, 1);

  say("파이썬 패키지…", 2);
  await p.loadPackage(["micropip", "networkx"]);
  const mp = p.pyimport("micropip");
  for (const s of ["pydantic==1.10.13", "python-gdsii"]) await mp.install(s);
  say(`networkx · pydantic · gdsii  ${el()}`, 2);

  say("libz3 22MB…", 3);
  p.FS.mkdirTree("/z3lib");
  p.FS.writeFile("/z3lib/libz3.so", await bytes(here("py/z3/libz3.so")));
  // 동적 적재 API 가 버전마다 다르다. 0.27 에서 Module 쪽을 부르면
  // "Didn't expect to load any more file_packager files!" 로 막힌다.
  if (p._api?.loadDynlib) await p._api.loadDynlib("/z3lib/libz3.so", true);
  else await p._module.loadDynamicLibrary("/z3lib/libz3.so", { global: true, nodelete: true });
  p.FS.mkdirTree("/zpy/z3");
  for (const f of ["__init__.py", "z3.py", "z3core.py", "z3consts.py", "z3num.py",
                   "z3poly.py", "z3printer.py", "z3rcf.py", "z3regex.py",
                   "z3types.py", "z3util.py"]) {
    try { p.FS.writeFile("/zpy/z3/" + f, await bytes(here("py/z3/py/" + f))); } catch { /* 없으면 넘긴다 */ }
  }
  p.runPython("import sys, os; sys.path.insert(0,'/zpy'); os.environ['Z3_LIBRARY_PATH']='/z3lib'");
  say(`libz3 적재  ${el()}`, 3);

  say("align 소스 + PDK…", 4);
  const zip = await bytes(here("py/front/align-front.zip"));
  p.FS.mkdirTree("/align");
  p.unpackArchive(zip.buffer, "zip", { extractDir: "/align" });
  // shims 는 align 보다 뒤에 둔다 (진짜 모듈이 있으면 그쪽이 이긴다)
  p.runPython("import sys; sys.path.insert(0,'/align'); sys.path.append('/align/shims')");
  // align/PnR.py 는 스텁이다 — 앞단은 배선기를 안 부른다 (부르면 스텁이 소리 내어 멈춘다).
  p.runPython("import browser_stubs; browser_stubs.install()");
  p.runPython("import align, z3");
  say(`align ${p.runPython("import align; align.__version__")} · ` +
      `z3 ${p.runPython("import z3; z3.get_version_string()")}  ${el()}`, 4);

  const r = await fetch(here("py/front.py"));
  if (!r.ok) throw new Error(`py/front.py -> ${r.status}`);
  p.runPython(await r.text());
  py = p;
  return py;
}

self.onmessage = async (e) => {
  const { sp, name, subckt, constraints } = e.data;
  try {
    const p = await boot();
    say("앞단 실행 — 1_topology · 2_primitives", 5);
    const t0 = performance.now();
    const out = p.globals.get("run")(sp, name, subckt, constraints ?? "");
    const blob = JSON.parse(out);
    const nInst = (blob.topology.modules.at(-1).instances ?? []).length;
    postMessage({
      type: "front", blob, name,
      secs: (performance.now() - t0) / 1000,
      modules: blob.topology.modules.length,
      instances: nInst,
      concrete: Object.keys(blob.primitives).length,
    });
  } catch (err) {
    // wasm 이 죽으면(null function, memory access ...) 그 Pyodide 인스턴스는 다시 못 쓴다.
    // 메시지에 "fatal" 이 없을 때가 있어서 표시를 따로 붙인다 — 페이지가 워커를 새로 띄운다.
    postMessage({ type: "error", msg: String(err?.message ?? err).slice(0, 1500),
                  fatal: !!err?.pyodide_fatal_error || /fatal/i.test(String(err?.message ?? err)) });
  }
};
