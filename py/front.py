"""앞단: SPICE 넷리스트 -> ALIGN 1_topology + 2_primitives, 배치기가 먹는 한 덩이로.

frontworker.mjs (.sp 올리기), alignworker.mjs (ALIGN 원본 배선 — 같은 작업 디렉터리를 쓴다),
node 하네스(symplace/scripts/route/node/align.mjs)가 같은 원문을 읽는다.
"""
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
