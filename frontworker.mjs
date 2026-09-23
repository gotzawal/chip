/** SPICE 넷리스트 -> ALIGN 앞단(1_topology + 2_primitives)을 브라우저에서.
 *
 *  배치기의 입력은 앞단 출력이다. 회로(.sp)부터 시작하려면 ALIGN 의 앞단을
 *  브라우저에서 돌려야 하고, 그게 이 워커다.
 *
 *  올리는 것 (원본 크기 합계 약 40 MB, 첫 방문에만)
 *    Pyodide 0.27.8  13.9 MB   CPython 을 wasm 으로
 *    networkx, pydantic 1.10.13, python-gdsii  2.1 MB    앞단이 실제로 쓰는 것만
 *    libz3 22.4 MB             직접 빌드한 side module.
 *                              **사용자가 쓴 제약을 받으려면 진짜로 필요하다**
 *                              (제약이 없으면 no-op 이지만 그건 목표가 아니다)
 *    PnR 휠 0.8 MB             축소 확장 (배선기·PnRDB·placer·lp_solve)
 *    align-front.zip 0.2 MB    align 파이썬 소스 + PDK (PDK 의 PDF·PPT 와 예제는 뺐다)
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

  say("PnR 확장…", 4);
  const whl = (await (await fetch("./py/pnr/list.txt")).text()).trim().split(/\s+/)[0];
  await mp.install(new URL("./py/pnr/" + whl, location.href).href);
  say(`PnR  ${el()}`, 4);

  say("align 소스 + PDK…", 5);
  const zip = await bytes("./py/front/align-front.zip");
  py.FS.mkdirTree("/align");
  py.unpackArchive(zip.buffer, "zip", { extractDir: "/align" });
  // shims 는 align 보다 뒤에 둔다 (진짜 모듈이 있으면 그쪽이 이긴다)
  py.runPython("import sys; sys.path.insert(0,'/align'); sys.path.append('/align/shims')");
  // 앞단용 PnR 스텁을 진짜 확장의 별칭으로 바꾼다.
  py.runPython(String.raw`import sys
# 앞단만 돌리려고 만든 스텁이 align/align/PnR.py 에 있다.
# align/pnr/build_pnr_model.py 는 from .. import PnR 로 상대 임포트하므로
# 최상위 PnR 이 아니라 **align.PnR** 이 진짜 확장이어야 배선이 된다.
# 스텁 파일을 진짜 모듈의 별칭으로 바꾼다.
open('/align/align/PnR.py', 'w').write(
    'import sys\n'
    'import PnR as _real\n'
    'sys.modules[__name__] = _real\n')
for m in ('PnR', 'align.PnR'):
    sys.modules.pop(m, None)`);
  py.runPython("import browser_stubs; browser_stubs.install()");
  py.runPython("import align, z3, PnR");
  // lp_solve 의 make_lp() 는 LP 를 만들 때마다 dlopen("libmyBLAS.so") 로 외부 BLAS 를
  // 찾는다. Emscripten 은 적재에 실패한 이름을 LDSO 에 남겨 두어서, 두 번째 dlopen 이
  // "이미 적재됨" 으로 성공하고 dlsym 이 전부 NULL 이 된다. lp_solve 는 그때 BLAS 함수
  // 포인터를 NULL 로 둔 채 넘어가고 다음 LP 에서 "null function" 으로 죽는다 — 계층
  // 설계의 두 번째 모듈, 같은 세션의 두 번째 배선이 그것이었다. 이 이름이 영영 적재되지
  // 않은 것으로 보이게 막으면 매번 제대로 실패한다 (symplace/PLAN-route.md 2 절).
  Object.defineProperty(py._module.LDSO.loadedLibsByName, "libmyBLAS.so",
    { get() { return undefined; }, set() {}, configurable: true });
  // 스텁도 PnRdatabase 속성은 가지고 있다 (부르면 raise). 파일 위치로 가른다.
  const pnrFile = py.runPython("import align.PnR as P; getattr(P, '__file__', '?')");
  if (String(pnrFile).includes("/align/align/PnR.py"))
    throw new Error("PnR 스텁이 아직 잡힌다: " + pnrFile);
  say("PnR 확장 " + String(pnrFile).split("/").pop(), 5);
  say(`align ${py.runPython("import align; align.__version__")} · ` +
      `z3 ${py.runPython("import z3; z3.get_version_string()")} · PnR  ${el()}`, 5);
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
    templates = {}
    for cn in prims:
        p = prim / (cn + ".json")
        if p.exists():
            d = json.loads(p.read_text())
            templates[cn] = {"bbox": d["bbox"],
                             "terminals": [t for t in d.get("terminals", [])
                                           if t.get("netType") == "pin" and t.get("netName")]}
    return json.dumps({"topology": topology, "primitives": prims,
                       "templates": templates, "place": None})
`;

const PYROUTE = String.raw`
import base64, json, logging, os, pathlib, shutil, traceback

def _emit_dump(pnr, prim, top_level, alts):
    """덤프 두 파일을 쓴다."""
    # leaf_map: abstract -> {concrete -> [{width,height}, [[rect,label,...]], None]}
    # 단위는 마이크론이다 (2_primitives 는 정수 좌표, ScaleFactor 1000).
    prims = json.loads((prim / "__primitives__.json").read_text())
    leaf_map = {}
    for cn, meta in prims.items():
        ab = meta["abstract_template_name"]
        p = prim / (cn + ".json")
        if not p.exists():
            continue
        bb = json.loads(p.read_text())["bbox"]
        w, h = (bb[2] - bb[0]) / 1000.0, (bb[3] - bb[1]) / 1000.0
        leaf_map.setdefault(ab, {})[cn] = [
            {"width": w, "height": h},
            [[[0, 0, w, h], "%s<br>0 0 %g %g" % (cn, w, h), True, 0, False]],
            None,
        ]

    with open(pnr / "__placer_dump__.json", "w") as f:
        json.dump([top_level, leaf_map, alts, {a[0]: {} for a in alts}], f)
    with open(pnr / "__placements_to_run__.json", "w") as f:
        json.dump([0], f)
    return str(pnr / "__placer_dump__.json")


def write_dump(work, top_level, placement):
    """우리 배치로 __placer_dump__.json 을 만든다.

    ALIGN 의 place 단계가 쓰는 것과 같은 모양이어야 route 가 읽는다.
      [top_level, leaf_map, alternatives, metrics]

    계층 정보는 1_topology 가 아니라 **3_pnr/inputs/<TOP>.verilog.json** 에서
    가져온다. prep 단계가 manipulate_hierarchy 를 돌려 거기 써둔 것이고
    (align/pnr/main.py:219), 배선 단계가 기대하는 바로 그 모양이다:
      - 최상위 포트에서 전원/접지가 빠져 있다 (안 빼면 C++ 배치기가 넷 없는
        단자로 읽고 색인을 벗어나 wasm 이 즉사한다)
      - 하위 모듈은 전원핀을 걷어낸 사본 이름(<이름>_PG0)으로 바뀌어 있고
        그 안의 소자는 전역 넷에 직접 물려 있다

    계층은 그대로 넘긴다. 배선기는 bottom_up 으로 하위 모듈부터 하나씩 돈다.
    (예전에는 하위 모듈을 최상위로 펼쳐 넘겼다. 두 번째 모듈에서 죽던 것을
    피하려던 것인데, 원인은 모듈 수가 아니라 lp_solve 의 BLAS 적재였다 —
    boot() 참고. 펼치면 블록을 가리키는 제약을 버려야 해서 되돌렸다.)
    """
    work = pathlib.Path(work)
    prim = work / "2_primitives"
    pnr = work / "3_pnr"
    vd = json.loads((pnr / "inputs" / (top_level + ".verilog.json")).read_text())
    mods = {m["name"]: m for m in vd["modules"]}
    gs = vd.get("global_signals", [])
    tmod = mods[top_level]
    tinst = {i["instance_name"]: i for i in tmod["instances"]}

    def leaf_entry(cn, ab):
        p = prim / (cn + ".json")
        if not p.exists():
            raise RuntimeError("leaf 정의 없음: %s" % cn)
        d = json.loads(p.read_text())
        terms = [{"name": t["netName"], "rect": list(t["rect"])}
                 for t in d.get("terminals", [])
                 if t.get("netType") == "pin" and t.get("netName")]
        return {"abstract_name": ab, "concrete_name": cn,
                "bbox": list(d["bbox"]), "terminals": terms}

    key = "%s_0" % top_level

    # --- 하위 모듈 이름 짓기 ---
    #
    # 우리 배치기는 하위 모듈을 여러 모양으로 올려 "<이름>__v0" 꼴을 쓴다.
    # 덤프 쪽 이름은 "<abstract>_<번호>" 여야 한다 — 배선 단계가
    # change_concrete_names_for_routing 에서 ^(.+)_(\d+)$ 로 풀어 쓴다.
    sub_name = {}        # 우리 concrete -> 덤프 concrete
    sub_abstract = {}    # 우리 concrete -> _PG 붙은 abstract
    for q in placement["instances"]:
        ab = tinst[q["name"]]["abstract_template_name"]
        if ab not in mods:
            continue     # 소자다
        if q["concrete"] in sub_name:
            continue
        n = sum(1 for v in sub_abstract.values() if v == ab)
        sub_abstract[q["concrete"]] = ab
        sub_name[q["concrete"]] = "%s_%d" % (ab, n)

    # --- 최상위 module 항목 ---
    insts, leaf_used = [], {}
    for q in placement["instances"]:
        src = tinst[q["name"]]
        ab = src["abstract_template_name"]
        cn = sub_name.get(q["concrete"], q["concrete"])
        if ab not in mods:
            leaf_used[q["concrete"]] = ab
        insts.append({
            "instance_name": q["name"],
            "abstract_template_name": ab,
            "concrete_template_name": cn,
            "fa_map": src.get("fa_map", []),
            "transformation": {"oX": int(q["oX"]), "oY": int(q["oY"]),
                               "sX": int(q["sX"]), "sY": int(q["sY"])},
        })

    def module_entry(ab, cn, bbox, placed):
        """모듈 하나를 덤프 항목으로. placed 는 {인스턴스이름: 우리 배치}."""
        m = mods[ab]
        out = []
        for i in m["instances"]:
            q = placed[i["instance_name"]]
            sub_cn = sub_name.get(q["concrete"], q["concrete"])
            if i["abstract_template_name"] not in mods:
                leaf_used[q["concrete"]] = i["abstract_template_name"]
            out.append({
                "instance_name": i["instance_name"],
                "abstract_template_name": i["abstract_template_name"],
                "concrete_template_name": sub_cn,
                "fa_map": i.get("fa_map", []),
                "transformation": {"oX": int(q["oX"]), "oY": int(q["oY"]),
                                   "sX": int(q["sX"]), "sY": int(q["sY"])},
            })
        return {"abstract_name": ab, "concrete_name": cn, "bbox": list(bbox),
                "parameters": m.get("parameters", []),
                "constraints": m.get("constraints", []), "instances": out}

    # --- 하위 모듈: 최상위 대안 안의 사본과 자기 대안을 둘 다 만든다 ---
    #
    # 자기 대안을 빠뜨리면 하위 모듈 배선이 자기 leaves 에서 우리가 고른
    # 변이를 못 찾아 "concrete_template_name: ... not found." 로 죽는다.
    sub_entries, extra_alts = [], []
    for sm in placement.get("subModules", []):
        cn = sub_name.get(sm["concrete"])
        ab = sub_abstract.get(sm["concrete"])
        if cn is None or ab is None:
            continue     # 최상위가 안 쓰는 모양이다
        placed = {i["name"]: i for i in sm["instances"]}
        ent = module_entry(ab, cn, sm["bbox"], placed)
        sub_entries.append(ent)
        own_leaves = sorted({i["concrete_template_name"] for i in ent["instances"]})
        extra_alts.append([cn, {
            "global_signals": gs,
            "leaves": [leaf_entry(c, leaf_used[c]) for c in own_leaves],
            "modules": [json.loads(json.dumps(ent))],
        }])

    top_entry = {"abstract_name": top_level, "concrete_name": key,
                 "bbox": list(placement["bbox"]),
                 "parameters": tmod.get("parameters", []),
                 "constraints": tmod.get("constraints", []),
                 "instances": insts}
    alt = {"global_signals": gs,
           "leaves": [leaf_entry(c, a) for c, a in sorted(leaf_used.items())],
           "modules": [top_entry] + sub_entries}

    return _emit_dump(pnr, prim, top_level, extra_alts + [[key, alt]])



def _skip_cap_placer():
    """커패시터가 없으면 cap_placer 를 건너뛴다.

    축소 PnR 바인딩에 Placer_Router_Cap_Ifc 가 없다 (배선에 안 쓰여서 뺐다).
    align/pnr/main.py 는 커패시터 유무와 무관하게 부르므로
    AttributeError 로 죽는다. 커패시터가 없는 설계에서는 결과가 같으므로
    빈 결과를 돌려준다. 있으면 조용히 넘기면 안 되니 분명히 실패시킨다.
    """
    import align.pnr.cap_placer as cp
    import align.pnr.main as pm
    def driver(toplevel_args_d=None, results_dir=None, **kw):
        d = toplevel_args_d or {}
        vd = d.get('verilog_d') or {}
        mods = vd.get('modules', []) if isinstance(vd, dict) else []
        caps = [i for m in mods for i in (m.get('instances') or [])
                if 'CAP' in str(i.get('abstract_template_name', '')).upper()]
        if caps:
            raise NotImplementedError(
                '이 설계에는 커패시터가 있다. 브라우저 PnR 휠에 '
                'Placer_Router_Cap_Ifc 를 다시 넣어야 한다.')
        return [], ''
    cp.cap_placer_driver = driver
    pm.cap_placer_driver = driver
def _log_to_js():
    """ALIGN 의 로그를 페이지로 흘린다.

    배선은 한 번의 runPython 안에서 몇 분씩 돈다. 그 동안 화면에는
    "배선 중" 한 줄뿐이라, 계층 설계에서 **어느 모듈에서 멈췄는지**
    알 길이 없었다 ("작동하다가 멈춘다"의 실체다).

    align/pnr/router.py 가 모듈마다
    'bottom up routing for <이름> (<idx>) placement version <j>' 를 찍으므로,
    그 줄만 받아 넘겨도 어디까지 갔는지 바로 보인다. 워커 안에서 부르는
    postMessage 는 메인 스레드가 바로 받으므로 진행이 그대로 보인다.
    """
    try:
        import js
    except ImportError:
        return None

    class JsLog(logging.Handler):
        def emit(self, rec):
            try:
                js.routeLog(rec.getMessage()[:300])
            except Exception:
                pass

    h = JsLog(logging.INFO)
    root = logging.getLogger()
    root.addHandler(h)
    if root.level > logging.INFO or root.level == logging.NOTSET:
        root.setLevel(logging.INFO)
    logging.getLogger('align').setLevel(logging.INFO)
    return h


def route(work, name, top_level, placement_json):
    handler = _log_to_js()
    try:
        _skip_cap_placer()
        placement = json.loads(placement_json)
        from align.main import schematic2layout
        w = pathlib.Path(work)
        pdk = pathlib.Path("/align/pdks/FinFET14nm_Mock_PDK")

        # 매번 prep 부터 다시 돌린다 (1 초 미만). prep 이 3_pnr 을 비우고 새로
        # 짓는다. 앞 회차의 GDS/LEF 도 걷어내야 결과를 헷갈리지 않는다.
        # (두 번째 배선이 죽던 것은 이것과 무관하다 — boot() 의 BLAS 우회 참고.)
        if (w / "3_pnr").exists():
            shutil.rmtree(w / "3_pnr")
        for stale in list(w.glob("*.gds")) + list(w.glob("*.lef")) + list(w.glob("*.gds.json")):
            stale.unlink()

        # route 가 __cap_map__.json 을 읽는데 (align/pnr/main.py:326) 그건
        # prep 단계가 쓴다. 배치 단계는 건너뛴다 — 우리 배치기가 대신한다.
        schematic2layout(w / "netlist", pdk, subckt=top_level, working_dir=w,
                         flow_start="3_pnr:prep", flow_stop="3_pnr:prep",
                         nvariants=1, effort=0)

        # 그 다음 우리 배치를 덤프에 심는다 (prep 이 덮어쓰지 않도록 순서가 중요)
        write_dump(work, top_level, placement)
        # bottom_up 이 CLI 기본값이고, WSL 에서 DRC 를 닫은 경로도 이쪽이다.
        # 파이썬 API 기본값 top_down 은 축소 빌드에서 불안정하다.
        schematic2layout(w / "netlist", pdk, subckt=top_level, working_dir=w,
                         flow_start="3_pnr:route", router_mode="bottom_up",
                         nvariants=1, effort=0)
        gds = sorted(w.glob("*.gds"))
        errs = []
        for p in sorted((w / "3_pnr").glob("*.errors")):
            errs += [l.strip() for l in p.read_text(errors="replace").splitlines() if l.strip()]
        rj = sorted((w / "3_pnr").glob("%s_0.json" % top_level))
        geo = json.loads(rj[0].read_text()) if rj else None
        # 첫 GDS 는 원본 바이트째 넘긴다 — 페이지가 그대로 내려받게 한다
        # (80K~200K 라 base64 로 옮겨도 부담이 없다).
        blob = base64.b64encode(gds[0].read_bytes()).decode() if gds else None
        return json.dumps({
            "ok": True,
            "gdsB64": blob,
            "gds": [{"name": p.name, "bytes": p.stat().st_size} for p in gds],
            "errors": errs[:40], "nerrors": len(errs),
            "geo": {"bbox": geo.get("bbox"), "terminals": geo.get("terminals", [])} if geo else None,
        })
    except Exception:
        return json.dumps({"ok": False, "error": traceback.format_exc()[-2500:]})
    finally:
        if handler is not None:
            logging.getLogger().removeHandler(handler)
`;


// 앞단이 만든 작업 디렉터리를 기억해 둔다. 배선은 **같은 워커**에서 해야 한다 —
// 워커가 다르면 Pyodide 파일시스템도 다르다.
let lastWork = null, lastTop = null, lastName = null;

self.onmessage = async (e) => {
  const { sp, name, subckt, constraints, cmd, placement } = e.data;
  try {
    const p = await boot();

    // --- 배선 ---
    if (cmd === "route") {
      if (!lastWork) throw new Error("앞단을 먼저 돌려야 합니다");
      say("배선 — ALIGN 배선기 (wasm)", 7);
      const t0 = performance.now();
      // 배선이 도는 동안 무슨 일이 일어나는지 흘려보낸다. 계층 설계는
      // 하위 모듈부터 하나씩 도는데, 그 중간에서 멈추면 어디였는지 알아야
      // 한다. 파이썬 로그(_log_to_js)와 C++ 쪽 표준출력을 둘 다 받는다.
      let where = "", nlog = 0;
      const push = (t) => {
        for (const raw of String(t).split("\n")) {
          const l = raw.trim();
          if (!l) continue;
          where = l.slice(0, 200);
          // 다 보내면 메시지가 수천 개가 된다. 어디쯤인지 알려주는 줄만.
          if (nlog < 400 && /rout|module|primitive|error|fail|Traceback/i.test(l)) {
            nlog++;
            say(l.slice(0, 160), 7);
          }
        }
      };
      globalThis.routeLog = push;
      try { p.setStdout({ batched: push }); p.setStderr({ batched: push }); } catch { /* 구버전 */ }
      let r;
      try {
        p.runPython(PYROUTE);
        const out = p.globals.get("route")(lastWork, lastName, lastTop,
                                           JSON.stringify(placement));
        r = JSON.parse(out);
      } finally {
        try { p.setStdout({}); p.setStderr({}); } catch { /* 구버전 */ }
      }
      postMessage({ type: "route", ...r, where,
                    secs: (performance.now() - t0) / 1000 });
      return;
    }

    say("앞단 실행 — 1_topology · 2_primitives", 6);
    const t0 = performance.now();
    p.runPython(FRONT);
    const out = p.globals.get("run")(sp, name, subckt, constraints ?? "");
    const blob = JSON.parse(out);
    lastWork = "/work/" + name; lastTop = subckt; lastName = name;
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
