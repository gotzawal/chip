"""ALIGN 원본 배선 — ALIGN 의 파이썬 흐름과 C++ 배선기(축소 PnR 휠, py/pnr/)로 우리 배치를 배선한다.

Rust 로 옮긴 배선기(symplace/alignroute)의 기준이다. 같은 원문을 셋이 쓴다:
  alignworker.mjs  페이지의 "배선 · ALIGN 원본" 버튼 (Rust 이식과 번갈아 돌려 견준다)
  route.mjs        node 하네스: ALIGN 배선을 끝까지 (시간, DRC)
  checkref.mjs     ALIGN 검사기의 입출력을 기록 (JS 검사기·도형 합성 대조용)

route(work, name, top_level, placement_json) — 앞단(py/front.py)이 /work/<name> 에 만든 작업 디렉터리 위에서.
"""
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
        # 파이썬 판 GDS (gen_gds_json + python-gdsii) — 우리 src/route/gds.mjs 가 바이트까지 맞추는 쪽
        pyg = sorted(w.glob("*.python.gds"))
        return json.dumps({
            "ok": True,
            "gdsB64": blob,
            "pyGdsB64": base64.b64encode(pyg[0].read_bytes()).decode() if pyg else None,
            "pyGdsName": pyg[0].name if pyg else None,
            "gds": [{"name": p.name, "bytes": p.stat().st_size} for p in gds],
            "errors": errs[:40], "nerrors": len(errs),
            "geo": {"bbox": geo.get("bbox"), "terminals": geo.get("terminals", [])} if geo else None,
        })
    except Exception:
        return json.dumps({"ok": False, "error": traceback.format_exc()[-2500:]})
    finally:
        if handler is not None:
            logging.getLogger().removeHandler(handler)
