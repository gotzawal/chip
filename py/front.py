"""앞단: SPICE 넷리스트 -> ALIGN 1_topology + 2_primitives, 배치기가 먹는 한 덩이로.

frontworker.mjs (.sp 올리기) 가 Pyodide 안에서 읽는다.
"""
import json, pathlib, shutil

def run(sp_text, name, subckt, const_json):
    """const_json: JSON 문자열 — {"<이름>.const.json": 내용, ...} 이거나 예전 모양(제약 배열 문자열).
    ALIGN 은 서브서킷마다 <서브서킷>.const.json 을 찾는다 (user_const.py, 대소문자 무관)."""
    work = pathlib.Path("/work") / name
    if work.exists():
        shutil.rmtree(work)
    nl = work / "netlist"
    nl.mkdir(parents=True)
    (nl / (name + ".sp")).write_text(sp_text)
    consts = {}
    if const_json:
        try:
            parsed = json.loads(const_json)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            consts = {k: v for k, v in parsed.items() if isinstance(v, str) and v.strip()}
        elif const_json.strip():
            consts = {subckt.lower() + ".const.json": const_json}
    for fname, text in consts.items():
        (nl / fname.lower()).write_text(text)

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
