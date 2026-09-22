"""계층을 펼쳐 배선기에 넘기는 부분을 검사한다 (Pyodide 없이).

frontworker.mjs 안의 파이썬(PYROUTE)을 그대로 꺼내 실제 배치에 대고 돌린다.
배선기는 못 돌리지만, 덤프를 만드는 쪽의 성질은 여기서 다 볼 수 있다.

  1. 이름이 안 겹친다
  2. 개수가 맞는다 (소자 1 개 + 하위 모듈마다 그 안의 소자 수)
  3. 좌표가 계층으로 읽은 것과 **정확히** 같다 (변환 합성이 맞는가)
  4. 소자가 최상위 bbox 안에 있다
  5. 넷 묶음(핀의 분할)이 계층 넷리스트와 같다 (연결이 보존되는가)
  6. 남은 제약의 핀 참조가 전부 실재한다 (SymmetricNets 를 옮겼는가)

    python3 symplace/web/placer/test/flatten.py
"""
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import types

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]                      # 저장소 루트


def load_pyroute():
    """frontworker.mjs 의 PYROUTE 블록을 모듈로 만든다."""
    src = io.open(ROOT / "frontworker.mjs", encoding="utf8").read()
    m = re.search(r"const PYROUTE = String\.raw`(.*?)`;", src, re.S)
    assert m, "PYROUTE 블록을 못 찾았다"
    mod = types.ModuleType("pyroute")
    exec(compile(m.group(1), "PYROUTE", "exec"), mod.__dict__)
    return mod


def place(name, out):
    subprocess.run(["node", str(HERE / "dumpplace.mjs"), name, out],
                   check=True, cwd=str(ROOT))
    return json.load(io.open(out, encoding="utf8"))["placement"]


def check(mod, name, placement):
    blob = json.load(io.open(ROOT / "data" / (name + ".json"), encoding="utf8"))
    topo = blob["topology"]
    mods = {m["name"]: m for m in topo["modules"]}
    gs = topo.get("global_signals", [])
    inst_of = {i["abstract_template_name"] for m in topo["modules"]
               for i in m.get("instances", [])}
    top_level = [m["name"] for m in topo["modules"] if m["name"] not in inst_of][0]
    tmod = mods[top_level]
    tinst = {i["instance_name"]: i for i in tmod["instances"]}
    tpl = blob["templates"]

    insts, leaf_used, dead, pinmap = mod._flat_instances(mods, tinst, placement, gs)
    print(f"\n=== {name} ===")
    print(f"  최상위 {len(placement['instances'])} -> 펼친 뒤 {len(insts)}"
          f"   하위 모듈 {len(dead)} 개   leaf 종류 {len(leaf_used)}")
    fails = []

    names = [i["instance_name"] for i in insts]
    if len(names) != len(set(names)):
        fails.append("인스턴스 이름 중복")

    want = sum(len(mods[tinst[q["name"]]["abstract_template_name"]]["instances"])
               if tinst[q["name"]]["abstract_template_name"] in mods else 1
               for q in placement["instances"])
    if want != len(insts):
        fails.append(f"개수 {len(insts)} != {want}")

    def box(cn, tr):
        bb = tpl[cn]["bbox"]
        xs = sorted([tr["sX"] * bb[0] + tr["oX"], tr["sX"] * bb[2] + tr["oX"]])
        ys = sorted([tr["sY"] * bb[1] + tr["oY"], tr["sY"] * bb[3] + tr["oY"]])
        return (xs[0], ys[0], xs[1], ys[1])

    flat = {i["instance_name"]: box(i["concrete_template_name"], i["transformation"])
            for i in insts}
    subs = {s["concrete"]: s for s in placement["subModules"]}
    hier = {}
    for q in placement["instances"]:
        ab = tinst[q["name"]]["abstract_template_name"]
        tr = {"oX": q["oX"], "oY": q["oY"], "sX": q["sX"], "sY": q["sY"]}
        if ab not in mods:
            hier[q["name"]] = box(q["concrete"], tr)
            continue
        for c in subs[q["concrete"]]["instances"]:
            inner = box(c["concrete"], {"oX": c["oX"], "oY": c["oY"],
                                        "sX": c["sX"], "sY": c["sY"]})
            xs = sorted([tr["sX"] * inner[0] + tr["oX"], tr["sX"] * inner[2] + tr["oX"]])
            ys = sorted([tr["sY"] * inner[1] + tr["oY"], tr["sY"] * inner[3] + tr["oY"]])
            hier[f'{q["name"]}_{c["name"]}'] = (xs[0], ys[0], xs[1], ys[1])
    if set(flat) != set(hier):
        fails.append(f"이름 집합이 다르다: {sorted(set(flat) ^ set(hier))[:4]}")
    else:
        bad = [k for k in flat if flat[k] != hier[k]]
        if bad:
            fails.append(f"좌표 다른 소자 {len(bad)} 개 (예: {bad[0]} "
                         f"{flat[bad[0]]} vs {hier[bad[0]]})")

    B = placement["bbox"]
    out = [k for k, b in flat.items()
           if b[0] < B[0] - 1 or b[1] < B[1] - 1 or b[2] > B[2] + 1 or b[3] > B[3] + 1]
    if out:
        fails.append(f"bbox 밖 소자 {len(out)} 개: {out[:3]}")

    glob = {g["actual"] for g in gs}
    hnets = {}
    for q in placement["instances"]:
        ab = tinst[q["name"]]["abstract_template_name"]
        fa = {f["formal"]: f["actual"] for f in tinst[q["name"]].get("fa_map", [])}
        if ab not in mods:
            for f, a in fa.items():
                hnets.setdefault(a, set()).add((q["name"], f))
            continue
        for c in mods[ab]["instances"]:
            for f in c.get("fa_map", []):
                a = f["actual"]
                key = fa[a] if a in fa else (a if a in glob else f'{q["name"]}::{a}')
                hnets.setdefault(key, set()).add(
                    (f'{q["name"]}_{c["instance_name"]}', f["formal"]))
    fnets = {}
    for i in insts:
        for f in i["fa_map"]:
            fnets.setdefault(f["actual"], set()).add((i["instance_name"], f["formal"]))
    h = {frozenset(v) for v in hnets.values()}
    fl = {frozenset(v) for v in fnets.values()}
    if h != fl:
        fails.append(f"넷 묶음이 다르다 (계층만 {len(h - fl)}, 평면만 {len(fl - h)})")
    else:
        print(f"  넷 {len(h)} 묶음 일치, 소자 {len(flat)} 개 좌표 일치")

    cs = tmod.get("constraints", [])
    kept, dropped = mod._fix_constraints(cs, dead, pinmap)
    have = {(i["instance_name"], f["formal"]) for i in insts for f in i["fa_map"]}
    have_names = {i["instance_name"] for i in insts}
    bad = []

    def walk(n):
        k = mod._pin_key(n)
        if k is not None and (k[0] in dead or (k[0] in have_names and k not in have)):
            bad.append(k)
        if isinstance(n, dict):
            for v in n.values():
                walk(v)
        elif isinstance(n, (list, tuple)):
            for v in n:
                walk(v)

    for c in kept:
        walk(c)
    if bad:
        fails.append(f"남은 제약이 없는 핀을 가리킨다: {bad[:4]}")
    else:
        print(f"  제약 {len(cs)} -> {len(kept)} (버린 것 {dropped}), "
              f"핀 {len(pinmap)} 자리를 옮겼고 전부 실재")

    for f in fails:
        print("  실패:", f)
    if not fails:
        print("  통과")
    return not fails


def main():
    mod = load_pyroute()
    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        for name in ["cascode_current_mirror_ota", "high_speed_comparator"]:
            p = os.path.join(tmp, name + ".json")
            ok &= check(mod, name, place(name, p))
    print("\n전부 통과" if ok else "\n실패 있음")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
