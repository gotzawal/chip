/** SPICE 넷리스트 -> ALIGN 앞단(1_topology + 2_primitives)을 브라우저에서.
 *
 *  배치기의 입력은 앞단 출력이다. 회로(.sp)부터 시작하려면 ALIGN 의 앞단을
 *  브라우저에서 돌려야 하고, 그게 이 워커다. **.sp 를 올릴 때만 뜬다** — 예제를 고르고
 *  배치·배선하는 데는 안 쓴다 (배선은 routeworker.mjs: JS + Rust wasm).
 *
 *  올리는 것 (원본 크기 합계 약 39 MB, 첫 방문에만)
 *    Pyodide 0.27.8  13.9 MB   CPython 을 wasm 으로
 *    networkx, pydantic 1.10.13, python-gdsii  2.1 MB    앞단이 실제로 쓰는 것만
 *    libz3 22.4 MB             직접 빌드한 side module.
 *                              **사용자가 쓴 제약을 받으려면 진짜로 필요하다**
 *                              (제약이 없으면 no-op 이지만 그건 목표가 아니다)
 *    align-front.zip 0.2 MB    align 파이썬 소스 + PDK (PDK 의 PDF·PPT 와 예제는 뺐다)
 *
 *  ALIGN 의 C++ 배선기(PnR 휠)는 더 안 싣는다. 앞단은 align/PnR.py 스텁으로 충분하다
 *  (5 예제에서 휠이 있을 때와 출력이 바이트까지 같다). 휠과 ALIGN 배선 경로는 비교 기준으로
 *  node 하네스에 남아 있다 (symplace/scripts/route/node/).
 *
 *  메인 스레드가 아니라 워커여야 한다: libz3 가 22 MB 라
 *  "RangeError: WebAssembly.Compile is disallowed on the main thread" 가 난다.
 */
importScripts;   // (모듈 워커라 안 쓴다 — 아래 import 로 Pyodide 를 가져온다)

let py = null;
const say = (text, step) => postMessage({ type: "log", text, step });

async function bytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Pyodide 스택을 올린다. 한 번만. */
async function boot() {
  if (py) return py;
  const t0 = performance.now();
  const el = () => ((performance.now() - t0) / 1000).toFixed(1) + "s";

  say("Pyodide 받는 중…", 1);
  // loadPyodide 는 전역으로 들어온다. 모듈 워커에서는 importScripts 가 없으므로
  // 동적 import 로 가져온다.
  const mod = await import("https://cdn.jsdelivr.net/pyodide/v0.27.8/full/pyodide.mjs");
  // PYTHONHASHSEED 를 고정한다. ALIGN 의 2_primitives 는 이것 없이는
  // **네이티브에서도** 실행마다 달라진다 (M2 사각형 두 개의 순서가 뒤바뀐다).
  py = await mod.loadPyodide({
    indexURL: "https://cdn.jsdelivr.net/pyodide/v0.27.8/full/",
    env: { PYTHONHASHSEED: "0" },
  });
  say(`Pyodide ${py.version}  ${el()}`, 1);

  say("파이썬 패키지…", 2);
  await py.loadPackage(["micropip", "networkx"]);
  const mp = py.pyimport("micropip");
  for (const s of ["pydantic==1.10.13", "python-gdsii"]) await mp.install(s);
  say(`networkx · pydantic · gdsii  ${el()}`, 2);

  say("libz3 22MB…", 3);
  const z3 = await bytes("./py/z3/libz3.so");
  py.FS.mkdirTree("/z3lib");
  py.FS.writeFile("/z3lib/libz3.so", z3);
  // 동적 적재 API 가 버전마다 다르다. 0.27 에서 Module 쪽을 부르면
  // "Didn't expect to load any more file_packager files!" 로 막힌다.
  if (py._api?.loadDynlib) await py._api.loadDynlib("/z3lib/libz3.so", true);
  else await py._module.loadDynamicLibrary("/z3lib/libz3.so", { global: true, nodelete: true });
  py.FS.mkdirTree("/zpy/z3");
  for (const f of ["__init__.py", "z3.py", "z3core.py", "z3consts.py", "z3num.py",
                   "z3poly.py", "z3printer.py", "z3rcf.py", "z3regex.py",
                   "z3types.py", "z3util.py"]) {
    try { py.FS.writeFile("/zpy/z3/" + f, await bytes("./py/z3/py/" + f)); } catch { /* 없으면 넘긴다 */ }
  }
  py.runPython("import sys, os; sys.path.insert(0,'/zpy'); os.environ['Z3_LIBRARY_PATH']='/z3lib'");
  say(`libz3 적재  ${el()}`, 3);

  say("align 소스 + PDK…", 4);
  const zip = await bytes("./py/front/align-front.zip");
  py.FS.mkdirTree("/align");
  py.unpackArchive(zip.buffer, "zip", { extractDir: "/align" });
  // shims 는 align 보다 뒤에 둔다 (진짜 모듈이 있으면 그쪽이 이긴다)
  py.runPython("import sys; sys.path.insert(0,'/align'); sys.path.append('/align/shims')");
  // align/PnR.py 는 스텁이다 — 앞단은 배선기를 안 부른다 (부르면 스텁이 소리 내어 멈춘다).
  py.runPython("import browser_stubs; browser_stubs.install()");
  py.runPython("import align, z3");
  say(`align ${py.runPython("import align; align.__version__")} · ` +
      `z3 ${py.runPython("import z3; z3.get_version_string()")}  ${el()}`, 4);
  return py;
}

/** 앞단을 돌려 배치기가 먹는 형태로 돌려준다. */
const FRONT = String.raw`
import json, os, pathlib, shutil, traceback

def run(sp_text, name, subckt, const_text):
    work = pathlib.Path("/work") / name
    if work.exists():
        shutil.rmtree(work)
    nl = work / "netlist"
    nl.mkdir(parents=True)
    (nl / (name + ".sp")).write_text(sp_text)
    if const_text:
        (nl / (subckt.lower() + ".const.json")).write_text(const_text)

    topo = work / "1_topology"; prim = work / "2_primitives"
    topo.mkdir(); prim.mkdir()
    pdk = pathlib.Path("/align/pdks/FinFET14nm_Mock_PDK")

    from align.compiler import generate_hierarchy
    lib = generate_hierarchy(nl / (name + ".sp"), subckt, topo, False, pdk)

    from align.primitive import generate_primitives
    prims = generate_primitives(lib, pdk, prim, nl, None, 1e3)
    (prim / "__primitives__.json").write_text(json.dumps(prims))

    # 배치기가 먹는 한 덩이로 묶는다
    vfiles = sorted(topo.glob("*.verilog.json"))
    topology = json.loads(vfiles[-1].read_text())
    templates, leaves = {}, {}
    for cn in sorted(prims):
        p = prim / (cn + ".json")
        if p.exists():
            d = json.loads(p.read_text())
            templates[cn] = {"bbox": d["bbox"],
                             "terminals": [t for t in d.get("terminals", [])
                                           if t.get("netType") == "pin" and t.get("netName")]}
            # 배선·DRC·GDS 에 쓸 리프 전체 도형 — src/route/leaves.mjs 의 "leaves/1" 형식
            rows = []
            for t in d.get("terminals", []):
                row = [t["layer"], t.get("netName"), 1 if t.get("netType") == "pin" else 0] + list(t["rect"])
                if t.get("terminal"):
                    row.append(t["terminal"])
                rows.append(row)
            leaves[cn] = {"bbox": d["bbox"], "t": rows}
            if d.get("subinsts"):
                leaves[cn]["s"] = list(d["subinsts"].keys())
    return json.dumps({"topology": topology, "primitives": prims,
                       "templates": templates, "place": None,
                       "leaves": {"format": "leaves/1", "leaves": leaves}})
`;



self.onmessage = async (e) => {
  const { sp, name, subckt, constraints } = e.data;
  try {
    const p = await boot();
    say("앞단 실행 — 1_topology · 2_primitives", 5);
    const t0 = performance.now();
    p.runPython(FRONT);
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
